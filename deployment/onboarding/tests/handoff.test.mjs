import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { sealHost, openHost, publicFingerprint } from "../handoff.mjs";

const key = () => generateKeyPairSync("rsa", {
  modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
export function fixture(publicKey) {
  return {
    scopeHash: "a".repeat(64), vmId: "/subscriptions/fixture/resourceGroups/test/providers/Microsoft.Compute/virtualMachines/test",
    operationId: "11111111-1111-4111-8111-111111111111", nonce: "b".repeat(64),
    recipientSha256: publicFingerprint(publicKey), expiresAt: Date.now() + 600_000,
    hostName: "DevPocket synthetic host", relayUrl: "https://relay.example",
    bridgeDataDir: "C:\\PrivateFixture\\bridge",
  };
}

test("only the intended recipient can accept a target-bound host handoff without plaintext in the envelope", () => {
  const recipient = key(), scope = fixture(recipient.publicKey);
  const config = { hostId: "22222222-2222-4222-8222-222222222222",
    token: "dph_" + randomBytes(32).toString("base64url"), relayUrl: scope.relayUrl,
    dataDir: scope.bridgeDataDir, allowInsecureLoopback: false };
  const sealed = sealHost(config, scope, recipient.publicKey);
  assert.deepEqual(openHost(sealed, scope, recipient.privateKey), config);
  const wire = JSON.stringify(sealed);
  assert.ok(!wire.includes(config.token));
  assert.ok(!wire.includes(Buffer.from(JSON.stringify(config)).toString("base64")));
  assert.ok(!wire.includes("PRIVATE KEY"));
  for (const changed of [
    { vmId: scope.vmId + "-wrong" }, { nonce: "c".repeat(64) },
    { scopeHash: "d".repeat(64) }, { operationId: "33333333-3333-4333-8333-333333333333" },
  ]) assert.throws(() => openHost(sealed, { ...scope, ...changed }, recipient.privateKey), /HANDOFF_BINDING/);
  assert.throws(() => openHost(sealed, scope, recipient.privateKey, scope.expiresAt + 1), /HANDOFF_EXPIRED/);
  const damaged = structuredClone(sealed);
  const tag = Buffer.from(damaged.tag, "base64"); tag[0] ^= 1; damaged.tag = tag.toString("base64");
  assert.throws(() => openHost(damaged, scope, recipient.privateKey), /HANDOFF_AUTHENTICATION/);
  assert.throws(() => openHost(sealed, scope, key().privateKey), /HANDOFF_RECIPIENT/);
});
