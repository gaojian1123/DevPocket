import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { executeLocalAppleRequest, executeLocalRefinement } from "../verification-refinement.mjs";
import { APPLE_REQUIREMENTS, validateAppleNativeEvidence } from "../apple-evidence.mjs";
import { combineVerification, executeVerification, sourceSnapshot, verificationPlan } from "../verification.mjs";
import { verificationImpact } from "../verification-policy.mjs";
import { developmentReviewRequirements } from "../development-policy.mjs";
import { readVerificationRun } from "../verification-run.mjs";
import { retainApplePreparationFailure } from "../verification-preflight.mjs";
import { diagnosticError, failureDetails } from "../diagnostic-errors.mjs";

const exec = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const view = "apple/DevPocket/DevPocket/ContentView.swift";
const controls = "apple/DevPocket/DevPocket/Controls.swift";
const uiTests = "apple/DevPocket/DevPocketUITests/DevPocketUITests.swift";
const nativeCase = "DevPocketUITests/testWorkbenchListsSessionsWithoutPromotionalCard()";
const nativeTest = process.platform === "darwin" ? test : test.skip;
const renderer = {
  "index.html": "<html>Synthetic renderer</html>\n",
  "component.js": "/* Synthetic renderer */\n",
  "component-fixtures.json": "[]\n",
};

async function save(root, file, value) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value) + "\n");
  return file;
}

async function fixture(t, fullApple = false) {
  const oldPath = process.env.PATH, oldCI = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  t.after(() => {
    process.env.PATH = oldPath;
    if (oldCI === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = oldCI;
  });
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/refinement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await save(root, ".gitignore", ".data/\n.tools/\nnode_modules/\ndist/\napple/DevPocket/Renderer/\n");
  await save(root, "package.json", { dependencies: { "fixture-dependency": "1.0.0" },
    scripts: { verify: `pwsh -NoProfile -File ${JSON.stringify(path.resolve("scripts/verify.ps1"))}` } });
  await save(root, "package-lock.json", { lockfileVersion: 3,
    packages: { "node_modules/fixture-dependency": { version: "1.0.0" } } });
  await save(root, "node_modules/fixture-dependency/package.json", { name: "fixture-dependency", version: "1.0.0" });
  await save(root, "node_modules/fixture-dependency/index.js", "/* Synthetic dependency */\n");
  await save(root, "apple/prepare-components.mjs", "// Synthetic preparation fixture\n");
  await save(root, "apple/Fixtures/components.json", []);
  await save(root, "packages/components/dist/spec.js", "// Synthetic prepared module\n");
  for (const [name, bytes] of Object.entries(renderer)) await save(root, "apple/DevPocket/Renderer/" + name, bytes);
  await save(root, view, "Text(\"Workbench\").font(.body)\n");
  await save(root, controls, "Text(\"Send\").font(.body)\n");
  await save(root, uiTests, "func testWorkbenchListsSessionsWithoutPromotionalCard() {}\n");
  await save(root, "docs/APPLE-CLIENT.md", "Fixture Apple client.\n");
  if (fullApple) {
    await save(root, `${APPLE_REQUIREMENTS.project}/project.pbxproj`, "// Synthetic project; never built by Xcode\n");
    await save(root, "scripts/apple-runner.mjs", "// Synthetic preflight input; never executed\n");
    await save(root, "scripts/verify.mjs", `import ${JSON.stringify(new URL("../verify.mjs", import.meta.url).href)};\n`);
    await save(root, `${APPLE_REQUIREMENTS.project}/xcshareddata/xcschemes/DevPocket.xcscheme`,
      `<Scheme><TestAction buildConfiguration="Debug"><Testables>${["DevPocketTests", "DevPocketUITests"].map((target) =>
        `<TestableReference skipped="NO" parallelizable="NO"><BuildableReference BlueprintName="${target}" BuildableName="${target}.xctest"/></TestableReference>`
      ).join("")}</Testables></TestAction></Scheme>`);
    await save(root, ".data/native-probes.json", nativeProbes());
  }
  const decoder = `const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), kind = args[args.indexOf("test-results") + 1];
if (args[0] === "xcodebuild" && args.includes("-version")) { console.log("Xcode 27.1\\nBuild version SyntheticFixture"); process.exit(0); }
if (fs.existsSync(".data/native-probes.json")) {
  const probes = JSON.parse(fs.readFileSync(".data/native-probes.json"));
  if (args.includes("-enumerate-tests")) {
    const output = args[args.indexOf("-test-enumeration-output-path") + 1];
    if (probes.catalogOutputRace) {
      fs.writeFileSync(path.join(path.dirname(output), "stdout.txt"), "Existing concurrent fixture output\\n");
      throw new Error("Synthetic enumeration failed after an output collision");
    }
    fs.writeFileSync(output, JSON.stringify(probes.enumeration));
    console.log("Synthetic enumeration; no Apple compiler or device invoked.");
    process.exit(0);
  }
  const key = JSON.stringify(args);
  if (Object.hasOwn(probes.outputs, key)) { process.stdout.write(probes.outputs[key]); process.exit(0); }
}
if (!["summary", "tests"].includes(kind)) throw new Error("Unexpected fixture decoder command");
process.stdout.write(fs.readFileSync(path.join(args[args.indexOf("--path") + 1], kind + ".json")));
`;
  const bin = path.join(root, ".tools", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "xcrun"), `#!/usr/bin/env node\n${decoder}`);
  await chmod(path.join(bin, "xcrun"), 0o755);
  if (fullApple) for (const [tool, output] of [["sw_vers", "27.0.1"], ["uname", process.arch]]) {
    await writeFile(path.join(bin, tool), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(output)});\n`);
    await chmod(path.join(bin, tool), 0o755);
  }
  process.env.PATH = bin + path.delimiter + oldPath;
  await exec("git", ["init", "--quiet", root]);
  await exec("git", ["config", "core.autocrlf", "false"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "Fixture"], { cwd: root });
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const plan = await verificationPlan(root, base);
  const report = await executeVerification(root, plan, {
    directory: path.join(root, ".data/verification/full"), captureRefinementContext: true,
  });
  assert.equal(report.complete, true);
  await save(root, ".data/verification/full/report.json", report);
  await save(root, ".data/apple/native.json", { source: report.source, status: "passed", synthetic: true });
  const acceptedProducts = [];
  for (const platform of ["ios", "macos"]) acceptedProducts.push(await product(root, "accepted", platform, report.source));
  const prepareRequest = { action: "prepare-checkpoint", verification: ".data/verification/full/report.json",
    nativeEvidence: [".data/apple/native.json"], acceptedProducts };
  const invoke = async (value, directory) => {
    const file = `${directory ?? ".data/verification"}/requests/${randomUUID()}.json`;
    await save(root, file, value);
    if (!directory) return executeLocalRefinement(root, base, file);
    await mkdir(path.join(root, directory), { recursive: true });
    return executeLocalAppleRequest(root, base, file, undefined, directory);
  };
  const subject = await invoke(prepareRequest), subjectFile = ".data/verification/subject.json";
  assert.equal(subject.status, "pending_review");
  assert.equal(subject.complete, false);
  await save(root, subjectFile, subject);
  const review = { type: "tool.execution_complete", data: { success: true, toolCallId: "fixture-review",
    toolTelemetry: { restrictedProperties: { agent_name: "devpocket-reviewer", agent_id: "fixture-agent" } },
    result: { content: "```json\n" + JSON.stringify({ verdict: "pass", base, reviewedSource: report.source,
      checkpointSha256: digest(await readFile(path.join(root, subjectFile))), findings: [] }) + "\n```" } } };
  await save(root, ".data/apple/review.json", review);
  const request = { action: "checkpoint", subject: subjectFile, review: ".data/apple/review.json" };
  const checkpoint = await invoke(request);
  await save(root, ".data/verification/checkpoint.json", checkpoint);
  return { root, base, checkpoint, report, request, prepareRequest, subjectFile, review, invoke };
}

