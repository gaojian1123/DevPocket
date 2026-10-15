import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { once } from "node:events";
import { createBoundedWorkerLog } from "../bounded-worker-log.mjs";
import { failureDetails } from "../diagnostic-errors.mjs";
import { createWorkerObservation, projectWorkerDiagnostics } from "../worker-diagnostics.mjs";
import { createLiveDeviceGuard, trackManagedCommand, managedWorkerDiagnostics, requireManagedCleanup } from "../android-emulator.mjs";

const exec = promisify(execFile);
const runId = "11111111-1111-4111-8111-111111111111";

test("actual managed log-write failure makes public collectors nonzero without changing native success or cleanup", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/managed-log-outcome-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sink = createBoundedWorkerLog(path.join(root, "missing-parent", "adb.log"));
  const failedLog = once(sink, "error");
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.stdout.write('PRIVATE_WORKER_OUTPUT'),50);setTimeout(()=>process.exit(0),150)"],
    { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const tracked = trackManagedCommand(child, sink, process.platform, { role: "adb" });
  await failedLog;
  tracked.workerObservation.markCleanup();
  await tracked.done;
  assert.equal(child.exitCode, 0);
  assert.equal(tracked.logInfo().status, "unavailable");
  const directory = path.join(root, ".data", "ci", "device");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "report.json"), JSON.stringify({
    version: 1, status: "partial", checks: [{ id: "android-device", status: "passed", exitCode: 0, deviceRunId: runId,
      workerDiagnostics: { version: 1, runId, cleanup: "completed",
        workers: [{ ...tracked.workerObservation.snapshot(), workerLog: tracked.logInfo() }],
        collectionFailures: [{ role: "adb", failure: failureDetails(tracked.logError, "collector-failed") }] } }],
  }));
  for (const entry of ["worker-diagnostics", "device-diagnostics"]) {
    await assert.rejects(exec(process.execPath, [path.resolve(`scripts/${entry}.mjs`), "--directory", directory],
      { cwd: root, timeout: 20000 }), (error) => error.code === 1);
    const result = JSON.parse(await readFile(path.join(directory, `${entry}.json`), "utf8"));
    assert.equal(result.collectionStatus, "failed");
    assert.ok(!JSON.stringify(result).includes("PRIVATE_WORKER_OUTPUT"));
    if (entry === "worker-diagnostics") assert.equal(result.cleanup, "completed");
    else assert.equal(result.checkStatus, "passed");
  }
});

test("a real dedicated lifecycle pipe error remains a failed collection after healthy logs and successful cleanup", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/lifecycle-pipe-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["-e",
    "setTimeout(()=>{process.stderr.write('DEVPOCKET_OWNED_TREE_STOPPED\\n');process.exit(0)},150)"],
  { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const state = trackManagedCommand(child, createBoundedWorkerLog(path.join(root, "worker.log")), "linux", { role: "emulator" });
  const failed = once(child.stdio[3], "error");
  child.stdio[3].destroy(Object.assign(new Error("PRIVATE_PIPE_ERROR"), { code: "EIO" }));
  await failed;
  state.workerObservation.markCleanup();
  await state.done;
  assert.equal(child.exitCode, 0);
  assert.equal(state.logInfo().status, "retained");
  assert.doesNotThrow(() => requireManagedCleanup(state));
  const value = managedWorkerDiagnostics([state], runId, "completed");
  assert.equal(value.cleanup, "completed");
  assert.equal(value.collectionStatus, "failed");
  assert.ok(value.collectionFailures.some((failure) => failure.channel === "native-lifecycle" && failure.failure.osCode === "EIO"));
  assert.ok(!JSON.stringify(value).includes("PRIVATE_PIPE_ERROR"));
  const directory = path.join(root, ".data", "ci", "device");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "report.json"), JSON.stringify({
    version: 1, status: "partial", checks: [{ id: "android-device", status: "passed", exitCode: 0,
      deviceRunId: runId, workerDiagnostics: value }],
  }));
  for (const entry of ["worker-diagnostics", "device-diagnostics"]) {
    await assert.rejects(exec(process.execPath, [path.resolve(`scripts/${entry}.mjs`), "--directory", directory],
      { cwd: root, timeout: 20000 }), (error) => error.code === 1);
    const result = JSON.parse(await readFile(path.join(directory, `${entry}.json`), "utf8"));
    assert.equal(result.collectionStatus, "failed");
    const failures = result.collectionFailures ?? result.workerCollectionFailures;
    assert.ok(failures.some((failure) => failure.channel === "native-lifecycle" && failure.failure.osCode === "EIO"));
    assert.ok(!JSON.stringify(result).includes("PRIVATE_PIPE_ERROR"));
    if (entry === "worker-diagnostics") assert.equal(result.cleanup, "completed");
    else assert.equal(result.checkStatus, "passed");
  }
});

