import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const inputBudget = 256 * 1024;
const outputBudget = 16 * 1024;
const sensitiveIdentifier = /gh[pousr]_|github_pat_|sk-[a-z0-9]|AIza|bearer|password[=:]|token[=:]|secret[=:]|api[-_]?key[=:]/i;
const safeIdentifier = (value) => !sensitiveIdentifier.test(value);

function sourceFile(value, root) {
  try {
    const android = path.join(root, "android");
    const absolute = value.startsWith("file:") ? fileURLToPath(value) : path.resolve(android, value);
    const relative = path.relative(android, absolute).replaceAll("\\", "/");
    if (relative.length <= 240 && /^app\/src\/(?:[A-Za-z0-9_$-]+\/)*[A-Za-z0-9_$-]+\.(?:kt|java|xml)$/.test(relative) &&
        safeIdentifier(relative)) return relative;
  } catch { /* Unsupported locations are omitted, never copied verbatim. */ }
}

function project(text, root, truncated) {
  const report = {
    version: 1, kind: "android-build-diagnostics", availability: "available", truncated,
    failureKinds: [], failedTasks: [], findings: [],
    note: "Allowlisted diagnostic metadata only; not verification evidence. Unrecognized details remain in the private local log.",
  };
  const kinds = new Set(), tasks = new Set(), seen = new Set();
  const add = (finding) => {
    const key = JSON.stringify(finding);
    if (seen.has(key)) return;
    seen.add(key);
    if (report.findings.length < 24) report.findings.push(finding);
    else report.truncated = true;
  };
  for (const raw of text.split(/\r?\n/)) {
    if (raw.length > 4096) { report.truncated = true; continue; }
    const line = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
    for (const [pattern, kind] of [
      [/Several environment variables and\/or system properties contain different paths to the SDK/i, "sdk-path-conflict"],
      [/SDK location not found|Failed to find Platform SDK|Android SDK platform \d+ is missing/i, "sdk-missing"],
      [/JDK 17 or 21 is required|Android Gradle plugin requires Java|Unsupported class file major version|requires at least JVM runtime version/i, "jdk-incompatible"],
      [/Could not resolve|Could not find [\w.-]+:[\w.-]+:/i, "dependency-resolution"],
      [/Could not (?:GET|HEAD)|PKIX path building failed|SSLHandshakeException/i, "dependency-download"],
      [/There were failing tests/i, "jvm-tests"],
      [/Lint found \d+ errors?|Lint found fatal errors/i, "lint"],
      [/Gradle build daemon disappeared|DaemonDisappearedException/i, "gradle-daemon"],
      [/OutOfMemoryError|Java heap space/i, "out-of-memory"],
      [/^BUILD FAILED\b|^FAILURE: Build failed/i, "build-failed"],
    ]) if (pattern.test(line)) kinds.add(kind);

    const task = /^(?:> Task (:[\w:]+) FAILED|Execution failed for task '(:[\w:]+)'\.)$/.exec(line);
    if (task) {
      const value = task[1] ?? task[2];
      if (/^:app:[A-Za-z][A-Za-z0-9]{0,79}$/.test(value) && safeIdentifier(value)) {
        if (tasks.size < 16) tasks.add(value);
        else report.truncated = true;
      }
    }
    const summary = /^(\d{1,7}) tests? completed(?:, (\d{1,7}) failed)?(?:, (\d{1,7}) skipped)?$/.exec(line);
    if (summary) {
      report.testSummary = { tests: Number(summary[1]), failed: Number(summary[2] ?? 0), skipped: Number(summary[3] ?? 0) };
      if (report.testSummary.failed) kinds.add("jvm-tests");
    }
    const test = /^((?:dev\.devpocket\.app\.)?[A-Za-z_$][\w$]{0,96}Test) > ([A-Za-z_$][\w$]{0,127}(?:\[\d{1,3}\])?) FAILED$/.exec(line);
    if (test && safeIdentifier(test[1]) && safeIdentifier(test[2])) {
      kinds.add("jvm-tests");
      add({ kind: "jvm-test", suite: test[1], test: test[2] });
    }
    const exception = /^(?:Caused by:\s+)?((?:java|javax|kotlin|kotlinx|android|com\.android|org\.gradle|org\.jetbrains|org\.junit|org\.robolectric|dev\.devpocket\.app|com\.almworks\.sqlite4java)\.[A-Za-z_$][\w.$]{0,160}(?:Exception|Error))(?::.*| at ([A-Za-z_$][\w$]{0,100}\.(?:kt|java)):(\d{1,7}))?$/.exec(line);
    if (exception && safeIdentifier(exception[1]) && (!exception[2] || safeIdentifier(exception[2]))) {
      add({ kind: "exception", type: exception[1],
        ...(exception[2] ? { file: exception[2], line: Number(exception[3]) } : {}) });
    }
    const location = /^(e:\s+)?(.+\.(?:kt|java|xml)):(\d{1,7})(?::(\d{1,7}))?:?\s+(.*)$/.exec(line);
    if (!location) continue;
    const file = sourceFile(location[2], root);
    if (!file) continue;
    const position = { file, line: Number(location[3]), ...(location[4] ? { column: Number(location[4]) } : {}) };
    const lint = /\b(?:Error|Fatal): .*\[([A-Za-z][A-Za-z0-9]{0,63})\]$/.exec(location[5]);
    if (lint && safeIdentifier(lint[1])) {
      kinds.add("lint");
      add({ kind: "lint", ...position, issue: lint[1] });
    } else if (location[1] || /\berror: /i.test(location[5])) {
      kinds.add("compiler");
      const code = [
        [/unresolved reference|cannot find symbol/i, "unresolved-reference"],
        [/type mismatch|incompatible types/i, "type-mismatch"],
        [/overload resolution ambiguity/i, "ambiguous-overload"],
        [/expecting|unclosed/i, "syntax"],
      ].find(([pattern]) => pattern.test(location[5]))?.[1] ?? "compilation-error";
      add({ kind: "compiler", ...position, code });
    }
  }
  report.failureKinds = [...kinds];
  report.failedTasks = [...tasks];
  return report;
}

