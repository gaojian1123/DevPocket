import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { diagnosticError, failureDetails, ownValue, projectFailureDetails } from "./diagnostic-errors.mjs";
import { projectWorkerDiagnostics, readDiagnosticReport } from "./worker-diagnostics.mjs";
import { diagnosticDirectory, publishDiagnostic } from "./diagnostic-publication.mjs";

export const DEVICE_DIAGNOSTIC_PREFIX = "DEVPOCKET_DEVICE_DIAGNOSTIC ";
export const DEVICE_DIAGNOSTIC_LIMIT = 32768;
const sampleLimit = 128 * 1024;
const phases = ["entry", "prepare", "resources", "lease", "build", "avd", "acceleration", "adb", "boot", "ownership",
  "install", "discovery", "native", "layout", "additional", "fixture", "source-check", "apk-check", "cleanup", "complete"];
const operations = ["start", "tools", "workspace", "image", "jdk", "emulator", "adb", "gradle", "cache", "app", "tests", "unlock",
  "clear-app", "instrumentation", "window", "font", "reset", "fixture-start", "fixture-config", "reverse",
  "verify", "processes", "data", "lease", "report", "done"];
const issueOperations = ["catalogue", "case-log", "logcat", "crash-log-write", "layout-reset", "worker-log", "native-lifecycle",
  "capacity-before-prepare", "capacity-after-prepare", "cleanup", "report", "output"];
const statuses = ["started", "passed", "failed", "blocked", "cancelled"];
const exceptionTypes = new Set([
  "java.lang.AssertionError", "org.junit.ComparisonFailure", "java.lang.IllegalArgumentException",
  "java.lang.IllegalStateException", "java.lang.NullPointerException", "java.lang.RuntimeException",
  "java.lang.SecurityException", "java.lang.OutOfMemoryError", "java.lang.ArithmeticException",
  "java.lang.ClassNotFoundException", "java.io.IOException", "java.util.concurrent.TimeoutException",
  "androidx.compose.ui.test.ComposeTimeoutException", "androidx.test.espresso.AppNotIdleException",
  "androidx.test.espresso.NoMatchingViewException", "androidx.test.espresso.PerformException",
]);
const caseName = (value) => ["native", "fixture", "layout-compact", "layout-medium", "layout-expanded",
  "layout-landscape", "layout-large-font"].includes(value) || typeof value === "string" && /^change-\d{1,4}$/.test(value)
  ? value : "unknown";
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : "unknown";
const phaseOfCase = (name) => name === "native" || name === "fixture" ? name
  : typeof name === "string" && name.startsWith("layout-") ? "layout"
    : typeof name === "string" && /^change-\d+$/.test(name) ? "additional" : "unknown";

