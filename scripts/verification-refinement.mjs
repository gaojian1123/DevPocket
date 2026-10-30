import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { activeHookSnapshot, sameSource } from "./candidate-commit.mjs";
import { readOnlyGit, sourceInputs, sourceSnapshot } from "./git-state.mjs";
import { combineVerification, verificationFault, verificationPlan } from "./verification.mjs";
import { readVerificationRun } from "./verification-run.mjs";
import { applePreparationInputs, resolveVerificationExecutable, verificationExecutionPolicy } from "./verification-preflight.mjs";
import { commandCleanupConfirmed, runCommand } from "./process.mjs";
import { commandDetails, failureDetails } from "./diagnostic-errors.mjs";
import { runAppleLocalCommands, validateAppleLocalArtifacts } from "./apple-runner.mjs";
import {
  APPLE_PROBES, APPLE_REQUIREMENTS, appleDeviceId, appleDevices, appleDigest, appleEnumerationArguments, appleJSON,
  appleTestInterval, appleTestSelection, inspectAppleScheme, inspectAppleToolchain, normalizeAppleBatchResult,
  normalizeAppleTestCatalog, normalizeAppleTestResult, projectAppleXcresult, validateAppleBatchCatalog, validateAppleNativeEvidence,
} from "./apple-evidence.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equal = isDeepStrictEqual;
const version = 2;
const application = [
  "apple/DevPocket/DevPocket/ContentView.swift",
  "apple/DevPocket/DevPocket/Controls.swift",
];
const companions = [
  "apple/DevPocket/DevPocketTests/DevPocketTests.swift",
  "apple/DevPocket/DevPocketUITests/DevPocketUITests.swift",
  "docs/APPLE-CLIENT.md",
];
const allowed = new Set([...application, ...companions]);
const sha = /^[a-f0-9]{64}$/;
const identifier = /^DevPocket(?:UI)?Tests\/[A-Za-z_][A-Za-z0-9_]*\(\)$/;
const fail = (reason = "report-invalid") => { throw verificationFault(reason); };
const text = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 8000;
const strings = (value, maximum = 128) => Array.isArray(value) && value.length > 0 && value.length <= maximum &&
  value.every(text) && new Set(value).size === value.length;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

async function location(root, file, directory = false) {
  if (typeof file !== "string" || file.includes("\0")) fail("ownership-mismatch");
  const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
  if (!relative.startsWith(`.data${path.sep}`)) fail("ownership-mismatch");
  let current = root;
  const parts = relative.split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || await realpath(current) !== current ||
        (index < parts.length - 1 || directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
      fail("ownership-mismatch");
    }
  }
  return absolute;
}

async function regularArtifact(file, maximum = 2 * 1024 * 1024) {
  const absolute = await realpath(file), before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("ownership-mismatch");
  if (before.size > maximum) fail("output-limit");
  const handle = await open(absolute, "r");
  let bytes;
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail("source-changed");
    bytes = await handle.readFile();
    for (const after of [await handle.stat(), await lstat(file)]) {
      if (["dev", "ino", "size", "mode", "nlink", "mtimeMs", "ctimeMs"].some((key) => opened[key] !== after[key])) {
        fail("source-changed");
      }
    }
    if (await realpath(file) !== absolute) fail("artifact-changed");
  } finally { await handle.close(); }
  return { sha256: hash(bytes), bytes };
}

async function artifact(root, file, maximum = 2 * 1024 * 1024) {
  const absolute = await location(root, file), input = await regularArtifact(absolute, maximum);
  return { reference: { path: path.relative(root, absolute).replaceAll("\\", "/"), sha256: input.sha256 }, bytes: input.bytes };
}

async function json(root, file) {
  const input = await artifact(root, file);
  try { return { ...input, value: JSON.parse(input.bytes) }; }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    fail("report-invalid");
  }
}

async function retained(root, reference) {
  const input = await json(root, reference?.path);
  if (input.reference.sha256 !== reference.sha256) fail("artifact-changed");
  return input.value;
}

export async function captureLocalRefinementContext(root, signal) {
  root = await realpath(root);
  if (process.env.GITHUB_ACTIONS === "true" || process.platform !== "darwin") fail("configuration");
  const source = await sourceSnapshot(root);
  const preparation = await applePreparationInputs(root, source, signal);
  const executable = await resolveVerificationExecutable(root, "git");
  const xcrun = await resolveVerificationExecutable(root, "xcrun");
  const xcode = await runCommand(xcrun, ["xcodebuild", "-version"], { cwd: root, timeoutMs: 30000, signal });
  return {
    workspace: root,
    branch: (await readOnlyGit(root, ["symbolic-ref", "--quiet", "HEAD"])).trim(),
    source,
    hooks: await activeHookSnapshot(root),
    policy: await verificationExecutionPolicy(),
    environment: {
      node: { version: process.version, executable: hash(await readFile(process.execPath)) },
      git: { executable: hash(await readFile(executable)),
        version: hash(await readOnlyGit(root, ["--version"])),
        execPath: hash(await readOnlyGit(root, ["--exec-path"])),
        configuration: hash(await readOnlyGit(root, ["config", "--null", "--show-origin", "--show-scope", "--list"])) },
      xcode: { launcher: hash(await readFile(xcrun)), version: hash(xcode.stdout),
        developerDirectory: hash(process.env.DEVELOPER_DIR ?? "") },
      preparation,
    },
  };
}

function reviewConclusion(event, source, base, checkpointSha256) {
  const data = event?.data;
  if (event?.type !== "tool.execution_complete" || data?.success !== true || !text(data.toolCallId) ||
      data.toolTelemetry?.restrictedProperties?.agent_name !== "devpocket-reviewer" ||
      !text(data.toolTelemetry.restrictedProperties.agent_id) || typeof data.result?.content !== "string") {
    fail("execution-origin");
  }
  const content = data.result.content;
  const blocks = [...content.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1) fail();
  let result;
  try { result = JSON.parse(blocks[0][1]); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; fail(); }
  const verdict = result.verdict ?? /^## Verdict:\s*`(pass|changes_requested|needs_human)`/m.exec(content)?.[1];
  if (verdict !== "pass" || result.base !== base || !sameSource(result.reviewedSource, source) ||
      result.checkpointSha256 !== checkpointSha256 ||
      !Array.isArray(result.findings) || result.findings.some((finding) => finding.severity !== "advisory")) fail("check-failed");
  return { toolCallId: data.toolCallId, agentId: data.toolTelemetry.restrictedProperties.agent_id };
}

async function fullEvidence(root, file, source, base) {
  const input = await json(root, file), report = input.value;
  if (!sameSource(report?.source, source) || report.base !== base) fail("source-mismatch");
  if (report.status !== "passed" || report.complete !== true || !report.run?.manifest || report.transition) fail("check-failed");
  const run = await readVerificationRun(root, report.run.manifest);
  if (!equal(run.report, report) || run.manifest.binding.group !== "all") fail("run-incomplete");
  combineVerification(run.manifest.plan, [report]);
  return { input, run };
}