async function product(root, label, platform, source, parent = ".data/apple") {
  const directory = `${parent}/${label}/${platform}`, bundle = directory + "/DevPocket.app";
  const originalProduct = path.join(root, `${parent}/${label}/produced`,
    platform === "macos" ? "Debug" : "Debug-iphonesimulator", "DevPocket.app");
  const files = platform === "macos" ? ["Contents/Info.plist", "Contents/MacOS/DevPocket"] : ["Info.plist", "DevPocket"];
  const contents = Object.fromEntries(files.map((file) => [file, "Synthetic product, not native acceptance.\n"]));
  const prefix = platform === "macos" ? "Contents/Resources/Renderer/" : "Renderer/";
  for (const [file, bytes] of Object.entries(renderer)) contents[prefix + file] = bytes;
  const hashes = {};
  for (const [file, bytes] of Object.entries(contents)) {
    await save(root, bundle + "/" + file, bytes);
    await save(root, path.relative(root, path.join(originalProduct, file)), bytes);
    hashes[file] = digest(bytes);
  }
  const artifact = directory + "/artifact.json";
  await save(root, artifact, { source, originalProduct, bundleId: "dev.devpocket.apple.fixtures",
    minimumOS: "27.0", signatureExitCode: 0, files: hashes });
  return { platform, artifact, bundle, originalProduct };
}

test("private preparation diagnostics preserve raw failure facts without inventing cleanup evidence", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/preparation-diagnostic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cause = Object.assign(new Error("PRIVATE_PREPARATION_ERROR", { cause: new Error("PRIVATE_NESTED_CAUSE") }), {
    stdout: "PRIVATE_PREPARATION_STDOUT", stderr: "PRIVATE_PREPARATION_STDERR", processTreeStopped: false,
    commandOutcome: { observedProcess: "owned-command-supervisor", reason: "timeout", exitCode: null,
      signal: "SIGTERM", outputTruncated: false, capturedBytes: 52,
      cleanupFailure: { reason: "cleanup-failed", processTreeStopped: false } },
  });
  cause[Symbol.for("nodejs.util.inspect.custom")] = () => { throw new Error("Custom inspection must not run"); };
  const failure = failureDetails(cause);
  const preparation = { version: 1, status: "blocked", groups: [{
    group: "backend", status: "blocked", issues: [{ prerequisite: "powershell", failure }],
    notProbed: [{ prerequisite: "npm", blockedBy: ["powershell"] }],
  }] };
  const error = Object.assign(diagnosticError("preflight-dependencies"), {
    processTreeStopped: false, preparation,
    preparationFailures: [{ group: "backend", prerequisite: "powershell", failure, error: cause }],
  });
  const original = failureDetails(error), source = { head: "1".repeat(40), fingerprint: "2".repeat(64) };
  const retained = await retainApplePreparationFailure(root, source, error);
  const bytes = await readFile(path.join(root, retained.path)), contents = bytes.toString("utf8");
  assert.equal(digest(bytes), retained.sha256);
  for (const value of ["PRIVATE_PREPARATION_ERROR", "PRIVATE_NESTED_CAUSE", "PRIVATE_PREPARATION_STDOUT",
    "PRIVATE_PREPARATION_STDERR", source.fingerprint, "notProbed", "blockedBy", "commandOutcome"]) {
    assert.ok(contents.includes(value), value);
  }
  assert.match(contents, /processTreeStopped: false/);
  assert.match(contents, /failedProcessId: 'unknown'/);
  assert.match(contents, /rawCleanupReceipt: 'unknown'/);
  assert.ok(!contents.includes("[Object]"));
  assert.deepEqual(failureDetails(error), original);
  assert.ok(!JSON.stringify(original).includes("PRIVATE_"));
  if (process.platform !== "win32") {
    assert.equal((await lstat(path.join(root, retained.path))).mode & 0o777, 0o600);
    assert.equal((await lstat(path.dirname(path.join(root, retained.path)))).mode & 0o777, 0o700);
  }
  const second = await retainApplePreparationFailure(root, source, error);
  assert.notEqual(second.path, retained.path);
  assert.deepEqual(await readFile(path.join(root, retained.path)), bytes);
});

async function failedPreparationEntry(t, blockDiagnostics = false) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/preparation-entry-"));
  const oldPath = process.env.PATH, oldCI = process.env.GITHUB_ACTIONS;
  let cleanupConfirmed = false;
  delete process.env.GITHUB_ACTIONS;
  t.after(async () => {
    process.env.PATH = oldPath;
    if (oldCI === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = oldCI;
    if (cleanupConfirmed) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Retained preparation fixture after unconfirmed or missing cleanup: ${root}`);
  });
  await save(root, ".gitignore", ".data/\n.tools/\n");
  await save(root, "package.json", { name: "synthetic-preparation-fixture", version: "1.0.0" });
  await exec("git", ["init", "--quiet", root]);
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "Synthetic fixture"], { cwd: root });
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const directory = ".data/verification/preparation-failure";
  // Deliberately only enough plan metadata to reach the failing preflight; no native catalogue is fabricated.
  const plan = { version: 2, kind: "local-apple-plan", base, directory,
    context: { workspace: root, source: await sourceSnapshot(root) }, selection: { testMode: "batches" } };
  const planFile = `${directory}/plan.json`;
  await save(root, planFile, plan);
  const request = `${directory}/request.json`, report = `${directory}/report.json`;
  await save(root, request, { action: "apple-catalog", plan: planFile, role: "mac" });
  if (blockDiagnostics) await save(root, ".data/verification/preparation-diagnostics", "Existing diagnostic path\n");
  const bin = path.join(root, ".tools/bin"), powershell = path.join(bin, "pwsh");
  await mkdir(bin, { recursive: true });
  await writeFile(powershell, "#!/usr/bin/env node\n" +
    "process.stdout.write('PRIVATE_PREPARATION_OUTPUT');process.stderr.write('PRIVATE_PREPARATION_ERROR');process.exitCode=37;\n");
  await chmod(powershell, 0o755);
  process.env.PATH = bin + path.delimiter + oldPath;
  let failure;
  try {
    await exec(process.execPath, [path.resolve("scripts/verify.mjs"), "--repo", root, "--base", base,
      "--apple-request", request, "--report", report]);
    assert.fail("The real entry must remain failed");
  } catch (error) {
    assert.equal(error.code, 1);
    failure = error;
  }
  const output = JSON.parse(await readFile(path.join(root, report)));
  cleanupConfirmed = output.failure?.processTreeStopped === true;
  assert.equal(output.kind, "local-apple-failure");
  assert.equal(output.failure.reason, "preflight-dependencies");
  assert.equal(output.failure.processTreeStopped, true);
  const invalidation = await readFile(path.join(root, directory, "batch-invalidated.json"), "utf8");
  for (const text of [JSON.stringify(output), failure.stdout, failure.stderr, invalidation]) {
    assert.ok(!text.includes("PRIVATE_PREPARATION"), text);
  }
  assert.equal(JSON.parse(invalidation).failure.reason, "preflight-dependencies");
  await assert.rejects(readFile(path.join(root, directory, "command-request.json")), { code: "ENOENT" });
  return { root, base, plan, directory, failure, output, invalidation };
}

nativeTest("the original Apple CLI retains the failing prerequisite privately before public projection", async (t) => {
  const f = await failedPreparationEntry(t);
  const directory = path.join(f.root, ".data/verification/preparation-diagnostics");
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const text = await readFile(path.join(directory, files[0]), "utf8");
  for (const value of ["powershell", "PRIVATE_PREPARATION_OUTPUT", "PRIVATE_PREPARATION_ERROR", "commandOutcome",
    "exitCode: 37", "--apple-request", f.plan.context.source.fingerprint, "notProbed"]) {
    assert.ok(text.includes(value), value);
  }
  assert.ok(!text.includes("[Object]"));
  const binding = `${f.directory}/binding.json`;
  await save(f.root, binding, { action: "binding", plan: `${f.directory}/plan.json` });
  await assert.rejects(executeLocalAppleRequest(f.root, f.base, binding, undefined, path.join(f.root, f.directory)),
    { diagnosticCode: "apple-batch-invalidated" });
  assert.equal(await readFile(path.join(f.root, f.directory, "batch-invalidated.json"), "utf8"), f.invalidation);
});

nativeTest("a private diagnostic write failure leaves the original preflight failure and cleanup status intact", async (t) => {
  const f = await failedPreparationEntry(t, true);
  const diagnostic = f.failure.stderr.split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch (error) { if (!(error instanceof SyntaxError)) throw error; return null; }
  }).find(value => value?.kind === "apple-preparation-diagnostic-failure");
  assert.ok(diagnostic);
  assert.equal(diagnostic.failure.reason, "report-write");
  assert.equal(diagnostic.originalFailure.reason, "preflight-dependencies");
  assert.equal(diagnostic.originalFailure.processTreeStopped, true);
  assert.equal(await readFile(path.join(f.root, ".data/verification/preparation-diagnostics"), "utf8"), "Existing diagnostic path\n");
});

const batchCases = [
  { targetName: "DevPocketTests", testIdentifier: "ModelAndWKTests/testModel()" },
  { targetName: "DevPocketUITests", testIdentifier: "WindowTests/testLayout()" },
  { targetName: "DevPocketUITests", testIdentifier: "WindowTests/testNavigation()" },
];
const fixtureDevice = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

function nativeProbes() {
  const types = APPLE_REQUIREMENTS.targets.slice(1).map((target) =>
    ({ name: target.deviceTypeName, identifier: `synthetic.type.${target.role}` }));
  const runtimes = ["27.0", "27.1"].map((version) => ({ version, isAvailable: true,
    identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replaceAll(".", "-")}`,
    supportedDeviceTypes: types }));
  const devices = Object.fromEntries(runtimes.map((runtime) => [runtime.identifier, []]));
  APPLE_REQUIREMENTS.targets.slice(1).forEach((target, index) => {
    const runtime = runtimes.find((item) => item.version === target.runtimeVersion);
    devices[runtime.identifier].push({ udid: fixtureDevice(index + 1), name: `Synthetic ${target.role}`,
      state: "Booted", deviceTypeIdentifier: types[index].identifier });
  });
  return {
    outputs: Object.fromEntries([
      [["--find", "xcodebuild"], "/Applications/Synthetic.app/Contents/Developer/usr/bin/xcodebuild\n"],
      [["--sdk", "iphoneos", "--show-sdk-version"], "27.1\n"],
      [["--sdk", "iphonesimulator", "--show-sdk-version"], "27.1\n"],
      [["--sdk", "macosx", "--show-sdk-version"], "27.1\n"],
      [["swift", "-version"], "Apple Swift version 7.0 (synthetic)\n"],
      [["simctl", "list", "--json"], JSON.stringify({ devices, runtimes, devicetypes: types })],
    ].map(([args, output]) => [JSON.stringify(args), output])),
    enumeration: { errors: [], values: [{ testPlan: "DevPocket", disabledTests: [],
      enabledTests: batchCases.map((item) => ({ identifier: `${item.targetName}/${item.testIdentifier}` })) }] },
  };
}

