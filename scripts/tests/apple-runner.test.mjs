import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  APPLE_NATIVE_REPORT_MAX_BYTES, APPLE_PROBES, APPLE_REQUIREMENTS, APPLE_RESULT_READINESS_MS, APPLE_CI_ROLES,
  appleCIShardDescriptor, appleCIDeferredTests, appleCITestSelection, combineAppleCIEvidence,
  appleDigest, appleEnumerationArguments, appleJSON, appleResultManifestReference, appleTestInterval, appleXcodeArguments,
  inspectAppleScheme, inspectAppleToolchain, normalizeAppleBatchResult, normalizeAppleTestResult, selectAppleSimulators,
  localAppleToolchain, normalizeAppleTestCatalog, projectAppleCleanupEvidence, projectAppleCommandOutput, projectAppleXcresult,
  selectAppleLocalTargets, validateAppleNativeEvidence, validateApplePlan,
} from "../apple-evidence.mjs";
import {
  appleRunnerOutputPath, cleanupAppleSimulators, createAppleSimulator, directoryArtifact,
  parseAppleRunnerArguments, requireAppleCIEnvironment, retainAppleResultManifest,
  runAppleLocalCommands, validateAppleLocalArtifacts, waitForAppleResult,
} from "../apple-runner.mjs";
import { combineVerification, requireToolingShardReport, requireAppleShardReport } from "../verification.mjs";
import { ciReportEnvelope, collectCIReports } from "../verification-ci.mjs";
import { toolingCatalogue, toolingShardDescriptor } from "../verification-tooling.mjs";
import { syntheticExecution } from "./fixtures/verification-tools.mjs";
import { openVerificationRun, readVerificationRun } from "../verification-run.mjs";
import { appleVerification } from "../verification-apple.mjs";
import { commandCleanupConfirmed, runCommand } from "../process.mjs";

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

