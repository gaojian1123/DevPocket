import { readOnlyGit, sourceSnapshot } from "./git-state.mjs";
import { deviceSourceCatalogue } from "./device-diagnostics.mjs";
import { diagnosticError, failureDetails, ownValue, diagnosticVersion } from "./diagnostic-errors.mjs";
import { CHECKS, CHECK_GROUPS, VERIFICATION_REPORT_VERSION, verificationGroups, verificationImpact } from "./verification-policy.mjs";
export { CHECKS } from "./verification-policy.mjs";
export { git, readOnlyGit, sourceSnapshot } from "./git-state.mjs";

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

export function publicDeviceEvidence(value, workerDiagnostics, deviceDiagnostics) {
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
  // Planning and aggregation must not load application execution adapters.
  const executor = await import("./verification-executor.mjs");
  return executor.executeVerification(root, plan, options);
}

export function requireCheckPolicy(plan) {
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

export function validateDeviceEvidence(evidence, plan, platform) {
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