async function fullBatches(f) {
  const directory = ".data/verification/full-batches", planFile = `${directory}/plan.json`;
  await save(f.root, view, "Text(\"Changed Apple source fixture\")\n");
  const plan = await f.invoke({ action: "apple-plan", testMode: "batches",
    targets: APPLE_REQUIREMENTS.targets.map((target, index) => ({ role: target.role, deviceId: fixtureDevice(index) })) }, directory);
  await save(f.root, planFile, plan);
  const request = { action: "apple-qualify", plan: planFile, tests: [], builds: [] };
  for (const target of plan.selection.tests) {
    const folder = `${directory}/catalog-${target.role}`;
    const catalog = await f.invoke({ action: "apple-catalog", plan: planFile, role: target.role }, folder);
    const file = `${folder}/catalog.json`;
    await save(f.root, file, catalog);
    request.tests.push({ role: target.role, catalog: file, batches: [] });
  }
  const before = await f.invoke({ action: "binding", plan: planFile }, directory);
  await save(f.root, `${directory}/before.json`, before);
  const binding = `${directory}/after.json`, handle = "synthetic-batch-workspace";
  const workspaceBinding = { requestEvent: `${directory}/workspaces-request.json`,
    responseEvent: `${directory}/workspaces-response.json` };
  await save(f.root, workspaceBinding.requestEvent, { type: "tool.execution_start", timestamp: before.observedAt,
    data: { toolCallId: "synthetic-workspaces", mcpServerName: "xcode", mcpToolName: "XcodeListWorkspaces", arguments: {} } });
  await save(f.root, workspaceBinding.responseEvent, { type: "tool.execution_complete", timestamp: before.observedAt,
    data: { toolCallId: "synthetic-workspaces", success: true, result: { structuredContent: {
      message: `* workspaceIdentifier: ${handle}, workspacePath: ${path.join(f.root, APPLE_REQUIREMENTS.project)}`,
    } } } });
  for (const target of plan.selection.tests) for (const [index, selected] of [[batchCases[0]], batchCases.slice(1)].entries()) {
    const folder = `${directory}/${target.role}-${index}`, now = new Date().toISOString();
    const original = `${folder}/original.xcresult`, copy = `${folder}/retained.xcresult`;
    const device = { deviceId: target.deviceId, platform: target.platform, osVersion: target.osVersion, architecture: target.architecture };
    const summary = { result: "Passed", failedTests: 0, skippedTests: 0, expectedFailures: 0,
      passedTests: selected.length, totalTestCount: selected.length, testFailures: [],
      startTime: Date.parse(now) / 1000, finishTime: Date.parse(now) / 1000,
      devicesAndConfigurations: [{ device, failedTests: 0, skippedTests: 0, expectedFailures: 0, passedTests: selected.length }] };
    const tests = { devices: [device], testNodes: [{ nodeType: "Test Plan", name: "DevPocket", children:
      [...new Set(selected.map((item) => item.targetName))].map((name) => ({
        nodeType: name === "DevPocketTests" ? "Unit test bundle" : "UI test bundle", name,
        children: selected.filter((item) => item.targetName === name).map((item) =>
          ({ nodeType: "Test Case", nodeIdentifier: item.testIdentifier, result: "Passed" })),
      })) }] };
    for (const bundle of [original, copy]) {
      await save(f.root, `${bundle}/summary.json`, summary);
      await save(f.root, `${bundle}/tests.json`, tests);
      await save(f.root, `${bundle}/Info.plist`, "Synthetic xcresult only\n");
    }
    const requestEvent = `${folder}/request.json`, responseEvent = `${folder}/response.json`, id = `synthetic-${target.role}-${index}`;
    await save(f.root, requestEvent, { type: "tool.execution_start", timestamp: now, data: {
      toolCallId: id, mcpServerName: "xcode", mcpToolName: "RunSomeTests",
      arguments: { workspaceIdentifier: handle, tests: selected },
    } });
    await save(f.root, responseEvent, { type: "tool.execution_complete", timestamp: now, data: {
      toolCallId: id, success: true, result: { structuredContent: {
        schemeName: "DevPocket", truncated: false, xcresultBundlePath: path.join(f.root, original),
        counts: { total: selected.length, passed: selected.length, failed: 0, skipped: 0, expectedFailures: 0, notRun: 0 },
        totalResults: selected.length, results: selected.map((item) =>
          ({ targetName: item.targetName, identifier: item.testIdentifier, state: "Passed", errorMessages: [] })),
      } },
    } });
    request.tests.find((item) => item.role === target.role).batches.push({
      binding, workspaceBinding, requestEvent, responseEvent, resultBundle: copy,
    });
  }
  for (const platform of ["ios", "macos"]) {
    const built = await product(f.root, "products", platform, plan.context.source, directory);
    const folder = `${directory}/build-${platform}`, log = `${folder}/build.log`, now = new Date().toISOString();
    const originalLog = path.join(f.root, `${folder}/BuildProject-Log-synthetic.txt`);
    const bytes = `CodeSign ${built.originalProduct} (in target 'DevPocket' from project 'DevPocket')\n` +
      `    cd ${path.join(f.root, "apple", "DevPocket")}\n** BUILD SUCCEEDED **\n`;
    await save(f.root, log, bytes);
    await save(f.root, path.relative(f.root, originalLog), bytes);
    const requestEvent = `${folder}/request.json`, responseEvent = `${folder}/response.json`, id = `synthetic-build-${platform}`;
    await save(f.root, requestEvent, { type: "tool.execution_start", timestamp: now, data: {
      toolCallId: id, mcpServerName: "xcode", mcpToolName: "BuildProject",
      arguments: { workspaceIdentifier: handle, buildForTesting: false },
    } });
    await save(f.root, responseEvent, { type: "tool.execution_complete", timestamp: now, data: {
      toolCallId: id, success: true, result: { structuredContent: {
        buildResult: "The project built successfully.", errors: [], elapsedTime: 0, fullLogPath: originalLog,
      } },
    } });
    request.builds.push({ ...built, binding, workspaceBinding, log, requestEvent, responseEvent });
  }
  await save(f.root, binding, await f.invoke({ action: "binding", plan: planFile, before: `${directory}/before.json` }, directory));
  return { directory, plan, request };
}

