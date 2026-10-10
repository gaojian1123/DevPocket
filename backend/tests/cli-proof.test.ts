import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { promisify } from "node:util";
import { cliProofRequest, cliProofSummary, readCliProof, startCliProof, stopCliProof } from "../integration/cli-proof.js";
import { HostConfig, startBridge } from "../src/bridge.js";

test("real-CLI proof relays use independent run directories and atomically bound loopback ports", async (t) => {
  const firstRoot = path.resolve(".data", "cli-proofs", `test-${randomUUID()}`);
  const secondRoot = path.resolve(".data", "cli-proofs", `test-${randomUUID()}`);
  const first = await startCliProof(firstRoot), second = await startCliProof(secondRoot);
  t.after(async () => {
    await first.close(); await second.close();
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  });

  assert.notEqual(first.proof.relayUrl, second.proof.relayUrl);
  assert.notEqual(first.proof.hostId, second.proof.hostId);
  assert.notEqual(first.proof.sessionId, second.proof.sessionId);
  const readFirst = await readCliProof(firstRoot);
  const request = cliProofRequest(readFirst);
  const catalog = await request("/v1/catalog") as { hosts: { id: string }[] };
  assert.deepEqual(catalog.hosts.map((host) => host.id), [first.proof.hostId]);
  await assert.rejects(startCliProof(firstRoot), { code: "EEXIST" });
  await stopCliProof(firstRoot);
  await assert.rejects(readCliProof(firstRoot), /closed|unavailable/);
  assert.equal((await readCliProof(secondRoot)).runId, second.proof.runId);
  assert.equal(JSON.parse(await readFile(path.join(firstRoot, "closed.json"), "utf8")).status, "closed");
});

test("proof consumers reject edited scope or credentials instead of trusting an old relay address", async (t) => {
  const root = path.resolve(".data", "cli-proofs", `test-${randomUUID()}`);
  const run = await startCliProof(root);
  t.after(async () => { await run.close(); await rm(root, { recursive: true, force: true }); });
  const metadataFile = path.join(root, "proof.local.json");
  const original = await readFile(metadataFile, "utf8");
  const metadata = JSON.parse(original);
  for (const edit of [{ sessionId: randomUUID() }, { deviceToken: `dpd_${"A".repeat(43)}` }]) {
    await writeFile(metadataFile, JSON.stringify({ ...metadata, ...edit }));
    await assert.rejects(readCliProof(root), /changed|unavailable/);
  }
  await writeFile(metadataFile, original);
  assert.equal((await readCliProof(root)).sessionId, run.proof.sessionId);
  const publicOutput = JSON.stringify(cliProofSummary(run.proof));
  assert.ok(!publicOutput.includes(metadata.deviceToken));
  assert.ok(!publicOutput.includes("hostConfig"));
  const request = cliProofRequest(run.proof);
  await run.close();
  await assert.rejects(request("/v1/catalog"), /closed|unavailable/);
});

test("real runtime checks and extension staging cannot start without the selected operation's opt-in", async (t) => {
  const root = path.resolve(".data", "cli-proofs", `test-${randomUUID()}`);
  const run = await startCliProof(root);
  t.after(async () => { await run.close(); await rm(root, { recursive: true, force: true }); });
  const exec = promisify(execFile);
  for (const [script, args, message] of [
    ["live-checks.ts", [], /confirm-runtime-checks/],
    ["cancel-check.ts", [], /confirm-runtime-checks/],
    ["canvas-proof.ts", ["send", '{"type":"abort"}'], /confirm-runtime-checks/],
    ["canvas-proof.ts", ["android"], /confirm-runtime-checks/],
    ["canvas-proof.ts", ["install"], /confirm-install/],
  ] as const) {
    await assert.rejects(exec(process.execPath, [
      "--import", import.meta.resolve("tsx"),
      path.resolve("backend", "integration", script), ...args, "--directory", root,
    ], { cwd: run.proof.workspace, timeout: 15_000 }), message);
  }
  for (const file of ["live-checks.json", "cancellation.json", "attachment-time.json"]) {
    await assert.rejects(readFile(path.join(root, file)), { code: "ENOENT" });
  }
});

