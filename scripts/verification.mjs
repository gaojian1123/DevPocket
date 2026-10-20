import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { readOnlyGit, sourceSnapshot } from "./git-state.mjs";
import { deviceSourceCatalogue } from "./device-diagnostics.mjs";
import { diagnosticError, failureDetails, ownValue, diagnosticVersion } from "./diagnostic-errors.mjs";
import { CHECKS, CHECK_GROUPS, VERIFICATION_REPORT_VERSION, verificationGroups, verificationImpact } from "./verification-policy.mjs";
import { requireToolingCatalogue, requireToolingShard, toolingCatalogue } from "./verification-tooling.mjs";
export { CHECKS } from "./verification-policy.mjs";
export { git, readOnlyGit, sourceSnapshot } from "./git-state.mjs";

const splitPaths = (value) => value.split("\0").filter(Boolean);
const baselineDeviceClasses = ["NativeFlowTest", "AdaptiveLayoutTest", "FixtureFlowTest"].map((name) => `dev.devpocket.app.${name}`);

export function verificationFault(reason, context = {}, cause) {
  return Object.assign(diagnosticError(reason, cause), { verificationContext: context });
}

export async function verificationStorageLocation(root, value) {
  const logical = path.resolve(root), physical = await realpath(logical);
  const absolute = path.resolve(logical, value), relative = path.relative(logical, absolute);
  return { root: physical, file: relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? absolute : path.resolve(physical, relative) };
}