async function prepareCheckpoint(root, base, request, before) {
  const plan = await verificationPlan(root, base);
  const { input, run } = await fullEvidence(root, request.verification, before.source, base);
  combineVerification(plan, [input.value]);
  if (run.manifest.binding.policy !== before.policy) fail("policy-mismatch");
  if (run.manifest.binding.captureRefinementContext !== true || !equal(input.value.refinementContext, before)) {
    fail("environment-changed");
  }
  if (!strings(request.nativeEvidence, 32)) fail();
  const nativeEvidence = [];
  for (const file of request.nativeEvidence) {
    const item = await json(root, file);
    if (!item.value?.source || !sha.test(item.value.source.fingerprint ?? "")) fail("source-mismatch");
    nativeEvidence.push({ ...item.reference, source: item.value.source });
  }
  if (!nativeEvidence.some((item) => sameSource(item.source, before.source))) fail("source-mismatch");
  if (!Array.isArray(request.acceptedProducts) || request.acceptedProducts.length !== 2) fail("artifact-changed");
  const acceptedProducts = [];
  for (const platform of ["ios", "macos"]) {
    const products = request.acceptedProducts.filter((item) => item?.platform === platform);
    if (products.length !== 1) fail("artifact-changed");
    const item = products[0], seal = await json(root, item.artifact);
    await sealedProduct(root, item, seal.value, before.source, before.environment.preparation.renderer);
    acceptedProducts.push({ platform, artifact: seal.reference, bundle: item.bundle });
  }
  const inputs = await sourceInputs(root), sources = {};
  for (const [file, mode, kind, digest] of inputs.filter(([file]) => allowed.has(file))) {
    if (mode !== "100644" || kind !== "file") fail("source-mismatch");
    const bytes = await readFile(path.join(root, file));
    if (bytes.length > 128 * 1024 || hash(bytes) !== digest) fail("source-changed");
    sources[file] = bytes.toString("utf8");
  }
  if (!application.some((file) => Object.hasOwn(sources, file))) fail("configuration");
  return { version, kind: "local-refinement-checkpoint-subject", status: "pending_review", complete: false, acceptance: false,
    reviewRequired: true,
    base, context: before, inputs, sources, verification: input.reference,
    nativeEvidence, acceptedProducts,
    createdAt: new Date().toISOString(), checks: [] };
}

async function checkpointSubject(root, file, base) {
  const input = await json(root, file), value = input.value;
  if (value?.version !== version || value.kind !== "local-refinement-checkpoint-subject" || value.status !== "pending_review" ||
      value.base !== base || value.context?.workspace !== root ||
      !Array.isArray(value.inputs) || hash(JSON.stringify(value.inputs)) !== value.context.source?.fingerprint ||
      !value.sources || !Array.isArray(value.nativeEvidence) || !value.nativeEvidence.length) fail("source-mismatch");
  await retained(root, value.request);
  const full = await fullEvidence(root, value.verification?.path, value.context.source, base);
  await retained(root, value.verification);
  if (full.run.manifest.binding.captureRefinementContext !== true ||
      !equal(full.input.value.refinementContext, value.context)) fail("environment-changed");
  for (const reference of value.nativeEvidence) {
    const native = await retained(root, reference);
    if (!sameSource(native.source, reference.source)) fail("source-mismatch");
  }
  if (!Array.isArray(value.acceptedProducts) || value.acceptedProducts.length !== 2) fail("artifact-changed");
  for (const item of value.acceptedProducts) {
    const seal = await retained(root, item.artifact);
    await sealedProduct(root, item, seal, value.context.source, value.context.environment.preparation.renderer);
  }
  for (const [file, contents] of Object.entries(value.sources)) {
    const original = value.inputs.find(([name]) => name === file);
    if (!allowed.has(file) || typeof contents !== "string" || original?.[1] !== "100644" ||
        original[2] !== "file" || original[3] !== hash(contents)) fail("source-mismatch");
  }
  if (value.inputs.some(([file, mode]) => allowed.has(file) && mode !== "deleted" &&
      !Object.hasOwn(value.sources, file))) fail("source-mismatch");
  return input;
}

async function acceptCheckpoint(root, base, request, before) {
  const subject = await checkpointSubject(root, request.subject, base), value = subject.value;
  if (!sameSource(value.context.source, before.source)) fail("source-mismatch");
  if (!equal(value.context, before)) fail("environment-changed");
  const review = await json(root, request.review);
  const origin = reviewConclusion(review.value, before.source, base, subject.reference.sha256);
  return { ...value, kind: "local-refinement-checkpoint", status: "checkpointed", complete: true,
    reviewRequired: false, subject: subject.reference, review: { ...review.reference, ...origin }, acceptedAt: new Date().toISOString() };
}

async function checkpoint(root, file, base) {
  const input = await json(root, file), value = input.value;
  if (value?.version !== version || value.kind !== "local-refinement-checkpoint" || value.status !== "checkpointed" ||
      value.complete !== true) fail("report-invalid");
  await retained(root, value.request);
  const subject = await checkpointSubject(root, value.subject?.path, base);
  if (subject.reference.sha256 !== value.subject.sha256) fail("artifact-changed");
  for (const key of ["base", "context", "inputs", "sources", "verification", "nativeEvidence", "acceptedProducts"]) {
    if (!equal(value[key], subject.value[key])) fail("source-mismatch");
  }
  const origin = reviewConclusion(await retained(root, value.review), value.context.source, base, subject.reference.sha256);
  if (origin.toolCallId !== value.review.toolCallId || origin.agentId !== value.review.agentId) fail("execution-origin");
  return input;
}

function selection(value, changed) {
  if (!value || !text(value.reason) || !text(value.unchangedCoverage) ||
      !Array.isArray(value.tests) || !value.tests.length || value.tests.length > 8 ||
      !Array.isArray(value.coverage)) fail("configuration");
  const ids = new Set(), devices = new Set();
  for (const target of value.tests) {
    if (!["iOS Simulator", "macOS"].includes(target?.platform) || !text(target.deviceId) ||
        !text(target.osVersion) || devices.has(target.deviceId) || !strings(target.identifiers) ||
        target.identifiers.some((id) => !identifier.test(id))) fail("configuration");
    devices.add(target.deviceId);
    target.identifiers.forEach((id) => ids.add(id));
  }
  if (![...ids].some((id) => id.startsWith("DevPocketUITests/"))) fail("configuration");
  const required = changed.filter((file) => application.includes(file) || file.endsWith(".swift"));
  if (value.coverage.length !== required.length || new Set(value.coverage.map((item) => item?.path)).size !== required.length ||
      value.coverage.some((item) => !required.includes(item.path) || !text(item.reason) ||
        !strings(item.tests) || item.tests.some((id) => !ids.has(id)))) fail("configuration");
  return { reason: value.reason, builds: ["ios", "macos"],
    tests: value.tests.map(({ platform, deviceId, osVersion, identifiers }) => ({ platform, deviceId, osVersion, identifiers })),
    coverage: value.coverage, unchangedCoverage: value.unchangedCoverage };
}

