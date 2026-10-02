import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { RelayStore } from "../../../dist/store.js";
import { openHost, publicFingerprint, sha } from "../handoff.mjs";
import { registerHost, finalizeHost } from "../cloud-host.mjs";

test("registration resumes the same encrypted identity after a pre-commit crash and never duplicates or overwrites a host", async (t) => {
  const parent = path.resolve(".data", "onboarding-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "journal-"));
  const recipient = generateKeyPairSync("rsa", { modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const scope = { scopeHash: "a".repeat(64), vmId: "/subscriptions/test/vm/fixture",
    operationId: randomUUID(), nonce: "b".repeat(64), recipientSha256: publicFingerprint(recipient.publicKey),
    expiresAt: Date.now() + 600_000, hostName: "DevPocket synthetic registration",
    relayUrl: "https://relay.example", bridgeDataDir: "C:\\Synthetic\\bridge" };
  const store = new RelayStore(path.join(root, "database"));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const journal = path.join(root, "journal");
  await assert.rejects(registerHost(scope, recipient.publicKey, store, journal, async () => {
    throw new Error("SIMULATED_DURABLE_WRITE_INTERRUPTION");
  }), /SIMULATED_DURABLE/);
  const prepared = JSON.parse(await readFile(path.join(journal, "handoff.json"), "utf8"));
  const config = openHost(prepared.envelope, scope, recipient.privateKey);
  assert.throws(() => store.host(config.token), /invalid|revoked/i);
  const recovered = await registerHost(scope, recipient.publicKey, store, journal);
  assert.equal(recovered.hostId, config.hostId);
  assert.equal(recovered.recovered, true);
  assert.equal(store.host(config.token).name, scope.hostName);
  const duplicate = await registerHost(scope, recipient.publicKey, store, journal);
  assert.deepEqual(duplicate.envelope, recovered.envelope);
  assert.equal(duplicate.hostId, recovered.hostId);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(registerHost({ ...scope, nonce: "c".repeat(64) }, recipient.publicKey, store, journal), /JOURNAL_BINDING/);
  await assert.rejects(registerHost({ ...scope, operationId: randomUUID(), scopeHash: "d".repeat(64) },
    recipient.publicKey, store, path.join(root, "another")), /HOST_NAME_COLLISION/);
  assert.ok(!(await readFile(path.join(journal, "handoff.json"), "utf8")).includes(config.token));
  const final = await finalizeHost(scope, store, journal, { hostId: config.hostId,
    envelopeSha256: sha(JSON.stringify(recovered.envelope)) });
  assert.equal(final.handoffRemoved, true);
  assert.equal(final.hostRetained, true);
  assert.equal(store.host(config.token).id, config.hostId);
  assert.deepEqual(await readdir(journal), ["closed.json"]);
  await assert.rejects(registerHost(scope, recipient.publicKey, store, journal), /HANDOFF_CLOSED/);
});
