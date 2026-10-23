import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { boundedDiagnosticBytes } from "./bounded-worker-log.mjs";

const eventLimit = 10000;
const findingLimit = 32;
const outputLimit = 16384;
const privateLogLimit = 1024 * 1024;
const prefix = "DEVPOCKET_BACKEND_DIAGNOSTIC ";
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const LINUX_PLATFORM_TESTS = Object.freeze([
  "scripts/tests/linux-emulator.test.mjs", "scripts/tests/linux-process.test.mjs", "scripts/tests/linux-runtime.test.mjs",
  "scripts/tests/worker-diagnostics.test.mjs", "scripts/tests/native-lifecycle.test.mjs", "scripts/tests/bounded-worker-log.test.mjs",
]);
const failureTypes = ["testCodeFailure", "subtestsFailed", "testTimeoutFailure", "cancelledByParent",
  "parentAlreadyFinished", "uncaughtException", "unhandledRejection", "hookFailed", "testAborted"];
const categories = ["assertion", "test-timeout", "cancelled", "subtest-failure", "unhandled-error",
  "missing-file", "port-conflict", "connection-refused", "connection-reset", "operation-timeout",
  "database-busy", "database-io", "type-error", "range-error", "syntax-error", "unknown"];
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : "unknown";
const own = (value, key) => {
  if (!value || typeof value !== "object") return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; }
  catch { return undefined; }
};
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