function nativeFixture(target, execution, modelCases = 2, pixel = false) {
  const device = { deviceId: target.deviceId ?? "synthetic-native-mac-id", deviceName: "Synthetic test destination",
    platform: target.platform, osVersion: target.osVersion, architecture: target.architecture };
  const cases = (name, count) => Array.from({ length: count }, (_, index) =>
    ({ nodeType: "Test Case", nodeIdentifier: `${name}/fixture${index}()`, result: "Passed" }));
  const testNodes = [{ nodeType: "Test Plan", name: "DevPocket", children: [
    { nodeType: "Unit test bundle", name: "DevPocketTests", children: [...cases("ModelAndWKFixtures", modelCases),
      ...(pixel ? [{ nodeType: "Test Case", nodeIdentifier: "DevPocketTests/actualWKWebViewRendersChartPixels()", result: "Passed" }] : [])] },
    { nodeType: "UI test bundle", name: "DevPocketUITests", children: cases("DevPocketUITests", 1) },
  ] }];
  const passedTests = modelCases + 1 + Number(pixel);
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

function evidenceFixture(modelCases = 2, ciRole) {
  const workspace = "/synthetic-checkout", directory = ciRole ? `.data/ci/apple-${ciRole}-synthetic` : ".data/ci/apple-synthetic";
  let clock = Date.parse("2026-10-25T00:00:00.000Z");
  const report = {
    version: ciRole ? 2 : 1, kind: "apple-native-evidence", origin: "ci-xcodebuild", workspace, directory,
    runId: ciRole ? uuid(43 + APPLE_CI_ROLES.indexOf(ciRole)) : owner,
    ...(ciRole ? { ciRole, nativeAcceptanceRequired: true, deferredTests: ciRole === "mac"
      ? [{ targetName: "DevPocketTests", testIdentifier: "DevPocketTests/actualWKWebViewRendersChartPixels()" }] : [] } : {}),
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
    if (ciRole && requirement.role !== ciRole) continue;
    const mac = requirement.role === "mac";
    let target = { role: "mac", platform: "macOS", osVersion: "27.0.1", architecture: "arm64" };
    if (!mac) {
      const selection = report.toolchain.simulators.find((item) => item.role === requirement.role);
      const resource = { role: requirement.role, deviceId: uuid(index), name: `DevPocket-${report.runId}-${requirement.role}`,
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
    let catalog, selectedTests;
    if (ciRole) {
      const all = nativeFixture(target, {
        startedAt: new Date(clock).toISOString(), completedAt: new Date(clock + 100).toISOString(),
      }, modelCases, true);
      const data = { errors: [], values: [{ testPlan: "DevPocket", disabledTests: [],
        enabledTests: all.tests.testNodes[0].children.flatMap((bundle) =>
          bundle.children.map((test) => ({ identifier: `${bundle.name}/${test.nodeIdentifier}` }))) }] };
      const catalogDirectory = `${relative}/catalog`;
      command(`${id}-catalog`, "/usr/bin/xcrun",
        appleEnumerationArguments(workspace, catalogDirectory, target, mac), "Synthetic unfiltered enumeration\n");
      catalog = { ...outputFile(`${catalogDirectory}/enumeration.json`, appleJSON(data)), data };
      if (mac) selectedTests = normalizeAppleTestCatalog(data, report.scheme.targets)
        .filter((test) => test.testIdentifier !== "DevPocketTests/actualWKWebViewRendersChartPixels()");
    }
    const execution = command(id, "/usr/bin/xcrun", appleXcodeArguments({
      workspace, directory: relative, action: "test", platform: mac ? "macos" : "ios", destination,
      ...(selectedTests ? { selectedTests } : {}),
    }), "** TEST SUCCEEDED **\n");
    const native = nativeFixture(target, execution, modelCases, Boolean(ciRole) && !mac);
    for (const kind of ["summary", "tests"]) command(`${id}-${kind}`, "/usr/bin/xcrun",
      ["xcresulttool", "get", "test-results", kind, "--path", `${workspace}/${relative}/result.xcresult`, "--compact"], appleJSON(native[kind]));
    const summary = projectAppleXcresult("summary", native.summary), testTree = projectAppleXcresult("tests", native.tests);
    report.tests.push({ role: target.role, action: "test", status: "passed", commandId: id,
      execution: executionReference(execution), target: { ...target, deviceId: native.summary.devicesAndConfigurations[0].device.deviceId },
      summary, testTree, summaryCommandId: `${id}-summary`, testsCommandId: `${id}-tests`,
      ...(catalog ? { catalog, catalogCommandId: `${id}-catalog` } : {}),
      resultBundle: treeFixture(`${relative}/result.xcresult`, id, ["Info.plist", "Data/synthetic"]),
      result: normalizeAppleTestResult(summary, testTree, target, execution, report.scheme.targets) });
  }
  if (report.resources.length) {
    report.cleanupEvidence = { beforeCommandId: "cleanup-before", afterCommandId: "cleanup-after" };
    command("cleanup-before", "/usr/bin/xcrun", ["simctl", "list", "devices", "--json"], appleJSON(inventory));
    for (const resource of report.resources) {
      command(resource.shutdownCommandId, "/usr/bin/xcrun", ["simctl", "shutdown", resource.deviceId]);
      command(resource.deleteCommandId, "/usr/bin/xcrun", ["simctl", "delete", resource.deviceId]);
      inventory.devices[resource.runtimeIdentifier] = inventory.devices[resource.runtimeIdentifier].filter((device) => device.udid !== resource.deviceId);
    }
    command("cleanup-after", "/usr/bin/xcrun", ["simctl", "list", "devices", "--json"], appleJSON(inventory));
  } else {
    report.cleanupEvidence = { beforeCommandId: null, afterCommandId: null };
  }
  report.completedAt = new Date(clock + 1000).toISOString();
  return report;
}

function localCommandFixture(modelCases = 2) {
  const workspace = "/synthetic-checkout", directory = ".data/verification/local-command-synthetic";
  const inventory = inventoryFixture(), probes = probeFixture();
  const requested = APPLE_REQUIREMENTS.targets.map((target, index) => ({
    role: target.role, deviceId: index === 0 ? "synthetic-native-mac-id" : uuid(index),
  }));
  for (const [index, type] of inventory.devicetypes.entries()) {
    const runtime = inventory.runtimes.find((item) => item.supportedDeviceTypes.some((entry) => entry.identifier === type.identifier));
    inventory.devices[runtime.identifier].push({ udid: uuid(index + 1), name: `Existing synthetic ${type.name}`,
      state: "Booted", deviceTypeIdentifier: type.identifier });
  }
  probes.simulators = appleJSON(inventory);
  const targets = selectAppleLocalTargets(inventory, inspectAppleToolchain(probes), requested, true);
  let clock = Date.parse("2026-10-26T00:00:00.000Z");
  const report = { version: 1, kind: "apple-native-evidence", origin: "local-xcodebuild",
    workspace, directory, runId: owner, ...structuredClone(plan),
    sourceBefore: structuredClone(plan.source), sourceAfter: structuredClone(plan.source),
    startedAt: new Date(clock).toISOString(), completedAt: null, status: "passed", cleanup: "completed", failures: [],
    local: { platform: "darwin", targets,
      plan: { path: ".data/verification/command-plan/plan.json", sha256: appleDigest("Synthetic local plan") },
      executionRequest: { path: `${directory}/execution-request.json`, sha256: appleDigest("Synthetic local request") },
      targetsAfterCommandId: "local-targets-after" },
    toolchain: localAppleToolchain(inspectAppleToolchain(probes), targets),
    scheme: { path: `${APPLE_REQUIREMENTS.project}/xcshareddata/xcschemes/DevPocket.xcscheme`,
      xml: scheme, sha256: appleDigest(scheme), targets: inspectAppleScheme(scheme) },
    commands: [], builds: [], tests: [], resources: [], cleanupEvidence: {} };
  const command = (id, file, args, stdout = "") => {
    const request = { id, kind: "owned-command", origin: report.origin, file, args: [...args], cwd: workspace,
      startedAt: new Date(clock += 1000).toISOString(), completedAt: null, status: "running", cleanup: "unknown" };
    const value = { ...request, completedAt: new Date(clock += 100).toISOString(), status: "passed", cleanup: "completed",
      outcome: { observedProcess: "owned-command-supervisor", reason: "exit", exitCode: 0, signal: "none",
        capturedBytes: Buffer.byteLength(stdout), outputTruncated: false, cleanupFailure: null },
      request: outputFile(`${directory}/logs/${id}.request.json`, appleJSON(request)),
      stdout: outputFile(`${directory}/logs/${id}.stdout.txt`, stdout), stderr: outputFile(`${directory}/logs/${id}.stderr.txt`, "") };
    value.output = projectAppleCommandOutput(value, stdout, "");
    value.response = outputFile(`${directory}/logs/${id}.response.json`, appleJSON(value));
    report.commands.push(value);
    return value;
  };
  const execution = (value) => ({ origin: report.origin, kind: "owned-command", commandId: value.id,
    workspace: `${workspace}/${APPLE_REQUIREMENTS.project}`, startedAt: value.startedAt, completedAt: value.completedAt });
  const copies = (item, relative, value) => {
    item.resultBundle = treeFixture(`${relative}/result.xcresult`, value.id, ["Info.plist", "Data/fixture"]);
    item.retainedResultBundle = { path: `${relative}/retained/result.xcresult`,
      producedBy: item.resultBundle.producedBy, sha256: item.resultBundle.sha256 };
    item.readiness = { commandId: value.id, status: "ready", timeoutMs: APPLE_RESULT_READINESS_MS,
      polls: 2, startedAt: value.completedAt, completedAt: new Date(Date.parse(value.completedAt) + 10).toISOString(),
      infoSha256: item.resultBundle.files.find((file) => file.path === "Info.plist").sha256 };
    if (item.action === "test") item.resultBundle = appleResultManifestReference(item.resultBundle,
      outputFile(`${relative}/result-files.json`, appleJSON(item.resultBundle.files)));
  };
  for (const probe of APPLE_PROBES) command(`probe-${probe.id}`, probe.file, probe.args, probes[probe.id]);
  report.preparationCommandId = "prepare-components";
  command(report.preparationCommandId, "/synthetic/node", ["apple/prepare-components.mjs"], "Synthetic preparation\n");
  for (const platform of ["ios", "macos"]) {
    const id = `build-${platform}`, relative = `${directory}/${id}`;
    const product = `${relative}/derived/Build/Products/${platform === "ios" ? "Debug-iphonesimulator" : "Debug"}/DevPocket.app`;
    const destination = platform === "ios" ? "generic/platform=iOS Simulator" : "platform=macOS,id=synthetic-native-mac-id";
    const value = command(id, "/usr/bin/xcrun", appleXcodeArguments({ workspace, directory: relative, action: "build", platform, destination }),
      `CodeSign ${workspace}/${product} (in target 'DevPocket' from project 'DevPocket')\n** BUILD SUCCEEDED **\n`);
    const item = { platform, action: "build", status: "passed", commandId: id, execution: execution(value),
      originalProduct: `${workspace}/${product}`,
      product: treeFixture(product, id, platform === "ios" ? ["Info.plist", "DevPocket"] : ["Contents/Info.plist", "Contents/MacOS/DevPocket"]),
      signatureCommandId: `${id}-signature`, infoCommandId: `${id}-info` };
    copies(item, relative, value);
    item.retainedProduct = { path: `${relative}/retained/DevPocket.app`,
      producedBy: item.product.producedBy, sha256: item.product.sha256 };
    item.seal = outputFile(`${relative}/retained/artifact.json`, "Synthetic seal");
    command(item.signatureCommandId, "/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", item.originalProduct]);
    command(item.infoCommandId, "/usr/bin/plutil", ["-convert", "json", "-o", "-",
      item.originalProduct + (platform === "ios" ? "/Info.plist" : "/Contents/Info.plist")],
    appleJSON({ CFBundleIdentifier: "synthetic.fixtures", [platform === "ios" ? "MinimumOSVersion" : "LSMinimumSystemVersion"]: "27.0" }));
    report.builds.push(item);
  }
  for (const target of targets) {
    const id = `test-${target.role}`, relative = `${directory}/${id}`, catalogDirectory = `${relative}/catalog`;
    const beforeCatalogCommandId = `${id}-before-catalog`, beforeTestCommandId = `${id}-before-test`, catalogCommandId = `${id}-catalog`;
    command(beforeCatalogCommandId, "/usr/bin/xcrun", ["simctl", "list", "--json"], appleJSON(inventory));
    command(catalogCommandId, "/usr/bin/xcrun", appleEnumerationArguments(workspace, catalogDirectory, target), "Synthetic discovery\n");
    command(beforeTestCommandId, "/usr/bin/xcrun", ["simctl", "list", "--json"], appleJSON(inventory));
    const value = command(id, "/usr/bin/xcrun", appleXcodeArguments({ workspace, directory: relative,
      action: "test", platform: target.role === "mac" ? "macos" : "ios", destination: `platform=${target.platform},id=${target.deviceId}`,
      testDiagnostics: "never" }),
    "** TEST SUCCEEDED **\n");
    const native = nativeFixture(target, value, modelCases), summary = projectAppleXcresult("summary", native.summary);
    const testTree = projectAppleXcresult("tests", native.tests);
    const result = normalizeAppleTestResult(summary, testTree, target, value, report.scheme.targets);
    const catalogData = { errors: [], values: [{ testPlan: "DevPocket", disabledTests: [],
      enabledTests: result.cases.map((test) => ({ identifier: `${test.target}/${test.identifier}` })) }] };
    const item = { role: target.role, action: "test", status: "passed", commandId: id, target,
      execution: execution(value), summary, testTree, result, catalogCommandId, beforeCatalogCommandId, beforeTestCommandId,
      catalog: { ...outputFile(`${catalogDirectory}/enumeration.json`, appleJSON(catalogData)), data: catalogData },
      summaryCommandId: `${id}-summary`, testsCommandId: `${id}-tests` };
    copies(item, relative, value);
    for (const kind of ["summary", "tests"]) command(`${id}-${kind}`, "/usr/bin/xcrun",
      ["xcresulttool", "get", "test-results", kind, "--path", `${workspace}/${relative}/result.xcresult`, "--compact"],
      appleJSON(native[kind]));
    report.tests.push(item);
  }
  command("local-targets-after", "/usr/bin/xcrun", ["simctl", "list", "--json"], appleJSON(inventory));
  report.completedAt = new Date(clock + 1000).toISOString();
  return report;
}

test("local full commands have their own origin, exact existing targets, complete catalogues and sealed copies", () => {
  const report = localCommandFixture();
  assert.equal(validateAppleNativeEvidence(report, plan, "local-xcodebuild"), report);
  assert.throws(() => validateAppleNativeEvidence(report, plan), /origin/);
  assert.throws(() => validateAppleNativeEvidence(report, plan, "local-xcode-mcp"), /origin/);
  assert.equal(report.commands.some((item) => item.args[0] === "simctl" &&
    ["create", "boot", "shutdown", "delete"].includes(item.args[1])), false);
});

test("cleanup evidence preserves exact JSON identity without inventing lifecycle references", async () => {
  const localCleanup = { status: "completed", failures: [] }, local = localCommandFixture();
  local.cleanupEvidence = projectAppleCleanupEvidence(localCleanup);
  assert.deepEqual(local.cleanupEvidence, {});
  assert.equal(validateAppleNativeEvidence(local, plan, "local-xcodebuild"), local);
  assert.deepEqual(JSON.parse(appleJSON(local)), local);
  const legacy = { beforeCommandId: localCleanup.beforeCommandId, afterCommandId: localCleanup.afterCommandId };
  assert.notDeepEqual(JSON.parse(appleJSON(legacy)), legacy);

  const empty = await cleanupAppleSimulators([], inventoryFixture(), () => assert.fail("No owned simulator needs a command."));
  assert.deepEqual(projectAppleCleanupEvidence(empty), { beforeCommandId: null, afterCommandId: null });
  const ci = evidenceFixture(), original = structuredClone(ci.cleanupEvidence);
  ci.cleanupEvidence = projectAppleCleanupEvidence({ status: "completed", ...original, failures: [] });
  assert.deepEqual(ci.cleanupEvidence, original);
  assert.equal(validateAppleNativeEvidence(ci, plan), ci);
  assert.deepEqual(JSON.parse(appleJSON(ci)), ci);
  ci.cleanupEvidence = projectAppleCleanupEvidence(localCleanup);
  assert.throws(() => validateAppleNativeEvidence(ci, plan));
});

test("only explicit local tests omit optional long-running diagnostics, without changing other arguments", () => {
  for (const platform of ["ios", "macos"]) {
    const input = { workspace: "/synthetic", directory: ".data/verification/native/test",
      action: "test", platform, destination: platform === "ios" ? `platform=iOS Simulator,id=${uuid(1)}` : "platform=macOS,id=synthetic-mac" };
    const original = appleXcodeArguments(input);
    const local = appleXcodeArguments({ ...input, testDiagnostics: "never" });
    const index = local.indexOf("-collect-test-diagnostics");
    assert.equal(local[index + 1], "never");
    assert.deepEqual([...local.slice(0, index), ...local.slice(index + 2)], original);
    assert.equal(original.includes("-collect-test-diagnostics"), false);
    assert.equal(appleXcodeArguments({ ...input, action: "build" }).includes("-collect-test-diagnostics"), false);
    assert.throws(() => appleXcodeArguments({ ...input, action: "build", testDiagnostics: "never" }), /Invalid/);
    assert.throws(() => appleXcodeArguments({ ...input, testDiagnostics: "on-failure" }), /Invalid/);
  }
  const local = localCommandFixture();
  assert.equal(local.commands.filter(command => command.args.includes("-collect-test-diagnostics")).length, 4);
  for (const command of local.commands.filter(command => !/^test-(mac|iphone|ipad|duo)$/.test(command.id))) {
    assert.equal(command.args.includes("-collect-test-diagnostics"), false, command.id);
  }
  const ci = evidenceFixture();
  assert.equal(ci.commands.some(command => command.args.includes("-collect-test-diagnostics")), false);
  assert.equal(validateAppleNativeEvidence(ci, plan), ci);
});

test("local command acceptance rejects missing, substituted, stale, failed and extra evidence", () => {
  const changes = [
    (r) => { r.ci = evidenceFixture().ci; },
    (r) => { r.origin = "ci-xcodebuild"; },
    (r) => { r.commands[0].cleanup = "unknown"; },
    (r) => { r.commands[0].outcome.reason = "timeout"; },
    (r) => { delete r.commands[0].request; },
    (r) => { delete r.commands[0].response; },
    (r) => { r.commands[0].args.push("unexpected"); },
    (r) => {
      const args = r.commands.find(command => command.id === "test-ipad").args;
      args.splice(args.indexOf("-collect-test-diagnostics"), 2);
    },
    (r) => {
      const args = r.commands.find(command => command.id === "test-ipad").args;
      args[args.indexOf("-collect-test-diagnostics") + 1] = "on-failure";
    },
    (r) => { r.tests[0].target.deviceId = "another-mac"; },
    (r) => { r.local.targets[1].deviceId = uuid(99); },
    (r) => { r.tests[0].readiness.status = "timeout"; },
    (r) => { r.tests[0].readiness.timeoutMs++; },
    (r) => { r.tests[0].readiness.infoSha256 = "0".repeat(64); },
    (r) => { r.tests[0].catalog.data.values[0].enabledTests.pop(); },
    (r) => { r.tests[0].catalog.data.values[0].disabledTests.push({ identifier: "disabled" }); },
    (r) => { r.tests[0].catalog.data.errors.push("UI runner initialization failed"); },
    (r) => { r.tests[0].retainedResultBundle.sha256 = "0".repeat(64); },
    (r) => { r.tests[0].resultBundle.fileManifest.sha256 = "0".repeat(64); },
    (r) => { r.tests[0].resultBundle.fileManifest.bytes = 16 * 1024 * 1024 + 1; },
    (r) => { r.tests[0].resultBundle.fileManifest.path = "../unbound-files.json"; },
    (r) => { r.tests[0].resultBundle.fileCount = 20001; },
    (r) => { r.builds.pop(); },
    (r) => { r.builds[0].retainedProduct.sha256 = "0".repeat(64); },
    (r) => { r.commands.find((c) => c.id === r.builds[0].signatureCommandId).outcome.exitCode = 1; },
    (r) => { r.commands.push({ ...structuredClone(r.commands[0]), id: "unrequested" }); },
    (r) => { r.resources.push({ role: "duo", deviceId: uuid(3) }); },
    (r) => { r.sourceAfter.fingerprint = "0".repeat(64); },
  ];
  for (const [index, change] of changes.entries()) {
    const report = localCommandFixture();
    change(report);
    assert.throws(() => validateAppleNativeEvidence(report, plan, "local-xcodebuild"), undefined, `mutation ${index}`);
  }
});

test("local commands refuse hosted identity before touching a plan or invoking any native command", async (t) => {
  const original = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  t.after(() => { if (original === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = original; });
  await assert.rejects(runAppleLocalCommands({}), /local Mac entry/);
});

test("hosted and local four-role results keep complete manifests outside the unchanged publication budget", () => {
  for (const [origin, report] of [["ci-xcodebuild", evidenceFixture(42)], ["local-xcodebuild", localCommandFixture(42)]]) {
    const privateManifests = new Map();
    for (const item of report.tests) {
      const directory = path.posix.dirname(item.resultBundle.path);
      const tree = treeFixture(item.resultBundle.path, item.commandId,
        ["Info.plist", ...Array.from({ length: 4000 }, (_, index) => `Data/attachment-${String(index).padStart(8, "0")}`)]);
      const bytes = appleJSON(tree.files), reference = outputFile(`${directory}/result-files.json`, bytes);
      assert.ok(Buffer.byteLength(bytes) > APPLE_NATIVE_REPORT_MAX_BYTES);
      privateManifests.set(reference.path, bytes);
      item.resultBundle = appleResultManifestReference(tree, reference);
      if (item.retainedResultBundle) item.retainedResultBundle.sha256 = tree.sha256;
    }
    assert.equal(privateManifests.size, 4);
    assert.ok(Buffer.byteLength(appleJSON(report)) < APPLE_NATIVE_REPORT_MAX_BYTES);
    assert.equal(validateAppleNativeEvidence(report, plan, origin), report);
    assert.equal(report.tests.flatMap((item) => item.result.cases).length, 172);
    for (const item of report.tests) {
      const bytes = privateManifests.get(item.resultBundle.fileManifest.path);
      assert.equal(appleDigest(bytes), item.resultBundle.sha256);
      assert.equal(JSON.parse(bytes).length, item.resultBundle.fileCount);
    }
  }
});

test("hosted result manifests keep exact command, path, digest and size bindings", () => {
  const inline = evidenceFixture();
  assert.equal(validateAppleNativeEvidence(inline, plan), inline);
  const changes = [
    (item) => { item.resultBundle.producedBy = "another-command"; },
    (item) => { item.resultBundle.fileManifest.sha256 = "0".repeat(64); },
    (item) => { item.resultBundle.fileManifest.bytes = 16 * 1024 * 1024 + 1; },
    (item) => { item.resultBundle.fileManifest.path = "../unbound-files.json"; },
    (item) => { item.resultBundle.fileManifest.path += ".other"; },
    (item) => { item.resultBundle.fileCount = 0; },
    (item) => { item.resultBundle.fileCount = 20001; },
    (item) => { item.resultBundle.infoSha256 = "missing"; },
  ];
  for (const change of changes) {
    const report = evidenceFixture(), item = report.tests[0], full = item.resultBundle;
    item.resultBundle = appleResultManifestReference(full,
      outputFile(`${path.posix.dirname(full.path)}/result-files.json`, appleJSON(full.files)));
    assert.equal(validateAppleNativeEvidence(report, plan), report);
    change(item);
    assert.throws(() => validateAppleNativeEvidence(report, plan));
  }
});

test("local result qualification reopens every manifest and both original and copied file trees", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/apple-result-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = ".data/verification/native/test-mac", original = `${directory}/result.xcresult`;
  await mkdir(path.join(root, original, "Data"), { recursive: true });
  await writeFile(path.join(root, original, "Info.plist"), "Synthetic metadata\n");
  await writeFile(path.join(root, original, "Data/attachment"), "Original attachment bytes\n");
  const full = await directoryArtifact(root, original, "test-mac");
  const compact = await retainAppleResultManifest(root, full), copy = `${directory}/retained/result.xcresult`;
  await cp(path.join(root, original), path.join(root, copy), { recursive: true });
  const catalog = { errors: [], values: [] }, catalogBytes = appleJSON(catalog);
  await writeFile(path.join(root, directory, "catalog.json"), catalogBytes);
  const evidence = { commands: [], builds: [], tests: [{ action: "test", resultBundle: compact,
    retainedResultBundle: { path: copy, producedBy: full.producedBy, sha256: full.sha256 },
    catalog: { ...outputFile(`${directory}/catalog.json`, catalogBytes), data: catalog } }] };
  await validateAppleLocalArtifacts(root, evidence, []);
  const bytes = await readFile(path.join(root, compact.fileManifest.path));
  assert.equal(bytes.toString(), appleJSON(full.files));
  await assert.rejects(retainAppleResultManifest(root, full), { code: "EEXIST" });
  for (const file of [compact.fileManifest.path, `${original}/Data/attachment`, `${copy}/Data/attachment`]) {
    const saved = await readFile(path.join(root, file));
    await writeFile(path.join(root, file), "Changed bytes\n");
    await assert.rejects(validateAppleLocalArtifacts(root, evidence, []), { diagnosticCode: "artifact-changed" });
    await writeFile(path.join(root, file), saved);
  }
  compact.fileCount++;
  await assert.rejects(validateAppleLocalArtifacts(root, evidence, []), { diagnosticCode: "artifact-changed" });
  compact.fileCount--;
  await rm(path.join(root, compact.fileManifest.path));
  await assert.rejects(validateAppleLocalArtifacts(root, evidence, []), { code: "ENOENT" });
});

test("local target resolution never substitutes or boots a stopped existing simulator", () => {
  const report = localCommandFixture(), inventory = JSON.parse(probeFixture().simulators);
  assert.throws(() => selectAppleLocalTargets(inventory, report.toolchain, report.local.targets, true), /exact local simulator/);
  const data = report.commands.find((command) => command.id === "probe-simulators").output.data;
  data.devices[report.local.targets[1].runtimeIdentifier].find((device) => device.udid === report.local.targets[1].deviceId).state = "Shutdown";
  assert.throws(() => selectAppleLocalTargets(data, report.toolchain, report.local.targets, true), /stopped/);
});

test("result readiness waits for metadata without inventing a native success", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/apple-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "result.xcresult"));
  const pending = waitForAppleResult(root, "result.xcresult", "synthetic-test");
  await writeFile(path.join(root, "result.xcresult/Info.plist"), "Synthetic result metadata\n");
  const observation = await pending;
  assert.equal(observation.status, "ready");
  assert.equal(observation.infoSha256, appleDigest("Synthetic result metadata\n"));
  assert.equal(observation.timeoutMs, APPLE_RESULT_READINESS_MS);
});

