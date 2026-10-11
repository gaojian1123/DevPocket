import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, readlink, realpath, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export function parseLinuxProcess(text) {
  const end = text.lastIndexOf(")");
  const pid = Number(text.slice(0, text.indexOf(" ")));
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || !Number.isSafeInteger(pid) || pid < 1 || fields.length < 20 ||
      !/^[A-Za-z]$/.test(fields[0]) || !/^\d+$/.test(fields[19]) ||
      !/^\d+$/.test(fields[1]) || !/^\d+$/.test(fields[2])) {
    throw new Error("Linux process identity is incomplete.");
  }
  return { pid, parent: Number(fields[1]), group: Number(fields[2]), state: fields[0], started: fields[19] };
}

export function tcpListenerInodes(text, port) {
  const result = [];
  for (const line of text.trim().split("\n").slice(1)) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || !/^[0-9A-Fa-f]+:[0-9A-Fa-f]{4}$/.test(fields[1]) ||
        !/^[0-9A-Fa-f]{2}$/.test(fields[3]) || !/^\d+$/.test(fields[9])) {
      throw new Error("Linux listener evidence is incomplete.");
    }
    if (fields[3] === "0A" && Number.parseInt(fields[1].split(":")[1], 16) === port) result.push(fields[9]);
  }
  return result;
}

export async function ownsLinuxListener(port, ownerPid) {
  const table = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try { table.push(parseLinuxProcess(await readFile(`/proc/${name}/stat`, "utf8"))); }
    catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  }
  if (!table.some((item) => item.pid === ownerPid && item.state !== "Z")) return false;
  const owned = new Set([ownerPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of table) {
      if (owned.has(item.parent) && !owned.has(item.pid)) { owned.add(item.pid); changed = true; }
    }
  }
  const inodes = new Set();
  for (const pid of owned) {
    let descriptors;
    try { descriptors = await readdir(`/proc/${pid}/fd`); }
    catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) continue; throw error; }
    for (const fd of descriptors) {
      try {
        const socket = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${pid}/fd/${fd}`));
        if (socket) inodes.add(socket[1]);
      } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
    }
  }
  const listeners = (await Promise.all(["tcp", "tcp6"].map(async (name) =>
    tcpListenerInodes(await readFile(`/proc/net/${name}`, "utf8"), port)))).flat();
  return listeners.length > 0 && listeners.every((inode) => inodes.has(inode));
}

export function linuxAcceleration(output) {
  if (!/\bKVM\b[^\r\n]*\bis installed and usable\b/.test(output)) {
    throw new Error("The Linux device gate requires explicit usable KVM acceleration.");
  }
  return { provider: "KVM", usable: true };
}

async function reserve(port) {
  const held = [];
  let selected = port;
  try {
    for (const host of ["127.0.0.1", "::1"]) {
      const server = net.createServer((socket) => socket.destroy());
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host, port: selected, ipv6Only: host === "::1", exclusive: true }, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      held.push(server);
      selected = server.address().port;
    }
  } catch (error) {
    for (const server of held) await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return { port: selected, close: async () => {
    for (const server of held) if (server.listening) await new Promise((resolve) => server.close(resolve));
  } };
}

export async function acquireLinuxEmulatorLease({ workspace, runId, signal }) {
  signal?.throwIfAborted();
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid Linux emulator owner.");
  const root = await realpath(workspace);
  const directory = path.join(root, ".data");
  await mkdir(directory, { recursive: true });
  if (await realpath(directory) !== directory) throw new Error("Linked Linux lease directories are not supported.");
  const file = path.join(directory, "linux-emulator.lock"), id = randomUUID();
  let lock;
  try { lock = await open(file, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("A Linux emulator run is active or unreclaimed in this isolated checkout.");
    throw error;
  }
  try { await lock.writeFile(JSON.stringify({ version: 1, id, runId, pid: process.pid, workspace: root })); }
  finally { await lock.close(); }
  let held = [], released = false;
  const handoff = async () => { for (const reservation of held) await reservation.close(); held = []; };
  const release = async () => {
    if (released) return;
    await handoff();
    const owner = JSON.parse(await readFile(file, "utf8"));
    if (owner.id !== id || owner.runId !== runId || owner.pid !== process.pid || owner.workspace !== root) {
      throw new Error("Linux emulator lease ownership changed; cleanup was refused.");
    }
    await unlink(file);
    released = true;
  };
  try {
    for (let consolePort = 5554; consolePort <= 5682; consolePort += 2) {
      signal?.throwIfAborted();
      try {
        for (const port of [consolePort, consolePort + 1, 0, 0]) held.push(await reserve(port));
        return { id, ports: Object.fromEntries(["console", "device", "adb", "grpc"]
          .map((name, index) => [name, held[index].port])), handoff, release };
      } catch (error) {
        await handoff();
        if (!["EADDRINUSE", "EACCES"].includes(error.code)) throw error;
      }
    }
    throw new Error("No isolated Linux emulator port pair is available.");
  } catch (error) { await release(); throw error; }
}
