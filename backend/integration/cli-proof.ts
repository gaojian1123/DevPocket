import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { HostConfig } from "../src/bridge.js";
import { PendingRequest, type WireEvent } from "../src/protocol.js";
import { authenticatedProofFetch, ProofKey } from "../src/local-proof.js";
import { startRelay } from "../src/relay.js";
import { provisionHost } from "../src/store.js";
import { localPipe } from "../../scripts/local-ipc.mjs";

const absolute = z.string().refine((value) => path.isAbsolute(value));
const Metadata = z.object({
  version: z.literal(2), runId: z.string().uuid(), repo: absolute, root: absolute, workspace: absolute, plugin: absolute,
  sessionId: z.string().uuid(), hostId: z.string().uuid(),
  deviceToken: z.string().regex(/^dpd_[A-Za-z0-9_-]{43}$/),
  relayUrl: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/),
  hostConfigPath: absolute, marker: z.string().regex(/^DP_ORIGINAL_[a-f0-9]{32}$/),
  startedAt: z.number().int().positive(), directoryIdentity: z.string(),
  hostConfigHash: z.string().regex(/^[a-f0-9]{64}$/),
  proofOwnerKey: ProofKey,
}).strict();
export type CliProof = z.infer<typeof Metadata>;
const endpoint = (runId: string) => process.platform === "win32"
  ? `\\\\.\\pipe\\devpocket-cli-proof-${runId}` : process.platform === "darwin"
    ? localPipe(`devpocket-cli-proof-${runId}`) : path.join(os.tmpdir(), `devpocket-proof-${runId}.sock`);
const normalized = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const binding = (proof: CliProof) => digest(JSON.stringify(proof));

async function directoryIdentity(root: string): Promise<string> {
  const info = await lstat(root, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Linked proof directories are unsupported.");
  return `${info.dev}:${info.ino}`;
}

async function proofFile(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64_000) throw new Error("Unsupported proof metadata file.");
  return readFile(file, "utf8");
}

async function proofDirectory(directory: string, create: boolean, repo = process.cwd()): Promise<string> {
  const base = path.resolve(repo), target = path.resolve(base, directory);
  const parent = path.join(base, ".data", "cli-proofs");
  if (!path.relative(parent, target) || path.relative(parent, target).split(path.sep).some((part) => part === "..") ||
      path.isAbsolute(path.relative(parent, target))) throw new Error("Proof directories must be new children of this checkout's .data\\cli-proofs.");
  let current = base;
  const segments = path.relative(base, target).split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Linked or non-directory proof paths are unsupported.");
    } catch (error) {
      if (!(create && error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if (index < segments.length - 1) {
        await mkdir(current).catch((failure: NodeJS.ErrnoException) => { if (failure.code !== "EEXIST") throw failure; });
        await directoryIdentity(current);
      }
    }
  }
  return target;
}

export function cliProofSummary(proof: CliProof) {
  const { runId, root, workspace, plugin, sessionId, marker, relayUrl, startedAt } = proof;
  return { version: 2, runId, root, workspace, plugin, sessionId, marker, relayUrl, startedAt };
}

async function control(proof: CliProof, command: "inspect" | "stop") {
  return new Promise<void>((resolve, reject) => {
    const socket = net.connect(endpoint(proof.runId));
    let text = "", settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("This exact CLI proof is closed or unavailable; another relay will not be selected."));
    };
    socket.setTimeout(15_000, fail);
    socket.once("error", fail);
    socket.once("connect", () => socket.write(JSON.stringify({ runId: proof.runId, binding: binding(proof), command }) + "\n"));
    socket.once("close", fail);
    socket.on("data", (bytes) => { text += bytes.toString(); if (text.length > 2000) fail(); });
    socket.once("end", () => {
      if (settled) return;
      try {
        const value = z.object({
          runId: z.string().uuid(), relayUrl: z.string(), hostId: z.string().uuid(),
          status: z.enum(["ready", "closed"]),
        }).strict().parse(JSON.parse(text));
        assert.equal(value.runId, proof.runId);
        assert.equal(value.relayUrl, proof.relayUrl);
        assert.equal(value.hostId, proof.hostId);
        assert.equal(value.status, command === "inspect" ? "ready" : "closed");
        settled = true;
        socket.destroy();
        resolve();
      } catch { fail(); }
    });
  });
}

