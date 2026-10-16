import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./process.mjs";
import { sourceSnapshot } from "./git-state.mjs";
import { diagnosticError, failureDetails, commandDetails } from "./diagnostic-errors.mjs";
import { boundedDiagnosticBytes } from "./bounded-worker-log.mjs";
import { CHECKS, CHECK_GROUPS } from "./verification-policy.mjs";
import { requireCheckPolicy, requirePlanCollection, verificationFailure, verificationFault } from "./verification.mjs";
import { backendVerification, prepareBackendVerification } from "./verification-backend.mjs";
import { androidVerification } from "./verification-android.mjs";

export async function executeVerification(root, plan, options = {}) {
  requirePlanCollection(plan);
  requireCheckPolicy(plan);
  const group = options.group ?? "all";
  if (!["all", ...CHECK_GROUPS].includes(group)) throw verificationFault("configuration");
  const checks = plan.requiredChecks.map((id) => ({ id, status: "not_run" }));
  const backend = await prepareBackendVerification(root, plan, options);
  await mkdir(options.directory, { recursive: true });
  let stopped = false;
  for (const check of checks) {
    const definition = CHECKS.find((item) => item.id === check.id);
    if (group !== "all" && group !== definition.group) continue;
    if (stopped) continue;
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
      stopped = true;
    } finally {
      try { await logFile?.close(); }
      catch (error) {
        logIssue(error);
        if (check.status === "passed") {
          check.status = "blocked";
          check.failure = { ...failureDetails(error, "report-write"), phase: "log", check: check.id };
          check.reason = check.failure.summary;
          stopped = true;
        }
      }
    }
    check.durationMs = Date.now() - started;
    check.log = path.relative(root, log);
  }
  let current, sourceFailure;
  try { current = await sourceSnapshot(root); }
  catch (error) {
    error.diagnosticCode = "source-unavailable";
    sourceFailure = verificationFailure(error, "source-validation");
  }
  const changed = current && (current.head !== plan.source.head || current.fingerprint !== plan.source.fingerprint);
  const failed = checks.some((check) => check.status === "failed");
  const blocked = checks.some((check) => check.status === "blocked");
  const complete = !sourceFailure && !changed && !failed && !blocked && checks.every((check) => check.status === "passed");
  return {
    ...plan, group, checks, complete,
    status: changed || failed ? "failed" : blocked || sourceFailure ? "blocked" : complete ? "passed" : "partial",
    ...(sourceFailure ? { sourceValidation: { status: "failed", failure: sourceFailure } } : {}),
    ...(changed ? { error: "Source changed during verification. Regenerate/review the change and run again.",
      failure: verificationFailure(verificationFault("source-changed"), "source-validation") } : {}),
    environment: { node: process.version, platform: process.platform },
  };
}
