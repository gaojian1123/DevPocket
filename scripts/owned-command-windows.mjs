import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cancellation = new AbortController();
let request, child, timer, buffer = "", received = 0, stopping = false, started = false, requestReceived = false;
let preparationCleanupConfirmed = true, scratchCleanupConfirmed = true, requestValidated = false;
let stopReason, inputFailure;
function control(phase) {
  process.stderr.write(`\u001eDEVPOCKET:${request.receiptId}:${phase}\u001f`);
}
function stop(reason = "cancelled") {
  if (stopping) return;
  stopping = true;
  stopReason = reason;
  cancellation.abort();
  if (child && !child.stdin.destroyed) child.stdin.write("cancel\n");
}
function rejectInput(message) {
  if (!inputFailure) {
    inputFailure = new Error(message);
    console.error(inputFailure.message);
  }
  process.exitCode = 1;
  stop("invalid-input");
}
async function ordinary(file, directory = false, maximum = 2097152) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.size > maximum)) {
    throw new Error("Invalid or linked Windows ownership helper artifact.");
  }
}
function checkDeadline() {
  if (Date.now() >= request.deadlineUnixMs) stop("timeout");
  cancellation.signal.throwIfAborted();
}
async function ownedStaging(directory, identity) {
  const current = await lstat(directory, { bigint: true });
  if (!identity || !current.isDirectory() || current.isSymbolicLink() ||
      ["dev", "ino", "birthtimeNs"].some((key) => current[key] !== identity[key])) {
    throw new Error("Ownership staging directory changed; it was preserved.");
  }
}
async function publish(temporary, directory, identity) {
  for (let attempt = 0; ; attempt++) {
    checkDeadline();
    await ownedStaging(temporary, identity);
    let present = true;
    try { await lstat(directory); }
    catch (error) { if (error.code !== "ENOENT") throw error; present = false; }
    if (present) throw new Error("Ownership publication destination appeared; it was not overwritten.");
    checkDeadline();
    try { await rename(temporary, directory); return; }
    catch (error) {
      if (!["EPERM", "EBUSY"].includes(error.code) || attempt === 3) throw error;
      await delay(100, undefined, { signal: cancellation.signal });
    }
  }
}
async function cacheLock(directory, operation) {
  const pipe = `\\\\.\\pipe\\DevPocketNativeOwner_${digest(directory.toLowerCase())}`;
  let waiting = false;
  while (true) {
    checkDeadline();
    const server = net.createServer((socket) => socket.destroy());
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(pipe, resolve); });
    } catch (error) {
      server.close();
      if (error.code !== "EADDRINUSE") throw error;
      if (!waiting) { control("preparation-wait"); waiting = true; }
      await delay(20, undefined, { signal: cancellation.signal });
      continue;
    }
    try { return await operation(); }
    finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  }
}
async function compile(compiler, source, output) {
  checkDeadline();
  const receiptId = randomUUID();
  child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(scripts, "owned-command.ps1")],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  preparationCleanupConfirmed = false;
  let diagnostic = "", outputBytes = 0, spawnError, controlTail = "";
  const collect = (bytes) => {
    outputBytes += bytes.length;
    if (outputBytes <= 1048576) diagnostic += bytes.toString();
    else stop();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", (bytes) => {
    controlTail = (controlTail + bytes.toString()).slice(-4096);
    collect(bytes);
  });
  child.once("error", (error) => { spawnError = error; });
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") { spawnError = error; stop(); } });
  const done = new Promise((resolve) => child.once("close", resolve));
  child.stdin.write(JSON.stringify({
    file: compiler, arguments: ["/nologo", "/target:exe", "/optimize+", "/platform:x64", "/define:NETFRAMEWORK",
      "/reference:System.Runtime.Serialization.dll", `/out:${output}`, source],
    timeoutMs: request.timeoutMs, graceMs: request.graceMs, deadlineUnixMs: request.deadlineUnixMs,
    ownerPid: process.pid, receiptId,
  }) + "\n");
  const code = await done;
  child = undefined;
  if (spawnError) throw spawnError;
  preparationCleanupConfirmed = controlTail.endsWith(`\u001eDEVPOCKET:${receiptId}:tree-stopped\u001f`);
  if (stopping && preparationCleanupConfirmed && [124, 130].includes(code)) cancellation.signal.throwIfAborted();
  if (code !== 0 || !preparationCleanupConfirmed) {
    throw new Error(`Windows ownership helper preparation failed (${code}).\n${diagnostic}`);
  }
  checkDeadline();
}
async function helper() {
  const sourcePath = path.join(scripts, "owned-command.cs");
  await ordinary(sourcePath, false, 131072);
  const source = await readFile(sourcePath), sourceHash = digest(source);
  const framework = path.join(process.env.SystemRoot ?? process.env.WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319");
  const compiler = path.join(framework, "csc.exe");
  const inputs = ["csc.exe", "csc.exe.config", "csc.rsp", "clr.dll", "mscorlib.dll", "System.Runtime.Serialization.dll"];
  const identity = [];
  for (const name of inputs) {
    const file = path.join(framework, name);
    await ordinary(file, false, 32 * 1024 * 1024);
    identity.push([file, digest(await readFile(file))]);
    checkDeadline();
  }
  const toolchain = digest(JSON.stringify(identity));
  const key = digest(`${sourceHash}\n${toolchain}`);
  const tools = path.join(scripts, "..", ".tools"), cache = path.join(tools, "command-owner-native-v1");
  for (const directory of [tools, cache]) { await mkdir(directory, { recursive: true }); await ordinary(directory, true); }
  const directory = path.join(cache, key);
  return cacheLock(directory, async () => {
    let exists = true;
    try { await ordinary(directory, true); }
    catch (error) { if (error.code !== "ENOENT") throw error; exists = false; }
    if (!exists) {
      const temporary = path.join(cache, `prepare-${randomUUID()}`);
      await mkdir(temporary);
      scratchCleanupConfirmed = false;
      let identity;
      try {
        identity = await lstat(temporary, { bigint: true });
        await ownedStaging(temporary, identity);
        const assembly = path.join(temporary, "owner.exe");
        await compile(compiler, sourcePath, assembly);
        if (digest(await readFile(sourcePath)) !== sourceHash) throw new Error("Ownership source changed during preparation.");
        await ordinary(assembly);
        await writeFile(path.join(temporary, "manifest.json"), JSON.stringify({
          version: 1, source: sourceHash, toolchain, assembly: digest(await readFile(assembly)),
        }), { flag: "wx" });
        checkDeadline();
        await publish(temporary, directory, identity);
        scratchCleanupConfirmed = true;
      } catch (error) {
        try {
          await ownedStaging(temporary, identity);
          for (const name of ["owner.exe", "manifest.json"]) await rm(path.join(temporary, name), { force: true });
          await rmdir(temporary);
          scratchCleanupConfirmed = true;
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Ownership preparation and its scratch cleanup failed.");
        }
        throw error;
      }
    }
    const manifestPath = path.join(directory, "manifest.json"), assembly = path.join(directory, "owner.exe");
    await ordinary(manifestPath, false, 4096);
    await ordinary(assembly);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.version !== 1 || manifest.source !== sourceHash || manifest.toolchain !== toolchain ||
        manifest.assembly !== digest(await readFile(assembly))) throw new Error("Windows owner artifact is not source/toolchain-bound.");
    if (digest(await readFile(sourcePath)) !== sourceHash) throw new Error("Ownership source changed before startup.");
    checkDeadline();
    return assembly;
  });
}
async function main(value) {
  request = JSON.parse(value);
  if (process.platform !== "win32" || typeof request.file !== "string" || !Array.isArray(request.arguments) ||
      !request.arguments.every((arg) => typeof arg === "string") || !Number.isSafeInteger(request.deadlineUnixMs) ||
      !Number.isSafeInteger(request.ownerPid) || request.ownerPid <= 0 ||
      !Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 86400000 ||
      !Number.isInteger(request.graceMs) || request.graceMs < 0 || request.graceMs > 60000 ||
      !/^[a-f0-9-]{36}$/.test(request.receiptId)) {
    throw new Error("Invalid Windows owned-command request.");
  }
  requestValidated = true;
  timer = setTimeout(() => stop("timeout"), Math.max(0, request.deadlineUnixMs - Date.now()));
  if (request.cancelled) stop();
  try {
    const executable = await helper();
    checkDeadline();
    child = spawn(executable, [], { windowsHide: true, stdio: ["pipe", "inherit", "inherit"] });
    started = true;
    let spawnError;
    child.once("error", (error) => { spawnError = error; });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") { spawnError = error; stop(); } });
    const code = await new Promise((resolve) => {
      child.once("close", resolve);
      child.stdin.write(JSON.stringify({ ...request, bootstrapPid: process.pid }) + "\n");
    });
    if (spawnError) throw spawnError;
    if (inputFailure) process.exitCode = 1;
    else process.exitCode = code === 0 && stopping ? (stopReason === "timeout" ? 124 : 130) : code ?? 1;
  } finally { clearTimeout(timer); }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (text) => {
  received += Buffer.byteLength(text);
  if (received > 1048576) {
    rejectInput("Owned-command input exceeded its bound.");
    process.stdin.destroy(); return;
  }
  buffer += text;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!requestReceived) {
      requestReceived = true;
      void main(line).catch((error) => {
        if ((error === cancellation.signal.reason || error.cause === cancellation.signal.reason) &&
            stopping && !started && preparationCleanupConfirmed && scratchCleanupConfirmed) {
          process.exitCode = inputFailure ? 1 : stopReason === "timeout" ? 124 : 130;
          if (!inputFailure) control(process.exitCode === 124 ? "deadline-expired" : "cancel-accepted");
          control("tree-stopped");
        } else {
          console.error(error); process.exitCode = 1;
          if (requestValidated && !started && preparationCleanupConfirmed && scratchCleanupConfirmed) control("tree-stopped");
        }
      }).finally(() => { clearTimeout(timer); process.stdin.destroy(); });
    } else if (line.trim() === "cancel") stop();
    else rejectInput("Unsupported owned-command control message.");
  }
});
process.stdin.once("end", stop);
