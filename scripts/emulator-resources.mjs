import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { commandCleanupConfirmed, ownerProcessFamilyAlive } from "./process.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { localPipe } from "./local-ipc.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const exec = promisify(execFile);
const portNames = ["console", "device", "adb", "grpc"];
const pathKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;
const waitError = () => Object.assign(new Error("Timed out waiting for the shared emulator resource pool."), { code: "EMULATOR_SLOT_TIMEOUT" });

export function defaultEmulatorRegistry() {
  if (process.platform === "darwin") return path.join(homedir(), ".cache", "DevPocket", "verification", "emulator-pool");
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
    throw new Error("The shared emulator pool requires the Windows account's LOCALAPPDATA directory.");
  }
  return path.join(process.env.LOCALAPPDATA, "DevPocket", "verification", "emulator-pool");
}

async function registryRoot(directory) {
  const root = path.resolve(directory ?? defaultEmulatorRegistry());
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await realpath(root);
  if (pathKey(canonical) !== pathKey(root)) throw new Error("Linked emulator registries are not supported.");
  if (process.platform === "darwin") {
    const info = await lstat(root);
    if (info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error("The macOS emulator registry must be private to this user.");
  }
  return canonical;
}

function pipeName(root, suffix) {
  const id = createHash("sha256").update(pathKey(root)).digest("hex").slice(0, 32);
  return localPipe(`devpocket-emulator-${id}-${suffix}`);
}

async function bindListener(address, response = "") {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(1000, () => socket.destroy());
    socket.end(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    port: typeof server.address() === "object" ? server.address().port : undefined,
    unref: () => server.unref(),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function listener(address, response = "") {
  if (typeof address !== "number") return bindListener({ path: address, exclusive: true }, response);
  const ipv4 = await bindListener({ host: "127.0.0.1", port: address, exclusive: true });
  let ipv6;
  try { ipv6 = await bindListener({ host: "::1", port: ipv4.port, exclusive: true, ipv6Only: true }); }
  catch (error) { await ipv4.close(); throw error; }
  return {
    port: ipv4.port,
    unref: () => { ipv4.unref(); ipv6.unref(); },
    close: async () => { await ipv4.close(); await ipv6.close(); },
  };
}

async function listeningPorts() {
  const result = await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $ports=@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()" +
    ".GetActiveTcpListeners() | Select-Object -ExpandProperty Port -Unique); ConvertTo-Json -InputObject $ports -Compress"],
  { timeout: 20_000, windowsHide: true });
  const ports = JSON.parse(result.stdout);
  if (!Array.isArray(ports) || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("Host listener discovery is incomplete; emulator ports cannot be reclaimed.");
  }
  return new Set(ports);
}

async function withRegistryLock(root, operation, signal, deadline = Date.now() + 30_000) {
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    let lock;
    try { lock = await listener(pipeName(root, "registry"), "busy\n"); }
    catch (error) {
      if (!["EADDRINUSE", "EACCES"].includes(error.code) &&
          !(process.platform === "darwin" && error.code === "EEXIST")) throw error;
      await delay(50, undefined, { signal });
      continue;
    }
    try { return await operation(); }
    finally { await lock.close(); }
  }
  throw waitError();
}

function validateState(value) {
  if (!value || value.version !== 1 || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 64 ||
      !Array.isArray(value.leases) || !Array.isArray(value.waiters) ||
      value.leases.length > 64 || value.waiters.length > 1000) throw new Error("Unsupported or incomplete emulator resource registry.");
  const ids = new Set();
  for (const entry of [...value.leases, ...value.waiters]) {
    if (!entry || !uuid.test(entry.id) || !uuid.test(entry.runId) || ids.has(entry.id) ||
        typeof entry.workspace !== "string" || !path.isAbsolute(entry.workspace) ||
        !Number.isInteger(entry.pid) || entry.pid < 1) throw new Error("Invalid emulator resource owner.");
    ids.add(entry.id);
  }
  const allocated = new Set();
  for (const lease of value.leases) {
    if (!lease.ports || portNames.some((name) => !Number.isInteger(lease.ports[name]) ||
        lease.ports[name] < 1 || lease.ports[name] > 65535) ||
        new Set(portNames.map((name) => lease.ports[name])).size !== 4 ||
        lease.ports.console % 2 !== 0 || lease.ports.device !== lease.ports.console + 1) {
      throw new Error("Invalid emulator port lease.");
    }
    for (const port of Object.values(lease.ports)) {
      if (allocated.has(port)) throw new Error("Duplicate ports across live emulator leases.");
      allocated.add(port);
    }
  }
  return value;
}

async function loadState(root) {
  try { return validateState(JSON.parse(await readFile(path.join(root, "registry.json"), "utf8"))); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { version: 1, limit: 1, leases: [], waiters: [] };
  }
}

