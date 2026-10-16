import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { readOnlyGit, sourceSnapshot } from "./git-state.mjs";
import { runCommand } from "./process.mjs";
import { cleanDeviceRun } from "./device-run.mjs";
import { projectWorkerDiagnostics, readDiagnosticReport } from "./worker-diagnostics.mjs";
import { deviceSourceCatalogue, projectDeviceDiagnostics, deviceDiagnosticsFromOutput } from "./device-diagnostics.mjs";
import { diagnosticError, failureDetails, ownValue, commandDetails, diagnosticVersion } from "./diagnostic-errors.mjs";
import { boundedDiagnosticBytes } from "./bounded-worker-log.mjs";
import { CHECKS, CHECK_GROUPS, VERIFICATION_REPORT_VERSION, verificationGroups, verificationImpact } from "./verification-policy.mjs";
export { CHECKS } from "./verification-policy.mjs";
export { git, readOnlyGit, sourceSnapshot } from "./git-state.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const splitPaths = (value) => value.split("\0").filter(Boolean);
const baselineDeviceClasses = ["NativeFlowTest", "AdaptiveLayoutTest", "FixtureFlowTest"].map((name) => `dev.devpocket.app.${name}`);

export function verificationFault(reason, context = {}, cause) {
  return Object.assign(diagnosticError(reason, cause), { verificationContext: context });
}

export function verificationFailure(error, phase = "command") {
  const context = ownValue(error, "verificationContext");
  const check = ownValue(context, "check"), group = ownValue(context, "group");
  const index = ownValue(context, "inputIndex"), artifact = ownValue(context, "artifact"), missing = ownValue(context, "missing");
  const outcome = ownValue(context, "outcome");
  return {
    ...failureDetails(error),
    phase: ["arguments", "plan", "preflight", "command", "device-validation", "artifact-validation",
      "source-validation", "log", "aggregate", "report"].includes(phase) ? phase : "unknown",
    ...(CHECKS.some((item) => item.id === check) ? { check } : {}),
    ...(["all", ...CHECK_GROUPS].includes(group) ? { group } : {}),
    ...(["success", "failure", "cancelled", "skipped", "unknown"].includes(outcome) ? { outcome } : {}),
    ...(Number.isSafeInteger(index) && index >= 0 && index < 128 ? { inputIndex: index } : {}),
    ...(["app", "instrumentation"].includes(artifact) ? { artifact } : {}),
    ...(Array.isArray(missing) ? { missingChecks: CHECKS.filter((item) => missing.includes(item.id)).map((item) => item.id) } : {}),
  };
}