async function makePlan(root, base, request, before) {
  const saved = await checkpoint(root, request.checkpoint, base), original = saved.value;
  const oldInputs = new Map(original.inputs.map((item) => [item[0], item]));
  const inputs = await sourceInputs(root), current = new Map(inputs.map((item) => [item[0], item]));
  const changed = [...new Set([...oldInputs.keys(), ...current.keys()])].sort()
    .filter((file) => !equal(oldInputs.get(file), current.get(file)));
  const reasons = [];
  if (original.context.branch !== before.branch) reasons.push("branch-changed");
  if (original.context.policy !== before.policy) reasons.push("policy-changed");
  if (!equal(original.context.hooks, before.hooks)) reasons.push("hooks-changed");
  if (!equal(original.context.environment, before.environment)) reasons.push("environment-changed");
  if (!changed.some((file) => application.includes(file))) reasons.push("no-presentation-change");
  if (changed.some((file) => !allowed.has(file))) reasons.push("outside-apple-presentation");
  if (changed.some((file) => !current.has(file) || current.get(file)[1] !== "100644" ||
      current.get(file)[2] !== "file" || application.includes(file) && !Object.hasOwn(original.sources, file))) {
    reasons.push("unsupported-source-change");
  }
  try { await readOnlyGit(root, ["merge-base", "--is-ancestor", original.context.source.head, before.source.head]); }
  catch (error) { if (error.code !== 1) throw error; reasons.push("history-changed"); }
  const output = { version, kind: "local-refinement-plan", base, context: before,
    checkpoint: saved.reference, changedFiles: changed, createdAt: new Date().toISOString(), complete: false,
    acceptance: false, checks: [] };
  if (reasons.length) return { ...output, status: "full_required", reasons };
  const delta = [];
  for (const file of changed) {
    const bytes = await readFile(path.join(root, file));
    if (bytes.length > 128 * 1024 || hash(bytes) !== current.get(file)[3]) fail("source-changed");
    delta.push({ path: file, before: original.sources[file] ?? null, after: bytes.toString("utf8") });
  }
  return { ...output, status: "planned", delta, selection: selection(request.selection, changed) };
}

async function makeApplePlan(root, base, request, before, directory, signal) {
  const policy = await verificationPlan(root, base);
  if (!policy.requiredChecks.includes("apple-native") || !sameSource(policy.source, before.source)) fail("policy-mismatch");
  if (request.testMode !== undefined && !["batches", "xcodebuild"].includes(request.testMode) ||
      request.runId !== undefined && !appleDeviceId(request.runId) ||
      !Array.isArray(request.targets) || request.targets.length !== APPLE_REQUIREMENTS.targets.length ||
      new Set(request.targets.map((target) => target?.role)).size !== request.targets.length ||
      new Set(request.targets.map((target) => target?.deviceId)).size !== request.targets.length) fail("configuration");
  const absolute = await location(root, directory, true), relative = path.relative(root, absolute).replaceAll("\\", "/");
  if (!/^\.data\/verification\/[^/]+/.test(relative)) fail("ownership-mismatch");
  const outputs = {};
  for (const probe of APPLE_PROBES) {
    const executable = await resolveVerificationExecutable(root, path.basename(probe.file));
    const result = await runCommand(executable, probe.args, { cwd: root, timeoutMs: 30000, signal });
    outputs[probe.id] = result.stdout;
  }
  const toolchain = inspectAppleToolchain(outputs), inventory = JSON.parse(outputs.simulators);
  const devices = appleDevices(inventory), tests = [], simulators = [];
  for (const requirement of APPLE_REQUIREMENTS.targets) {
    const target = request.targets.find((item) => item.role === requirement.role);
    if (!text(target?.deviceId)) fail("configuration");
    if (requirement.role === "mac") {
      tests.push({ role: "mac", platform: "macOS", osVersion: toolchain.macOS,
        architecture: toolchain.architecture, deviceId: target.deviceId });
      continue;
    }
    const found = devices.filter((item) => item.udid === target.deviceId);
    if (found.length !== 1) fail("device-evidence");
    const device = found[0], runtime = inventory.runtimes.find((item) => item.identifier === device.runtimeIdentifier);
    const type = inventory.devicetypes.find((item) => item.identifier === device.deviceTypeIdentifier);
    if (request.testMode === "xcodebuild" && device.state !== "Booted" ||
        !runtime?.isAvailable || runtime.version.split(".").slice(0, 2).join(".") !== requirement.runtimeVersion ||
        type?.name !== requirement.deviceTypeName ||
        !runtime.supportedDeviceTypes?.some((item) => item.identifier === type.identifier)) fail("device-evidence");
    const selected = { ...requirement, osVersion: runtime.version, runtimeIdentifier: runtime.identifier,
      deviceTypeIdentifier: type.identifier };
    simulators.push(selected);
    tests.push({ ...selected, architecture: toolchain.architecture, deviceId: target.deviceId });
  }
  toolchain.simulators = simulators;
  const schemePath = `${APPLE_REQUIREMENTS.project}/xcshareddata/xcschemes/DevPocket.xcscheme`;
  const xml = await readFile(path.join(root, schemePath), "utf8");
  return { version, kind: "local-apple-plan", base, context: before, apple: policy.apple,
    directory: relative, runId: request.runId ?? randomUUID(), changedFiles: policy.changedFiles,
    toolchain, scheme: { path: schemePath, xml, sha256: appleDigest(xml), targets: inspectAppleScheme(xml) },
    selection: { builds: ["ios", "macos"], tests, fullSuite: true, ...(request.testMode ? { testMode: request.testMode } : {}) },
    status: "planned", complete: false, acceptance: false, checks: [], createdAt: new Date().toISOString() };
}

async function currentPlan(root, base, file, before, signal) {
  const input = await json(root, file), plan = input.value;
  const apple = plan?.kind === "local-apple-plan";
  if (plan?.version !== version || !["local-refinement-plan", "local-apple-plan"].includes(plan.kind) || plan.status !== "planned" ||
      !timestamp(plan.createdAt)) fail();
  if (!sameSource(plan.context?.source, before.source)) fail("source-mismatch");
  if (!equal(plan.context.environment, before.environment)) fail("environment-changed");
  if (!equal(plan.context, before)) fail("policy-mismatch");
  const originalRequest = await retained(root, plan.request);
  const expected = apple
    ? await makeApplePlan(root, base, { ...originalRequest, runId: plan.runId }, before, plan.directory, signal)
    : await makePlan(root, base, { checkpoint: plan.checkpoint?.path, selection: plan.selection }, before);
  const keys = apple ? ["base", "context", "apple", "directory", "runId", "changedFiles", "toolchain", "scheme", "selection", "status"]
    : ["base", "context", "checkpoint", "changedFiles", "delta", "selection", "status"];
  for (const key of keys) {
    if (!equal(plan[key], expected[key])) {
      if (key === "context" && !equal(plan.context.environment, before.environment)) fail("environment-changed");
      fail(key === "context" ? "source-mismatch" : "policy-mismatch");
    }
  }
  return input;
}

