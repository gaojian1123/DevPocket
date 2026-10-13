import { randomUUID } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { combineVerification, executeVerification, verificationPlan, verificationFailure, verificationFault, requirePlanCollection } from "./verification.mjs";
import { readDiagnosticReport } from "./worker-diagnostics.mjs";

let entryPhase = "arguments";

async function main() {
  const { values } = parseArgs({ options: {
    repo: { type: "string", default: process.cwd() },
    base: { type: "string" },
    report: { type: "string" },
    plan: { type: "boolean", default: false },
    all: { type: "boolean", default: false },
    group: { type: "string", default: "all" },
    jdk: { type: "string" },
    sdk: { type: "string" },
    image: { type: "string" },
    combine: { type: "boolean", default: false },
    input: { type: "string", multiple: true, default: [] },
    "backend-diagnostics": { type: "boolean", default: false },
    upstream: { type: "string", multiple: true, default: [] },
  } });
  entryPhase = "report";
  const root = path.resolve(values.repo);
  const reportPath = path.resolve(root, values.report ?? path.join(".data", "verification", randomUUID(), "report.json"));
  const relative = path.relative(root, reportPath);
  if (!["verification", "ci"].some((folder) => relative.startsWith(path.join(".data", folder) + path.sep))) {
    throw verificationFault("ownership-mismatch");
  }
  let parent = root;
  for (const part of path.relative(root, path.dirname(reportPath)).split(path.sep)) {
    parent = path.join(parent, part);
    try { await mkdir(parent); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw verificationFault("ownership-mismatch");
  }
  const output = await open(reportPath, "wx", 0o600);
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error("Verification cancelled."));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let report, plan, phase = "plan";
  try {
    try {
      plan = await verificationPlan(root, values.base, values.all);
      requirePlanCollection(plan);
      if (values.plan && values.combine) throw verificationFault("configuration");
      if (values.combine) {
        phase = "aggregate";
        if (values.input.length > 32) throw verificationFault("report-invalid");
        const reports = await Promise.all(values.input.map(async (file, inputIndex) => {
          let value;
          try { value = await readDiagnosticReport(file); }
          catch (error) { throw verificationFault(error.diagnosticCode ?? (error instanceof SyntaxError ? "report-invalid" : "report-unavailable"), { inputIndex }, error); }
          if (value === null) throw verificationFault("report-missing", { inputIndex });
          return value;
        }));
        report = combineVerification(plan, reports);
        for (const result of values.upstream) {
          const match = /^(backend|android|device):(success|failure|cancelled|skipped|unknown)$/.exec(result);
          if (!match) throw verificationFault("configuration");
          if (match[2] !== "success") throw verificationFault("upstream-job-failed", { group: match[1], outcome: match[2] });
        }
      } else {
        if (values.upstream.length) throw verificationFault("configuration");
        phase = values.plan ? "plan" : "command";
        report = values.plan ? { ...plan, status: "planned", complete: false, checks: [] }
          : await executeVerification(root, plan, { ...values, backendDiagnostics: values["backend-diagnostics"],
            directory: path.dirname(reportPath), signal: cancellation.signal });
      }
      if (["failed", "blocked"].includes(report.status)) process.exitCode = 1;
    } catch (error) {
      const failure = verificationFailure(error, error.verificationContext?.phase ?? phase);
      report = { ...plan, version: 1, status: "blocked", complete: false, failure,
        error: failure.summary + (failure.missingChecks?.length ? ` Missing checks: ${failure.missingChecks.join(", ")}.` : ""),
        checks: [] };
      process.exitCode = 1;
    }
    try {
      const bytes = JSON.stringify(report, null, 2) + "\n";
      if (Buffer.byteLength(bytes) > 512 * 1024) throw verificationFault("output-limit");
      await output.truncate(0);
      await output.writeFile(bytes);
      await output.sync();
    } catch (error) {
      console.error(JSON.stringify({
        kind: "verification-report-failure", status: "blocked", acceptance: false,
        failure: verificationFailure(error.diagnosticCode ? error : verificationFault("report-write", {}, error), "report"),
        originalStatus: report.status,
        originalFailure: report.failure ?? null,
        checks: report.checks.map((check) => ({ id: check.id, status: check.status, exitCode: check.exitCode,
          failure: check.failure ?? null, ...(check.deviceDiagnostics ? { deviceDiagnostics: check.deviceDiagnostics } : {}) })),
      }));
      process.exitCode = 1;
      return;
    }
  } finally {
    await output.close();
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
  console.log(`Verification ${report.status}: ${path.relative(root, reportPath).replaceAll("\\", "/")}`);
  if (report.failure) console.error(JSON.stringify({ kind: "verification-failure", ...report.failure }));
}

try { await main(); }
catch (error) {
  const failure = verificationFailure(error.diagnosticCode ? error
    : verificationFault(entryPhase === "arguments" ? "configuration" : "report-write", {}, error), entryPhase);
  console.error(JSON.stringify({ kind: "verification-entry-failure", status: "blocked", acceptance: false,
    diagnosticAvailability: "not-produced", failure }));
  process.exitCode = 1;
}