export async function readCliProof(directory: string, repo = process.cwd()): Promise<CliProof> {
  const root = await proofDirectory(directory, false, repo);
  const closed = await lstat(path.join(root, "closed.json")).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return false;
  });
  if (closed) throw new Error("This CLI proof is closed; preserve its evidence and start a new directory.");
  const proof = Metadata.parse(JSON.parse(await proofFile(path.join(root, "proof.local.json"))));
  if (normalized(proof.repo) !== normalized(repo) || normalized(proof.root) !== normalized(root) ||
      normalized(proof.workspace) !== normalized(path.join(root, "workspace")) ||
      normalized(proof.plugin) !== normalized(path.join(root, "plugin")) ||
      normalized(proof.hostConfigPath) !== normalized(path.join(root, "host.local.json"))) {
    throw new Error("The CLI proof metadata does not belong to the selected checkout and run directory.");
  }
  if (await directoryIdentity(root) !== proof.directoryIdentity) throw new Error("CLI proof directory changed.");
  for (const folder of [proof.workspace, proof.plugin, path.join(proof.plugin, "extensions")]) {
    if (normalized(await realpath(folder)) !== normalized(folder)) throw new Error("Linked proof resources are unsupported.");
  }
  const hostText = await proofFile(proof.hostConfigPath);
  if (digest(hostText) !== proof.hostConfigHash) throw new Error("CLI proof host credentials changed.");
  const host = HostConfig.parse(JSON.parse(hostText));
  if (host.hostId !== proof.hostId || host.relayUrl !== proof.relayUrl ||
      normalized(host.dataDir) !== normalized(path.join(root, "bridge")) || !host.allowInsecureLoopback) {
    throw new Error("CLI proof host scope changed.");
  }
  await control(proof, "inspect");
  return proof;
}

const CliIdentity = z.object({
  runId: z.string().uuid(), sessionId: z.string().uuid(), parentPid: z.number().int().positive(),
  processCreatedAt: z.string().datetime({ offset: true }), capturedAt: z.string().datetime(),
}).strict();