async function makeAppleCatalog(root, base, request, before, directory, signal) {
  const input = await currentPlan(root, base, request.plan, before, signal), plan = input.value;
  const target = plan.selection.tests.find((item) => item.role === request.role);
  if (plan.kind !== "local-apple-plan" || plan.selection.testMode !== "batches" || !target ||
      Object.keys(request).some((key) => !["action", "plan", "role"].includes(key))) fail("configuration");
  const absolute = await location(root, directory, true), relative = path.relative(root, absolute).replaceAll("\\", "/");
  if (!relative.startsWith(plan.directory + "/")) fail("ownership-mismatch");
  const file = await resolveVerificationExecutable(root, "xcrun");
  if (target.role !== "mac") {
    const inventory = JSON.parse((await runCommand(file, ["simctl", "list", "--json"], { cwd: root, signal })).stdout);
    const devices = appleDevices(inventory).filter((item) => item.udid === target.deviceId);
    if (devices.length !== 1 || devices[0].state !== "Booted" ||
        devices[0].runtimeIdentifier !== target.runtimeIdentifier ||
        devices[0].deviceTypeIdentifier !== target.deviceTypeIdentifier) fail("device-evidence");
  }
  const args = appleEnumerationArguments(root, relative, target);
  const save = async (name, bytes) => {
    const file = path.join(absolute, name);
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    return { path: path.relative(root, file).replaceAll("\\", "/"), sha256: hash(bytes) };
  };
  let completion;
  try {
    for (const name of ["derived", "enumeration.json", "command-request.json", "command-response.json", "stdout.txt", "stderr.txt"]) {
      try { await lstat(path.join(absolute, name)); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      throw Object.assign(new Error("Catalogue output paths cannot be reused."), { code: "EEXIST" });
    }
    // A new derived-data directory makes this an enumeration of a current build, not Xcode's cached test list.
    await mkdir(path.join(absolute, "derived"));
    completion = await open(path.join(absolute, "command-response.json"), "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") error.appleCatalogNotStarted = true;
    throw error;
  }
  const command = { id: randomUUID(), kind: "owned-command", origin: "local-xcode-enumeration",
    file, args, cwd: root, startedAt: new Date().toISOString() };
  let outcome, error;
  let execution;
  try {
    const commandRequest = await save("command-request.json", appleJSON(command));
    try { outcome = await runCommand(file, args, { cwd: root, timeoutMs: 180000, graceMs: 15000, signal }); }
    catch (caught) { error = caught; outcome = caught; }
    execution = { ...command, completedAt: new Date().toISOString(), request: commandRequest,
      status: error ? "failed" : "passed",
      cleanup: commandCleanupConfirmed(outcome, { file, args, cwd: root }) ? "completed" : "unknown",
      outcome: commandDetails(outcome?.commandOutcome),
      ...(error ? { failure: failureDetails(error) } : {}) };
    const failures = [];
    for (const stream of ["stdout", "stderr"]) {
      try { execution[stream] = await save(`${stream}.txt`, outcome?.[stream] ?? ""); }
      catch (failure) { failures.push(failure); }
    }
    if (failures.length) {
      execution.status = "failed";
      execution.retentionFailures = failures.map((failure) => failureDetails(failure));
    }
    const bytes = appleJSON(execution);
    try {
      await completion.writeFile(bytes);
      await completion.sync();
      execution.response = { path: `${relative}/command-response.json`, sha256: hash(bytes) };
    } catch (failure) { failures.push(failure); }
    if (failures.length) throw Object.assign(
      new AggregateError([...(error ? [error] : []), ...failures], "Catalogue command evidence could not be retained completely."),
      { diagnosticCode: "report-write", processTreeStopped: execution.cleanup === "completed", appleCatalogExecution: execution });
  } finally { await completion.close(); }
  if (error) throw error;
  if (execution.cleanup !== "completed") fail("cleanup-failed");
  const enumeration = await json(root, path.join(absolute, "enumeration.json"));
  normalizeAppleTestCatalog(enumeration.value, plan.scheme.targets);
  return { version, kind: "local-apple-catalog", status: "enumerated", complete: false, acceptance: false,
    base, source: before.source, context: before, plan: input.reference, directory: relative, target,
    execution, enumeration: enumeration.reference, data: enumeration.value, checks: [] };
}

async function appleCatalog(root, file, input, target) {
  const catalog = await json(root, file), value = catalog.value, plan = input.value;
  if (!equal(value?.context, plan.context)) fail("environment-changed");
  const request = await retained(root, value.request);
  if (request.action !== "apple-catalog" || request.role !== target.role ||
      path.resolve(root, request.plan) !== path.resolve(root, input.reference.path)) fail("discovery");
  validateAppleBatchCatalog(value, { base: plan.base, source: plan.context.source, workspace: root,
    directory: plan.directory, plan: input.reference, startedAt: plan.createdAt,
    completedAt: new Date().toISOString(), scheme: plan.scheme }, target);
  const { response, ...execution } = value.execution;
  if (!equal(await retained(root, response), execution)) fail("artifact-changed");
  const start = await retained(root, execution.request);
  if (!equal(start, Object.fromEntries(["id", "kind", "origin", "file", "args", "cwd", "startedAt"]
    .map((key) => [key, execution[key]])))) fail("execution-origin");
  for (const reference of [execution.stdout, execution.stderr]) {
    if ((await artifact(root, reference.path, 16 * 1024 * 1024)).reference.sha256 !== reference.sha256) fail("artifact-changed");
  }
  if (!equal(await retained(root, value.enumeration), value.data)) fail("artifact-changed");
  return value;
}

async function binding(root, base, request, before, signal) {
  const plan = await currentPlan(root, base, request.plan, before, signal);
  const result = { version, kind: "local-refinement-binding", base, plan: plan.reference,
    context: before, source: before.source, hooks: before.hooks, observedAt: new Date().toISOString(),
    status: "observed", complete: false, acceptance: false, checks: [] };
  if (request.before) {
    const original = await json(root, request.before);
    await retained(root, original.value.request);
    if (original.value.kind !== result.kind || original.value.version !== version || original.value.before ||
        !equal(original.value.context, before) || !equal(original.value.plan, plan.reference) ||
        !timestamp(original.value.observedAt) || original.value.observedAt > result.observedAt) fail("source-mismatch");
    result.before = path.join(root, original.reference.path);
    result.beforeSha256 = original.reference.sha256;
  }
  return result;
}

async function bindingPair(root, file, plan) {
  const after = await json(root, file), value = after.value;
  await retained(root, value?.request);
  if (value?.kind !== "local-refinement-binding" || value.version !== version ||
      !equal(value.context, plan.value.context) || !equal(value.plan, plan.reference) ||
      !timestamp(value.observedAt) || value.observedAt < plan.value.createdAt ||
      Date.parse(value.observedAt) > Date.now()) fail("source-mismatch");
  const before = await json(root, value.before);
  await retained(root, before.value.request);
  if (before.reference.sha256 !== value.beforeSha256 || before.value.kind !== value.kind ||
      before.value.version !== version || before.value.before || !equal(before.value.context, value.context) ||
      !equal(before.value.plan, plan.reference) || !timestamp(before.value.observedAt) ||
      before.value.observedAt < plan.value.createdAt || before.value.observedAt > value.observedAt) fail("source-mismatch");
  return { before, after };
}

function testCases(value) {
  if (!Array.isArray(value)) fail("discovery");
  const cases = [];
  let visited = 0;
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 20 || ++visited > 10000) fail("discovery");
    if (node.nodeType === "Test Case") cases.push(node);
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) fail("discovery");
      node.children.forEach((child) => visit(child, depth + 1));
    }
  };
  value.forEach((node) => visit(node));
  return cases;
}