export function projectDeviceDiagnostics(value, catalogue, expectedRunId) {
  const owner = typeof expectedRunId === "string" && /^[a-f0-9-]{36}$/.test(expectedRunId) ? expectedRunId : "unknown";
  const output = {
    version: 1, kind: "device-execution-diagnostics", acceptance: false, runId: owner,
    catalogueFingerprint: catalogue.fingerprint ?? "unknown", availability: "incomplete",
    sequence: 0, phase: "entry", operation: "start", status: "unknown",
    primary: null, secondary: [], cases: [], history: [], logs: [], truncated: false,
    collectionStatus: "unknown",
  };
  if (ownValue(value, "version") !== 1 || ownValue(value, "runId") !== owner) {
    output.availability = value == null ? "missing" : "foreign";
    return output;
  }
  const matchingCatalogue = typeof catalogue.fingerprint === "string" && /^[a-f0-9]{64}$/.test(catalogue.fingerprint) &&
    ownValue(value, "catalogueFingerprint") === catalogue.fingerprint;
  const classRef = (input) => {
    const item = matchingCatalogue ? trustedClass(catalogue, ownValue(input, "name")) : undefined;
    return item && item.file === ownValue(input, "file") && item.line === ownValue(input, "line")
      ? { name: item.name, file: item.file, line: item.line } : "unknown";
  };
  const caseRef = (input) => ({ name: caseName(ownValue(input, "name")), class: classRef(ownValue(input, "class")) });
  const instrument = (input) => {
    const findings = ownValue(input, "failures");
    const failures = [];
    for (const item of Array.isArray(findings) ? findings.slice(0, 8) : []) {
      const type = ownValue(item, "exception"), sourceClass = classRef(ownValue(item, "class"));
      const methodValue = ownValue(item, "method");
      const method = sourceClass !== "unknown" ? trustedMethod(catalogue, sourceClass.name, ownValue(methodValue, "name")) : undefined;
      const foundFrames = ownValue(item, "frames"), frames = [];
      for (const frame of Array.isArray(foundFrames) ? foundFrames.slice(0, 8) : []) {
        const file = matchingCatalogue ? catalogue.files.find((file) => file.file === ownValue(frame, "file")) : undefined;
        const line = ownValue(frame, "line");
        if (file && Number.isSafeInteger(line) && line > 0 && line <= file.lines) frames.push({ file: file.file, line });
      }
      const code = ownValue(item, "statusCode");
      failures.push({
        statusCode: [-1, -2, -3, -4].includes(code) ? code : "unknown",
        class: sourceClass,
        method: method && method.file === ownValue(methodValue, "file") && method.line === ownValue(methodValue, "line")
          ? { name: method.name, file: method.file, line: method.line } : "unknown",
        exception: exceptionTypes.has(type) ? type : "unknown",
        category: ["assertion", "exception", "timeout", "skipped"].includes(ownValue(item, "category")) ? ownValue(item, "category") : "unknown",
        frames,
      });
    }
    const exit = ownValue(input, "exitCode"), bytes = ownValue(input, "sampledBytes");
    return {
      availability: ["available", "incomplete"].includes(ownValue(input, "availability")) ? ownValue(input, "availability") : "unavailable",
      sampledBytes: Number.isInteger(bytes) && bytes >= 0 && bytes <= sampleLimit ? bytes : "unknown",
      truncated: typeof ownValue(input, "truncated") === "boolean" ? ownValue(input, "truncated") : "unknown",
      exitCode: Number.isInteger(exit) && exit >= -999 && exit <= 999 ? exit : "unknown",
      failures,
    };
  };
  const phase = (input) => phases.includes(input) ? input : "unknown";
  const operation = (input) => operations.includes(input) ? input : "unknown";
  const primary = ownValue(value, "primary");
  if (primary && typeof primary === "object") output.primary = {
    phase: phase(ownValue(primary, "phase")), operation: operation(ownValue(primary, "operation")),
    case: ownValue(primary, "case") ? caseRef(ownValue(primary, "case")) : null,
    ...projectFailureDetails(primary),
    ...(ownValue(primary, "instrumentation") ? { instrumentation: instrument(ownValue(primary, "instrumentation")) } : {}),
  };
  const secondary = ownValue(value, "secondary");
  for (const item of Array.isArray(secondary) ? secondary.slice(0, 16) : []) {
    output.secondary.push({ operation: issueOperations.includes(ownValue(item, "operation")) ? ownValue(item, "operation") : "unknown",
      phase: phase(ownValue(item, "phase")), case: ownValue(item, "case") ? caseRef(ownValue(item, "case")) : null,
      ...projectFailureDetails(item) });
  }
  const cases = ownValue(value, "cases");
  for (const item of Array.isArray(cases) ? cases.slice(-32) : []) output.cases.push({
    ...caseRef(item), status: statuses.includes(ownValue(item, "status")) ? ownValue(item, "status") : "unknown", tests: count(ownValue(item, "tests")),
  });
  const history = ownValue(value, "history");
  for (const item of Array.isArray(history) ? history.slice(-32) : []) output.history.push({
    sequence: count(ownValue(item, "sequence")), phase: phase(ownValue(item, "phase")), operation: operation(ownValue(item, "operation")),
  });
  const logs = ownValue(value, "logs");
  for (const item of Array.isArray(logs) ? logs.slice(-16) : []) {
    const retained = ownValue(item, "retainedBytes");
    output.logs.push({
      role: ["case", "crash", "build", "discovery", "failure"].includes(ownValue(item, "role")) ? ownValue(item, "role") : "unknown",
      case: caseName(ownValue(item, "case")),
      status: ["retained", "unavailable", "pending"].includes(ownValue(item, "status")) ? ownValue(item, "status") : "unknown",
      truncated: typeof ownValue(item, "truncated") === "boolean" ? ownValue(item, "truncated") : "unknown",
      retainedBytes: Number.isInteger(retained) && retained >= 0 && retained <= 1024 * 1024 ? retained : "unknown",
    });
  }
  Object.assign(output, {
    availability: matchingCatalogue && owner !== "unknown" ? "observed" : "incomplete",
    sequence: count(ownValue(value, "sequence")), phase: phase(ownValue(value, "phase")), operation: operation(ownValue(value, "operation")),
    status: statuses.includes(ownValue(value, "status")) ? ownValue(value, "status") : "unknown",
    truncated: ownValue(value, "truncated") === true || (Array.isArray(cases) && cases.length > 32) ||
      (Array.isArray(history) && history.length > 32) || (Array.isArray(secondary) && secondary.length > 16) ||
      (Array.isArray(logs) && logs.length > 16),
    collectionStatus: ownValue(value, "collectionStatus") === "failed" ||
      output.secondary.some((issue) => ["catalogue", "case-log", "logcat", "crash-log-write", "worker-log", "native-lifecycle",
        "capacity-before-prepare", "capacity-after-prepare", "report", "output"].includes(issue.operation))
      ? "failed" : ownValue(value, "collectionStatus") === "completed" ? "completed" : "unknown",
  });
  if (output.truncated || output.secondary.length || ownValue(value, "availability") === "incomplete") {
    output.availability = "incomplete";
  }
  while (Buffer.byteLength(JSON.stringify(output)) > DEVICE_DIAGNOSTIC_LIMIT) {
    output.truncated = true;
    output.availability = "incomplete";
    if (output.history.length) output.history.shift();
    else if (output.cases.length > 1) output.cases.shift();
    else if (output.logs.length) output.logs.shift();
    else if (output.secondary.length) output.secondary.pop();
    else if (output.primary?.instrumentation?.failures.length) output.primary.instrumentation.failures.pop();
    else break;
  }
  return output;
}