async function saveState(root, state) {
  validateState(state);
  const temporary = path.join(root, `registry-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temporary, path.join(root, "registry.json"));
}

async function alive(root, id) {
  return new Promise((resolve) => {
    const socket = net.connect(pipeName(root, id));
    let settled = false, result = "";
    const finish = (value) => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
    socket.setTimeout(500, () => finish("unknown"));
    socket.on("data", (bytes) => {
      result += bytes.toString();
      if (result.length > 100) finish("unknown");
    });
    socket.once("end", () => finish(result === `${id}\n` ? true : "unknown"));
    socket.once("error", (error) => finish(["ENOENT", "ECONNREFUSED"].includes(error.code) ? false : "unknown"));
  });
}

async function portsFree(ports) {
  const occupied = await listeningPorts();
  if (Object.values(ports).some((port) => occupied.has(port))) return false;
  const held = [];
  try {
    for (const port of Object.values(ports)) held.push(await listener(port));
    return true;
  } catch (error) {
    if (!["EADDRINUSE", "EACCES"].includes(error.code)) throw error;
    return false;
  } finally {
    for (const server of held) await server.close();
  }
}

async function reap(root, state) {
  const leases = [];
  for (const lease of state.leases) {
    if (await alive(root, lease.id) !== false || await ownerProcessFamilyAlive(lease.pid) ||
        !await portsFree(lease.ports)) leases.push(lease);
  }
  const waiters = [];
  for (const waiter of state.waiters) if (await alive(root, waiter.id) !== false) waiters.push(waiter);
  state.leases = leases;
  state.waiters = waiters;
}

async function reservePorts(state, range) {
  const taken = new Set(state.leases.flatMap((lease) => Object.values(lease.ports)));
  for (const port of await listeningPorts()) taken.add(port);
  for (let port = range[0]; port <= range[1]; port += 2) {
    if (taken.has(port) || taken.has(port + 1)) continue;
    const held = [];
    try {
      held.push(await listener(port));
      held.push(await listener(port + 1));
      for (let attempt = 0; held.length < 4 && attempt < 128; attempt++) {
        const candidate = await listener(0);
        if (taken.has(candidate.port)) await candidate.close();
        else held.push(candidate);
      }
      if (held.length !== 4) {
        for (const server of held) await server.close();
        return null;
      }
      return { held, ports: Object.fromEntries(portNames.map((name, index) => [name, held[index].port])) };
    } catch (error) {
      for (const server of held) await server.close();
      if (!["EADDRINUSE", "EACCES"].includes(error.code)) throw error;
    }
  }

  return null;
}

export async function configureEmulatorLimit(limit, { registryDirectory } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("The emulator limit must be an integer from 1 to 64.");
  const root = await registryRoot(registryDirectory);
  return withRegistryLock(root, async () => {
    const state = await loadState(root);
    await reap(root, state);
    state.limit = limit;
    await saveState(root, state);
    return { limit, active: state.leases.length, waiting: state.waiters.length };
  });
}

export async function emulatorLeaseStatus({ registryDirectory } = {}) {
  const root = await registryRoot(registryDirectory);
  return withRegistryLock(root, async () => {
    const state = await loadState(root);
    await reap(root, state);
    await saveState(root, state);
    return {
      limit: state.limit,
      leases: await Promise.all(state.leases.map(async (entry) => ({ ...entry, ownerAlive: await alive(root, entry.id) }))),
      waiters: state.waiters,
    };
  });
}

export async function recoverEmulatorLease({ workspace, runId, directory, registryDirectory }, outcome, args) {
  const checkout = await realpath(workspace);
  const expected = ["-NoProfile", "-NonInteractive", "-File", path.join(checkout, "scripts", "test-android.ps1")];
  const values = new Map();
  if (process.platform !== "darwin" || !uuid.test(runId) || !Array.isArray(args) ||
      expected.some((value, index) => args[index] !== value) ||
      !commandCleanupConfirmed(outcome, { file: "pwsh", args, cwd: checkout })) {
    throw new Error("Automatic lease recovery requires the exact native command's confirmed cleanup.");
  }
  for (let index = expected.length; index < args.length; index++) {
    const name = args[index];
    if (name === "-Layouts" && !values.has(name)) { values.set(name, true); continue; }
    if (!["-Jdk", "-Sdk", "-Image", "-Owner", "-RunDirectory"].includes(name) || values.has(name) ||
        typeof args[index + 1] !== "string") throw new Error("Unrecognized native command scope for lease recovery.");
    values.set(name, args[++index]);
  }
  if (values.get("-Owner") !== runId || values.get("-RunDirectory") !== directory ||
      !path.relative(checkout, directory).startsWith(`.data${path.sep}`) ||
      path.relative(checkout, directory).split(path.sep).includes("..")) {
    throw new Error("Native command cleanup does not belong to this device run.");
  }
  const root = await registryRoot(registryDirectory);
  return withRegistryLock(root, async () => {
    const state = await loadState(root);
    const selected = state.leases.filter((entry) => entry.workspace === checkout && entry.runId === runId);
    if (!selected.length) return { status: "not-held" };
    if (selected.length !== 1) throw new Error("Ambiguous emulator lease ownership; recovery was refused.");
    const entry = selected[0];
    if (await alive(root, entry.id) !== false || !await portsFree(entry.ports)) {
      throw new Error("The confirmed command still has a live lease or occupied ports; recovery was refused.");
    }
    const socket = pipeName(root, entry.id);
    try {
      const info = await lstat(socket);
      if (!info.isSocket() || info.uid !== process.getuid()) throw new Error("Recovered lease socket ownership changed.");
      await unlink(socket);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    state.leases = state.leases.filter((lease) => lease.id !== entry.id);
    await saveState(root, state);
    return { status: "released", id: entry.id };
  });
}

export async function acquireEmulatorLease({
  workspace, runId, registryDirectory, signal, timeoutMs = 15 * 60_000, onWaiting,
  portRange = [5554, 5680],
}) {
  if (!["win32", "darwin"].includes(process.platform)) throw new Error("Shared emulator leases require Windows or macOS.");
  if (!uuid.test(runId) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Array.isArray(portRange) || portRange.length !== 2 ||
      portRange.some((port) => !Number.isInteger(port) || port < 1024 || port > 65534) ||
      portRange[0] % 2 || portRange[1] < portRange[0]) throw new Error("Invalid emulator lease request.");
  const root = await registryRoot(registryDirectory);
  const owner = { id: randomUUID(), runId, workspace: await realpath(workspace), pid: process.pid };
  const heartbeat = await listener(pipeName(root, owner.id), `${owner.id}\n`);
  heartbeat.unref();
  const deadline = Date.now() + timeoutMs;
  let reservation, released = false, lastWaiting;
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const status = await withRegistryLock(root, async () => {
        const state = await loadState(root);
        await reap(root, state);
        if (!state.waiters.some((item) => item.id === owner.id)) state.waiters.push(owner);
        const position = state.waiters.findIndex((item) => item.id === owner.id);
        if (position === 0 && state.leases.length < state.limit &&
            !state.leases.some((item) => pathKey(item.workspace) === pathKey(owner.workspace))) {
          reservation = await reservePorts(state, portRange);
          if (reservation) {
            state.waiters.shift();
            state.leases.push({ ...owner, ports: reservation.ports });
          }
        }
        await saveState(root, state);
        return { position: position + 1, active: state.leases.length, limit: state.limit };
      }, signal, deadline);
      if (reservation) break;
      const waiting = JSON.stringify(status);
      if (waiting !== lastWaiting) onWaiting?.(status);
      lastWaiting = waiting;
      await delay(100, undefined, { signal });
    }
    if (!reservation) throw waitError();
    const entry = { ...owner, ports: reservation.ports };
    return {
      id: owner.id, runId, workspace: owner.workspace, ports: { ...reservation.ports },
      handoff: async () => {
        if (released) throw new Error("The emulator lease has already been released.");
        for (const server of reservation.held.splice(0)) await server.close();
      },
      release: async () => {
        if (released) return;
        for (const server of reservation.held.splice(0)) await server.close();
        await withRegistryLock(root, async () => {
          const state = await loadState(root);
          const actual = state.leases.find((item) => item.id === owner.id);
          if (JSON.stringify(actual) !== JSON.stringify(entry)) throw new Error("Emulator lease ownership changed; refusing release.");
          if (!await portsFree(entry.ports)) throw new Error("Leased ports are still occupied; confirm owned processes have exited.");
          state.leases = state.leases.filter((item) => item.id !== owner.id);
          await saveState(root, state);
        });
        released = true;
        await heartbeat.close();
      },
    };
  } catch (error) {
    for (const server of reservation?.held ?? []) await server.close();
    try {
      await withRegistryLock(root, async () => {
        const state = await loadState(root);
        state.waiters = state.waiters.filter((item) => item.id !== owner.id);
        state.leases = state.leases.filter((item) => item.id !== owner.id);
        await saveState(root, state);
      });
    } finally { await heartbeat.close(); }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { max: { type: "string" } } });
  const command = positionals[0] ?? "status";
  if (positionals.length > 1 || !["status", "limit"].includes(command) ||
      (command === "status" && values.max !== undefined)) throw new Error("Use status, or limit --max N.");
  const result = command === "status" ? await emulatorLeaseStatus() : await configureEmulatorLimit(Number(values.max));
  console.log(JSON.stringify(result, null, 2));
}
