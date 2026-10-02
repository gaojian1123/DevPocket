import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Fault, hash, secret } from "./security.js";
import { createHostRecord } from "./host-record.js";
import {
  Receipt, SessionSummary, UserEvent, finalStatus,
  type Command, type EventPage, type SessionInfo, type WireEvent,
} from "./protocol.js";

const hostRow = z.object({ id: z.string(), name: z.string(), last_seen: z.number() });
const deviceRow = z.object({ id: z.string(), name: z.string() });
export type Host = { id: string; name: string; online: boolean; lastSeen: number };

export class RelayStore {
  readonly db: DatabaseSync;

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dataDir, "relay.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        last_seen INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, push_token TEXT
      );
      CREATE TABLE IF NOT EXISTS grants (
        device_id TEXT NOT NULL REFERENCES devices(id), host_id TEXT NOT NULL REFERENCES hosts(id),
        created_at INTEGER NOT NULL, PRIMARY KEY(device_id, host_id)
      );
      CREATE TABLE IF NOT EXISTS pairings (
        code_hash TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id),
        expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        host_id TEXT NOT NULL REFERENCES hosts(id), session_id TEXT NOT NULL, summary TEXT NOT NULL,
        title TEXT, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL, pruned_through INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(host_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL, host_id TEXT NOT NULL, session_id TEXT NOT NULL,
        action TEXT NOT NULL, digest TEXT NOT NULL, receipt TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS commands_scope ON commands(host_id,session_id);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, host_id TEXT NOT NULL, session_id TEXT NOT NULL,
        event_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(host_id,session_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS events_scope ON events(host_id,session_id,seq);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, host_id TEXT NOT NULL, session_id TEXT NOT NULL, device_id TEXT NOT NULL,
        name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        body BLOB NOT NULL, created_at INTEGER NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  createHost(name: string): { hostId: string; token: string; name: string } {
    const cleanName = z.string().trim().min(1).max(80).parse(name);
    return createHostRecord(this.db, cleanName);
  }

  host(token: string): { id: string; name: string } {
    const row = this.db.prepare("SELECT id,name,last_seen FROM hosts WHERE token_hash=? AND revoked=0").get(hash(token));
    if (!row) throw new Fault("UNAUTHORIZED", "Host credential is invalid or revoked.", 401);
    return hostRow.parse(row);
  }

  device(token: string): { id: string; name: string } {
    const row = this.db.prepare("SELECT id,name FROM devices WHERE token_hash=?").get(hash(token));
    if (!row) throw new Fault("UNAUTHORIZED", "Device credential is invalid.", 401);
    return deviceRow.parse(row);
  }

  authorize(deviceId: string, hostId: string): void {
    if (!this.db.prepare(`SELECT 1 FROM grants g JOIN hosts h ON g.host_id=h.id
      WHERE g.device_id=? AND g.host_id=? AND h.revoked=0`).get(deviceId, hostId)) {
      throw new Fault("FORBIDDEN", "This device is not paired with that Dev Box.", 403);
    }
  }

  pairing(hostId: string): { code: string; expiresAt: number } {
    const code = secret("dpp");
    const expiresAt = this.now() + 5 * 60_000;
    this.db.prepare("DELETE FROM pairings WHERE expires_at<? OR consumed=1").run(this.now());
    this.db.prepare("INSERT INTO pairings (code_hash,host_id,expires_at) VALUES (?,?,?)")
      .run(hash(code), hostId, expiresAt);
    return { code, expiresAt };
  }

  pair(code: string, name: string, existing?: { id: string; name: string }):
    { deviceId: string; hostId: string; token?: string } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`UPDATE pairings SET consumed=1
        WHERE code_hash=? AND consumed=0 AND expires_at>? RETURNING host_id`)
        .get(hash(code), this.now());
      if (!row) throw new Fault("PAIRING_INVALID", "Pairing code is invalid, expired, or already used.", 401);
      const { host_id: hostId } = z.object({ host_id: z.string() }).parse(row);
      const deviceId = existing?.id ?? randomUUID();
      const token = existing ? undefined : secret("dpd");
      if (token) {
        this.db.prepare("INSERT INTO devices (id,name,token_hash,created_at) VALUES (?,?,?,?)")
          .run(deviceId, name, hash(token), this.now());
      }
      this.db.prepare("INSERT OR IGNORE INTO grants VALUES (?,?,?)").run(deviceId, hostId, this.now());
      this.db.exec("COMMIT");
      return { deviceId, hostId, ...(token ? { token } : {}) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  hosts(deviceId: string): Host[] {
    return this.db.prepare(`SELECT h.id,h.name,h.last_seen FROM hosts h
      JOIN grants g ON h.id=g.host_id WHERE g.device_id=? AND h.revoked=0 ORDER BY h.name`)
      .all(deviceId).map((row) => {
        const host = hostRow.parse(row);
        return { id: host.id, name: host.name, online: false, lastSeen: host.last_seen };
      });
  }

  devices(hostId: string): { id: string; name: string }[] {
    return this.db.prepare(`SELECT d.id,d.name FROM devices d JOIN grants g ON d.id=g.device_id
      WHERE g.host_id=? ORDER BY d.name`).all(hostId).map((row) => deviceRow.parse(row));
  }

  revoke(deviceId: string, hostId: string): void {
    this.db.prepare("DELETE FROM grants WHERE device_id=? AND host_id=?").run(deviceId, hostId);
  }

  touch(hostId: string, summary: SessionSummary): boolean {
    const existed = !!this.db.prepare("SELECT 1 FROM sessions WHERE host_id=? AND session_id=?").get(hostId, summary.sessionId);
    this.db.prepare("UPDATE hosts SET last_seen=? WHERE id=?").run(this.now(), hostId);
    this.db.prepare(`INSERT INTO sessions (host_id,session_id,summary,last_seen) VALUES (?,?,?,?)
      ON CONFLICT(host_id,session_id) DO UPDATE SET summary=excluded.summary,last_seen=excluded.last_seen`)
      .run(hostId, summary.sessionId, JSON.stringify(summary), this.now());
    return existed;
  }

  session(hostId: string, sessionId: string): SessionInfo {
    const row = this.db.prepare("SELECT * FROM sessions WHERE host_id=? AND session_id=?").get(hostId, sessionId);
    if (!row) throw new Fault("SESSION_NOT_FOUND", "This session has not registered on that Dev Box.", 404);
    const value = z.object({
      summary: z.string(), title: z.string().nullable(), pinned: z.number(),
      archived: z.number(), last_seen: z.number(),
    }).parse(row);
    const summary = SessionSummary.parse(JSON.parse(value.summary));
    return { ...summary, title: value.title ?? summary.title, hostId, online: false,
      pinned: value.pinned === 1, archived: value.archived === 1, lastSeen: value.last_seen };
  }

  sessions(deviceId: string): SessionInfo[] {
    return this.db.prepare(`SELECT s.host_id,s.session_id FROM sessions s
      JOIN grants g ON s.host_id=g.host_id JOIN hosts h ON h.id=s.host_id
      WHERE g.device_id=? AND h.revoked=0 ORDER BY s.pinned DESC,s.last_seen DESC`).all(deviceId)
      .map((row) => {
        const ids = z.object({ host_id: z.string(), session_id: z.string() }).parse(row);
        return this.session(ids.host_id, ids.session_id);
      });
  }

  metadata(hostId: string, sessionId: string, patch: { title?: string; pinned?: boolean; archived?: boolean }): void {
    this.session(hostId, sessionId);
    if (patch.title !== undefined)
      this.db.prepare("UPDATE sessions SET title=? WHERE host_id=? AND session_id=?").run(patch.title, hostId, sessionId);
    if (patch.pinned !== undefined)
      this.db.prepare("UPDATE sessions SET pinned=? WHERE host_id=? AND session_id=?").run(Number(patch.pinned), hostId, sessionId);
    if (patch.archived !== undefined)
      this.db.prepare("UPDATE sessions SET archived=? WHERE host_id=? AND session_id=?").run(Number(patch.archived), hostId, sessionId);
  }

  command(deviceId: string, hostId: string, sessionId: string, commandId: string): Receipt | undefined {
    const row = this.db.prepare("SELECT device_id,host_id,session_id,receipt FROM commands WHERE id=?").get(commandId);
    if (!row) return undefined;
    if (row.device_id !== deviceId || row.host_id !== hostId || row.session_id !== sessionId)
      throw new Fault("COMMAND_CONFLICT", "Command ID belongs to another request.", 409);
    return Receipt.parse(JSON.parse(z.string().parse(row.receipt)));
  }

  submit(deviceId: string, hostId: string, sessionId: string, command: Command): { receipt: Receipt; fresh: boolean } {
    const digest = hash(JSON.stringify(command.action));
    const prior = this.command(deviceId, hostId, sessionId, command.commandId);
    if (prior) {
      if (this.db.prepare("SELECT digest FROM commands WHERE id=?").get(command.commandId)?.digest !== digest)
        throw new Fault("COMMAND_CONFLICT", "Do not reuse a command ID with different content.", 409);
      return { receipt: prior, fresh: false };
    }
    const receipt: Receipt = { commandId: command.commandId, status: "dispatched" };
    this.db.prepare("INSERT INTO commands VALUES (?,?,?,?,?,?,?,?)")
      .run(command.commandId, deviceId, hostId, sessionId, JSON.stringify(command.action), digest,
        JSON.stringify(receipt), this.now());
    return { receipt, fresh: true };
  }

  result(hostId: string, sessionId: string, receipt: Receipt): boolean {
    const row = this.db.prepare("SELECT receipt FROM commands WHERE id=? AND host_id=? AND session_id=?")
      .get(receipt.commandId, hostId, sessionId);
    if (!row) throw new Fault("COMMAND_NOT_FOUND", "Response is not for a command on this session.", 404);
    const old = Receipt.parse(JSON.parse(z.string().parse(row.receipt)));
    if (finalStatus(old.status) || old.status === receipt.status) return false;
    if (old.status === "processing" && ["admitted", "queued"].includes(receipt.status)) return false;
    this.db.prepare("UPDATE commands SET receipt=? WHERE id=?").run(JSON.stringify(receipt), receipt.commandId);
    return true;
  }

  unsettled(hostId: string, sessionId: string): (Command & { deviceId: string })[] {
    return this.db.prepare("SELECT id,device_id,action,receipt FROM commands WHERE host_id=? AND session_id=?")
      .all(hostId, sessionId).flatMap((row) => {
        const data = z.object({ id: z.string(), device_id: z.string(), action: z.string(), receipt: z.string() }).parse(row);
        const receipt = Receipt.parse(JSON.parse(data.receipt));
        if (finalStatus(receipt.status)) return [];
        return [{ commandId: data.id, deviceId: data.device_id, action: JSON.parse(data.action) as Command["action"] }];
      });
  }

  event(hostId: string, sessionId: string, event: UserEvent): WireEvent | undefined {
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO events
      (host_id,session_id,event_id,body,created_at) VALUES (?,?,?,?,?)`)
      .run(hostId, sessionId, event.id, JSON.stringify(event), this.now());
    if (!inserted.changes) return undefined;
    if (event.kind === "runtime.state") {
      const current = this.session(hostId, sessionId);
      const { hostId: _host, online: _online, pinned: _pinned, archived: _archived, lastSeen: _seen, ...summary } = current;
      this.touch(hostId, { ...summary, state: event.data.state });
    }
    const cutoff = this.db.prepare(`SELECT seq FROM events WHERE host_id=? AND session_id=?
      ORDER BY seq DESC LIMIT 1 OFFSET 19999`).get(hostId, sessionId)?.seq;
    if (typeof cutoff === "number") {
      this.db.prepare("DELETE FROM events WHERE host_id=? AND session_id=? AND seq<?").run(hostId, sessionId, cutoff);
      this.db.prepare("UPDATE sessions SET pruned_through=? WHERE host_id=? AND session_id=?")
        .run(cutoff - 1, hostId, sessionId);
    }
    return { ...event, cursor: Number(inserted.lastInsertRowid), hostId, sessionId };
  }

  events(hostId: string, sessionId: string, after: number, limit = 500): EventPage {
    const prune = this.db.prepare("SELECT pruned_through FROM sessions WHERE host_id=? AND session_id=?")
      .get(hostId, sessionId)?.pruned_through;
    const latest = this.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE host_id=? AND session_id=?")
      .get(hostId, sessionId)?.seq;
    const reset = (typeof prune === "number" && after > 0 && after < prune) ||
      (typeof latest === "number" && after > latest);
    const rows = this.db.prepare(`SELECT seq,body FROM events WHERE host_id=? AND session_id=? AND seq>?
      ORDER BY seq LIMIT ?`).all(hostId, sessionId, reset ? 0 : after, limit + 1);
    const events: WireEvent[] = [];
    let size = 0;
    for (const row of rows.slice(0, limit)) {
      const event: WireEvent = { ...UserEvent.parse(JSON.parse(z.string().parse(row.body))),
        cursor: z.number().parse(row.seq), hostId, sessionId };
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (size + bytes > 512 * 1024 && events.length) break;
      events.push(event);
      size += bytes;
    }
    return { events, cursor: events.at(-1)?.cursor ?? (reset ? 0 : after), hasMore: rows.length > events.length, reset };
  }

  upload(deviceId: string, hostId: string, sessionId: string, name: string, mime: string, bytes: Buffer) {
    this.db.prepare("DELETE FROM attachments WHERE created_at<?").run(this.now() - 7 * 86400_000);
    const size = this.db.prepare("SELECT COALESCE(SUM(size),0) AS size FROM attachments WHERE host_id=? AND session_id=?")
      .get(hostId, sessionId)?.size;
    if (z.number().parse(size) + bytes.length > 20 * 1024 * 1024)
      throw new Fault("ATTACHMENT_QUOTA", "This session's seven-day attachment quota is 20 MiB.", 413);
    const file = { id: randomUUID(), name, mime, size: bytes.length, sha256: hash(bytes) };
    this.db.prepare("INSERT INTO attachments VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(file.id, hostId, sessionId, deviceId, name, mime, bytes.length, file.sha256, bytes, this.now());
    return file;
  }

  attachment(hostId: string, sessionId: string, id: string) {
    const row = this.db.prepare(`SELECT id,name,mime,size,sha256,body FROM attachments
      WHERE id=? AND host_id=? AND session_id=? AND created_at>=?`)
      .get(id, hostId, sessionId, this.now() - 7 * 86400_000);
    if (!row) throw new Fault("ATTACHMENT_NOT_FOUND", "Attachment is expired or does not belong to this session.", 404);
    return z.object({
      id: z.string(), name: z.string(), mime: z.string(), size: z.number(), sha256: z.string(),
      body: z.instanceof(Uint8Array),
    }).parse(row);
  }

  attachments(hostId: string, sessionId: string) {
    return this.db.prepare(`SELECT id,name,mime,size,sha256 FROM attachments
      WHERE host_id=? AND session_id=? AND created_at>=? ORDER BY created_at DESC`)
      .all(hostId, sessionId, this.now() - 7 * 86400_000).map((row) =>
        z.object({ id: z.string(), name: z.string(), mime: z.string(), size: z.number(), sha256: z.string() }).parse(row));
  }

  pushToken(deviceId: string, token: string | null): void {
    this.db.prepare("UPDATE devices SET push_token=? WHERE id=?").run(token, deviceId);
  }

  pushTargets(hostId: string): { id: string; token: string }[] {
    return this.db.prepare(`SELECT d.id,d.push_token AS token FROM devices d
      JOIN grants g ON d.id=g.device_id WHERE g.host_id=? AND d.push_token IS NOT NULL`).all(hostId)
      .map((row) => z.object({ id: z.string(), token: z.string() }).parse(row));
  }
}

export function provisionHost(dataDir: string, name: string): { hostId: string; token: string; name: string } {
  const store = new RelayStore(dataDir);
  try { return store.createHost(name); } finally { store.close(); }
}