function testOutcome(summary, tests, target, invocation) {
  const cases = testCases(tests?.testNodes), device = summary?.devicesAndConfigurations?.[0];
  if (summary?.result !== "Passed" || summary.failedTests !== 0 || summary.skippedTests !== 0 ||
      summary.expectedFailures !== 0 || !Array.isArray(summary.testFailures) || summary.testFailures.length ||
      !Array.isArray(summary.devicesAndConfigurations) || summary.devicesAndConfigurations.length !== 1 ||
      !Array.isArray(tests.devices) || tests.devices.length !== 1 ||
      !equal(device.device, tests.devices[0]) || device.device.deviceId !== target.deviceId ||
      device.device.platform !== target.platform || device.device.osVersion !== target.osVersion ||
      device.failedTests !== 0 || device.skippedTests !== 0 || device.expectedFailures !== 0 ||
      cases.length !== target.identifiers.length || summary.totalTestCount !== cases.length ||
      summary.passedTests !== cases.length || device.passedTests !== cases.length ||
      new Set(cases.map((item) => item.nodeIdentifier)).size !== cases.length ||
      cases.some((item) => item.result !== "Passed" || !target.identifiers.includes(item.nodeIdentifier))) {
    fail("check-failed");
  }
  return { device: device.device, identifiers: cases.map((item) => item.nodeIdentifier),
    ...appleTestInterval(summary, invocation) };
}

async function resultExport(root, bundle, kind, signal) {
  const reader = await resolveVerificationExecutable(root, "xcrun");
  let output;
  try {
    output = await runCommand(reader, ["xcresulttool", "get", "test-results", kind, "--path", bundle, "--compact"],
      { cwd: root, timeoutMs: 30000, signal });
  } catch (error) {
    throw Object.assign(verificationFault("collector-failed", {}, error),
      error.processTreeStopped === false ? { processTreeStopped: false } : {});
  }
  try { return JSON.parse(output.stdout); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    fail("collector-failed");
  }
}

async function bundleFiles(root, directory, produced = false, manifest = false) {
  const absolute = produced ? await realpath(directory) : await location(root, directory, true), files = {};
  const entries = [];
  if (produced && (!path.isAbsolute(directory) ||
      !(path.basename(directory) === "DevPocket.app" || produced === "xcresult" && directory.endsWith(".xcresult")) ||
      !(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())) fail("ownership-mismatch");
  let total = 0;
  const visit = async (relative, depth = 0) => {
    if (depth > 20) fail("output-limit");
    for (const entry of await readdir(path.join(absolute, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) fail("ownership-mismatch");
      if (entry.isDirectory()) await visit(name, depth + 1);
      else {
        if (!entry.isFile() || Object.keys(files).length >= 10000) fail("artifact-changed");
        const item = await regularArtifact(path.join(absolute, name), 64 * 1024 * 1024);
        total += item.bytes.length;
        if (total > 512 * 1024 * 1024) fail("output-limit");
        files[name.replaceAll("\\", "/")] = item.sha256;
        entries.push({ path: name.replaceAll("\\", "/"), bytes: item.bytes.length, sha256: item.sha256 });
      }
    }
  };
  await visit("");
  if (await realpath(path.resolve(root, directory)) !== absolute) fail("artifact-changed");
  return manifest ? entries.sort((a, b) => a.path.localeCompare(b.path)) : files;
}

async function nativeTree(root, directory, producedBy) {
  const files = await bundleFiles(root, directory, false, true);
  return { path: path.relative(root, path.resolve(root, directory)).replaceAll("\\", "/"),
    producedBy, files, sha256: appleDigest(appleJSON(files)) };
}

async function sealedProduct(root, item, seal, source, renderer) {
  if (!["ios", "macos"].includes(item.platform) || !sameSource(seal?.source, source) ||
      seal.signatureExitCode !== 0 || !text(seal.bundleId) || !text(seal.minimumOS) ||
      !seal.files || Object.keys(seal.files).length < 2) fail("artifact-changed");
  const files = await bundleFiles(root, item.bundle);
  const required = item.platform === "macos" ? ["Contents/Info.plist", "Contents/MacOS/DevPocket"] : ["Info.plist", "DevPocket"];
  if (required.some((file) => !Object.hasOwn(files, file)) ||
      Object.keys(files).length !== Object.keys(seal.files).length ||
      Object.entries(files).some(([file, digest]) => seal.files[file] !== digest)) fail("artifact-changed");
  const prefix = item.platform === "macos" ? "Contents/Resources/Renderer/" : "Renderer/";
  const packaged = Object.entries(files).filter(([file]) => file.startsWith(prefix))
    .map(([file, digest]) => [file.slice(prefix.length), digest]).sort();
  if (!Array.isArray(renderer) || !renderer.length ||
      !equal(packaged, renderer.map(([file, identity]) => [file, identity.sha256]).sort())) fail("artifact-changed");
  return files;
}

async function workspaceBinding(root, nativeRequest, supplied, observedBefore) {
  const identifier = nativeRequest?.data?.arguments?.workspaceIdentifier;
  const project = path.join(root, APPLE_REQUIREMENTS.project);
  if (identifier === project) return { identifier, evidence: [] };
  if (!text(identifier) || !supplied) fail("execution-origin");
  const start = await json(root, supplied.requestEvent), finish = await json(root, supplied.responseEvent);
  const event = start.value, result = finish.value;
  if (event?.type !== "tool.execution_start" || event.data?.mcpServerName !== "xcode" ||
      event.data.mcpToolName !== "XcodeListWorkspaces" || !text(event.data.toolCallId) ||
      result?.type !== "tool.execution_complete" || result.data?.toolCallId !== event.data.toolCallId ||
      result.data.success !== true || result.data.result?.isError === true ||
      typeof result.data.result?.structuredContent?.message !== "string" ||
      !timestamp(event.timestamp) || !timestamp(result.timestamp) ||
      event.timestamp < observedBefore || result.timestamp < event.timestamp ||
      result.timestamp > nativeRequest.timestamp) fail("execution-origin");
  const mappings = result.data.result.structuredContent.message.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const match = /^\*\s*workspaceIdentifier:\s*([^,\r\n]+),\s*workspacePath:\s*(.+)$/.exec(line.trim());
    if (!match || !path.isAbsolute(match[2])) fail("execution-origin");
    return { identifier: match[1].trim(), path: match[2] };
  });
  const matches = mappings.filter((item) => item.identifier === identifier);
  if (matches.length !== 1 || matches[0].path !== project) fail("execution-origin");
  return { identifier, evidence: [start.reference, finish.reference] };
}

function buildInvocation(start, finish, root, observedBefore, observedAfter, identifier) {
  const args = start?.data?.arguments, result = finish?.data?.result?.structuredContent;
  const project = path.join(root, "apple", "DevPocket", "DevPocket.xcodeproj");
  if (start?.type !== "tool.execution_start" || start.data?.mcpServerName !== "xcode" ||
      start.data.mcpToolName !== "BuildProject" || !text(start.data.toolCallId) ||
      finish?.type !== "tool.execution_complete" || finish.data?.toolCallId !== start.data.toolCallId ||
      finish.data.success !== true || finish.data.result?.isError === true ||
      args?.workspaceIdentifier !== identifier ||
      (args.buildForTesting !== undefined && args.buildForTesting !== false) ||
      Object.keys(args).some((key) => !["workspaceIdentifier", "buildForTesting"].includes(key)) ||
      result?.buildResult !== "The project built successfully." || !Array.isArray(result.errors) || result.errors.length ||
      !Number.isFinite(result.elapsedTime) || result.elapsedTime < 0 ||
      !text(result.fullLogPath) || !path.isAbsolute(result.fullLogPath) ||
      !/^BuildProject-Log-[A-Za-z0-9_.-]+\.txt$/.test(path.basename(result.fullLogPath)) ||
      !timestamp(start.timestamp) || !timestamp(finish.timestamp) ||
      start.timestamp < observedBefore || finish.timestamp < start.timestamp || finish.timestamp > observedAfter) {
    fail("check-failed");
  }
  return { toolCallId: start.data.toolCallId, tool: "xcode/BuildProject", workspace: project,
    kind: "original-client-tool-call", startedAt: start.timestamp, completedAt: finish.timestamp,
    elapsedSeconds: result.elapsedTime, fullLogPath: result.fullLogPath };
}