async function boundedFile(file, limit) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error("Unsupported backend diagnostic input.");
  const handle = await open(file, "r");
  try {
    const current = await handle.stat();
    if (current.ino !== info.ino || current.dev !== info.dev || current.size !== info.size) {
      throw new Error("Backend diagnostic input changed.");
    }
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

export async function backendTestCatalogue(root, scope = "backend") {
  root = path.resolve(root);
  if (!["backend", "linux-platform"].includes(scope)) throw new Error("Unsupported diagnostic test scope.");
  const base = scope === "backend" ? "backend" : "scripts";
  for (const directory of [root, path.join(root, base), path.join(root, base, "tests")]) {
    if (!(await lstat(directory)).isDirectory() || !samePath(await realpath(directory), directory)) {
      throw new Error("Linked backend test catalogues are not supported.");
    }
  }
  const { parse } = await import("@babel/parser");
  const names = scope === "backend"
    ? (await readdir(path.join(root, "backend", "tests"))).filter((name) => name.endsWith(".test.ts")).sort()
    : LINUX_PLATFORM_TESTS.map((file) => path.basename(file));
  if (!names.length || names.length > 64 || names.some((name) => !/^[a-z][a-z0-9-]{0,63}\.test\.(?:ts|mjs)$/.test(name))) {
    throw new Error("Unsupported backend test catalogue.");
  }
  const files = [], identities = [];
  let totalBytes = 0, declarations = 0;
  for (const name of names) {
    const absolute = path.join(root, base, "tests", name), file = `${base}/tests/${name}`;
    const text = await boundedFile(absolute, 512 * 1024);
    identities.push([file, hash(text)]);
    totalBytes += Buffer.byteLength(text);
    if (totalBytes > 4 * 1024 * 1024) throw new Error("Backend test catalogue exceeded its source budget.");
    let source;
    try {
      source = parse(text, { sourceType: "module", sourceFilename: file, attachComment: false,
        createParenthesizedExpressions: true, plugins: name.endsWith(".ts") ? ["typescript"] : [] });
    } catch (error) {
      throw new Error("Backend test declarations could not be parsed.", { cause: error });
    }
    const imports = new Set();
    for (const statement of source.program.body) {
      if (statement.type !== "ImportDeclaration" || statement.source.value !== "node:test" || statement.importKind === "type") continue;
      for (const binding of statement.specifiers) {
        if (binding.type === "ImportDefaultSpecifier" ||
            binding.type === "ImportSpecifier" && binding.importKind !== "type" &&
              ["test", "it", "describe"].includes(binding.imported.name ?? binding.imported.value))
          imports.add(binding.local.name);
      }
    }
    const entries = [];
    const visit = (node, contexts = new Set()) => {
      if (!node || typeof node.type !== "string") return;
      const expression = ["CallExpression", "OptionalCallExpression"].includes(node.type) ? node.callee : undefined;
      const direct = expression?.type === "Identifier" && imports.has(expression.name);
      const member = expression && ["MemberExpression", "OptionalMemberExpression"].includes(expression.type) &&
        !expression.computed && expression.object.type === "Identifier" && expression.property.type === "Identifier" &&
        ((contexts.has(expression.object.name) && expression.property.name === "test") ||
          (imports.has(expression.object.name) && ["only", "skip", "todo"].includes(expression.property.name)));
      if (direct || member) {
        // Node reports member calls at the method token, not the receiver.
        const location = (member ? expression.property : expression).loc.start;
        entries.push({ file, line: location.line, column: location.column + 1 });
        if (++declarations > 2048) throw new Error("Backend declarations exceeded their budget.");
        for (const argument of node.arguments) {
          const nested = new Set(contexts);
          if (["ArrowFunctionExpression", "FunctionExpression"].includes(argument.type)) {
            const parameter = argument.params[0];
            const identifier = parameter?.type === "AssignmentPattern" ? parameter.left :
              parameter?.type === "RestElement" ? parameter.argument : parameter;
            if (identifier?.type === "Identifier") nested.add(identifier.name);
          }
          visit(argument, nested);
        }
      } else {
        for (const [key, value] of Object.entries(node)) {
          if (["loc", "start", "end", "comments", "tokens", "extra"].includes(key)) continue;
          if (Array.isArray(value)) for (const child of value) visit(child, contexts);
          else if (value && typeof value === "object") visit(value, contexts);
        }
      }
    };
    visit(source);
    files.push({ absolute, file, entries });
  }
  return { root, files, scope, fingerprint: hash(JSON.stringify(identities)) };
}

function trustedIdentity(catalogue, file, line, column) {
  let absolute;
  try {
    if (typeof file !== "string" || file.length > 4096) return { file: "unknown", declaration: "unknown" };
    absolute = file.startsWith("file:") ? fileURLToPath(file) : path.resolve(catalogue.root, file);
  } catch { return { file: "unknown", declaration: "unknown" }; }
  const known = catalogue.files.find((item) => samePath(item.absolute, absolute));
  if (!known) return { file: "unknown", declaration: "unknown" };
  const matches = known.entries.filter((entry) => entry.line === line && entry.column === column);
  const entry = matches.length === 1 ? matches[0] : undefined;
  return { file: known.file, declaration: entry ? { file: entry.file, line: entry.line, column: entry.column } : "unknown" };
}

function errorCategory(error, failureType) {
  if (failureType === "testTimeoutFailure") return "test-timeout";
  if (["cancelledByParent", "testAborted"].includes(failureType)) return "cancelled";
  if (failureType === "subtestsFailed") return "subtest-failure";
  const codes = {
    ERR_ASSERTION: "assertion", ENOENT: "missing-file", EADDRINUSE: "port-conflict",
    ECONNREFUSED: "connection-refused", ECONNRESET: "connection-reset", ETIMEDOUT: "operation-timeout",
    ABORT_ERR: "cancelled", SQLITE_BUSY: "database-busy", SQLITE_IOERR: "database-io",
  };
  const names = { TypeError: "type-error", RangeError: "range-error", SyntaxError: "syntax-error" };
  for (let depth = 0; error && depth < 3; depth++, error = own(error, "cause")) {
    const code = own(error, "code"), name = own(error, "name");
    if (typeof code === "string" && Object.hasOwn(codes, code)) return codes[code];
    if (typeof name === "string" && Object.hasOwn(names, name)) return names[name];
  }
  return ["uncaughtException", "unhandledRejection"].includes(failureType) ? "unhandled-error" : "unknown";
}

export function createBackendObservation(catalogue, runId) {
  const findings = [];
  let events = 0, inputTruncated = false, outputTruncated = false, summary, invalid = false;
  return {
    add(event) {
      if (++events > eventLimit) { inputTruncated = true; return; }
      const type = own(event, "type"), data = own(event, "data");
      if (type === "test:summary" && own(data, "file") === undefined) {
        const counts = own(data, "counts");
        const values = Object.fromEntries(["tests", "passed", "failed", "cancelled", "skipped", "todo"]
          .map((key) => [key, count(own(counts, key))]));
        if (summary || Object.values(values).includes("unknown") || typeof own(data, "success") !== "boolean") invalid = true;
        else summary = { success: own(data, "success"), counts: values };
      }
      if (type !== "test:fail") return;
      if (findings.length >= findingLimit) { outputTruncated = true; return; }
      const error = own(own(data, "details"), "error"), suppliedType = own(error, "failureType");
      const failureType = failureTypes.includes(suppliedType) ? suppliedType : "unknown";
      findings.push({
        ...trustedIdentity(catalogue, own(data, "file"), own(data, "line"), own(data, "column")),
        category: errorCategory(error, failureType), failureType,
        nesting: count(own(data, "nesting")), ordinal: count(own(data, "testNumber")),
      });
    },
    snapshot() {
      const result = {
        version: 1, kind: catalogue.scope === "linux-platform" ? "platform-test-diagnostics" : "backend-test-diagnostics", acceptance: false,
        runId: typeof runId === "string" && /^[a-f0-9-]{36}$/.test(runId) ? runId : "unknown",
        catalogueFingerprint: catalogue.fingerprint ?? "unknown",
        availability: summary && !invalid && !inputTruncated && !outputTruncated ? "complete" : "incomplete",
        collectionStatus: "completed",
        inputTruncated, outputTruncated,
        summary: summary ?? "unknown", findings: findings.map((item) => ({ ...item })),
      };
      while (Buffer.byteLength(JSON.stringify(result)) > outputLimit && result.findings.length) {
        result.findings.pop();
        result.outputTruncated = true;
        result.availability = "incomplete";
      }
      return result;
    },
  };
}

function compatibleNodeOptions(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 16384) throw new Error("Unsupported backend Node option configuration.");
  if (value.includes("${")) {
    throw Object.assign(new Error("Backend diagnostics do not support interpolation-bearing Node options."), { diagnosticCode: "options-interpolation" });
  }
  const options = [];
  let token = "", quote;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote && character === "\\") {
      if (++index >= value.length) throw new Error("Unsupported NODE_OPTIONS quoting.");
      token += value[index];
    } else if (character === quote) quote = undefined;
    else if (!quote && character === '"') quote = character;
    else if (!quote && character === " ") {
      if (token) options.push(token);
      token = "";
    } else token += character;
  }
  if (quote) throw new Error("Unsupported NODE_OPTIONS quoting.");
  if (token) options.push(token);
  if (options.some((option) => ["--test-reporter", "--test-reporter-destination", "--no-enable-source-maps"]
    .includes(option.split("=")[0].replaceAll("_", "-")))) {
    throw new Error("Backend diagnostics refuse conflicting reporter or source-map configuration.");
  }
  return value;
}