export async function verificationPlan(root, base, all = false) {
  if (!base || base.startsWith("-")) throw verificationFault("base-invalid");
  let baseSha;
  try { baseSha = (await readOnlyGit(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`])).trim(); }
  catch (error) { throw verificationFault("base-invalid", {}, error); }
  const source = await sourceSnapshot(root);
  const changedFiles = [...new Set([
    ...splitPaths(await readOnlyGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", baseSha, "--"])),
    ...splitPaths(await readOnlyGit(root, ["ls-files", "--others", "--exclude-standard", "-z"])),
  ])].sort();
  const impact = verificationImpact(changedFiles, all);
  const device = impact.requiredChecks.includes("android-device");
  let trustedDeviceClasses = baselineDeviceClasses;
  let deviceClassCatalogueAvailable = false;
  let deviceClassCatalogueFailure;
  if (device) {
    try {
      const catalogue = await deviceSourceCatalogue(root);
      trustedDeviceClasses = [...new Set([...baselineDeviceClasses,
        ...catalogue.files.filter((file) => file.file.startsWith("android/app/src/androidTest/"))
          .flatMap((file) => file.classes.map((item) => item.name))])].sort();
      deviceClassCatalogueAvailable = catalogue.fingerprint !== "unknown" && !catalogue.files.some((file) => file.declarationIssue);
    } catch (error) { deviceClassCatalogueFailure = failureDetails(error, "collector-failed"); }
  }
  return {
    version: VERIFICATION_REPORT_VERSION, base: baseSha, source, changedFiles, ...impact,
    ...(device ? { trustedDeviceClasses, deviceClassCatalogueAvailable,
      deviceClassCatalogueFailure: deviceClassCatalogueFailure ?? null } : {}),
  };
}

function publicDeviceEvidence(value, workerDiagnostics, deviceDiagnostics) {
  const version = (input) => diagnosticVersion(input) ?? null;
  return {
    version: 1, runId: value.runId, status: value.status, cleanup: value.cleanup, evidence: value.evidence,
    source: { head: value.source.head, fingerprint: value.source.fingerprint },
    tests: value.tests,
    cases: value.cases.map((item) => ({ name: item.name, class: item.class, tests: item.tests, status: item.status })),
    discoveredClasses: [...value.discoveredClasses],
    apkSha256: value.apkSha256, testApkSha256: value.testApkSha256,
    ...(value.platform === "linux" || value.platform === "win32" ? { platform: value.platform } : {}),
    ...(value.acceleration?.provider === "KVM" && value.acceleration.usable === true
      ? { acceleration: { provider: "KVM", usable: true } } : {}),
    image: typeof value.image === "string" &&
      /^system-images[\\/]android-\d+(?:\.\d+)?[\\/](?:google_apis(?:_playstore)?|default)[\\/]x86_64$/.test(value.image) ? value.image : "unknown",
    toolchain: Object.fromEntries(["java", "adb", "emulator", "imageRevision"].map((name) => [name, version(value.toolchain?.[name])])),
    workerDiagnostics, deviceDiagnostics,
  };
}

export function requirePlanCollection(plan) {
  if (plan.deviceClassCatalogueFailure) {
    throw verificationFault("collector-failed", { phase: "plan", check: "android-device" });
  }
}

export async function executeVerification(root, plan, options = {}) {
  requirePlanCollection(plan);
  requireCheckPolicy(plan);
  const group = options.group ?? "all";
  if (!["all", ...CHECK_GROUPS].includes(group)) throw verificationFault("configuration");
  const checks = plan.requiredChecks.map((id) => ({ id, status: "not_run" }));
  const backendDiagnostics = options.backendDiagnostics ? await import("./backend-diagnostics.mjs") : undefined;
  const backendDiagnosticRunId = backendDiagnostics && ["all", "backend"].includes(group) &&
    plan.requiredChecks.includes("backend-tests") ? randomUUID() : undefined;
  let backendDiagnosticEnv;
  try {
    backendDiagnosticEnv = backendDiagnosticRunId
      ? await backendDiagnostics.prepareBackendDiagnosticEnvironment(root, backendDiagnosticRunId, process.env, options.signal) : undefined;
  } catch (error) {
    error.verificationContext = { phase: "preflight", check: "backend-tests" };
    throw error;
  }
  await mkdir(options.directory, { recursive: true });
  let stopped = false;
  for (const check of checks) {
    const definition = CHECKS.find((item) => item.id === check.id);
    const deviceOwner = check.id === "android-device" ? randomUUID() : undefined;
    if (group !== "all" && group !== definition.group) continue;
    if (stopped) continue;
    if (deviceOwner) check.deviceRunId = deviceOwner;
    let deviceCatalogue;
    if (deviceOwner) {
      try { deviceCatalogue = await deviceSourceCatalogue(root); }
      catch (error) {
        deviceCatalogue = { files: [], fingerprint: "unknown" };
        check.collectionStatus = "failed";
        check.diagnosticIssues = [{ operation: "device-catalogue", ...failureDetails(error, "collector-failed") }];
      }
    }
    const args = definition.npm
      ? ["-NoProfile", "-NonInteractive", "-Command", `& npm ${definition.npm}; exit $LASTEXITCODE`]
      : ["-NoProfile", "-NonInteractive", "-File", path.join(root, "scripts", definition.script),
        ...definition.args];
    if (definition.script) {
      if (options.jdk) args.push("-Jdk", options.jdk);
      if (options.sdk) args.push("-Sdk", options.sdk);
      if (check.id === "android-device") {
        args.push("-RunDirectory", path.join(options.directory, "device"));
        args.push("-Owner", deviceOwner);
        if (options.image) args.push("-Image", options.image);
        if (plan.layouts) args.push("-Layouts");
      }
    }
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
      if (check.id === "backend-tests" && backendDiagnostics) {
        check.backendDiagnosticLogTruncated = logTruncated;
      }
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
      let env;
      if (check.id === "backend-tests" && backendDiagnostics) {
        check.backendDiagnosticRunId = backendDiagnosticRunId;
        env = backendDiagnosticEnv;
      }
      checkPhase = "command";
      check.executionState = "started";
      output = await runCommand("pwsh", args, {
        cwd: root, env, timeoutMs: 30 * 60_000, graceMs: check.id === "android-device" ? 30_000 : 5000, signal: options.signal,
      });
      check.executionState = "exited";
      check.commandOutcome = commandDetails(output.commandOutcome);
      if (!await writeLog(output.stdout + output.stderr)) {
        checkPhase = "log";
        throw verificationFault("report-write", { check: check.id });
      }
      if (check.id === "backend-tests" && backendDiagnostics) {
        let catalogue;
        try { catalogue = await backendDiagnostics.backendTestCatalogue(root); }
        catch (error) {
          catalogue = { files: [], fingerprint: "unknown" };
          check.collectionStatus = "failed";
          check.diagnosticIssues = [...(check.diagnosticIssues ?? []),
            { operation: "backend-catalogue", ...failureDetails(error, "collector-failed") }];
        }
        const observed = backendDiagnostics.parseBackendOutput(output.stdout, catalogue, check.backendDiagnosticRunId);
        if (observed.collectionStatus === "failed") check.collectionStatus = "failed";
        if (typeof observed.summary?.success === "boolean") check.reportedBackendTestStatus = observed.summary.success ? "passed" : "failed";
      }
      if (check.id === "android-device") {
        checkPhase = "device-validation";
        const evidence = await readDiagnosticReport(path.join(options.directory, "device", "device-report.json"));
        if (!evidence) throw diagnosticError("report-missing");
        validateDeviceEvidence(evidence, plan, process.platform);
        if (evidence.runId !== deviceOwner) throw verificationFault("ownership-mismatch", { check: check.id });
        for (const [field, parts] of [
          ["apkSha256", ["debug", "app-debug.apk"]],
          ["testApkSha256", ["androidTest", "debug", "app-debug-androidTest.apk"]],
        ]) {
          checkPhase = "artifact-validation";
          const context = { check: check.id, artifact: field === "apkSha256" ? "app" : "instrumentation" };
          let bytes;
          try { bytes = await readFile(path.join(root, "android", "app", "build", "outputs", "apk", ...parts)); }
          catch (error) { throw verificationFault("apk-unavailable", context, error); }
          if (digest(bytes) !== evidence[field]) throw verificationFault("apk-mismatch", context);
        }
        check.workerDiagnostics = projectWorkerDiagnostics(evidence.workerDiagnostics, deviceOwner);
        check.deviceDiagnostics = projectDeviceDiagnostics(evidence.deviceDiagnostics, deviceCatalogue, deviceOwner);
        check.deviceEvidence = publicDeviceEvidence(evidence, check.workerDiagnostics, check.deviceDiagnostics);
      }
      if (check.collectionStatus === "failed") throw verificationFault("collector-failed", { check: check.id });
      Object.assign(check, { status: "passed", exitCode: 0 });
    } catch (error) {
      if (!error.commandOutcome && output?.commandOutcome) error.commandOutcome = output.commandOutcome;
      check.commandOutcome = commandDetails(error.commandOutcome);
      if (check.executionState === "started") check.executionState = "exited";
      check.failure = verificationFailure(error, checkPhase);
      if (!logFile) {
        check.failure = { ...failureDetails(error, "report-write"), phase: "log", check: check.id };
        check.privateLog = { availability: "not-produced", truncated: false, retainedBytes: 0 };
      }
      await writeLog(`${error.stdout ?? ""}${error.stderr ?? ""}\n${error.message}\n`);
      Object.assign(check, {
        status: check.id === "android-build" && error.code === 78 ? "blocked" : typeof error.code === "number" ? "failed" : "blocked",
        exitCode: typeof error.code === "number" ? error.code : null,
        reason: check.id === "android-build" && error.code === 78 ? "Android build prerequisites are unavailable." : check.failure.summary,
      });
      if (check.id === "android-device") {
        check.deviceDiagnostics = deviceDiagnosticsFromOutput(
          `${error.stdout ?? output?.stdout ?? ""}\n${error.stderr ?? output?.stderr ?? ""}`, deviceCatalogue, deviceOwner);
        if (error.processTreeStopped) {
          try {
            const cleaned = await cleanDeviceRun(root, path.join(options.directory, "device"), deviceOwner);
            check.cleanup = cleaned ? "completed" : "unknown";
          } catch (cleanupError) {
            check.cleanup = "failed";
            check.diagnosticIssues = [...(check.diagnosticIssues ?? []),
              { operation: "controller-cleanup", ...failureDetails(cleanupError, "cleanup-failed") }];
            check.reason += " Cleanup remains incomplete; inspect retained owned resources.";
          }
        }
        try {
          const evidence = await readDiagnosticReport(path.join(options.directory, "device", "device-report.json"));
          if (!evidence || typeof evidence !== "object") throw diagnosticError(evidence === null ? "report-missing" : "report-invalid");
          if (evidence.runId === deviceOwner) {
            check.workerDiagnostics = projectWorkerDiagnostics(evidence.workerDiagnostics, deviceOwner);
            if (evidence.deviceDiagnostics) check.deviceDiagnostics = projectDeviceDiagnostics(evidence.deviceDiagnostics, deviceCatalogue, deviceOwner);
            if (["passed", "failed", "blocked"].includes(evidence.executionStatus)) check.reportedDeviceExecutionStatus = evidence.executionStatus;
            if (["completed", "failed", "unknown"].includes(evidence.collectionStatus)) check.reportedDeviceCollectionStatus = evidence.collectionStatus;
            if (evidence.collectionStatus === "failed" || check.deviceDiagnostics.collectionStatus === "failed" ||
                check.workerDiagnostics.collectionStatus === "failed") check.collectionStatus = "failed";
          }
          if (evidence.runId === deviceOwner && evidence.status === "blocked" && evidence.cleanup === "completed") {
            check.status = "blocked";
            check.reason = "Device prerequisites or worker readiness are unavailable; inspect the bounded worker diagnostics.";
          }
        } catch (evidenceError) {
          if (evidenceError.diagnosticCode !== "report-missing") check.collectionStatus = "failed";
          check.diagnosticIssues = [...(check.diagnosticIssues ?? []),
            { operation: "device-report", ...failureDetails(evidenceError, evidenceError instanceof SyntaxError ? "report-invalid" : "report-unavailable") }];
          check.reason += " No complete device report was available.";
        }
        if (check.deviceDiagnostics.primary) {
          const primary = check.deviceDiagnostics.primary;
          check.reason = `Device failure at ${primary.phase}/${primary.operation}: ${primary.reason}.`;
        } else if (check.reportedDeviceExecutionStatus === "passed" &&
            (check.reportedDeviceCollectionStatus === "failed" || check.deviceDiagnostics.collectionStatus === "failed" ||
              check.workerDiagnostics?.collectionStatus === "failed" || check.collectionStatus === "failed")) {
          if (check.failure.reason === "command-failed") check.failure = verificationFailure(verificationFault("collector-failed", { check: check.id }), "report");
          check.reason = "Native execution passed, but diagnostic collection failed.";
        }
      }

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

function requireCheckPolicy(plan) {
  if (plan.version !== VERIFICATION_REPORT_VERSION || !Array.isArray(plan.requiredChecks) ||
      JSON.stringify(plan.requiredChecks) !== JSON.stringify(CHECKS.filter((check) => plan.requiredChecks.includes(check.id)).map((check) => check.id)) ||
      JSON.stringify(plan.requiredGroups) !== JSON.stringify(verificationGroups(plan.requiredChecks))) {
    throw verificationFault("policy-mismatch");
  }
}

export function combineVerification(plan, reports) {
  requirePlanCollection(plan);
  requireCheckPolicy(plan);
  const passed = new Map();
  for (const [inputIndex, report] of reports.entries()) {
    const context = { inputIndex, group: report?.group };
    if (!report || typeof report !== "object" || !Array.isArray(report.checks)) throw verificationFault("report-invalid", context);
    if (report.version !== plan.version) throw verificationFault("policy-mismatch", context);
    if (report.base !== plan.base ||
        report.source?.head !== plan.source.head || report.source?.fingerprint !== plan.source.fingerprint) {
      throw verificationFault("source-mismatch", context);
    }
    if (!["passed", "partial"].includes(report.status)) {
      const failed = report.checks.find((item) => CHECKS.some((check) => check.id === item?.id) &&
        ["failed", "blocked"].includes(item.status));
      throw verificationFault("check-failed", { ...context, check: failed?.id });
    }
    if (JSON.stringify(report.requiredChecks) !== JSON.stringify(plan.requiredChecks) ||
        JSON.stringify(report.requiredGroups) !== JSON.stringify(plan.requiredGroups)) throw verificationFault("policy-mismatch", context);
    if (!["all", ...CHECK_GROUPS].includes(report.group)) throw verificationFault("check-group", context);
    const seen = new Set();
    for (const check of report.checks ?? []) {
      const definition = CHECKS.find((item) => item.id === check?.id);
      if (!definition || !plan.requiredChecks.includes(check.id)) throw verificationFault("check-unexpected", context);
      if (seen.has(check.id)) throw verificationFault("check-duplicate", { ...context, check: check.id });
      seen.add(check.id);
      if (check.status === "not_run") continue;
      if (report.group !== "all" && definition.group !== report.group) throw verificationFault("check-group", { ...context, check: check.id });
      if (check.status !== "passed" || check.exitCode !== 0) throw verificationFault("check-failed", { ...context, check: check.id });
      if (check.collectionStatus === "failed" || check.reportedDeviceCollectionStatus === "failed" ||
          check.workerDiagnostics?.collectionStatus === "failed" || check.deviceDiagnostics?.collectionStatus === "failed") {
        throw verificationFault("collector-failed", { ...context, check: check.id });
      }
      if (passed.has(check.id)) throw verificationFault("check-duplicate", { ...context, check: check.id });
      if (check.id === "android-device") validateDeviceEvidence(check.deviceEvidence, plan, report.environment?.platform);
      passed.set(check.id, {
        id: definition.id, status: "passed", exitCode: 0,
        ...(Number.isSafeInteger(check.durationMs) && check.durationMs >= 0 && check.durationMs <= 86400000
          ? { durationMs: check.durationMs } : {}),
        ...(check.id === "android-device" ? { deviceEvidence: publicDeviceEvidence(check.deviceEvidence) } : {}),
      });
    }
  }
  const missing = plan.requiredChecks.filter((id) => !passed.has(id));
  if (missing.length) throw verificationFault("shard-missing", { missing });
  return { ...plan, group: "all", status: "passed", complete: true,
    checks: plan.requiredChecks.map((id) => passed.get(id)) };
}

function validateDeviceEvidence(evidence, plan, platform) {
  const context = { check: "android-device" };
  if (!evidence || evidence.status !== "passed" ||
      evidence.evidence !== "emulator-test-sdk-adapter" ||
      !/^[a-f0-9-]{36}$/.test(evidence.runId) || !Array.isArray(evidence.cases) ||
      !Array.isArray(evidence.discoveredClasses)) throw verificationFault("device-evidence", context);
  if (evidence.collectionStatus === "failed" || evidence.deviceDiagnostics?.collectionStatus === "failed" ||
      evidence.workerDiagnostics?.collectionStatus === "failed") throw verificationFault("collector-failed", context);
  if (evidence.cleanup !== "completed") throw verificationFault("cleanup-failed", context);
  if (evidence.source?.head !== plan.source.head || evidence.source?.fingerprint !== plan.source.fingerprint) {
    throw verificationFault("source-mismatch", context);
  }
  if (!/^[a-f0-9]{64}$/.test(evidence.apkSha256) || !/^[a-f0-9]{64}$/.test(evidence.testApkSha256)) {
    throw verificationFault("apk-unavailable", context);
  }
  if ((platform === "linux" && evidence.platform !== "linux") ||
      (evidence.platform === "linux" &&
        (evidence.acceleration?.provider !== "KVM" || evidence.acceleration.usable !== true))) {
    throw verificationFault("acceleration-evidence", context);
  }
  const baseline = baselineDeviceClasses;
  const trusted = new Set(plan.trustedDeviceClasses ?? baseline);
  if (evidence.discoveredClasses.some((name) => typeof name !== "string" || !trusted.has(name))) {
    throw verificationFault("device-evidence", context);
  }
  if (baseline.some((name) => !evidence.discoveredClasses.includes(name)) ||
      new Set(evidence.discoveredClasses).size !== evidence.discoveredClasses.length ||
      evidence.discoveredClasses.includes("dev.devpocket.app.ConnectedFlowTest")) {
    throw verificationFault("discovery", context);
  }
  const expected = new Map([
    ["native", baseline[0]], ["layout-compact", baseline[1]], ["fixture", baseline[2]],
    ...(plan.layouts ? ["medium", "expanded", "landscape", "large-font"].map((name) => [`layout-${name}`, baseline[1]]) : []),
    ...evidence.discoveredClasses.filter((name) => !baseline.includes(name)).map((name, index) => [`change-${index}`, name]),
  ]);
  let total = 0;
  for (const item of evidence.cases) {
    if (!item || typeof item.name !== "string" || !expected.has(item.name) || typeof item.class !== "string" ||
        item.class !== expected.get(item.name) ||
        item.status !== "passed" || !Number.isSafeInteger(item.tests) || item.tests < (item.name === "native" ? 2 : 1)) {
      throw verificationFault("case-evidence", context);
    }
    expected.delete(item.name);
    total += item.tests;
  }
  if (expected.size || total !== evidence.tests) throw verificationFault("case-evidence", context);
}
