import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("manual commands address one live owned run and stop is acknowledged only after cleanup", async (t) => {
  const { openManualControl, requestManualEmulator } = await import("../manual-emulator.mjs");
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/manual-control-"));
  const directory = path.join(root, ".data", "run");
  await mkdir(directory, { recursive: true });
  let layouts = 0;
  const controller = await openManualControl({
    root, directory, runId: randomUUID(), leaseId: randomUUID(), ports: { adb: 1, console: 2, device: 3, grpc: 4 },
    serial: "fixture-only", avdName: "fixture-only",
  }, {
    layouts: async () => { layouts++; return { status: "passed", tests: 5 }; },
  });
  t.after(async () => { await controller.finish({ status: "stopped" }); await rm(root, { recursive: true, force: true }); });
  const result = await requestManualEmulator({ root, directory, command: "layouts" });
  assert.equal(result.status, "passed");
  assert.equal(layouts, 1);
  await assert.rejects(requestManualEmulator({ root: path.join(root, "other-worktree"), directory, command: "layouts" }), /worktree|checkout/);
  let acknowledged = false;
  const stop = requestManualEmulator({ root, directory, command: "stop" }).then((value) => { acknowledged = true; return value; });
  await controller.stopping;
  assert.equal(acknowledged, false);
  await controller.finish({ status: "stopped", cleanup: "completed" });
  assert.equal((await stop).cleanup, "completed");
});

test("unknown manual operation acknowledgements cannot be reported as success", async (t) => {
  const { openManualControl, requestManualEmulator } = await import("../manual-emulator.mjs");
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/manual-ack-"));
  const directory = path.join(root, ".data", "run");
  await mkdir(directory, { recursive: true });
  const controller = await openManualControl({ root, directory, runId: randomUUID(), leaseId: randomUUID(), ports: {} }, {
    layouts: async () => ({ status: "future-success" }),
  });
  t.after(async () => { await controller.finish({ status: "stopped" }); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(requestManualEmulator({ root, directory, command: "layouts" }), /unsupported|Invalid/);
});

test("stop during manual ownership validation interrupts layouts but waits for successful cleanup", async (t) => {
  const { openManualControl, requestManualEmulator } = await import("../manual-emulator.mjs");
  const { createLiveDeviceGuard } = await import("../android-emulator.mjs");
  const { EventEmitter } = await import("node:events");
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/manual-stop-"));
  const directory = path.join(root, ".data", "run");
  await mkdir(directory, { recursive: true });
  const cancellation = new AbortController();
  let entered, finish;
  const started = new Promise((resolve) => { entered = resolve; });
  const inspecting = new Promise((resolve) => { finish = resolve; });
  const worker = { child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }), settled: false };
  const guard = createLiveDeviceGuard([worker], () => { entered(); return inspecting; }, cancellation.signal);
  const controller = await openManualControl({ root, directory, runId: randomUUID(), leaseId: randomUUID(), ports: {} }, {
    signal: guard.signal, validate: guard.verify, stop: () => cancellation.abort(new Error("Requested stop.")),
    layouts: async () => assert.fail("Cancelled validation must not run layouts."),
  });
  t.after(async () => { guard.close(); await controller.finish({ status: "stopped" }); await rm(root, { recursive: true, force: true }); });
  const layout = assert.rejects(requestManualEmulator({ root, directory, command: "layouts" }), /Requested stop/);
  await started;
  const stop = requestManualEmulator({ root, directory, command: "stop" });
  await controller.stopping;
  finish();
  await layout;
  await controller.drain();
  assert.equal(guard.failure, undefined);
  await controller.finish({ status: "stopped", cleanup: "completed" });
  assert.equal((await stop).status, "stopped");
});