test("result readiness retains cancellation and timeout instead of returning ready", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/apple-readiness-failed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForAppleResult(root, "missing.xcresult", "synthetic-cancel", controller.signal),
    (error) => error.appleResultReadiness?.status === "cancelled");
  let calls = 0;
  t.mock.method(performance, "now", () => calls++ === 0 ? 0 : APPLE_RESULT_READINESS_MS + 1);
  await assert.rejects(waitForAppleResult(root, "missing.xcresult", "synthetic-timeout"),
    (error) => error.diagnosticCode === "apple-result-incomplete" && error.appleResultReadiness?.status === "timeout");
});

test("result readiness rejects linked metadata rather than reading outside its retained directory",
  { skip: process.platform === "win32" }, async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/apple-readiness-linked-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "result.xcresult"));
  await writeFile(path.join(root, "elsewhere.plist"), "Synthetic metadata\n");
  await symlink("../elsewhere.plist", path.join(root, "result.xcresult/Info.plist"));
  await assert.rejects(waitForAppleResult(root, "result.xcresult", "synthetic-linked"),
    (error) => error.appleResultReadiness?.status === "failed" && error.diagnosticCode === "ownership-mismatch");
});

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

test("the Apple adapter's grace period starts a real Darwin-owned child",
  { skip: process.platform !== "darwin" }, async (t) => {
    const ci = process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_ACTIONS;
    t.after(() => { if (ci === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = ci; });
    await mkdir(".data/tests", { recursive: true });
    const root = await mkdtemp(path.resolve(".data/tests/apple-grace-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const adapter = await appleVerification(root, { id: "apple-native" }, plan, {
      directory: path.join(root, ".data/verification/grace"), appleEvidence: ".data/qualify.json",
    });
    const args = ["-e", "process.stdout.write('apple-adapter-started')"];
    const result = await runCommand(adapter.file, args, { cwd: root, timeoutMs: 10000, graceMs: adapter.graceMs });
    assert.equal(result.stdout, "apple-adapter-started");
    assert.equal(commandCleanupConfirmed(result, { file: adapter.file, args, cwd: root }), true);
  });

test("Apple test intervals allow bounded timestamp precision, not stale executions", () => {
  const execution = { startedAt: "2026-10-25T00:00:00.800Z", completedAt: "2026-10-25T00:00:01.200Z" };
  const startTime = Date.parse("2026-10-25T00:00:00.000Z") / 1000;
  assert.doesNotThrow(() => appleTestInterval({ startTime, finishTime: startTime + 2 }, execution));
  for (const summary of [{ startTime: startTime - 1, finishTime: startTime + 1 },
    { startTime, finishTime: startTime + 3 }]) {
    assert.throws(() => appleTestInterval(summary, execution), { diagnosticCode: "execution-origin" });
  }
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
        executionState: "exited", privateLog: { availability: "retained" },
        commandOutcome: { observedProcess: "owned-command-supervisor", reason: "exit",
          exitCode: 0, cleanupFailure: null }, cleanup: "completed", appleEvidence: evidence }] };
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