nativeTest("complete local batches qualify original catalogues, handles, native exports and both normal products", async (t) => {
  const f = await fixture(t, true), native = await fullBatches(f);
  const result = await f.invoke(native.request, native.directory);
  assert.equal(result.status, "passed");
  assert.equal(result.complete, true);
  assert.equal(result.acceptance, false);
  assert.equal(result.reviewRequired, true);
  validateAppleNativeEvidence(result.appleEvidence, await verificationPlan(f.root, f.base), "local-xcode-mcp");
  assert.equal(result.appleEvidence.tests.length, 4);
  assert.ok(result.appleEvidence.tests.every((item) => item.mode === "batches" && item.batches.length === 2 && !item.execution));
  assert.equal(result.appleEvidence.builds.length, 2);
  const qualification = `${native.directory}/qualification.json`;
  await save(f.root, qualification, native.request);
  const gatePlan = await verificationPlan(f.root, f.base);
  const gate = await executeVerification(f.root, gatePlan, {
    directory: path.join(f.root, ".data/verification/full-batch-gate"), appleEvidence: qualification,
  });
  assert.equal(gate.version, 6);
  assert.equal(gate.status, "passed", JSON.stringify(gate));
  assert.equal(gate.complete, true);
  assert.deepEqual((await readVerificationRun(f.root, gate.run.manifest)).report, gate);
  assert.equal(combineVerification(gatePlan, [gate]).complete, true);
  assert.ok(gate.checks.find((item) => item.id === "apple-native").appleEvidence.tests.every((item) =>
    item.batches.every((batch) => batch.execution.tool === "xcode/RunSomeTests")));
  const first = native.request.tests[0].batches[0];
  assert.equal(JSON.parse(await readFile(path.join(f.root, first.requestEvent))).data.arguments.workspaceIdentifier,
    "synthetic-batch-workspace");
  await assert.rejects(f.invoke({ action: "apple-catalog", plan: native.request.plan, role: "mac" },
    `${native.directory}/catalog-mac`), { code: "EEXIST" });
  const mutate = async (file, edit, reason) => {
    const original = await readFile(path.join(f.root, file), "utf8"), value = JSON.parse(original);
    edit(value);
    await save(f.root, file, value);
    await assert.rejects(f.invoke(native.request, native.directory), { diagnosticCode: reason });
    await save(f.root, file, original);
    await assert.rejects(f.invoke(native.request, native.directory), { diagnosticCode: "apple-batch-invalidated" });
    const invalidation = `${native.directory}/batch-invalidated.json`;
    assert.equal(JSON.parse(await readFile(path.join(f.root, invalidation))).kind, "apple-batch-invalidation");
    // Reset only this synthetic fixture between independent invalid-input cases.
    await rm(path.join(f.root, invalidation));
  };
  await mutate(first.responseEvent, (event) => { event.data.success = false;
    event.data.error = { code: -32001, message: "Synthetic timeout; no native tests ran" }; }, "case-evidence");
  await mutate(first.workspaceBinding.responseEvent, (event) => {
    event.data.result.structuredContent.message = "* workspaceIdentifier: synthetic-batch-workspace, workspacePath: /wrong/project";
  }, "execution-origin");
  await mutate(first.binding, (value) => { value.context.source.fingerprint = "0".repeat(64); }, "source-mismatch");
  await mutate(native.request.tests[0].catalog, (value) => {
    value.context.environment.preparation.prepared = "0".repeat(64);
  }, "environment-changed");
  await mutate(native.request.tests[0].catalog, (value) => {
    value.data.values[0].enabledTests.pop();
  }, "artifact-changed");
  await mutate(`${first.resultBundle}/summary.json`, (value) => { value.skippedTests = 1; }, "artifact-changed");
  const duplicate = structuredClone(native.request);
  duplicate.tests[0].batches.push(duplicate.tests[0].batches[0]);
  await assert.rejects(f.invoke(duplicate, native.directory));
  await rm(path.join(f.root, native.directory, "batch-invalidated.json"));
  const missing = structuredClone(native.request);
  missing.tests[0].batches.pop();
  await assert.rejects(f.invoke(missing, native.directory), { diagnosticCode: "case-evidence" });
});

for (const action of ["binding", "qualify"]) nativeTest(`refinement ${action} cannot erase observed drift in a full batch plan`, async (t) => {
  const f = await fixture(t, true), native = await fullBatches(f);
  const original = await readFile(path.join(f.root, view), "utf8");
  await save(f.root, view, original + "// Source changed after batch execution\n");
  await assert.rejects(f.invoke({ action, plan: native.request.plan }), { diagnosticCode: "source-mismatch" });
  await save(f.root, view, original);
  await assert.rejects(f.invoke(native.request, native.directory), { diagnosticCode: "apple-batch-invalidated" });
});

nativeTest("catalogue output collisions are refused before any enumeration can launch", async (t) => {
  const f = await fixture(t, true), native = await fullBatches(f);
  const directory = `${native.directory}/catalog-collision`;
  await save(f.root, `${directory}/stdout.txt`, "Retained conflicting output\n");
  await mkdir(path.join(f.root, directory, "enumeration.json"));
  await assert.rejects(f.invoke({ action: "apple-catalog", plan: native.request.plan, role: "mac" }, directory));
  await assert.rejects(readFile(path.join(f.root, directory, "command-request.json")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.root, directory, "stdout.txt"), "utf8"), "Retained conflicting output\n");
  const probes = nativeProbes();
  probes.catalogOutputRace = true;
  await save(f.root, ".data/native-probes.json", probes);
  const raced = `${native.directory}/catalog-race`;
  await assert.rejects(f.invoke({ action: "apple-catalog", plan: native.request.plan, role: "mac" }, raced),
    { diagnosticCode: "report-write" });
  const completion = JSON.parse(await readFile(path.join(f.root, raced, "command-response.json")));
  assert.equal(completion.status, "failed");
  assert.equal(completion.outcome.exitCode, 1);
  assert.equal(completion.cleanup, "completed");
  assert.equal(completion.failure.reason, "command-failed");
  assert.equal(completion.retentionFailures.length, 1);
  const invalidated = JSON.parse(await readFile(path.join(f.root, native.directory, "batch-invalidated.json")));
  assert.equal(invalidated.execution.id, completion.id);
  assert.deepEqual(invalidated.execution.outcome, completion.outcome);
  await assert.rejects(f.invoke(native.request, native.directory), { diagnosticCode: "apple-batch-invalidated" });
});

