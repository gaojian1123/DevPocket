import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

export function ownedCommandLaunch(platform = process.platform, privileged = false, env = process.env) {
  if (!["win32", "linux"].includes(platform)) throw new Error("Owned command execution requires Windows or Linux.");
  if (privileged && (platform !== "linux" || env.GITHUB_ACTIONS !== "true" ||
      env.RUNNER_ENVIRONMENT !== "github-hosted")) {
    throw new Error("Privileged command ownership requires the configured hosted Linux job.");
  }
  const linux = platform === "linux";
  const launcher = fileURLToPath(new URL(linux ? "./owned-command-linux.py" : "./owned-command.ps1", import.meta.url));
  if (privileged) return { file: "sudo", args: ["-n", "python3", "-u", launcher] };
  return linux ? { file: "python3", args: ["-u", launcher] }
    : { file: "pwsh", args: ["-NoProfile", "-NonInteractive", "-File", launcher] };
}

export function spawnOwnedCommand(file, args, {
  cwd, env = process.env, timeoutMs = 30_000, graceMs = 5000, persistent = false, privileged = false, nativeLifecycle = false,
} = {}) {
  if (nativeLifecycle && (process.platform !== "linux" || privileged)) {
    throw new Error("Native lifecycle pipes require an ordinary Linux command owner.");
  }
  const launch = ownedCommandLaunch(process.platform, privileged, env);
  const child = spawn(launch.file, launch.args,
    { cwd, env, windowsHide: true, stdio: nativeLifecycle ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"] });
  child.stdin.write(JSON.stringify({ file, arguments: args, timeoutMs, graceMs, persistent, nativeLifecycle, ownerPid: process.pid }) + "\n");
  return child;
}

export async function ownerProcessFamilyAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process-family owner.");
  const result = await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; $items=@(Get-CimInstance Win32_Process -Filter "ProcessId=${pid} OR ParentProcessId=${pid}"); ` +
    `if($items.Count) { 'alive' } else { 'exited' }`], { timeout: 20_000, windowsHide: true });
  const status = result.stdout.trim();
  if (!["alive", "exited"].includes(status)) throw new Error("Process-family liveness is unavailable; retaining the emulator lease.");
  return status === "alive";
}

export async function stopOwnedProcess(child) {
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
    child.kill("SIGTERM");
  }
}

export function runCommand(file, args, {
  cwd, env = process.env, timeoutMs = 30_000, graceMs = 5000, signal, privileged = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnOwnedCommand(file, args, { cwd, env, timeoutMs, graceMs, privileged });
    let stdout = "", stderr = "", failure, stopping = false, hardStop;
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") failure = error; });
    const stop = (error) => {
      if (stopping) return;
      stopping = true;
      failure = error;
      if (!child.stdin.destroyed) child.stdin.write("cancel\n");
      hardStop = setTimeout(() => {
        void stopOwnedProcess(child).catch((cleanupError) => {
          failure = new Error(`Owned process cleanup failed: ${cleanupError.message}`);
        });
      }, graceMs + 1000);
    };
    const timer = setTimeout(() => stop(new Error("Command timed out; its owned process tree was stopped.")), timeoutMs);
    const abort = () => stop(new Error("Command cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const capture = (chunk, target) => {
      if (stdout.length + stderr.length > 16 * 1024 * 1024) {
        stop(new Error("Command output exceeded the private diagnostic budget."));
      } else if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (chunk) => capture(chunk, "stdout"));
    child.stderr.on("data", (chunk) => capture(chunk, "stderr"));
    child.once("error", (error) => { failure = error; });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(hardStop);
      signal?.removeEventListener("abort", abort);
      const processTreeStopped = (process.platform === "linux"
        ? /DEVPOCKET_OWNED_TREE_STOPPED/ : /DEVPOCKET_OWNERSHIP_ACTIVE/).test(stderr);
      stderr = stderr.replace(/^DEVPOCKET_(?:OWNERSHIP_ACTIVE|OWNED_TREE_STOPPED)\r?\n/gm, "");
      if (failure || code !== 0) {
        const error = failure ?? new Error(`${file} exited with ${code}.`);
        Object.assign(error, { code: failure ? failure.code : code, stdout, stderr, processTreeStopped });
        reject(error);
      } else resolve({ stdout, stderr, processTreeStopped });
    });
  });
}