export function deviceDiagnosticsFromOutput(value, catalogue, runId) {
  const input = sample(value);
  const lines = input.text.split(/\r?\n/).filter((line) => line.startsWith(DEVICE_DIAGNOSTIC_PREFIX));
  if (lines.length !== 1 || Buffer.byteLength(lines[0]) > DEVICE_DIAGNOSTIC_LIMIT + DEVICE_DIAGNOSTIC_PREFIX.length) {
    return { ...projectDeviceDiagnostics(null, catalogue, runId),
      unavailableReason: lines.length ? "ambiguous-or-oversized-frame" : "not-produced" };
  }
  try {
    const output = projectDeviceDiagnostics(JSON.parse(lines[0].slice(DEVICE_DIAGNOSTIC_PREFIX.length)), catalogue, runId);
    if (input.truncated) { output.truncated = true; output.availability = "incomplete"; }
    return output;
  } catch {
    return { ...projectDeviceDiagnostics(null, catalogue, runId), availability: "invalid", unavailableReason: "invalid-frame" };
  }
}

function codeWithoutLiterals(text) {
  const output = text.split("");
  let index = 0;
  const hide = (start, end) => {
    for (let cursor = start; cursor < end; cursor++) if (output[cursor] !== "\n" && output[cursor] !== "\r") output[cursor] = " ";
  };
  const comment = (start) => {
    let cursor = start + 2, depth = 1;
    if (text.startsWith("//", start)) {
      while (cursor < text.length && text[cursor] !== "\n") cursor++;
      return cursor;
    }
    while (cursor < text.length && depth) {
      if (text.startsWith("/*", cursor)) { depth++; cursor += 2; }
      else if (text.startsWith("*/", cursor)) { depth--; cursor += 2; }
      else cursor++;
    }
    if (depth) throw new Error("Unclosed source comment.");
    return cursor;
  };
  const quoted = (start, level = 0) => {
    if (level > 32) throw new Error("Source interpolation nesting exceeded its bound.");
    const raw = text.startsWith('"""', start), quote = raw ? '"""' : text[start];
    let cursor = start + quote.length;
    while (cursor < text.length) {
      if (!raw && quote !== "`" && text[cursor] === "\\") { cursor += 2; continue; }
      if ((raw || quote === '"') && text.startsWith("${", cursor)) {
        cursor = interpolation(cursor + 2, level + 1);
        continue;
      }
      if (text.startsWith(quote, cursor)) return cursor + quote.length;
      cursor++;
    }
    throw new Error("Unclosed source literal.");
  };
  const interpolation = (start, level) => {
    let cursor = start, depth = 1;
    while (cursor < text.length) {
      if (text.startsWith("//", cursor) || text.startsWith("/*", cursor)) { cursor = comment(cursor); continue; }
      if (['"', "'", "`"].includes(text[cursor])) { cursor = quoted(cursor, level); continue; }
      if (text[cursor] === "{") depth++;
      if (text[cursor++] === "}" && --depth === 0) return cursor;
    }
    throw new Error("Unclosed source interpolation.");
  };
  while (index < text.length) {
    const start = index;
    if (text.startsWith("//", index) || text.startsWith("/*", index)) index = comment(index);
    else if (['"', "'", "`"].includes(text[index])) index = quoted(index);
    else { index++; continue; }
    hide(start, index);
  }
  return output.join("");
}