function selected(paths = [view]) {
  return {
    reason: "Remove the duplicate promotional entry; session navigation remains covered.",
    unchangedCoverage: "Retain original native evidence for unchanged model/renderer/platform inputs; do not boot Duo.",
    tests: [{ platform: "iOS Simulator", deviceId: "fixture-iphone", osVersion: "27.0", identifiers: [nativeCase] }],
    coverage: paths.map((file) => ({ path: file, tests: [nativeCase], reason: "Exercises the affected workbench and navigation." })),
  };
}

async function commandPlan(f) {
  const directory = ".data/verification/commands", file = `${directory}/plan.json`;
  await save(f.root, view, "Text(\"Changed Apple source fixture\")\n");
  const plan = await f.invoke({ action: "apple-plan", testMode: "xcodebuild",
    targets: APPLE_REQUIREMENTS.targets.map((target, index) => ({ role: target.role, deviceId: fixtureDevice(index) })) }, directory);
  await save(f.root, file, plan);
  return { directory, file, plan };
}

nativeTest("local command planning retains all exact roles without executing a native test", async (t) => {
  const f = await fixture(t, true), p = await commandPlan(f);
  assert.equal(p.plan.selection.testMode, "xcodebuild");
  assert.equal(p.plan.selection.fullSuite, true);
  assert.deepEqual(p.plan.selection.builds, ["ios", "macos"]);
  assert.deepEqual(p.plan.selection.tests.map((target) => target.deviceId),
    APPLE_REQUIREMENTS.targets.map((_target, index) => fixtureDevice(index)));
  assert.equal(p.plan.complete, false);
  assert.equal(p.plan.acceptance, false);
  assert.ok(!(await readdir(path.join(f.root, p.directory))).includes("command-started.json"));
});

nativeTest("a used local command plan cannot start another native run", async (t) => {
  const f = await fixture(t, true), p = await commandPlan(f);
  await save(f.root, `${p.directory}/command-started.json`, { original: "Synthetic already admitted run" });
  await assert.rejects(f.invoke({ action: "apple-run", plan: p.file }, `${p.directory}/execution`),
    (error) => error.code === "EEXIST" && error.appleCommandNotStarted === true);
  assert.ok(!(await readdir(path.join(f.root, p.directory))).includes("command-invalidated.json"));
});

nativeTest("local command qualification cannot turn MCP receipts into command evidence", async (t) => {
  const f = await fixture(t, true), p = await commandPlan(f);
  await assert.rejects(f.invoke({ action: "apple-qualify", plan: p.file, tests: [], builds: [] }, p.directory),
    { diagnosticCode: "configuration" });
  const file = `${p.directory}/command-invalidated.json`, original = await readFile(path.join(f.root, file), "utf8");
  assert.equal(JSON.parse(original).kind, "apple-command-invalidation");
  await assert.rejects(f.invoke({ action: "binding", plan: p.file }, p.directory),
    { diagnosticCode: "apple-command-invalidated" });
  assert.equal(await readFile(path.join(f.root, file), "utf8"), original);
});

nativeTest("source drift permanently invalidates the local command plan", async (t) => {
  const f = await fixture(t, true), p = await commandPlan(f);
  const old = await readFile(path.join(f.root, controls), "utf8");
  await save(f.root, controls, old + "// A real changed source input in this synthetic fixture\n");
  await assert.rejects(f.invoke({ action: "binding", plan: p.file }, p.directory), { diagnosticCode: "source-mismatch" });
  await save(f.root, controls, old);
  await assert.rejects(f.invoke({ action: "binding", plan: p.file }, p.directory), { diagnosticCode: "apple-command-invalidated" });
});

async function planned(f, files = [view]) {
  for (const file of files) await save(f.root, file, "Text(\"Revised workbench\").font(.callout)\n");
  const plan = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected(files) });
  assert.equal(plan.status, "planned");
  await save(f.root, ".data/verification/plan.json", plan);
  return plan;
}

async function nativeEvidence(f, plan) {
  const directory = ".data/apple/fresh";
  const before = await f.invoke({ action: "binding", plan: ".data/verification/plan.json" });
  await save(f.root, directory + "/before.json", before);
  const device = { deviceId: "fixture-iphone", platform: "iOS Simulator", osVersion: "27.0", architecture: "arm64" };
  const now = Date.now() / 1000;
  const originalBundle = path.join(f.root, directory, "original", "result.xcresult");
  const summary = { result: "Passed", failedTests: 0, skippedTests: 0, expectedFailures: 0,
    passedTests: 1, totalTestCount: 1, testFailures: [], startTime: now, finishTime: now,
    devicesAndConfigurations: [{ device, failedTests: 0, skippedTests: 0, expectedFailures: 0, passedTests: 1 }] };
  const tests = { devices: [device], testNodes: [
    { nodeType: "Test Plan", children: [{ nodeType: "Test Case", nodeIdentifier: nativeCase, result: "Passed" }] },
  ] };
  for (const [name, value] of [["summary", summary], ["tests", tests]]) {
    await save(f.root, `${directory}/${name}.json`, value);
    await save(f.root, `${directory}/result.xcresult/${name}.json`, value);
    await save(f.root, path.relative(f.root, path.join(originalBundle, `${name}.json`)), value);
  }
  const requestEvent = `${directory}/tests-request.event.json`, responseEvent = `${directory}/tests-response.event.json`;
  const testTime = new Date(now * 1000).toISOString();
  await save(f.root, requestEvent, { type: "tool.execution_start", timestamp: testTime, data: {
    toolCallId: "fixture-selected-tests", mcpServerName: "xcode", mcpToolName: "RunSomeTests",
    arguments: { workspaceIdentifier: path.join(f.root, "apple", "DevPocket", "DevPocket.xcodeproj"),
      tests: [{ targetName: "DevPocketUITests", testIdentifier: nativeCase }] },
  } });
  await save(f.root, responseEvent, { type: "tool.execution_complete", timestamp: testTime, data: {
    toolCallId: "fixture-selected-tests", success: true, result: { structuredContent: {
      schemeName: "DevPocket", truncated: false, xcresultBundlePath: originalBundle,
      counts: { total: 1, passed: 1, failed: 0, skipped: 0, expectedFailures: 0, notRun: 0 },
      totalResults: 1, results: [{ targetName: "DevPocketUITests", identifier: nativeCase,
        state: "Passed", errorMessages: [] }],
    } },
  } });
  const request = { action: "qualify", plan: ".data/verification/plan.json",
    tests: [{ binding: directory + "/binding.json", summary: directory + "/summary.json",
      tests: directory + "/tests.json", resultBundle: directory + "/result.xcresult", requestEvent, responseEvent }], builds: [] };
  for (const platform of ["ios", "macos"]) {
    const built = await product(f.root, "fresh", platform, plan.context.source);
    const log = `${directory}/${platform}/build.log`;
    const originalLog = path.join(f.root, `${directory}/${platform}/BuildProject-Log-${platform}.txt`);
    const logBytes = `CodeSign ${built.originalProduct} (in target 'DevPocket' from project 'DevPocket')\n` +
      `    cd ${path.join(f.root, "apple", "DevPocket")}\n** BUILD SUCCEEDED **\n`;
    await save(f.root, log, logBytes);
    await save(f.root, path.relative(f.root, originalLog), logBytes);
    const call = `fixture-${platform}`, time = new Date().toISOString();
    const requestEvent = `${directory}/${platform}/request.event.json`, responseEvent = `${directory}/${platform}/response.event.json`;
    await save(f.root, requestEvent, { type: "tool.execution_start", timestamp: time, data: {
      toolCallId: call, mcpServerName: "xcode", mcpToolName: "BuildProject",
      arguments: { workspaceIdentifier: path.join(f.root, "apple", "DevPocket", "DevPocket.xcodeproj"), buildForTesting: false },
    } });
    await save(f.root, responseEvent, { type: "tool.execution_complete", timestamp: time, data: {
      toolCallId: call, success: true, result: { structuredContent: {
        buildResult: "The project built successfully.", errors: [], elapsedTime: 0, fullLogPath: originalLog,
      } },
    } });
    request.builds.push({ ...built, log, requestEvent, responseEvent, binding: directory + "/binding.json" });
  }
  const after = await f.invoke({ action: "binding", plan: ".data/verification/plan.json", before: directory + "/before.json" });
  await save(f.root, directory + "/binding.json", after);
  return { request, summary, tests, directory, originalBundle };
}

