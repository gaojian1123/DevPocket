import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createWorkerObservation, projectWorkerDiagnostics } from "../worker-diagnostics.mjs";
import { createLiveDeviceGuard, trackManagedCommand } from "../android-emulator.mjs";

const exec = promisify(execFile);
const runId = "11111111-1111-4111-8111-111111111111";

test("the existing managed handle captures a real exit without weakening the live-device guard", async (t) => {
  const child = spawn(process.execPath, ["-e",
    "process.stderr.write('Unknown option: synthetic-private-argument\\n'); process.exitCode=27;"],
  { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const output = new PassThrough();
  output.resume();
  const state = trackManagedCommand(child, output, process.platform, { role: "emulator" });
  const guard = createLiveDeviceGuard([state], async () => "owned");
  await state.done;
  await assert.rejects(guard.verify(), /exited/);
  state.workerObservation.markCleanup();
  const observed = state.workerObservation.snapshot();
  assert.equal(observed.exitCode, 27);
  assert.equal(observed.context, "unexpected");
  assert.equal(observed.failureCategory, "unsupported-option");
  assert.ok(!JSON.stringify(observed).includes("synthetic-private-argument"));
  guard.close();
});

test("trusted role and actual observed supervisor exit survive later cleanup without exporting private stderr", () => {
  const worker = createWorkerObservation("emulator");
  worker.stderr(Buffer.from("role=adb token=synthetic-secret https://private.invalid/path\nqt.qpa.xcb: could not connect to display\n"));
  worker.exit(17, null);
  worker.markCleanup();
  const value = worker.snapshot();
  assert.equal(value.role, "emulator");
  assert.equal(value.observedProcess, "owned-command-supervisor");
  assert.equal(value.context, "unexpected");
  assert.equal(value.exitCode, 17);
  assert.equal(value.signal, "none");
  assert.equal(value.failureCategory, "graphics-initialization");
  for (const secret of ["synthetic-secret", "private.invalid", "token=", "role=adb"]) {
    assert.ok(!JSON.stringify(value).includes(secret));
  }
});

test("cleanup, cancellation and unavailable exits remain distinct from unexpected failure", () => {
  const cleanup = createWorkerObservation("adb");
  cleanup.markCleanup();
  cleanup.exit(124, null);
  assert.equal(cleanup.snapshot().context, "during-cleanup");
  assert.equal(cleanup.snapshot().failureCategory, "not-applicable");
  const signal = new AbortController();
  const cancelled = createWorkerObservation("emulator", signal.signal);
  signal.abort();
  cancelled.exit(null, "SIGTERM");
  assert.equal(cancelled.snapshot().context, "during-cancellation");
  assert.equal(cancelled.snapshot().exitCode, "unknown");
  assert.equal(cancelled.snapshot().signal, "SIGTERM");
  const unknown = createWorkerObservation("adb");
  assert.equal(unknown.snapshot().observation, "not-observed");
  assert.equal(unknown.snapshot().exitCode, "unknown");
  assert.equal(unknown.snapshot().signal, "unknown");
});

test("stderr sampling and public projection are bounded and never treat unknown values as success", () => {
  const worker = createWorkerObservation("emulator");
  worker.stderr(Buffer.from("private\n".repeat(100_000) + "\nUnknown option: private-value\n"));
  worker.exit(null, "UNTRUSTED_SIGNAL");
  const value = worker.snapshot();
  assert.ok(value.stderrSampledBytes <= 32768);
  assert.equal(value.stderrTruncated, true);
  assert.equal(value.failureCategory, "unsupported-option");
  assert.equal(value.exitCode, "unknown");
  assert.equal(value.signal, "unknown");
  const projected = projectWorkerDiagnostics({ runId, cleanup: "completed", workers: [
    { ...value, argv: ["secret"], environment: "private", absolutePath: "C:\\private", failureCategory: "secret" },
    { role: "untrusted-private-role", exitCode: 0 },
  ] });
  assert.equal(projected.workers.length, 1);
  assert.equal(projected.workers[0].failureCategory, "unknown");
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 8192);
  assert.ok(!JSON.stringify(projected).includes("private"));
  assert.ok(!JSON.stringify(projected).includes("secret"));
});

async function fixture(t, report) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/worker-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ".data", "ci", "device");
  await mkdir(directory, { recursive: true });
  if (report) await writeFile(path.join(directory, "report.json"), JSON.stringify(report));
  return { root, directory };
}

test("the CLI exports only source-bound allowlisted worker metadata and preserves blocked machine evidence", async (t) => {
  const worker = createWorkerObservation("adb");
  worker.stderr(Buffer.from("cannot bind listener: Address already in use\nsecret=fixture-value"));
  worker.exit(1, null);
  const machine = { status: "blocked", complete: false, base: "a".repeat(40),
    source: { head: "b".repeat(40), fingerprint: "c".repeat(64) },
    checks: [{ id: "android-device", status: "blocked", workerDiagnostics: {
      runId, cleanup: "completed", workers: [worker.snapshot()], private: "fixture-value",
    } }], private: "fixture-value" };
  const item = await fixture(t, machine);
  const file = path.resolve("scripts/worker-diagnostics.mjs");
  const result = await exec(process.execPath, [file], { cwd: item.root, timeout: 20000 });
  const bytes = await readFile(path.join(item.directory, "worker-diagnostics.json"), "utf8");
  const output = JSON.parse(bytes);
  assert.equal(result.stdout.trim(), bytes.trim());
  assert.equal(output.verificationStatus, "blocked");
  assert.deepEqual(output.source, machine.source);
  assert.equal(output.workers[0].role, "adb");
  assert.equal(output.workers[0].failureCategory, "port-conflict");
  assert.ok(!bytes.includes("fixture-value"));
  assert.ok(Buffer.byteLength(bytes) <= 8192);
  assert.deepEqual(JSON.parse(await readFile(path.join(item.directory, "report.json"), "utf8")), machine);
  await assert.rejects(exec(process.execPath, [file], { cwd: item.root, timeout: 20000 }));
});

test("diagnostic metadata cannot replace required failed device evidence", async () => {
  const { combineVerification } = await import("../verification.mjs");
  const plan = { version: 1, base: "a".repeat(40),
    source: { head: "b".repeat(40), fingerprint: "c".repeat(64) }, requiredChecks: ["android-device"] };
  assert.throws(() => combineVerification(plan, [{
    ...plan, group: "device", status: "blocked", checks: [
      { id: "android-device", status: "blocked", exitCode: 1, workerDiagnostics: { availability: "observed" } },
    ],
  }]), /failed, blocked/);
});

test("missing or linked diagnostic inputs cannot turn into a passing report or escape the run directory", async (t) => {
  const item = await fixture(t);
  const file = path.resolve("scripts/worker-diagnostics.mjs");
  await exec(process.execPath, [file], { cwd: item.root, timeout: 20000 });
  const output = JSON.parse(await readFile(path.join(item.directory, "worker-diagnostics.json"), "utf8"));
  assert.equal(output.availability, "missing");
  assert.equal(output.verificationStatus, "unknown");
  assert.deepEqual(output.workers, []);
  const link = path.join(item.root, ".data", "ci", "linked");
  await symlink(item.directory, link, "junction");
  await assert.rejects(exec(process.execPath, [file, "--directory", link], { cwd: item.root, timeout: 20000 }));
  await assert.rejects(exec(process.execPath, [file, "--directory", path.join(item.root, "outside")],
    { cwd: item.root, timeout: 20000 }));
});