async function buildEvidence(root, item, pair, source, renderer) {
  const start = await json(root, item.requestEvent), finish = await json(root, item.responseEvent);
  const workspace = await workspaceBinding(root, start.value, item.workspaceBinding, pair.before.value.observedAt);
  const execution = buildInvocation(start.value, finish.value, root,
    pair.before.value.observedAt, pair.after.value.observedAt, workspace.identifier);
  const log = await artifact(root, item.log), originalLog = await regularArtifact(execution.fullLogPath);
  if (log.reference.sha256 !== originalLog.sha256) fail("artifact-changed");
  const content = log.bytes.toString("utf8");
  const products = [...new Set([...content.matchAll(
    /^\s*(?:CodeSign|Validate) (.+\/DevPocket\.app) \(in target 'DevPocket' from project 'DevPocket'\)\s*$/gm,
  )].map((match) => match[1]))];
  if (!/^\*\* BUILD SUCCEEDED \*\*\s*$/m.test(content) || /\*\* BUILD (?:FAILED|CANCELLED) \*\*/.test(content) ||
      !content.split(/\r?\n/).some((line) => line.trim() === `cd ${path.join(root, "apple", "DevPocket")}`) ||
      products.length !== 1 || !path.isAbsolute(products[0]) ||
      path.basename(path.dirname(products[0])) !== (item.platform === "ios" ? "Debug-iphonesimulator" : "Debug")) {
    fail("execution-origin");
  }
  const seal = await json(root, item.artifact);
  if (seal.value.originalProduct !== products[0]) fail("artifact-changed");
  const files = await sealedProduct(root, item, seal.value, source, renderer);
  if (!equal(files, await bundleFiles(root, products[0], true))) fail("artifact-changed");
  return { execution, product: products[0], bundle: item.bundle,
    evidence: [start.reference, finish.reference, ...workspace.evidence, log.reference, seal.reference] };
}

async function qualify(root, base, request, before, signal) {
  const input = await currentPlan(root, base, request.plan, before, signal), plan = input.value;
  if (plan.kind !== "local-refinement-plan") fail("configuration");
  if (!Array.isArray(request.tests) || request.tests.length !== plan.selection.tests.length ||
      !Array.isArray(request.builds) || request.builds.length !== 2) fail("shard-missing");
  const checks = [], calls = new Set();
  for (const [index, target] of plan.selection.tests.entries()) {
    signal?.throwIfAborted();
    const supplied = request.tests[index];
    const pair = await bindingPair(root, supplied?.binding, input);
    const summary = await json(root, supplied?.summary), tests = await json(root, supplied?.tests);
    const selected = target.identifiers.map((id) => ({ targetName: id.slice(0, id.indexOf("/")), testIdentifier: id }));
    const native = await nativeTestEvidence(root, supplied, pair, target, signal, selected);
    if (!equal(native.selected, appleTestSelection(selected))) fail("case-evidence");
    if (!equal(native.summary, summary.value) || !equal(native.testTree, tests.value)) fail("artifact-changed");
    if (calls.has(native.execution.toolCallId)) fail("check-duplicate");
    calls.add(native.execution.toolCallId);
    const result = testOutcome(native.summary, native.testTree, target, native.execution);
    checks.push({ id: `apple-tests-${index}`, status: "passed", execution: native.execution, result,
      source: before.source, evidence: [...native.evidence, summary.reference, tests.reference],
      resultBundle: path.relative(root, native.bundle).replaceAll("\\", "/") });
  }
  for (const platform of plan.selection.builds) {
    signal?.throwIfAborted();
    const builds = request.builds.filter((item) => item?.platform === platform);
    if (builds.length !== 1) fail("check-duplicate");
    const item = builds[0];
    const pair = await bindingPair(root, item.binding, input);
    const built = await buildEvidence(root, item, pair, before.source, before.environment.preparation.renderer);
    if (calls.has(built.execution.toolCallId)) fail("check-duplicate");
    calls.add(built.execution.toolCallId);
    checks.push({ id: `apple-build-${platform}`, status: "passed", source: before.source,
      execution: built.execution, product: built.product, bundle: built.bundle,
      observation: { startedAt: pair.before.value.observedAt, completedAt: pair.after.value.observedAt },
      evidence: [...built.evidence, pair.before.reference, pair.after.reference] });
  }
  return { version, kind: "local-refinement-verification", status: "passed", complete: true, acceptance: false,
    reviewRequired: true, base, source: before.source, context: before, plan: input.reference,
    checkpoint: plan.checkpoint, changedFiles: plan.changedFiles, selection: plan.selection, checks,
    note: "Local Apple refinement evidence only. Independent review and fresh local authority are still required; not PR CI evidence." };
}

export function validateAppleMcpTestInvocation(start, finish, root, pair, target, identifier, selected) {
  return mcpTestInvocation(start, finish, root, pair, target, identifier, selected);
}

function mcpTestInvocation(start, finish, root, pair, target, identifier, selected) {
  const args = start?.data?.arguments, result = finish?.data?.result?.structuredContent;
  const tool = selected ? "RunSomeTests" : "RunAllTests";
  if (start?.type !== "tool.execution_start" || start.data?.mcpServerName !== "xcode" ||
      start.data.mcpToolName !== tool || !text(start.data.toolCallId) ||
      finish?.type !== "tool.execution_complete" || finish.data?.toolCallId !== start.data.toolCallId ||
      finish.data.success !== true || finish.data.result?.isError === true ||
      !text(identifier) || args?.workspaceIdentifier !== identifier ||
      Object.keys(args).some((key) => key !== "workspaceIdentifier" && !(selected && key === "tests")) ||
      result?.schemeName !== APPLE_REQUIREMENTS.scheme || result.truncated !== false ||
      !Array.isArray(result.results) || !result.results.length ||
      !text(result.xcresultBundlePath) || !path.isAbsolute(result.xcresultBundlePath) ||
      !result.xcresultBundlePath.endsWith(".xcresult") ||
      !timestamp(start.timestamp) || !timestamp(finish.timestamp) ||
      start.timestamp < pair.before.value.observedAt || finish.timestamp < start.timestamp ||
      finish.timestamp > pair.after.value.observedAt ||
      result.counts?.total !== result.results.length || result.totalResults !== result.results.length ||
      result.counts.passed !== result.results.length ||
      ["failed", "skipped", "expectedFailures", "notRun"].some((key) => result.counts[key] !== 0) ||
      result.results.some((item) => !text(item?.targetName) || !text(item.identifier) ||
        item.state !== "Passed" || !Array.isArray(item.errorMessages) || item.errorMessages.length) ||
      new Set(result.results.map((item) => `${item.targetName}/${item.identifier}`)).size !== result.results.length) {
    fail("case-evidence");
  }
  let requested;
  if (selected) {
    const allowed = appleTestSelection(selected);
    requested = appleTestSelection(args.tests);
    if (requested.length > 100 ||
        requested.some((test) => !allowed.some((item) => equal(item, test))) ||
        !equal(appleTestSelection(result.results.map((item) =>
          ({ targetName: item.targetName, testIdentifier: item.identifier }))), requested)) fail("case-evidence");
  }
  return { execution: { origin: "local-xcode-mcp", kind: "original-client-tool-call",
    workspace: path.join(root, APPLE_REQUIREMENTS.project), tool: `xcode/${tool}`,
    toolCallId: start.data.toolCallId, startedAt: start.timestamp, completedAt: finish.timestamp },
  result, target, ...(requested ? { selected: requested } : {}) };
}