nativeTest("refinement MCP selections must equal the complete plan and native result set", async (t) => {
  const f = await fixture(t);
  await save(f.root, view, "Text(\"Revised workbench\").font(.callout)\n");
  const selection = selected(), second = "DevPocketUITests/testWorkbenchNavigation()";
  selection.tests[0].identifiers.push(second);
  const plan = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection });
  await save(f.root, ".data/verification/plan.json", plan);
  const native = await nativeEvidence(f, plan);
  native.summary.passedTests = native.summary.totalTestCount = native.summary.devicesAndConfigurations[0].passedTests = 2;
  native.tests.testNodes[0].children.push({ nodeType: "Test Case", nodeIdentifier: second, result: "Passed" });
  for (const [kind, data] of [["summary", native.summary], ["tests", native.tests]]) {
    await save(f.root, `${native.directory}/${kind}.json`, data);
    await save(f.root, `${native.directory}/result.xcresult/${kind}.json`, data);
    await save(f.root, path.relative(f.root, path.join(native.originalBundle, `${kind}.json`)), data);
  }
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "case-evidence" });
});

nativeTest("a local Apple refinement retains its full checkpoint and requires independent review", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const result = await f.invoke(native.request);
  assert.equal(result.status, "passed");
  assert.equal(result.complete, true);
  assert.equal(result.acceptance, false);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.base, f.base);
  assert.deepEqual(result.source, plan.context.source);
  assert.notEqual(result.source.fingerprint, f.checkpoint.context.source.fingerprint);
  assert.equal(result.checks.length, 3);
  assert.equal(result.checks[0].execution.tool, "xcode/RunSomeTests");
  assert.equal(result.checks[0].execution.workspace, path.join(f.root, "apple", "DevPocket", "DevPocket.xcodeproj"));
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, ".data/verification/full/report.json"))), f.report);
  assert.throws(() => combineVerification(f.report, [result]), { diagnosticCode: "policy-mismatch" });
  await assert.rejects(f.invoke({ action: "plan", checkpoint: f.subjectFile, selection: selected() }),
    { diagnosticCode: "report-invalid" });
});

nativeTest("the documented npm entry preserves context between the normal gate and checkpoint preparation", async (t) => {
  const f = await fixture(t);
  const invoke = (args) => exec("npm", ["run", "verify", "--", "-Base", f.base, ...args],
    { cwd: f.root, env: process.env, timeout: 120000, maxBuffer: 1024 * 1024 });
  await invoke(["-CaptureRefinementContext", "-Report", ".data/verification/cli-full/report.json"]);
  await save(f.root, ".data/verification/cli-prepare.json",
    { ...f.prepareRequest, verification: ".data/verification/cli-full/report.json" });
  const output = await invoke(["-Refinement", ".data/verification/cli-prepare.json",
    "-Report", ".data/verification/cli-subject/report.json"]);
  const bytes = await readFile(path.join(f.root, ".data/verification/cli-subject/report.json"));
  assert.equal(JSON.parse(bytes).status, "pending_review");
  assert.ok(output.stdout.includes(`Checkpoint subject SHA256: ${digest(bytes)}`));
});

nativeTest("cumulative presentation, added regression and documentation changes keep the original base", async (t) => {
  const f = await fixture(t);
  const first = await planned(f);
  await save(f.root, controls, "Text(\"Send\").font(.caption)\n");
  await save(f.root, uiTests, "func testWorkbenchListsSessionsWithoutPromotionalCard() { /* stronger regression */ }\n");
  await save(f.root, "docs/APPLE-CLIENT.md", "The workbench no longer contains the promotional card.\n");
  const second = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json",
    selection: selected([view, controls, uiTests]) });
  assert.equal(second.status, "planned");
  assert.equal(second.base, f.base);
  assert.deepEqual(second.changedFiles, [view, controls, uiTests, "docs/APPLE-CLIENT.md"].sort());
  assert.equal(second.delta.find((item) => item.path === view).before, f.checkpoint.sources[view]);
  assert.notEqual(second.context.source.fingerprint, first.context.source.fingerprint);
  assert.equal(second.selection.tests.length, 1);
});

nativeTest("unknown/model/build/dependency edits return full_required instead of silently narrowing", async (t) => {
  const f = await fixture(t);
  await planned(f);
  for (const file of ["apple/DevPocket/DevPocket/FixtureState.swift", "apple/prepare-components.mjs",
    "apple/DevPocket/DevPocket.xcodeproj/project.pbxproj", "backend/src/protocol.ts"]) {
    await save(f.root, file, "An out-of-scope fixture change\n");
  }
  const result = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() });
  assert.equal(result.status, "full_required");
  assert.equal(result.complete, false);
  assert.ok(result.reasons.includes("outside-apple-presentation"));
});

nativeTest("deleted presentation and uncovered companion inputs cannot qualify", async (t) => {
  const f = await fixture(t);
  await planned(f);
  await save(f.root, uiTests, "Changed test driver\n");
  await assert.rejects(f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() }),
    { diagnosticCode: "configuration" });
  await rm(path.join(f.root, view));
  const missing = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() });
  assert.equal(missing.status, "full_required");
  assert.ok(missing.reasons.includes("unsupported-source-change"));
});

nativeTest("Git environment changes remain explicit blockers even when source is unchanged", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  await exec("git", ["config", "core.quotePath", "false"], { cwd: f.root });
  const next = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() });
  assert.equal(next.status, "full_required");
  assert.ok(next.reasons.includes("environment-changed"));
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "environment-changed" });
});

nativeTest("native SDK, toolchain and loader environment drift requires the full gate", async (t) => {
  const f = await fixture(t);
  await planned(f);
  for (const name of ["SDKROOT", "TOOLCHAINS", "DYLD_TEST_NATIVE_BINDING"]) {
    const original = process.env[name];
    try {
      process.env[name] = "synthetic-changed-native-input";
      const result = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() });
      assert.equal(result.status, "full_required", name);
      assert.ok(result.reasons.includes("environment-changed"), name);
      assert.deepEqual(result.changedFiles, [view]);
    } finally {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  }
});

nativeTest("checkpoint creation cannot adopt drift after the accepted full run", async (t) => {
  const f = await fixture(t);
  await exec("git", ["config", "core.quotePath", "false"], { cwd: f.root });
  await assert.rejects(f.invoke(f.request), { diagnosticCode: "environment-changed" });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, ".data/verification/full/report.json"))), f.report);
});

nativeTest("old ordinary reports without a captured native context cannot seed refinement", async (t) => {
  const f = await fixture(t), plan = await verificationPlan(f.root, f.base);
  const report = await executeVerification(f.root, plan, { directory: path.join(f.root, ".data/verification/without-context") });
  assert.equal(report.status, "passed");
  await save(f.root, ".data/verification/without-context/report.json", report);
  await assert.rejects(f.invoke({ ...f.prepareRequest, verification: ".data/verification/without-context/report.json" }),
    { diagnosticCode: "environment-changed" });
});

