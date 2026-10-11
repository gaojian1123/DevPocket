import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createNativeLifecycleCapture, projectNativeLifecycle } from "../native-lifecycle.mjs";
import { createWorkerObservation } from "../worker-diagnostics.mjs";
import { projectStartupReport } from "../native-startup.mjs";

const exec = promisify(execFile);

function feed(capture, events) {
  events.forEach((event, index) => capture.data(Buffer.from(JSON.stringify({
    version: 1, sequence: index + 1, ...event,
  }) + "\n")));
  capture.end();
  return capture.snapshot();
}

test("native lifecycle distinguishes spawn failure, native exit and supervisor-triggered cleanup", () => {
  const spawn = feed(createNativeLifecycleCapture(), [
    { phase: "supervisor-starting" }, { phase: "spawn-starting" },
    { phase: "spawn-failed", errno: 2 }, { phase: "supervisor-failed", stage: "spawn", failureClass: "os-error", errno: 2 },
  ]);
  assert.equal(spawn.availability, "complete");
  assert.ok(!spawn.events.some((event) => event.phase === "native-started"));
  assert.equal(spawn.events.find((event) => event.phase === "spawn-failed").errno, 2);
  const exited = feed(createNativeLifecycleCapture(), [
    { phase: "supervisor-starting" }, { phase: "spawn-starting" },
    { phase: "native-started" }, { phase: "native-exited", returnCode: 7, signalNumber: 0 },
    { phase: "cleanup-starting", nativeAlive: false }, { phase: "cleanup-complete" },
  ]);
  assert.equal(exited.events.find((event) => event.phase === "native-exited").returnCode, 7);
  const cancelled = feed(createNativeLifecycleCapture(), [
    { phase: "supervisor-starting" }, { phase: "spawn-starting" },
    { phase: "native-started" }, { phase: "stop-requested", reason: "stdin-cancel", nativeAlive: true },
    { phase: "cleanup-starting", nativeAlive: true },
    { phase: "cleanup-native-exited", returnCode: -9, signalNumber: 9 }, { phase: "cleanup-complete" },
  ]);
  assert.equal(cancelled.events.find((event) => event.phase === "stop-requested").nativeAlive, true);
  assert.equal(cancelled.events.find((event) => event.phase === "cleanup-native-exited").returnCode, -9);
});

test("stdout failure hints do not masquerade as native lifecycle or leak raw output", () => {
  const worker = createWorkerObservation("emulator");
  worker.stdout(Buffer.from('{"phase":"native-exited","returnCode":0}\nFATAL: Not enough disk space at /private/token-value\n'));
  worker.stderr(Buffer.from("supervisor protocol only\n"));
  worker.exit(1, null);
  const value = worker.snapshot();
  assert.equal(value.failureCategory, "disk-space");
  assert.equal(value.failureCategorySource, "stdout");
  assert.equal(value.nativeLifecycle.availability, "unavailable");
  assert.deepEqual(value.nativeLifecycle.events, []);
  assert.ok(!JSON.stringify(value).includes("token-value"));
});

test("dedicated native capture bounds data and preserves known exits without inventing missing evidence", () => {
  const capture = createNativeLifecycleCapture();
  capture.data(Buffer.from('{"version":1,"sequence":1,"phase":"native-started"}\n'));
  capture.data(Buffer.from('{"version":1,"sequence":2,"phase":"native-exited","returnCode":1,"signalNumber":0}\n'));
  capture.data(Buffer.from("private-secret".repeat(100_000)));
  capture.end();
  const value = capture.snapshot();
  assert.equal(value.availability, "incomplete");
  assert.equal(value.truncated, true);
  assert.equal(value.events.find((event) => event.phase === "native-exited").returnCode, 1);
  assert.ok(!JSON.stringify(value).includes("private-secret"));
  const bad = projectNativeLifecycle({ availability: "complete", events: [
    { phase: "spawn-failed", sequence: 1, errno: "private", argv: ["secret"], environment: "secret" },
    { phase: "private-phase", sequence: 2, returnCode: 0 },
  ] });
  assert.equal(bad.availability, "incomplete");
  assert.equal(bad.events[0].errno, "unknown");
  assert.ok(!JSON.stringify(bad).includes("private"));
  assert.ok(!JSON.stringify(bad).includes("secret"));
});