test("Apple role evidence joins the ordinary gate and CI without losing shared macOS requirements", async () => {
  const selected = { ...structuredClone(plan), version: 6,
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
  const apple = APPLE_CI_ROLES.map((role) => {
    const evidence = evidenceFixture(2, role);
    return { ...selected, group: "apple", status: "partial", complete: false,
      checks: [{ id: "tooling-tests", status: "not_run" }, { id: "apple-native", status: "passed", exitCode: 0,
        appleShard: appleCIShardDescriptor(role),
        executionState: "exited", privateLog: { availability: "retained" },
        commandOutcome: { observedProcess: "owned-command-supervisor", reason: "exit", exitCode: 0,
          signal: "none", cleanupFailure: null },
        execution: { source: plan.source, startedAt: evidence.startedAt, completedAt: evidence.completedAt },
        appleEvidence: evidence }] };
  });
  const envelopes = reports.map((report) => ciReportEnvelope(report, context, `tooling-${report.checks[0].toolingShard.id}`));
  envelopes.push(ciReportEnvelope(macos, context, "macos"));
  const collect = (reports, upstream = new Map([["tooling", "success"], ["macos", "success"], ["apple", "success"]])) =>
    collectCIReports(selected, context, [...envelopes, ...reports.map((report) =>
      ciReportEnvelope(report, context, `apple-${report.checks[1].appleShard.role}`))], upstream);
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
    edit(invalid[0].checks[1].appleEvidence);
    assert.throws(() => collect(invalid));
  }
  assert.throws(() => collect(apple, new Map([["tooling", "success"], ["macos", "success"], ["apple", "skipped"]])));
  assert.throws(() => collect(apple.slice(1)));
  assert.equal(gate.report.checks.find((check) => check.id === "apple-native").appleEvidence.nativeAcceptanceRequired, true);
});