async function inspectCliProcess(proof: CliProof, inputPid: number) {
  if (process.platform !== "win32") throw new Error("Original CLI process inspection currently requires Windows.");
  const pid = z.number().int().positive().parse(inputPid);
  const { stdout } = await promisify(execFile)("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    $item = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'
    if (-not $item) { throw 'The selected original CLI process no longer exists.' }
    if ($item.Name -in @('cmd.exe', 'pwsh.exe', 'powershell.exe', 'conhost.exe', 'wscript.exe', 'cscript.exe')) {
      throw 'Select the actual CLI process, not a command-shell or terminal wrapper.'
    }
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DevPocketProofArguments {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Parse(string command) {
    int count;
    IntPtr memory = CommandLineToArgvW(command, out count);
    if (memory == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try {
      var result = new string[count];
      for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
      return result;
    } finally { LocalFree(memory); }
  }
}
'@
    $argv = [DevPocketProofArguments]::Parse($item.CommandLine)
    $sessions = @()
    for ($index = 1; $index -lt $argv.Length; $index++) {
      $arg = $argv[$index]
      if ($arg -ceq '--') { break }
      if ($arg -ceq '--session-id') {
        $index++
        if ($index -lt $argv.Length) { $sessions += $argv[$index] }
      } elseif ($arg.StartsWith('--session-id=', [StringComparison]::Ordinal)) {
        $sessions += $arg.Substring(13)
      } elseif ($arg -cin @('-i', '-C', '--name', '--mode', '--plugin-dir', '--log-dir', '--disable-mcp-server', '--prefer-version')) {
        $index++
      }
    }
    [pscustomobject]@{
      parentPid = [int]$item.ProcessId
      processCreatedAt = $item.CreationDate.ToUniversalTime().ToString('O')
      sessionMatched = [bool]($sessions.Count -eq 1 -and $sessions[0] -ceq '${proof.sessionId}')
    } | ConvertTo-Json -Compress
  `], { timeout: 15_000, windowsHide: true, maxBuffer: 4096 });
  const observed = z.object({
    parentPid: z.literal(pid), processCreatedAt: z.string().datetime({ offset: true }), sessionMatched: z.boolean(),
  }).strict().parse(JSON.parse(stdout));
  if (!observed.sessionMatched) throw new Error("The selected process does not have this proof's exact --session-id argument.");
  return observed;
}

export async function captureCliIdentity(proof: CliProof, pid: number) {
  if ((await readdir(path.join(proof.plugin, "extensions"))).length) {
    throw new Error("Capture the original process before staging or loading the extension. Use a new proof.");
  }
  const launch = z.object({
    runId: z.literal(proof.runId), sessionId: z.literal(proof.sessionId),
    launchedAt: z.string().datetime(), launcherPid: z.number().int().positive(),
  }).parse(JSON.parse(await proofFile(path.join(proof.root, "launch.json"))));
  const observed = await inspectCliProcess(proof, pid);
  if (Date.parse(observed.processCreatedAt) < Date.parse(launch.launchedAt) || pid === launch.launcherPid) {
    throw new Error("Select the original CLI process started by this proof, not its launcher or an older runtime.");
  }
  const identity = CliIdentity.parse({
    runId: proof.runId, sessionId: proof.sessionId, parentPid: pid,
    processCreatedAt: observed.processCreatedAt, capturedAt: new Date().toISOString(),
  });
  await writeFile(path.join(proof.root, "before-attachment.evidence.json"), JSON.stringify(identity, null, 2), { flag: "wx" });
  return identity;
}

export async function readCliIdentity(proof: CliProof) {
  await control(proof, "inspect");
  const before = CliIdentity.parse(JSON.parse(await proofFile(path.join(proof.root, "before-attachment.evidence.json"))));
  assert.equal(before.runId, proof.runId, "Original identity belongs to another proof.");
  assert.equal(before.sessionId, proof.sessionId, "Original identity belongs to another session.");
  const observed = await inspectCliProcess(proof, before.parentPid);
  assert.equal(observed.processCreatedAt, before.processCreatedAt, "The original PID was replaced; never resume this proof.");
  return before;
}

export async function verifyCliAttachment(proof: CliProof) {
  const before = await readCliIdentity(proof);
  const registration = z.object({
    parentPid: z.literal(before.parentPid), sessionId: z.literal(proof.sessionId),
    attachedAt: z.string().datetime(), recordedCliVersion: z.string().min(1).max(80),
  }).parse(JSON.parse(await proofFile(path.join(proof.root, "bridge", proof.hostId, proof.sessionId, "registration.json"))));
  assert.ok(Date.parse(before.capturedAt) < Date.parse(registration.attachedAt), "Identity capture must predate attachment.");
  return { before, registration };
}

export async function requireManualCli(proof: CliProof, idle = false): Promise<void> {
  const catalog = z.object({ sessions: z.array(z.object({
    hostId: z.string().uuid(), sessionId: z.string().uuid(), permissionMode: z.string(), state: z.string(), online: z.boolean(),
  })) }).parse(await cliProofRequest(proof)("/v1/catalog"));
  const session = catalog.sessions.find((item) => item.hostId === proof.hostId && item.sessionId === proof.sessionId);
  assert.ok(session?.online, "The selected original CLI must be connected.");
  assert.equal(session.permissionMode, "manual", "Keep the disposable CLI in Manual permission mode.");
  if (idle) assert.equal(session.state, "idle", "Finish startup/reload or pending work in the original terminal first.");
}

export function requireExactShellPermission(input: PendingRequest, command: string): void {
  const request = PendingRequest.parse(input);
  assert.ok(request.supported && request.type === "permission" && ["shell", "commands"].includes(request.permissionKind ?? ""),
    "Incomplete permission: review it in the original terminal.");
  const detail = request.detail.replace(/^Agent mode: interactive\n/, "").replace(/^Permission mode: manual\n/, "");
  for (const section of detail.split("\nPrompt details:\n")) {
    const form = z.object({
      kind: z.enum(["shell", "commands"]), fullCommandText: z.string().optional(), command: z.string().optional(),
      args: z.object({ command: z.string() }).strict().optional(), arguments: z.object({ command: z.string() }).strict().optional(),
      requestSandboxBypass: z.literal(false).optional(), requestSandboxPermissive: z.literal(false).optional(),
      managedApprovalRequired: z.literal(false).optional(), hasWriteFileRedirection: z.literal(false).optional(),
    }).passthrough().parse(JSON.parse(section));
    const allowed = new Set(["kind", "fullCommandText", "command", "args", "arguments", "toolName", "intention", "warning",
      "managedApprovalRequired", "requestSandboxBypass", "requestSandboxBypassReason", "requestSandboxPermissive",
      "canOfferSessionApproval", "commands", "commandSegments", "hasWriteFileRedirection", "possiblePaths", "possibleUrls", "commandIdentifiers"]);
    assert.ok(Object.keys(form).every((key) => allowed.has(key)), "Unknown permission details require the original terminal.");
    const commands = [form.fullCommandText, form.command, form.args?.command, form.arguments?.command].filter((value) => value !== undefined);
    assert.ok(commands.length > 0 && commands.every((value) => value === command), "The permission must contain only the exact opted-in shell command.");
  }
}

export function requireExactQuestion(input: PendingRequest, question: string): void {
  const request = PendingRequest.parse(input);
  assert.ok(request.supported && request.type === "question", "Unknown or incomplete questions require the original terminal.");
  assert.deepEqual(request.choices, ["Alpha", "Beta"], "Question choices changed.");
  // Source/message/schema display text is not reversible; never infer original fields from it.
  assert.equal(request.detail, question, "Question display cannot prove the exact opted-in message. Review it in the original terminal; acceptance is incomplete.");
  assert.equal(request.allowFreeform, false, "Unexpected freeform question semantics.");
}

export function successfulShellEvidence(events: WireEvent[], afterCursor: number, marker: string) {
  const starts = events.filter((event) => event.kind === "tool.start").filter((event) => event.cursor > afterCursor);
  if (!starts.length) return undefined;
  assert.equal(starts.length, 1, "Unexpected additional tools ran during the permission check.");
  const start = starts[0];
  assert.ok(start);
  assert.equal(start.data.name.split(/[.:]/).at(-1), "powershell", "The expected built-in shell did not run.");
  const completed = events.filter((event) => event.kind === "tool.output").find((event) =>
    event.cursor > start.cursor && event.data.toolCallId === start.data.toolCallId && event.data.complete);
  if (!completed) return undefined;
  assert.equal(completed.data.success, true, "Tool completion did not confirm successful execution.");
  assert.ok(completed.data.text.split(/\r?\n/).some((line) => line.trim() === marker), "Successful tool output did not contain the exact expected marker.");
  return completed;
}

export function cliProofRequest(proof: CliProof) {
  return async (route: string, body?: unknown, token = proof.deviceToken): Promise<unknown> => {
    if (!route.startsWith("/v1/") || route.startsWith("//") || route.includes("\\") ||
        new URL(route, proof.relayUrl).origin !== proof.relayUrl) throw new Error("Proof requests must stay on the selected local relay.");
    await control(proof, "inspect");
    const response = await authenticatedProofFetch(proof.relayUrl + route, proof.proofOwnerKey, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const result: unknown = await response.json();
    if (!response.ok) throw new Error(`Proof request failed with HTTP ${response.status}; inspect the scoped relay evidence.`);
    return result;
  };
}

export async function startCliProof(directory: string, repo = process.cwd()) {
  const root = await proofDirectory(directory, true, repo);
  await mkdir(root);
  const workspace = path.join(root, "workspace"), plugin = path.join(root, "plugin");
  await mkdir(workspace);
  await mkdir(path.join(plugin, "extensions"), { recursive: true });
  await writeFile(path.join(plugin, "plugin.json"), JSON.stringify({
    name: "devpocket-cli-proof", version: "0.1.0", extensions: "./extensions",
  }), { flag: "wx" });
  const proofOwnerKey = randomBytes(32).toString("hex");
  const relay = await startRelay({ dataDir: path.join(root, "relay"), allowInsecureLoopback: true, bind: "127.0.0.1", port: 0, proofOwnerKey });
  let server: net.Server | undefined, closing: Promise<void> | undefined;
  const sockets = new Set<net.Socket>();
  try {
    const host = provisionHost(path.join(root, "relay"), "DevPocket disposable CLI proof");
    const hostConfigPath = path.join(root, "host.local.json");
    const hostText = JSON.stringify(HostConfig.parse({
      hostId: host.hostId, token: host.token, relayUrl: relay.url, dataDir: path.join(root, "bridge"), allowInsecureLoopback: true,
      proofOwnerKey,
    }));
    await writeFile(hostConfigPath, hostText, { flag: "wx", mode: 0o600 });
    const pairingResponse = await fetch(`${relay.url}/v1/host/pairings`, {
      method: "POST", headers: { Authorization: `Bearer ${host.token}` },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!pairingResponse.ok) throw new Error("Could not create a pairing for the isolated relay controller.");
    const pairing = z.object({ code: z.string().min(1) }).parse(await pairingResponse.json());
    const response = await fetch(`${relay.url}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairing.code, name: "Disposable proof controller" }),
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Could not create the isolated relay controller.");
    const device = z.object({ token: Metadata.shape.deviceToken }).parse(await response.json());
    const runId = randomUUID();
    const proof = Metadata.parse({
      version: 2, runId, repo: path.resolve(repo), root, workspace, plugin, sessionId: randomUUID(), hostId: host.hostId,
      deviceToken: device.token, relayUrl: relay.url, hostConfigPath, proofOwnerKey,
      marker: `DP_ORIGINAL_${runId.replaceAll("-", "")}`, startedAt: Date.now(),
      directoryIdentity: await directoryIdentity(root), hostConfigHash: digest(hostText),
    });
    const proofBinding = binding(proof);
    const close = (reply?: net.Socket): Promise<void> => {
      closing ??= (async () => {
        try {
          await relay.close();
          await proofDirectory(root, false, repo);
          if (await directoryIdentity(root) !== proof.directoryIdentity) throw new Error("Proof directory changed; refusing credential cleanup.");
          for (const file of ["proof.local.json", "host.local.json"]) await rm(path.join(root, file));
          await writeFile(path.join(root, "closed.json"), JSON.stringify({ runId, status: "closed", at: new Date().toISOString() }), { flag: "wx" });
          if (reply) reply.end(JSON.stringify({ runId, relayUrl: relay.url, hostId: proof.hostId, status: "closed" }) + "\n");
        } catch (error) {
          reply?.destroy();
          throw error;
        } finally {
          for (const socket of sockets) if (socket !== reply) socket.destroy();
          const controller = server;
          if (controller) await new Promise<void>((resolve, reject) => controller.close((error) => error ? reject(error) : resolve()));
        }
      })();
      return closing;
    };
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      socket.setTimeout(15_000, () => socket.destroy());
      let text = "", received = false;
      socket.on("data", (bytes) => {
        if (received) return;
        text += bytes.toString();
        if (text.length > 2000) { received = true; socket.destroy(); return; }
        if (!text.includes("\n")) return;
        received = true;
        try {
          const input = z.object({ runId: z.literal(runId), binding: z.literal(proofBinding), command: z.enum(["inspect", "stop"]) }).strict().parse(JSON.parse(text));
          if (closing) { socket.destroy(); return; }
          if (input.command === "stop") void close(socket).catch((error: unknown) => {
            console.error("Proof cleanup failed:", error instanceof Error ? error.message : "unknown error");
            socket.destroy();
          });
          else socket.end(JSON.stringify({ runId, relayUrl: relay.url, hostId: proof.hostId, status: "ready" }) + "\n");
        } catch { socket.destroy(); }
      });
    });
    server.maxConnections = 8;
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(endpoint(runId), () => { server!.off("error", reject); resolve(); });
    });
    await writeFile(path.join(root, "proof.local.json"), JSON.stringify(proof, null, 2), { flag: "wx", mode: 0o600 });
    return { proof, close: () => close() };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await relay.close();
    throw error;
  }
}

