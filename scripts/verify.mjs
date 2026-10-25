import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { executeVerification, validateVerificationEvidence, verificationPlan, verificationFailure, verificationFault,
  requirePlanCollection, requireVerificationReportPath } from "./verification.mjs";
import { readDiagnosticReport } from "./worker-diagnostics.mjs";
import { CHECK_GROUPS, VERIFICATION_REPORT_VERSION } from "./verification-policy.mjs";

let entryPhase = "arguments";

async function main() {
  const { values } = parseArgs({ options: {
    repo: { type: "string", default: process.cwd() },
    base: { type: "string" },
    report: { type: "string" },
    plan: { type: "boolean", default: false },
    all: { type: "boolean", default: false },
    group: { type: "string", default: "all" },
    "tooling-shard": { type: "string" },
    resume: { type: "string" },
    refinement: { type: "string" },
    "capture-refinement-context": { type: "boolean", default: false },
    promote: { type: "string" },
    "candidate-request": { type: "string" },
    "candidate-evidence": { type: "boolean", default: false },
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
  await requireVerificationReportPath(root, reportPath, [values.resume, values.promote]);
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
      if (values.refinement) {
        if (values.plan || values.all || values["capture-refinement-context"] || values.group !== "all" || values["tooling-shard"] ||
            values.resume || values.promote || values["candidate-request"] || values["candidate-evidence"] ||
            values.combine || values.input.length || values.upstream.length || values["backend-diagnostics"] ||
            values.jdk || values.sdk || values.image) throw verificationFault("configuration");
        const { executeLocalRefinement } = await import("./verification-refinement.mjs");
        report = await executeLocalRefinement(root, values.base, values.refinement, cancellation.signal);
      } else {
        if (values["capture-refinement-context"] && (values.plan || values.combine || values.promote)) {
          throw verificationFault("configuration");
        }
        plan = await verificationPlan(root, values.base, values.all);
        requirePlanCollection(plan);
        if (!["all", ...CHECK_GROUPS].includes(values.group)) throw verificationFault("configuration");
        if (values["tooling-shard"] && (values.group !== "tooling" || values.plan || values.combine || values.promote)) {
          throw verificationFault("configuration");
        }
        if (values.plan && values.combine || values.resume && (values.plan || values.combine || values.input.length)) {
          throw verificationFault("configuration");
        }
        if (values.promote && (values.plan || values.combine || values.resume || values.input.length || values.group !== "all") ||
            Boolean(values.promote) !== Boolean(values["candidate-request"]) ||
            values["candidate-evidence"] && !values.combine) throw verificationFault("configuration");
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
          report = await validateVerificationEvidence(root, plan, reports, { ...values,
            candidateEvidence: values["candidate-evidence"], backendDiagnostics: values["backend-diagnostics"] });
          const upstream = new Map();
          for (const result of values.upstream) {
            const [group, outcome, extra] = result.split(":");
            if (!CHECK_GROUPS.includes(group) || extra !== undefined || upstream.has(group) ||
                !["success", "failure", "cancelled", "skipped", "unknown"].includes(outcome)) throw verificationFault("configuration");
            upstream.set(group, outcome);
          }
          if (upstream.size) for (const group of plan.requiredGroups) {
            const outcome = upstream.get(group) ?? "unknown";
            if (outcome !== "success") throw verificationFault("upstream-job-failed", { group, outcome });
          }
        } else {
          if (values.upstream.length) throw verificationFault("configuration");
          phase = values.plan ? "plan" : "command";
          report = values.plan ? { ...plan, status: "planned", complete: false, checks: [] }
            : await executeVerification(root, plan, { ...values, backendDiagnostics: values["backend-diagnostics"],
              toolingShard: values["tooling-shard"],
              captureRefinementContext: values["capture-refinement-context"],
              candidateRequest: values["candidate-request"],
              directory: path.dirname(reportPath), signal: cancellation.signal });
        }
      }
      if (["failed", "blocked", "full_required"].includes(report.status)) process.exitCode = 1;
    } catch (error) {
      const failure = verificationFailure(error, error.verificationContext?.phase ?? phase);
      report = { ...plan, version: values.refinement ? 2 : VERIFICATION_REPORT_VERSION,
        ...(values.refinement ? { kind: "local-refinement-failure", acceptance: false } : {}),
        status: "blocked", complete: false, failure,
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
      if (report.kind === "local-refinement-checkpoint-subject") {
        console.log(`Checkpoint subject SHA256: ${createHash("sha256").update(bytes).digest("hex")}`);
      }
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
  if (report.run) console.log(`Verification run: ${report.run.manifest.replaceAll("\\", "/")} (attempt ${report.run.attempt})`);
  if (report.preflight?.status === "blocked") {
    console.error(JSON.stringify({ kind: "verification-preflight", ...report.preflight }));
  }
  if (report.kind?.startsWith("local-refinement-")) console.log(JSON.stringify({
    kind: report.kind, acceptance: false, reviewRequired: report.reviewRequired ?? false,
    changedFiles: report.changedFiles, selection: report.selection, reasons: report.reasons,
  }));
  else if (report.status === "planned") console.log(JSON.stringify({
    kind: "verification-plan", requiredChecks: report.requiredChecks, requiredGroups: report.requiredGroups,
    layouts: report.layouts, ciMacos: report.ciMacos, selectionReasons: report.selectionReasons, toolingShards: report.toolingShards ?? null,
  }));
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