nativeTest("ignored renderer, prepared-module and installed-dependency drift require the ordinary route", async (t) => {
  const f = await fixture(t);
  await planned(f);
  for (const file of ["apple/DevPocket/Renderer/component.js", "packages/components/dist/spec.js",
    "node_modules/fixture-dependency/index.js"]) {
    const original = await readFile(path.join(f.root, file), "utf8");
    await save(f.root, file, original + "\n// Changed ignored input\n");
    const result = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() });
    assert.equal(result.status, "full_required");
    assert.ok(result.reasons.includes("environment-changed"));
    assert.deepEqual(result.changedFiles, [view]);
    await save(f.root, file, original);
  }
});

nativeTest("ignored native drift during a binding cannot be qualified", async (t) => {
  const f = await fixture(t);
  await planned(f);
  const before = await f.invoke({ action: "binding", plan: ".data/verification/plan.json" });
  await save(f.root, ".data/apple/before-drift.json", before);
  await save(f.root, "apple/DevPocket/Renderer/component.js", "Changed after observation\n");
  await assert.rejects(f.invoke({ action: "binding", plan: ".data/verification/plan.json", before: ".data/apple/before-drift.json" }),
    { diagnosticCode: "environment-changed" });
});

nativeTest("a self-consistent app seal does not replace the accepted prepared renderer", async (t) => {
  const f = await fixture(t), item = f.prepareRequest.acceptedProducts[0];
  const seal = JSON.parse(await readFile(path.join(f.root, item.artifact)));
  await save(f.root, item.bundle + "/Renderer/component.js", "Different packaged renderer\n");
  seal.files["Renderer/component.js"] = digest("Different packaged renderer\n");
  await save(f.root, item.artifact, seal);
  await assert.rejects(f.invoke(f.prepareRequest), { diagnosticCode: "artifact-changed" });
});

nativeTest("an old same-source review cannot accept a new environment or verification subject", async (t) => {
  const f = await fixture(t);
  await exec("git", ["config", "core.quotePath", "false"], { cwd: f.root });
  const report = await executeVerification(f.root, await verificationPlan(f.root, f.base),
    { directory: path.join(f.root, ".data/verification/new-context"), captureRefinementContext: true });
  assert.equal(report.complete, true);
  await save(f.root, ".data/verification/new-context/report.json", report);
  const subject = await f.invoke({ ...f.prepareRequest, verification: ".data/verification/new-context/report.json" });
  await save(f.root, ".data/verification/new-subject.json", subject);
  await assert.rejects(f.invoke({ ...f.request, subject: ".data/verification/new-subject.json" }),
    { diagnosticCode: "check-failed" });
});

nativeTest("all-passed commands with a blocked terminal qualification are not a checkpoint", async (t) => {
  const f = await fixture(t);
  const blocked = { ...f.report, complete: false, status: "blocked", failure: { reason: "environment-changed" } };
  await save(f.root, ".data/verification/blocked.json", blocked);
  await assert.rejects(f.invoke({ ...f.prepareRequest, verification: ".data/verification/blocked.json" }),
    { diagnosticCode: "check-failed" });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, ".data/verification/blocked.json"))), blocked);
});

nativeTest("a historical source, edited report or implementer-written review cannot create a checkpoint", async (t) => {
  const f = await fixture(t);
  await save(f.root, ".data/apple/review.json", { verdict: "pass", reviewedSource: f.report.source });
  await assert.rejects(f.invoke(f.request), { diagnosticCode: "execution-origin" });
  await save(f.root, ".data/apple/review.json", f.review);
  await save(f.root, view, "New source, not the accepted snapshot\n");
  await assert.rejects(f.invoke(f.request), { diagnosticCode: "source-mismatch" });
});

nativeTest("native exports must match the actual xcresult and report every selected test passing", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const summaryFile = `${native.directory}/summary.json`;
  await save(f.root, summaryFile, { ...native.summary, passedTests: 99 });
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "artifact-changed" });
  const failed = { ...native.summary, result: "Failed", failedTests: 1, passedTests: 0 };
  await save(f.root, summaryFile, failed);
  await save(f.root, `${native.directory}/result.xcresult/summary.json`, failed);
  await save(f.root, path.relative(f.root, path.join(native.originalBundle, "summary.json")), failed);
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "check-failed" });
});

nativeTest("old native results, wrong devices and skipped tests are not fresh visual evidence", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  for (const [summary, diagnosticCode] of [
    [{ ...native.summary, startTime: Date.parse(plan.createdAt) / 1000 - 5 }, "execution-origin"],
    [{ ...native.summary, skippedTests: 1 }, "check-failed"],
    [{ ...native.summary, devicesAndConfigurations: [{ ...native.summary.devicesAndConfigurations[0],
      device: { ...native.summary.devicesAndConfigurations[0].device, deviceId: "wrong-device" } }] }, "check-failed"],
  ]) {
    await save(f.root, `${native.directory}/summary.json`, summary);
    await save(f.root, `${native.directory}/result.xcresult/summary.json`, summary);
    await save(f.root, path.relative(f.root, path.join(native.originalBundle, "summary.json")), summary);
    await assert.rejects(f.invoke(native.request), { diagnosticCode });
  }
});

nativeTest("selected test passes require the original invocation, workspace and bundle", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const item = native.request.tests[0];
  const start = JSON.parse(await readFile(path.join(f.root, item.requestEvent)));
  const finish = JSON.parse(await readFile(path.join(f.root, item.responseEvent)));
  for (const [edit, diagnosticCode] of [
    [(request) => { request.data.arguments.workspaceIdentifier = "/another/worktree/DevPocket.xcodeproj"; }, "execution-origin"],
    [(request) => { request.data.mcpToolName = "RunAllTests"; }, "case-evidence"],
    [(request) => { request.timestamp = new Date(Date.parse(plan.createdAt) - 5000).toISOString(); }, "case-evidence"],
    [(request) => { request.data.arguments.tests[0].testIdentifier = "DevPocketUITests/anotherCase()"; }, "case-evidence"],
  ]) {
    const invalid = structuredClone(start);
    edit(invalid);
    await save(f.root, item.requestEvent, invalid);
    await assert.rejects(f.invoke(native.request), { diagnosticCode });
  }
  await save(f.root, item.requestEvent, start);
  await save(f.root, item.responseEvent, { ...finish, data: { ...finish.data, success: false } });
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "case-evidence" });
  await save(f.root, item.responseEvent, finish);
  const omitted = structuredClone(native.request);
  delete omitted.tests[0].requestEvent;
  await assert.rejects(f.invoke(omitted), { diagnosticCode: "ownership-mismatch" });
  await save(f.root, path.relative(f.root, path.join(native.originalBundle, "different-bytes.txt")), "Another producing bundle\n");
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "artifact-changed" });
});

nativeTest("refinement accepts whole-second xcresult precision inside an actual MCP invocation", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const rounded = { ...native.summary, startTime: Math.floor(native.summary.startTime),
    finishTime: Math.ceil(native.summary.finishTime) };
  for (const file of [`${native.directory}/summary.json`, `${native.directory}/result.xcresult/summary.json`,
    path.relative(f.root, path.join(native.originalBundle, "summary.json"))]) await save(f.root, file, rounded);
  const result = await f.invoke(native.request);
  assert.equal(result.status, "passed");
  assert.equal(result.checks[0].result.startedAt, new Date(rounded.startTime * 1000).toISOString());
  assert.equal(result.checks[0].execution.startedAt, new Date(native.summary.startTime * 1000).toISOString());
});

nativeTest("changed products and source changes after planning invalidate qualification", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  await save(f.root, native.request.builds[0].bundle + "/DevPocket", "Changed product\n");
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "artifact-changed" });
  await save(f.root, controls, "Changed after the planned source\n");
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "source-mismatch" });
});

