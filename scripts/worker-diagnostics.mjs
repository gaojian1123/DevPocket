import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { projectNativeLifecycle } from "./native-lifecycle.mjs";

const stderrBudget = 32768;
const roles = ["adb", "emulator"];
const signals = ["SIGABRT", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE",
  "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGTRAP"];
const categories = ["runtime-library", "acceleration-unavailable", "unsupported-option", "graphics-initialization",
  "port-conflict", "avd-configuration", "disk-space", "memory-exhaustion", "process-crash", "process-signalled", "unknown"];
const contexts = ["unexpected", "during-cleanup", "during-cancellation", "unknown"];
const exitCode = (value) => Number.isInteger(value) && value >= -2147483648 && value <= 4294967295 ? value : "unknown";

function category(text, signal) {
  for (const [pattern, name] of [
    [/error while loading shared libraries|cannot open shared object file/i, "runtime-library"],
    [/(?:KVM|WHPX|acceleration).*(?:not available|not usable|unavailable|permission denied)|failed to initialize.*(?:KVM|WHPX)/i, "acceleration-unavailable"],
    [/unknown option|unrecognized option|invalid option|unknown argument/i, "unsupported-option"],
    [/could not connect to display|could not.*Qt platform|Qt platform plugin.*(?:failed|could not)|failed to initialize.*(?:Vulkan|OpenGL)|eglInitialize.*failed/i, "graphics-initialization"],
    [/address already in use|EADDRINUSE/i, "port-conflict"],
    [/unknown AVD name|cannot find AVD system path|PANIC:.*(?:AVD|system path)/i, "avd-configuration"],
    [/not enough disk space|not enough space to create userdata partition|insufficient disk space|no space left on device|ENOSPC/i, "disk-space"],
    [/out of memory|ENOMEM|bad_alloc/i, "memory-exhaustion"],
    [/segmentation fault|core dumped|fatal signal/i, "process-crash"],
  ]) if (pattern.test(text)) return name;
  if (["SIGABRT", "SIGBUS", "SIGFPE", "SIGILL", "SIGSEGV", "SIGTRAP"].includes(signal)) return "process-crash";
  return signals.includes(signal) ? "process-signalled" : "unknown";
}

function projectUserdataCapacity(value) {
  const valid = (number) => Number.isFinite(number) && number >= 0 && number < 1_000_000_000;
  if (!["stdout", "stderr"].includes(value?.source) || value?.unit !== "MiB" ||
      !valid(value.available) || !valid(value.required) || value.required <= value.available) return "unknown";
  return { source: value.source, unit: "MiB", available: value.available, required: value.required };
}

function userdataCapacity(outputs) {
  let observed;
  const marker = "Not enough space to create userdata partition";
  for (const [source, text] of outputs) {
    for (const line of text.split("\n")) {
      if (!line.includes(marker)) continue;
      if (line.indexOf(marker) !== line.lastIndexOf(marker)) return "unknown";
      const match = line.match(/Not enough space to create userdata partition\. Available: (\d{1,9}(?:\.\d{1,6})?) MB at [^\r\n]{1,4096}, need (\d{1,9}(?:\.\d{1,6})?) MB\.\r?$/);
      if (!match) return "unknown";
      const value = projectUserdataCapacity({ source, unit: "MiB", available: Number(match[1]), required: Number(match[2]) });
      if (value === "unknown" || observed && (observed.source !== value.source ||
          observed.available !== value.available || observed.required !== value.required)) return "unknown";
      observed = value;
    }
  }
  return observed ?? "unknown";
}

function boundedOutput() {
  let head = Buffer.alloc(0), tail = Buffer.alloc(0), seen = 0;
  return {
    add: (value) => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      seen += bytes.length;
      const half = stderrBudget / 2;
      if (head.length < half) head = Buffer.concat([head, bytes.subarray(0, half - head.length)]);
      tail = Buffer.concat([tail, bytes.subarray(Math.max(0, bytes.length - half))]).subarray(-half);
    },
    snapshot: () => {
      const remaining = Math.min(Math.max(0, seen - head.length), tail.length);
      return {
        text: head.toString("utf8") + (seen > stderrBudget ? "\n" : "") +
          (remaining ? tail.subarray(tail.length - remaining).toString("utf8") : ""),
        bytes: Math.min(seen, stderrBudget), truncated: seen > stderrBudget,
      };
    },
  };
}

