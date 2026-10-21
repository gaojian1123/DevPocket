import { execFile, spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { failureDetails } from "./diagnostic-errors.mjs";

const exec = promisify(execFile);
const ownedProcesses = new WeakMap();
const cleanedCommands = new WeakMap();
const inheritedDarwinScope = process.platform === "darwin" ? process.env.DEVPOCKET_DARWIN_SCOPE : undefined;
const commandBoundary = new AsyncLocalStorage();

export function withCommandBoundary(boundary, operation) {
  if (typeof boundary !== "function" || typeof operation !== "function") {
    throw new TypeError("A command boundary and operation are required.");
  }
  if (commandBoundary.getStore()) throw new Error("A command boundary cannot be replaced while it is active.");
  return commandBoundary.run(boundary, operation);
}

const commandIdentity = (file, args, cwd) => JSON.stringify({ file, args, cwd: path.resolve(cwd ?? process.cwd()) });

export function commandCleanupConfirmed(outcome, { file, args, cwd }) {
  return outcome !== null && typeof outcome === "object" &&
    cleanedCommands.get(outcome) === commandIdentity(file, args, cwd);
}

function ownedTargetStderr(bytes, receiptId) {
  const frames = ["active", "tree-stopped", "cancel-accepted", "deadline-expired", "preparation-wait"]
    .map((phase) => Buffer.from(`\u001eDEVPOCKET:${receiptId}:${phase}\u001f`));
  const parts = [];
  let retainedFrom = 0, searchFrom = 0;
  for (let start; (start = bytes.indexOf(0x1e, searchFrom)) !== -1;) {
    const frame = frames.find((candidate) => bytes.subarray(start, start + candidate.length).equals(candidate));
    if (frame) {
      parts.push(bytes.subarray(retainedFrom, start));
      retainedFrom = start + frame.length;
      searchFrom = retainedFrom;
    } else searchFrom = start + 1;
  }
  parts.push(bytes.subarray(retainedFrom));
  // Control frames may interrupt a multibyte character, so concatenate target bytes before decoding.
  return Buffer.concat(parts).toString("utf8");
}

export function ownedCommandLaunch(platform = process.platform, privileged = false, env = process.env) {
  if (!["win32", "linux", "darwin"].includes(platform)) throw new Error("Owned command execution requires Windows, Linux or macOS.");
  if (privileged && (platform !== "linux" || env.GITHUB_ACTIONS !== "true" ||
      env.RUNNER_ENVIRONMENT !== "github-hosted")) {
    throw new Error("Privileged command ownership requires the configured hosted Linux job.");
  }
  if (platform === "darwin") {
    return { file: "python3", args: ["-B", fileURLToPath(new URL("./owned-command-darwin.py", import.meta.url))] };
  }
  const linux = platform === "linux";
  const launcher = fileURLToPath(new URL(linux ? "./owned-command-linux.py" : "./owned-command-windows.mjs", import.meta.url));
  if (privileged) return { file: "sudo", args: ["-n", "python3", "-u", launcher] };
  return linux ? { file: "python3", args: ["-u", launcher] }
    : { file: process.execPath, args: [launcher] };
}

export function spawnOwnedCommand(file, args, {
  cwd, env = process.env, timeoutMs = 30_000, graceMs = 5000, persistent = false, privileged = false, nativeLifecycle = false,
  deadlineUnixMs = Date.now() + timeoutMs, cancelled = false,
} = {}) {
  if (nativeLifecycle && (process.platform !== "linux" || privileged)) {
    throw new Error("Native lifecycle pipes require an ordinary Linux command owner.");
  }
  const launch = ownedCommandLaunch(process.platform, privileged, env);
  const receiptId = randomUUID();
  const supervisorEnvironment = process.platform === "darwin" ? { ...env } : env;
  if (process.platform === "darwin") {
    if (inheritedDarwinScope === undefined) delete supervisorEnvironment.DEVPOCKET_DARWIN_SCOPE;
    else supervisorEnvironment.DEVPOCKET_DARWIN_SCOPE = inheritedDarwinScope;
  }
  const child = spawn(launch.file, launch.args,
    { cwd, env: supervisorEnvironment, windowsHide: true,
      stdio: nativeLifecycle ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"] });
  const state = { tail: "", receiptId, graceMs, confirmed: false };
  ownedProcesses.set(child, state);
  child.stderr.on("data", (bytes) => { state.tail = (state.tail + bytes.toString()).slice(-4096); });
  state.done = new Promise((resolve) => child.once("close", () => {
    state.confirmed = ["win32", "darwin"].includes(process.platform)
      ? state.tail.endsWith(`\u001eDEVPOCKET:${receiptId}:tree-stopped\u001f`)
      : state.tail.trimEnd().split(/\r?\n/).at(-1) === "DEVPOCKET_OWNED_TREE_STOPPED";
    resolve();
  }));
  child.stdin.write(JSON.stringify({ file, arguments: args, timeoutMs, graceMs, persistent, nativeLifecycle,
    ownerPid: process.pid, deadlineUnixMs, cancelled, receiptId }) + "\n");
  return child;
}

export function ownedProcessCleanupConfirmed(child) {
  return ownedProcesses.get(child)?.confirmed === true;
}

export async function ownerProcessFamilyAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process-family owner.");
  if (process.platform === "darwin") {
    const result = await exec("python3", ["-B", fileURLToPath(new URL("./owned-command-darwin.py", import.meta.url)),
      "--family", String(pid)], { timeout: 20_000 });
    const status = result.stdout.trim();
    if (!["alive", "unknown"].includes(status)) throw new Error("macOS process-family liveness is unavailable.");
    return true; // Both live and unconfirmed families retain their emulator lease.
  }
  const result = await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; $items=@(Get-CimInstance Win32_Process -Filter "ProcessId=${pid} OR ParentProcessId=${pid}"); ` +
    `if($items.Count) { 'alive' } else { 'exited' }`], { timeout: 20_000, windowsHide: true });
  const status = result.stdout.trim();
  if (!["alive", "exited"].includes(status)) throw new Error("Process-family liveness is unavailable; retaining the emulator lease.");
  return status === "alive";
}

export async function stopOwnedProcess(child, { force = false } = {}) {
  const owned = ["win32", "darwin"].includes(process.platform) ? ownedProcesses.get(child) : undefined;
  if (owned) {
    if (child.exitCode === null && child.signalCode === null) {
      if (force) child.kill();
      else if (!child.stdin.destroyed) child.stdin.write("cancel\n");
      let timer;
      try {
        await Promise.race([owned.done, new Promise((resolve) => {
          timer = setTimeout(() => { child.kill(); resolve(); }, force ? 1000 : owned.graceMs + 1000);
        })]);
      } finally { clearTimeout(timer); }
    }
    let closeTimer;
    try {
      await Promise.race([owned.done, new Promise((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error("Owned supervisor did not close after termination.")),
          process.platform === "darwin" ? 20000 : 10000);
      })]);
    } finally { clearTimeout(closeTimer); }
    if (!owned.confirmed) throw Object.assign(new Error("Owned process-tree cleanup was not confirmed."),
      { diagnosticCode: "cleanup-failed" });
    return;
  }
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const pid = Number(child.pid);
    await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop'; function Stop-OwnedTree([int]$ownerId) { ` +
      `$children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ownerId"); ` +
      `foreach ($item in $children) { Stop-OwnedTree $item.ProcessId }; ` +
      `if (Get-Process -Id $ownerId -ErrorAction SilentlyContinue) { Stop-Process -Id $ownerId -Force } }; ` +
      `Stop-OwnedTree ${pid}`], { timeout: 20_000, windowsHide: true });
  } else {
    if (process.platform !== "darwin") { child.kill("SIGTERM"); return; }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.off("close", closed); reject(new Error("The macOS child did not close.")); }, 20000);
      const closed = () => { clearTimeout(timer); resolve(); };
      child.once("close", closed);
      child.kill("SIGTERM");
    });
  }
}