async function readSource(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new Error("Unsupported device catalogue source.");
  const handle = await open(file, "r");
  try {
    const current = await handle.stat();
    if (current.ino !== info.ino || current.dev !== info.dev || current.size !== info.size) throw new Error("Device catalogue source changed.");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    return bytes.subarray(0, offset).toString("utf8");
  } finally { await handle.close(); }
}

export async function deviceSourceCatalogue(root, { includeUnitTests = false } = {}) {
  root = path.resolve(root);
  const files = [], identities = [];
  let visited = 0, bytes = 0;
  const walk = async (directory, depth = 0) => {
    if (++visited > 256 || depth > 16) throw new Error("Device catalogue directory budget exceeded.");
    let info;
    try { info = await lstat(directory); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const canonical = await realpath(directory);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        (process.platform === "win32" ? canonical.toLowerCase() !== directory.toLowerCase() : canonical !== directory)) {
      throw new Error("Linked device catalogue directories are not supported.");
    }
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error("Linked device catalogue entries are not supported.");
      if (item.isDirectory()) { await walk(absolute, depth + 1); continue; }
      const extension = includeUnitTests ? /\.(?:kt|java|xml)$/ : /\.(?:kt|java)$/;
      if (!extension.test(item.name) || !/^[A-Za-z_][A-Za-z0-9_.-]{0,95}$/.test(item.name)) continue;
      if (files.length >= 128) throw new Error("Device catalogue file budget exceeded.");
      const text = await readSource(absolute), file = path.relative(root, absolute).replaceAll("\\", "/");
      if (file.length > 240 || !/^android\/app\/src\/(?:main|debug|release|androidTest|test)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:kt|java|xml)$/.test(file)) {
        throw new Error("Unsupported device catalogue path.");
      }
      bytes += Buffer.byteLength(text);
      if (bytes > 4 * 1024 * 1024) throw new Error("Device catalogue source budget exceeded.");
      const declarationIssue = item.name.endsWith(".java") ? "java-declarations-unsupported" : undefined;
      const code = item.name.endsWith(".xml") || declarationIssue ? "" : codeWithoutLiterals(text);
      const packageName = /^package[ \t]+(dev\.devpocket\.app(?:\.[A-Za-z_][A-Za-z0-9_]*)*)[ \t]*;?[ \t]*\r?$/m.exec(code)?.[1];
      const position = (offset) => code.slice(0, offset).split("\n").length;
      const classes = packageName ? [...code.matchAll(/\bclass[ \t]+([A-Za-z_][A-Za-z0-9_]*)\b/g)]
        .filter((match) => match[1].length <= 128 && packageName.length <= 128)
        .map((match) => Object.freeze({ name: `${packageName}.${match[1]}`, file, line: position(match.index) })) : [];
      const testClasses = file.startsWith("android/app/src/androidTest/") || includeUnitTests && file.startsWith("android/app/src/test/")
        ? classes.filter((item) => item.name.endsWith("Test")) : [];
      const methods = testClasses.length === 1 ? [...code.matchAll(/@(?:org\.junit\.)?Test(?:[ \t]*\([^\n]*\))?\s+(?:(?:public|internal|suspend)\s+)*fun[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/g)]
        .filter((match) => match[1].length <= 160)
        .map((match) => Object.freeze({ name: match[1], class: testClasses[0].name, file, line: position(match.index) })) : [];
      if (classes.length > 128 || methods.length > 256) throw new Error("Device declaration budget exceeded.");
      identities.push([file, createHash("sha256").update(text).digest("hex")]);
      files.push(Object.freeze({ file, basename: item.name, packageName, lines: text.split("\n").length,
        classes: Object.freeze(classes), testClasses: Object.freeze(testClasses), methods: Object.freeze(methods),
        facade: packageName ? `${packageName}.${item.name.slice(0, -3)}Kt` : undefined, declarationIssue }));
    }
  };
  if (includeUnitTests) await walk(path.join(root, "android", "app", "src"));
  else {
    await walk(path.join(root, "android", "app", "src", "androidTest", "java"));
    await walk(path.join(root, "android", "app", "src", "main", "java"));
  }
  if (!files.length) return Object.freeze({ files: Object.freeze([]), fingerprint: "unknown", unavailableReason: "not-produced" });
  return Object.freeze({ files: Object.freeze(files), fingerprint: createHash("sha256").update(JSON.stringify(identities)).digest("hex") });
}

