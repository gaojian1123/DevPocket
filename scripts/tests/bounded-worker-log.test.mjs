import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createBoundedWorkerLog } from "../bounded-worker-log.mjs";
import { requireManagedCleanup, trackManagedCommand } from "../android-emulator.mjs";

test("private worker logs retain bounded beginning and end while draining excess output", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/bounded-worker-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "worker.log");
  const output = createBoundedWorkerLog(file);
  const finished = once(output, "finish");
  output.write("synthetic-head\n");
  for (let index = 0; index < 40; index++) output.write(Buffer.alloc(65536, 120));
  output.end("\nsynthetic-critical-tail");
  await finished;
  const bytes = await readFile(file);
  assert.ok(bytes.length <= 1024 * 1024);
  assert.ok(bytes.toString().startsWith("synthetic-head"));
  assert.ok(bytes.toString().endsWith("synthetic-critical-tail"));
  assert.equal(output.logInfo().truncated, true);
  assert.equal(output.logInfo().status, "retained");
});

test("private log failure still drains workers and cannot strand cleanup", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/bounded-worker-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = createBoundedWorkerLog(path.join(root, "missing-parent", "worker.log"));
  const error = once(output, "error");
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  const state = trackManagedCommand(child, output, "linux", { role: "emulator" });
  await error;
  child.stdout.write("still drained");
  child.stderr.write("DEVPOCKET_OWNED_TREE_STOPPED\n");
  child.emit("exit", 1, null);
  child.emit("close", 1);
  await state.done;
  assert.equal(state.logInfo().status, "unavailable");
  assert.equal(state.workerObservation.snapshot().exitCode, 1);
  assert.doesNotThrow(() => requireManagedCleanup(state));
});
