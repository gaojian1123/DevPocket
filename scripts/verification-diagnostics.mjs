import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readOnlyGit } from "./verification.mjs";
import { CHECKS, CHECK_GROUPS, diagnosticCheckGroup, isDiagnosticVerificationVersion, projectVerificationSelection } from "./verification-policy.mjs";
import { readDiagnosticReport } from "./worker-diagnostics.mjs";
import { readBoundedLog } from "./android-diagnostics.mjs";
import { commandDetails, diagnosticError, failureDetails, ownValue, projectFailureDetails } from "./diagnostic-errors.mjs";
import { diagnosticDirectory, publishDiagnostic } from "./diagnostic-publication.mjs";
import { deviceSourceCatalogue } from "./device-diagnostics.mjs";
import { projectStartupReport } from "./native-startup.mjs";

const phases = ["arguments", "plan", "preflight", "command", "device-validation", "artifact-validation",
  "source-validation", "log", "aggregate", "report"];
const states = ["passed", "failed", "blocked", "not_run"];
const issueOperations = ["private-log", "device-catalogue", "device-report", "backend-catalogue", "controller-cleanup"];
const exceptions = ["AssertionError", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "ModuleNotFoundError", "ImportError", "PermissionError", "FileNotFoundError", "TimeoutError", "ConnectionError"];

function projectedFailure(value) {
  const result = projectFailureDetails(value);
  const phase = ownValue(value, "phase"), check = ownValue(value, "check"), group = ownValue(value, "group");
  const index = ownValue(value, "inputIndex"), artifact = ownValue(value, "artifact"), missing = ownValue(value, "missingChecks");
  const outcome = ownValue(value, "outcome");
  return {
    ...result, phase: phases.includes(phase) ? phase : "unknown",
    ...(CHECKS.some((item) => item.id === check) ? { check } : {}),
    ...(["all", ...CHECK_GROUPS].includes(group) ? { group } : {}),
    ...(["success", "failure", "cancelled", "skipped", "unknown"].includes(outcome) ? { outcome } : {}),
    ...(Number.isInteger(index) && index >= 0 && index < 32 ? { inputIndex: index } : {}),
    ...(["app", "instrumentation"].includes(artifact) ? { artifact } : {}),
    ...(Array.isArray(missing) ? { missingChecks: CHECKS.filter((item) => missing.includes(item.id)).map((item) => item.id) } : {}),
  };
}

async function diagnosticSourceIndex(root) {
  const values = (await readOnlyGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  if (values.length > 8192) throw diagnosticError("output-limit");
  return { paths: new Set(values), sources: new Set(values.filter((file) => file.length <= 240 &&
    /^(?:backend|scripts|deployment|android|test-fixtures)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|mjs|js|py|ps1|kt|kts|java|xml)$/.test(file))) };
}

export async function diagnosticSourceFiles(root) {
  return (await diagnosticSourceIndex(root)).sources;
}