export function createWorkerObservation(role, callerSignal, nativeCapture) {
  const stderr = boundedOutput(), stdout = boundedOutput();
  let cleanupRequested = false, observed;
  return {
    stderr: stderr.add,
    stdout: stdout.add,
    markCleanup: () => { cleanupRequested = true; },
    exit: (code, signal) => {
      if (observed) return;
      observed = {
        context: callerSignal?.aborted ? "during-cancellation" : cleanupRequested ? "during-cleanup" : "unexpected",
        exitCode: exitCode(code),
        signal: signals.includes(signal) ? signal : signal === null && exitCode(code) !== "unknown" ? "none" : "unknown",
      };
    },
    snapshot: () => {
      const errorOutput = stderr.snapshot(), normalOutput = stdout.snapshot();
      const clean = (text) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
      const stderrText = clean(errorOutput.text), stdoutText = clean(normalOutput.text);
      const stderrCategory = category(stderrText, "unknown"), stdoutCategory = category(stdoutText, "unknown");
      const hint = [["stderr", stderrCategory], ["stdout", stdoutCategory],
        ["supervisor-signal", category("", observed?.signal)]].find(([, value]) => value !== "unknown");
      return {
        role: roles.includes(role) ? role : "unknown",
        observedProcess: "owned-command-supervisor",
        observation: observed ? "exit" : "not-observed",
        context: observed?.context ?? "unknown",
        exitCode: observed?.exitCode ?? "unknown",
        signal: observed?.signal ?? "unknown",
        failureCategory: observed?.context === "unexpected"
          ? hint?.[1] ?? "unknown"
          : observed ? "not-applicable" : "unknown",
        failureCategorySource: observed?.context === "unexpected" ? hint?.[0] ?? "unknown" : observed ? "not-applicable" : "unknown",
        stderrFailureCategory: stderrCategory,
        stdoutFailureCategory: stdoutCategory,
        stderrSampledBytes: errorOutput.bytes,
        stderrTruncated: errorOutput.truncated,
        stdoutSampledBytes: normalOutput.bytes,
        stdoutTruncated: normalOutput.truncated,
        userdataCapacity: role === "emulator" ? userdataCapacity([["stderr", stderrText], ["stdout", stdoutText]]) : "unknown",
        nativeLifecycle: projectNativeLifecycle(nativeCapture?.snapshot()),
      };
    },
  };
}

export function projectWorkerDiagnostics(value, expectedRunId) {
  if (expectedRunId && value?.runId !== expectedRunId) value = { runId: expectedRunId };
  const input = Array.isArray(value?.workers) ? value.workers.slice(0, 2) : [];
  const workers = [];
  for (const role of roles) {
    const matches = input.filter((item) => item?.role === role);
    if (matches.length !== 1) continue;
    const item = matches[0], observed = item.observation === "exit";
    const code = observed ? exitCode(item.exitCode) : "unknown";
    const context = observed && contexts.includes(item.context) ? item.context : "unknown";
    workers.push({
      role, observedProcess: "owned-command-supervisor", observation: observed ? "exit" : "not-observed",
      context, exitCode: code,
      signal: observed && signals.includes(item.signal) ? item.signal
        : observed && item.signal === "none" && code !== "unknown" ? "none" : "unknown",
      failureCategory: context === "unexpected" ? categories.includes(item.failureCategory) ? item.failureCategory : "unknown"
        : observed && context !== "unknown" ? "not-applicable" : "unknown",
      failureCategorySource: ["stdout", "stderr", "supervisor-signal", "not-applicable"].includes(item.failureCategorySource)
        ? item.failureCategorySource : "unknown",
      stdoutFailureCategory: categories.includes(item.stdoutFailureCategory) ? item.stdoutFailureCategory : "unknown",
      stderrFailureCategory: categories.includes(item.stderrFailureCategory) ? item.stderrFailureCategory : "unknown",
      stderrSampledBytes: Number.isInteger(item.stderrSampledBytes) && item.stderrSampledBytes >= 0 &&
        item.stderrSampledBytes <= stderrBudget ? item.stderrSampledBytes : "unknown",
      stderrTruncated: typeof item.stderrTruncated === "boolean" ? item.stderrTruncated : "unknown",
      stdoutSampledBytes: Number.isInteger(item.stdoutSampledBytes) && item.stdoutSampledBytes >= 0 &&
        item.stdoutSampledBytes <= stderrBudget ? item.stdoutSampledBytes : "unknown",
      stdoutTruncated: typeof item.stdoutTruncated === "boolean" ? item.stdoutTruncated : "unknown",
      userdataCapacity: role === "emulator" ? projectUserdataCapacity(item.userdataCapacity) : "unknown",
      nativeLifecycle: projectNativeLifecycle(item.nativeLifecycle),
      workerLog: {
        status: ["retained", "unavailable", "pending"].includes(item.workerLog?.status) ? item.workerLog.status : "unknown",
        truncated: typeof item.workerLog?.truncated === "boolean" ? item.workerLog.truncated : "unknown",
        retainedBytes: Number.isInteger(item.workerLog?.retainedBytes) && item.workerLog.retainedBytes >= 0 &&
          item.workerLog.retainedBytes <= 1024 * 1024 ? item.workerLog.retainedBytes : "unknown",
      },
    });
  }
  return {
    version: 1,
    runId: typeof value?.runId === "string" && /^[a-f0-9-]{36}$/.test(value.runId) ? value.runId : "unknown",
    availability: workers.some((worker) => worker.observation === "exit") ? "observed" : "unknown",
    cleanup: ["completed", "failed"].includes(value?.cleanup) ? value.cleanup : "unknown",
    workers,
    unobservedRoles: roles.filter((role) => !workers.some((worker) => worker.role === role && worker.observation === "exit")),
  };
}

