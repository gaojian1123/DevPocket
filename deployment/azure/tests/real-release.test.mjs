import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as tar from "tar";
import { createHash } from "node:crypto";
import { inspectFrozenArchive, validateRealArguments, REAL_MAX_REQUEST_BYTES } from "../real-archive.mjs";
import { realResult, renderRealAction, actionOnce } from "../real-actions.mjs";
import { RealRunner } from "../real-runner.mjs";
import { sourceFingerprint } from "../package.mjs";
import { spawnSync } from "node:child_process";

const hash = (value) => createHash("sha256").update(value).digest("hex");
test("frozen business import authenticates the exact archive and per-file manifest without executing it", async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const parent = path.join(root, ".data", "azure-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "frozen-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = {
    "package.json": Buffer.from('{"name":"fixture","version":"0.1.0","scripts":{"unsafe":"MUST_NOT_EXECUTE"}}'),
    "deployment-target.json": Buffer.from('{"schemaVersion":1,"deploymentId":"fixture","host":"fixture.example","tlsEmail":"operator@example.com","autostart":true}'),
    "deployment/azure/vm/control.py": Buffer.from('raise RuntimeError("MUST_NOT_EXECUTE")\n'),
  };
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), body);
  }
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, files: Object.entries(files).map(([name, body]) => ({ name, sha256: hash(body) })) }));
  await writeFile(path.join(directory, "release-manifest.json"), manifest);
  const archive = path.join(directory, "candidate.tar.gz");
  await tar.c({ cwd: directory, file: archive, gzip: true, portable: true, noDirRecurse: true }, [...Object.keys(files), "release-manifest.json"]);
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(archive);
  const result = await inspectFrozenArchive(archive, { sha256: hash(bytes), bytes: bytes.length });
  assert.equal(result.manifestSha256, hash(manifest));
  assert.equal(result.fileCount, 3);
  assert.equal(result.controlSha256, hash(files["deployment/azure/vm/control.py"]));
  assert.equal(result.version, "0.1.0");
  await assert.rejects(inspectFrozenArchive(archive, { sha256: "a".repeat(64), bytes: bytes.length }), /FROZEN_HASH/);
  await assert.rejects(inspectFrozenArchive(archive, { sha256: hash(bytes), bytes: bytes.length + 1 }), /FROZEN_SIZE/);
  assert.throws(() => validateRealArguments(["run", "--archive", "another.tar.gz"]), /Unknown/);
  assert.throws(() => validateRealArguments(["run", "--vm", "another"]), /Unknown/);
  assert.equal(REAL_MAX_REQUEST_BYTES, 36369);
});

test("real ARM evidence rejects unknown fields, leaked values and unbounded image/error output", () => {
  const response = (value) => ({ value: [{ message: "DEVPOCKET_REAL_RESULT=" + JSON.stringify(value) }] });
  assert.equal(realResult(response({ status: "ready", targetVerified: true, dependenciesInstalled: false })).status, "ready");
  assert.throws(() => realResult(response({ status: "ready", sourceText: "PRIVATE_SOURCE" })), /RESULT_SCHEMA/);
  assert.throws(() => realResult(response({ status: "failed", code: "SECRET_KEY_VALUE" }), ["SECRET_KEY_VALUE"]), /PROHIBITED_OUTPUT/);
  assert.throws(() => realResult(response({ status: "failed", code: "Traceback with source code" })), /RESULT_ERROR_CODE/);
  assert.throws(() => realResult(response({ status: "image_built", imageId: "source text", caddyImage: "other", blobUsed: false })), /RESULT_IMAGE_ID/);
  assert.throws(() => realResult(response({ status: "bootstrap_verified" })), /RESULT_SCHEMA/);
});

test("no successful authenticated import means no Azure call for build or activation", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const plan = { target: { tenantId: "22222222-2222-4222-8222-222222222222", subscriptionId: "11111111-1111-4111-8111-111111111111",
    resourceGroup: "rg-devpocket-fixture" }, names: { vm: "vm-fixture" }, planHash: "a".repeat(64) };
  const runner = new RealRunner(root, path.join(root, ".data", "nonexistent-real-fixture"), plan, {}, "not-a-real-package");
  runner.api.arm = async () => { throw new Error("Azure must not be reached"); };
  await assert.rejects(runner.action("build"), /SUCCESSFUL_IMPORT_REQUIRED/);
  await assert.rejects(runner.action("activate"), /SUCCESSFUL_IMPORT_REQUIRED/);
  await assert.rejects(runner.api.upload({}), /BLOB_CALL_FORBIDDEN/);
  await assert.rejects(runner.api.runVm("anything", {}, ""), /UNSCOPED_VM_SCRIPT_FORBIDDEN/);
});

