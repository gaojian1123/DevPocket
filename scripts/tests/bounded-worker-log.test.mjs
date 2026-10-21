import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createBoundedWorkerLog, readWorkerLogTail, WORKER_LOG_BUDGET } from "../bounded-worker-log.mjs";
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

test("failure log tails accept the producer budget without truncating retained evidence", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/bounded-worker-tail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "worker.log");
  for (const length of [256 * 1024, WORKER_LOG_BUDGET]) {
    const bytes = Buffer.alloc(length, 120);
    Buffer.from("specific failure tail").copy(bytes, bytes.length - 21);
    await writeFile(file, bytes);
    const tail = await readWorkerLogTail(file);
    assert.ok(Buffer.byteLength(tail) <= 16384);
    assert.ok(tail.endsWith("specific failure tail"));
    assert.deepEqual(await readFile(file), bytes);
  }
  await writeFile(file, Buffer.alloc(WORKER_LOG_BUDGET + 1));
  await assert.rejects(readWorkerLogTail(file), /bounded regular file/);
});

test("failure log tail limits apply to encoded Unicode and malformed UTF-8 text", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/bounded-worker-unicode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "worker.log");
  for (const value of ["\u20ac".repeat(6000), "\u{1f600}".repeat(6000)]) {
    const bytes = Buffer.from(value);
    await writeFile(file, bytes);
    const tail = await readWorkerLogTail(file);
    assert.ok(Buffer.byteLength(tail, "utf8") <= 16384);
    assert.equal(tail.includes("\ufffd"), false, "A valid UTF-8 tail must not gain partial-character replacements.");
    assert.ok(value.endsWith(tail));
    assert.deepEqual(await readFile(file), bytes);
  }
  const malformed = Buffer.alloc(20000, 0xff);
  await writeFile(file, malformed);
  const tail = await readWorkerLogTail(file);
  assert.ok(tail.includes("\ufffd"));
  assert.ok(Buffer.byteLength(tail, "utf8") <= 16384);
  assert.deepEqual(await readFile(file), malformed);
});
