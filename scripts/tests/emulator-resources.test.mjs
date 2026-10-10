import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fork } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stopOwnedProcess } from "../process.mjs";

const exec = promisify(execFile);
async function poolFixture(t) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/emulator-pool-"));
  const first = path.join(root, "worktree-a"), second = path.join(root, "worktree-b");
  await mkdir(first);
  await mkdir(second);
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return { registryDirectory: path.join(root, "registry"), first, second, portRange: [32500, 32530],
    cleanup: (action) => cleanups.push(action) };
}

async function unavailable(port) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
    });
    return false;
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    return true;
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

test("one shared default slot queues another worktree and reserves ports until explicit handoff", async (t) => {
  const { acquireEmulatorLease } = await import("../emulator-resources.mjs");
  const pool = await poolFixture(t);
  const first = await acquireEmulatorLease({ ...pool, workspace: pool.first, runId: randomUUID() });
  pool.cleanup(() => first.release());
  assert.equal(new Set(Object.values(first.ports)).size, 4);
  for (const port of Object.values(first.ports)) assert.equal(await unavailable(port), true);
  let admit, announce;
  const waiting = new Promise((resolve) => { announce = resolve; });
  const pending = acquireEmulatorLease({
    ...pool, workspace: pool.second, runId: randomUUID(), timeoutMs: 30_000,
    onWaiting: announce,
  }).then((lease) => { admit = lease; return lease; });
  await waiting;
  assert.equal(admit, undefined);
  await first.release();
  const second = await pending;
  await second.handoff();
  for (const port of Object.values(second.ports)) assert.equal(await unavailable(port), false);
  await second.release();
});

