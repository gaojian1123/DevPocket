import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const exec = promisify(execFile);
const entry = path.resolve("scripts/android-runner.mjs");

test("missing emulator prerequisites produce blocked evidence without touching an existing run", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const parent = await mkdtemp(path.resolve(".data/tests/emulator-runner-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "owned");
  await assert.rejects(exec(process.execPath, [entry, "--directory", directory, "--sdk", path.join(parent, "missing")]));
  const report = JSON.parse(await readFile(path.join(directory, "device-report.json"), "utf8"));
  assert.equal(report.status, "blocked");
  assert.equal(report.tests, 0);
  await writeFile(path.join(directory, "retained.txt"), "preserve");
  await assert.rejects(exec(process.execPath, [entry, "--directory", directory, "--sdk", path.join(parent, "missing")]));
  assert.equal(await readFile(path.join(directory, "retained.txt"), "utf8"), "preserve");
});

test("instrumentation success requires actual tests and rejects skipped, crashed or truncated output", async () => {
  const { instrumentationResult } = await import("../android-runner.mjs");
  const success = "INSTRUMENTATION_STATUS: class=example.NativeTest\nINSTRUMENTATION_STATUS: test=works\n" +
    "INSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n";
  assert.deepEqual(instrumentationResult(success, "example.NativeTest"), { tests: 1, status: "passed" });
  for (const invalid of [
    "OK (0 tests)\nINSTRUMENTATION_CODE: -1\n",
    success.replace("STATUS_CODE: 0", "STATUS_CODE: -3"),
    success.replace("INSTRUMENTATION_CODE: -1", "INSTRUMENTATION_CODE: 0"),
    success.replace("OK (1 test)", "FAILURES!!!"),
    success.replace("example.NativeTest", "example.UnrelatedTest"),
  ]) assert.throws(() => instrumentationResult(invalid, "example.NativeTest"));
});

test("APK discovery includes additional regression classes while refusing real-CLI test selection", async () => {
  const { instrumentationClasses } = await import("../android-runner.mjs");
  const names = ["NativeFlowTest", "AdaptiveLayoutTest", "FixtureFlowTest", "FeatureFlowTest"];
  const output = names.map((name) => `INSTRUMENTATION_STATUS: class=dev.devpocket.app.${name}`).join("\n") +
    "\nINSTRUMENTATION_CODE: -1\n";
  assert.deepEqual(instrumentationClasses(output), names.map((name) => `dev.devpocket.app.${name}`).sort());
  assert.throws(() => instrumentationClasses(output.replace("FeatureFlowTest", "ConnectedFlowTest")));
  assert.throws(() => instrumentationClasses("INSTRUMENTATION_CODE: -1\n"));
});

test("cancelled-run cleanup cannot delete another run's AVD or fixture credentials", async (t) => {
  const { cleanDeviceRun } = await import("../device-run.mjs");
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/cleanup-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = randomUUID();
  await writeFile(path.join(directory, "owner.json"), JSON.stringify({
    version: 1, root: process.cwd(), runId: owner, pid: process.pid,
  }));
  await mkdir(path.join(directory, "avd"));
  await writeFile(path.join(directory, "avd", "preserved.txt"), "owned by the other run");
  await assert.rejects(cleanDeviceRun(process.cwd(), directory, randomUUID()), /ownership/i);
  assert.equal(await readFile(path.join(directory, "avd", "preserved.txt"), "utf8"), "owned by the other run");
  await cleanDeviceRun(process.cwd(), directory, owner);
  await assert.rejects(readFile(path.join(directory, "avd", "preserved.txt")), { code: "ENOENT" });
});

test("a live device handle is revoked when a worker exits or listener ownership changes", async () => {
  const { createLiveDeviceGuard } = await import("../android-emulator.mjs");
  const worker = () => ({ child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }), settled: false });
  const adb = worker(), emulator = worker();
  let probes = 0;
  const guard = createLiveDeviceGuard([adb, emulator], async () => { probes++; });
  await guard.verify();
  assert.equal(probes, 1);
  emulator.child.emit("exit", 1);
  assert.equal(guard.signal.aborted, true);
  await assert.rejects(guard.verify(), /exited|unavailable/);
  assert.equal(probes, 1, "A replacement listener must not revive an exited owned worker.");
  guard.close();
  let replaced = false;
  const live = createLiveDeviceGuard([worker(), worker()], async () => {
    if (replaced) throw new Error("Listener ownership mismatch.");
  });
  await live.verify();
  replaced = true;
  await assert.rejects(live.verify(), /ownership mismatch/);
  assert.equal(live.signal.aborted, true);
  live.close();
});

test("caller cancellation during ownership inspection is not latched as an unexpected worker failure", async () => {
  const { createLiveDeviceGuard } = await import("../android-emulator.mjs");
  const worker = { child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }), settled: false };
  const cancellation = new AbortController();
  let finish;
  const inspected = new Promise((resolve) => { finish = resolve; });
  const guard = createLiveDeviceGuard([worker], () => inspected, cancellation.signal);
  const verification = guard.verify();
  cancellation.abort(new Error("Manual stop requested."));
  finish();
  await assert.rejects(verification, /Manual stop/);
  assert.equal(guard.failure, undefined);
  guard.close();
});
