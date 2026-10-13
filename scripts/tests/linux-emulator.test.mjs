import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { acquireLinuxEmulatorLease, linuxAcceleration, parseLinuxProcess, tcpListenerInodes } from "../linux-emulator.mjs";

test("Linux process identity parsing retains ownership despite spaces and parentheses in the command name", () => {
  const fields = ["S", "42", "77", ...Array(16).fill("0"), "123456", "0"];
  assert.deepEqual(parseLinuxProcess(`81 (worker (fixture)) ${fields.join(" ")}`),
    { pid: 81, parent: 42, group: 77, state: "S", started: "123456" });
  assert.throws(() => parseLinuxProcess("81 broken"), /process/i);
});

test("Linux listener evidence selects only listening sockets at the exact leased port", () => {
  const header = "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode";
  const row = (port, state, inode) => `0: 0100007F:${port.toString(16).toUpperCase()} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode}`;
  assert.deepEqual(tcpListenerInodes(`${header}\n${row(5554, "0A", "123")}\n${row(5555, "01", "124")}\n${row(5556, "0A", "125")}\n`, 5554), ["123"]);
  assert.throws(() => tcpListenerInodes(`${header}\nmalformed\n`, 5554), /listener/i);
});

test("Linux acceleration requires explicit usable KVM evidence, not a zero exit or other hypervisor", () => {
  assert.deepEqual(linuxAcceleration("accel:\n0\nKVM (version 12) is installed and usable.\naccel\n"),
    { provider: "KVM", usable: true });
  for (const text of ["", "accel:\n0\n", "KVM is not usable.", "WHPX is installed and usable."]) {
    assert.throws(() => linuxAcceleration(text), /KVM/);
  }
});

test("Linux job-local leases reserve distinct ports and cannot remove another invocation's lock", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/linux-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = randomUUID();
  const lease = await acquireLinuxEmulatorLease({ workspace: root, runId });
  t.after(() => lease.release());
  assert.equal(new Set(Object.values(lease.ports)).size, 4);
  assert.equal(lease.ports.console % 2, 0);
  assert.equal(lease.ports.device, lease.ports.console + 1);
  const server = net.createServer();
  await assert.rejects(new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: lease.ports.console }, resolve);
  }), { code: "EADDRINUSE" });
  await assert.rejects(acquireLinuxEmulatorLease({ workspace: root, runId: randomUUID() }), /active|unreclaimed/i);
  const marker = JSON.parse(await readFile(path.join(root, ".data", "linux-emulator.lock"), "utf8"));
  assert.equal(marker.runId, runId);
  await lease.handoff();
  await assert.rejects(acquireLinuxEmulatorLease({ workspace: root, runId: randomUUID() }), /active|unreclaimed/i);
  const lockPath = path.join(root, ".data", "linux-emulator.lock");
  const replaced = { ...marker, id: randomUUID() };
  await writeFile(lockPath, JSON.stringify(replaced));
  await assert.rejects(lease.release(), /ownership changed/i);
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), replaced);
  await writeFile(lockPath, JSON.stringify(marker));
  await lease.release();
  const next = await acquireLinuxEmulatorLease({ workspace: root, runId: randomUUID() });
  await next.release();
});
