import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { hash, secret } from "./security.js";

export function createHostRecord(db: DatabaseSync, name: string): { hostId: string; token: string; name: string } {
  const hostId = randomUUID(), token = secret("dph");
  db.prepare("INSERT INTO hosts (id,name,token_hash) VALUES (?,?,?)").run(hostId, name, hash(token));
  return { hostId, token, name };
}