const npmOptionsKey = (key) => key.toLowerCase().replaceAll("-", "_") === "npm_config_node_options";

export function backendDiagnosticEnvironment(root, runId, env = process.env, npmNodeOptions) {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Backend diagnostics require a fresh invocation.");
  const nodeKeys = Object.keys(env).filter((key) => key.toUpperCase() === "NODE_OPTIONS");
  for (const key of nodeKeys) compatibleNodeOptions(env[key]);
  const original = compatibleNodeOptions(env.NODE_OPTIONS ?? env[nodeKeys[0]]);
  const configured = Object.keys(env).filter(npmOptionsKey);
  for (const key of configured) compatibleNodeOptions(env[key]);
  const effective = compatibleNodeOptions(npmNodeOptions ?? env[configured[0]]) || original;
  const reporter = pathToFileURL(path.join(root, "scripts", "backend-diagnostics.mjs")).href;
  const result = { ...env, DEVPOCKET_BACKEND_DIAGNOSTIC_ID: runId, DEVPOCKET_TEST_DIAGNOSTIC_SCOPE: "backend" };
  for (const key of nodeKeys) delete result[key];
  if (nodeKeys.length) result.NODE_OPTIONS = original;
  for (const key of configured) delete result[key];
  result.npm_config_node_options =
    `${effective} --enable-source-maps --test-reporter=${reporter} --test-reporter-destination=stdout`.trim();
  return result;
}