function insideDirectory(parent, value) {
  const relative = path.relative(parent, value);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function verificationOutputLocation(root, value) {
  const location = await verificationStorageLocation(root, value);
  const relative = path.relative(location.root, location.file);
  if (!["verification", "ci", "development"].some((name) => {
    const allowed = path.join(".data", name);
    return relative === allowed || relative.startsWith(allowed + path.sep);
  })) throw verificationFault("ownership-mismatch");
  if (process.platform === "win32" && relative.split(path.sep).some((part) => /:|[. ]$/.test(part))) {
    throw verificationFault("ownership-mismatch");
  }
  if (insideDirectory(path.join(location.root, ".data", "verification", "local"), location.file)) {
    throw verificationFault("run-output-reused");
  }
  return location;
}

export async function requireVerificationOutputDirectory(root, directory, retainedRuns = []) {
  const location = await verificationOutputLocation(root, directory);
  const relative = path.relative(location.root, location.file);
  for (const file of retainedRuns.filter(Boolean)) {
    const retained = await verificationStorageLocation(root, file);
    if (insideDirectory(path.dirname(retained.file), location.file)) throw verificationFault("run-output-reused");
  }
  let current = location.root;
  for (const [index, part] of relative.split(path.sep).entries()) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === "ENOENT") return location; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw verificationFault("ownership-mismatch");
    const physical = await realpath(current);
    if (process.platform === "win32" ? physical.toLowerCase() !== current.toLowerCase() : physical !== current) {
      throw verificationFault("ownership-mismatch");
    }
    if (index === 0) continue;
    try { await lstat(path.join(current, "run.json")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw verificationFault("run-output-reused");
  }
  return location;
}

export async function requireVerificationReportPath(root, file, retainedRuns = []) {
  const location = await verificationOutputLocation(root, file), name = path.basename(location.file);
  if ((process.platform === "win32" ? name.toLowerCase() : name) === "run.json") throw verificationFault("run-output-reused");
  await requireVerificationOutputDirectory(root, path.dirname(location.file), retainedRuns);
}

export function verificationFailure(error, phase = "command") {
  const context = ownValue(error, "verificationContext");
  const check = ownValue(context, "check"), group = ownValue(context, "group");
  const index = ownValue(context, "inputIndex"), artifact = ownValue(context, "artifact"), missing = ownValue(context, "missing");
  const outcome = ownValue(context, "outcome");
  return {
    ...failureDetails(error),
    phase: ["arguments", "plan", "admission", "preflight", "command", "device-validation", "artifact-validation",
      "source-validation", "log", "aggregate", "report"].includes(phase) ? phase : "unknown",
    ...(CHECKS.some((item) => item.id === check) ? { check } : {}),
    ...(["all", ...CHECK_GROUPS].includes(group) ? { group } : {}),
    ...(["success", "failure", "cancelled", "skipped", "unknown"].includes(outcome) ? { outcome } : {}),
    ...(Number.isSafeInteger(index) && index >= 0 && index < 128 ? { inputIndex: index } : {}),
    ...(["app", "instrumentation"].includes(artifact) ? { artifact } : {}),
    ...(Array.isArray(missing) ? { missingChecks: CHECKS.filter((item) => missing.includes(item.id)).map((item) => item.id) } : {}),
    ...(["node", "command-ownership", "powershell", "output-directory", "root-dependencies", "npm", "git",
      "ssh-keygen", "python", "azure-dependencies", "probe-python", "operations-python", "jdk", "android-platform-35",
      "gradle-wrapper", "android-entry", "android-output", "backend-output", "gradle-cache", "native-configuration",
      "android-image", "adb", "emulator-acceleration", "typecheck-contract"]
      .includes(ownValue(context, "prerequisite")) ? { prerequisite: ownValue(context, "prerequisite") } : {}),
  };
}

export async function verificationPlan(root, base, all = false, { trustedTooling = false } = {}) {
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
    ...(impact.requiredChecks.includes("workflow-tests") ? { toolingShards: await toolingCatalogue(root, { trusted: trustedTooling }) } : {}),
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

export async function validateVerificationEvidence(root, plan, reports, options = {}) {
  if (options.requireComplete === true &&
      (reports.length !== 1 || reports[0]?.status !== "passed" || reports[0].complete !== true)) {
    throw verificationFault("check-failed");
  }
  if (!reports.some((report) => report?.transition)) return combineVerification(plan, reports);
  if (!options.candidateEvidence || reports.length !== 1) throw verificationFault("candidate-evidence-required");
  const { validateCandidateVerification } = await import("./verification-transition.mjs");
  return validateCandidateVerification(root, plan, reports[0], options);
}

export function requireCheckPolicy(plan) {
  if (plan.version !== VERIFICATION_REPORT_VERSION || !Array.isArray(plan.requiredChecks) ||
      JSON.stringify(plan.requiredChecks) !== JSON.stringify(CHECKS.filter((check) => plan.requiredChecks.includes(check.id)).map((check) => check.id)) ||
      JSON.stringify(plan.requiredGroups) !== JSON.stringify(verificationGroups(plan.requiredChecks))) {
    throw verificationFault("policy-mismatch");
  }
  if (plan.toolingShards) requireToolingCatalogue(plan.toolingShards);
}

export function combineVerification(plan, reports) {
  requirePlanCollection(plan);
  requireCheckPolicy(plan);
  const passed = new Map(), toolingParts = new Map();
  for (const [inputIndex, report] of reports.entries()) {
    for (const check of validatedReportChecks(plan, report, inputIndex, true)) {
      const context = { inputIndex, group: report.group };
      if (check.toolingShard) {
        if (passed.has(check.id) || toolingParts.has(check.toolingShard.id)) {
          throw verificationFault("check-duplicate", { ...context, check: check.id });
        }
        toolingParts.set(check.toolingShard.id, { shard: structuredClone(check.toolingShard),
          execution: checkExecution(check, plan.source, plan) });
        continue;
      }
      if (passed.has(check.id) || check.id === "workflow-tests" && toolingParts.size) {
        throw verificationFault("check-duplicate", { ...context, check: check.id });
      }
      passed.set(check.id, {
        id: check.id, status: "passed", exitCode: 0,
        execution: checkExecution(check, plan.source, plan),
        ...(Number.isSafeInteger(check.durationMs) && check.durationMs >= 0 && check.durationMs <= 86400000
          ? { durationMs: check.durationMs } : {}),
        ...(check.id === "android-device" ? { deviceEvidence: publicDeviceEvidence(check.deviceEvidence) } : {}),
      });
    }
  }
  if (toolingParts.size) {
    const expected = requireToolingCatalogue(plan.toolingShards).parts;
    if (expected.length !== toolingParts.size || expected.some((part) => !toolingParts.has(part.id))) {
      throw verificationFault("shard-missing", { missing: ["workflow-tests"] });
    }
    passed.set("workflow-tests", { id: "workflow-tests", status: "passed", exitCode: 0,
      execution: { kind: "tooling-shards", source: structuredClone(plan.source),
        parts: expected.map((part) => toolingParts.get(part.id)) } });
  }
  const missing = plan.requiredChecks.filter((id) => !passed.has(id));
  if (missing.length) throw verificationFault("shard-missing", { missing });
  return { ...plan, group: "all", status: "passed", complete: true,
    checks: plan.requiredChecks.map((id) => passed.get(id)) };
}

function checkExecution(check, source, plan) {
  const value = check.execution;
  if (value?.kind === "tooling-shards") {
    if (check.id !== "workflow-tests" || check.toolingShard || !Array.isArray(value.parts) ||
        value.source?.head !== source.head || value.source?.fingerprint !== source.fingerprint) {
      throw verificationFault("execution-origin", { check: check.id });
    }
    const expected = requireToolingCatalogue(plan.toolingShards).parts;
    if (value.parts.length !== expected.length ||
        value.parts.some((part, index) => part?.shard?.id !== expected[index].id || part.execution?.kind)) {
      throw verificationFault("execution-origin", { check: check.id });
    }
    return { kind: "tooling-shards", source: structuredClone(source),
      parts: value.parts.map((part) => ({
        shard: structuredClone(requireToolingShard(plan, part.shard)),
        execution: checkExecution({ id: check.id, execution: part.execution }, source, plan),
      })) };
  }
  const timestamp = (text) => typeof text === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) &&
    Number.isFinite(Date.parse(text)) && new Date(text).toISOString() === text;
  if (!value || value.kind !== undefined || !timestamp(value.startedAt) || !timestamp(value.completedAt) ||
      value.completedAt < value.startedAt || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.source?.head ?? "") ||
      !/^[a-f0-9]{64}$/.test(value.source?.fingerprint ?? "")) {
    throw verificationFault("execution-origin", { check: check.id });
  }
  if (value.source.head !== source.head || value.source.fingerprint !== source.fingerprint) {
    throw verificationFault("candidate-evidence-required", { check: check.id });
  }
  return { source: { head: value.source.head, fingerprint: value.source.fingerprint },
    startedAt: value.startedAt, completedAt: value.completedAt };
}

