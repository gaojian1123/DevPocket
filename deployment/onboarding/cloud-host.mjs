import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { canonical, publicFingerprint, requireValue, sealHost, sha } from "./handoff.mjs";

async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function durable(file, value) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
}
function identity(row, entry, scope) {
  requireValue(row && row.id === entry.hostId && row.name === scope.hostName &&
    row.token_hash === entry.tokenHash && row.revoked === 0, "HOST_IDENTITY_MISMATCH");
}
async function load(scope, journal) {
  const entry = JSON.parse(await readFile(path.join(journal, "handoff.json"), "utf8"));
  requireValue(entry.schemaVersion === 1 && entry.scope === canonical(scope) &&
    entry.envelope.metadata.hostId === entry.hostId && /^[a-f0-9]{64}$/.test(entry.tokenHash) &&
    entry.envelope.metadata.scopeHash === scope.scopeHash, "JOURNAL_BINDING");
  return entry;
}
export async function registerHost(scope, publicPem, store, journal, afterDurable = async () => {}) {
  requireValue(Date.now() < scope.expiresAt, "HANDOFF_EXPIRED");
  requireValue(publicFingerprint(publicPem) === scope.recipientSha256, "HANDOFF_RECIPIENT");
  await mkdir(journal, { recursive: true, mode: 0o700 });
  requireValue(!(await lstat(journal)).isSymbolicLink(), "JOURNAL_LINK");
  requireValue(!await exists(path.join(journal, "closed.json")), "HANDOFF_CLOSED");
  const file = path.join(journal, "handoff.json");
  store.db.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    let entry, duplicate = false, recovered = false;
    if (await exists(file)) {
      requireValue(!(await lstat(file)).isSymbolicLink(), "JOURNAL_LINK");
      entry = await load(scope, journal);
      const row = store.db.prepare("SELECT id,name,token_hash,revoked FROM hosts WHERE id=?").get(entry.hostId);
      if (row) { identity(row, entry, scope); duplicate = true; }
      else {
        requireValue(!store.db.prepare("SELECT 1 FROM hosts WHERE name=? OR token_hash=?").get(scope.hostName, entry.tokenHash), "HOST_NAME_COLLISION");
        // Recover only the exact identity durably encrypted before a rolled-back commit.
        store.db.prepare("INSERT INTO hosts(id,name,token_hash) VALUES(?,?,?)").run(entry.hostId, scope.hostName, entry.tokenHash);
        recovered = true;
      }
    } else {
      requireValue(!store.db.prepare("SELECT 1 FROM hosts WHERE name=?").get(scope.hostName), "HOST_NAME_COLLISION");
      const host = store.createHost(scope.hostName);
      const config = { hostId: host.hostId, token: host.token, relayUrl: scope.relayUrl,
        dataDir: scope.bridgeDataDir, allowInsecureLoopback: false };
      const envelope = sealHost(config, scope, publicPem);
      entry = { schemaVersion: 1, scope: canonical(scope), hostId: host.hostId, tokenHash: sha(host.token), envelope };
      await durable(file, entry);
      await afterDurable();
    }
    store.db.exec("COMMIT"); committed = true;
    return { status: "host_registered", hostId: entry.hostId, duplicate, recovered, envelope: entry.envelope };
  } finally { if (!committed) store.db.exec("ROLLBACK"); }
}
export async function finalizeHost(scope, store, journal, acknowledgement) {
  const closed = path.join(journal, "closed.json");
  if (await exists(closed)) {
    const previous = JSON.parse(await readFile(closed, "utf8"));
    requireValue(previous.scopeHash === scope.scopeHash && previous.hostId === acknowledgement.hostId, "CLOSED_IDENTITY");
    if (await exists(path.join(journal, "handoff.json"))) await unlink(path.join(journal, "handoff.json"));
    return { status: "handoff_cleaned", hostId: previous.hostId, handoffRemoved: true, hostRetained: true };
  }
  const entry = await load(scope, journal);
  requireValue(entry.hostId === acknowledgement.hostId &&
    sha(JSON.stringify(entry.envelope)) === acknowledgement.envelopeSha256, "HANDOFF_ACKNOWLEDGEMENT");
  identity(store.db.prepare("SELECT id,name,token_hash,revoked FROM hosts WHERE id=?").get(entry.hostId), entry, scope);
  const receipt = { scopeHash: scope.scopeHash, operationId: scope.operationId, hostId: entry.hostId,
    envelopeSha256: acknowledgement.envelopeSha256, cleanedAt: new Date().toISOString() };
  const pending = path.join(journal, "closed.pending.json");
  if (await exists(pending)) await unlink(pending);
  await durable(pending, receipt);
  await rename(pending, closed);
  await unlink(path.join(journal, "handoff.json"));
  return { status: "handoff_cleaned", hostId: entry.hostId, handoffRemoved: true, hostRetained: true };
}

export async function guestMain(input) {
  const { scope, publicKeyPem, action, acknowledgement } = input;
  requireValue(process.getuid?.() === 1000 && /^[a-f0-9-]{36}$/.test(scope.operationId), "RELAY_USER_OPERATION_SCOPE");
  const database = "/data/relay.sqlite";
  requireValue((await lstat(database)).isFile(), "EXISTING_RELAY_DATABASE_REQUIRED");
  const { DatabaseSync } = await import("node:sqlite");
  const check = new DatabaseSync(database, { readOnly: true });
  let schemaVersion;
  try {
    schemaVersion = check.prepare("PRAGMA schema_version").get().schema_version;
    requireValue(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hosts'").get(), "EXISTING_HOST_SCHEMA");
    if (action === "inspect") {
      const count = check.prepare("SELECT COUNT(*) AS n FROM hosts WHERE name=?").get(scope.hostName).n;
      return { status: "registration_ready", sameNameCount: count, schemaVersion };
    }
  } finally { check.close(); }
  requireValue(["register", "finalize"].includes(action), "HOST_ACTION_DENIED");
  const { RelayStore } = await import("/app/dist/store.js");
  const store = new RelayStore("/data");
  try {
    requireValue(store.db.prepare("PRAGMA schema_version").get().schema_version === schemaVersion, "SCHEMA_CHANGED");
    const journal = path.join("/data", ".devpocket-onboarding", scope.operationId);
    return action === "register" ? await registerHost(scope, publicKeyPem, store, journal) :
      await finalizeHost(scope, store, journal, acknowledgement);
  } finally { store.close(); }
}
