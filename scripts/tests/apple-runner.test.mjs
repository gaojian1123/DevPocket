import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  APPLE_NATIVE_REPORT_MAX_BYTES, APPLE_PROBES, APPLE_REQUIREMENTS, appleDigest, appleJSON, appleXcodeArguments,
  inspectAppleScheme, inspectAppleToolchain, normalizeAppleTestResult, selectAppleSimulators,
  projectAppleCommandOutput, projectAppleXcresult, validateAppleNativeEvidence, validateApplePlan,
} from "../apple-evidence.mjs";
import {
  appleRunnerOutputPath, cleanupAppleSimulators, createAppleSimulator,
  parseAppleRunnerArguments, requireAppleCIEnvironment,
} from "../apple-runner.mjs";
import { combineVerification, requireToolingShardReport } from "../verification.mjs";
import { ciReportEnvelope, collectCIReports } from "../verification-ci.mjs";
import { toolingCatalogue, toolingShardDescriptor } from "../verification-tooling.mjs";
import { syntheticExecution } from "./fixtures/verification-tools.mjs";
import { openVerificationRun, readVerificationRun } from "../verification-run.mjs";

const uuid = (number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
const owner = uuid(42);
const retainedOutputs = new WeakMap();
const plan = { base: "1".repeat(40), source: { head: "2".repeat(40), fingerprint: "3".repeat(64) }, apple: APPLE_REQUIREMENTS };
const scheme = `<Scheme><TestAction buildConfiguration="Debug"><Testables>
${["DevPocketTests", "DevPocketUITests"].map((target) =>
  `<TestableReference skipped="NO" parallelizable="NO"><BuildableReference BlueprintName="${target}" BuildableName="${target}.xctest"/></TestableReference>`).join("\n")}
</Testables></TestAction></Scheme>`;

function inventoryFixture() {
  const types = APPLE_REQUIREMENTS.targets.filter((item) => item.role !== "mac").map((target) =>
    ({ name: target.deviceTypeName, identifier: `com.apple.CoreSimulator.SimDeviceType.fixture-${target.role}` }));
  const runtimes = ["27.0", "27.1"].map((version) => ({ name: `iOS ${version}`, version, isAvailable: true,
    identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replaceAll(".", "-")}`,
    supportedDeviceTypes: version === "27.0" ? types.slice(0, 2) : types.slice(2) }));
  return { devicetypes: types, runtimes, devices: {
    [runtimes[0].identifier]: [{ udid: uuid(99), name: "Unrelated synthetic simulator", state: "Booted",
      deviceTypeIdentifier: types[0].identifier }],
    [runtimes[1].identifier]: [],
  } };
}

function probeFixture() {
  return { xcode: "Xcode 27.1\nBuild version 18B123\n",
    "xcode-path": "/Applications/Xcode_27.1.app/Contents/Developer/usr/bin/xcodebuild\n",
    "ios-sdk": "27.1\n", "simulator-sdk": "27.1\n", "macos-sdk": "27.1\n",
    macos: "27.0.1\n", architecture: "arm64\n", swift: "Apple Swift version 7.0 (synthetic test fixture)\n",
    simulators: appleJSON(inventoryFixture()) };
}

function nativeFixture(target, execution, modelCases = 2) {
  const device = { deviceId: target.deviceId ?? "synthetic-native-mac-id", deviceName: "Synthetic test destination",
    platform: target.platform, osVersion: target.osVersion, architecture: target.architecture };
  const cases = (name, count) => Array.from({ length: count }, (_, index) =>
    ({ nodeType: "Test Case", nodeIdentifier: `${name}/fixture${index}()`, result: "Passed" }));
  const testNodes = [{ nodeType: "Test Plan", name: "DevPocket", children: [
    { nodeType: "Unit test bundle", name: "DevPocketTests", children: cases("ModelAndWKFixtures", modelCases) },
    { nodeType: "UI test bundle", name: "DevPocketUITests", children: cases("DevPocketUITests", 1) },
  ] }];
  const passedTests = modelCases + 1;
  const summary = { result: "Passed", failedTests: 0, skippedTests: 0, expectedFailures: 0,
    passedTests, totalTestCount: passedTests, testFailures: [],
    startTime: Date.parse(execution.startedAt) / 1000 + 0.01,
    finishTime: Date.parse(execution.completedAt) / 1000 - 0.01,
    devicesAndConfigurations: [{ device, failedTests: 0, skippedTests: 0, expectedFailures: 0, passedTests }] };
  return { summary, tests: { devices: [device], testNodes } };
}

function outputFile(file, text) {
  return { path: file, bytes: Buffer.byteLength(text), sha256: appleDigest(text) };
}

function treeFixture(file, producedBy, names) {
  const files = names.map((name) => {
    const text = `Synthetic unit fixture, NOT native acceptance: ${name}\n`;
    return { path: name, bytes: Buffer.byteLength(text), sha256: appleDigest(text) };
  });
  return { path: file, producedBy, files, sha256: appleDigest(appleJSON(files)) };
}

function evidenceFixture(modelCases = 2) {
  const workspace = "/synthetic-checkout", directory = ".data/ci/apple-synthetic";
  let clock = Date.parse("2026-10-25T00:00:00.000Z");
  const report = {
    version: 1, kind: "apple-native-evidence", origin: "ci-xcodebuild", workspace, directory, runId: owner,
    ...structuredClone(plan), sourceBefore: structuredClone(plan.source), sourceAfter: structuredClone(plan.source),
    startedAt: new Date(clock).toISOString(), completedAt: null, status: "passed", cleanup: "completed", failures: [],
    ci: { githubActions: "true", runnerEnvironment: "github-hosted", platform: "darwin",
      runId: "123", runAttempt: "1", job: "apple", repository: "example/fixture", sha: plan.source.head },
    scheme: { path: `${APPLE_REQUIREMENTS.project}/xcshareddata/xcschemes/DevPocket.xcscheme`,
      xml: scheme, sha256: appleDigest(scheme), targets: inspectAppleScheme(scheme) },
    commands: [], builds: [], tests: [], resources: [],
  };
  const rawOutputs = new Map();
  retainedOutputs.set(report, rawOutputs);
  const command = (id, file, args, stdout = "") => {
    clock += 1000;
    const startedAt = new Date(clock).toISOString();
    clock += 100;
    const item = { id, kind: "owned-command", origin: report.origin, file, args, cwd: workspace,
      startedAt, completedAt: new Date(clock).toISOString(), status: "passed", cleanup: "completed",
      outcome: { observedProcess: "owned-command-supervisor", reason: "exit", exitCode: 0, signal: "none",
        capturedBytes: Buffer.byteLength(stdout), outputTruncated: false, cleanupFailure: null },
      stdout: outputFile(`${directory}/logs/${id}.stdout.txt`, stdout),
      stderr: outputFile(`${directory}/logs/${id}.stderr.txt`, "") };
    item.output = projectAppleCommandOutput(item, stdout, "");
    rawOutputs.set(id, { stdout, stderr: "" });
    report.commands.push(item);
    return item;
  };
  const executionReference = (command) => ({ kind: command.kind, origin: report.origin, commandId: command.id,
    workspace: `${workspace}/${APPLE_REQUIREMENTS.project}`, startedAt: command.startedAt, completedAt: command.completedAt });
  const outputs = probeFixture();
  for (const probe of APPLE_PROBES) command(`probe-${probe.id}`, probe.file, probe.args, outputs[probe.id]);
  report.toolchain = inspectAppleToolchain(outputs);
  report.preparationCommandId = "prepare-components";
  command(report.preparationCommandId, "/synthetic/node", ["apple/prepare-components.mjs"], "Synthetic component build\n");
  for (const platform of ["ios", "macos"]) {
    const id = `build-${platform}`, relative = `${directory}/${id}`;
    const product = `${relative}/derived/Build/Products/${platform === "ios" ? "Debug-iphonesimulator" : "Debug"}/DevPocket.app`;
    const destination = platform === "ios" ? "generic/platform=iOS Simulator" : "platform=macOS,arch=arm64";
    const execution = command(id, "/usr/bin/xcrun", appleXcodeArguments({ workspace, directory: relative, action: "build", platform, destination }),
      `CodeSign ${workspace}/${product} (in target 'DevPocket' from project 'DevPocket')\n** BUILD SUCCEEDED **\n`);
    report.builds.push({ platform, action: "build", status: "passed", commandId: id,
      execution: executionReference(execution), originalProduct: `${workspace}/${product}`,
      resultBundle: treeFixture(`${relative}/result.xcresult`, id, ["Info.plist", "Data/synthetic"]),
      product: treeFixture(product, id, platform === "ios" ? ["Info.plist", "DevPocket"] : ["Contents/Info.plist", "Contents/MacOS/DevPocket"]) });
  }
  const inventory = inventoryFixture();
  for (const [index, requirement] of APPLE_REQUIREMENTS.targets.entries()) {
    const mac = requirement.role === "mac";
    let target = { role: "mac", platform: "macOS", osVersion: "27.0.1", architecture: "arm64" };
    if (!mac) {
      const selection = report.toolchain.simulators.find((item) => item.role === requirement.role);
      const resource = { role: requirement.role, deviceId: uuid(index), name: `DevPocket-${owner}-${requirement.role}`,
        runtimeIdentifier: selection.runtimeIdentifier, deviceTypeIdentifier: selection.deviceTypeIdentifier,
        createCommandId: `create-${requirement.role}`, confirmCommandId: `confirm-${requirement.role}`,
        bootCommandId: `boot-${requirement.role}`, readyCommandId: `ready-${requirement.role}`,
        shutdownCommandId: `shutdown-${requirement.role}`, deleteCommandId: `delete-${requirement.role}`, cleanup: "completed" };
      command(resource.createCommandId, "/usr/bin/xcrun",
        ["simctl", "create", resource.name, selection.deviceTypeIdentifier, selection.runtimeIdentifier], resource.deviceId + "\n");
      const device = { name: resource.name, udid: resource.deviceId, state: "Shutdown", deviceTypeIdentifier: selection.deviceTypeIdentifier };
      inventory.devices[selection.runtimeIdentifier].push(device);
      command(resource.confirmCommandId, "/usr/bin/xcrun", ["simctl", "list", "devices", "--json"], appleJSON(inventory));
      command(resource.bootCommandId, "/usr/bin/xcrun", ["simctl", "boot", resource.deviceId]);
      device.state = "Booted";
      command(resource.readyCommandId, "/usr/bin/xcrun", ["simctl", "bootstatus", resource.deviceId, "-b"]);
      report.resources.push(resource);
      target = { ...selection, deviceId: resource.deviceId, architecture: "arm64" };
    }
    const id = `test-${target.role}`, relative = `${directory}/${id}`;
    const destination = mac ? "platform=macOS,arch=arm64" : `platform=iOS Simulator,id=${target.deviceId}`;
    const execution = command(id, "/usr/bin/xcrun", appleXcodeArguments({
      workspace, directory: relative, action: "test", platform: mac ? "macos" : "ios", destination,
    }), "** TEST SUCCEEDED **\n");
    const native = nativeFixture(target, execution, modelCases);
    for (const kind of ["summary", "tests"]) command(`${id}-${kind}`, "/usr/bin/xcrun",
      ["xcresulttool", "get", "test-results", kind, "--path", `${workspace}/${relative}/result.xcresult`, "--compact"], appleJSON(native[kind]));
    const summary = projectAppleXcresult("summary", native.summary), testTree = projectAppleXcresult("tests", native.tests);
    report.tests.push({ role: target.role, action: "test", status: "passed", commandId: id,
      execution: executionReference(execution), target: { ...target, deviceId: native.summary.devicesAndConfigurations[0].device.deviceId },
      summary, testTree, summaryCommandId: `${id}-summary`, testsCommandId: `${id}-tests`,
      resultBundle: treeFixture(`${relative}/result.xcresult`, id, ["Info.plist", "Data/synthetic"]),
      result: normalizeAppleTestResult(summary, testTree, target, execution, report.scheme.targets) });
  }
  report.cleanupEvidence = { beforeCommandId: "cleanup-before", afterCommandId: "cleanup-after" };
  command("cleanup-before", "/usr/bin/xcrun", ["simctl", "list", "devices", "--json"], appleJSON(inventory));
  for (const resource of report.resources) {
    command(resource.shutdownCommandId, "/usr/bin/xcrun", ["simctl", "shutdown", resource.deviceId]);
    command(resource.deleteCommandId, "/usr/bin/xcrun", ["simctl", "delete", resource.deviceId]);
    inventory.devices[resource.runtimeIdentifier] = inventory.devices[resource.runtimeIdentifier].filter((device) => device.udid !== resource.deviceId);
  }
  command("cleanup-after", "/usr/bin/xcrun", ["simctl", "list", "devices", "--json"], appleJSON(inventory));
  report.completedAt = new Date(clock + 1000).toISOString();
  return report;
}

function changeOutput(report, id, transform, stream = "stdout") {
  const command = report.commands.find((item) => item.id === id);
  const raw = retainedOutputs.get(report).get(id), text = transform(raw[stream]);
  raw[stream] = text;
  command[stream] = outputFile(command[stream].path, text);
  command.output = projectAppleCommandOutput(command, raw.stdout, raw.stderr);
  command.outcome.capturedBytes = Buffer.byteLength(raw.stdout) + Buffer.byteLength(raw.stderr);
  if (stream === "stdout") {
    const item = report.tests.find((item) => item.summaryCommandId === id || item.testsCommandId === id);
    if (item) item[item.summaryCommandId === id ? "summary" : "testTree"] =
      projectAppleXcresult(item.summaryCommandId === id ? "summary" : "tests", JSON.parse(text));
  }
}

test("Apple requirements are immutable and require exact target/runtime policy", () => {
  assert.ok(Object.isFrozen(APPLE_REQUIREMENTS));
  assert.ok(Object.isFrozen(APPLE_REQUIREMENTS.targets));
  assert.ok(APPLE_REQUIREMENTS.targets.every(Object.isFrozen));
  assert.equal(validateApplePlan(plan), plan);
  const weakened = structuredClone(plan);
  weakened.apple.xcodeMinimum = "27.0";
  assert.throws(() => validateApplePlan(weakened), /requirements/);
  assert.throws(() => validateApplePlan({ ...plan, base: "HEAD" }), /exact base/);
});

test("CI guard is a pure check and does not turn local or self-hosted execution into CI", () => {
  for (const [environment, platform] of [
    [{}, "darwin"], [{ GITHUB_ACTIONS: "true" }, "darwin"],
    [{ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" }, "darwin"],
    [{ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" }, "linux"],
  ]) assert.throws(() => requireAppleCIEnvironment(environment, platform), /GitHub-hosted CI only/);
  assert.doesNotThrow(() => requireAppleCIEnvironment({ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" }, "darwin"));
});

test("runner accepts only explicit unique arguments and checkout-scoped output paths", () => {
  const args = ["--repo", "root", "--plan", "plan.json", "--directory", ".data/ci/apple"];
  assert.deepEqual(parseAppleRunnerArguments(args), { repo: "root", plan: "plan.json", directory: ".data/ci/apple" });
  for (const invalid of [args.slice(0, 4), [...args, "--repo", "elsewhere"], [...args, "--local", "true"], [...args, "extra"]]) {
    assert.throws(() => parseAppleRunnerArguments(invalid));
  }
  const root = path.resolve("synthetic-checkout");
  for (const directory of [".data/ci/apple", ".data/verification/apple"]) {
    assert.equal(appleRunnerOutputPath(root, directory), path.resolve(root, directory));
  }
  for (const directory of [".data/ci", ".data/development/apple", "../elsewhere", ".data/verification/local/apple", ".data/ci/../../elsewhere"]) {
    assert.throws(() => appleRunnerOutputPath(root, directory));
  }
});

test("normal builds and full-scheme native tests never request a test plan or subset", () => {
  for (const action of ["build", "test"]) {
    const args = appleXcodeArguments({ workspace: "/fixture", directory: ".data/ci/apple/fresh",
      action, platform: "ios", destination: "platform=iOS Simulator,id=synthetic" });
    assert.equal(args.at(-1), action);
    assert.ok(args.includes("-disableAutomaticPackageResolution"));
    assert.ok(args.includes("-onlyUsePackageVersionsFromResolvedFile"));
    assert.ok(args.includes("-skipPackageUpdates"));
    assert.ok(!args.some((arg) => /testPlan|only-testing|skip-testing|build-for-testing|DEPLOYMENT_TARGET|retry-tests/.test(arg)));
    assert.equal(args[args.indexOf("-derivedDataPath") + 1], "/fixture/.data/ci/apple/fresh/derived");
    assert.equal(args[args.indexOf("-scheme") + 1], "DevPocket");
  }
  assert.deepEqual(inspectAppleScheme(scheme), ["DevPocketTests", "DevPocketUITests"]);
  for (const invalid of [scheme.replace('skipped="NO"', 'skipped="YES"'),
    scheme.replace('parallelizable="NO"', 'parallelizable="YES"'),
    scheme.replace("</TestAction>", "<TestPlans/></TestAction>"),
    scheme.replace("</TestAction>", "<SelectedTests/></TestAction>"),
    scheme.replace('buildConfiguration="Debug"', 'buildConfiguration="Release"'),
    scheme.replaceAll("DevPocketTests", "AnotherTarget")]) assert.throws(() => inspectAppleScheme(invalid));
});

test("toolchain requires the newer compile SDK as well as host and Xcode versions", () => {
  assert.equal(inspectAppleToolchain(probeFixture()).macOS, "27.0.1");
  for (const [key, value] of [["xcode", "Xcode 27.0\nBuild version 18A1\n"], ["ios-sdk", "27.0"],
    ["simulator-sdk", "27.0"], ["macos", "26.9"], ["macos-sdk", "26.9"], ["swift", ""], ["architecture", "unknown"]]) {
    assert.throws(() => inspectAppleToolchain({ ...probeFixture(), [key]: value }));
  }
});

test("runtime selection resolves actual IDs and requires supportedDeviceTypes without substituting a phone", () => {
  const inventory = inventoryFixture(), selected = selectAppleSimulators(inventory);
  assert.deepEqual(selected.map((item) => [item.role, item.osVersion]), [["iphone", "27.0"], ["ipad", "27.0"], ["duo", "27.1"]]);
  assert.equal(selected[2].deviceTypeIdentifier, inventory.devicetypes[2].identifier);
  for (const alter of [
    (data) => { data.runtimes[1].isAvailable = false; },
    (data) => { data.runtimes[1].supportedDeviceTypes = []; },
    (data) => { delete data.runtimes[1].supportedDeviceTypes; },
    (data) => { data.runtimes[1].version = "27.0"; },
    (data) => { data.devicetypes[2].name = "A different iPhone"; },
    (data) => { data.devicetypes.push({ ...data.devicetypes[2] }); },
  ]) {
    const changed = structuredClone(inventory); alter(changed);
    assert.throws(() => selectAppleSimulators(changed));
  }
});

test("complete evidence validates variable suite sizes, not a permanent 31-test count", () => {
  for (const modelCases of [2, 5]) {
    const report = evidenceFixture(modelCases);
    assert.equal(validateAppleNativeEvidence(report, plan), report);
    assert.ok(report.tests.every((item) => item.result.cases.length === modelCases + 1));
  }
});

test("successful Apple group and full-gate receipts round-trip through signed run history", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/apple-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const selected = { ...structuredClone(plan), version: 6, ciMacos: false, layouts: false,
    requiredChecks: ["apple-native"], requiredGroups: ["apple"] };
  for (const group of ["apple", "all"]) {
    const evidence = evidenceFixture(), policy = "4".repeat(64);
    const run = await openVerificationRun(root, selected, {
      group, directory: path.join(root, ".data/verification", group),
    }, policy);
    const report = { ...selected, group, run: run.reference, status: "passed", complete: true,
      checks: [{ id: "apple-native", status: "passed", exitCode: 0,
        execution: { source: plan.source, startedAt: evidence.startedAt, completedAt: evidence.completedAt },
        appleEvidence: evidence }] };
    await run.record({ ...report, group: "apple" }, "5".repeat(64), { available: true }, false);
    await run.finish(report, true, ["apple"]);
    const recorded = await readVerificationRun(root, run.reference.manifest);
    assert.deepEqual(recorded.report, report);
    assert.deepEqual(recorded.manifest.binding.apple, APPLE_REQUIREMENTS);
    assert.deepEqual(recorded.latest.get("apple").report.checks[0].appleEvidence, evidence);
    const resumed = await openVerificationRun(root, selected, {
      group, resume: run.reference.manifest, directory: path.join(root, ".data/verification", group + "-resumed"),
    }, policy);
    assert.deepEqual(await resumed.reusable("apple", "5".repeat(64), { available: true }, false),
      { status: "invalidated", reason: "environment-unbound" });
    await resumed.finish({ ...selected, group, status: "blocked", complete: false,
      checks: [{ id: "apple-native", status: "not_run" }] }, true, []);
    assert.equal((await readVerificationRun(root, resumed.reference.manifest)).count, 2);
    await writeFile(path.join(recorded.directory, "0003-foreign.json"), "{}\n");
    await assert.rejects(readVerificationRun(root, resumed.reference.manifest), { diagnosticCode: "run-invalid" });
  }
});

test("Apple evidence joins the ordinary gate and CI without losing shared macOS requirements", async () => {
  const evidence = evidenceFixture(), selected = { ...structuredClone(plan), version: 6,
    ciMacos: true, layouts: false, requiredChecks: ["tooling-tests", "apple-native"], requiredGroups: ["tooling", "apple"],
    toolingShards: await toolingCatalogue(process.cwd()) };
  const context = { repository: "example/fixture", runId: "123", attempt: 1, event: "pull_request",
    candidate: "4".repeat(40), pullRequest: 11, pullRequestBase: plan.base,
    tested: { head: plan.source.head, tree: "5".repeat(40) }, workflowSha: plan.source.head,
    workflowRef: "example/fixture/.github/workflows/ci.yml@refs/pull/11/merge" };
  const reports = selected.toolingShards.parts.map((part) => ({
    ...selected, group: "tooling", status: "partial", complete: false,
    environment: { platform: "win32", architecture: "x64" },
    checks: [{ id: "tooling-tests", status: "passed", exitCode: 0,
      toolingShard: toolingShardDescriptor(selected, part.id), execution: syntheticExecution(plan.source),
      executionState: "exited", commandOutcome: {
        observedProcess: "owned-command-supervisor", reason: "exit", exitCode: 0, cleanupFailure: null,
      } }, { id: "apple-native", status: "not_run" }],
  }));
  const macos = structuredClone(reports.find((report) => report.checks[0].toolingShard.id === "native"));
  macos.environment = { platform: "darwin", architecture: "arm64" };
  const apple = { ...selected, group: "apple", status: "partial", complete: false,
    checks: [{ id: "tooling-tests", status: "not_run" }, { id: "apple-native", status: "passed", exitCode: 0,
      execution: { source: plan.source, startedAt: evidence.startedAt, completedAt: evidence.completedAt },
      appleEvidence: evidence }] };
  const envelopes = reports.map((report) => ciReportEnvelope(report, context, `tooling-${report.checks[0].toolingShard.id}`));
  envelopes.push(ciReportEnvelope(macos, context, "macos"));
  const collect = (report, upstream = new Map([["tooling", "success"], ["macos", "success"], ["apple", "success"]])) =>
    collectCIReports(selected, context, [...envelopes, ciReportEnvelope(report, context, "apple")], upstream);
  const gate = collect(apple);
  assert.equal(gate.report.complete, true);
  assert.deepEqual(gate.macos.apple, APPLE_REQUIREMENTS);
  assert.doesNotThrow(() => requireToolingShardReport(selected, gate.macos));
  assert.deepEqual(combineVerification(selected, [gate.report]), gate.report);
  for (const edit of [
    (value) => { value.origin = "local-xcode-mcp"; },
    (value) => { value.ci.repository = "another/repository"; },
    (value) => { value.ci.runId = "456"; },
    (value) => { value.ci.runAttempt = "2"; },
    (value) => { value.ci.job = "another-job"; },
    (value) => { value.ci.sha = "6".repeat(40); },
    (value) => { value.startedAt = "2026-01-01T00:00:00.000Z"; },
  ]) {
    const invalid = structuredClone(apple);
    edit(invalid.checks[1].appleEvidence);
    assert.throws(() => collect(invalid));
  }
  assert.throws(() => collect(apple, new Map([["tooling", "success"], ["macos", "success"], ["apple", "skipped"]])));
});

test("multi-megabyte native logs remain artifacts while the report fits existing publication budgets", () => {
  const report = evidenceFixture(40), noise = ("SYNTHETIC_VERBOSE_LOG_ONLY " + "x".repeat(200) + "\n").repeat(10000);
  const ids = ["prepare-components", "build-ios", "build-macos", "test-mac", "test-iphone", "test-ipad", "test-duo"];
  for (const id of ids) {
    changeOutput(report, id, (text) => noise + text);
    const command = report.commands.find((item) => item.id === id);
    const retained = retainedOutputs.get(report).get(id).stdout;
    assert.ok(command.stdout.bytes > 1024 * 1024);
    assert.equal(command.stdout.bytes, Buffer.byteLength(retained));
    assert.equal(command.stdout.sha256, appleDigest(retained));
    assert.equal(Object.hasOwn(command.stdout, "text"), false);
  }
  // xcresult console/debug metadata is also retained in the original export, not repeated in every envelope.
  changeOutput(report, "test-mac-tests", (text) => {
    const value = JSON.parse(text);
    value.consoleLog = noise;
    value.testNodes[0].children[0].children[0].consoleLog = noise;
    return appleJSON(value);
  });
  assert.equal(validateAppleNativeEvidence(report, plan), report);
  const nativeBytes = Buffer.byteLength(appleJSON(report));
  assert.ok(nativeBytes <= APPLE_NATIVE_REPORT_MAX_BYTES);
  assert.ok(!appleJSON(report).includes("SYNTHETIC_VERBOSE_LOG_ONLY"));
  assert.ok(Buffer.byteLength(appleJSON({ version: 6, appleEvidence: report, otherFields: "x".repeat(64 * 1024) })) < 512 * 1024);
  assert.ok(Buffer.byteLength(appleJSON({ plan, reports: [report, report], envelope: "x".repeat(64 * 1024) })) < 1024 * 1024);
});

test("compact build facts still reject failures, wrong producers, altered digests and truncated commands", () => {
  const noise = "Synthetic compiler detail\n".repeat(50000);
  for (const alter of [
    (report) => changeOutput(report, "build-ios", (text) => noise + text + "** BUILD FAILED **\n"),
    (report) => changeOutput(report, "build-ios", () => noise + "** BUILD CANCELLED **\n", "stderr"),
    (report) => changeOutput(report, "build-ios", () => noise + "** BUILD SUCCEEDED **\n"),
    (report) => changeOutput(report, "build-ios", (text) => noise + text.replace("/derived/Build/Products/", "/copied/Build/Products/")),
    (report) => { report.commands.find((item) => item.id === "build-ios").stdout.sha256 = "0".repeat(64); },
    (report) => { report.commands.find((item) => item.id === "build-ios").output.data.products = ["/copied/DevPocket.app"]; },
    (report) => { report.commands.find((item) => item.id === "build-ios").outcome.exitCode = 65; },
    (report) => { report.commands.find((item) => item.id === "build-ios").outcome.outputTruncated = true; },
  ]) {
    const report = evidenceFixture(); alter(report);
    assert.ok(Buffer.byteLength(appleJSON(report)) <= APPLE_NATIVE_REPORT_MAX_BYTES);
    assert.throws(() => validateAppleNativeEvidence(report, plan));
  }
  const inline = evidenceFixture();
  inline.commands[0].stdout.text = "Legacy inline output";
  assert.throws(() => validateAppleNativeEvidence(inline, plan), /separate artifacts/);
  const oversized = evidenceFixture();
  oversized.unexpectedPayload = "x".repeat(APPLE_NATIVE_REPORT_MAX_BYTES);
  assert.throws(() => validateAppleNativeEvidence(oversized, plan), /publication budget/);
});

test("native evidence rejects missing roles, stale source, copied outputs and incomplete cleanup", () => {
  const mutations = [
    (report) => { report.source.head = "4".repeat(40); },
    (report) => { report.sourceAfter.fingerprint = "4".repeat(64); },
    (report) => { report.base = "4".repeat(40); },
    (report) => { report.status = "blocked"; },
    (report) => { report.cleanup = "unknown"; },
    (report) => { report.failures.push({ reason: "original-test-failure" }); },
    (report) => { report.builds.pop(); },
    (report) => { report.tests = report.tests.filter((item) => item.role !== "duo"); },
    (report) => { report.tests[3] = structuredClone(report.tests[1]); },
    (report) => { report.resources[0].deviceId = uuid(99); },
    (report) => { report.resources[0].runtimeIdentifier = "unobserved-runtime"; },
    (report) => { report.resources[0].cleanup = "failed"; },
    (report) => { report.commands.find((item) => item.id === "test-mac").outcome.exitCode = 65; },
    (report) => { report.commands.find((item) => item.id === "test-mac").cleanup = "unknown"; },
    (report) => { report.commands.find((item) => item.id === "test-mac").args.push("-only-testing:DevPocketUITests"); },
    (report) => { report.builds[0].product.path = ".data/ci/copied/DevPocket.app"; },
    (report) => { report.builds[0].product.producedBy = "test-iphone"; },
    (report) => { report.tests[0].resultBundle.sha256 = "0".repeat(64); },
    (report) => { report.commands.find((item) => item.id === "build-ios").args.splice(-1, 1, "build-for-testing"); },
    (report) => changeOutput(report, "build-ios", () => "** BUILD SUCCEEDED **\n"),
    (report) => changeOutput(report, "test-mac-summary", (text) => appleJSON({ ...JSON.parse(text), startTime: 1 })),
    (report) => changeOutput(report, "cleanup-after", (text) => {
      const data = JSON.parse(text), resource = report.resources[0];
      data.devices[resource.runtimeIdentifier].push({ udid: resource.deviceId, name: resource.name, state: "Shutdown" });
      return appleJSON(data);
    }),
  ];
  for (const [index, mutate] of mutations.entries()) {
    const report = evidenceFixture(); mutate(report);
    assert.throws(() => validateAppleNativeEvidence(report, plan), undefined, `mutation ${index}`);
  }
});

test("UI-only discovery and failed/skipped/expected-failure/not-run xcresult cases cannot pass", () => {
  for (const field of ["failedTests", "skippedTests", "expectedFailures"]) {
    const report = evidenceFixture();
    changeOutput(report, "test-iphone-summary", (text) => appleJSON({ ...JSON.parse(text), [field]: 1 }));
    assert.throws(() => validateAppleNativeEvidence(report, plan));
  }
  for (const state of ["Failed", "Skipped", "Expected Failure", "Not Run"]) {
    const report = evidenceFixture();
    changeOutput(report, "test-ipad-tests", (text) => {
      const data = JSON.parse(text); data.testNodes[0].children[0].children[0].result = state; return appleJSON(data);
    });
    assert.throws(() => validateAppleNativeEvidence(report, plan));
  }
  const report = evidenceFixture();
  changeOutput(report, "test-duo-tests", (text) => {
    const data = JSON.parse(text); data.testNodes[0].children.shift(); return appleJSON(data);
  });
  changeOutput(report, "test-duo-summary", (text) => {
    const data = JSON.parse(text); data.passedTests = 1; data.totalTestCount = 1; data.devicesAndConfigurations[0].passedTests = 1;
    return appleJSON(data);
  });
  assert.throws(() => validateAppleNativeEvidence(report, plan), /coverage/);
});

test("a real native destination and both independent xcresult device projections must agree", () => {
  const execution = { startedAt: "2026-10-25T00:00:00.000Z", completedAt: "2026-10-25T00:00:01.000Z" };
  const target = { platform: "iOS Simulator", osVersion: "27.1", architecture: "arm64", deviceId: uuid(3) };
  for (const alter of [
    (data) => { data.tests.devices[0] = { ...data.tests.devices[0], deviceId: uuid(4) }; },
    (data) => { data.summary.devicesAndConfigurations[0].device.osVersion = "27.0"; },
    (data) => { data.summary.devicesAndConfigurations[0].device.platform = "macOS"; },
    (data) => { data.tests.testNodes[0].children[0].children.push(data.tests.testNodes[0].children[0].children[0]); },
  ]) {
    const data = nativeFixture(target, execution); alter(data);
    assert.throws(() => normalizeAppleTestResult(data.summary, data.tests, target, execution, ["DevPocketTests", "DevPocketUITests"]));
  }
});

test("CI receipts cannot be relabelled as MCP work", () => {
  const report = evidenceFixture();
  report.origin = "local-xcode-mcp";
  assert.throws(() => validateAppleNativeEvidence(report, plan), /origin/);
  assert.throws(() => validateAppleNativeEvidence(report, plan, "local-xcode-mcp"), /original invocation/);
  assert.throws(() => validateAppleNativeEvidence({ ...report, origin: "unrecognized" }, plan, "unrecognized"), /Unknown/);
});

test("the shared outcome schema accepts distinct original-client receipt envelopes", () => {
  const report = evidenceFixture();
  report.origin = "local-xcode-mcp";
  for (const item of [...report.builds, ...report.tests]) {
    const id = `synthetic-mcp-${item.commandId}`;
    item.execution = { origin: report.origin, kind: "original-client-tool-call", toolCallId: id,
      tool: `xcode/${item.action === "build" ? "BuildProject" : "RunAllTests"}`,
      workspace: item.execution.workspace, startedAt: item.execution.startedAt, completedAt: item.execution.completedAt,
      evidence: ["request", "response"].map((kind) => ({ path: `${report.directory}/${id}-${kind}.json`,
        sha256: appleDigest(`Synthetic ${kind}, not a native receipt`) })) };
    if (item.product) item.product.producedBy = id;
    if (item.action === "build") delete item.resultBundle;
    else item.resultBundle.producedBy = id;
    delete item.commandId;
    delete item.summaryCommandId;
    delete item.testsCommandId;
  }
  for (const field of ["commands", "ci", "resources", "cleanupEvidence", "preparationCommandId"]) delete report[field];
  let afterTests = Math.max(...report.tests.map((item) => Date.parse(item.execution.completedAt))) + 1000;
  for (const build of report.builds) {
    build.execution.startedAt = new Date(afterTests).toISOString();
    build.execution.completedAt = new Date(afterTests + 100).toISOString();
    afterTests += 1000;
  }
  report.completedAt = new Date(afterTests).toISOString();
  assert.equal(validateAppleNativeEvidence(report, plan, "local-xcode-mcp"), report);
  report.tests[0].execution.tool = "xcode/RunSomeTests";
  assert.throws(() => validateAppleNativeEvidence(report, plan, "local-xcode-mcp"), /original invocation/);
});

test("CI still requires tests after both normal builds", () => {
  const report = evidenceFixture();
  report.builds[0].execution.completedAt = report.tests.at(-1).execution.completedAt;
  assert.throws(() => validateAppleNativeEvidence(report, plan), /interval/);
});

function simulatorHarness({ createOutput, failureId, failCreateAfterMutation = false } = {}) {
  const baseline = inventoryFixture(), live = structuredClone(baseline), calls = [];
  const originalFailure = new Error("Synthetic original command failure");
  const selection = selectAppleSimulators(baseline)[0];
  const invoke = async (id, args) => {
    calls.push({ id, args });
    const action = args[1];
    if (id === failureId) throw originalFailure;
    let stdout = "";
    if (action === "list") stdout = appleJSON(live);
    if (action === "create") {
      live.devices[args[4]].push({ udid: uuid(1), name: args[2], state: "Shutdown", deviceTypeIdentifier: args[3] });
      if (failCreateAfterMutation) throw originalFailure;
      stdout = createOutput ?? uuid(1) + "\n";
    }
    const device = Object.values(live.devices).flat().find((item) => item.udid === args[2]);
    if (action === "boot") device.state = "Booted";
    if (action === "shutdown") device.state = "Shutdown";
    if (action === "delete") {
      for (const [runtime, devices] of Object.entries(live.devices)) live.devices[runtime] = devices.filter((item) => item.udid !== args[2]);
    }
    return { stdout: { text: stdout } };
  };
  return { baseline, live, calls, originalFailure, selection, invoke };
}

test("synthetic simulator lifecycle touches only the newly created ID and retains unrelated devices", async () => {
  const fixture = simulatorHarness(), resources = [];
  const resource = await createAppleSimulator(fixture.selection, owner, resources, fixture.baseline, fixture.invoke);
  const result = await cleanupAppleSimulators(resources, fixture.baseline, fixture.invoke);
  assert.equal(result.status, "completed");
  assert.equal(resource.cleanup, "completed");
  assert.deepEqual(fixture.live.devices, fixture.baseline.devices);
  const mutations = fixture.calls.filter((call) => ["boot", "bootstatus", "shutdown", "delete"].includes(call.args[1]));
  assert.ok(mutations.every((call) => call.args[2] === uuid(1)));
  assert.ok(fixture.calls.findIndex((call) => call.id === "confirm-iphone") < fixture.calls.findIndex((call) => call.id === "boot-iphone"));
});

test("lost or malformed create output is recovered by a unique new name without losing the original failure", async () => {
  for (const options of [{ createOutput: "not-a-device-id\n" }, { failCreateAfterMutation: true }]) {
    const fixture = simulatorHarness(options), resources = [];
    await assert.rejects(createAppleSimulator(fixture.selection, owner, resources, fixture.baseline, fixture.invoke));
    assert.ok(!fixture.calls.some((call) => call.args[1] === "boot"));
    const result = await cleanupAppleSimulators(resources, fixture.baseline, fixture.invoke);
    assert.equal(result.status, "completed");
    assert.equal(resources[0].recoveredAfterCreate, true);
    assert.deepEqual(fixture.live.devices, fixture.baseline.devices);
  }
});

test("cleanup never deletes a mismatched or baseline device", async () => {
  const fixture = simulatorHarness({ createOutput: uuid(99) + "\n" }), resources = [];
  await assert.rejects(createAppleSimulator(fixture.selection, owner, resources, fixture.baseline, fixture.invoke), /pre-existing ID/);
  const result = await cleanupAppleSimulators(resources, fixture.baseline, fixture.invoke);
  assert.equal(result.status, "completed");
  assert.ok(!fixture.calls.some((call) => ["boot", "shutdown", "delete"].includes(call.args[1]) && call.args[2] === uuid(99)));
  assert.ok(fixture.calls.some((call) => call.args[1] === "delete" && call.args[2] === uuid(1)));
  assert.ok(Object.values(fixture.live.devices).flat().some((device) => device.udid === uuid(99)));
});

test("shutdown failure remains failed even if deletion succeeds; unavailable cleanup stays unknown", async () => {
  for (const failureId of ["shutdown-iphone", "cleanup-before", "cleanup-after"]) {
    const fixture = simulatorHarness({ failureId }), resources = [];
    await createAppleSimulator(fixture.selection, owner, resources, fixture.baseline, fixture.invoke);
    const result = await cleanupAppleSimulators(resources, fixture.baseline, fixture.invoke);
    assert.equal(result.status, failureId === "shutdown-iphone" ? "failed" : "unknown");
    assert.equal(result.failures[0].error, fixture.originalFailure);
    if (failureId === "shutdown-iphone") assert.ok(fixture.calls.some((call) => call.id === "delete-iphone"));
    if (failureId === "cleanup-before") assert.ok(!fixture.calls.some((call) => call.id === "delete-iphone"));
  }
});
