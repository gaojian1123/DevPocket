import assert from "node:assert/strict";
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from "node:crypto";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseProbeResult } from "../probe-runner.mjs";
import { canonical, createSyntheticFixture, encryptFixture, validateProbeArguments } from "../probe-crypto.mjs";

test("synthetic-only fixture encryption binds authenticated metadata and never accepts a real archive input", async (t) => {
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const parent = path.join(project, ".data", "azure-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "probe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await createSyntheticFixture(directory, "small", 512);
  const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const pub = pair.publicKey.export({ type: "spki", format: "pem" });
  const meta = { vmId: "/subscriptions/test/resourceGroups/test/providers/Microsoft.Compute/virtualMachines/test",
    transferId: "00000000-0000-4000-8000-000000000001", fixtureId: "small", fixtureSha256: fixture.archiveSha256,
    expiresAt: Date.now() + 600000, protocol: "DevPocketSyntheticProbe/1" };
  const encrypted = await encryptFixture(directory, fixture, pub, meta);
  assert.ok(!JSON.stringify(encrypted.envelope).includes(fixture.sentinel));
  const key = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(encrypted.envelope.wrappedKey, "base64"));
  const decrypt = (metadata) => {
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.envelope.nonce, "base64"));
    cipher.setAAD(Buffer.from(canonical(metadata)));
    cipher.setAuthTag(Buffer.from(encrypted.envelope.tag, "base64"));
    return Buffer.concat([cipher.update(encrypted.ciphertext), cipher.final()]);
  };
  assert.deepEqual(decrypt(encrypted.envelope.metadata), await readFile(fixture.file));
  assert.throws(() => decrypt({ ...encrypted.envelope.metadata, vmId: "another-vm" }));
  assert.throws(() => validateProbeArguments(["run", "--archive", "real-source.tar.gz"]), /Unknown|not allowed/);
  assert.throws(() => validateProbeArguments(["run", "--vm", "another-vm"]), /Unknown|not allowed/);
  await assert.rejects(encryptFixture(directory, { ...fixture, file: path.join(directory, "..", "packages", "real-source.tar.gz") },
    pub, meta), /cannot read any real source archive/);
  assert.equal(encrypted.envelope.metadata.archiveBytes, fixture.archiveBytes);
  encrypted.key.fill(0); key.fill(0);
});

test("Node sender and the actual Python receiver interoperate without exposing key or synthetic plaintext in results", async (t) => {
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const parent = path.join(project, ".data", "azure-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "probe-cross-"));
  const vmDirectory = path.join(directory, "vm");
  await mkdir(vmDirectory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await createSyntheticFixture(directory, "small", 512);
  const plan = { protocol: "DevPocketSyntheticProbe/1", planHash: "a".repeat(64),
    vmId: "/subscriptions/fixture/resourceGroups/fixture/providers/Microsoft.Compute/virtualMachines/fixture",
    transferId: "00000000-0000-4000-8000-000000000009", expiresAt: Date.now() + 600000,
    fixtures: { small: { archiveSha256: fixture.archiveSha256, archiveBytes: fixture.archiveBytes,
      contentSha256: fixture.contentSha256, contentBytes: fixture.contentBytes } } };
  const python = process.env.DEVPOCKET_PROBE_PYTHON ??
    path.join(project, ".tools", "probe-python", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
  const invoke = (operation, values = {}) => {
    const script = `import importlib.util,json,sys\nfrom pathlib import Path\np=json.load(sys.stdin)\ns=importlib.util.spec_from_file_location("receiver",p["receiver"])\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.BASE=Path(p["root"])\nif p["operation"]=="init": r=m.initialize(p["plan"])\nelse:\n m.begin(p["plan"],p["envelope"])\n for i,c in enumerate(p["chunks"]): m.receive_chunk(p["plan"],"small",i,c)\n r=m.finish(p["plan"],"small");m.cleanup(p["plan"])\nprint(json.dumps(r))`;
    const result = spawnSync(python, ["-c", script], {
      input: JSON.stringify({ operation, receiver: path.join(project, "deployment", "azure", "probe", "receiver.py"),
        root: vmDirectory, plan, ...values }), encoding: "utf8", timeout: 10000,
      env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(project, ".data", "probe-local-tests", "pycache") },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const key = invoke("init");
  const encrypted = await encryptFixture(directory, fixture, key.publicKeyPem, {
    protocol: plan.protocol, probePlanHash: plan.planHash, vmId: plan.vmId, transferId: plan.transferId,
    fixtureId: "small", fixtureSha256: fixture.archiveSha256, expiresAt: plan.expiresAt,
  });
  const result = invoke("finish", { envelope: encrypted.envelope, chunks: encrypted.chunks.map((c) => c.toString("base64")) });
  assert.equal(result.status, "fixture_verified");
  assert.equal(result.sha256, fixture.archiveSha256);
  assert.ok(!JSON.stringify(result).includes(fixture.sentinel));
  assert.ok(!JSON.stringify(result).includes(encrypted.key.toString("base64")));
  encrypted.key.fill(0);
});

test("ARM output audit rejects accidental sentinel/private-key content before persisting raw logs", () => {
  const response = (value) => ({ value: [{ message: `DEVPOCKET_PROBE_RESULT=${JSON.stringify(value)}` }] });
  assert.equal(parseProbeResult(response({ status: "ready" })).status, "ready");
  assert.throws(() => parseProbeResult(response({ status: "failed", unexpected: "synthetic-sentinel" }), ["synthetic-sentinel"]), /forbidden/);
  assert.throws(() => parseProbeResult(response({ status: "failed", value: "-----BEGIN PRIVATE KEY-----" })), /forbidden/);
  assert.throws(() => parseProbeResult({ value: [{ message: "ARM accepted only" }] }), /evidence/);
});