async function readReport(file) {
  let info;
  try { info = await lstat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new Error("Unsupported diagnostic input.");
  const input = await open(file, "r");
  try {
    const current = await input.stat();
    if (current.ino !== info.ino || current.dev !== info.dev || current.size > 512 * 1024) throw new Error("Diagnostic input changed.");
    const bytes = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await input.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } finally { await input.close(); }
}

async function main() {
  const { values } = parseArgs({ options: { directory: { type: "string", default: path.join(".data", "ci", "device") } } });
  const root = process.cwd(), directory = path.resolve(root, values.directory), relative = path.relative(root, directory);
  if (!["ci", "verification"].some((name) => relative.startsWith(path.join(".data", name) + path.sep))) {
    throw new Error("Worker diagnostics require an isolated CI or verification directory.");
  }
  let parent = root;
  for (const part of relative.split(path.sep)) {
    parent = path.join(parent, part);
    try { await mkdir(parent); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Linked diagnostic directories are not supported.");
  }
  const report = await readReport(path.join(directory, "report.json"));
  const check = Array.isArray(report?.checks) ? report.checks.find((item) => item?.id === "android-device") : undefined;
  const projected = projectWorkerDiagnostics(check?.workerDiagnostics);
  const source = typeof report?.source?.head === "string" && /^[a-f0-9]{40}$/.test(report.source.head) &&
    typeof report?.source?.fingerprint === "string" && /^[a-f0-9]{64}$/.test(report.source.fingerprint)
    ? { head: report.source.head, fingerprint: report.source.fingerprint } : null;
  const output = {
    kind: "owned-worker-diagnostics", ...projected,
    availability: report === null ? "missing" : projected.availability,
    source,
    base: typeof report?.base === "string" && /^[a-f0-9]{40}$/.test(report.base) ? report.base : "unknown",
    verificationStatus: ["passed", "partial", "failed", "blocked", "planned"].includes(report?.status) ? report.status : "unknown",
    note: "Diagnostic metadata only, not verification evidence. Exit values identify the observed supervisor, not an unobserved native descendant.",
  };
  const bytes = JSON.stringify(output, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > 8192) throw new Error("Worker diagnostics exceeded their public budget.");
  const file = await open(path.join(directory, "worker-diagnostics.json"), "wx", 0o600);
  try { await file.writeFile(bytes); }
  finally { await file.close(); }
  process.stdout.write(bytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch {
    console.error("Worker diagnostic export refused or failed; no raw worker logs were published.");
    process.exitCode = 1;
  }
}