test("proof paths and host credentials remain bound to their owning checkout without following junctions", async (t) => {
  const root = path.resolve(".data", "cli-proofs", `test-${randomUUID()}`);
  const run = await startCliProof(root);
  t.after(async () => { await run.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(readCliProof(root, path.join(root, "another-checkout")), /checkout/);
  const hostFile = run.proof.hostConfigPath, original = await readFile(hostFile, "utf8");
  const host = JSON.parse(original);
  await writeFile(hostFile, JSON.stringify({ ...host, token: host.token.slice(0, -1) + (host.token.endsWith("A") ? "B" : "A") }));
  await assert.rejects(readCliProof(root), /changed/);
  await writeFile(hostFile, original);
  const destination = path.join(root, "must-not-write-here"), alias = path.join(root, "alias");
  await mkdir(destination);
  await symlink(destination, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(startCliProof(path.join(alias, "unexpected-parent", "run")), /Linked/);
  await assert.rejects(readFile(path.join(destination, "unexpected-parent", "run", "proof.local.json")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(destination, "unexpected-parent")), { code: "ENOENT" });
});

test("a dead proof owner is not replaced by an unrelated service reusing its relay port", async (t) => {
  const root = path.resolve(".data", "cli-proofs", `test-${randomUUID()}`);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
    path.resolve("backend", "integration", "canvas-proof.ts"), "start", "--directory", root],
  { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exited = once(child, "exit");
  const replacement = net.createServer((socket) => { contacts++; socket.destroy(); });
  let contacts = 0;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    if (replacement.listening) await new Promise<void>((resolve, reject) => replacement.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Proof startup did not finish.")), 15_000);
    let text = "", errors = "";
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", () => { clearTimeout(timeout); reject(new Error(errors || "Proof owner exited before readiness.")); });
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.trimEnd().endsWith("}")) { clearTimeout(timeout); resolve(); }
    });
    child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4096); });
  });
  const proof = await readCliProof(root);
  child.kill("SIGKILL");
  await exited;
  await new Promise<void>((resolve, reject) => {
    replacement.once("error", reject);
    replacement.listen(Number(new URL(proof.relayUrl).port), "127.0.0.1", resolve);
  });
  await assert.rejects(readCliProof(root), /unavailable/);
  await assert.rejects(cliProofRequest(proof)("/v1/catalog"), /unavailable/);
  assert.equal(contacts, 0, "No credentials or commands may be sent to a replacement listener.");
});

test("a proof bridge authenticates every reconnect while the original fake runtime remains alive", async (t) => {
  const root = path.resolve(".data", "cli-proofs", `test-${randomUUID()}`);
  const run = await startCliProof(root);
  const config = HostConfig.parse(JSON.parse(await readFile(run.proof.hostConfigPath, "utf8")));
  const bridge = await startBridge({
    sessionId: run.proof.sessionId, getEvents: async () => [], on: () => () => {},
    rpc: { metadata: { activity: async () => ({ hasActiveWork: false, abortable: false }) },
      permissions: { getMode: async () => ({ mode: "manual" }), pendingRequests: async () => ({ items: [] }) } },
  }, config);
  let deliver: (value: string) => void = () => {};
  const observed = new Promise<string>((resolve) => { deliver = resolve; });
  const replacement = net.createServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.once("data", (bytes) => {
      deliver(bytes.toString());
      socket.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
  });
  t.after(async () => {
    await bridge.close(); await run.close();
    if (replacement.listening) await new Promise<void>((resolve) => replacement.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await run.close();
  await new Promise<void>((resolve, reject) => {
    replacement.once("error", reject);
    replacement.listen(Number(new URL(config.relayUrl).port), "127.0.0.1", resolve);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempted = await Promise.race([observed, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("No bounded bridge reconnect was observed.")), 20_000);
  })]).finally(() => clearTimeout(timer));
  assert.ok(!attempted.toLowerCase().includes("authorization:"), "A reconnect must not leak the host credential to a replacement listener.");
  assert.ok(!attempted.includes(config.token));
});