function validatedReportChecks(plan, report, inputIndex, allowToolingShard = false) {
  const context = { inputIndex, group: report?.group };
  if (!report || typeof report !== "object" || !Array.isArray(report.checks)) throw verificationFault("report-invalid", context);
  if (report.version !== plan.version) throw verificationFault("policy-mismatch", context);
  if (report.base !== plan.base ||
      report.source?.head !== plan.source.head || report.source?.fingerprint !== plan.source.fingerprint) {
    throw verificationFault("source-mismatch", context);
  }
  if (report.transition || report.checks.some((check) => check?.candidateReuse ||
      check?.execution?.source && (check.execution.source.head !== report.source?.head ||
        check.execution.source.fingerprint !== report.source?.fingerprint))) {
    throw verificationFault("candidate-evidence-required", context);
  }
  if (!["passed", "partial"].includes(report.status)) {
    const failed = report.checks.find((item) => CHECKS.some((check) => check.id === item?.id) &&
      ["failed", "blocked"].includes(item.status));
    throw verificationFault("check-failed", { ...context, check: failed?.id });
  }
  if (JSON.stringify(report.requiredChecks) !== JSON.stringify(plan.requiredChecks) ||
      JSON.stringify(report.requiredGroups) !== JSON.stringify(plan.requiredGroups) ||
      JSON.stringify(report.toolingShards ?? null) !== JSON.stringify(plan.toolingShards ?? null)) {
    throw verificationFault("policy-mismatch", context);
  }
  if (!["all", ...CHECK_GROUPS].includes(report.group)) throw verificationFault("check-group", context);
  const seen = new Set(), passed = [];
  for (const check of report.checks) {
    const definition = CHECKS.find((item) => item.id === check?.id);
    if (!definition || !plan.requiredChecks.includes(check.id)) throw verificationFault("check-unexpected", context);
    if (seen.has(check.id)) throw verificationFault("check-duplicate", { ...context, check: check.id });
    seen.add(check.id);
    if (check.status === "not_run") continue;
    if (report.group !== "all" && definition.group !== report.group) throw verificationFault("check-group", { ...context, check: check.id });
    if (check.status !== "passed" || check.exitCode !== 0) throw verificationFault("check-failed", { ...context, check: check.id });
    if (check.toolingShard) {
      if (!allowToolingShard || check.id !== "workflow-tests" || report.group !== "tooling" ||
          report.status !== "partial" || report.complete !== false) {
        throw verificationFault("shard-missing", { ...context, missing: ["workflow-tests"] });
      }
      requireToolingShard(plan, check.toolingShard);
    }
    checkExecution(check, plan.source, plan);
    if (check.collectionStatus === "failed" || check.reportedDeviceCollectionStatus === "failed" ||
        check.workerDiagnostics?.collectionStatus === "failed" || check.deviceDiagnostics?.collectionStatus === "failed") {
      throw verificationFault("collector-failed", { ...context, check: check.id });
    }
    if (check.id === "android-device") validateDeviceEvidence(check.deviceEvidence, plan, report.environment?.platform);
    passed.push(check);
  }
  return passed;
}