export async function prepareBackendDiagnosticEnvironment(root, runId, env = process.env, signal) {
  backendDiagnosticEnvironment(root, runId, env);
  const { runCommand } = await import("./process.mjs");
  let configured;
  try {
    const result = await runCommand("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
      "& npm config get node-options; exit $LASTEXITCODE"], { cwd: root, env, timeoutMs: 30000, signal });
    if (result.processTreeStopped !== true || Buffer.byteLength(result.stdout) > 16384) {
      throw new Error("Incomplete npm configuration observation.");
    }
    const value = result.stdout.replace(/\r?\n$/, "");
    configured = value === "null" ? null : value;
  } catch (error) {
    const { failureDetails } = await import("./diagnostic-errors.mjs");
    const known = failureDetails(error, "configuration");
    throw Object.assign(new Error("Backend diagnostic preflight could not resolve effective npm node-options with confirmed cleanup."), {
      diagnosticCode: known.reason, commandOutcome: error.commandOutcome, processTreeStopped: error.processTreeStopped,
    });
  }
  return backendDiagnosticEnvironment(root, runId, env, configured);
}

export default async function* backendReporter(source) {
  let catalogue, collectionError;
  try { catalogue = await backendTestCatalogue(process.cwd(), process.env.DEVPOCKET_TEST_DIAGNOSTIC_SCOPE ?? "backend"); }
  catch { collectionError = "catalogue-unavailable"; }
  const observation = createBackendObservation(catalogue ?? { root: process.cwd(), files: [] },
    process.env.DEVPOCKET_BACKEND_DIAGNOSTIC_ID);
  for await (const event of source) observation.add(event);
  const result = observation.snapshot();
  if (collectionError) Object.assign(result, { availability: "incomplete", collectionError, collectionStatus: "failed" });
  yield `${prefix}${JSON.stringify(result)}\n`;
}

export function boundedBackendLog(value) {
  return boundedDiagnosticBytes(value);
}

export function parseBackendOutput(text, catalogue, runId) {
  const empty = (collectionError) => ({
    version: 1, kind: catalogue.scope === "linux-platform" ? "platform-test-diagnostics" : "backend-test-diagnostics", acceptance: false, runId,
    catalogueFingerprint: catalogue.fingerprint,
    availability: "incomplete", collectionError, inputTruncated: false, outputTruncated: false,
    collectionStatus: "unavailable",
    summary: "unknown", findings: [],
  });
  if (typeof text !== "string" || Buffer.byteLength(text) > privateLogLimit) return empty("input-limit");
  const frames = text.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (frames.length !== 1 || frames[0].length > outputLimit + prefix.length) return empty("missing-or-ambiguous-frame");
  let value;
  try { value = JSON.parse(frames[0].slice(prefix.length)); }
  catch { return empty("invalid-frame"); }
  if (value?.version !== 1 || value.runId !== runId) {
    return empty("invocation-or-catalogue-mismatch");
  }
  const output = empty("unknown");
  output.inputTruncated = value.inputTruncated === true;
  output.outputTruncated = value.outputTruncated === true ||
    Array.isArray(value.findings) && value.findings.length > findingLimit;
  let valid = Array.isArray(value.findings) && typeof value.inputTruncated === "boolean" &&
    typeof value.outputTruncated === "boolean";
  const counts = Object.fromEntries(["tests", "passed", "failed", "cancelled", "skipped", "todo"]
    .map((key) => [key, count(value.summary?.counts?.[key])]));
  if (!Object.values(counts).includes("unknown") && typeof value.summary?.success === "boolean") {
    output.summary = { success: value.summary.success, counts };
  } else valid = false;
  if (value.collectionError === "catalogue-unavailable" || value.collectionStatus === "failed") {
    output.collectionStatus = "failed";
    output.collectionError = value.collectionError === "catalogue-unavailable" ? "catalogue-unavailable" : "reporter-failed";
    return output;
  }
  if (value.catalogueFingerprint !== catalogue.fingerprint) return empty("invocation-or-catalogue-mismatch");
  output.collectionStatus = value.collectionStatus === "completed" ? "completed" : "unavailable";
  for (const finding of Array.isArray(value.findings) ? value.findings.slice(0, findingLimit) : []) {
    const file = catalogue.files.find((item) => item.file === finding?.file);
    const entries = file?.entries.filter((entry) => finding?.declaration?.file === file.file &&
      entry.line === finding.declaration.line && entry.column === finding.declaration.column) ?? [];
    const declaration = entries.length === 1 ? entries[0] : undefined;
    output.findings.push({
      file: file?.file ?? "unknown",
      declaration: declaration ? { file: declaration.file, line: declaration.line, column: declaration.column } : "unknown",
      category: categories.includes(finding?.category) ? finding.category : "unknown",
      failureType: failureTypes.includes(finding?.failureType) ? finding.failureType : "unknown",
      nesting: count(finding?.nesting), ordinal: count(finding?.ordinal),
    });
  }
  if (output.summary?.success === true && output.findings.length) valid = false;
  if (valid && value.availability === "complete" && !output.inputTruncated && !output.outputTruncated) {
    output.availability = "complete";
  }
  if (value.collectionError === "catalogue-unavailable") output.collectionError = "catalogue-unavailable";
  return output;
}