export function runCommand(file, args, options = {}) {
  const boundary = commandBoundary.getStore();
  if (boundary) return commandBoundary.run(undefined, () => boundary(file, args, options, runCommand));
  return runOwnedCommand(file, args, options);
}

function runOwnedCommand(file, args, {
  cwd, env = process.env, timeoutMs = 30_000, graceMs = 5000, signal, privileged = false,
} = {}) {
  const deadlineUnixMs = Date.now() + timeoutMs;
  const identity = commandIdentity(file, args, cwd);
  return new Promise((resolve, reject) => {
    const child = spawnOwnedCommand(file, args, { cwd, env, timeoutMs, graceMs, privileged,
      deadlineUnixMs, cancelled: signal?.aborted ?? false });
    let stdout = "", stderr = "", failure, failureReason, cleanupFailure, stopping = false, hardStop, capturedBytes = 0;
    let outputTruncated = false;
    const stdoutDecoder = new StringDecoder("utf8"), stderrChunks = [];
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") { failure ??= error; failureReason ??= "io"; }
    });
    const stop = (error, reason) => {
      if (stopping) return;
      stopping = true;
      failure ??= error;
      failureReason ??= reason;
      if (!child.stdin.destroyed) child.stdin.write("cancel\n");
      hardStop = setTimeout(() => {
        void stopOwnedProcess(child, { force: true }).catch((cleanupError) => {
          cleanupFailure = cleanupError;
        });
      }, graceMs + 1000);
    };
    const timer = setTimeout(() => stop(new Error("Command timed out; its owned process tree was stopped."), "timeout"),
      Math.max(0, deadlineUnixMs - Date.now()));
    const abort = () => stop(new Error("Command cancelled."), "cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const capture = (chunk, target) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const retained = bytes.subarray(0, Math.max(0, 16 * 1024 * 1024 - capturedBytes));
      capturedBytes += retained.length;
      if (target === "stdout") stdout += stdoutDecoder.write(retained);
      else stderrChunks.push(Buffer.from(retained));
      if (retained.length !== bytes.length) {
        outputTruncated = true;
        stop(new Error("Command output exceeded the private diagnostic budget."), "output-limit");
      }
    };
    child.stdout.on("data", (chunk) => capture(chunk, "stdout"));
    child.stderr.on("data", (chunk) => capture(chunk, "stderr"));
    child.once("error", (error) => { failure ??= error; failureReason ??= "spawn"; });
    child.once("close", (code, signalCode) => {
      clearTimeout(timer);
      clearTimeout(hardStop);
      signal?.removeEventListener("abort", abort);
      stdout += stdoutDecoder.end();
      const stderrBytes = Buffer.concat(stderrChunks);
      const processTreeStopped = ownedProcessCleanupConfirmed(child);
      if (["win32", "darwin"].includes(process.platform)) {
        const receiptId = ownedProcesses.get(child).receiptId;
        stderr = ownedTargetStderr(stderrBytes, receiptId);
      } else stderr = stderrBytes.toString("utf8").replace(/^DEVPOCKET_(?:OWNERSHIP_ACTIVE|OWNED_TREE_STOPPED)\r?\n/gm, "");
      if (!failure && Date.now() >= deadlineUnixMs) {
        failure = new Error("Command exceeded its total wall-clock deadline.");
        failureReason = "timeout";
      }
      if (!processTreeStopped) {
        cleanupFailure ??= Object.assign(new Error("Owned command exited without confirming process-tree cleanup."),
          { diagnosticCode: "cleanup-failed" });
        if (!failure && code === 0) { failure = cleanupFailure; failureReason = "exit"; }
      }
      const commandOutcome = {
        observedProcess: "owned-command-supervisor", reason: failureReason ?? (signalCode ? "signal" : "exit"),
        exitCode: code, signal: signalCode, outputTruncated, capturedBytes,
        cleanupFailure: cleanupFailure ? failureDetails(cleanupFailure, "cleanup-failed") : null,
      };
      if (failure || code !== 0) {
        const error = failure ?? new Error(`${file} exited with ${code}.`);
        Object.assign(error, { code: failure ? failure.code : code, stdout, stderr, processTreeStopped, commandOutcome });
        if (processTreeStopped && !cleanupFailure) cleanedCommands.set(error, identity);
        reject(error);
      } else {
        const result = { stdout, stderr, processTreeStopped, commandOutcome };
        if (processTreeStopped && !cleanupFailure) cleanedCommands.set(result, identity);
        resolve(result);
      }
    });
  });
}
