import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { activeHookSnapshot, sameSource } from "./candidate-commit.mjs";
import { readOnlyGit, sourceInputs, sourceSnapshot } from "./git-state.mjs";
import { combineVerification, verificationFault, verificationPlan } from "./verification.mjs";
import { readVerificationRun } from "./verification-run.mjs";
import { resolveVerificationExecutable, verificationExecutionPolicy } from "./verification-preflight.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exec = promisify(execFile);
const equal = isDeepStrictEqual;
const version = 1;
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

async function artifact(root, file, maximum = 2 * 1024 * 1024) {
  const absolute = await location(root, file), before = await lstat(absolute);
  if (before.size > maximum) fail("output-limit");
  const handle = await open(absolute, "r");
  let bytes;
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail("source-changed");
    bytes = await handle.readFile();
    for (const after of [await handle.stat(), await lstat(absolute)]) {
      if (["dev", "ino", "size", "mode", "nlink", "mtimeMs", "ctimeMs"].some((key) => opened[key] !== after[key])) {
        fail("source-changed");
      }
    }
  } finally { await handle.close(); }
  return { reference: { path: path.relative(root, absolute).replaceAll("\\", "/"), sha256: hash(bytes) }, bytes };
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

async function context(root) {
  const executable = await resolveVerificationExecutable(root, "git");
  const xcrun = await resolveVerificationExecutable(root, "xcrun");
  const xcode = await exec(xcrun, ["xcodebuild", "-version"],
    { cwd: root, timeout: 30000, maxBuffer: 64 * 1024, encoding: "utf8" });
  return {
    workspace: root,
    branch: (await readOnlyGit(root, ["symbolic-ref", "--quiet", "HEAD"])).trim(),
    source: await sourceSnapshot(root),
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
    },
  };
}