nativeTest("failed, omitted and stale build invocations never produce a build pass", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const item = native.request.builds[0];
  const start = JSON.parse(await readFile(path.join(f.root, item.requestEvent)));
  const finish = JSON.parse(await readFile(path.join(f.root, item.responseEvent)));
  const failed = structuredClone(finish);
  failed.data.result.structuredContent.buildResult = "The build failed.";
  failed.data.result.structuredContent.errors = ["Synthetic compiler failure"];
  await save(f.root, item.responseEvent, failed);
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "check-failed" });
  await save(f.root, item.responseEvent, finish);
  await save(f.root, item.requestEvent, { ...start, timestamp: new Date(Date.parse(plan.createdAt) - 1000).toISOString() });
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "check-failed" });
  await save(f.root, item.requestEvent, start);
  const omitted = structuredClone(native.request);
  delete omitted.builds[0].requestEvent;
  await assert.rejects(f.invoke(omitted), { diagnosticCode: "ownership-mismatch" });
});

nativeTest("build logs, workspaces and producing products must match the native invocation", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const item = native.request.builds[0];
  const start = JSON.parse(await readFile(path.join(f.root, item.requestEvent)));
  const finish = JSON.parse(await readFile(path.join(f.root, item.responseEvent)));
  const originalLog = finish.data.result.structuredContent.fullLogPath;
  const log = await readFile(path.join(f.root, item.log), "utf8");
  await save(f.root, item.log, "** BUILD FAILED **\n");
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "artifact-changed" });
  await save(f.root, path.relative(f.root, originalLog), "** BUILD FAILED **\n");
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "execution-origin" });
  await save(f.root, item.log, log);
  await save(f.root, path.relative(f.root, originalLog), log);
  const wrong = structuredClone(start);
  wrong.data.arguments.workspaceIdentifier = "/another/worktree/DevPocket.xcodeproj";
  await save(f.root, item.requestEvent, wrong);
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "execution-origin" });
  await save(f.root, item.requestEvent, start);
  await save(f.root, path.relative(f.root, item.originalProduct) + "/DevPocket", "A different producing product\n");
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "artifact-changed" });
});

nativeTest("actual workspace mappings bind handle-based MCP calls without rewriting the request", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const item = native.request.builds[0], request = JSON.parse(await readFile(path.join(f.root, item.requestEvent)));
  const before = JSON.parse(await readFile(path.join(f.root, ".data/apple/fresh/before.json")));
  request.data.arguments.workspaceIdentifier = "workspace-fixture";
  await save(f.root, item.requestEvent, request);
  const requestEvent = ".data/apple/fresh/workspaces-request.json";
  const responseEvent = ".data/apple/fresh/workspaces-response.json";
  await save(f.root, requestEvent, { type: "tool.execution_start", timestamp: before.observedAt, data: {
    toolCallId: "fixture-workspaces", mcpServerName: "xcode", mcpToolName: "XcodeListWorkspaces", arguments: {},
  } });
  const response = { type: "tool.execution_complete", timestamp: before.observedAt, data: {
    toolCallId: "fixture-workspaces", success: true, result: { structuredContent: {
      message: `* workspaceIdentifier: workspace-fixture, workspacePath: ${path.join(f.root, "apple", "DevPocket", "DevPocket.xcodeproj")}`,
    } },
  } };
  await save(f.root, responseEvent, response);
  item.workspaceBinding = { requestEvent, responseEvent };
  const testItem = native.request.tests[0];
  const testRequest = JSON.parse(await readFile(path.join(f.root, testItem.requestEvent)));
  testRequest.data.arguments.workspaceIdentifier = "workspace-fixture";
  await save(f.root, testItem.requestEvent, testRequest);
  testItem.workspaceBinding = { requestEvent, responseEvent };
  assert.equal((await f.invoke(native.request)).status, "passed");
  for (const alter of [
    (value) => { value.data.result.structuredContent.message = "* workspaceIdentifier: workspace-fixture, workspacePath: /another/DevPocket.xcodeproj"; },
    (value) => { value.data.result.structuredContent.message += "\n" + value.data.result.structuredContent.message; },
    (value) => { value.data.result.structuredContent.message = value.data.result.structuredContent.message.replace("workspace-fixture", "another-handle"); },
    (value) => { value.timestamp = new Date(Date.parse(before.observedAt) - 1).toISOString(); },
    (value) => { value.timestamp = new Date(Date.parse(request.timestamp) + 1).toISOString(); },
    (value) => { value.data.toolCallId = "another-call"; },
    (value) => { value.data.result.isError = true; },
  ]) {
    const invalid = structuredClone(response);
    alter(invalid);
    await save(f.root, responseEvent, invalid);
    await assert.rejects(f.invoke(native.request), { diagnosticCode: "execution-origin" });
  }
});

nativeTest("a missing local Apple request blocks before execution and releases the owned gate", async (t) => {
  const f = await fixture(t);
  await save(f.root, "apple/DevPocket/DevPocket.xcodeproj/project.pbxproj", "// Synthetic project; never built\n");
  await save(f.root, "scripts/apple-runner.mjs", "// Synthetic entry; never executed\n");
  const plan = await verificationPlan(f.root, f.base);
  const report = await executeVerification(f.root, plan, {
    group: "apple", directory: path.join(f.root, ".data/verification/missing-apple-request"),
  });
  const check = report.checks.find((item) => item.id === "apple-native");
  assert.equal(report.status, "blocked");
  assert.equal(check.failure.reason, "apple-evidence-required", JSON.stringify(report));
  assert.equal(check.executionState, "not-started");
  assert.equal(report.admission.state, report.admission.mode === "inherited" ? "returned" : "released");
  const recorded = await readVerificationRun(f.root, report.run.manifest);
  assert.deepEqual(recorded.report, report);
  assert.equal(recorded.latest.get("apple").report.group, "apple");
  const resumed = await executeVerification(f.root, plan, {
    group: "apple", resume: report.run.manifest,
    directory: path.join(f.root, ".data/verification/missing-apple-request-resumed"),
  });
  assert.equal(resumed.checks.find((item) => item.id === "apple-native").failure.reason, "apple-evidence-required");
  assert.equal((await readVerificationRun(f.root, resumed.run.manifest)).count, 2);
});

nativeTest("retained evidence paths cannot escape the worktree or follow symlinks", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.invoke({ ...f.request, review: "../review.json" }), { diagnosticCode: "ownership-mismatch" });
  const link = path.join(f.root, ".data", "linked");
  await symlink(path.join(f.root, ".data", "apple"), link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.invoke({ ...f.request, review: ".data/linked/review.json" }), { diagnosticCode: "ownership-mismatch" });
});

test("hosted CI and ordinary gate aggregation cannot consume local refinement", async (t) => {
  const oldCI = process.env.GITHUB_ACTIONS;
  t.after(() => { if (oldCI === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = oldCI; });
  process.env.GITHUB_ACTIONS = "true";
  await assert.rejects(executeLocalRefinement(process.cwd(), "not-a-base", "not-a-request"), { diagnosticCode: "configuration" });
  await assert.rejects(executeVerification(process.cwd(), { version: 6, requiredChecks: [], requiredGroups: [] },
    { captureRefinementContext: true }), { diagnosticCode: "configuration" });
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/refinement-rejection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = path.resolve("scripts/verify.mjs");
  await assert.rejects(exec(process.execPath, [entry, "--repo", root, "--base", "not-a-base",
    "--refinement", ".data/verification/request.json", "--all"], { env: { ...process.env, GITHUB_ACTIONS: "false" } }),
  (error) => error.code === 1 && error.stderr.includes("configuration"));
  assert.deepEqual(verificationImpact(["apple/DevPocket/DevPocket/ContentView.swift"]).selectionReasons.map((item) => item.rule), ["apple"]);
  assert.equal(developmentReviewRequirements(["scripts/verification-refinement.mjs"]).requiresHumanReview, true);
  assert.deepEqual(verificationImpact(["scripts/tests/verification-refinement.test.mjs"]).requiredChecks, ["tooling-tests"]);
});
