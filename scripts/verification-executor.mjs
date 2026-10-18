import { open } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./process.mjs";
import { sourceSnapshot } from "./git-state.mjs";
import { diagnosticError, failureDetails, commandDetails } from "./diagnostic-errors.mjs";
import { boundedDiagnosticBytes } from "./bounded-worker-log.mjs";
import { CHECKS, CHECK_GROUPS } from "./verification-policy.mjs";
import { combineVerification, requireCheckPolicy, requirePlanCollection, verificationFailure, verificationFault } from "./verification.mjs";
import { backendVerification, prepareBackendVerification } from "./verification-backend.mjs";
import { androidVerification } from "./verification-android.mjs";
import { acquireVerificationLock, openVerificationRun, readVerificationRun } from "./verification-run.mjs";
import { verificationArtifacts, verificationExecutionPolicy, verificationPreflight } from "./verification-preflight.mjs";
import { candidateReusableChecks, capturePromotionContext, prepareVerificationTransition, validateCandidateVerification } from "./verification-transition.mjs";

function reportFor(plan, group, checks) {
  const failed = checks.some((check) => check.status === "failed");
  const blocked = checks.some((check) => check.status === "blocked");
  const complete = checks.every((check) => check.status === "passed");
  return { ...plan, group, checks, complete, status: failed ? "failed" : blocked ? "blocked" : complete ? "passed" : "partial",
    environment: { node: process.version, platform: process.platform } };
}

function checkCleanupConfirmed(check) {
  if (check.status === "not_run" || check.executionState === "not-started") return true;
  if (check.executionState !== "exited" || check.commandOutcome?.cleanupFailure !== null) return false;
  if (check.id !== "android-device") return true;
  if (check.diagnosticIssues?.some((issue) => issue.operation === "controller-cleanup")) return false;
  return check.cleanup === "completed" ||
    check.cleanup === undefined && check.deviceEvidence?.cleanup === "completed";
}