test("hosted role selection defers only the declared Mac pixel case and retains complete native catalogues", () => {
  for (const role of APPLE_CI_ROLES) {
    const evidence = evidenceFixture(2, role);
    assert.equal(validateAppleNativeEvidence(evidence, plan), evidence);
    assert.equal(evidence.tests.length, 1);
    assert.equal(evidence.tests[0].role, role);
    const item = evidence.tests[0], expected = normalizeAppleTestCatalog(item.catalog.data, evidence.scheme.targets);
    const selection = appleCITestSelection(item.catalog.data, evidence.scheme.targets, role);
    assert.deepEqual(selection.deferred, appleCIDeferredTests(role));
    assert.equal(selection.deferred.length, role === "mac" ? 1 : 0);
    assert.equal(item.result.cases.length + selection.deferred.length, expected.length);
    assert.equal(item.summary.skippedTests, 0);
    assert.equal(evidence.nativeAcceptanceRequired, true);
  }
  const mac = evidenceFixture(2, "mac");
  mac.tests[0].catalog.data.values[0].enabledTests =
    mac.tests[0].catalog.data.values[0].enabledTests.filter((test) => !test.identifier.includes("RendersChartPixels"));
  assert.throws(() => validateAppleNativeEvidence(mac, plan));
});

test("Apple matrix aggregation requires every role and preserves each real execution origin", () => {
  const selected = { ...plan, version: 6, layouts: false, requiredChecks: ["apple-native"], requiredGroups: ["apple"] };
  const reports = APPLE_CI_ROLES.map((role) => {
    const evidence = evidenceFixture(4, role);
    return { ...selected, group: "apple", status: "partial", complete: false, checks: [{
      id: "apple-native", status: "passed", exitCode: 0, appleShard: appleCIShardDescriptor(role),
      executionState: "exited", privateLog: { availability: "retained" },
      commandOutcome: { observedProcess: "owned-command-supervisor", reason: "exit", exitCode: 0,
        signal: "none", cleanupFailure: null },
      execution: { source: plan.source, startedAt: evidence.startedAt, completedAt: evidence.completedAt },
      appleEvidence: evidence,
    }] };
  });
  for (const report of reports) {
    assert.equal(requireAppleShardReport(selected, report).length, 1);
    assert.throws(() => combineVerification(selected, [report]));
  }
  const aggregate = combineVerification(selected, reports), check = aggregate.checks[0];
  assert.equal(aggregate.complete, true);
  assert.equal(check.execution.kind, "apple-shards");
  assert.deepEqual(check.execution.parts.map((part) => part.shard.role), APPLE_CI_ROLES);
  assert.equal(check.appleEvidence.kind, "apple-native-matrix");
  assert.equal(check.appleEvidence.nativeAcceptanceRequired, true);
  assert.deepEqual(combineVerification(selected, [aggregate]), aggregate);
  assert.throws(() => combineVerification(selected, reports.slice(1)));
  assert.throws(() => combineVerification(selected, [...reports, reports[0]]));
  for (const change of [
    (value) => { value[0].status = "passed"; value[0].complete = true; },
    (value) => { delete value[0].checks[0].appleShard; },
    (value) => { value[0].checks[0].commandOutcome.cleanupFailure = "unconfirmed"; },
    (value) => { value[0].checks[0].execution.source = { ...plan.source, head: "9".repeat(40) }; },
    (value) => { value[0].checks[0].appleEvidence.ci.runId = "999"; },
    (value) => { value[0].checks[0].appleEvidence.deferredTests = []; },
    (value) => { value[0].checks[0].appleEvidence.commands.find((item) => item.id === "test-mac").args.push("-skip-testing:DevPocketUITests"); },
  ]) {
    const invalid = structuredClone(reports);
    change(invalid);
    assert.throws(() => combineVerification(selected, invalid));
  }
  for (const change of [
    (value) => { value.checks[0].appleEvidence.nativeAcceptanceRequired = false; },
    (value) => { value.checks[0].execution.parts.reverse(); },
    (value) => { value.checks[0].appleEvidence.parts.pop(); },
  ]) {
    const invalid = structuredClone(aggregate);
    change(invalid);
    assert.throws(() => combineVerification(selected, [invalid]));
  }
});

