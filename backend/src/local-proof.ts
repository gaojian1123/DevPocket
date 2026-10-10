import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Agent, request } from "node:http";
import net from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { z } from "zod";

export const ProofKey = z.string().regex(/^[a-f0-9]{64}$/);
export const proofSignature = (key: string, nonce: string) =>
  createHmac("sha256", key).update(`devpocket-proof-v1:${nonce}`).digest("hex");

export function createProofAgent(endpoint: string | URL, inputKey: string): Agent {
  const url = new URL(endpoint), key = ProofKey.parse(inputKey);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
    throw new Error("Owner authentication is restricted to an explicit local proof relay.");
  }
  const agent = new Agent({ keepAlive: false });
  const pending = new Set<net.Socket>();
  const destroy = agent.destroy.bind(agent);
  agent.destroy = () => { for (const socket of pending) socket.destroy(); destroy(); };
  agent.createConnection = () => {
    const outbound = new PassThrough(), inbound = new PassThrough();
    const gated = Duplex.from({ writable: outbound, readable: inbound });
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(url.port) });
    Object.assign(gated, {
      setTimeout: (milliseconds: number, callback?: () => void) => {
        if (callback) gated.once("timeout", callback);
        socket.setTimeout(milliseconds);
        return gated;
      },
      setNoDelay: (enabled = true) => { socket.setNoDelay(enabled); return gated; },
      setKeepAlive: (enabled = false, delay = 0) => { socket.setKeepAlive(enabled, delay); return gated; },
    });
    socket.on("timeout", () => gated.emit("timeout"));
    gated.once("close", () => socket.destroy());
    pending.add(socket);
    const nonce = randomBytes(32).toString("hex");
    let bytes = Buffer.alloc(0), settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off("data", receive); socket.off("error", fail); socket.off("close", fail);
      pending.delete(socket);
      socket.once("error", (failure) => gated.destroy(failure));
      if (error) { gated.destroy(error); socket.destroy(); }
      else {
        socket.once("close", () => { if (!socket.readableEnded) gated.destroy(new Error("Proof connection closed.")); });
        outbound.pipe(socket); socket.pipe(inbound);
      }
    };
    const fail = () => finish(new Error("The original proof relay could not authenticate this connection."));
    const timeout = setTimeout(fail, 15_000);
    const receive = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 4096) { fail(); return; }
      const split = bytes.indexOf("\r\n\r\n");
      if (split < 0 || bytes.length < split + 4 + 64) return;
      const headers = bytes.subarray(0, split).toString("ascii"), mac = bytes.subarray(split + 4);
      if (!headers.startsWith("HTTP/1.1 200 ") || !/\r\ncontent-length: 64(?:\r\n|$)/i.test(headers) ||
          /\r\n(?:transfer-encoding|content-encoding):/i.test(headers) || mac.length !== 64 ||
          !timingSafeEqual(mac, Buffer.from(proofSignature(key, nonce)))) { fail(); return; }
      // Release buffered HTTP/WS bytes only onto the socket that answered the fresh challenge.
      finish();
    };
    socket.on("data", receive);
    socket.once("error", fail);
    socket.once("close", fail);
    socket.once("connect", () => socket.write(
      `GET /__devpocket-proof/${nonce} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: keep-alive\r\n\r\n`));
    return gated;
  };
  return agent;
}

export async function authenticatedProofFetch(url: string | URL, key: string, options: {
  method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal;
} = {}): Promise<Response> {
  const agent = createProofAgent(url, key);
  try {
    return await new Promise<Response>((resolve, reject) => {
      const call = request(url, {
        agent, method: options.method ?? "GET", headers: options.headers,
        signal: options.signal ?? AbortSignal.timeout(15_000),
      }, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("error", reject);
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 4 * 1024 * 1024) {
            response.destroy(new Error("Proof response exceeded its bounded payload size."));
          } else chunks.push(chunk);
        });
        response.once("end", () => {
          if (!response.statusCode) { reject(new Error("Missing proof HTTP status.")); return; }
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
          }
          resolve(new Response(length ? Buffer.concat(chunks) : null, { status: response.statusCode, headers }));
        });
      });
      call.once("error", reject);
      call.end(options.body);
    });
  } finally { agent.destroy(); }
}