export async function executeVerification(root, plan, options = {}) {
  requirePlanCollection(plan);
  requireCheckPolicy(plan);
  const group = options.group ?? "all";
  if (!["all", ...CHECK_GROUPS].includes(group)) throw verificationFault("configuration");
  const checks = plan.requiredChecks.map((id) => ({ id, status: "not_run" }));
  const selected = plan.requiredGroups.filter((item) => group === "all" || item === group);
  const release = await acquireVerificationLock(root);
  let run, preflight, report, sourceFailure, policy, transition, qualificationFailed = false,
    policyChanged = false, changed = false, safe = true, finished = false;
  const recovery = { reused: [], reusedChecks: [], invalidated: [], executed: [] };
  const qualifiedGroups = new Set();
  let candidateChecks = new Map();
  try {
    try {
      policy = await verificationExecutionPolicy();
      transition = options.promote ? await prepareVerificationTransition(root, plan, options)
        : options.resume ? (await readVerificationRun(root, options.resume)).manifest.transition : null;
      const promotionContext = transition ? null : await capturePromotionContext(root, plan);
      run = await openVerificationRun(root, plan, { ...options, transition }, policy, promotionContext);
      const backend = await prepareBackendVerification(root, plan, options);
      preflight = await verificationPreflight(root, plan, options);
      safe = !preflight.groups.some((item) => item.issues.some(({ failure }) =>
        failure.observedProcess === "owned-command-supervisor" && failure.processTreeStopped !== true));
      if (preflight.status !== "passed") {
        for (const item of preflight.groups.filter((item) => item.status !== "passed")) {
          const check = checks.find((check) => CHECKS.find((definition) => definition.id === check.id).group === item.group);
          const issue = item.issues[0];
          Object.assign(check, { status: "blocked", executionState: "not-started", exitCode: null,
            failure: { ...issue.failure, phase: "preflight", check: check.id, group: item.group, prerequisite: issue.prerequisite },
            reason: `${issue.failure.summary} (${issue.prerequisite}).` });
        }
      } else {
        candidateChecks = transition ? await candidateReusableChecks(root, plan, transition, preflight, options) : new Map();
        for (const selectedGroup of selected) {
          options.signal?.throwIfAborted();
          const before = preflight.groups.find((item) => item.group === selectedGroup);
          const reusable = await run.reusable(selectedGroup, before.fingerprint,
            await verificationArtifacts(root, plan, selectedGroup), before.reusable, candidateChecks);
          if (reusable.status === "reused") {
            for (const saved of reusable.report.checks.filter((item) => item.status === "passed")) {
              Object.assign(checks.find((item) => item.id === saved.id), saved);
            }
            recovery.reused.push({ group: selectedGroup, attempt: reusable.attempt });
            continue;
          }
          if (reusable.status === "invalidated") recovery.invalidated.push({ group: selectedGroup, reason: reusable.reason });
          recovery.executed.push(selectedGroup);
          const selectedChecks = checks.filter((check) => CHECKS.find((item) => item.id === check.id).group === selectedGroup);
          for (const check of selectedChecks) {
            if (candidateChecks.has(check.id)) {
              Object.assign(check, candidateChecks.get(check.id));
              recovery.reusedChecks.push(check.id);
              continue;
            }
            safe = false;
            await executeCheck(root, plan, check, options, backend);
            safe = checks.every(checkCleanupConfirmed);
            if (check.status !== "passed") break;
          }
          const groupChecks = checks.map((check) => selectedChecks.includes(check) ? structuredClone(check) : { id: check.id, status: "not_run" });
          await run.record(reportFor(plan, selectedGroup, groupChecks), before.fingerprint,
            await verificationArtifacts(root, plan, selectedGroup), before.reusable, candidateChecks);
          try {
            const current = await sourceSnapshot(root);
            changed ||= current.head !== plan.source.head || current.fingerprint !== plan.source.fingerprint;
          } catch (error) {
            sourceFailure = verificationFailure(verificationFault("source-unavailable", {}, error), "source-validation");
          }
          if (changed || sourceFailure || selectedChecks.some((check) => check.status !== "passed")) break;
        }
        if (!options.signal?.aborted && checks.some((check) => check.status === "passed")) {
          const after = await verificationPreflight(root, plan, options);
          safe &&= !after.groups.some((item) => item.issues.some(({ failure }) =>
            failure.observedProcess === "owned-command-supervisor" && failure.processTreeStopped !== true));
          let environmentFailure;
          for (const before of preflight.groups) {
            if (!checks.some((check) => check.status === "passed" && CHECKS.find((item) => item.id === check.id).group === before.group)) continue;
            const current = after.groups.find((item) => item.group === before.group);
            if (current?.status !== "passed" || current.fingerprint !== before.fingerprint) {
              environmentFailure ??= verificationFault("environment-changed", { phase: "preflight", group: before.group });
            } else if (checks.filter((check) => CHECKS.find((item) => item.id === check.id).group === before.group)
              .every((check) => check.status === "passed")) {
              qualifiedGroups.add(before.group);
            }
          }
          for (const reused of recovery.reused) {
            if (!qualifiedGroups.has(reused.group)) continue;
            const current = after.groups.find((item) => item.group === reused.group);
            if ((await run.reusable(reused.group, current.fingerprint,
              await verificationArtifacts(root, plan, reused.group), current.reusable, candidateChecks)).status !== "reused") {
              qualifiedGroups.delete(reused.group);
              environmentFailure ??= verificationFault("artifact-changed", { phase: "artifact-validation", group: reused.group });
            }
          }
          preflight = after;
          if (environmentFailure) throw environmentFailure;
        }
      }
      report = { ...reportFor(plan, group, checks), preflight, run: run.reference, recovery,
        ...(transition ? { transition } : { candidateConversion: run.promotion }) };
    } catch (error) {
      if (error.processTreeStopped === false) safe = false;
      const failure = verificationFailure(error, error.verificationContext?.phase ?? "preflight");
      report = { ...reportFor(plan, group, checks), status: "blocked", complete: false, failure, error: failure.summary,
        ...(preflight ? { preflight } : {}), ...(run ? { run: run.reference } : {}), recovery, ...(transition ? { transition } : {}) };
    }
    try {
      const current = await sourceSnapshot(root);
      changed ||= current.head !== plan.source.head || current.fingerprint !== plan.source.fingerprint;
    } catch (error) {
      sourceFailure = verificationFailure(verificationFault("source-unavailable", {}, error), "source-validation");
    }
    if (changed || sourceFailure) {
      Object.assign(report, { complete: false, status: changed ? "failed" : "blocked",
        ...(sourceFailure ? { sourceValidation: { status: "failed", failure: sourceFailure } } : {}),
        ...(changed ? { error: "Source changed during verification. Regenerate/review the change and run again.",
          failure: verificationFailure(verificationFault("source-changed"), "source-validation") } : {}) });
    }
    if (policy) {
      try { policyChanged = await verificationExecutionPolicy() !== policy; }
      catch (error) {
        policyChanged = true;
        report.policyValidation = { status: "failed", failure: verificationFailure(verificationFault("policy-mismatch", {}, error), "preflight") };
      }
      if (policyChanged) Object.assign(report, { status: "blocked", complete: false,
        failure: verificationFailure(verificationFault("policy-mismatch"), "preflight") });
    }
    if (report.complete && selected.some((group) => !qualifiedGroups.has(group))) {
      const failure = verificationFailure(verificationFault("environment-unconfirmed"), "preflight");
      Object.assign(report, { complete: false, status: "blocked", failure, error: failure.summary });
    }
    if (report.complete) {
      try {
        if (transition) await validateCandidateVerification(root, plan, report, { ...options, recorded: false, preflight });
        else combineVerification(plan, [report]);
      } catch (error) {
        qualificationFailed = true;
        const failure = verificationFailure(error, error.verificationContext?.phase ?? "aggregate");
        Object.assign(report, { complete: false, status: "blocked", failure, error: failure.summary });
      }
    }
    if (run) {
      await run.finish(report, safe && !changed && !sourceFailure && !policyChanged && !qualificationFailed, [...qualifiedGroups]);
      finished = true;
    }
    return report;
  } finally {
    await release(safe && (!run || finished));
  }
}