function peer(pool) {
  const child = fork(path.resolve("scripts/tests/fixtures/emulator-lease-peer.mjs"), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages = [];
  const waiters = new Set();
  child.on("message", (message) => {
    messages.push(message);
    for (const wake of waiters) wake();
  });
  pool.cleanup(() => stopOwnedProcess(child));
  const wait = (type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Lease peer did not report ${type}.`)); }, 30_000);
    const check = () => {
      const index = messages.findIndex((message) => message.type === type || message.type === "error");
      if (index < 0) return;
      const [message] = messages.splice(index, 1);
      clearTimeout(timer);
      waiters.delete(check);
      if (message.type === "error" && type !== "error") reject(new Error(message.message));
      else resolve(message);
    };
    waiters.add(check);
    check();
  });
  return { child, wait, send: (message) => child.send(message) };
}

test("independent processes share an explicit higher limit without reusing any live port", async (t) => {
  const { configureEmulatorLimit, emulatorLeaseStatus } = await import("../emulator-resources.mjs");
  const pool = await poolFixture(t);
  await configureEmulatorLimit(2, pool);
  const first = peer(pool), second = peer(pool);
  first.send({ type: "acquire", options: { ...pool, workspace: pool.first, runId: randomUUID() } });
  second.send({ type: "acquire", options: { ...pool, workspace: pool.second, runId: randomUUID() } });
  const [a, b] = await Promise.all([first.wait("acquired"), second.wait("acquired")]);
  assert.equal(new Set([...Object.values(a.ports), ...Object.values(b.ports)]).size, 8);
  assert.equal((await emulatorLeaseStatus(pool)).leases.length, 2);
  const lowered = await configureEmulatorLimit(1, pool);
  assert.equal(lowered.active, 2, "Reducing the cap must not terminate an admitted run.");
  assert.equal((await emulatorLeaseStatus(pool)).leases.length, 2);
  first.send({ type: "release" });
  second.send({ type: "release" });
  await Promise.all([first.wait("released"), second.wait("released")]);
});

test("an occupied half-pair is skipped without leaking its other reserved port", async (t) => {
  const pool = await poolFixture(t);
  const occupied = net.createServer();
  await new Promise((resolve, reject) => { occupied.once("error", reject); occupied.listen(32501, "127.0.0.1", resolve); });
  pool.cleanup(() => new Promise((resolve) => occupied.close(resolve)));
  const holder = peer(pool);
  holder.send({ type: "acquire", options: { ...pool, workspace: pool.first, runId: randomUUID() } });
  const lease = await holder.wait("acquired");
  assert.notEqual(lease.ports.console, 32500);
  assert.equal(await unavailable(32500), false);
  holder.send({ type: "release" });
  await holder.wait("released");
});

test("cancelling a queued worktree removes its request without affecting the active holder", async (t) => {
  const { acquireEmulatorLease, emulatorLeaseStatus } = await import("../emulator-resources.mjs");
  const pool = await poolFixture(t);
  const lease = await acquireEmulatorLease({ ...pool, workspace: pool.first, runId: randomUUID() });
  pool.cleanup(() => lease.release());
  const cancellation = new AbortController();
  let announce;
  const waiting = new Promise((resolve) => { announce = resolve; });
  const pending = acquireEmulatorLease({
    ...pool, workspace: pool.second, runId: randomUUID(), signal: cancellation.signal, onWaiting: announce,
  });
  const cancelled = assert.rejects(pending, { name: "AbortError" });
  await waiting;
  cancellation.abort();
  await cancelled;
  const status = await emulatorLeaseStatus(pool);
  assert.equal(status.leases.length, 1);
  assert.equal(status.leases[0].id, lease.id);
  assert.equal(status.waiters.length, 0);
  await lease.release();
});

test("a crashed owner is reclaimed only after all its leased ports are unoccupied", async (t) => {
  const { acquireEmulatorLease, emulatorLeaseStatus } = await import("../emulator-resources.mjs");
  const pool = await poolFixture(t);
  const first = peer(pool);
  first.send({ type: "acquire", options: { ...pool, workspace: pool.first, runId: randomUUID() } });
  const original = await first.wait("acquired");
  first.send({ type: "handoff" });
  await first.wait("handed-off");
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(original.ports.console, "127.0.0.1", resolve);
  });
  pool.cleanup(async () => { if (occupied.listening) await new Promise((resolve) => occupied.close(resolve)); });
  await stopOwnedProcess(first.child);
  await assert.rejects(acquireEmulatorLease({
    ...pool, workspace: pool.second, runId: randomUUID(), timeoutMs: 250,
  }), { code: "EMULATOR_SLOT_TIMEOUT" });
  const stale = await emulatorLeaseStatus(pool);
  assert.equal(stale.leases[0].id, original.id);
  assert.equal(stale.leases[0].ownerAlive, false);
  assert.equal(occupied.listening, true);
  await new Promise((resolve) => occupied.close(resolve));
  const next = await acquireEmulatorLease({ ...pool, workspace: pool.second, runId: randomUUID() });
  await next.release();
});

test("raising the account limit never permits two owners of the same checkout", async (t) => {
  const { acquireEmulatorLease, configureEmulatorLimit } = await import("../emulator-resources.mjs");
  const pool = await poolFixture(t);
  await configureEmulatorLimit(2, pool);
  const active = await acquireEmulatorLease({ ...pool, workspace: pool.first, runId: randomUUID() });
  pool.cleanup(() => active.release());
  await assert.rejects(acquireEmulatorLease({
    ...pool, workspace: pool.first, runId: randomUUID(), timeoutMs: 200,
  }), { code: "EMULATOR_SLOT_TIMEOUT" });
});

test("post-handoff allocation cannot reuse an unbound port from another live lease", async (t) => {
  const { acquireEmulatorLease, configureEmulatorLimit } = await import("../emulator-resources.mjs");
  const pool = await poolFixture(t);
  await configureEmulatorLimit(2, pool);
  const first = await acquireEmulatorLease({ ...pool, workspace: pool.first, runId: randomUUID() });
  pool.cleanup(() => first.release());
  await first.handoff();
  const original = net.Server.prototype.listen;
  let forced = false;
  t.mock.method(net.Server.prototype, "listen", function (options, ...args) {
    if (!forced && options?.port === 0) {
      forced = true;
      return original.call(this, { ...options, port: first.ports.adb }, ...args);
    }
    return original.call(this, options, ...args);
  });
  const second = await acquireEmulatorLease({ ...pool, workspace: pool.second, runId: randomUUID() });
  pool.cleanup(() => second.release());
  assert.equal(forced, true, "Exercise the OS allocating a handed-off but not yet bound port.");
  assert.equal(new Set([...Object.values(first.ports), ...Object.values(second.ports)]).size, 8);
});

test("an IPv6-only listener prevents reclaiming a dead owner's port lease", async (t) => {
  const { acquireEmulatorLease, emulatorLeaseStatus } = await import("../emulator-resources.mjs");
  const pool = await poolFixture(t), holder = peer(pool);
  holder.send({ type: "acquire", options: { ...pool, workspace: pool.first, runId: randomUUID() } });
  const original = await holder.wait("acquired");
  holder.send({ type: "handoff" });
  await holder.wait("handed-off");
  const ipv6 = net.createServer();
  await new Promise((resolve, reject) => {
    ipv6.once("error", reject);
    ipv6.listen({ host: "::1", port: original.ports.adb, ipv6Only: true, exclusive: true }, resolve);
  });
  pool.cleanup(async () => { if (ipv6.listening) await new Promise((resolve) => ipv6.close(resolve)); });
  await stopOwnedProcess(holder.child);
  const status = await emulatorLeaseStatus(pool);
  assert.equal(status.leases.length, 1);
  assert.equal(status.leases[0].id, original.id);
  await new Promise((resolve) => ipv6.close(resolve));
  const next = await acquireEmulatorLease({ ...pool, workspace: pool.second, runId: randomUUID() });
  await next.release();
});

test("killing only a lease controller cannot admit another worktree while its preparation job survives", async (t) => {
  const { acquireEmulatorLease } = await import("../emulator-resources.mjs");
  const pool = await poolFixture(t), holder = peer(pool);
  holder.send({ type: "acquire", options: { ...pool, workspace: pool.first, runId: randomUUID() } });
  await holder.wait("acquired");
  holder.send({ type: "prepare" });
  const worker = await holder.wait("preparing");
  pool.cleanup(async () => {
    await exec("pwsh", ["-NoProfile", "-Command",
      `if (Get-Process -Id ${worker.pid} -ErrorAction SilentlyContinue) { Stop-Process -Id ${worker.pid} -Force }`]);
  });
  await exec("pwsh", ["-NoProfile", "-Command", `Stop-Process -Id ${holder.child.pid} -Force`]);
  const next = await acquireEmulatorLease({ ...pool, workspace: pool.first, runId: randomUUID(), timeoutMs: 15_000 });
  pool.cleanup(() => next.release());
  const running = await exec("pwsh", ["-NoProfile", "-Command",
    `if (Get-Process -Id ${worker.pid} -ErrorAction SilentlyContinue) { 'alive' }`]);
  assert.equal(running.stdout.trim(), "", "The old owned preparation must be gone before another run is admitted.");
});