async function readBoundedLog(file) {
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (error.code === "ENOENT") return { availability: "missing", text: "", truncated: false };
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Linked or non-file logs are not supported.");
  const input = await open(file, "r");
  try {
    const opened = await input.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev) throw new Error("The diagnostic input changed.");
    const read = async (start, size) => {
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const result = await input.read(bytes, offset, size - offset, start + offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      return bytes.subarray(0, offset).toString("utf8");
    };
    if (opened.size <= inputBudget) {
      return { availability: "available", text: await read(0, opened.size), truncated: false };
    }
    // Sample both ends so an early compiler error and the final failed task survive noisy output.
    const head = await read(0, inputBudget / 2);
    const tail = await read(opened.size - inputBudget / 2, inputBudget / 2);
    return { availability: "available", truncated: true,
      text: head.slice(0, head.lastIndexOf("\n") + 1) + tail.slice(tail.indexOf("\n") + 1) };
  } finally { await input.close(); }
}

async function main() {
  const { values } = parseArgs({ options: { directory: { type: "string", default: path.join(".data", "ci", "android") } } });
  const root = process.cwd(), directory = path.resolve(root, values.directory);
  const relative = path.relative(root, directory);
  if (!["ci", "verification"].some((folder) => relative.startsWith(path.join(".data", folder) + path.sep))) {
    throw new Error("Diagnostics belong in an isolated CI or verification directory.");
  }
  let parent = root;
  for (const part of relative.split(path.sep)) {
    parent = path.join(parent, part);
    try { await mkdir(parent); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Linked directories are not supported.");
  }
  const input = await readBoundedLog(path.join(directory, "android-build.log"));
  const report = project(input.text, root, input.truncated);
  report.availability = input.availability;
  let bytes = JSON.stringify(report, null, 2) + "\n";
  while (Buffer.byteLength(bytes) > outputBudget) {
    report.findings.pop();
    report.truncated = true;
    bytes = JSON.stringify(report, null, 2) + "\n";
  }
  const output = await open(path.join(directory, "android-diagnostics.json"), "wx", 0o600);
  try { await output.writeFile(bytes); }
  finally { await output.close(); }
  process.stdout.write(bytes);
}

try { await main(); }
catch {
  console.error("Android diagnostic export refused or failed; no raw log was published.");
  process.exitCode = 1;
}