async function nativeTestEvidence(root, item, pair, target, signal, selected) {
  const start = await json(root, item.requestEvent), finish = await json(root, item.responseEvent);
  const workspace = await workspaceBinding(root, start.value, item.workspaceBinding, pair.before.value.observedAt);
  const call = mcpTestInvocation(start.value, finish.value, root, pair, target, workspace.identifier, selected);
  const bundle = await location(root, item.resultBundle, true);
  if (!bundle.endsWith(".xcresult") || bundle === await realpath(call.result.xcresultBundlePath)) fail("artifact-changed");
  const summary = await resultExport(root, call.result.xcresultBundlePath, "summary", signal);
  const testTree = await resultExport(root, call.result.xcresultBundlePath, "tests", signal);
  if (!equal(summary, await resultExport(root, bundle, "summary", signal)) ||
      !equal(testTree, await resultExport(root, bundle, "tests", signal)) ||
      !equal(await bundleFiles(root, call.result.xcresultBundlePath, "xcresult"),
        await bundleFiles(root, bundle))) fail("artifact-changed");
  return { ...call, summary, testTree, bundle,
    evidence: [start.reference, finish.reference, ...workspace.evidence, pair.before.reference, pair.after.reference] };
}

async function qualifyApple(root, base, request, before, signal) {
  const input = await currentPlan(root, base, request.plan, before, signal), plan = input.value;
  if (plan.selection.testMode === "xcodebuild") return qualifyAppleCommands(root, base, request, before, input, signal);
  if (plan.kind !== "local-apple-plan" || !Array.isArray(request.tests) || request.tests.length !== 4 ||
      !Array.isArray(request.builds) || request.builds.length !== 2) fail("configuration");
  const evidence = { version: 1, kind: "apple-native-evidence", origin: "local-xcode-mcp",
    base, source: before.source, sourceBefore: plan.context.source, sourceAfter: before.source,
    workspace: root, directory: plan.directory, runId: plan.runId, apple: plan.apple,
    startedAt: plan.createdAt, completedAt: null, status: "passed", cleanup: "completed",
    failures: [], toolchain: plan.toolchain, scheme: plan.scheme, plan: input.reference, builds: [], tests: [] };
  for (const target of plan.selection.tests) {
    signal?.throwIfAborted();
    const matches = request.tests.filter((item) => item?.role === target.role);
    if (matches.length !== 1) fail("case-evidence");
    const item = matches[0];
    if (plan.selection.testMode === "batches") {
      if (!Array.isArray(item.batches) || !item.batches.length ||
          Object.keys(item).some((key) => !["role", "catalog", "batches"].includes(key))) fail("case-evidence");
      const catalog = await appleCatalog(root, item.catalog, input, target);
      const selected = normalizeAppleTestCatalog(catalog.data, plan.scheme.targets), batches = [];
      for (const batch of item.batches) {
        signal?.throwIfAborted();
        if (batch?.role !== undefined && batch.role !== target.role) fail("case-evidence");
        const pair = await bindingPair(root, batch?.binding, input);
        const call = await nativeTestEvidence(root, batch, pair, target, signal, selected);
        batches.push({ action: "test", status: "passed", selected: call.selected,
          execution: { ...call.execution, evidence: call.evidence },
          originalResultBundle: call.result.xcresultBundlePath,
          resultBundle: await nativeTree(root, call.bundle, call.execution.toolCallId),
          summary: projectAppleXcresult("summary", call.summary), testTree: projectAppleXcresult("tests", call.testTree),
          result: normalizeAppleBatchResult(call.summary, call.testTree, target, call.execution, call.selected) });
      }
      const { context: _context, checks: _checks, ...projected } = catalog;
      evidence.tests.push({ role: target.role, action: "test", status: "passed", mode: "batches", target,
        catalog: projected, batches });
      continue;
    }
    if (item.catalog || item.batches) fail("case-evidence");
    const pair = await bindingPair(root, item.binding, input);
    const call = await nativeTestEvidence(root, item, pair, target, signal);
    const { summary, testTree } = call;
    const result = normalizeAppleTestResult(summary, testTree, target, call.execution, plan.scheme.targets);
    const observed = call.result.results.map((test) => `${test.targetName}/${test.identifier}`).sort();
    if (!equal(observed, result.cases.map((test) => `${test.target}/${test.identifier}`).sort())) fail("case-evidence");
    evidence.tests.push({ role: target.role, action: "test", status: "passed", target,
      execution: { ...call.execution, evidence: call.evidence },
      resultBundle: await nativeTree(root, call.bundle, call.execution.toolCallId),
      summary: projectAppleXcresult("summary", summary), testTree: projectAppleXcresult("tests", testTree), result });
  }
  for (const platform of ["ios", "macos"]) {
    const matches = request.builds.filter((item) => item.platform === platform);
    if (matches.length !== 1) fail("case-evidence");
    const item = matches[0], pair = await bindingPair(root, item.binding, input);
    const built = await buildEvidence(root, item, pair, before.source, before.environment.preparation.renderer);
    evidence.builds.push({ platform, action: "build", status: "passed", originalProduct: built.product,
      execution: { ...built.execution, origin: evidence.origin,
        evidence: [...built.evidence, pair.before.reference, pair.after.reference] },
      product: await nativeTree(root, built.bundle, built.execution.toolCallId) });
  }
  evidence.completedAt = new Date().toISOString();
  validateAppleNativeEvidence(evidence, { base, source: before.source, apple: plan.apple }, "local-xcode-mcp");
  return { version, kind: "local-apple-verification", status: "passed", complete: true, acceptance: false,
    reviewRequired: true, base, source: before.source, context: before, plan: input.reference,
    appleEvidence: evidence, checks: [] };
}