function reviewConclusion(event, source, base) {
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

async function capture(root, base, request, before) {
  const plan = await verificationPlan(root, base);
  const { input, run } = await fullEvidence(root, request.verification, before.source, base);
  combineVerification(plan, [input.value]);
  if (run.manifest.binding.policy !== before.policy) fail("policy-mismatch");
  const review = await json(root, request.review);
  const origin = reviewConclusion(review.value, before.source, base);
  if (!strings(request.nativeEvidence, 32)) fail();
  const nativeEvidence = [];
  for (const file of request.nativeEvidence) {
    const item = await json(root, file);
    if (!item.value?.source || !sha.test(item.value.source.fingerprint ?? "")) fail("source-mismatch");
    nativeEvidence.push({ ...item.reference, source: item.value.source });
  }
  if (!nativeEvidence.some((item) => sameSource(item.source, before.source))) fail("source-mismatch");
  const inputs = await sourceInputs(root), sources = {};
  for (const [file, mode, kind, digest] of inputs.filter(([file]) => allowed.has(file))) {
    if (mode !== "100644" || kind !== "file") fail("source-mismatch");
    const bytes = await readFile(path.join(root, file));
    if (bytes.length > 128 * 1024 || hash(bytes) !== digest) fail("source-changed");
    sources[file] = bytes.toString("utf8");
  }
  if (!application.some((file) => Object.hasOwn(sources, file))) fail("configuration");
  return { version, kind: "local-refinement-checkpoint", status: "checkpointed", complete: true, acceptance: false,
    base, context: before, inputs, sources, verification: input.reference,
    review: { ...review.reference, ...origin }, nativeEvidence, createdAt: new Date().toISOString(), checks: [] };
}

async function checkpoint(root, file, base) {
  const input = await json(root, file), value = input.value;
  if (value?.version !== version || value.kind !== "local-refinement-checkpoint" || value.status !== "checkpointed" ||
      value.base !== base || value.context?.workspace !== root ||
      !Array.isArray(value.inputs) || hash(JSON.stringify(value.inputs)) !== value.context.source?.fingerprint ||
      !value.sources || !Array.isArray(value.nativeEvidence) || !value.nativeEvidence.length) fail("source-mismatch");
  await retained(root, value.request);
  await fullEvidence(root, value.verification?.path, value.context.source, base);
  await retained(root, value.verification);
  reviewConclusion(await retained(root, value.review), value.context.source, base);
  for (const reference of value.nativeEvidence) {
    const native = await retained(root, reference);
    if (!sameSource(native.source, reference.source)) fail("source-mismatch");
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

async function currentPlan(root, base, file, before) {
  const input = await json(root, file), plan = input.value;
  if (plan?.version !== version || plan.kind !== "local-refinement-plan" || plan.status !== "planned" ||
      !timestamp(plan.createdAt)) fail();
  if (!sameSource(plan.context?.source, before.source)) fail("source-mismatch");
  if (!equal(plan.context.environment, before.environment)) fail("environment-changed");
  if (!equal(plan.context, before)) fail("policy-mismatch");
  await retained(root, plan.request);
  const expected = await makePlan(root, base, { checkpoint: plan.checkpoint?.path, selection: plan.selection }, before);
  for (const key of ["base", "context", "checkpoint", "changedFiles", "delta", "selection", "status"]) {
    if (!equal(plan[key], expected[key])) {
      if (key === "context" && !equal(plan.context.environment, before.environment)) fail("environment-changed");
      fail(key === "context" ? "source-mismatch" : "policy-mismatch");
    }
  }
  return input;
}

async function binding(root, base, request, before) {
  const plan = await currentPlan(root, base, request.plan, before);
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

function testOutcome(summary, tests, target, createdAt) {
  const cases = testCases(tests?.testNodes), device = summary?.devicesAndConfigurations?.[0];
  if (summary?.result !== "Passed" || summary.failedTests !== 0 || summary.skippedTests !== 0 ||
      summary.expectedFailures !== 0 || !Array.isArray(summary.testFailures) || summary.testFailures.length ||
      !Number.isFinite(summary.startTime) || !Number.isFinite(summary.finishTime) ||
      summary.startTime * 1000 < Date.parse(createdAt) || summary.finishTime < summary.startTime ||
      summary.finishTime * 1000 > Date.now() ||
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
    startedAt: new Date(summary.startTime * 1000).toISOString(), completedAt: new Date(summary.finishTime * 1000).toISOString() };
}

async function resultExport(root, bundle, kind) {
  const reader = await resolveVerificationExecutable(root, "xcrun");
  let output;
  try {
    output = await exec(reader, ["xcresulttool", "get", "test-results", kind, "--path", bundle, "--compact"],
      { cwd: root, timeout: 30000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
  } catch (error) {
    throw verificationFault("collector-failed", {}, error);
  }
  try { return JSON.parse(output.stdout); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    fail("collector-failed");
  }
}

async function bundleFiles(root, directory) {
  const absolute = await location(root, directory, true), files = {};
  let total = 0;
  const visit = async (relative, depth = 0) => {
    if (depth > 20) fail("output-limit");
    for (const entry of await readdir(path.join(absolute, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) fail("ownership-mismatch");
      if (entry.isDirectory()) await visit(name, depth + 1);
      else {
        if (!entry.isFile() || Object.keys(files).length >= 10000) fail("artifact-changed");
        const item = await artifact(root, path.join(absolute, name), 64 * 1024 * 1024);
        total += item.bytes.length;
        if (total > 512 * 1024 * 1024) fail("output-limit");
        files[name.replaceAll("\\", "/")] = item.reference.sha256;
      }
    }
  };
  await visit("");
  return files;
}

async function qualify(root, base, request, before) {
  const input = await currentPlan(root, base, request.plan, before), plan = input.value;
  if (!Array.isArray(request.tests) || request.tests.length !== plan.selection.tests.length ||
      !Array.isArray(request.builds) || request.builds.length !== 2) fail("shard-missing");
  const checks = [];
  for (const [index, target] of plan.selection.tests.entries()) {
    const supplied = request.tests[index];
    const pair = await bindingPair(root, supplied?.binding, input);
    const summary = await json(root, supplied?.summary), tests = await json(root, supplied?.tests);
    const bundle = await location(root, supplied?.resultBundle, true);
    if (!bundle.endsWith(".xcresult")) fail("artifact-changed");
    // Decode the retained bundle, not GetTestList's cache or an owner's success summary.
    const actualSummary = await resultExport(root, bundle, "summary"), actualTests = await resultExport(root, bundle, "tests");
    if (!equal(actualSummary, summary.value) || !equal(actualTests, tests.value)) fail("artifact-changed");
    const execution = testOutcome(actualSummary, actualTests, target, pair.before.value.observedAt);
    if (execution.completedAt > pair.after.value.observedAt) fail("execution-origin");
    checks.push({ id: `apple-tests-${index}`, status: "passed", execution,
      source: before.source, evidence: [pair.after.reference, pair.before.reference, summary.reference, tests.reference],
      resultBundle: path.relative(root, bundle).replaceAll("\\", "/") });
  }
  for (const platform of plan.selection.builds) {
    const builds = request.builds.filter((item) => item?.platform === platform);
    if (builds.length !== 1) fail("check-duplicate");
    const item = builds[0], seal = await json(root, item.artifact), log = await artifact(root, item.log);
    const pair = await bindingPair(root, item.binding, input);
    if (!sameSource(seal.value?.source, before.source) || seal.value.signatureExitCode !== 0 ||
        !text(seal.value.bundleId) || !text(seal.value.minimumOS) ||
        !log.bytes.length || !seal.value.files || Object.keys(seal.value.files).length < 2) fail("artifact-changed");
    const files = await bundleFiles(root, item.bundle);
    const required = platform === "macos" ? ["Contents/Info.plist", "Contents/MacOS/DevPocket"] : ["Info.plist", "DevPocket"];
    if (required.some((file) => !Object.hasOwn(files, file)) ||
        Object.keys(files).length !== Object.keys(seal.value.files).length ||
        Object.entries(files).some(([file, digest]) => seal.value.files[file] !== digest)) fail("artifact-changed");
    checks.push({ id: `apple-build-${platform}`, status: "passed", source: before.source,
      execution: { startedAt: pair.before.value.observedAt, completedAt: pair.after.value.observedAt }, bundle: item.bundle,
      evidence: [seal.reference, pair.before.reference, pair.after.reference, log.reference] });
  }
  return { version, kind: "local-refinement-verification", status: "passed", complete: true, acceptance: false,
    reviewRequired: true, base, source: before.source, context: before, plan: input.reference,
    checkpoint: plan.checkpoint, changedFiles: plan.changedFiles, selection: plan.selection, checks,
    note: "Local Apple refinement evidence only. Independent review and fresh local authority are still required; not PR CI evidence." };
}

export async function executeLocalRefinement(root, base, requestFile) {
  if (process.env.GITHUB_ACTIONS === "true") fail("configuration");
  root = await realpath(root);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base ?? "") ||
      (await readOnlyGit(root, ["rev-parse", "--verify", `${base}^{commit}`])).trim() !== base) fail("base-invalid");
  const request = await json(root, requestFile), before = await context(root);
  let report;
  if (request.value?.action === "checkpoint") report = await capture(root, base, request.value, before);
  else if (request.value?.action === "plan") report = await makePlan(root, base, request.value, before);
  else if (request.value?.action === "binding") report = await binding(root, base, request.value, before);
  else if (request.value?.action === "qualify") report = await qualify(root, base, request.value, before);
  else fail("configuration");
  await retained(root, request.reference);
  const after = await context(root);
  if (!equal(before.environment, after.environment)) fail("environment-changed");
  if (!equal(before, after)) fail("source-changed");
  return { ...report, request: request.reference };
}
