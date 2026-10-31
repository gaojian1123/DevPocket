import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { executeLocalAppleRequest, executeLocalRefinement } from "../../verification-refinement.mjs";
import { APPLE_REQUIREMENTS } from "../../apple-evidence.mjs";
import { executeVerification, sourceSnapshot, verificationPlan } from "../../verification.mjs";

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
    await save(root, "scripts/verify.mjs", `import ${JSON.stringify(new URL("../../verify.mjs", import.meta.url).href)};\n`);
    await save(root, `${APPLE_REQUIREMENTS.project}/xcshareddata/xcschemes/DevPocket.xcscheme`,
      `<Scheme><TestAction buildConfiguration="Debug"><Testables>${["DevPocketTests", "DevPocketUITests"].map((target) =>
        `<TestableReference skipped="NO" parallelizable="NO"><BuildableReference BlueprintName="${target}" BuildableName="${target}.xctest"/></TestableReference>`
      ).join("")}</Testables></TestAction></Scheme>`);
    await save(root, ".data/native-probes.json", nativeProbes());
  }
  const decoder = `const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), kind = args[args.indexOf("test-results") + 1];
if (args[0] === "xcodebuild" && args.includes("-version")) { console.log("Xcode 27.2\\nBuild version SyntheticFixture"); process.exit(0); }
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

const batchCases = [
  { targetName: "DevPocketTests", testIdentifier: "ModelAndWKTests/testModel()" },
  { targetName: "DevPocketUITests", testIdentifier: "WindowTests/testLayout()" },
  { targetName: "DevPocketUITests", testIdentifier: "WindowTests/testNavigation()" },
];
const fixtureDevice = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

function nativeProbes() {
  const types = APPLE_REQUIREMENTS.targets.slice(1).map((target) =>
    ({ name: target.deviceTypeName, identifier: `synthetic.type.${target.role}` }));
  const runtimes = ["27.2"].map((version) => ({ version, isAvailable: true,
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
      [["--sdk", "iphoneos", "--show-sdk-version"], "27.2\n"],
      [["--sdk", "iphonesimulator", "--show-sdk-version"], "27.2\n"],
      [["--sdk", "macosx", "--show-sdk-version"], "27.2\n"],
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

function selected(paths = [view]) {
  return {
    reason: "Remove the duplicate promotional entry; session navigation remains covered.",
    unchangedCoverage: "Retain original native evidence for unchanged model/renderer/platform inputs; do not boot Duo.",
    tests: [{ platform: "iOS Simulator", deviceId: "fixture-iphone", osVersion: "27.2", identifiers: [nativeCase] }],
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
  const device = { deviceId: "fixture-iphone", platform: "iOS Simulator", osVersion: "27.2", architecture: "arm64" };
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

export { commandPlan, controls, digest, exec, failedPreparationEntry, fixture, fixtureDevice, fullBatches,
  nativeEvidence, nativeProbes, nativeTest, planned, save, selected, uiTests, view };
