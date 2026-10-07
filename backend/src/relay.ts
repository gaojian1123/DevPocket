import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import { Fault, RateLimiter, bearer, fileName, publicError, relayUrl } from "./security.js";
import { RelayStore } from "./store.js";
import {
  Command, HostFrame, Id, MAX_UPLOAD, MetadataPatch, PROTOCOL, VERSION, allowedMime,
  type Receipt, type SessionInfo, type UserEvent,
} from "./protocol.js";
import { FcmPush, type PushSender } from "./push.js";

export { VERSION, PROTOCOL } from "./protocol.js";
export type RelayOptions = {
  dataDir: string;
  port?: number;
  bind?: string;
  publicUrl?: string;
  allowInsecureLoopback?: boolean;
  trustedProxy?: string;
  now?: () => number;
  fcmServiceAccount?: string;
  pushSender?: PushSender;
};

export async function readBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<Buffer> {
  if (Number(request.headers["content-length"] ?? 0) > maxBytes) {
    throw new Fault("TOO_LARGE", "Request exceeds the size limit.", 413);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw new Fault("TOO_LARGE", "Request exceeds the size limit.", 413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new Fault("CONTENT_TYPE", "Content-Type must be application/json.", 415);
  }
  try { return JSON.parse((await readBody(request)).toString("utf8")) as unknown; }
  catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault("INVALID_JSON", "Request body must be valid JSON.");
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  });
  response.end(JSON.stringify(value));
}