export function requireToolingShardReport(plan, report) {
  requireCheckPolicy(plan);
  const checks = validatedReportChecks(plan, report, undefined, true);
  if (checks.length !== 1 || !checks[0].toolingShard) throw verificationFault("report-invalid");
  return checks;
}

export function requireCompletedVerificationGroup(plan, report, group, validatedReuse = new Map()) {
  requirePlanCollection(plan);
  requireCheckPolicy(plan);
  if (!plan.requiredGroups.includes(group) || report.group !== group) throw verificationFault("check-group", { group });
  const checks = requireVerificationResults(plan, report, validatedReuse);
  const required = CHECKS.filter((check) => check.group === group && plan.requiredChecks.includes(check.id)).map((check) => check.id);
  if (JSON.stringify(checks.map((check) => check.id)) !== JSON.stringify(required) ||
      report.sourceValidation?.status === "failed" || report.failure ||
      checks.some((check) => check.executionState !== "exited" || check.privateLog?.availability !== "retained" ||
        check.commandOutcome?.observedProcess !== "owned-command-supervisor" || check.commandOutcome.reason !== "exit" ||
        check.commandOutcome.exitCode !== 0 || check.commandOutcome.cleanupFailure !== null)) {
    throw verificationFault("check-failed", { group });
  }
  return checks;
}

export function requireVerificationResults(plan, report, validatedReuse = new Map()) {
  requirePlanCollection(plan);
  requireCheckPolicy(plan);
  if (!Array.isArray(report.checks)) throw verificationFault("report-invalid");
  for (const check of report.checks.filter((item) => item?.candidateReuse)) {
    if (!validatedReuse.has(check.id) || JSON.stringify(check) !== JSON.stringify(validatedReuse.get(check.id))) {
      throw verificationFault("candidate-evidence-required", { check: check.id });
    }
  }
  const checks = validatedReportChecks(plan, { ...report, checks: report.checks.filter((item) => !item?.candidateReuse) });
  return report.checks.filter((item) => item?.candidateReuse || checks.includes(item));
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
