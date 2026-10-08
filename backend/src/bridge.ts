import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { z } from "zod";
import { Command, Id, MAX_UPLOAD, PROTOCOL, Receipt, RelayReady, UserEvent, finalStatus, type DeliveryStatus, type SessionSummary } from "./protocol.js";
import { CopilotRuntime, type JoinedSession, type LocalAttachment } from "./runtime.js";
import { Fault, fileName, hash, publicError, relayUrl } from "./security.js";

export const HostConfig = z.object({
  hostId: Id, token: z.string().regex(/^dph_[A-Za-z0-9_-]{43}$/),
  relayUrl: z.string().url(), dataDir: z.string().min(1),
  allowInsecureLoopback: z.boolean().default(false),
}).strict();
export type HostConfig = z.infer<typeof HostConfig>;

class Journal {
  readonly db: DatabaseSync;
  readonly uploads: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.uploads = path.join(directory, "uploads");
    mkdirSync(this.uploads, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, "bridge.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, action TEXT NOT NULL, receipt TEXT,
        message_id TEXT, created_at INTEGER NOT NULL, acked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, entity TEXT, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS origins (id TEXT PRIMARY KEY, at INTEGER NOT NULL, idle INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS idle_marker (id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL, aborted INTEGER NOT NULL);
    `);
  }

  begin(command: Command): { fresh: boolean; receipt?: Receipt } {
    const digest = hash(JSON.stringify(command.action));
    const existing = this.db.prepare("SELECT digest,receipt FROM commands WHERE id=?").get(command.commandId);
    if (existing) {
      if (existing.digest !== digest) throw new Fault("COMMAND_CONFLICT", "Command ID has different content.", 409);
      if (typeof existing.receipt === "string")
        return { fresh: false, receipt: Receipt.parse(JSON.parse(existing.receipt)) };
      const receipt: Receipt = { commandId: command.commandId, status: "uncertain",
        error: { code: "DELIVERY_UNCERTAIN", message: "The bridge restarted during this operation. Inspect the original terminal; it will not be executed again automatically." } };
      this.save(receipt);
      return { fresh: false, receipt };
    }
    this.db.prepare("INSERT INTO commands (id,digest,action,created_at) VALUES (?,?,?,?)")
      .run(command.commandId, digest, JSON.stringify(command.action), Date.now());
    return { fresh: true };
  }

  save(receipt: Receipt): void {
    const previous = this.db.prepare("SELECT receipt FROM commands WHERE id=?").get(receipt.commandId)?.receipt;
    if (typeof previous === "string" && finalStatus(Receipt.parse(JSON.parse(previous)).status)) return;
    const messageId = receipt.result?.messageId;
    let final = receipt;
    if (typeof messageId === "string" && ["admitted", "queued", "processing"].includes(receipt.status)) {
      const seen = this.db.prepare("SELECT idle FROM origins WHERE id=?").get(messageId);
      if (seen) final = { ...receipt, status: seen.idle === 1 ? "completed" : "processing" };
    }
    if (receipt.status === "cancel_requested") {
      const created = this.db.prepare("SELECT created_at FROM commands WHERE id=?").get(receipt.commandId)?.created_at;
      const idle = this.db.prepare("SELECT at,aborted FROM idle_marker WHERE id=1").get();
      if (typeof created === "number" && typeof idle?.at === "number" && idle.at >= created)
        final = { ...receipt, status: "completed", result: { ...receipt.result, stopped: true, idle: true, aborted: idle.aborted === 1 } };
    }
    this.db.prepare("UPDATE commands SET receipt=?,message_id=COALESCE(?,message_id),acked=0 WHERE id=?")
      .run(JSON.stringify(final), typeof messageId === "string" ? messageId : null, receipt.commandId);
    if (final.status === "completed" && final.result?.idle === true && Array.isArray(final.result.cancelledMessageIds)) {
      for (const id of final.result.cancelledMessageIds) {
        if (typeof id !== "string") continue;
        for (const row of this.db.prepare("SELECT receipt FROM commands WHERE message_id=?").all(id)) {
          if (typeof row.receipt !== "string") continue;
          const queued = Receipt.parse(JSON.parse(row.receipt));
          if (!finalStatus(queued.status)) this.save({ ...queued, status: "cancelled" });
        }
      }
    }
  }

  observe(event: UserEvent): void {
    if (event.kind === "user.message" || (event.kind === "assistant.message" && event.data.originatingMessageId)) {
      const origin = event.kind === "user.message" ? event.data.messageId : event.data.originatingMessageId!;
      this.db.prepare(`INSERT INTO origins (id,at) VALUES (?,?) ON CONFLICT(id) DO UPDATE
        SET at=MAX(at,excluded.at),idle=0`).run(origin, Date.parse(event.at));
      for (const row of this.db.prepare("SELECT receipt FROM commands WHERE message_id=?").all(origin)) {
        if (typeof row.receipt === "string") {
          const receipt = Receipt.parse(JSON.parse(row.receipt));
          if (!finalStatus(receipt.status)) this.save({ ...receipt, status: "processing" });
        }
      }
    }
    if (event.kind === "runtime.state" && event.data.state === "idle") {
      const at = Date.parse(event.at);
      this.db.prepare(`INSERT INTO idle_marker VALUES (1,?,?) ON CONFLICT(id) DO UPDATE
        SET at=excluded.at,aborted=excluded.aborted WHERE excluded.at>=idle_marker.at`).run(at, Number(event.data.aborted === true));
      this.db.prepare("UPDATE origins SET idle=1 WHERE at<=?").run(at);
      for (const row of this.db.prepare("SELECT id,action,receipt,message_id,created_at FROM commands WHERE created_at<=?").all(at)) {
        if (typeof row.receipt !== "string") continue;
        const receipt = Receipt.parse(JSON.parse(row.receipt));
        if (finalStatus(receipt.status)) continue;
        if (receipt.status === "cancel_requested") {
          this.save({ ...receipt, status: "completed", result: { ...receipt.result, stopped: true, idle: true, aborted: event.data.aborted === true } });
        } else if (typeof row.message_id === "string" &&
          this.db.prepare("SELECT 1 FROM origins WHERE id=? AND idle=1").get(row.message_id)) {
          this.save({ ...receipt, status: event.data.aborted ? "cancelled" : "completed" });
        }
      }
    }
  }

  enqueue(event: UserEvent): void {
    const entity = event.kind === "assistant.delta" ? `assistant:${event.data.messageId}` :
      event.kind === "tool.output" && !event.data.complete ? `tool:${event.data.toolCallId}` : null;
    if (entity) this.db.prepare("DELETE FROM outbox WHERE entity=?").run(entity);
    if (event.kind === "assistant.message") this.db.prepare("DELETE FROM outbox WHERE entity=?").run(`assistant:${event.data.messageId}`);
    if (event.kind === "tool.output" && event.data.complete) this.db.prepare("DELETE FROM outbox WHERE entity=?").run(`tool:${event.data.toolCallId}`);
    const size = this.db.prepare("SELECT COALESCE(SUM(length(body)),0) AS size FROM outbox").get()?.size;
    if (typeof size === "number" && size > 64 * 1024 * 1024)
      throw new Fault("BRIDGE_BUFFER_FULL", "Offline event buffer exceeded 64 MiB. The original terminal is unaffected; inspect the bridge log.");
    this.db.prepare("INSERT OR IGNORE INTO outbox (id,entity,body) VALUES (?,?,?)").run(event.id, entity, JSON.stringify(event));
  }

  events(): UserEvent[] {
    const selected: UserEvent[] = [];
    let bytes = 0;
    for (const row of this.db.prepare("SELECT body FROM outbox ORDER BY seq LIMIT 80").all()) {
      const body = z.string().parse(row.body);
      if (bytes + Buffer.byteLength(body) > 512 * 1024 && selected.length) break;
      bytes += Buffer.byteLength(body);
      selected.push(UserEvent.parse(JSON.parse(body)));
    }
    return selected;
  }

  receipts(): Receipt[] {
    return this.db.prepare("SELECT receipt FROM commands WHERE receipt IS NOT NULL AND acked=0 LIMIT 80").all()
      .map((row) => Receipt.parse(JSON.parse(z.string().parse(row.receipt))));
  }

  acknowledge(ids: string[]): void {
    const statement = this.db.prepare("DELETE FROM outbox WHERE id=?");
    for (const id of ids) statement.run(id);
  }

  acknowledgeResult(id: string, status: DeliveryStatus): void {
    const row = this.db.prepare("SELECT receipt FROM commands WHERE id=?").get(id);
    if (typeof row?.receipt === "string" && Receipt.parse(JSON.parse(row.receipt)).status === status)
      this.db.prepare("UPDATE commands SET acked=1 WHERE id=?").run(id);
  }
}

const RelayFrame = z.discriminatedUnion("type", [
  RelayReady,
  z.object({ type: z.literal("command"), ...Command.shape }).strict(),
  z.object({ type: z.literal("eventsAck"), ids: z.array(z.string()).max(200) }).strict(),
  z.object({ type: z.literal("resultAck"), commandId: Id, status: Receipt.shape.status }).strict(),
  z.object({ type: z.literal("error"), error: z.object({ code: z.string(), message: z.string() }) }).strict(),
]);

export async function startBridge(session: JoinedSession, input: HostConfig,
  options: { waitForReady?: boolean } = {}): Promise<{ close(): Promise<void>; runtime: CopilotRuntime }> {
  const config = HostConfig.parse(input);
  const origin = relayUrl(config.relayUrl, config.allowInsecureLoopback);
  Id.parse(session.sessionId);
  const journal = new Journal(path.join(config.dataDir, config.hostId, session.sessionId));
  const runtime = new CopilotRuntime(session, (event) => { journal.observe(event); journal.enqueue(event); });
  await runtime.connect();
  await writeFile(path.join(config.dataDir, config.hostId, session.sessionId, "registration.json"), JSON.stringify({
    sessionId: session.sessionId, extensionPid: process.pid, parentPid: process.ppid, attachedAt: new Date().toISOString(),
    recordedCliVersion: runtime.summary.cliVersion, capabilities: runtime.summary.capabilities,
  }, null, 2), { mode: 0o600 });
  let ws: WebSocket | undefined, stopped = false, ready = false, permanentFailure = false;
  let workspaceMetadata: boolean | undefined;
  let retry: NodeJS.Timeout | undefined, attempts = 0, eventInFlight = false, closed = false;
  let summaryPending = false;
  const inFlight = new Map<string, Promise<void>>();
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const firstReady = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  if (options.waitForReady === false) void firstReady.catch((error: unknown) => {
    console.error("[DevPocket] Relay registration failed:", error instanceof Fault ? error.code : "connection error");
  });

  function send(value: unknown): boolean {
    if (!ready || ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount >= 2 * 1024 * 1024) return false;
    ws.send(JSON.stringify(value));
    return true;
  }
  function summaryForRelay(summary: SessionSummary): SessionSummary {
    if (workspaceMetadata === true) return summary;
    const { workspace, ...legacy } = summary;
    if (workspace && workspaceMetadata === false) legacy.warnings = [
      ...legacy.warnings.slice(0, 19),
      "This relay does not support workspace labels. Update the relay to display branches and working trees.",
    ];
    return legacy;
  }
  function flush(): void {
    if (!ready || stopped) return;
    // Publish refreshed model state before completion, without overwriting newer queued activity events.
    if (summaryPending) {
      if (!send({ type: "summary", summary: summaryForRelay(runtime.summary) })) return;
      summaryPending = false;
    }
    if (!eventInFlight) {
      const items = journal.events();
      if (items.length) eventInFlight = send({ type: "events", items });
    }
    for (const receipt of journal.receipts()) send({ type: "result", ...receipt });
  }

  async function attachment(id: string): Promise<LocalAttachment> {
    const response = await fetch(new URL(`/v1/host/sessions/${session.sessionId}/attachments/${id}`, origin), {
      headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    if (!response.ok) throw new Fault("ATTACHMENT_UNAVAILABLE", `Relay refused attachment (${response.status}).`, 409);
    if (!response.body || Number(response.headers.get("content-length")) > MAX_UPLOAD)
      throw new Fault("ATTACHMENT_TOO_LARGE", "Attachment exceeds 2 MiB.");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > MAX_UPLOAD) throw new Fault("ATTACHMENT_TOO_LARGE", "Attachment exceeds 2 MiB.");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(chunks);
    if (hash(bytes) !== response.headers.get("x-content-sha256")) throw new Fault("ATTACHMENT_CORRUPT", "Attachment checksum did not match.");
    const encoded = response.headers.get("content-disposition")?.match(/filename\*=UTF-8''(.+)$/)?.[1];
    if (!encoded) throw new Fault("ATTACHMENT_INVALID", "Attachment name is missing.");
    const name = fileName(decodeURIComponent(encoded));
    const target = path.join(journal.uploads, `${id}-${name}`);
    try { await writeFile(target, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (hash(await readFile(target)) !== hash(bytes)) throw new Fault("ATTACHMENT_CORRUPT", "Local attachment cache changed.");
    }
    return { type: "file", path: target, displayName: name };
  }

  async function execute(command: Command): Promise<void> {
    const claim = journal.begin(command);
    if (!claim.fresh) { if (claim.receipt) send({ type: "result", ...claim.receipt }); return; }
    let invoked = false;
    try {
      const attachments = command.action.type === "message"
        ? await Promise.all(command.action.attachmentIds.map(attachment)) : [];
      invoked = true;
      const result = await runtime.execute(command.action, attachments);
      journal.save({ commandId: command.commandId, ...result });
    } catch (error) {
      const uncertain = invoked && !(error instanceof Fault) &&
        ["message", "abort", "permission", "answer", "model.set"].includes(command.action.type);
      journal.save({ commandId: command.commandId, status: uncertain ? "uncertain" : "failed",
        error: uncertain ? { code: "DELIVERY_UNCERTAIN", message: "The runtime may have accepted this operation. Inspect the terminal; DevPocket will not execute it again automatically." } : publicError(error) });
      console.error("[DevPocket] Command failed:", error instanceof Fault ? error.code : "runtime error");
    }
    if (["models", "model.set", "refresh"].includes(command.action.type)) summaryPending = true;
    flush();
  }

  function connect(): void {
    if (stopped || permanentFailure) return;
    workspaceMetadata = undefined;
    const url = new URL("/v1/host/stream", origin);
    url.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("sessionId", session.sessionId);
    url.searchParams.set("workspaceMetadata", "1");
    ws = new WebSocket(url, { headers: { Authorization: `Bearer ${config.token}` },
      maxPayload: 4 * 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 15_000 });
    const socket = ws;
    // Protocol-v1 peers validate fields strictly, so the first hello remains legacy-shaped.
    socket.on("open", () => socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, summary: summaryForRelay(runtime.summary) })));
    socket.on("message", (bytes) => {
      try {
        const frame = RelayFrame.parse(JSON.parse(bytes.toString()));
        if (frame.type === "ready") {
          if (frame.hostId !== config.hostId || frame.sessionId !== session.sessionId) throw new Fault("SCOPE_MISMATCH", "Relay registered a different session.");
          workspaceMetadata = frame.workspaceMetadata === true;
          ready = true; eventInFlight = false; attempts = 0;
          send({ type: "summary", summary: summaryForRelay(runtime.summary) });
          resolveReady(); flush();
        } else if (frame.type === "command") {
          if (!ready) throw new Fault("NOT_READY", "Relay issued a command before registration.");
          if (inFlight.has(frame.commandId)) return;
          const work = execute(Command.parse({ commandId: frame.commandId, action: frame.action }));
          inFlight.set(frame.commandId, work);
          void work.finally(() => inFlight.delete(frame.commandId)).catch((error: unknown) => {
            console.error("[DevPocket] Durable command journal failed:", error instanceof Error ? error.name : "unknown");
            socket.close(1011, "Journal error");
          });
        } else if (frame.type === "eventsAck") {
          journal.acknowledge(frame.ids); eventInFlight = false; flush();
        } else if (frame.type === "resultAck") {
          journal.acknowledgeResult(frame.commandId, frame.status);
        } else {
          console.error("[DevPocket] Relay rejected a frame:", frame.error.code);
          socket.close(1008, "Relay rejected frame");
        }
      } catch (error) {
        console.error("[DevPocket] Invalid relay frame:", error instanceof Fault ? error.code : "PROTOCOL_INVALID");
        socket.close(1008, "Invalid relay frame");
      }
    });
    socket.on("unexpected-response", (_request, response) => {
      if ([401, 403].includes(response.statusCode ?? 0)) {
        permanentFailure = true;
        rejectReady(new Fault("HOST_REGISTRATION_REJECTED", `Relay refused host registration (${response.statusCode}). Check the independent host credential and existing registration.`));
      }
      if (response.statusCode === 409) console.error("[DevPocket] Waiting for the previous registered connection to close.");
      response.resume();
      socket.terminate();
    });
    socket.on("error", () => console.error("[DevPocket] Relay connection interrupted; the terminal is unaffected."));
    socket.on("close", () => {
      if (socket !== ws) return;
      ready = false; eventInFlight = false;
      if (!stopped && !permanentFailure) retry = setTimeout(connect, Math.min(30_000, 500 * 2 ** Math.min(attempts++, 6)) + Math.random() * 500);
    });
  }

  const flushTimer = setInterval(flush, 120);
  let refreshing = false;
  const refreshTimer = setInterval(() => {
    if (stopped || refreshing) return;
    refreshing = true;
    void runtime.refresh().then((summary) => send({ type: "summary", summary: summaryForRelay(summary) }))
      .catch((error: unknown) => console.error("[DevPocket] Runtime refresh failed:", error instanceof Error ? error.name : "unknown"))
      .finally(() => { refreshing = false; });
  }, 10_000);
  connect();
  const handle = {
    runtime,
    close: async () => {
      if (closed) return;
      closed = true; stopped = true; ready = false;
      if (retry) clearTimeout(retry);
      clearInterval(flushTimer); clearInterval(refreshTimer);
      runtime.close();
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        const socket = ws;
        await new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.terminate(); });
      }
      await Promise.allSettled(inFlight.values());
      journal.db.close();
    },
  };
  if (options.waitForReady !== false) {
    const timeout = setTimeout(() => rejectReady(new Fault("RELAY_OFFLINE", "The relay did not become ready within 20 seconds.", 503)), 20_000);
    try { await firstReady; } catch (error) { await handle.close(); throw error; } finally { clearTimeout(timeout); }
  }
  return handle;
}
