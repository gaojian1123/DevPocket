import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";

const freeze = (value) => {
  if (value && typeof value === "object") Object.values(value).forEach(freeze);
  return Object.freeze(value);
};

export const APPLE_REQUIREMENTS = freeze({
  project: "apple/DevPocket/DevPocket.xcodeproj",
  scheme: "DevPocket",
  xcodeMinimum: "27.1",
  iosSDKMinimum: "27.1",
  macOSMinimum: "27.0",
  targets: [
    { role: "mac", platform: "macOS", osMinimum: "27.0" },
    { role: "iphone", platform: "iOS Simulator", runtimeVersion: "27.0", deviceTypeName: "iPhone 18 Pro" },
    { role: "ipad", platform: "iOS Simulator", runtimeVersion: "27.0", deviceTypeName: "iPad Pro 11-inch (M5)" },
    { role: "duo", platform: "iOS Simulator", runtimeVersion: "27.1", deviceTypeName: "iPhone Duo" },
  ],
});

export const APPLE_PROBES = freeze([
  { id: "xcode", file: "/usr/bin/xcrun", args: ["xcodebuild", "-version"] },
  { id: "xcode-path", file: "/usr/bin/xcrun", args: ["--find", "xcodebuild"] },
  { id: "ios-sdk", file: "/usr/bin/xcrun", args: ["--sdk", "iphoneos", "--show-sdk-version"] },
  { id: "simulator-sdk", file: "/usr/bin/xcrun", args: ["--sdk", "iphonesimulator", "--show-sdk-version"] },
  { id: "macos-sdk", file: "/usr/bin/xcrun", args: ["--sdk", "macosx", "--show-sdk-version"] },
  { id: "macos", file: "/usr/bin/sw_vers", args: ["-productVersion"] },
  { id: "architecture", file: "/usr/bin/uname", args: ["-m"] },
  { id: "swift", file: "/usr/bin/xcrun", args: ["swift", "-version"] },
  { id: "simulators", file: "/usr/bin/xcrun", args: ["simctl", "list", "--json"] },
]);

// Leave room for the enclosing verification report within its existing 512-KiB limit.
export const APPLE_NATIVE_REPORT_MAX_BYTES = 256 * 1024;
export const APPLE_RESULT_READINESS_MS = 30_000;