export async function startRelay(options: RelayOptions): Promise<{ url: string; close(): Promise<void> }> {
  const bind = options.bind ?? "127.0.0.1";
  if (options.allowInsecureLoopback && !["127.0.0.1", "::1"].includes(bind)) {
    throw new Fault("UNSAFE_BIND", "Insecure development mode may bind only to loopback.");
  }
  if (!options.allowInsecureLoopback && !options.publicUrl) {
    throw new Fault("TLS_REQUIRED", "Configure an HTTPS public URL and a trusted TLS proxy.");
  }
  if (options.publicUrl) relayUrl(options.publicUrl, options.allowInsecureLoopback);
  const store = new RelayStore(options.dataDir, options.now);
  const push = options.pushSender ?? (options.fcmServiceAccount ? await FcmPush.fromFile(options.fcmServiceAccount) : undefined);
  const limiter = new RateLimiter(options.now);
  let origin = options.publicUrl ?? "http://127.0.0.1";
  const hosts = new Map<string, { socket: WebSocket; ready: boolean; hostId: string; sessionId: string }>();
  const viewers = new Map<WebSocket, { deviceId: string; hostId: string; sessionId: string }>();
  const pushPending = new Set<Promise<void>>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
  const alive = new WeakSet<WebSocket>();
  function trackHeartbeat(ws: WebSocket): void {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
  }
  let closing = false;
  const key = (hostId: string, sessionId: string) => `${hostId}/${sessionId}`;
  const isReady = (connection: { socket: WebSocket; ready: boolean } | undefined): boolean =>
    connection?.ready === true && connection.socket.readyState === WebSocket.OPEN;
  const present = (item: SessionInfo): SessionInfo => {
    const online = isReady(hosts.get(key(item.hostId, item.sessionId)));
    return { ...item, online, state: online ? item.state : "offline" };
  };

  function send(socket: WebSocket, data: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 4 * 1024 * 1024) { socket.close(1013, "Replay after reconnect"); return; }
    socket.send(JSON.stringify(data));
  }

  function revokeSockets(deviceId: string, hostId: string): void {
    for (const [socket, viewer] of viewers)
      if (viewer.deviceId === deviceId && viewer.hostId === hostId) socket.close(4003, "Device revoked");
  }

  function publish(hostId: string, sessionId: string, event: UserEvent): void {
    const inserted = store.event(hostId, sessionId, event);
    if (!inserted) return;
    if (push && Date.now() - Date.parse(event.at) < 60_000 &&
      ((event.kind === "requests" && event.data.items.length > 0) ||
        (event.kind === "runtime.state" && event.data.state === "idle"))) {
      for (const target of store.pushTargets(hostId)) {
        if (pushPending.size >= 32) { console.error("[devpocket] Push queue full; notification omitted."); break; }
        const work = (async () => {
          try {
            store.authorize(target.id, hostId);
            const result = await push.send(target.token, {
              hostId, sessionId, eventId: event.id, kind: event.kind === "requests" ? "attention" : "status",
            });
            if (result === "unregistered") store.pushToken(target.id, null);
          } catch (error) {
            console.error("[devpocket] Push notification failed:", error instanceof Fault ? error.code : "delivery error");
          }
        })();
        pushPending.add(work);
        void work.finally(() => pushPending.delete(work));
      }
    }
    for (const [socket, viewer] of viewers) {
      if (viewer.hostId !== hostId || viewer.sessionId !== sessionId) continue;
      try {
        store.authorize(viewer.deviceId, hostId);
        send(socket, { type: "events", events: [inserted], cursor: inserted.cursor, reset: false, hasMore: false });
      } catch (error) {
        if (!(error instanceof Fault)) throw error;
        socket.close(4003, "Device revoked");
      }
    }
  }

  function result(hostId: string, sessionId: string, receipt: Receipt): void {
    if (store.result(hostId, sessionId, receipt)) {
      const visible: Receipt = { commandId: receipt.commandId, status: receipt.status,
        ...(receipt.error ? { error: receipt.error } : {}),
        ...(typeof receipt.result?.messageId === "string" ? { result: { messageId: receipt.result.messageId } } : {}),
      };
      publish(hostId, sessionId, { id: randomUUID(), at: new Date().toISOString(), kind: "delivery", data: visible });
    }
  }

  function checkTransport(request: IncomingMessage): void {
    if (request.headers.origin) throw new Fault("ORIGIN_REJECTED", "Browser-origin requests are not supported.", 403);
    if (!options.allowInsecureLoopback &&
      !(request.socket.remoteAddress === options.trustedProxy && request.headers["x-forwarded-proto"] === "https")) {
      throw new Fault("TLS_REQUIRED", "Use the trusted HTTPS endpoint.", 403);
    }
    limiter.take(`all:${request.socket.remoteAddress ?? "unknown"}`, 1500);
  }

  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      if (!(error instanceof Fault) && !(error instanceof z.ZodError)) {
        console.error("[devpocket] request failed:", error instanceof Error ? error.name : "unknown error");
      }
      const validation = error instanceof z.ZodError;
      json(response, validation ? 400 : error instanceof Fault ? error.status : 500,
        { error: validation ? { code: "INVALID_REQUEST", message: "Request does not match protocol v1." } : publicError(error) });
    });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 40;
  server.on("upgrade", (request, socket, head) => {
    try {
      checkTransport(request);
      const url = new URL(request.url ?? "/", origin);
      const token = bearer(request.headers.authorization);
      const sessionId = Id.parse(url.searchParams.get("sessionId"));
      if (url.pathname === "/v1/host/stream") {
        const host = store.host(token);
        const routeKey = key(host.id, sessionId);
        if (hosts.has(routeKey)) throw new Fault("ALREADY_ATTACHED", "A bridge is already registered for this runtime.", 409);
        wss.handleUpgrade(request, socket, head, (ws) => {
          trackHeartbeat(ws);
          const connection = { socket: ws, ready: false, hostId: host.id, sessionId };
          hosts.set(routeKey, connection);
          const deadline = setTimeout(() => ws.close(1008, "Registration timed out"), 10_000);
          ws.on("error", () => console.error("[devpocket] host socket error"));
          ws.on("message", (bytes) => {
            try {
              store.host(token);
              limiter.take(`frames:${host.id}`, 6000);
              const frame = HostFrame.parse(JSON.parse(bytes.toString()));
              if (!connection.ready && frame.type !== "hello") throw new Fault("REGISTER_FIRST", "Register before sending events.");
              if (frame.type === "hello" || frame.type === "summary") {
                if (frame.summary.sessionId !== sessionId) throw new Fault("SCOPE_MISMATCH", "Session identity cannot change.");
                const knownSession = store.touch(host.id, frame.summary);
                if (frame.type === "hello") {
                  clearTimeout(deadline);
                  connection.ready = true;
                  send(ws, { type: "ready", protocol: PROTOCOL, hostId: host.id, sessionId });
                  if (knownSession) publish(host.id, sessionId, {
                    id: randomUUID(), at: new Date().toISOString(), kind: "runtime.state", data: { state: frame.summary.state },
                  });
                  for (const command of store.unsettled(host.id, sessionId)) {
                    try {
                      store.authorize(command.deviceId, host.id);
                      send(ws, { type: "command", commandId: command.commandId, action: command.action });
                    } catch (error) {
                      if (!(error instanceof Fault)) throw error;
                      result(host.id, sessionId, { commandId: command.commandId, status: "failed", error: publicError(error) });
                    }
                  }
                }
              } else if (frame.type === "events") {
                for (const event of frame.items) {
                  if (Buffer.byteLength(JSON.stringify(event)) > 500 * 1024)
                    throw new Fault("EVENT_TOO_LARGE", "A projected event exceeds the mobile-safe size limit.");
                  publish(host.id, sessionId, event);
                }
                send(ws, { type: "eventsAck", ids: frame.items.map((event) => event.id) });
              } else {
                const { type: _type, ...receipt } = frame;
                result(host.id, sessionId, receipt);
                send(ws, { type: "resultAck", commandId: receipt.commandId, status: receipt.status });
              }
            } catch (error) {
              send(ws, { type: "error", error: error instanceof z.ZodError
                ? { code: "PROTOCOL_INVALID", message: "Host frame does not match protocol v1." } : publicError(error) });
              ws.close(1008, "Protocol or authorization failure");
            }
          });
          ws.on("close", () => {
            clearTimeout(deadline);
            if (hosts.get(routeKey)?.socket !== ws) return;
            hosts.delete(routeKey);
            if (connection.ready && !closing) publish(host.id, sessionId, {
              id: randomUUID(), at: new Date().toISOString(), kind: "runtime.state", data: { state: "offline" },
            });
          });
        });
      } else if (url.pathname === "/v1/events") {
        const hostId = Id.parse(url.searchParams.get("hostId"));
        const device = store.device(token);
        store.authorize(device.id, hostId);
        store.session(hostId, sessionId);
        const after = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get("after") ?? 0);
        if ([...viewers.values()].filter((item) => item.deviceId === device.id).length >= 8)
          throw new Fault("TOO_MANY_STREAMS", "Close another session stream first.", 429);
        wss.handleUpgrade(request, socket, head, (ws) => {
          trackHeartbeat(ws);
          viewers.set(ws, { deviceId: device.id, hostId, sessionId });
          ws.on("error", () => console.error("[devpocket] device socket error"));
          ws.on("close", () => viewers.delete(ws));
          ws.on("message", () => ws.close(1008, "Use typed HTTPS commands"));
          send(ws, { type: "events", ...store.events(hostId, sessionId, after) });
        });
      } else throw new Fault("NOT_FOUND", "WebSocket route not found.", 404);
    } catch (error) {
      const status = error instanceof Fault ? error.status : 400;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { ws.terminate(); continue; }
      alive.delete(ws);
      ws.ping();
    }
  }, 25_000);

  function download(response: ServerResponse, hostId: string, sessionId: string, attachmentId: string): void {
    const file = store.attachment(hostId, sessionId, attachmentId);
    response.writeHead(200, {
      "Content-Type": file.mime, "Content-Length": file.size, "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "X-Content-Type-Options": "nosniff", "X-Content-Sha256": file.sha256,
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    response.end(file.body);
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", origin);
    const method = request.method ?? "GET";
    if (url.pathname === "/healthz" && method === "GET") {
      json(response, 200, { version: VERSION, protocol: PROTOCOL });
      return;
    }
    checkTransport(request);
    const ip = request.socket.remoteAddress ?? "unknown";
    if (method === "POST" && url.pathname === "/v1/host/pairings") {
      const host = store.host(bearer(request.headers.authorization));
      limiter.take(`host-pair:${host.id}`, 10);
      const pair = store.pairing(host.id);
      json(response, 201, { ...pair, hostId: host.id, relayUrl: origin });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/pair") {
      limiter.take(`pair:${ip}`, 6);
      const input = z.object({ code: z.string().min(40).max(160), name: z.string().trim().min(1).max(80) })
        .strict().parse(await jsonBody(request));
      const existing = request.headers.authorization ? store.device(bearer(request.headers.authorization)) : undefined;
      json(response, 201, store.pair(input.code, input.name, existing));
      return;
    }
    if (url.pathname === "/v1/host/devices" && method === "GET") {
      const host = store.host(bearer(request.headers.authorization));
      json(response, 200, { devices: store.devices(host.id) });
      return;
    }
    const hostAttachment = /^\/v1\/host\/sessions\/([a-f0-9-]+)\/attachments\/([a-f0-9-]+)$/.exec(url.pathname);
    if (hostAttachment?.[1] && hostAttachment[2] && method === "GET") {
      const host = store.host(bearer(request.headers.authorization));
      store.session(host.id, hostAttachment[1]);
      download(response, host.id, hostAttachment[1], hostAttachment[2]);
      return;
    }
    const revoke = /^\/v1\/host\/devices\/([a-f0-9-]+)$/.exec(url.pathname);
    if (revoke?.[1] && method === "DELETE") {
      const host = store.host(bearer(request.headers.authorization));
      store.revoke(revoke[1], host.id);
      revokeSockets(revoke[1], host.id);
      json(response, 200, { revoked: true });
      return;
    }
    const device = store.device(bearer(request.headers.authorization));
    if (url.pathname === "/v1/catalog" && method === "GET") {
      json(response, 200, { device, hosts: store.hosts(device.id).map((host) => ({
        ...host, online: [...hosts.values()].some((conn) => conn.hostId === host.id && isReady(conn)),
      })), sessions: store.sessions(device.id).map(present), pushConfigured: !!push, protocol: PROTOCOL });
      return;
    }
    if (url.pathname === "/v1/push-token" && method === "PUT") {
      limiter.take(`push:${device.id}`, 8);
      const input = z.object({ provider: z.literal("fcm"), token: z.string().min(20).max(4096).nullable() }).strict().parse(await jsonBody(request));
      if (input.token && !push) throw new Fault("PUSH_UNCONFIGURED", "This relay has no FCM credentials. Background delivery is unavailable.", 409);
      store.pushToken(device.id, input.token);
      json(response, 200, { registered: input.token !== null, provider: "fcm" });
      return;
    }
    const grant = /^\/v1\/grants\/([a-f0-9-]+)$/.exec(url.pathname);
    if (grant?.[1] && method === "DELETE") {
      store.authorize(device.id, grant[1]);
      store.revoke(device.id, grant[1]);
      revokeSockets(device.id, grant[1]);
      json(response, 200, { revoked: true });
      return;
    }
    const scoped = /^\/v1\/hosts\/([a-f0-9-]+)\/sessions\/([a-f0-9-]+)(\/.*)?$/.exec(url.pathname);
    if (scoped?.[1] && scoped[2]) {
      const hostId = Id.parse(scoped[1]), sessionId = Id.parse(scoped[2]), resource = scoped[3] ?? "";
      store.authorize(device.id, hostId);
      const session = present(store.session(hostId, sessionId));
      const connection = hosts.get(key(hostId, sessionId));
      if (resource === "" && method === "GET") { json(response, 200, session); return; }
      if (resource === "/metadata" && method === "PATCH") {
        store.metadata(hostId, sessionId, MetadataPatch.parse(await jsonBody(request)));
        json(response, 200, present(store.session(hostId, sessionId)));
        return;
      }
      if (resource === "/events" && method === "GET") {
        const after = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get("after") ?? 0);
        json(response, 200, store.events(hostId, sessionId, after));
        return;
      }
      if (resource === "/attachments" && method === "POST") {
        limiter.take(`uploads:${device.id}`, 12);
        const rawName = z.string().max(1000).parse(request.headers["x-file-name"]);
        let name: string;
        try { name = fileName(decodeURIComponent(rawName)); }
        catch (error) {
          if (error instanceof Fault) throw error;
          throw new Fault("INVALID_FILE_NAME", "File name must use valid percent encoding.");
        }
        const mime = request.headers["content-type"]?.split(";")[0] ?? "";
        if (!allowedMime.has(mime)) throw new Fault("UNSUPPORTED_MEDIA", "Allowed: text, JSON, PDF, PNG, JPEG, WebP.", 415);
        const bytes = await readBody(request, MAX_UPLOAD);
        if (!bytes.length) throw new Fault("EMPTY_FILE", "Attachment is empty.");
        json(response, 201, store.upload(device.id, hostId, sessionId, name, mime, bytes));
        return;
      }
      if (resource === "/attachments" && method === "GET") {
        json(response, 200, { attachments: store.attachments(hostId, sessionId) });
        return;
      }
      const attachmentMatch = /^\/attachments\/([a-f0-9-]+)$/.exec(resource);
      if (attachmentMatch?.[1] && method === "GET") {
        download(response, hostId, sessionId, attachmentMatch[1]);
        return;
      }
      if (resource === "/commands" && method === "POST") {
        limiter.take(`commands:${device.id}`, 120);
        const command = Command.parse(await jsonBody(request));
        if (command.action.type === "message")
          for (const id of command.action.attachmentIds) store.attachment(hostId, sessionId, id);
        const previous = store.command(device.id, hostId, sessionId, command.commandId);
        if (!previous && !isReady(connection))
          throw new Fault("HOST_OFFLINE", "The original runtime is offline. No command was queued.", 503);
        const submitted = store.submit(device.id, hostId, sessionId, command);
        if (submitted.fresh && connection) send(connection.socket, { type: "command", ...command });
        json(response, 202, submitted.receipt);
        return;
      }
      const commandMatch = /^\/commands\/([a-f0-9-]+)$/.exec(resource);
      if (commandMatch?.[1] && method === "GET") {
        const receipt = store.command(device.id, hostId, sessionId, commandMatch[1]);
        if (!receipt) throw new Fault("COMMAND_NOT_FOUND", "Command not found.", 404);
        json(response, 200, receipt);
        return;
      }
      throw new Fault("NOT_FOUND", "Session resource not found.", 404);
    }
    if (url.pathname === "/v1/devices" && method === "GET") {
      json(response, 200, { device, hosts: store.hosts(device.id) });
      return;
    }
    throw new Fault("NOT_FOUND", "Route not found.", 404);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, bind, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Relay did not bind a TCP address.");
  const url = `http://${bind === "::1" ? "[::1]" : bind}:${address.port}`;
  origin = options.publicUrl ?? url;
  return {
    url,
    close: async () => {
      closing = true;
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await Promise.allSettled(pushPending);
      store.close();
    },
  };
}