test("missing, unsupported and truncated lifecycle telemetry do not invent a channel I/O failure", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/lifecycle-incomplete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, telemetry] of [
    ["missing", ""], ["unsupported", '{"version":2,"private":"PRIVATE_CHANNEL_DATA"}\n'],
    ["truncated", "PRIVATE_CHANNEL_DATA".repeat(1000)],
  ]) {
    const child = spawn(process.execPath, ["-e",
      `require('node:fs').writeSync(3,${JSON.stringify(telemetry)});process.stderr.write('DEVPOCKET_OWNED_TREE_STOPPED\\n')`],
    { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    const state = trackManagedCommand(child, createBoundedWorkerLog(path.join(root, `${name}.log`)), "linux", { role: "emulator" });
    await state.done;
    assert.equal(child.exitCode, 0);
    assert.doesNotThrow(() => requireManagedCleanup(state));
    const result = managedWorkerDiagnostics([state], runId, "completed");
    assert.equal(result.collectionStatus, "completed");
    assert.deepEqual(result.collectionFailures, []);
    assert.equal(result.workers[0].nativeLifecycle.availability, "incomplete");
    assert.ok(!JSON.stringify(result).includes("PRIVATE_CHANNEL_DATA"));
  }
});

test("worker collection projection keeps separate channel faults and rejects arbitrary channel text", () => {
  const result = projectWorkerDiagnostics({
    runId, collectionFailures: [
      { role: "emulator", channel: "native-lifecycle", failure: { reason: "collector-failed", osCode: "EIO" } },
      { role: "emulator", channel: "PRIVATE_CHANNEL_TOKEN", failure: { reason: "PRIVATE_ERROR_TOKEN" } },
    ],
    workers: [{ role: "emulator", workerLog: { status: "unavailable" } }],
  });
  assert.equal(result.collectionStatus, "failed");
  assert.deepEqual(result.collectionFailures.map((failure) => failure.channel), ["native-lifecycle", "unknown", "worker-log"]);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
});

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

test("the official userdata-capacity failure projects numeric evidence without its private path or raw output", () => {
  const worker = createWorkerObservation("emulator");
  worker.stdout(Buffer.from("FATAL | Not enough space to create userdata partition. Available: 6700.250000 MB at "));
  worker.stdout(Buffer.from("/synthetic-private/token=fixture-value/owned.avd, need 7372.800000 MB.\n"));
  worker.stderr(Buffer.from("https://private.invalid/?token=fixture-value\n"));
  worker.exit(1, null);
  const value = projectWorkerDiagnostics({ runId, cleanup: "completed", workers: [worker.snapshot()] });
  const observed = value.workers[0];
  assert.equal(observed.failureCategory, "disk-space");
  assert.equal(observed.failureCategorySource, "stdout");
  assert.deepEqual(observed.userdataCapacity, { source: "stdout", unit: "MiB", available: 6700.25, required: 7372.8 });
  assert.equal(observed.context, "unexpected");
  assert.equal(observed.exitCode, 1);
  assert.notEqual(observed.nativeLifecycle.availability, "complete");
  assert.equal(observed.nativeLifecycle.returnCode, "unknown");
  assert.deepEqual(observed.nativeLifecycle.events, []);
  for (const privateValue of ["fixture-value", "synthetic-private", "private.invalid", "owned.avd", "Not enough space"]) {
    assert.ok(!JSON.stringify(value).includes(privateValue));
  }
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 8192);
});

test("malformed, conflicting and untrusted-role capacity evidence stays unknown", () => {
  const message = (available, required) =>
    `ERROR | Not enough space to create userdata partition. Available: ${available} MB at /private, need ${required} MB.\n`;
  for (const text of [
    message("NaN", 7000), message(-1, 7000), message(1, 1_000_000_000),
    message(8000, 7000), message(6000, 7000) + message(5000, 7000),
    message(6000, 7000) + message("private-value", 7000),
  ]) {
    const worker = createWorkerObservation("emulator");
    worker.stdout(Buffer.from(text));
    worker.exit(1, null);
    assert.equal(worker.snapshot().userdataCapacity, "unknown");
  }
  const adb = createWorkerObservation("adb");
  adb.stderr(Buffer.from(message(6000, 7000)));
  adb.exit(1, null);
  assert.equal(adb.snapshot().userdataCapacity, "unknown");
  const worker = createWorkerObservation("emulator");
  worker.stderr(Buffer.from(message(6000, 7000)));
  worker.exit(1, null);
  assert.deepEqual(worker.snapshot().userdataCapacity, { source: "stderr", unit: "MiB", available: 6000, required: 7000 });
  const projected = projectWorkerDiagnostics({ runId, workers: [
    { ...worker.snapshot(), userdataCapacity: { source: "private-value", unit: "MiB", available: 1, required: 2 } },
  ] });
  assert.equal(projected.workers[0].userdataCapacity, "unknown");
  assert.ok(!JSON.stringify(projected).includes("private-value"));
});

test("concatenated capacity templates cannot fabricate a pair from separate records", () => {
  const message = (available, required) =>
    `Not enough space to create userdata partition. Available: ${available} MB at /fixture, need ${required} MB.`;
  for (const text of [
    `${message(6000, 7000)} ${message(5000, 8000)}\n`,
    `${message("private-value", 7000)} ${message(5000, 8000)}\n`,
  ]) {
    const worker = createWorkerObservation("emulator");
    worker.stdout(Buffer.from(text));
    worker.exit(1, null);
    assert.equal(worker.snapshot().userdataCapacity, "unknown");
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
  const { VERIFICATION_REPORT_VERSION } = await import("../verification-policy.mjs");
  const plan = { version: VERIFICATION_REPORT_VERSION, base: "a".repeat(40),
    source: { head: "b".repeat(40), fingerprint: "c".repeat(64) }, requiredChecks: ["android-device"], requiredGroups: ["device"] };
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
