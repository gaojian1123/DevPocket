import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openExistingHostStore } from "../cloud-host.mjs";
import { sha } from "../handoff.mjs";

const hostSchema = `CREATE TABLE hosts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  last_seen INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0
)`;
const schema = (db) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();

async function fixture(t, sql) {
  const directory = await mkdtemp(path.join(tmpdir(), "devpocket-existing-db-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "relay.sqlite");
  if (sql) {
    const db = new DatabaseSync(file);
    try { db.exec(sql); } finally { db.close(); }
  }
  return file;
}

test("onboarding never creates a missing relay database", async (t) => {
  const file = await fixture(t);
  await assert.rejects(openExistingHostStore(file), { code: "ENOENT" });
  await assert.rejects(readFile(file), { code: "ENOENT" });
});

test("incompatible existing host schemas are rejected without changing database bytes", async (t) => {
  for (const sql of [
    "CREATE TABLE unrelated(value TEXT)",
    "CREATE TABLE hosts(id TEXT PRIMARY KEY,name TEXT,token_hash TEXT)",
    hostSchema.replace("token_hash TEXT NOT NULL UNIQUE", "token_hash TEXT NOT NULL"),
    hostSchema + "; CREATE TRIGGER unexpected AFTER INSERT ON hosts BEGIN UPDATE hosts SET revoked=1; END",
  ]) {
    const file = await fixture(t, sql);
    const before = await readFile(file);
    for (const readOnly of [true, false])
      await assert.rejects(openExistingHostStore(file, { readOnly }), /EXISTING_HOST_SCHEMA/);
    assert.deepEqual(await readFile(file), before);
  }
});

test("a compatible host-only database stays unmigrated through inspection and registration", async (t) => {
  const file = await fixture(t, hostSchema + "; CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('preserve')");
  const readOnly = await openExistingHostStore(file, { readOnly: true });
  const before = schema(readOnly.db);
  const version = readOnly.db.prepare("PRAGMA schema_version").get().schema_version;
  assert.throws(() => readOnly.createHost("cannot write"), /readonly/i);
  readOnly.close();
  const store = await openExistingHostStore(file);
  try {
    const host = store.createHost(" My Dev Box ");
    const row = store.db.prepare("SELECT * FROM hosts").get();
    assert.equal(row.id, host.hostId);
    assert.equal(row.name, "My Dev Box");
    assert.equal(row.token_hash, sha(host.token));
    assert.equal(row.last_seen, 0);
    assert.equal(row.revoked, 0);
    assert.deepEqual(schema(store.db), before);
    assert.equal(store.db.prepare("PRAGMA schema_version").get().schema_version, version);
    assert.equal(store.db.prepare("SELECT value FROM unrelated").get().value, "preserve");
    assert.throws(() => store.createHost(" "), /HOST_NAME/);
  } finally { store.close(); }
});
