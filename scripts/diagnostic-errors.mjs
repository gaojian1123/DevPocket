const reasons = {
  "command-failed": "The owned command exited unsuccessfully.",
  "command-timeout": "The owned command exceeded its deadline.",
  "command-cancelled": "The owned command was cancelled.",
  "command-signal": "The owned command supervisor exited after a signal.",
  "command-io": "The owned command communication failed.",
  "process-spawn": "The owned command could not be started.",
  "output-limit": "The private command output budget was exceeded.",
  "cleanup-failed": "Owned resource cleanup was not confirmed.",
  "report-missing": "The required report was not produced.",
  "report-invalid": "The required report is malformed or unsupported.",
  "report-unavailable": "The required report could not be read safely.",
  "report-write": "The report could not be published.",
  "source-changed": "Source changed during verification.",
  "source-unavailable": "Final source identity could not be inspected.",
  "source-mismatch": "Report source or base does not match the candidate.",
  "policy-mismatch": "Report check policy does not match the current plan.",
  "shard-missing": "A required verification shard or check is missing.",
  "check-failed": "A report or check is failed, blocked, planned, or incomplete.",
  "check-duplicate": "Duplicate or conflicting check evidence was supplied.",
  "check-unexpected": "An unknown check was supplied.",
  "check-group": "Check evidence belongs to a different group.",
  "base-invalid": "The explicit comparison base could not be resolved.",
  "plan-invalid": "The verification plan could not be established.",
  configuration: "Execution configuration is unsupported or unavailable.",
  "options-interpolation": "Backend diagnostics do not support interpolation-bearing Node options.",
  "upstream-job-failed": "A required upstream job did not complete successfully.",
  "device-evidence": "Required current device evidence is incomplete.",
  "acceleration-evidence": "Linux device evidence requires usable KVM acceleration.",
  "case-evidence": "Required native cases are missing, skipped, duplicated or inconsistent.",
  "apk-unavailable": "A required tested APK could not be read.",
  "apk-mismatch": "The tested APK identity does not match the retained artifact.",
  discovery: "The required native test discovery did not complete.",
  instrumentation: "Instrumentation did not complete every required test.",
  "resource-unavailable": "A required local execution resource is unavailable.",
  "readiness-timeout": "The required readiness condition did not arrive before its deadline.",
  "lease-timeout": "No emulator slot became available before the queue deadline.",
  "worker-exited": "An owned worker exited before the operation completed.",
  "ownership-mismatch": "Execution resource ownership could not be confirmed.",
  "collector-failed": "Secondary diagnostic collection did not complete.",
  unknown: "The failure category is unavailable.",
};
const osCodes = ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "EPIPE", "EEXIST", "EBUSY", "EISDIR", "ENOTDIR",
  "EADDRINUSE", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"];
const signals = ["SIGABRT", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGTRAP"];

export function ownValue(value, key) {
  if (!value || typeof value !== "object") return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; }
  catch { return undefined; }
}

export function diagnosticVersion(value) {
  return typeof value === "string" && value.length <= 48 &&
    /^\d{1,4}(?:\.\d{1,4}){0,5}(?:[+-]\d{1,6})?$/.test(value) ? value : undefined;
}

export function diagnosticError(reason, cause) {
  const code = typeof reason === "string" && Object.hasOwn(reasons, reason) ? reason : "unknown";
  return Object.assign(new Error(reasons[code], cause === undefined ? undefined : { cause }), { diagnosticCode: code });
}

export function contextualFailure(error, signal) {
  if (signal?.aborted && error === signal.reason && !ownValue(error, "diagnosticCode")) {
    return diagnosticError("command-cancelled", error);
  }
  return error instanceof Error ? error : diagnosticError("unknown", error);
}