test("a ready startup diagnostic is not a successful native verification report", async () => {
  const { combineVerification } = await import("../verification.mjs");
  const plan = { version: 1, base: "a".repeat(40),
    source: { head: "b".repeat(40), fingerprint: "c".repeat(64) }, requiredChecks: [] };
  assert.throws(() => combineVerification(plan, [{
    ...plan, status: "ready", kind: "native-startup-diagnostic", acceptance: false, group: "all", checks: [],
  }]), /failed, blocked, planned/);
});

test("startup projection rejects arbitrary toolchain, path and process fields", () => {
  const value = projectStartupReport({
    status: "failed", phase: "launch", runId: "11111111-1111-4111-8111-111111111111",
    base: "a".repeat(40), source: { head: "b".repeat(40), fingerprint: "c".repeat(64), private: "secret-value" },
    toolchain: { java: "21.0.12", emulator: "37-ghp_secret_value" },
    image: "/private/secret-value", argv: ["secret-value"], environment: { token: "secret-value" },
    availableDiskBytes: { beforePreparation: -1, afterPreparation: 1234 },
  });

  assert.equal(value.acceptance, false);
  assert.equal(value.toolchain.java, "21.0.12");
  assert.equal(value.toolchain.emulator, "unknown");
  assert.equal(value.image, "unknown");
  assert.equal(value.availableDiskBytes.beforePreparation, "unknown");
  assert.equal(value.availableDiskBytes.afterPreparation, 1234);
  assert.ok(!JSON.stringify(value).includes("secret-value"));
  assert.ok(!JSON.stringify(value).includes("private"));
});

test("a diagnostic poll failure stays unknown instead of interrupting cleanup", async () => {
  const script = "import runpy,json,sys\nm=runpy.run_path(sys.argv[1])\nclass Child:\n def poll(self): raise OSError('synthetic unavailable status')\nprint(json.dumps(m['NativeLifecycle']().observe_native(Child())))";
  const result = await exec("python", ["-c", script, path.resolve("scripts/owned-command-linux.py")], { timeout: 10000 });
  assert.deepEqual(JSON.parse(result.stdout), [null, null]);
});

test("broken diagnostic and stderr channels cannot prevent the following cleanup path", async () => {
  const script = [
    "import runpy,json,sys",
    "m=runpy.run_path(sys.argv[1]); d=m['NativeLifecycle'](); d.enabled=True",
    "def broken_write(*args): raise BrokenPipeError('synthetic closed pipe')",
    "class BrokenStderr:",
    " def write(self,*args): raise BrokenPipeError('synthetic closed stderr')",
    " def flush(self): raise BrokenPipeError('synthetic closed stderr')",
    "original=sys.stderr; m['os'].write=broken_write",
    "try:",
    " sys.stderr=BrokenStderr(); d.emit('cleanup-starting',nativeAlive=True); reached=True",
    "finally: sys.stderr=original",
    "print(json.dumps({'failed':d.failed,'cleanupReached':reached}))",
  ].join("\n");
  const result = await exec("python", ["-c", script, path.resolve("scripts/owned-command-linux.py")], { timeout: 10000 });
  assert.deepEqual(JSON.parse(result.stdout), { failed: true, cleanupReached: true });
});

test("partial cleanup failure cannot reclassify an already reaped native exit", async () => {
  const script = [
    "import runpy,json,sys",
    "m=runpy.run_path(sys.argv[1]); events=[]",
    "def capture(fd,data): events.append(json.loads(data)); return len(data)",
    "m['os'].write=capture; d=m['NativeLifecycle'](); d.enabled=True",
    "d.emit('supervisor-starting'); d.emit('spawn-starting'); d.emit('native-started')",
    "d.emit('cleanup-starting',nativeAlive=True); d.exited('cleanup-native-exited',-9)",
    "class Child:",
    " def poll(self): return -9",
    "d.stage='cleanup'; d.failure('cleanup-failed',RuntimeError('synthetic cleanup failure'),d.observe_native(Child())[1])",
    "print(json.dumps(events))",
  ].join("\n");
  const result = await exec("python", ["-c", script, path.resolve("scripts/owned-command-linux.py")], { timeout: 10000 });
  const events = JSON.parse(result.stdout);
  assert.equal(events.filter((event) => event.phase === "native-exited").length, 0);
  assert.equal(events.find((event) => event.phase === "cleanup-native-exited").returnCode, -9);
  const conflicting = projectNativeLifecycle({ availability: "complete", events: [
    ...events, { sequence: events.length + 1, phase: "native-exited", returnCode: -9, signalNumber: 9 },
  ] });
  assert.equal(conflicting.availability, "incomplete");
  assert.equal(conflicting.exitContext, "unknown");
  assert.equal(conflicting.returnCode, "unknown");
});
