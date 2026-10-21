import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import childProcess, { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { runCommand, stopOwnedProcess } from "../process.mjs";
import { localPipe } from "../local-ipc.mjs";

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

test("macOS automatically recovers only the failed native run with an authentic command cleanup outcome",
  { skip: process.platform !== "darwin" }, async (t) => {
    const { acquireEmulatorLease, emulatorLeaseStatus, recoverEmulatorLease } = await import("../emulator-resources.mjs");
    const pool = await poolFixture(t), runId = randomUUID(), directory = path.join(pool.first, ".data", "device");
    const scripts = path.join(pool.first, "scripts"), program = path.join(pool.first, "lease-fixture.mjs");
    await mkdir(scripts);
    const entry = path.join(scripts, "test-android.ps1"), pidFile = path.join(pool.first, "worker.pid");
    await writeFile(program, [
      `import {acquireEmulatorLease} from ${JSON.stringify(pathToFileURL(path.resolve("scripts/emulator-resources.mjs")).href)};`,
      `import {spawnOwnedCommand} from ${JSON.stringify(pathToFileURL(path.resolve("scripts/process.mjs")).href)};`,
      "import {writeFileSync} from 'node:fs';",
      `const lease=await acquireEmulatorLease({workspace:process.cwd(),runId:process.argv[2],registryDirectory:${JSON.stringify(pool.registryDirectory)}});`,
      "await lease.handoff();",
      "const child=spawnOwnedCommand(process.execPath,['-e','console.log(process.pid);setInterval(()=>{},1000)'],{timeoutMs:30000,graceMs:100});",
      "let ready=false,diagnostics='';child.stderr.on('data',bytes=>{diagnostics=(diagnostics+bytes).slice(-4096)});",
      "child.once('close',code=>{if(!ready)throw new Error('Nested fixture exited before readiness: '+code+' '+diagnostics.replace(/\\x1eDEVPOCKET:[a-f0-9-]{36}:[a-z-]+\\x1f/g,''))});",
      `child.stdout.once('data',bytes=>{ready=true;writeFileSync(${JSON.stringify(pidFile)},bytes);process.exit(37)});`,
    ].join("\n"));
    await writeFile(entry, `param([string]$RunDirectory,[string]$Owner)\n& node '${program.replaceAll("'", "''")}' $Owner\nexit $LASTEXITCODE\n`);
    const args = ["-NoProfile", "-NonInteractive", "-File", entry, "-RunDirectory", directory, "-Owner", runId];
    let outcome;
    await assert.rejects(runCommand("pwsh", args, { cwd: pool.first, timeoutMs: 30000, graceMs: 100 }),
      (error) => {
        outcome = error;
        assert.equal(error.code, 37, error.stderr);
        assert.equal(error.processTreeStopped, true, error.stderr);
        return true;
      });
    const prior = await emulatorLeaseStatus(pool);
    assert.equal(prior.leases.length, 1, "A missing controller alone must retain its lease.");
    const recovery = { ...pool, workspace: pool.first, runId, directory };
    for (const [candidate, command] of [[{ ...outcome }, args], [outcome, [...args, "-Layouts"]],
      [outcome, args.map((value) => value === runId ? randomUUID() : value)]]) {
      await assert.rejects(recoverEmulatorLease(recovery, candidate, command), /confirmed cleanup/);
      assert.equal((await emulatorLeaseStatus(pool)).leases[0].id, prior.leases[0].id);
    }
    const result = await recoverEmulatorLease(recovery, outcome, args);
    assert.deepEqual(result, { status: "released", id: prior.leases[0].id });
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    const next = await acquireEmulatorLease({ ...pool, workspace: pool.second, runId: randomUUID() });
    await next.release();
  });

test("macOS socket creation contention waits instead of failing the emulator pool",
  { skip: process.platform !== "darwin" }, async (t) => {
    const { configureEmulatorLimit } = await import("../emulator-resources.mjs");
    const pool = await poolFixture(t), listen = net.Server.prototype.listen;
    let collided = false;
    t.mock.method(net.Server.prototype, "listen", function (options, ...args) {
      if (!collided && typeof options?.path === "string") {
        collided = true;
        queueMicrotask(() => this.emit("error", Object.assign(new Error("Concurrent socket creation."), { code: "EEXIST" })));
        return this;
      }
      return listen.call(this, options, ...args);
    });
    assert.deepEqual(await configureEmulatorLimit(2, pool), { limit: 2, active: 0, waiting: 0 });
    assert.equal(collided, true);
  });

test("macOS registry locking recovers a killed lock holder without losing live leases",
  { skip: process.platform !== "darwin" }, async (t) => {
    const { acquireEmulatorLease, configureEmulatorLimit, emulatorLeaseStatus } = await import("../emulator-resources.mjs");
    const pool = await poolFixture(t);
    await configureEmulatorLimit(2, pool);
    const first = await acquireEmulatorLease({ ...pool, workspace: pool.first, runId: randomUUID() });
    pool.cleanup(() => first.release());
    const key = createHash("sha256").update(pool.registryDirectory).digest("hex").slice(0, 32);
    const legacySocket = localPipe(`devpocket-emulator-${key}-registry`);
    const source = `import fs from "node:fs/promises";import path from "node:path";import {syncBuiltinESMExports} from "node:module";
      const write=fs.writeFile;fs.writeFile=async function(file,...args){
        if(path.dirname(file)===${JSON.stringify(pool.registryDirectory)}&&path.basename(file).startsWith("registry-")){
          console.log("locked");await new Promise(()=>{});return;
        }
        return write.call(this,file,...args);
      };syncBuiltinESMExports();
      const {configureEmulatorLimit}=await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/emulator-resources.mjs")).href)});
      setInterval(()=>{},1000);await configureEmulatorLimit(3,{registryDirectory:${JSON.stringify(pool.registryDirectory)}});`;
    const holder = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(holder, "exit");
    holder.stderr.resume();
    pool.cleanup(async () => {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      await exited;
      try {
        const info = await lstat(legacySocket);
        assert.equal(info.isSocket(), true);
        await unlink(legacySocket);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Registry holder did not enter its critical section.")), 10000);
      let output = "";
      holder.stdout.on("data", (bytes) => {
        output += bytes;
        if (output.includes("locked\n")) { clearTimeout(timer); resolve(); }
      });
    });
    holder.kill("SIGKILL");
    await exited;
    await assert.rejects(access(legacySocket), { code: "ENOENT" },
      "A crashed registry operation must not leave a pathname lock blocking recovery.");
    const state = await emulatorLeaseStatus(pool);
    assert.equal(state.limit, 2);
    assert.equal(state.leases.length, 1);
    assert.equal(state.leases[0].id, first.id);
    const second = await acquireEmulatorLease({ ...pool, workspace: pool.second, runId: randomUUID(), timeoutMs: 5000 });
    await second.release();
  });

test("macOS upgrades only an idle legacy registry and preserves its limit and retained records",
  { skip: process.platform !== "darwin" }, async (t) => {
    const { emulatorLeaseStatus } = await import("../emulator-resources.mjs");
    const pool = await poolFixture(t), file = path.join(pool.registryDirectory, "registry.json");
    await mkdir(pool.registryDirectory, { mode: 0o700 });
    await writeFile(file, JSON.stringify({ version: 1, limit: 3, leases: [], waiters: [] }), { mode: 0o600 });
    assert.equal((await emulatorLeaseStatus(pool)).limit, 3);
    assert.equal(JSON.parse(await readFile(file, "utf8")).version, 2);
    const owner = { id: randomUUID(), runId: randomUUID(), workspace: pool.first, pid: process.pid };
    for (const entries of [
      { leases: [{ ...owner, ports: { console: 32500, device: 32501, adb: 32502, grpc: 32503 } }], waiters: [] },
      { leases: [], waiters: [owner] },
    ]) {
      const original = JSON.stringify({ version: 1, limit: 3, ...entries });
      await writeFile(file, original);
      await assert.rejects(emulatorLeaseStatus(pool), /legacy macOS emulator registry must be idle/);
      assert.equal(await readFile(file, "utf8"), original);
    }
  });

test("macOS registry locks reject linked and non-private files before changing registry state",
  { skip: process.platform !== "darwin" }, async (t) => {
    const { emulatorLeaseStatus } = await import("../emulator-resources.mjs");
    const pool = await poolFixture(t), file = path.join(pool.registryDirectory, "registry.lock");
    const target = path.join(pool.first, "untouched");
    await mkdir(pool.registryDirectory, { mode: 0o700 });
    await writeFile(target, "unchanged");
    await symlink(target, file);
    await assert.rejects(emulatorLeaseStatus(pool), { code: "ELOOP" });
    assert.equal(await readFile(target, "utf8"), "unchanged");
    await unlink(file);
    await writeFile(file, "", { mode: 0o644 });
    await chmod(file, 0o644);
    await assert.rejects(emulatorLeaseStatus(pool), /private file identity/);
    await assert.rejects(access(path.join(pool.registryDirectory, "registry.json")), { code: "ENOENT" });
  });

test("macOS registry helper deadlines retain timeout and cancellation semantics without hiding crashes",
  { skip: process.platform !== "darwin" }, async (t) => {
    const { acquireEmulatorLease, configureEmulatorLimit, emulatorLeaseStatus } = await import("../emulator-resources.mjs");
    for (const mode of ["deadline", "late-success", "cancelled", "crash", "late-crash"]) await t.test(mode, async (t) => {
      const pool = await poolFixture(t);
      await configureEmulatorLimit(1, pool);
      const controller = new AbortController(), original = childProcess.spawn;
      let intercepted = false, lease, clock;
      pool.cleanup(async () => { await lease?.release(); });
      const mock = t.mock.method(childProcess, "spawn", (file, args, options) => {
        if (!intercepted && file === "python3" && args.includes("--registry-lock")) {
          intercepted = true;
          const command = mode === "late-success" ? args
            : ["-B", "-c", mode.endsWith("crash") ? "import sys;sys.exit(37)" : "import time;time.sleep(1)"];
          const child = original(file, command, options);
          if (mode === "cancelled") child.once("spawn", () => controller.abort());
          if (mode.startsWith("late-")) child.once("close", () => {
            const elapsed = Date.now() + 6000;
            clock = t.mock.method(Date, "now", () => elapsed);
          });
          return child;
        }
        return original(file, args, options);
      });
      syncBuiltinESMExports();
      try {
        const pending = acquireEmulatorLease({ ...pool, workspace: pool.first, runId: randomUUID(),
          timeoutMs: mode === "deadline" ? 80 : 5000, signal: controller.signal }).then((value) => { lease = value; return value; });
        await assert.rejects(pending, (error) => {
          if (["deadline", "late-success"].includes(mode)) assert.equal(error.code, "EMULATOR_SLOT_TIMEOUT");
          else if (mode === "cancelled") assert.equal(error.name, "AbortError");
          else {
            assert.notEqual(error.code, "EMULATOR_SLOT_TIMEOUT");
            assert.match(error.message, /registry lock helper failed \(37\)/);
          }
          return true;
        });
        assert.equal(intercepted, true);
      } finally {
        mock.mock.restore();
        clock?.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal((await emulatorLeaseStatus(pool)).leases.length, 0);
    });
  });

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
  const { failureDetails } = await import("../diagnostic-errors.mjs");
  const pool = await poolFixture(t);
  const lease = await acquireEmulatorLease({ ...pool, workspace: pool.first, runId: randomUUID() });
  pool.cleanup(() => lease.release());
  const cancellation = new AbortController();
  let announce;
  const waiting = new Promise((resolve) => { announce = resolve; });
  const pending = acquireEmulatorLease({
    ...pool, workspace: pool.second, runId: randomUUID(), signal: cancellation.signal, onWaiting: announce,
  });
  const cancelled = assert.rejects(pending, (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(failureDetails(error).reason, "command-cancelled");
    assert.equal(failureDetails(error).exitCode, "unknown");
    return true;
  });
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
  const { failureDetails } = await import("../diagnostic-errors.mjs");
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
  }), (error) => {
    assert.equal(error.code, "EMULATOR_SLOT_TIMEOUT");
    assert.equal(failureDetails(error).reason, "lease-timeout");
    assert.equal(failureDetails(error).exitCode, "unknown");
    return true;
  });
  const stale = await emulatorLeaseStatus(pool);
  assert.equal(stale.leases[0].id, original.id);
  assert.equal(stale.leases[0].ownerAlive, false);
  assert.equal(occupied.listening, true);
  await new Promise((resolve) => occupied.close(resolve));
  if (process.platform === "darwin") {
    await assert.rejects(acquireEmulatorLease({
      ...pool, workspace: pool.second, runId: randomUUID(), timeoutMs: 250,
    }), { code: "EMULATOR_SLOT_TIMEOUT" });
    assert.equal((await emulatorLeaseStatus(pool)).leases[0].id, original.id);
    return;
  }
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
  if (process.platform === "darwin") {
    await assert.rejects(acquireEmulatorLease({
      ...pool, workspace: pool.second, runId: randomUUID(), timeoutMs: 250,
    }), { code: "EMULATOR_SLOT_TIMEOUT" });
    return;
  }
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
  if (process.platform === "darwin") {
    await assert.rejects(acquireEmulatorLease({
      ...pool, workspace: pool.first, runId: randomUUID(), timeoutMs: 250,
    }), { code: "EMULATOR_SLOT_TIMEOUT" });
    return;
  }
  const next = await acquireEmulatorLease({ ...pool, workspace: pool.first, runId: randomUUID(), timeoutMs: 15_000 });
  pool.cleanup(() => next.release());
  const running = await exec("pwsh", ["-NoProfile", "-Command",
    `if (Get-Process -Id ${worker.pid} -ErrorAction SilentlyContinue) { 'alive' }`]);
  assert.equal(running.stdout.trim(), "", "The old owned preparation must be gone before another run is admitted.");
});