async function optionalFile(file, limit) {
  try { return await boundedFile(file, limit); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

async function main() {
  const { values } = parseArgs({ options: {
    directory: { type: "string", default: path.join(".data", "ci", "backend") }, github: { type: "boolean", default: false },
  } });
  const root = process.cwd(), directory = path.resolve(root, values.directory), relative = path.relative(root, directory);
  if (!["ci", "verification"].some((folder) => relative.startsWith(path.join(".data", folder) + path.sep))) {
    throw new Error("Backend diagnostic output must remain in an isolated CI or verification directory.");
  }
  let parent = root;
  for (const part of relative.split(path.sep)) {
    parent = path.join(parent, part);
    try { await mkdir(parent); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (!(await lstat(parent)).isDirectory() || !samePath(await realpath(parent), parent)) {
      throw new Error("Linked backend diagnostic directories are not supported.");
    }
  }
  const bytes = await optionalFile(path.join(directory, "report.json"), 512 * 1024);
  const report = bytes === undefined ? undefined : JSON.parse(bytes);
  const check = Array.isArray(report?.checks) ? report.checks.find((item) => item.id === "backend-tests") : undefined;
  const runId = typeof check?.backendDiagnosticRunId === "string" && /^[a-f0-9-]{36}$/.test(check.backendDiagnosticRunId)
    ? check.backendDiagnosticRunId : "unknown";
  let catalogue, catalogueFailure;
  try { catalogue = await backendTestCatalogue(root); }
  catch (error) {
    const { failureDetails } = await import("./diagnostic-errors.mjs");
    catalogue = { root, files: [], fingerprint: "unknown" };
    catalogueFailure = failureDetails(error, "collector-failed");
  }
  const log = await optionalFile(path.join(directory, "backend-tests.log"), privateLogLimit);
  const observation = parseBackendOutput(log ?? "", catalogue, runId);
  const output = {
    ...observation,
    source: /^[a-f0-9]{40}$/.test(report?.source?.head ?? "") && /^[a-f0-9]{64}$/.test(report?.source?.fingerprint ?? "")
      ? { head: report.source.head, fingerprint: report.source.fingerprint } : null,
    base: /^[a-f0-9]{40}$/.test(report?.base ?? "") ? report.base : "unknown",
    verificationStatus: ["failed", "blocked", "partial", "passed", "planned"].includes(report?.status) ? report.status : "unknown",
    checkStatus: ["failed", "blocked", "not_run", "passed"].includes(check?.status) ? check.status : "unknown",
    exitCode: Number.isInteger(check?.exitCode) && check.exitCode >= 0 && check.exitCode <= 255 ? check.exitCode : "unknown",
    privateLogTruncated: typeof check?.backendDiagnosticLogTruncated === "boolean" ? check.backendDiagnosticLogTruncated : "unknown",
    collectionStatus: observation.collectionStatus === "failed" || check?.collectionStatus === "failed" || catalogueFailure ? "failed" : observation.collectionStatus,
    catalogueFailure: catalogueFailure ?? null,
  };
  if (bytes === undefined || log === undefined || runId === "unknown") {
    Object.assign(output, { availability: "missing", findings: [], summary: "unknown" });
  }
  const encoded = JSON.stringify(output, null, 2) + "\n";
  if (Buffer.byteLength(encoded) > outputLimit) throw new Error("Backend diagnostic output exceeded its budget.");
  const { publishDiagnostic } = await import("./diagnostic-publication.mjs");
  await publishDiagnostic({ root, directory, name: "backend-diagnostics.json", value: output, limit: outputLimit, github: values.github });
  if (output.collectionStatus === "failed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch {
    console.error("Backend diagnostic export refused or failed; no raw test logs were published.");
    process.exitCode = 1;
  }
}