const sha = /^[a-f0-9]{64}$/;
const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const appleDeviceId = (value) => typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const appleDigest = (value) => createHash("sha256").update(value).digest("hex");
export const appleJSON = (value) => JSON.stringify(value) + "\n";
const text = (value) => typeof value === "string" && value.length > 0 && !value.includes("\0");
const timestamp = (value) => text(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const relative = (value) => text(value) && !value.includes("\\") && !value.startsWith("/") &&
  value.split("/").every((part) => part && part !== "." && part !== "..");

export function requireApple(value, message, diagnosticCode = "device-evidence") {
  if (!value) throw Object.assign(new Error(message), { diagnosticCode });
}

const fields = (value, names) => Object.fromEntries(names.filter((name) => Object.hasOwn(value, name))
  .map((name) => [name, value[name]]));

export function projectAppleCleanupEvidence(cleanup) {
  return fields(cleanup, ["beforeCommandId", "afterCommandId"]);
}

function projectSimulatorInventory(value) {
  appleDevices(value);
  const result = { devices: Object.fromEntries(Object.entries(value.devices).map(([runtime, devices]) => [runtime,
    devices.map((device) => fields(device, ["udid", "name", "state", "deviceTypeIdentifier"]))])) };
  if (Object.hasOwn(value, "runtimes") || Object.hasOwn(value, "devicetypes")) {
    requireApple(Array.isArray(value.runtimes) && Array.isArray(value.devicetypes), "Incomplete simulator inventory.", "preflight-sdk");
    const names = APPLE_REQUIREMENTS.targets.map((target) => target.deviceTypeName).filter(Boolean);
    result.devicetypes = value.devicetypes.filter((type) => names.includes(type?.name))
      .map((type) => fields(type, ["name", "identifier"]));
    const identifiers = new Set(result.devicetypes.map((type) => type.identifier));
    result.runtimes = value.runtimes.map((runtime) => {
      const projected = fields(runtime, ["identifier", "version", "isAvailable", "supportedDeviceTypes"]);
      if (Array.isArray(projected.supportedDeviceTypes)) projected.supportedDeviceTypes = projected.supportedDeviceTypes
        .filter((type) => identifiers.has(type?.identifier)).map((type) => ({ identifier: type.identifier }));
      return projected;
    });
  }
  return result;
}

export function projectAppleXcresult(kind, value) {
  requireApple(value && typeof value === "object", "Missing xcresult data.", "case-evidence");
  if (kind === "summary") {
    const result = fields(value, ["result", "failedTests", "skippedTests", "expectedFailures", "passedTests",
      "totalTestCount", "testFailures", "startTime", "finishTime", "devicesAndConfigurations"]);
    // Failure presence/count is validation input; original messages remain in the full xcresult export.
    if (Array.isArray(result.testFailures)) result.testFailures = result.testFailures.map(() => ({}));
    if (Array.isArray(result.devicesAndConfigurations)) result.devicesAndConfigurations = result.devicesAndConfigurations
      .map((configuration) => fields(configuration, ["device", "failedTests", "skippedTests", "expectedFailures", "passedTests"]));
    return result;
  }
  requireApple(kind === "tests" && Array.isArray(value.testNodes), "Missing xcresult test tree.", "case-evidence");
  let visited = 0;
  const node = (value, depth = 0) => {
    requireApple(value && typeof value === "object" && depth <= 30 && ++visited <= 20000,
      "The xcresult test tree is malformed or too large.", "case-evidence");
    const result = fields(value, ["nodeType", "name", "nodeIdentifier", "result", "children"]);
    if (Object.hasOwn(result, "children")) {
      requireApple(Array.isArray(result.children), "Malformed xcresult child nodes.", "case-evidence");
      result.children = result.children.map((child) => node(child, depth + 1));
    }
    return result;
  };
  return { ...fields(value, ["devices"]), testNodes: value.testNodes.map((value) => node(value)) };
}

export function projectAppleCommandOutput(command, stdout, stderr) {
  const result = { version: 1, kind: "logs", stdoutSha256: appleDigest(stdout), stderrSha256: appleDigest(stderr) };
  const { file, args } = command;
  if (file === "/usr/bin/xcrun" && args[0] === "xcodebuild" && args.at(-1) === "build") {
    result.kind = "build";
    result.data = {
      succeeded: [...stdout.matchAll(/^\*\* BUILD SUCCEEDED \*\*[ \t]*\r?$/gm)].length,
      failed: [...`${stdout}\n${stderr}`.matchAll(/\*\* BUILD (?:FAILED|CANCELLED) \*\*/g)].length,
      products: [...new Set([...stdout.matchAll(
        /^[ \t]*(?:CodeSign|Validate) (.+\/DevPocket\.app) \(in target 'DevPocket' from project 'DevPocket'\)[ \t]*\r?$/gm,
      )].map((match) => match[1]))],
    };
  } else if (file === "/usr/bin/xcrun" && equal(args.slice(0, 2), ["simctl", "list"])) {
    result.kind = "simulators";
    const inventory = JSON.parse(stdout);
    result.data = projectSimulatorInventory(args[2] === "devices" ? { devices: inventory.devices } : inventory);
  } else if (file === "/usr/bin/xcrun" && equal(args.slice(0, 3), ["xcresulttool", "get", "test-results"])) {
    requireApple(["summary", "tests"].includes(args[3]), "Unknown xcresult projection.", "case-evidence");
    result.kind = `xcresult-${args[3]}`;
    result.dataSha256 = appleDigest(appleJSON(projectAppleXcresult(args[3], JSON.parse(stdout))));
  } else if (file === "/usr/bin/plutil" && equal(args.slice(0, 4), ["-convert", "json", "-o", "-"]) && args.length === 5) {
    result.kind = "product-info";
    result.data = fields(JSON.parse(stdout), ["CFBundleIdentifier", "MinimumOSVersion", "LSMinimumSystemVersion"]);
  } else if (APPLE_PROBES.some((probe) => probe.file === file && equal(probe.args, args)) ||
      file === "/usr/bin/xcrun" && equal(args.slice(0, 2), ["simctl", "create"])) {
    requireApple(Buffer.byteLength(stdout) <= 8192, "The required Apple probe output is oversized.", "output-limit");
    result.kind = "text";
    result.data = stdout;
  }
  if (Object.hasOwn(result, "data")) result.dataSha256 = appleDigest(appleJSON(result.data));
  return result;
}

function commandProjection(command, kind) {
  const value = command.output;
  requireApple(value?.version === 1 && value.kind === kind &&
    value.stdoutSha256 === command.stdout.sha256 && value.stderrSha256 === command.stderr.sha256 &&
    Object.keys(value).every((key) => ["version", "kind", "stdoutSha256", "stderrSha256", "data", "dataSha256"].includes(key)),
  "Apple output projection is not bound to its original logs.", "artifact-changed");
  if (kind === "logs") {
    requireApple(!Object.hasOwn(value, "data") && !Object.hasOwn(value, "dataSha256"),
      "Verbose command logs must remain separate artifacts.", "artifact-changed");
  } else if (kind.startsWith("xcresult-")) {
    requireApple(!Object.hasOwn(value, "data") && sha.test(value.dataSha256 ?? ""),
      "xcresult projection identity is missing.", "artifact-changed");
  } else {
    requireApple(Object.hasOwn(value, "data") && value.dataSha256 === appleDigest(appleJSON(value.data)),
      "Apple output projection data changed.", "artifact-changed");
    if (kind === "text") requireApple(typeof value.data === "string" && Buffer.byteLength(value.data) <= 8192 &&
      Buffer.byteLength(value.data) === command.stdout.bytes && appleDigest(value.data) === command.stdout.sha256,
    "Apple probe text differs from its original output.", "artifact-changed");
    if (kind === "simulators") requireApple(equal(value.data, projectSimulatorInventory(value.data)),
      "Simulator projection contains unvalidated data.", "artifact-changed");
  }
  return value;
}

export function validateApplePlan(plan) {
  requireApple(commit.test(plan?.base ?? "") && commit.test(plan?.source?.head ?? "") &&
    sha.test(plan?.source?.fingerprint ?? ""), "Apple verification requires an exact base and source.", "source-mismatch");
  requireApple(equal(plan.apple, APPLE_REQUIREMENTS), "Apple requirements differ from the supported plan.", "policy-mismatch");
  return plan;
}

function version(value) {
  requireApple(typeof value === "string" && /^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(value),
    "The Apple tool version is unavailable.", "preflight-version");
  return value.split(".").map(Number);
}

function compareVersions(left, right) {
  const a = version(left), b = version(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export function appleDevices(inventory) {
  requireApple(inventory?.devices && typeof inventory.devices === "object" && !Array.isArray(inventory.devices),
    "Simulator device inventory is incomplete.", "preflight-sdk");
  return Object.entries(inventory.devices).flatMap(([runtimeIdentifier, devices]) => {
    requireApple(Array.isArray(devices), "Simulator device inventory is malformed.", "preflight-sdk");
    return devices.map((device) => {
      requireApple(appleDeviceId(device?.udid) && text(device.name) && text(device.state),
        "Simulator identity is incomplete.", "preflight-sdk");
      return { ...device, runtimeIdentifier };
    });
  });
}

export function selectAppleSimulators(inventory) {
  requireApple(Array.isArray(inventory?.runtimes) && Array.isArray(inventory?.devicetypes),
    "Simulator runtime and device-type inventories are required.", "preflight-sdk");
  appleDevices(inventory);
  return APPLE_REQUIREMENTS.targets.filter((target) => target.role !== "mac").map((target) => {
    const types = inventory.devicetypes.filter((item) => item?.name === target.deviceTypeName);
    requireApple(types.length === 1 && text(types[0].identifier),
      `The exact ${target.deviceTypeName} device type is unavailable or ambiguous.`, "preflight-sdk");
    const deviceType = types[0];
    const runtimes = inventory.runtimes.filter((runtime) =>
      runtime?.isAvailable === true && /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-/.test(runtime.identifier ?? "") &&
      typeof runtime.version === "string" && /^\d+(?:\.\d+){1,3}$/.test(runtime.version) &&
      runtime.version.split(".").slice(0, 2).join(".") === target.runtimeVersion &&
      Array.isArray(runtime.supportedDeviceTypes) &&
      runtime.supportedDeviceTypes.some((item) => item?.identifier === deviceType.identifier));
    runtimes.sort((a, b) => compareVersions(b.version, a.version) || a.identifier.localeCompare(b.identifier));
    requireApple(runtimes.length > 0,
      `An available iOS ${target.runtimeVersion} runtime supporting ${target.deviceTypeName} is required.`, "preflight-sdk");
    return { ...target, runtimeIdentifier: runtimes[0].identifier, osVersion: runtimes[0].version,
      deviceTypeIdentifier: deviceType.identifier };
  });
}

export function selectAppleLocalTargets(inventory, toolchain, requested, requireBooted = false) {
  requireApple(Array.isArray(requested) && requested.length === APPLE_REQUIREMENTS.targets.length &&
    new Set(requested.map((item) => item?.role)).size === requested.length &&
    new Set(requested.map((item) => item?.deviceId)).size === requested.length,
  "Every local Apple role requires its own explicit destination.", "device-evidence");
  const devices = appleDevices(inventory);
  return APPLE_REQUIREMENTS.targets.map((requirement) => {
    const target = requested.find((item) => item?.role === requirement.role);
    requireApple(text(target?.deviceId), "A local Apple destination is missing.", "device-evidence");
    if (requirement.role === "mac") return { role: "mac", platform: "macOS", osVersion: toolchain.macOS,
      architecture: toolchain.architecture, deviceId: target.deviceId };
    const matching = devices.filter((item) => item.udid === target.deviceId), device = matching[0];
    const runtime = inventory.runtimes?.find((item) => item.identifier === device?.runtimeIdentifier);
    const type = inventory.devicetypes?.find((item) => item.identifier === device?.deviceTypeIdentifier);
    requireApple(matching.length === 1 && (!requireBooted || device.state === "Booted") &&
      runtime?.isAvailable === true && runtime.version.split(".").slice(0, 2).join(".") === requirement.runtimeVersion &&
      type?.name === requirement.deviceTypeName &&
      runtime.supportedDeviceTypes?.some((item) => item.identifier === type.identifier),
    "The exact local simulator is unavailable, stopped, or has a different runtime/type.", "device-evidence");
    return { ...requirement, osVersion: runtime.version, runtimeIdentifier: runtime.identifier,
      deviceTypeIdentifier: type.identifier, architecture: toolchain.architecture, deviceId: target.deviceId };
  });
}

export function localAppleToolchain(toolchain, targets) {
  return { ...toolchain, simulators: targets.filter((item) => item.role !== "mac")
    .map(({ architecture: _architecture, deviceId: _deviceId, ...selection }) => selection) };
}

export function inspectAppleToolchain(outputs) {
  const xcode = /^Xcode (\d+(?:\.\d+){1,3})\r?\nBuild version ([^\s]+)\s*$/.exec(outputs.xcode ?? "");
  const swift = /Apple Swift version (\d+(?:\.\d+){1,3})\b/.exec(outputs.swift ?? "");
  const executable = outputs["xcode-path"]?.trim();
  requireApple(xcode && swift && text(executable) && executable.startsWith("/") &&
    executable.endsWith("/Contents/Developer/usr/bin/xcodebuild"),
  "The selected Xcode and Swift toolchain could not be identified.", "preflight-version");
  const toolchain = {
    xcode: { version: xcode[1], build: xcode[2], executable },
    swift: { version: swift[1] },
    iosSDK: outputs["ios-sdk"]?.trim(),
    simulatorSDK: outputs["simulator-sdk"]?.trim(),
    macOSSDK: outputs["macos-sdk"]?.trim(),
    macOS: outputs.macos?.trim(),
    architecture: outputs.architecture?.trim(),
  };
  for (const [actual, minimum, label] of [
    [toolchain.xcode.version, APPLE_REQUIREMENTS.xcodeMinimum, "Xcode"],
    [toolchain.iosSDK, APPLE_REQUIREMENTS.iosSDKMinimum, "iOS SDK"],
    [toolchain.simulatorSDK, APPLE_REQUIREMENTS.iosSDKMinimum, "iOS Simulator SDK"],
    [toolchain.macOSSDK, APPLE_REQUIREMENTS.macOSMinimum, "macOS SDK"],
    [toolchain.macOS, APPLE_REQUIREMENTS.macOSMinimum, "macOS host"],
  ]) requireApple(compareVersions(actual, minimum) >= 0, `${label} ${minimum} or newer is required.`, "preflight-version");
  requireApple(["arm64", "x86_64"].includes(toolchain.architecture), "Unknown native Mac architecture.", "preflight-version");
  let inventory;
  try { inventory = JSON.parse(outputs.simulators); }
  catch { requireApple(false, "Simulator inventory is not JSON.", "preflight-sdk"); }
  return { ...toolchain, simulators: selectAppleSimulators(inventory) };
}

export function inspectAppleScheme(xml) {
  requireApple(text(xml) && xml.length < 512 * 1024, "The shared Apple scheme is missing.", "preflight-path");
  const actions = [...xml.matchAll(/<TestAction\b([^>]*)>([\s\S]*?)<\/TestAction>/g)];
  const attribute = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1];
  requireApple(actions.length === 1 && attribute(actions[0][1], "buildConfiguration") === "Debug" &&
    !/<(?:TestPlans|TestPlanReference|SelectedTests|SkippedTests)\b/.test(actions[0][2]),
  "The full inline Debug TestAction is required; test plans and test filters are unsupported.", "preflight-path");
  const testables = [...actions[0][2].matchAll(/<TestableReference\b([^>]*)>([\s\S]*?)<\/TestableReference>/g)];
  const targets = testables.map(([, attributes, body]) => {
    requireApple(attribute(attributes, "skipped") === "NO" && attribute(attributes, "parallelizable") === "NO",
      "Every scheme test target must be enabled and nonparallel.", "preflight-path");
    const references = [...body.matchAll(/<BuildableReference\b([^>]*)\/?>/g)];
    requireApple(references.length === 1, "The scheme test target is ambiguous.", "preflight-path");
    const target = attribute(references[0][1], "BlueprintName");
    requireApple(text(target) && attribute(references[0][1], "BuildableName") === `${target}.xctest`,
      "The scheme test bundle could not be identified.", "preflight-path");
    return target;
  });
  requireApple(new Set(targets).size === targets.length &&
    ["DevPocketTests", "DevPocketUITests"].every((target) => targets.includes(target)),
  "Both the model/WK and UI test targets must be enabled.", "preflight-path");
  return targets;
}

export function appleXcodeArguments({ workspace, directory, action, platform, destination, testDiagnostics }) {
  requireApple(["build", "test"].includes(action) && ["ios", "macos"].includes(platform) &&
    text(destination) && relative(directory) &&
    (testDiagnostics === undefined || action === "test" && testDiagnostics === "never"),
  "Invalid Apple build/test arguments.", "configuration");
  return ["xcodebuild", "-project", path.posix.join(workspace, APPLE_REQUIREMENTS.project),
    "-scheme", APPLE_REQUIREMENTS.scheme, "-configuration", "Debug",
    "-sdk", platform === "ios" ? "iphonesimulator" : "macosx",
    "-destination", destination, "-destination-timeout", "120",
    "-derivedDataPath", path.posix.join(workspace, directory, "derived"),
    "-resultBundlePath", path.posix.join(workspace, directory, "result.xcresult"),
    "-disableAutomaticPackageResolution", "-onlyUsePackageVersionsFromResolvedFile", "-skipPackageUpdates",
    ...(action === "test" ? ["-parallel-testing-enabled", "NO", "-test-timeouts-enabled", "YES",
      "-default-test-execution-time-allowance", "120", "-maximum-test-execution-time-allowance", "300"] : []),
    ...(testDiagnostics === "never" ? ["-collect-test-diagnostics", "never"] : []),
    "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_REQUIRED=YES", "DEVELOPMENT_TEAM=", action];
}

export function appleEnumerationArguments(workspace, directory, target) {
  requireApple(relative(directory) && text(workspace) && workspace.startsWith("/") &&
    APPLE_REQUIREMENTS.targets.some((item) => item.role === target?.role && item.platform === target.platform) &&
    /^[A-Za-z0-9-]{1,128}$/.test(target.deviceId ?? ""),
  "A catalogue requires an exact Apple destination.", "configuration");
  return ["xcodebuild", "-project", path.posix.join(workspace, APPLE_REQUIREMENTS.project),
    "-scheme", APPLE_REQUIREMENTS.scheme, "-configuration", "Debug",
    "-sdk", target.role === "mac" ? "macosx" : "iphonesimulator",
    "-destination", `platform=${target.platform},id=${target.deviceId}`,
    "-derivedDataPath", path.posix.join(workspace, directory, "derived"),
    "-disableAutomaticPackageResolution", "-onlyUsePackageVersionsFromResolvedFile", "-skipPackageUpdates",
    "-parallel-testing-enabled", "NO", "-enumerate-tests", "-test-enumeration-style", "flat",
    "-test-enumeration-format", "json", "-test-enumeration-output-path", path.posix.join(workspace, directory, "enumeration.json"),
    "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_REQUIRED=YES", "DEVELOPMENT_TEAM=", "test"];
}

const testKey = (item) => `${item.targetName}/${item.testIdentifier}`;

export function appleTestSelection(tests) {
  requireApple(Array.isArray(tests) && tests.length > 0 && tests.length <= 10000 &&
    tests.every((item) => text(item?.targetName) && !item.targetName.includes("/") &&
      text(item.testIdentifier) && !/[\r\n*]/.test(item.testIdentifier) &&
      Object.keys(item).every((key) => ["targetName", "testIdentifier"].includes(key))) &&
    new Set(tests.map(testKey)).size === tests.length,
  "Native test selectors must be explicit, nonempty and unique.", "case-evidence");
  return [...tests].sort((a, b) => testKey(a).localeCompare(testKey(b)));
}

export function normalizeAppleTestCatalog(data, targets) {
  const value = data?.values?.[0];
  requireApple(Array.isArray(data?.errors) && data.errors.length === 0 &&
    Array.isArray(data.values) && data.values.length === 1 && text(value?.testPlan) &&
    Array.isArray(value.enabledTests) && value.enabledTests.length > 0 &&
    Array.isArray(value.disabledTests) && value.disabledTests.length === 0 &&
    data.truncated !== true && value.truncated !== true,
  "A complete native enumeration with no errors or disabled tests is required.", "discovery");
  const tests = appleTestSelection(value.enabledTests.map((item) => {
    requireApple(text(item?.identifier) && item.identifier.indexOf("/") > 0,
      "A native catalogue entry has no target-qualified identifier.", "discovery");
    const slash = item.identifier.indexOf("/");
    return { targetName: item.identifier.slice(0, slash), testIdentifier: item.identifier.slice(slash + 1) };
  }));
  requireApple(Array.isArray(targets) && targets.length >= 2 &&
    targets.every((target) => tests.some((item) => item.targetName === target)) &&
    tests.every((item) => targets.includes(item.targetName)),
  "The native catalogue must cover exactly the enabled scheme targets.", "discovery");
  return tests;
}

function testCases(nodes) {
  requireApple(Array.isArray(nodes), "The xcresult test tree is missing.", "case-evidence");
  const cases = [];
  let visited = 0;
  const visit = (node, target, depth) => {
    requireApple(node && typeof node === "object" && depth <= 30 && ++visited <= 20000,
      "The xcresult test tree is malformed or too large.", "case-evidence");
    if (typeof node.nodeType === "string" && /^(?:Unit|UI) test bundle$/i.test(node.nodeType)) {
      requireApple(text(node.name), "An xcresult test bundle has no name.", "case-evidence");
      target = node.name.replace(/\.xctest$/, "");
    }
    if (node.nodeType === "Test Case") {
      requireApple(text(target) && text(node.nodeIdentifier) && node.result === "Passed",
        "A native test is unbound, failed, skipped or incomplete.", "case-evidence");
      cases.push({ target, identifier: node.nodeIdentifier, result: node.result });
    }
    if (node.children !== undefined) {
      requireApple(Array.isArray(node.children), "Invalid xcresult child nodes.", "case-evidence");
      node.children.forEach((child) => visit(child, target, depth + 1));
    }
  };
  nodes.forEach((node) => visit(node, undefined, 0));
  return cases;
}

export function appleTestInterval(summary, execution) {
  // xcresult may report whole-second timestamps.
  requireApple(Number.isFinite(summary?.startTime) && Number.isFinite(summary?.finishTime) &&
    timestamp(execution?.startedAt) && timestamp(execution?.completedAt) &&
    execution.completedAt >= execution.startedAt && summary.finishTime >= summary.startTime &&
    summary.startTime * 1000 >= Date.parse(execution.startedAt) - 1000 &&
    summary.finishTime * 1000 <= Date.parse(execution.completedAt) + 1000,
  "The xcresult is outside its producing test invocation.", "execution-origin");
  return { startedAt: new Date(summary.startTime * 1000).toISOString(),
    completedAt: new Date(summary.finishTime * 1000).toISOString() };
}

// This normalized result is reusable by an original-client MCP adapter; it contains no invented command receipt.
function nativeTestResult(summary, tests, target, execution, requiredTargets) {
  const cases = testCases(tests?.testNodes), configuration = summary?.devicesAndConfigurations?.[0];
  const device = configuration?.device;
  requireApple(summary?.result === "Passed" && summary.failedTests === 0 && summary.skippedTests === 0 &&
    summary.expectedFailures === 0 && Array.isArray(summary.testFailures) && summary.testFailures.length === 0 &&
    Array.isArray(summary.devicesAndConfigurations) && summary.devicesAndConfigurations.length === 1 &&
    Array.isArray(tests.devices) && tests.devices.length === 1 && equal(device, tests.devices[0]) &&
    text(device?.deviceId) && device.platform === target.platform && device.osVersion === target.osVersion &&
    device.architecture === target.architecture && (!target.deviceId || device.deviceId === target.deviceId) &&
    configuration.failedTests === 0 && configuration.skippedTests === 0 && configuration.expectedFailures === 0 &&
    cases.length > 0 && summary.totalTestCount === cases.length && summary.passedTests === cases.length &&
    configuration.passedTests === cases.length &&
    new Set(cases.map((item) => `${item.target}/${item.identifier}`)).size === cases.length &&
    Array.isArray(requiredTargets) && requiredTargets.length > 0 &&
    requiredTargets.every((name) => cases.some((item) => item.target === name)),
  "The complete native test outcome, target coverage or destination does not match.", "case-evidence");
  return { device, cases, ...appleTestInterval(summary, execution) };
}

export function normalizeAppleTestResult(summary, tests, target, execution, requiredTargets) {
  requireApple(Array.isArray(requiredTargets) && requiredTargets.length >= 2,
    "Full Apple tests require model/WK and UI targets.", "case-evidence");
  return nativeTestResult(summary, tests, target, execution, requiredTargets);
}

export function normalizeAppleBatchResult(summary, tests, target, execution, selected) {
  selected = appleTestSelection(selected);
  const result = nativeTestResult(summary, tests, target, execution, [...new Set(selected.map((item) => item.targetName))]);
  requireApple(equal(appleTestSelection(result.cases.map((item) =>
    ({ targetName: item.target, testIdentifier: item.identifier }))), selected),
  "A batch's actual native cases differ from its request filters.", "case-evidence");
  return result;
}

function inside(directory, file) {
  return relative(file) && file.startsWith(directory + "/");
}

function fileReference(value, directory) {
  requireApple(value && inside(directory, value.path) && sha.test(value.sha256 ?? "") &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 0, "Invalid Apple artifact identity.", "artifact-changed");
}

function treeReference(value, expectedPath, commandId, requiredFiles, externalManifest = false) {
  if (externalManifest && value?.fileManifest) {
    const directory = path.posix.dirname(expectedPath);
    fileReference(value.fileManifest, directory);
    requireApple(value.path === expectedPath && value.producedBy === commandId &&
      value.fileManifest.path === `${directory}/result-files.json` && value.fileManifest.sha256 === value.sha256 &&
      value.fileManifest.bytes > 0 && value.fileManifest.bytes <= 16 * 1024 * 1024 &&
      Object.keys(value.fileManifest).every((key) => ["path", "bytes", "sha256"].includes(key)) &&
      Number.isSafeInteger(value.fileCount) && value.fileCount > 0 && value.fileCount <= 20000 &&
      sha.test(value.infoSha256 ?? "") && equal(requiredFiles, ["Info.plist"]) &&
      Object.keys(value).every((key) => ["path", "producedBy", "sha256", "fileManifest", "fileCount", "infoSha256"].includes(key)),
    "The native result must retain its complete external file manifest.", "artifact-changed");
    return;
  }
  requireApple(value?.path === expectedPath && value.producedBy === commandId &&
    Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 20000 &&
    new Set(value.files.map((entry) => entry.path)).size === value.files.length &&
    value.files.every((entry) => relative(entry.path) && sha.test(entry.sha256 ?? "") &&
      Number.isSafeInteger(entry.bytes) && entry.bytes >= 0) &&
    requiredFiles.every((name) => value.files.some((entry) => entry.path === name)) &&
    value.sha256 === appleDigest(appleJSON(value.files)),
  "An original Apple product or result bundle is missing or unbound.", "artifact-changed");
}

export function appleResultManifestReference(manifest, fileManifest) {
  treeReference(manifest, manifest?.path, manifest?.producedBy, ["Info.plist"]);
  const value = { path: manifest.path, producedBy: manifest.producedBy, sha256: manifest.sha256,
    fileManifest, fileCount: manifest.files.length,
    infoSha256: manifest.files.find((file) => file.path === "Info.plist").sha256 };
  treeReference(value, manifest.path, manifest.producedBy, ["Info.plist"], true);
  return value;
}

function copiedTreeReference(value, expectedPath, original) {
  requireApple(value?.path === expectedPath && value.producedBy === original.producedBy &&
    value.sha256 === original.sha256 && Object.keys(value).every((key) => ["path", "producedBy", "sha256"].includes(key)),
  "The retained native copy is not bound to the original complete file manifest.", "artifact-changed");
}

function sharedAppleOutcomes(evidence) {
  const toolchain = evidence.toolchain;
  requireApple(toolchain && text(toolchain.xcode?.build) && text(toolchain.xcode?.executable) &&
    text(toolchain.swift?.version) && ["arm64", "x86_64"].includes(toolchain.architecture),
  "Native Apple toolchain identity is incomplete.", "preflight-version");
  version(toolchain.swift.version);
  for (const [actual, minimum] of [
    [toolchain.xcode.version, APPLE_REQUIREMENTS.xcodeMinimum],
    [toolchain.iosSDK, APPLE_REQUIREMENTS.iosSDKMinimum], [toolchain.simulatorSDK, APPLE_REQUIREMENTS.iosSDKMinimum],
    [toolchain.macOSSDK, APPLE_REQUIREMENTS.macOSMinimum], [toolchain.macOS, APPLE_REQUIREMENTS.macOSMinimum],
  ]) requireApple(compareVersions(actual, minimum) >= 0, "An Apple toolchain minimum is not met.", "preflight-version");
  requireApple(evidence.scheme?.path === `${APPLE_REQUIREMENTS.project}/xcshareddata/xcschemes/DevPocket.xcscheme` &&
    evidence.scheme.sha256 === appleDigest(evidence.scheme.xml) &&
    equal(evidence.scheme.targets, inspectAppleScheme(evidence.scheme.xml)),
  "The shared scheme evidence is incomplete.", "case-evidence");
  requireApple(Array.isArray(toolchain.simulators) && toolchain.simulators.length === 3 &&
    Array.isArray(evidence.builds) && evidence.builds.length === 2 &&
    Array.isArray(evidence.tests) && evidence.tests.length === 4,
  "Required Apple native outcomes are missing.", "shard-missing");
  const ids = new Set(), resultPaths = new Set(), originalPaths = new Set();
  const invocation = (item, action, tool = action === "build" ? "BuildProject" : "RunAllTests") => {
    const value = item?.execution, command = evidence.origin !== "local-xcode-mcp";
    const id = command ? value?.commandId : value?.toolCallId;
    requireApple(item?.status === "passed" && item.action === action && value?.origin === evidence.origin &&
      text(id) && !ids.has(id) && value.workspace === path.posix.join(evidence.workspace, APPLE_REQUIREMENTS.project) &&
      timestamp(value.startedAt) && timestamp(value.completedAt) && value.startedAt >= evidence.startedAt &&
      value.completedAt >= value.startedAt && value.completedAt <= evidence.completedAt &&
      (command ? value.kind === "owned-command" && item.commandId === id : value.kind === "original-client-tool-call" &&
        value.tool === `xcode/${tool}`),
    "A native outcome has no unique, completed original invocation.", "execution-origin");
    if (!command) {
      requireApple(Array.isArray(value.evidence) && value.evidence.length >= 2 &&
        value.evidence.every((reference) => inside(evidence.directory, reference?.path) && sha.test(reference.sha256 ?? "")),
      "Original-client invocation receipts are missing.", "execution-origin");
    }
    ids.add(id);
    return id;
  };
  for (const platform of ["ios", "macos"]) {
    const matches = evidence.builds.filter((item) => item.platform === platform);
    requireApple(matches.length === 1, "A normal Apple build is missing or duplicated.", "shard-missing");
    const build = matches[0], id = invocation(build, "build");
    requireApple(inside(evidence.directory, build.product?.path) && build.product.path.endsWith("/DevPocket.app") &&
      text(build.originalProduct) && build.originalProduct.startsWith("/") && build.originalProduct.endsWith("/DevPocket.app"),
    "The original normal-build product is unbound.", "artifact-changed");
    treeReference(build.product, build.product.path, id, platform === "ios"
      ? ["Info.plist", "DevPocket"] : ["Contents/Info.plist", "Contents/MacOS/DevPocket"]);
  }
  const deviceIds = new Set();
  for (const requirement of APPLE_REQUIREMENTS.targets) {
    const matches = evidence.tests.filter((item) => item.role === requirement.role);
    requireApple(matches.length === 1, "A native Apple role is missing or duplicated.", "shard-missing");
    const item = matches[0], target = item.target;
    // MCP captures normal products last because build-for-testing can modify them.
    requireApple(target?.role === requirement.role && target.platform === requirement.platform &&
      target.architecture === toolchain.architecture && text(target.deviceId) && !deviceIds.has(target.deviceId) &&
      (evidence.origin === "local-xcode-mcp" || evidence.builds.every((build) => item.execution?.startedAt >= build.execution.completedAt)),
    "The native target or execution interval is invalid.", "case-evidence");
    deviceIds.add(target.deviceId);
    if (requirement.role === "mac") {
      requireApple(target.osVersion === toolchain.macOS, "The native Mac does not match the host.", "case-evidence");
    } else {
      const selections = toolchain.simulators.filter((selection) => selection.role === requirement.role);
      requireApple(selections.length === 1, "The required simulator role is missing.", "case-evidence");
      const selection = selections[0];
      requireApple(appleDeviceId(target.deviceId) && target.osVersion === selection.osVersion &&
        version(target.osVersion).slice(0, 2).join(".") === requirement.runtimeVersion &&
        selection.deviceTypeName === requirement.deviceTypeName && target.deviceTypeName === requirement.deviceTypeName &&
        text(selection.runtimeIdentifier) && target.runtimeIdentifier === selection.runtimeIdentifier &&
        text(selection.deviceTypeIdentifier) && target.deviceTypeIdentifier === selection.deviceTypeIdentifier,
      "A simulator runtime or device type was substituted.", "case-evidence");
    }
    const outcome = (test, selected) => {
      const id = invocation(test, "test", selected ? "RunSomeTests" : "RunAllTests");
      requireApple(inside(evidence.directory, test.resultBundle?.path) && test.resultBundle.path.endsWith(".xcresult") &&
        !resultPaths.has(test.resultBundle.path), "The original native test result bundle is missing or reused.", "artifact-changed");
      resultPaths.add(test.resultBundle.path);
      treeReference(test.resultBundle, test.resultBundle.path, id, ["Info.plist"],
        evidence.origin === "ci-xcodebuild" || evidence.origin === "local-xcodebuild");
      const result = selected
        ? normalizeAppleBatchResult(test.summary, test.testTree, target, test.execution, selected)
        : normalizeAppleTestResult(test.summary, test.testTree, target, test.execution, evidence.scheme.targets);
      requireApple(equal(test.result, result), "Native results differ from their xcresult projections.", "case-evidence");
    };
    if (item.mode === "batches") {
      requireApple(evidence.origin === "local-xcode-mcp" && item.status === "passed" && item.action === "test" &&
        !item.execution && !item.result && !item.summary && !item.testTree && !item.resultBundle &&
        Array.isArray(item.batches) && item.batches.length > 0,
      "Batched Apple evidence requires its individual original-client invocations.", "execution-origin");
      const catalog = item.catalog;
      validateAppleBatchCatalog(catalog, evidence, target);
      requireApple(!ids.has(catalog.execution.id), "A catalogue invocation was reused.", "execution-origin");
      ids.add(catalog.execution.id);
      const expected = normalizeAppleTestCatalog(catalog.data, evidence.scheme.targets), observed = [];
      let completedAt = catalog.execution.completedAt;
      for (const batch of item.batches) {
        const selected = appleTestSelection(batch?.selected);
        requireApple(selected.length <= 100 && batch.execution?.startedAt >= completedAt &&
          selected.every((test) => expected.some((item) => testKey(item) === testKey(test))),
        "A batch is out of order or contains an unknown test.", "case-evidence");
        requireApple(text(batch.originalResultBundle) && batch.originalResultBundle.startsWith("/") &&
          batch.originalResultBundle.endsWith(".xcresult") && !originalPaths.has(batch.originalResultBundle) &&
          batch.originalResultBundle !== path.posix.join(evidence.workspace, batch.resultBundle?.path ?? ""),
        "A batch must retain its distinct producing and copied result bundles.", "artifact-changed");
        originalPaths.add(batch.originalResultBundle);
        outcome(batch, selected);
        observed.push(...selected);
        completedAt = batch.execution.completedAt;
      }
      requireApple(equal(appleTestSelection(observed), expected),
        "Batches must cover the entire native catalogue exactly once; retries cannot hide a prior failure.", "case-evidence");
    } else {
      requireApple(item.mode === undefined && !item.batches &&
        (evidence.origin === "local-xcodebuild" ? Boolean(item.catalog) : !item.catalog),
        "Unknown Apple test execution mode.", "execution-origin");
      outcome(item);
    }
  }
}

export function validateAppleBatchCatalog(catalog, evidence, target) {
  const command = catalog?.execution;
  requireApple(catalog?.version === 2 && catalog.kind === "local-apple-catalog" && catalog.status === "enumerated" &&
    catalog.base === evidence.base && equal(catalog.source, evidence.source) && equal(catalog.target, target) &&
    inside(evidence.directory, catalog.directory) && equal(catalog.plan, evidence.plan) &&
    inside(evidence.directory, catalog.plan?.path) && sha.test(catalog.plan.sha256 ?? "") &&
    command?.kind === "owned-command" && command.origin === "local-xcode-enumeration" && text(command.id) &&
    text(command.file) && command.file.startsWith("/") && path.posix.basename(command.file) === "xcrun" &&
    command.cwd === evidence.workspace &&
    equal(command.args, appleEnumerationArguments(evidence.workspace, catalog.directory, target)) &&
    timestamp(command.startedAt) && timestamp(command.completedAt) && command.startedAt >= evidence.startedAt &&
    command.completedAt >= command.startedAt && command.completedAt <= evidence.completedAt &&
    command.status === "passed" && command.cleanup === "completed" && !command.failure &&
    command.outcome?.observedProcess === "owned-command-supervisor" && command.outcome.reason === "exit" &&
    command.outcome.exitCode === 0 && command.outcome.signal === "none" &&
    command.outcome.outputTruncated === false && command.outcome.cleanupFailure === null,
  "The native catalogue lacks a current, unfiltered, completed enumeration.", "discovery");
  for (const reference of [catalog.request, catalog.enumeration, command.request, command.response, command.stdout, command.stderr]) {
    requireApple(inside(evidence.directory, reference?.path) && sha.test(reference.sha256 ?? ""),
      "Native catalogue command/output receipts are missing.", "discovery");
  }
  normalizeAppleTestCatalog(catalog.data, evidence.scheme.targets);
  return catalog;
}

/**
 * Passing v1 reports contain base/source/sourceBefore/sourceAfter, workspace/directory,
 * startedAt/completedAt, scheme {path, xml, sha256, targets}, toolchain, builds[2],
 * tests[4], status/cleanup and an empty failures array. Builds contain platform,
 * action:"build", status, execution, originalProduct and product (a directory manifest).
 * Tests contain role, action:"test", status, execution, target, resultBundle (manifest),
 * summary/testTree (actual xcresult JSON), and result (normalizeAppleTestResult).
 * Execution is {origin, kind, workspace:project, startedAt, completedAt, commandId}
 * for CI, or {origin, kind:"original-client-tool-call", workspace:project, startedAt,
 * completedAt, tool, toolCallId, evidence:[{path,sha256}]} for local-xcode-mcp.
 * The local collector validates original receipts and re-reads retained artifacts.
 * CI additionally proves ci, commands, preparationCommandId, resources,
 * cleanupEvidence, build resultBundle, and test summaryCommandId/testsCommandId.
 * CI command stdout/stderr are {path,bytes,sha256} references, never verbose text.
 * command.output binds compact facts/probe data to both original log digests.
 * CI summary/testTree retain every validation field/case, without console metadata;
 * their canonical hashes bind to the commands that exported the full JSON artifacts.
 */
export function validateAppleNativeEvidence(evidence, plan, expectedOrigin = "ci-xcodebuild") {
  validateApplePlan(plan);
  requireApple(evidence?.version === 1 && evidence.kind === "apple-native-evidence" &&
    evidence.origin === expectedOrigin, "Apple evidence has the wrong version or execution origin.", "execution-origin");
  requireApple(["ci-xcodebuild", "local-xcode-mcp", "local-xcodebuild"].includes(expectedOrigin),
    "Unknown Apple evidence origin.", "execution-origin");
  requireApple(Buffer.byteLength(appleJSON(evidence)) <= APPLE_NATIVE_REPORT_MAX_BYTES,
    "Apple native evidence exceeds its publication budget.", "output-limit");
  requireApple(evidence.base === plan.base && equal(evidence.source, plan.source) &&
    equal(evidence.sourceBefore, plan.source) && equal(evidence.sourceAfter, plan.source) &&
    equal(evidence.apple, plan.apple), "Apple evidence source or requirements changed.", "source-mismatch");
  requireApple(evidence.status === "passed" && evidence.cleanup === "completed" &&
    Array.isArray(evidence.failures) && evidence.failures.length === 0,
  "Apple execution or cleanup is incomplete.", "check-failed");
  requireApple(timestamp(evidence.startedAt) && timestamp(evidence.completedAt) &&
    evidence.completedAt >= evidence.startedAt && text(evidence.workspace) && evidence.workspace.startsWith("/") &&
    relative(evidence.directory) && /^\.data\/(?:ci|verification)\/.+/.test(evidence.directory) &&
    !/^\.data\/verification\/local(?:\/|$)/.test(evidence.directory) && appleDeviceId(evidence.runId),
  "Invalid Apple execution boundary.", "execution-origin");
  sharedAppleOutcomes(evidence);
  if (expectedOrigin === "local-xcode-mcp") return evidence;
  const local = expectedOrigin === "local-xcodebuild";
  if (local) {
    requireApple(!evidence.ci && evidence.directory.startsWith(".data/verification/") && evidence.local?.platform === "darwin" &&
      Array.isArray(evidence.local.targets) && evidence.local.targets.length === 4 &&
      inside(evidence.directory, evidence.local.executionRequest?.path) &&
      sha.test(evidence.local.executionRequest.sha256 ?? "") &&
      relative(evidence.local.plan?.path) && sha.test(evidence.local.plan.sha256 ?? ""),
    "Local command evidence must retain its own plan, request and exact targets.", "execution-origin");
  } else requireApple(evidence.ci?.githubActions === "true" && evidence.ci.runnerEnvironment === "github-hosted" &&
    evidence.ci.platform === "darwin" && /^\d+$/.test(evidence.ci.runId ?? "") &&
    /^\d+$/.test(evidence.ci.runAttempt ?? "") && text(evidence.ci.job) && text(evidence.ci.repository) &&
    evidence.ci.sha === plan.source.head,
  "Apple execution is not bound to a GitHub-hosted Mac job.", "execution-origin");
  requireApple(Array.isArray(evidence.commands) && evidence.commands.length > 0 &&
    new Set(evidence.commands.map((item) => item.id)).size === evidence.commands.length,
  "Apple command evidence is missing or duplicated.", "execution-origin");
  const commands = new Map(evidence.commands.map((item) => [item.id, item]));
  const consumed = new Set();
  for (const command of commands.values()) {
    requireApple(text(command.id) && command.kind === "owned-command" && command.origin === evidence.origin &&
      text(command.file) && Array.isArray(command.args) && command.args.every((arg) => typeof arg === "string") &&
      command.cwd === evidence.workspace && command.status === "passed" && command.cleanup === "completed" &&
      timestamp(command.startedAt) && timestamp(command.completedAt) && command.startedAt >= evidence.startedAt &&
      command.completedAt >= command.startedAt && command.completedAt <= evidence.completedAt &&
      command.outcome?.observedProcess === "owned-command-supervisor" && command.outcome.reason === "exit" &&
      command.outcome.exitCode === 0 && command.outcome.signal === "none" &&
      command.outcome.outputTruncated === false && command.outcome.cleanupFailure === null && !command.failure &&
      Number.isSafeInteger(command.outcome.capturedBytes) && command.outcome.capturedBytes >= 0 &&
      command.outcome.capturedBytes <= 16 * 1024 * 1024,
    "An Apple command did not complete successfully with confirmed ownership cleanup.", "execution-origin");
    for (const stream of [command.stdout, command.stderr]) {
      fileReference(stream, evidence.directory);
      requireApple(Object.keys(stream).every((key) => ["path", "bytes", "sha256"].includes(key)),
        "Verbose command logs must remain separate artifacts.", "artifact-changed");
    }
    if (local) for (const receipt of [command.request, command.response]) fileReference(receipt, evidence.directory);
    requireApple(["logs", "build", "text", "simulators", "xcresult-summary", "xcresult-tests",
      ...(local ? ["product-info"] : [])].includes(command.output?.kind),
      "Unknown Apple command projection.", "artifact-changed");
    commandProjection(command, command.output.kind);
  }
  const command = (id, file, args) => {
    const value = commands.get(id);
    requireApple(value && value.file === file && equal(value.args, args),
      `Missing or mismatched Apple invocation: ${id}.`, "execution-origin");
    consumed.add(id);
    return value;
  };
  const outputs = Object.fromEntries(APPLE_PROBES.map((probe) => {
    const value = command(`probe-${probe.id}`, probe.file, probe.args);
    return [probe.id, probe.id === "simulators" ? appleJSON(commandProjection(value, "simulators").data)
      : commandProjection(value, "text").data];
  }));
  const baselineToolchain = inspectAppleToolchain(outputs);
  const localTargets = local ? selectAppleLocalTargets(JSON.parse(outputs.simulators), baselineToolchain, evidence.local.targets, true) : null;
  const toolchain = local ? localAppleToolchain(baselineToolchain, localTargets) : baselineToolchain;
  if (local) requireApple(equal(localTargets, evidence.local.targets), "Local destination labels changed.", "device-evidence");
  requireApple(equal(evidence.toolchain, toolchain), "Toolchain labels differ from the actual probes.", "preflight-version");
  requireApple(evidence.scheme?.path === `${APPLE_REQUIREMENTS.project}/xcshareddata/xcschemes/DevPocket.xcscheme` &&
    evidence.scheme.sha256 === appleDigest(evidence.scheme.xml) &&
    equal(evidence.scheme.targets, inspectAppleScheme(evidence.scheme.xml)),
  "The shared scheme evidence is incomplete.", "case-evidence");
  const preparation = commands.get(evidence.preparationCommandId);
  consumed.add(evidence.preparationCommandId);
  requireApple(preparation && text(preparation.file) && preparation.file.startsWith("/") &&
    equal(preparation.args, ["apple/prepare-components.mjs"]) &&
    APPLE_PROBES.every((probe) => preparation.startedAt >= commands.get(`probe-${probe.id}`).completedAt),
  "Apple renderer preparation was not executed after preflight.", "execution-origin");
  const inventory = JSON.parse(outputs.simulators), baseline = appleDevices(inventory);
  const nativeTargets = local ? localTargets
    : [{ role: "mac", platform: "macOS", osVersion: toolchain.macOS, architecture: toolchain.architecture }];
  let cleanupBefore, cleanupAfter;
  if (local) {
    requireApple(Array.isArray(evidence.resources) && evidence.resources.length === 0 &&
      evidence.cleanupEvidence && !evidence.cleanupEvidence.beforeCommandId && !evidence.cleanupEvidence.afterCommandId,
    "Local verification must preserve existing devices, not acquire a simulator lifecycle.", "ownership-mismatch");
    cleanupAfter = command(evidence.local.targetsAfterCommandId, "/usr/bin/xcrun", ["simctl", "list", "--json"]);
    requireApple(equal(selectAppleLocalTargets(commandProjection(cleanupAfter, "simulators").data,
      baselineToolchain, localTargets, true), localTargets), "Local target identity changed after execution.", "device-evidence");
  } else {
    requireApple(Array.isArray(evidence.resources) && evidence.resources.length === 3 &&
      new Set(evidence.resources.map((item) => item.deviceId)).size === 3,
    "The owned simulator set is incomplete.", "ownership-mismatch");
    cleanupBefore = command(evidence.cleanupEvidence?.beforeCommandId, "/usr/bin/xcrun", ["simctl", "list", "devices", "--json"]);
    cleanupAfter = command(evidence.cleanupEvidence?.afterCommandId, "/usr/bin/xcrun", ["simctl", "list", "devices", "--json"]);
    const beforeDevices = appleDevices(commandProjection(cleanupBefore, "simulators").data);
    const remaining = appleDevices(commandProjection(cleanupAfter, "simulators").data);
    for (const selection of toolchain.simulators) {
      const matching = evidence.resources.filter((item) => item.role === selection.role);
      requireApple(matching.length === 1, "A simulator role is missing or duplicated.", "ownership-mismatch");
      const resource = matching[0], name = `DevPocket-${evidence.runId}-${selection.role}`;
      requireApple(appleDeviceId(resource.deviceId) && resource.name === name &&
        resource.runtimeIdentifier === selection.runtimeIdentifier && resource.deviceTypeIdentifier === selection.deviceTypeIdentifier &&
        !baseline.some((item) => item.udid === resource.deviceId || item.name === name) && resource.cleanup === "completed",
      "Simulator identity or cleanup is not owned by this run.", "ownership-mismatch");
      const created = command(resource.createCommandId, "/usr/bin/xcrun",
        ["simctl", "create", name, selection.deviceTypeIdentifier, selection.runtimeIdentifier]);
      requireApple(commandProjection(created, "text").data.trim() === resource.deviceId,
      "The simulator was not returned by this run's creation command.", "ownership-mismatch");
      const confirmed = command(resource.confirmCommandId, "/usr/bin/xcrun", ["simctl", "list", "devices", "--json"]);
      const found = appleDevices(commandProjection(confirmed, "simulators").data).filter((item) => item.udid === resource.deviceId);
      requireApple(found.length === 1 && found[0].name === name && found[0].runtimeIdentifier === selection.runtimeIdentifier &&
        (!found[0].deviceTypeIdentifier || found[0].deviceTypeIdentifier === selection.deviceTypeIdentifier),
      "The created simulator identity was not confirmed before boot.", "ownership-mismatch");
      const booted = command(resource.bootCommandId, "/usr/bin/xcrun", ["simctl", "boot", resource.deviceId]);
      const ready = command(resource.readyCommandId, "/usr/bin/xcrun", ["simctl", "bootstatus", resource.deviceId, "-b"]);
      requireApple(confirmed.startedAt >= created.completedAt && booted.startedAt >= confirmed.completedAt &&
        ready.startedAt >= booted.completedAt, "Simulator readiness predates creation or confirmation.", "execution-origin");
      if (resource.shutdownCommandId) command(resource.shutdownCommandId, "/usr/bin/xcrun", ["simctl", "shutdown", resource.deviceId]);
      if (resource.deleteCommandId) command(resource.deleteCommandId, "/usr/bin/xcrun", ["simctl", "delete", resource.deviceId]);
      else requireApple(!beforeDevices.some((item) => item.udid === resource.deviceId || item.name === name),
        "A retained simulator was not deleted.", "ownership-mismatch");
      requireApple(!remaining.some((item) => item.udid === resource.deviceId || item.name === name),
        "Owned simulators remain after cleanup.", "cleanup-failed");
      nativeTargets.push({ ...selection, deviceId: resource.deviceId, architecture: toolchain.architecture });
    }
  }
  requireApple(Array.isArray(evidence.builds) && evidence.builds.length === 2 &&
    Array.isArray(evidence.tests) && evidence.tests.length === 4, "Required Apple builds or targets are missing.", "shard-missing");
  const nativeCommands = new Set(), resultPaths = new Set();
  const execution = (item, action, platform, destination, label) => {
    requireApple(item?.status === "passed", "An Apple build or test was not completed.", "check-failed");
    const directory = `${evidence.directory}/${label}`;
    const value = command(item.commandId, "/usr/bin/xcrun",
      appleXcodeArguments({ workspace: evidence.workspace, directory, action, platform, destination,
        ...(local && action === "test" ? { testDiagnostics: "never" } : {}) }));
    requireApple(!nativeCommands.has(value.id) && value.startedAt >= preparation.completedAt &&
      item.execution.startedAt === value.startedAt && item.execution.completedAt === value.completedAt,
      "A native invocation was reused or preceded preparation.", "execution-origin");
    nativeCommands.add(value.id);
    const bundle = `${directory}/result.xcresult`;
    requireApple(!resultPaths.has(bundle), "A native result bundle was reused.", "execution-origin");
    resultPaths.add(bundle);
    treeReference(item.resultBundle, bundle, value.id, ["Info.plist"], action === "test");
    if (local) {
      const ready = item.readiness;
      requireApple(ready?.status === "ready" && ready.commandId === value.id &&
        ready.timeoutMs === APPLE_RESULT_READINESS_MS && Number.isSafeInteger(ready.polls) && ready.polls > 0 &&
        timestamp(ready.startedAt) && timestamp(ready.completedAt) && ready.startedAt >= value.completedAt &&
        ready.completedAt >= ready.startedAt &&
        Date.parse(ready.completedAt) - Date.parse(ready.startedAt) <= APPLE_RESULT_READINESS_MS &&
        ready.infoSha256 === (item.resultBundle.fileManifest ? item.resultBundle.infoSha256
          : item.resultBundle.files.find((file) => file.path === "Info.plist")?.sha256),
      "The native result did not become ready within its bounded post-command check.", "case-evidence");
      copiedTreeReference(item.retainedResultBundle, `${directory}/retained/result.xcresult`, item.resultBundle);
    }
    return { value, directory };
  };
  for (const platform of ["ios", "macos"]) {
    const items = evidence.builds.filter((item) => item.platform === platform);
    requireApple(items.length === 1, "A normal Apple build is missing or duplicated.", "shard-missing");
    const item = items[0], destination = platform === "ios" ? "generic/platform=iOS Simulator"
      : local ? `platform=macOS,id=${localTargets.find((target) => target.role === "mac").deviceId}`
        : `platform=macOS,arch=${toolchain.architecture}`;
    const { value, directory } = execution(item, "build", platform, destination, `build-${platform}`);
    const facts = commandProjection(value, "build").data;
    requireApple(Number.isSafeInteger(facts?.succeeded) && facts.succeeded > 0 && facts.failed === 0 &&
      Object.keys(facts).every((key) => ["succeeded", "failed", "products"].includes(key)),
    "The normal build has no successful native build result.", "check-failed");
    const product = `${directory}/derived/Build/Products/${platform === "ios" ? "Debug-iphonesimulator" : "Debug"}/DevPocket.app`;
    const original = path.posix.join(evidence.workspace, product);
    requireApple(item.originalProduct === original && equal(facts.products, [original]),
    "The product is not the original output of the successful build.", "artifact-changed");
    treeReference(item.product, product, value.id, platform === "ios"
      ? ["Info.plist", "DevPocket"] : ["Contents/Info.plist", "Contents/MacOS/DevPocket"]);
    if (local) {
      const verified = command(item.signatureCommandId, "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", "--verbose=2", original]);
      const info = command(item.infoCommandId, "/usr/bin/plutil",
        ["-convert", "json", "-o", "-", original + (platform === "ios" ? "/Info.plist" : "/Contents/Info.plist")]);
      const metadata = commandProjection(info, "product-info").data;
      requireApple(verified.startedAt >= value.completedAt && info.startedAt >= verified.completedAt &&
        text(metadata?.CFBundleIdentifier) &&
        compareVersions(platform === "ios" ? metadata.MinimumOSVersion : metadata.LSMinimumSystemVersion, "27.0") >= 0,
      "The normal product lacks native signature/Info.plist evidence.", "artifact-changed");
      copiedTreeReference(item.retainedProduct, `${directory}/retained/DevPocket.app`, item.product);
      fileReference(item.seal, evidence.directory);
    }
  }
  for (const target of nativeTargets) {
    const items = evidence.tests.filter((item) => item.role === target.role);
    requireApple(items.length === 1, "A native Apple test role is missing or duplicated.", "shard-missing");
    const item = items[0], mac = target.role === "mac";
    const destination = mac && !local ? `platform=macOS,arch=${toolchain.architecture}` : `platform=${target.platform},id=${target.deviceId}`;
    const { value, directory } = execution(item, "test", mac ? "macos" : "ios", destination, `test-${target.role}`);
    if (!mac && !local) {
      const resource = evidence.resources.find((entry) => entry.role === target.role);
      requireApple(value.startedAt >= commands.get(resource.readyCommandId).completedAt,
        "Native tests preceded owned simulator readiness.", "execution-origin");
    }
    requireApple(Date.parse(value.startedAt) >=
      Math.max(...evidence.builds.map((build) => Date.parse(commands.get(build.commandId).completedAt))),
    "Native tests preceded the normal builds.", "execution-origin");
    const bundle = path.posix.join(evidence.workspace, item.resultBundle.path);
    const exports = ["summary", "tests"].map((kind) => {
      const read = command(item[`${kind}CommandId`], "/usr/bin/xcrun",
        ["xcresulttool", "get", "test-results", kind, "--path", bundle, "--compact"]);
      requireApple(read.startedAt >= value.completedAt, "xcresult was read before its test invocation completed.", "execution-origin");
      const data = kind === "summary" ? item.summary : item.testTree;
      requireApple(equal(data, projectAppleXcresult(kind, data)) &&
        commandProjection(read, `xcresult-${kind}`).dataSha256 === appleDigest(appleJSON(data)),
      "The xcresult projection differs from its original export.", "artifact-changed");
      return data;
    });
    if (local) {
      const catalog = item.catalog, catalogDirectory = `${directory}/catalog`;
      const discovered = command(item.catalogCommandId, "/usr/bin/xcrun",
        appleEnumerationArguments(evidence.workspace, catalogDirectory, target));
      fileReference(catalog, evidence.directory);
      requireApple(catalog.path === `${catalogDirectory}/enumeration.json` &&
        discovered.startedAt >= preparation.completedAt && discovered.completedAt <= value.startedAt,
      "The full command requires its own fresh, unfiltered native catalogue.", "discovery");
      for (const [id, followedBy] of [[item.beforeCatalogCommandId, discovered], [item.beforeTestCommandId, value]]) {
        const check = command(id, "/usr/bin/xcrun", ["simctl", "list", "--json"]);
        requireApple(check.startedAt >= preparation.completedAt && check.completedAt <= followedBy.startedAt &&
          equal(selectAppleLocalTargets(commandProjection(check, "simulators").data, baselineToolchain, localTargets, true), localTargets),
        "The exact targets must already be booted before catalogue/test execution.", "device-evidence");
      }
      const expected = normalizeAppleTestCatalog(catalog.data, evidence.scheme.targets);
      const actual = normalizeAppleTestResult(exports[0], exports[1], target, value, evidence.scheme.targets);
      requireApple(equal(expected, appleTestSelection(actual.cases.map((test) =>
        ({ targetName: test.target, testIdentifier: test.identifier })))),
      "The native command did not execute the entire fresh catalogue.", "case-evidence");
    }
    const result = normalizeAppleTestResult(exports[0], exports[1], target, value, evidence.scheme.targets);
    requireApple(equal(item.summary, exports[0]) && equal(item.testTree, exports[1]) && equal(item.result, result),
      "The normalized native result differs from actual xcresult data.", "case-evidence");
    requireApple(local ? cleanupAfter.startedAt >= value.completedAt
      : cleanupBefore.startedAt >= value.completedAt && cleanupAfter.startedAt >= cleanupBefore.completedAt,
      "Cleanup evidence predates native execution.", "execution-origin");
  }
  if (local) requireApple(consumed.size === commands.size, "Local command evidence contains an unrequested invocation.", "execution-origin");
  return evidence;
}