export async function stopCliProof(directory: string): Promise<void> {
  const proof = await readCliProof(directory);
  await control(proof, "stop");
}

export function proofArguments(options: Record<string, { type: "string" | "boolean" }>) {
  const definitions: typeof options = { ...options, directory: { type: "string" }, "confirm-runtime-checks": { type: "boolean" } };
  const parsed = parseArgs({ allowPositionals: true, options: definitions });
  if (!parsed.values.directory || typeof parsed.values.directory !== "string") {
    throw new Error("Select an explicit --directory beneath this checkout's .data\\cli-proofs.");
  }
  return { ...parsed, directory: parsed.values.directory };
}

export async function lockCliCheck(proof: CliProof, name: string) {
  await readCliProof(proof.root, proof.repo);
  const file = path.join(proof.root, "checks.lock");
  const lock = await open(file, "wx", 0o600);
  const owner = JSON.stringify({ runId: proof.runId, name, id: randomUUID(), pid: process.pid, at: new Date().toISOString() });
  try { await lock.writeFile(owner); }
  catch (error) { await lock.close(); throw error; }
  return async () => {
    await lock.close();
    if (await proofFile(file) !== owner) throw new Error("Check ownership changed; refusing lock cleanup.");
    await rm(file);
  };
}

export async function beginCliCheck(proof: CliProof, name: "live-checks" | "cancellation", initial: unknown) {
  const close = await lockCliCheck(proof, name);
  const file = path.join(proof.root, `${name}.json`);
  try { await writeFile(file, JSON.stringify(initial, null, 2), { flag: "wx", mode: 0o600 }); }
  catch (error) { await close(); throw error; }
  return { close, save: async (value: unknown) => {
    if (await directoryIdentity(proof.root) !== proof.directoryIdentity) throw new Error("Proof directory changed; refusing evidence writes.");
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Proof evidence file changed.");
    await writeFile(file, JSON.stringify(value, null, 2));
  } };
}