export function checkLogHints(text, root, sources, check = "unknown") {
  const findings = [];
  const seen = new Set();
  const add = (value) => {
    const key = JSON.stringify(value);
    if (findings.length < 12 && !seen.has(key)) { seen.add(key); findings.push(value); }
  };
  const location = (value, line, column) => {
    try {
      const absolute = value.startsWith("file:") ? fileURLToPath(value) : path.resolve(root, value);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (sources.has(relative) && Number.isInteger(line) && line > 0 && line <= 1_000_000) {
        return { file: relative, line, ...(Number.isInteger(column) && column > 0 && column <= 100000 ? { column } : {}) };
      }
    } catch { return undefined; }
  };
  for (const raw of text.split(/\r?\n/)) {
    if (raw.length > 4096) continue;
    const line = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    const compiler = /^(.+\.tsx?)\((\d{1,6}),(\d{1,6})\): error (TS\d{4,5}):/.exec(line);
    if (compiler) {
      const source = location(compiler[1], Number(compiler[2]), Number(compiler[3]));
      if (source) add({ kind: "compiler", code: compiler[4], ...source });
    }
    const exception = /^[ \t]*(?:error: )?([A-Za-z]+Error)(?::|\s+\[)/.exec(line);
    if (exception && exceptions.includes(exception[1])) add({ kind: "exception", type: exception[1] });
    const frame = /^[ \t]*File "([^"]+)", line (\d{1,6})(?:,|$)/.exec(line);
    if (frame) {
      const source = location(frame[1], Number(frame[2]));
      if (source) add({ kind: "source-frame", ...source });
    }
    const test = check === "workflow-tests" ? /^test at (.+\.mjs):(\d{1,6}):(\d{1,6})$/.exec(line.trim()) : undefined;
    if (test) {
      const source = location(test[1], Number(test[2]), Number(test[3]));
      if (source) add({ kind: "test-declaration-hint", ...source });
    }
    for (const code of ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_ASSERTION", "ENOSPC", "EBUSY", "EISDIR",
      "ENOTDIR", "EACCES", "EPERM", "EADDRINUSE", "ECONNREFUSED"]) {
      if (new RegExp(`^[ \\t]*(?:code: ['"])?${code}(?:['":,]|$)`).test(line)) add({ kind: "error-code", code });
    }
  }
  return findings;
}

