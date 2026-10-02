import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { rsaPublicKey } from "../init-local.mjs";

test("dedicated provisioning key exports a valid public-only OpenSSH RSA key", () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const exported = rsaPublicKey(pair.publicKey);
  assert.ok(exported.startsWith("ssh-rsa "));
  assert.ok(!exported.includes("PRIVATE"));
  const bytes = Buffer.from(exported.split(" ")[1], "base64");
  let offset = 0;
  const read = () => { const size = bytes.readUInt32BE(offset); offset += 4; const result = bytes.subarray(offset, offset + size); offset += size; return result; };
  assert.equal(read().toString(), "ssh-rsa");
  assert.equal(read().toString("hex"), "010001");
  assert.ok(read().length >= 256);
  assert.equal(offset, bytes.length);
});