async function executeCheck(root, plan, check, options, backend) {
  const definition = CHECKS.find((item) => item.id === check.id);
  const adapter = definition.group === "tooling" ? {
    args: ["-NoProfile", "-NonInteractive", "-Command", "& npm run test:workflow; exit $LASTEXITCODE"],
    timeoutMs: 30 * 60_000, graceMs: 5000,
  } : definition.group === "backend" ? backendVerification(root, check, backend)
    : await androidVerification(root, check, plan, options);
  const started = Date.now();
  const log = path.join(options.directory, `${check.id}.log`);
  let logFile, checkPhase = "log", retainedLog = Buffer.alloc(0), logTruncated = false;
  check.executionState = "not-started";
  const logIssue = (error) => {
    check.collectionStatus = "failed";
    check.diagnosticIssues = [...(check.diagnosticIssues ?? []),
      { operation: "private-log", ...failureDetails(error, "report-write") }];
  };
  const writeLog = async (text) => {
    if (!logFile) return false;
    const part = boundedDiagnosticBytes(text);
    const bounded = boundedDiagnosticBytes(Buffer.concat([retainedLog, part.bytes]));
    retainedLog = bounded.bytes;
    logTruncated ||= part.truncated || bounded.truncated;
    check.privateLog = { availability: "pending", truncated: logTruncated, retainedBytes: bounded.bytes.length };
    if (check.backendDiagnosticRunId) check.backendDiagnosticLogTruncated = logTruncated;
    try {
      await logFile.truncate(0);
      let offset = 0;
      while (offset < retainedLog.length) {
        const result = await logFile.write(retainedLog, offset, retainedLog.length - offset, offset);
        if (!result.bytesWritten) throw diagnosticError("report-write");
        offset += result.bytesWritten;
      }
      check.privateLog.availability = "retained";
      return true;
    } catch (error) {
      check.privateLog.availability = "unavailable";
      logIssue(error);
      return false;
    }
  };
  let output;
  try {
    logFile = await open(log, "wx", 0o600);
    checkPhase = "command";
    check.executionState = "started";
    check.execution = { source: structuredClone(plan.source), startedAt: new Date().toISOString() };
    output = await runCommand("pwsh", adapter.args, {
      cwd: root, env: adapter.env, timeoutMs: adapter.timeoutMs, graceMs: adapter.graceMs, signal: options.signal,
    });
    check.executionState = "exited";
    check.commandOutcome = commandDetails(output.commandOutcome);
    if (!await writeLog(output.stdout + output.stderr)) {
      checkPhase = "log";
      throw verificationFault("report-write", { check: check.id });
    }
    await adapter.accept?.(output);
    if (check.collectionStatus === "failed") throw verificationFault("collector-failed", { check: check.id });
    Object.assign(check, { status: "passed", exitCode: 0 });
  } catch (error) {
    if (!error.commandOutcome && output?.commandOutcome) error.commandOutcome = output.commandOutcome;
    check.commandOutcome = commandDetails(error.commandOutcome);
    if (check.executionState === "started") check.executionState = "exited";
    check.failure = verificationFailure(error, error.verificationContext?.phase ?? checkPhase);
    if (!logFile) {
      check.failure = { ...failureDetails(error, "report-write"), phase: "log", check: check.id };
      check.privateLog = { availability: "not-produced", truncated: false, retainedBytes: 0 };
    }
    await writeLog(`${error.stdout ?? ""}${error.stderr ?? ""}\n${error.message}\n`);
    Object.assign(check, {
      status: typeof error.code === "number" ? "failed" : "blocked",
      exitCode: typeof error.code === "number" ? error.code : null,
      reason: check.failure.summary,
    });
    await adapter.failure?.(error, output);
  } finally {
    try { await logFile?.close(); }
    catch (error) {
      logIssue(error);
      if (check.status === "passed") {
        check.status = "blocked";
        check.failure = { ...failureDetails(error, "report-write"), phase: "log", check: check.id };
        check.reason = check.failure.summary;
      }
    }
  }
  check.durationMs = Date.now() - started;
  if (check.execution) check.execution.completedAt = new Date().toISOString();
  check.log = path.relative(root, log);
}
