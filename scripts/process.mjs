import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

export function spawnOwnedCommand(file, args, {
  cwd, env = process.env, timeoutMs = 30_000, graceMs = 5000, persistent = false,
} = {}) {
  if (process.platform !== "win32") throw new Error("Owned command execution requires the Windows development executor.");
  const launcher = fileURLToPath(new URL("./owned-command.ps1", import.meta.url));
  const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", launcher],
    { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.write(JSON.stringify({ file, arguments: args, timeoutMs, graceMs, persistent }) + "\n");
  return child;
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

export function runCommand(file, args, { cwd, env = process.env, timeoutMs = 30_000, graceMs = 5000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnOwnedCommand(file, args, { cwd, env, timeoutMs, graceMs });
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
      const processTreeStopped = /DEVPOCKET_OWNERSHIP_ACTIVE/.test(stderr);
      stderr = stderr.replace(/^DEVPOCKET_(?:OWNERSHIP_ACTIVE|OWNED_TREE_STOPPED)\r?\n/gm, "");
      if (failure || code !== 0) {
        const error = failure ?? new Error(`${file} exited with ${code}.`);
        Object.assign(error, { code: failure ? failure.code : code, stdout, stderr, processTreeStopped });
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}