test("real CLI cannot inherit exhausted Blob/probe phases or submit an unapproved VM action", async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const parent = path.join(root, ".data", "azure", "real-guard-fixture");
  const directory = path.join(parent, "real-release-001");
  await mkdir(directory, { recursive: true });
  await mkdir(path.join(parent, "recovery-001"), { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeFile(path.join(parent, "recovery-001", "baseline.json"), "{}");
  const body = { schemaVersion: 1, kind: "frozen-real-release", sourceHash: await sourceFingerprint(root),
    target: { tenantId: "22222222-2222-4222-8222-222222222222", subscriptionId: "11111111-1111-4111-8111-111111111111",
      resourceGroup: "rg-devpocket-fixture" }, names: { vm: "vm-fixture" }, business: { archiveSha256: "a".repeat(64) } };
  const plan = { ...body, planHash: hash(JSON.stringify(body)) };
  await writeFile(path.join(directory, "plan.json"), JSON.stringify(plan));
  await writeFile(path.join(directory, "approval.local.json"), JSON.stringify({ schemaVersion: 1, planHash: plan.planHash,
    phases: ["upload", "deploy", "start", "probe-key"], issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString() }));
  const cli = path.join(root, "deployment", "azure", "real-release.mjs");
  for (const action of ["predeploy", "run", "cleanup-transfer"]) {
    const result = spawnSync(process.execPath, [cli, action, "--directory", directory],
      { encoding: "utf8", timeout: 15000, cwd: root });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not permit phase real-/);
  }
  await assert.rejects(stat(path.join(directory, "operations")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(directory, "run-started.json")), { code: "ENOENT" });
});

test("an unknown VM Action result leaves an in-flight barrier and never resubmits or cleans concurrently", async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const parent = path.join(root, ".data", "azure-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "uncertain-real-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let posts = 0;
  const ctx = {
    root, directory, expiresAt: Date.now() + 60000, forbidden: [],
    plan: { planHash: "a".repeat(64), sourceHash: "b".repeat(64), allowedVmId: "/subscriptions/fixture/vm/fixture",
      target: { subscriptionId: "fixture" }, transferId: "00000000-0000-4000-8000-000000000089",
      business: { archiveSha256: "c".repeat(64), archiveBytes: 1024, manifestSha256: "d".repeat(64),
        controlSha256: "e".repeat(64), fileCount: 3, originSourceHash: "f".repeat(64),
        binding: { deploymentId: "fixture", host: "fixture.example", tlsEmail: "operator@example.com", autostart: true } },
      vm: { dataDiskGiB: 32 }, policy: { maxActions: 24 } },
    authorize: async () => {}, verifyTarget: async () => {},
    api: { arm: async (_uri, { method } = {}) => {
      if (method === "POST") { posts++; throw new Error("SIMULATED_RESPONSE_LOST"); }
      throw new Error("Unexpected request");
    } },
  };
  await assert.rejects(actionOnce(ctx, "inspect"), /SIMULATED_RESPONSE_LOST/);
  await assert.rejects(actionOnce(ctx, "cleanup-transfer"), /PREVIOUS_ACTION_UNSETTLED/);
  assert.equal(posts, 1);
  assert.ok(await stat(path.join(directory, "action.inflight")));
  let checks = 0, deniedPosts = 0;
  const denied = {
    ...ctx, directory: path.join(directory, "source-recheck"),
    authorize: async () => { if (++checks === 2) throw new Error("REAL_SOURCE_CHANGED"); },
    api: { arm: async () => { deniedPosts++; throw new Error("Must not reach Azure"); } },
  };
  await assert.rejects(actionOnce(denied, "inspect"), /REAL_SOURCE_CHANGED/);
  assert.equal(deniedPosts, 0);
  await assert.rejects(stat(path.join(denied.directory, "action.inflight")), { code: "ENOENT" });
  const { readdir, readFile } = await import("node:fs/promises");
  const receiptName = (await readdir(path.join(denied.directory, "operations")))[0];
  const receipt = JSON.parse(await readFile(path.join(denied.directory, "operations", receiptName), "utf8"));
  assert.equal(receipt.postCount, 0);
  assert.equal(receipt.state, "not-submitted");
});