async function executeAppleCommands(root, base, request, before, directory, requestFile, signal) {
  const input = await currentPlan(root, base, request.plan, before, signal), plan = input.value;
  if (plan.kind !== "local-apple-plan" || plan.selection.testMode !== "xcodebuild" ||
      Object.keys(request).some((key) => !["action", "plan"].includes(key))) fail("configuration");
  const absolute = await location(root, directory, true);
  const relative = path.relative(root, path.join(absolute, "native")).replaceAll("\\", "/");
  if (!relative.startsWith(plan.directory + "/")) fail("ownership-mismatch");
  try {
    await lstat(path.join(root, relative));
    throw Object.assign(verificationFault("run-output-reused"), { appleCommandNotStarted: true });
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  try {
    await writeFile(path.join(root, plan.directory, "command-started.json"),
      appleJSON({ plan: input.reference, request: requestFile, directory: relative, startedAt: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") error.appleCommandNotStarted = true;
    throw error;
  }
  const evidence = await runAppleLocalCommands({ repo: root, plan: request.plan,
    directory: relative, request: requestFile, signal });
  const native = await json(root, `${relative}/apple-report.json`);
  if (evidence.status !== "passed" || evidence.cleanup !== "completed") {
    throw Object.assign(verificationFault("apple-command-failed"), {
      processTreeStopped: evidence.cleanup === "completed", appleCommandExecution: native.reference,
    });
  }
  if (!equal(native.value, evidence)) fail("artifact-changed");
  return { version, kind: "local-apple-command-run", status: "executed", base,
    source: before.source, context: before, plan: input.reference, directory: relative,
    nativeReport: native.reference, startedAt: evidence.startedAt, completedAt: evidence.completedAt,
    complete: false, acceptance: false, checks: [] };
}

async function qualifyAppleCommands(root, base, request, before, input, signal) {
  const plan = input.value;
  if (Object.keys(request).some((key) => !["action", "plan", "execution"].includes(key))) fail("configuration");
  const run = await json(root, request.execution), value = run.value;
  if (value?.kind !== "local-apple-command-run" || value.version !== version || value.status !== "executed" ||
      value.base !== base || !equal(value.source, before.source) || !equal(value.context, before) ||
      !equal(value.plan, input.reference) || !value.directory?.startsWith(plan.directory + "/")) fail("source-mismatch");
  const originalRequest = await retained(root, value.request);
  if (originalRequest.action !== "apple-run" ||
      !equal((await json(root, originalRequest.plan)).reference, input.reference)) fail("execution-origin");
  const evidence = await retained(root, value.nativeReport);
  const admission = await json(root, path.join(root, plan.directory, "command-started.json"));
  if (!equal(admission.value.plan, input.reference) || admission.value.directory !== value.directory ||
      !timestamp(admission.value.startedAt) || admission.value.startedAt > evidence.startedAt ||
      !equal((await json(root, admission.value.request)).reference, value.request)) fail("execution-origin");
  if (evidence.origin !== "local-xcodebuild" || evidence.workspace !== root ||
      evidence.directory !== value.directory || evidence.runId !== plan.runId ||
      !equal(evidence.local?.plan, input.reference) || !equal(evidence.local?.targets, plan.selection.tests) ||
      !equal(await retained(root, evidence.local.executionRequest), originalRequest)) fail("execution-origin");
  validateAppleNativeEvidence(evidence, { base, source: before.source, apple: plan.apple }, "local-xcodebuild");
  await validateAppleLocalArtifacts(root, evidence, before.environment.preparation.renderer);
  for (const item of evidence.tests) {
    for (const reference of [item.resultBundle, item.retainedResultBundle]) {
      for (const kind of ["summary", "tests"]) {
        const actual = projectAppleXcresult(kind, await resultExport(root, path.join(root, reference.path), kind, signal));
        if (!equal(actual, kind === "summary" ? item.summary : item.testTree)) fail("artifact-changed");
      }
    }
  }
  return { version, kind: "local-apple-verification", status: "passed", complete: true, acceptance: false,
    reviewRequired: true, base, source: before.source, context: before, plan: input.reference,
    execution: run.reference, appleEvidence: evidence, checks: [] };
}

async function executeLocalNativeRequest(root, base, requestFile, signal, apple, directory) {
  if (process.env.GITHUB_ACTIONS === "true" || process.platform !== "darwin") fail("configuration");
  root = await realpath(root);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base ?? "") ||
      (await readOnlyGit(root, ["rev-parse", "--verify", `${base}^{commit}`])).trim() !== base) fail("base-invalid");
  const request = await json(root, requestFile);
  let batchPlan, invalidation, commandPlan = false;
  const requireActivePlan = async () => {
    if (!invalidation) return;
    try { await lstat(invalidation); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    fail(commandPlan ? "apple-command-invalidated" : "apple-batch-invalidated");
  };
  if (request.value?.plan !== undefined) {
    const input = await json(root, request.value.plan), plan = input.value;
    if (plan?.kind === "local-apple-plan" && ["batches", "xcodebuild"].includes(plan.selection?.testMode) &&
        plan.base === base && plan.context?.workspace === root) {
      batchPlan = input;
      commandPlan = plan.selection.testMode === "xcodebuild";
      invalidation = path.join(await location(root, plan.directory, true), commandPlan ? "command-invalidated.json" : "batch-invalidated.json");
      await requireActivePlan();
    }
  }
  try {
    const before = await captureLocalRefinementContext(root, signal);
    let report;
    if (apple && !["apple-plan", "apple-catalog", "apple-run", "binding", "apple-qualify"].includes(request.value?.action) ||
        !apple && ["apple-plan", "apple-catalog", "apple-run", "apple-qualify"].includes(request.value?.action)) fail("configuration");
    if (request.value?.action === "apple-plan") report = await makeApplePlan(root, base, request.value, before, directory, signal);
    else if (request.value?.action === "apple-catalog") report = await makeAppleCatalog(root, base, request.value, before, directory, signal);
    else if (request.value?.action === "apple-run") report = await executeAppleCommands(root, base, request.value, before, directory, requestFile, signal);
    else if (request.value?.action === "apple-qualify") report = await qualifyApple(root, base, request.value, before, signal);
    else if (request.value?.action === "prepare-checkpoint") report = await prepareCheckpoint(root, base, request.value, before);
    else if (request.value?.action === "checkpoint") report = await acceptCheckpoint(root, base, request.value, before);
    else if (request.value?.action === "plan") report = await makePlan(root, base, request.value, before);
    else if (request.value?.action === "binding") report = await binding(root, base, request.value, before, signal);
    else if (request.value?.action === "qualify") report = await qualify(root, base, request.value, before, signal);
    else fail("configuration");
    await retained(root, request.reference);
    const after = await captureLocalRefinementContext(root, signal);
    if (!equal(before.environment, after.environment)) fail("environment-changed");
    if (!equal(before, after)) fail("source-changed");
    await requireActivePlan();
    return { ...report, request: request.reference };
  } catch (error) {
    if (batchPlan && error.appleCatalogNotStarted !== true && error.appleCommandNotStarted !== true) {
      try {
        await writeFile(invalidation, appleJSON({ version: 1, kind: commandPlan ? "apple-command-invalidation" : "apple-batch-invalidation",
          plan: batchPlan.reference, request: request.reference, observedAt: new Date().toISOString(),
          failure: failureDetails(error),
          ...(error.appleCatalogExecution ? { execution: error.appleCatalogExecution } : {}),
          ...(error.appleCommandExecution ? { execution: error.appleCommandExecution } : {}),
        }), { flag: "wx", mode: 0o600 });
      } catch (writeError) {
        if (writeError.code !== "EEXIST") throw Object.assign(
          new AggregateError([error, writeError], "The batch failure and its invalidation could not both be retained."),
          { diagnosticCode: "report-write" });
      }
    }
    throw error;
  }
}

export const executeLocalRefinement = (root, base, request, signal) =>
  executeLocalNativeRequest(root, base, request, signal, false);
export const executeLocalAppleRequest = (root, base, request, signal, directory) =>
  executeLocalNativeRequest(root, base, request, signal, true, directory);