export async function collectVerificationDiagnostics(root, directory, job, stepResult = "unknown", expectedOwner) {
  if (!["plan", ...CHECK_GROUPS, "gate", "startup"].includes(job)) throw diagnosticError("configuration");
  let report, collectorFailure, sourceHintsFailure, startupEntry, sources = new Set(), sourcePaths = new Set();
  const collectionErrors = [];
  const file = job === "gate" ? "gate.json" : job === "plan" ? "plan.json" : job === "startup" ? "startup-report.json" : "report.json";
  try { report = await readDiagnosticReport(path.join(directory, file)); }
  catch (error) { collectorFailure = failureDetails(error, error instanceof SyntaxError ? "report-invalid" : "report-unavailable"); }
  if (report && (job === "startup" ? report.version !== 1 || report.kind !== "native-startup-diagnostic"
    : !isDiagnosticVerificationVersion(report.version) || !Array.isArray(report.checks))) {
    collectorFailure = failureDetails(diagnosticError("report-invalid"));
  }
  if (job === "startup") {
    const validOwner = typeof expectedOwner === "string" && /^[a-f0-9-]{36}$/.test(expectedOwner);
    if (report && (!validOwner || report.runId !== expectedOwner)) {
      collectorFailure = failureDetails(diagnosticError("ownership-mismatch"));
      report = undefined;
    }
    try {
      const entry = await readDiagnosticReport(path.join(directory, "startup-entry-report.json"));
      if (entry?.kind === "native-startup-entry" && typeof entry.runId === "string" &&
          validOwner && entry.runId === expectedOwner && entry.startup?.runId === expectedOwner) {
        report = entry.startup;
        collectorFailure ??= failureDetails(diagnosticError("report-write"));
        startupEntry = {
          status: "failed", runId: entry.runId, failure: projectFailureDetails(entry.failure),
          recoveryCleanup: ["completed", "failed", "unknown", "not-attempted"].includes(entry.recoveryCleanup) ? entry.recoveryCleanup : "unknown",
          cleanupFailure: entry.cleanupFailure ? projectFailureDetails(entry.cleanupFailure) : null,
        };
      }
    } catch (error) { collectionErrors.push({ operation: "startup-entry-report", failure: failureDetails(error, "report-unavailable") }); }
  }
  try {
    const index = await diagnosticSourceIndex(root);
    sources = index.sources;
    sourcePaths = index.paths;
  }
  catch (error) {
    sourceHintsFailure = failureDetails(error, "collector-failed");
    collectionErrors.push({ operation: "source-index", failure: sourceHintsFailure });
  }
  if (!report && stepResult === "success") collectorFailure ??= failureDetails(diagnosticError("report-missing"));
  if (report?.deviceClassCatalogueFailure) {
    collectionErrors.push({ operation: "plan-catalogue", failure: projectFailureDetails(report.deviceClassCatalogueFailure) });
  }
  const checks = [];
  for (const definition of CHECKS) {
    const selected = Array.isArray(report?.checks) ? report.checks.filter((item) => item?.id === definition.id) : [];
    const group = diagnosticCheckGroup(definition, report?.version);
    if (!selected.length || (!["gate", "plan"].includes(job) && group !== job)) continue;
    if (selected.length !== 1) { collectorFailure = failureDetails(diagnosticError("report-invalid")); continue; }
    const input = selected[0], issues = ownValue(input, "diagnosticIssues");
    const check = {
      id: definition.id, status: states.includes(input.status) ? input.status : "unknown",
      exitCode: Number.isInteger(input.exitCode) && input.exitCode >= -2147483648 && input.exitCode <= 4294967295 ? input.exitCode : "unknown",
      executionState: ["not-started", "started", "exited"].includes(input.executionState) ? input.executionState : "unknown",
      reportedTestStatus: ["passed", "failed"].includes(input.reportedBackendTestStatus) ? input.reportedBackendTestStatus : "unknown",
      reportedDeviceExecutionStatus: ["passed", "failed", "blocked"].includes(input.reportedDeviceExecutionStatus)
        ? input.reportedDeviceExecutionStatus : "unknown",
      recordedCollectionStatus: input.collectionStatus === "failed" || input.reportedDeviceCollectionStatus === "failed" ||
        input.deviceDiagnostics?.collectionStatus === "failed" || input.workerDiagnostics?.collectionStatus === "failed" ? "failed" : "unknown",
      failure: input.failure ? projectedFailure(input.failure) : null,
      commandOutcome: commandDetails(input.commandOutcome),
      diagnosticIssues: (Array.isArray(issues) ? issues.slice(0, 8) : []).map((issue) => ({
        operation: issueOperations.includes(ownValue(issue, "operation")) ? ownValue(issue, "operation") : "unknown",
        ...projectFailureDetails(issue),
      })),
      privateLog: { availability: input.status === "not_run" ? "not-produced" : "not-sampled", truncated: false },
      hints: [],
    };
    const execution = input.execution;
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(execution?.source?.head ?? "") &&
        /^[a-f0-9]{64}$/.test(execution?.source?.fingerprint ?? "") &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(execution?.startedAt ?? "") &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(execution?.completedAt ?? "")) {
      check.executionEvidence = {
        kind: input.candidateReuse ? "candidate-reuse-claim" : "executed",
        source: { head: execution.source.head, fingerprint: execution.source.fingerprint },
        startedAt: execution.startedAt, completedAt: execution.completedAt, approval: "not-established",
      };
    }
    if (["failed", "blocked"].includes(input.status)) {
      if (input.privateLog?.availability === "not-produced") check.privateLog.availability = "not-produced";
      else {
        try {
          const sampled = await readBoundedLog(path.join(directory, `${definition.id}.log`));
          check.privateLog = { availability: sampled.availability, truncated: sampled.truncated || input.privateLog?.truncated === true };
          check.hints = checkLogHints(sampled.text, root, sources, definition.id);
          if (sampled.availability === "missing" && input.privateLog?.availability === "retained") {
            collectionErrors.push({ operation: "check-log", check: definition.id, failure: failureDetails(diagnosticError("report-missing")) });
          }
        } catch (error) {
          check.privateLog.availability = "invalid-or-unavailable";
          check.diagnosticIssues.push({ operation: "private-log", ...failureDetails(error, "report-unavailable") });
          collectionErrors.push({ operation: "check-log", check: definition.id, failure: failureDetails(error, "report-unavailable") });
        }
      }
    }
    checks.push(check);
  }
  let startup;
  if (job === "startup" && report && (!collectorFailure || startupEntry)) {
    let catalogue;
    try { catalogue = await deviceSourceCatalogue(root); }
    catch (error) {
      catalogue = { files: [], fingerprint: "unknown" };
      collectionErrors.push({ operation: "device-catalogue", failure: failureDetails(error, "collector-failed") });
    }
    startup = projectStartupReport(report, catalogue);
  }
  if (collectorFailure) collectionErrors.unshift({ operation: "report", failure: collectorFailure });
  return {
    version: 1, kind: "verification-diagnostics", acceptance: false, job,
    executionStep: { name: job === "plan" ? "plan" : job === "startup" ? "probe" : "verify",
      result: ["success", "failure", "cancelled", "skipped"].includes(stepResult) ? stepResult : "unknown" },
    source: typeof report?.source?.head === "string" && /^[a-f0-9]{40}$/.test(report.source.head) &&
      typeof report?.source?.fingerprint === "string" && /^[a-f0-9]{64}$/.test(report.source.fingerprint)
      ? { head: report.source.head, fingerprint: report.source.fingerprint } : null,
    base: typeof report?.base === "string" && /^[a-f0-9]{40}$/.test(report.base) ? report.base : "unknown",
    status: startup?.status ?? (["passed", "partial", "failed", "blocked", "planned", "ready", "incomplete"].includes(report?.status) ? report.status : "unknown"),
    reportAvailability: collectorFailure ? "invalid-or-unavailable" : report ? "available" : "not-produced",
    unavailableReason: report ? "not-applicable" : stepResult === "skipped" ? "step-not-run"
      : stepResult === "failure" ? "execution-failed-before-report" : stepResult === "success" ? "missing-after-success" : "unknown",
    collectorFailure: collectorFailure ?? null,
    ...(startupEntry ? { startupEntry, reportOrigin: "owned-entry-fallback" } : {}),
    collectionStatus: collectionErrors.length || checks.some((check) => check.recordedCollectionStatus === "failed") ||
      startup?.collectionStatus === "failed"
      ? "failed" : report ? "completed" : "unavailable",
    collectionErrors,
    failure: report?.failure ? projectedFailure(report.failure) : null,
    sourceValidation: report?.sourceValidation?.status === "failed"
      ? { status: "failed", failure: projectedFailure(report.sourceValidation.failure) } : null,
    sourceHintsAvailable: sources.size > 0,
    sourceHintsFailure: sourceHintsFailure ?? null,
    selection: projectVerificationSelection(report, sourcePaths),
    checks,
    ...(startup ? { startup } : {}),
    note: "Fixed check/phase/exit facts and bounded source-aware log hints only. Hints are not a proved cause. Missing reports or platform termination never establish success.",
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    directory: { type: "string" }, job: { type: "string" }, github: { type: "boolean", default: false },
    "step-result": { type: "string", default: "unknown" },
    owner: { type: "string" },
  } });
  if (!values.directory || !values.job) throw diagnosticError("configuration");
  const root = process.cwd(), directory = await diagnosticDirectory(root, values.directory);
  const result = await collectVerificationDiagnostics(root, directory, values.job, values["step-result"], values.owner);
  if (result.startup) {
    await publishDiagnostic({ root, directory: path.join(directory, "public"), name: "startup-report.json",
      value: result.startup, limit: 16384, github: values.github, outputKey: "startup_report_ready" });
  }
  await publishDiagnostic({ root, directory, name: "verification-diagnostics.json", value: result, limit: 65536, github: values.github });
  if (result.collectionStatus === "failed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    console.error(JSON.stringify({ kind: "verification-diagnostic-export", status: "failed", acceptance: false,
      diagnosticAvailability: "not-produced", failure: failureDetails(error, "collector-failed") }));
    process.exitCode = 1;
  }
}