function trustedClass(catalogue, name) {
  const matches = catalogue.files.flatMap((file) => file.testClasses).filter((item) => item.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function trustedMethod(catalogue, className, name) {
  const matches = catalogue.files.flatMap((file) => file.methods).filter((item) => item.class === className && item.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function sample(value) {
  if (typeof value !== "string") return { text: "", bytes: 0, truncated: false, availability: "invalid" };
  const buffer = Buffer.from(value);
  if (buffer.length <= sampleLimit) return { text: value, bytes: buffer.length, truncated: false, availability: "available" };
  const head = buffer.subarray(0, sampleLimit / 2).toString("utf8"), tail = buffer.subarray(-sampleLimit / 2).toString("utf8");
  return { text: head.slice(0, head.lastIndexOf("\n") + 1) + tail.slice(tail.indexOf("\n") + 1),
    bytes: sampleLimit, truncated: true, availability: "incomplete" };
}

export function instrumentationDiagnostics(value, expectedClass, catalogue) {
  const input = sample(value), failures = [];
  let group = {}, stack = false, exitCode = "unknown", groupTruncated = false;
  const frames = (lines) => {
    const result = [];
    for (const line of lines.slice(0, 128)) {
      const match = /^[ \t]+at ([A-Za-z_$][A-Za-z0-9_.$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\(([A-Za-z_][A-Za-z0-9_]*\.kt):(\d{1,6})\)[ \t]*$/.exec(line);
      if (!match) continue;
      const owner = match[1].split("$")[0], number = Number(match[4]);
      const known = catalogue.files.filter((file) => file.basename === match[3] && number > 0 && number <= file.lines &&
        (file.facade === owner || file.classes.some((item) => item.name === owner)));
      if (known.length === 1 && result.length < 8) result.push({ file: known[0].file, line: number });
    }

    return result;
  };
  for (const raw of input.text.split(/\r?\n/)) {
    if (raw.length > 4096) {
      groupTruncated = true;
      if (raw.startsWith("INSTRUMENTATION_STATUS: stack=")) {
        group.stack = [raw.slice("INSTRUMENTATION_STATUS: stack=".length, 512)];
        stack = true;
      }
      continue;
    }
    const status = /^INSTRUMENTATION_STATUS: (class|test|stack)=(.*)$/.exec(raw);
    if (status) {
      stack = status[1] === "stack";
      group[status[1]] = stack ? [status[2]] : status[2];
      continue;
    }
    const end = /^INSTRUMENTATION_STATUS_CODE: (-?\d{1,3})[ \t]*$/.exec(raw);
    if (end) {
      const code = Number(end[1]);
      if ([-1, -2, -3, -4].includes(code)) {
        const type = /^([A-Za-z_$][A-Za-z0-9_.$]*)(?::|$)/.exec(group.stack?.[0] ?? "")?.[1];
        const exception = exceptionTypes.has(type) ? type : "unknown";
        const method = group.class === expectedClass ? trustedMethod(catalogue, expectedClass, group.test) : undefined;
        if (failures.length < 8) failures.push({
          statusCode: code,
          class: group.class === expectedClass ? trustedClass(catalogue, expectedClass) ?? "unknown" : "unknown",
          method: method ? { name: method.name, file: method.file, line: method.line } : "unknown",
          exception,
          category: code === -3 || code === -4 ? "skipped" : exception === "unknown" ? "unknown"
            : ["java.lang.AssertionError", "org.junit.ComparisonFailure"].includes(exception) ? "assertion"
              : exception.includes("Timeout") || exception === "androidx.test.espresso.AppNotIdleException" ? "timeout" : "exception",
          frames: frames(group.stack ?? []),
        });
        else groupTruncated = true;
      }
      group = {};
      stack = false;
      continue;
    }
    const finished = /^INSTRUMENTATION_CODE: (-?\d{1,3})[ \t]*$/.exec(raw);
    if (finished) { exitCode = Number(finished[1]); stack = false; continue; }
    if (stack && group.stack.length < 128) group.stack.push(raw);
  }
  return { availability: input.availability === "available" && !groupTruncated && exitCode !== "unknown" ? "available" : "incomplete",
    sampledBytes: input.bytes, truncated: input.truncated || groupTruncated, exitCode, failures };
}

export async function createDeviceDiagnostics({ root = process.cwd(), runId, onSnapshot } = {}) {
  let catalogue, catalogueIssue;
  try { catalogue = await deviceSourceCatalogue(root); }
  catch (error) {
    catalogue = { files: [], fingerprint: "unknown" };
    catalogueIssue = { operation: "catalogue", ...failureDetails(error, "collector-failed") };
  }
  const state = { sequence: 0, phase: "entry", operation: "start", status: "started", cases: [], currentCase: undefined,
    primary: undefined, secondary: catalogueIssue ? [catalogueIssue] : [], history: [], logs: [], truncated: false,
    collectionFailed: !!catalogueIssue };
  const seenFailures = new WeakSet();
  let outputFailureRecorded = false;
  const snapshot = () => projectDeviceDiagnostics({
    version: 1, kind: "device-execution-diagnostics", acceptance: false,
    runId: typeof runId === "string" && /^[a-f0-9-]{36}$/.test(runId) ? runId : "unknown",
    catalogueFingerprint: catalogue.fingerprint, availability: catalogueIssue ? "incomplete" : "observed",
    sequence: state.sequence, phase: state.phase, operation: state.operation, status: state.status,
    primary: state.primary ?? null, secondary: state.secondary.slice(), cases: state.cases.map((item) => ({ ...item })),
    history: state.history.slice(), logs: state.logs.slice(), truncated: state.truncated,
    collectionStatus: state.collectionFailed ? "failed" : "completed",
  }, catalogue, runId);
  const notify = () => {
    try { onSnapshot?.(snapshot()); }
    catch (error) {
      if (!outputFailureRecorded && state.secondary.length < 16) {
        state.secondary.push({ operation: "output", ...failureDetails(error, "collector-failed") });
      }
      outputFailureRecorded = true;
      state.collectionFailed = true;
      state.truncated = true;
    }
  };
  const stage = (phase, operation = "start") => {
    state.phase = phases.includes(phase) ? phase : "unknown";
    if (!["native", "layout", "additional", "fixture"].includes(phase)) state.currentCase = undefined;
    state.operation = operations.includes(operation) ? operation : "unknown";
    state.sequence++;
    if (state.history.length >= 32) { state.history.shift(); state.truncated = true; }
    state.history.push({ sequence: state.sequence, phase: state.phase, operation: state.operation });
    notify();
  };
  const issue = (operation, error) => {
    if (!["cleanup", "layout-reset"].includes(operation)) state.collectionFailed = true;
    if (state.secondary.length < 16) state.secondary.push({
      operation: issueOperations.includes(operation) ? operation : "unknown",
      phase: state.phase, case: state.currentCase ? { name: state.currentCase.name, class: state.currentCase.class } : null,
      ...failureDetails(error, ["cleanup", "layout-reset"].includes(operation) ? "cleanup-failed" : "collector-failed"),
    });
    else state.truncated = true;
    notify();
  };
  const fail = (error, instrumentation) => {
    if (error && typeof error === "object" && seenFailures.has(error)) return;
    if (error && typeof error === "object") seenFailures.add(error);
    if (state.currentCase?.status === "started") state.currentCase.status = "failed";
    const detail = { phase: state.phase, operation: state.operation,
      case: state.currentCase ? { name: state.currentCase.name, class: state.currentCase.class } : null, ...failureDetails(error),
      ...(instrumentation ? { instrumentation } : {}) };
    if (!state.primary) state.primary = detail;
    else issue(state.phase === "cleanup" ? "cleanup" : "report", error);
    state.status = detail.reason === "command-cancelled" ? "cancelled" : "failed";
    notify();
  };
  return {
    catalogue, stage, issue, fail, snapshot,
    log(role, info) {
      if (state.logs.length >= 16) { state.logs.shift(); state.truncated = true; }
      state.logs.push({ role, case: state.currentCase?.name, ...info });
      notify();
    },
    operation(operation) { stage(state.phase, operation); },
    caseStarted(name, className) {
      if (caseName(name) === "unknown") throw new Error("Unsupported native case identifier.");
      const known = trustedClass(catalogue, className);
      let item = state.cases.findLast((item) => item.name === name && item.status === "started");
      if (!item) {
        if (state.cases.length >= 32) { state.cases.shift(); state.truncated = true; }
        item = { name: caseName(name), class: known ?? "unknown", requestedClass: className, status: "started", tests: 0 };
        state.cases.push(item);
      }
      state.currentCase = item;
      stage(phaseOfCase(name), "clear-app");
    },
    caseFinished(name, result, error, instrumentation) {
      const item = state.cases.findLast((item) => item.name === caseName(name));
      if (item) Object.assign(item, { status: error ? "failed" : "passed", tests: error ? 0 : count(result?.tests) });
      if (error) fail(error, instrumentation);
      else notify();
    },
    failedCase() {
      const item = state.currentCase;
      return item ? { name: item.name, class: item.requestedClass, status: item.status === "started" ? "failed" : item.status,
        tests: Number.isSafeInteger(item.tests) ? item.tests : 0 } : undefined;
    },
    finish(status) {
      state.status = statuses.includes(status) ? status : "unknown";
      notify();
      return snapshot();
    },
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    directory: { type: "string", default: path.join(".data", "ci", "device") },
    github: { type: "boolean", default: false },
  } });
  const root = process.cwd(), directory = await diagnosticDirectory(root, values.directory);
  let catalogue, report, collectionFailure, catalogueFailure;
  try { catalogue = await deviceSourceCatalogue(root); }
  catch (error) {
    catalogue = { files: [], fingerprint: "unknown" };
    catalogueFailure = failureDetails(error, "collector-failed");
  }
  try { report = await readDiagnosticReport(path.join(directory, "report.json")); }
  catch (error) { collectionFailure = failureDetails(error, error instanceof SyntaxError ? "report-invalid" : "report-unavailable"); }
  if (report && (report.version !== 1 || !Array.isArray(report.checks))) {
    collectionFailure = failureDetails(diagnosticError("report-invalid"));
  }
  const selected = Array.isArray(report?.checks) ? report.checks.filter((item) => item?.id === "android-device") : [];
  if (selected.length > 1) collectionFailure = failureDetails(diagnosticError("report-invalid"));
  const check = selected.length === 1 ? selected[0] : undefined;
  const runId = typeof check?.deviceRunId === "string" && /^[a-f0-9-]{36}$/.test(check.deviceRunId) ? check.deviceRunId : "unknown";
  const projected = projectDeviceDiagnostics(runId === "unknown" ? null : check?.deviceDiagnostics, catalogue, runId);
  const workers = projectWorkerDiagnostics(check?.workerDiagnostics, runId);
  const output = {
    ...projected,
    source: /^[a-f0-9]{40}$/.test(report?.source?.head ?? "") && /^[a-f0-9]{64}$/.test(report?.source?.fingerprint ?? "")
      ? { head: report.source.head, fingerprint: report.source.fingerprint } : null,
    base: /^[a-f0-9]{40}$/.test(report?.base ?? "") ? report.base : "unknown",
    verificationStatus: ["passed", "partial", "failed", "blocked", "planned"].includes(report?.status) ? report.status : "unknown",
    checkStatus: ["passed", "failed", "blocked", "not_run"].includes(check?.status) ? check.status : "unknown",
    executionStatus: ["passed", "failed", "blocked"].includes(check?.reportedDeviceExecutionStatus)
      ? check.reportedDeviceExecutionStatus : "unknown",
    checkFailure: check?.failure ? projectFailureDetails(check.failure) : null,
    reportAvailability: collectionFailure ? "invalid-or-unavailable" : report ? "available" : "not-produced",
    collectionFailure: collectionFailure ?? null,
    catalogueFailure: catalogueFailure ?? null,
    collectionStatus: collectionFailure || catalogueFailure || workers.collectionStatus === "failed" ||
      projected.collectionStatus === "failed" || check?.collectionStatus === "failed" ? "failed" : "completed",
    workerAvailability: workers.availability,
    workerCollectionStatus: workers.collectionStatus,
    workerCollectionFailures: workers.collectionFailures,
  };
  await publishDiagnostic({ root, directory, name: "device-diagnostics.json", value: output, limit: 65536, github: values.github });
  if (output.collectionStatus === "failed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    console.error(JSON.stringify({ kind: "device-diagnostic-export", status: "failed", acceptance: false,
      diagnosticAvailability: "not-produced", failure: failureDetails(error, "collector-failed") }));
    process.exitCode = 1;
  }
}