test("role-owned evidence stays bounded without increasing the native or outer publication limits", () => {
  const parts = APPLE_CI_ROLES.map((role) => evidenceFixture(48, role));
  for (const part of parts) assert.ok(Buffer.byteLength(appleJSON(part)) <= APPLE_NATIVE_REPORT_MAX_BYTES);
  const matrix = combineAppleCIEvidence(plan, parts);
  assert.ok(Buffer.byteLength(appleJSON({ version: 6, appleEvidence: matrix })) <= 512 * 1024);
  assert.equal(validateAppleNativeEvidence(matrix, plan), matrix);
  const invalid = structuredClone(matrix);
  invalid.parts[0].unexpectedPayload = "x".repeat(APPLE_NATIVE_REPORT_MAX_BYTES);
  assert.throws(() => validateAppleNativeEvidence(invalid, plan));
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

function localEvidenceFixture(modelCases = 2) {
  const report = evidenceFixture(modelCases);
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
  return report;
}

test("the shared outcome schema accepts distinct original-client receipt envelopes", () => {
  const report = localEvidenceFixture();
  assert.equal(validateAppleNativeEvidence(report, plan, "local-xcode-mcp"), report);
  report.tests[0].execution.tool = "xcode/RunSomeTests";
  assert.throws(() => validateAppleNativeEvidence(report, plan, "local-xcode-mcp"), /original invocation/);
});

function batchedEvidenceFixture(modelCases = 2) {
  const report = localEvidenceFixture(modelCases);
  const reference = (file) => ({ path: `${report.directory}/${file}`, sha256: appleDigest(`Synthetic ${file}`) });
  report.plan = reference("plan.json");
  report.tests = report.tests.map((item) => {
    const selected = item.result.cases.map((test) => ({ targetName: test.target, testIdentifier: test.identifier }));
    const directory = `${report.directory}/catalog-${item.role}`;
    const catalog = { version: 2, kind: "local-apple-catalog", status: "enumerated", base: report.base,
      source: report.source, target: item.target, plan: report.plan, directory,
      request: reference(`catalog-${item.role}/request.json`), enumeration: reference(`catalog-${item.role}/enumeration.json`),
      data: { errors: [], values: [{ testPlan: "DevPocket", disabledTests: [],
        enabledTests: selected.map((test) => ({ identifier: `${test.targetName}/${test.testIdentifier}` })) }] },
      execution: { id: `catalog-${item.role}`, kind: "owned-command", origin: "local-xcode-enumeration",
        cwd: report.workspace, file: "/synthetic/bin/xcrun", args: appleEnumerationArguments(report.workspace, directory, item.target),
        startedAt: report.startedAt, completedAt: report.startedAt, status: "passed", cleanup: "completed",
        outcome: { observedProcess: "owned-command-supervisor", reason: "exit", exitCode: 0, signal: "none",
          outputTruncated: false, cleanupFailure: null },
        ...Object.fromEntries(["request", "response", "stdout", "stderr"].map((key) =>
          [key, reference(`catalog-${item.role}/${key}.json`)])) } };
    const batches = [];
    for (let offset = 0; offset < selected.length; offset += 20) {
      const tests = selected.slice(offset, offset + 20), id = `${item.execution.toolCallId}-${offset}`;
      const execution = { ...item.execution, tool: "xcode/RunSomeTests", toolCallId: id,
        startedAt: new Date(Date.parse(item.execution.startedAt) + offset).toISOString(),
        completedAt: new Date(Date.parse(item.execution.startedAt) + offset + 1).toISOString() };
      const summary = structuredClone(item.summary);
      summary.totalTestCount = summary.passedTests = summary.devicesAndConfigurations[0].passedTests = tests.length;
      summary.startTime = Date.parse(execution.startedAt) / 1000;
      summary.finishTime = Date.parse(execution.completedAt) / 1000;
      const testTree = { devices: item.testTree.devices, testNodes: [{ nodeType: "Test Plan", children:
        [...new Set(tests.map((test) => test.targetName))].map((target) => ({
          nodeType: target === "DevPocketTests" ? "Unit test bundle" : "UI test bundle", name: target,
          children: tests.filter((test) => test.targetName === target).map((test) =>
            ({ nodeType: "Test Case", nodeIdentifier: test.testIdentifier, result: "Passed" })),
        })) }] };
      batches.push({ action: "test", status: "passed", execution, selected: tests, summary, testTree,
        originalResultBundle: `/synthetic/produced/${id}.xcresult`,
        resultBundle: treeFixture(`${report.directory}/${id}.xcresult`, id, ["Info.plist", "Data/fixture"]),
        result: normalizeAppleBatchResult(summary, testTree, item.target, execution, tests) });
    }
    return { role: item.role, target: item.target, action: "test", status: "passed", mode: "batches", catalog, batches };
  });
  return report;
}

test("complete batches join the existing Apple outcome contract without a fabricated full-suite call", () => {
  const report = batchedEvidenceFixture(37);
  assert.equal(validateAppleNativeEvidence(report, plan, "local-xcode-mcp"), report);
  assert.ok(report.tests.every((item) => item.batches.length === 2 && item.execution === undefined));
  assert.ok(Buffer.byteLength(appleJSON(report)) < APPLE_NATIVE_REPORT_MAX_BYTES);
  assert.throws(() => validateAppleNativeEvidence(report, plan), /origin/);
  assert.throws(() => validateAppleNativeEvidence({ ...report, origin: "ci-xcodebuild" }, plan));
});

test("batch qualification rejects omitted, repeated, foreign, cancelled, stale and unbound evidence", () => {
  for (const edit of [
    (value) => { value.tests.pop(); },
    (value) => { value.tests[0].batches.pop(); },
    (value) => { value.tests[0].batches.push(value.tests[0].batches[0]); },
    (value) => { value.tests[0].catalog.source = { ...value.source, fingerprint: "f".repeat(64) }; },
    (value) => { value.tests[0].catalog.target = value.tests[1].target; },
    (value) => { value.tests[0].catalog.plan = { ...value.plan, sha256: "f".repeat(64) }; },
    (value) => { value.tests[0].catalog.data.errors.push("Test discovery did not finish"); },
    (value) => { value.tests[0].catalog.execution.args[value.tests[0].catalog.execution.args.length - 1] = "test-without-building"; },
    (value) => { value.tests[0].catalog.execution.args.push("-only-testing:DevPocketUITests"); },
    (value) => { value.tests[0].catalog.execution.cleanup = "unknown"; },
    (value) => { value.tests[0].catalog.execution.outcome.reason = "timeout"; },
    (value) => { delete value.tests[0].catalog.execution.request; },
    (value) => { value.tests[0].batches[0].execution.tool = "xcode/RunAllTests"; },
    (value) => { value.tests[0].batches[0].execution.evidence = []; },
    (value) => { value.tests[0].batches[1].execution.toolCallId = value.tests[0].batches[0].execution.toolCallId; },
    (value) => { value.tests[0].batches[1].execution.startedAt = value.tests[0].batches[0].execution.startedAt; },
    (value) => { value.tests[0].batches[1].originalResultBundle = value.tests[0].batches[0].originalResultBundle; },
    (value) => { value.tests[0].batches[0].selected[0].testIdentifier = "Unknown/notInCatalog()"; },
    (value) => { value.tests[0].batches[0].summary.skippedTests = 1; },
    (value) => { value.tests[0].batches[0].summary.expectedFailures = 1; },
    (value) => { value.tests[0].batches[0].summary.result = "Cancelled"; },
    (value) => { value.tests[0].batches[0].summary.devicesAndConfigurations[0].device.deviceId = uuid(99); },
    (value) => { value.tests[0].batches[0].testTree.testNodes[0].children[0].children[0].result = "Not Run"; },
    (value) => { value.tests[0].batches[0].testTree.testNodes[0].children[0].children[0].result = "Failed"; },
    (value) => { value.tests[0].batches[0].summary.startTime -= 30; },
    (value) => { value.tests[0].target.osVersion = "27.0.2"; },
    (value) => { value.builds[0].action = "build-for-testing"; },
    (value) => { value.sourceAfter = { ...value.source, fingerprint: "f".repeat(64) }; },
  ]) {
    const report = batchedEvidenceFixture(21);
    edit(report);
    assert.throws(() => validateAppleNativeEvidence(report, plan, "local-xcode-mcp"));
  }
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