export function failureDetails(error, fallback = "unknown") {
  const supplied = ownValue(error, "diagnosticCode");
  const code = ownValue(error, "code");
  const command = ownValue(error, "commandOutcome");
  const termination = ownValue(command, "reason");
  let nativeAbort = false;
  try {
    nativeAbort = typeof DOMException === "function" && error instanceof DOMException &&
      Object.getOwnPropertyDescriptor(DOMException.prototype, "name").get.call(error) === "AbortError";
  } catch { /* Non-DOM exceptions have no native abort brand. */ }
  const terminations = { timeout: "command-timeout", cancelled: "command-cancelled", "output-limit": "output-limit",
    spawn: "process-spawn", signal: "command-signal", io: "command-io" };
  const knownTermination = typeof termination === "string" && Object.hasOwn(terminations, termination) ? terminations[termination] : undefined;
  const reason = typeof supplied === "string" && Object.hasOwn(reasons, supplied) ? supplied
    : knownTermination ?? (code === "ABORT_ERR" || nativeAbort ? "command-cancelled"
      : code === "EMULATOR_SLOT_TIMEOUT" ? "lease-timeout" : Number.isInteger(code) ? "command-failed"
      : typeof fallback === "string" && Object.hasOwn(reasons, fallback) ? fallback : "unknown");
  const observedCode = ownValue(command, "exitCode") ?? code;
  const signal = ownValue(command, "signal");
  const stopped = ownValue(error, "processTreeStopped");
  return {
    reason, summary: reasons[reason],
    observedProcess: ownValue(command, "observedProcess") === "owned-command-supervisor" ? "owned-command-supervisor" : "unknown",
    exitCode: Number.isInteger(observedCode) && observedCode >= -2147483648 && observedCode <= 4294967295 ? observedCode : "unknown",
    signal: signals.includes(signal) ? signal : signal === null && Number.isInteger(observedCode) ? "none" : "unknown",
    osCode: osCodes.includes(code) ? code : "unknown",
    processTreeStopped: typeof stopped === "boolean" ? stopped : "unknown",
    outputTruncated: typeof ownValue(command, "outputTruncated") === "boolean" ? ownValue(command, "outputTruncated") : "unknown",
  };
}

export function projectFailureDetails(value) {
  const code = ownValue(value, "reason"), exit = ownValue(value, "exitCode"), signal = ownValue(value, "signal");
  const reason = typeof code === "string" && Object.hasOwn(reasons, code) ? code : "unknown";
  const osCode = ownValue(value, "osCode"), stopped = ownValue(value, "processTreeStopped");
  return {
    reason, summary: reasons[reason],
    observedProcess: ownValue(value, "observedProcess") === "owned-command-supervisor" ? "owned-command-supervisor" : "unknown",
    exitCode: Number.isInteger(exit) && exit >= -2147483648 && exit <= 4294967295 ? exit : "unknown",
    signal: signals.includes(signal) ? signal : signal === "none" && Number.isInteger(exit) ? "none" : "unknown",
    osCode: osCodes.includes(osCode) ? osCode : "unknown",
    processTreeStopped: typeof stopped === "boolean" ? stopped : "unknown",
    outputTruncated: typeof ownValue(value, "outputTruncated") === "boolean" ? ownValue(value, "outputTruncated") : "unknown",
  };
}

export function commandDetails(value) {
  const exit = ownValue(value, "exitCode"), signal = ownValue(value, "signal"), bytes = ownValue(value, "capturedBytes");
  const reason = ownValue(value, "reason");
  return {
    observedProcess: ownValue(value, "observedProcess") === "owned-command-supervisor" ? "owned-command-supervisor" : "unknown",
    reason: ["exit", "timeout", "cancelled", "output-limit", "spawn", "signal", "io"].includes(reason) ? reason : "unknown",
    exitCode: Number.isInteger(exit) && exit >= -2147483648 && exit <= 4294967295 ? exit : "unknown",
    signal: signals.includes(signal) ? signal : signal === null && Number.isInteger(exit) ? "none" : "unknown",
    capturedBytes: Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 16 * 1024 * 1024 ? bytes : "unknown",
    outputTruncated: typeof ownValue(value, "outputTruncated") === "boolean" ? ownValue(value, "outputTruncated") : "unknown",
    cleanupFailure: ownValue(value, "cleanupFailure") ? projectFailureDetails(ownValue(value, "cleanupFailure")) : null,
  };
}
