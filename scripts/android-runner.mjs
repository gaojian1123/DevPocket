import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runCommand } from "./process.mjs";
import { waitForAndroid, withAndroidEmulator } from "./android-emulator.mjs";
import { sourceSnapshot } from "./verification.mjs";
import { cleanDeviceRun } from "./device-run.mjs";
import { diagnosticError, failureDetails, diagnosticVersion, contextualFailure } from "./diagnostic-errors.mjs";
import { createDeviceDiagnostics, instrumentationDiagnostics, DEVICE_DIAGNOSTIC_PREFIX } from "./device-diagnostics.mjs";
import { writeBoundedWorkerLog } from "./bounded-worker-log.mjs";

const manualClass = "dev.devpocket.app.ConnectedFlowTest";
const baselineClasses = ["NativeFlowTest", "AdaptiveLayoutTest", "FixtureFlowTest"].map((name) => `dev.devpocket.app.${name}`);

export function instrumentationClasses(output) {
  const classes = [...new Set([...output.matchAll(/^INSTRUMENTATION_STATUS: class=(.+)\r?$/gm)]
    .map((match) => match[1].trim()))].sort();
  if (!/^INSTRUMENTATION_CODE: -1\s*$/m.test(output) || !classes.length ||
      classes.includes(manualClass) || classes.some((name) => !/^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(name)) ||
      baselineClasses.some((name) => !classes.includes(name))) {
    throw Object.assign(new Error("APK test discovery is incomplete or includes the opt-in real-CLI suite."), { diagnosticCode: "discovery" });
  }
  return classes;
}

export function instrumentationResult(output, expectedClass) {
  const end = /^OK \((\d+) tests?\)\s*$/m.exec(output);
  const successes = [...output.matchAll(/^INSTRUMENTATION_STATUS_CODE: 0\s*$/gm)].length;
  const classes = [...output.matchAll(/^INSTRUMENTATION_STATUS: class=(.+)\r?$/gm)].map((match) => match[1].trim());
  if (!end || Number(end[1]) < 1 || successes !== Number(end[1]) ||
      !/^INSTRUMENTATION_CODE: -1\s*$/m.test(output) ||
      /^INSTRUMENTATION_STATUS_CODE: -[1-4]\s*$/m.test(output) ||
      !classes.includes(expectedClass) || classes.some((name) => name !== expectedClass)) {
    throw Object.assign(new Error(`Instrumentation did not complete every required test in ${expectedClass}; skips are not acceptance.`),
      { diagnosticCode: "instrumentation" });
  }
  return { tests: Number(end[1]), status: "passed" };
}

export async function runNativeCase(device, name, testClass, extra = [], directory = device.directory) {
  if (typeof testClass !== "string") throw diagnosticError("plan-invalid");
  const fullClass = testClass.includes(".") ? testClass : `dev.devpocket.app.${testClass}`;
  const diagnostics = device.diagnostics ?? await createDeviceDiagnostics({ root: device.root, runId: device.runId });
  diagnostics.caseStarted(name, fullClass);
  let output, result, failure, attempted = false;
  try {
    await device.adb(["shell", "pm", "clear", "dev.devpocket.app.debug"]);
    diagnostics.operation("instrumentation");
    attempted = true;
    output = await device.adb(["shell", "am", "instrument", "-w", "-r", "-e", "class", fullClass, ...extra,
      "dev.devpocket.app.debug.test/androidx.test.runner.AndroidJUnitRunner"], 300_000);
    result = { name, class: fullClass, ...instrumentationResult(output.stdout, fullClass) };
  } catch (error) {
    failure = contextualFailure(error, device.signal);
    if (output?.commandOutcome) failure.commandOutcome = output.commandOutcome;
  }
  const stdout = output?.stdout ?? failure?.stdout ?? "", stderr = output?.stderr ?? failure?.stderr ?? "";
  const instrumentation = attempted ? instrumentationDiagnostics(stdout, fullClass, diagnostics.catalogue) : undefined;
  diagnostics.caseFinished(name, result, failure, instrumentation);
  try {
    const retained = await writeBoundedWorkerLog(path.join(directory, `case-${name}.log`),
      `${typeof stdout === "string" ? stdout : ""}${typeof stderr === "string" ? stderr : ""}`);
    diagnostics.log("case", retained);
  } catch (error) {
    diagnostics.issue("case-log", error);
    // Only the run-level recorder's owner can defer qualification until cleanup.
    if (!device.diagnostics) failure ??= diagnosticError("report-write", error);
  }
  if (!failure) return result;
  if (attempted && !result) {
    let operation = "logcat";
    try {
      const crash = await device.adb(["logcat", "-d", "-b", "crash", "-t", "250"]);
      operation = "crash-log-write";
      diagnostics.log("crash", await writeBoundedWorkerLog(path.join(directory, `case-${name}-crash.log`), crash.stdout + crash.stderr));
    } catch (collectionError) {
      const issue = { operation, ...failureDetails(collectionError, "collector-failed") };
      failure.diagnosticIssues = [...(failure.diagnosticIssues ?? []), issue];
      diagnostics.issue(operation, collectionError);
    }
  }
  diagnostics.fail(failure, instrumentation);
  failure.failedCase = result ?? { name, class: fullClass, status: "failed", tests: 0 };
  failure.deviceDiagnostics = diagnostics.snapshot();
  throw failure;
}

async function restoreLayout(device, original) {
  const failures = [];
  for (const args of [["shell", "wm", "size", "reset"], ["shell", "wm", "density", "reset"],
    ["shell", "settings", "put", "system", "font_scale", "1.0"]]) {
    try { await device.adb(args); }
    catch (error) {
      failures.push(error);
      device.diagnostics?.issue("layout-reset", error);
    }
  }
  if (!failures.length) return;
  if (original) {
    original.diagnosticIssues = [...(original.diagnosticIssues ?? []),
      ...failures.map((error) => ({ operation: "layout-reset", ...failureDetails(error, "cleanup-failed") }))];
    if (device.diagnostics) original.deviceDiagnostics = device.diagnostics.snapshot();
    return;
  }
  const error = diagnosticError("cleanup-failed", failures[0]);
  device.diagnostics?.operation("reset");
  device.diagnostics?.fail(error);
  if (device.diagnostics) error.deviceDiagnostics = device.diagnostics.snapshot();
  throw error;
}

export async function runNativeLayouts(device, { all = true, directory = device.directory, onCase } = {}) {
  const layouts = all ? [
    ["compact", "1080x2400", "420", "1.0"], ["medium", "1400x2200", "320", "1.0"],
    ["expanded", "2400x1800", "240", "1.0"], ["landscape", "2400x1080", "420", "1.0"],
    ["large-font", "1080x2400", "420", "2.0"],
  ] : [["compact", "1080x2400", "420", "1.0"]];
  const results = [];
  let failure;
  try {
    for (const [name, size, density, font] of layouts) {
      device.diagnostics?.caseStarted(`layout-${name}`, "dev.devpocket.app.AdaptiveLayoutTest");
      device.diagnostics?.stage("layout", "window");
      await device.adb(["shell", "wm", "size", size]);
      await device.adb(["shell", "wm", "density", density]);
      device.diagnostics?.operation("font");
      await device.adb(["shell", "settings", "put", "system", "font_scale", font]);
      const result = await runNativeCase(device, `layout-${name}`, "AdaptiveLayoutTest", [], directory);
      results.push(result);
      onCase?.(result);
    }
  }
  catch (error) {
    failure = error;
    device.diagnostics?.fail(error);
    error.failedCase ??= device.diagnostics?.failedCase();
    throw error;
  } finally { await restoreLayout(device, failure); }
  return results;
}

export async function prepareAndroidRuntime(identity, report, signal, { buildApks = true, diagnostics } = {}) {
  const { root, directory, jdk, sdk, image, imageDir, executable, adbPath, javaPath } = identity;
  diagnostics?.stage("prepare", "jdk");
  await access(javaPath);
  diagnostics?.operation("workspace");
  report.source = await sourceSnapshot(root);
  report.image = image;
  diagnostics?.operation("jdk");
  const java = await runCommand(javaPath, ["-version"], { signal });
  diagnostics?.operation("adb");
  const adbVersion = await runCommand(adbPath, ["version"], { signal });
  diagnostics?.operation("emulator");
  const emulatorVersion = await runCommand(executable, ["-version"], { signal });
  diagnostics?.operation("image");
  const imageProperties = await readFile(path.join(imageDir, "source.properties"), "utf8");
  report.toolchain = {
    java: diagnosticVersion(/version "([A-Za-z0-9._+-]+)"/.exec(java.stdout + java.stderr)?.[1]) ?? null,
    adb: diagnosticVersion(/^Android Debug Bridge version ([A-Za-z0-9._+-]+)/m.exec(adbVersion.stdout)?.[1]) ?? null,
    emulator: diagnosticVersion(/Android emulator version ([A-Za-z0-9._+-]+)/.exec(emulatorVersion.stdout + emulatorVersion.stderr)?.[1]) ?? null,
    imageRevision: diagnosticVersion(/^Pkg\.Revision=([0-9.]+)\s*$/m.exec(imageProperties)?.[1]) ?? null,
  };
  report.toolchainWarnings = Object.entries(report.toolchain).filter(([, value]) => value === null)
    .map(([tool]) => `${tool} did not report a recognized diagnostic version.`);
  if (!buildApks) return {};
  diagnostics?.stage("build", "cache");
  const disposableCache = process.platform === "linux" && process.env.GITHUB_ACTIONS === "true" &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted" ? path.join(directory, "gradle-cache") : undefined;
  if (disposableCache) await mkdir(disposableCache);
  diagnostics?.operation("gradle");
  const build = await runCommand("pwsh", ["-NoProfile", "-NonInteractive", "-File",
    path.join(root, "scripts", "build-android.ps1"), "-Jdk", jdk, "-Sdk", sdk, "-Instrumentation",
    ...(disposableCache ? ["-GradleUserHome", disposableCache] : [])],
  { cwd: root, timeoutMs: 20 * 60_000, signal });
  if (disposableCache && build.processTreeStopped !== true) {
    throw Object.assign(new Error("The build command did not confirm process-tree cleanup."),
      { processTreeStopped: false, stdout: build.stdout, stderr: build.stderr });
  }
  diagnostics?.operation("report");
  const retained = await writeBoundedWorkerLog(path.join(directory, "build.log"), build.stdout + build.stderr);
  diagnostics?.log("build", retained);
  diagnostics?.operation("cache");
  if (disposableCache) await cleanDeviceRun(root, directory, identity.runId, { cacheOnly: true });
  diagnostics?.stage("apk-check", "app");
  const apk = path.join(root, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  const testApk = path.join(root, "android", "app", "build", "outputs", "apk", "androidTest", "debug", "app-debug-androidTest.apk");
  report.apkSha256 = createHash("sha256").update(await readFile(apk)).digest("hex");
  diagnostics?.operation("tests");
  report.testApkSha256 = createHash("sha256").update(await readFile(testApk)).digest("hex");
  return { apk, testApk };
}

export async function runAndroidTests(options, { emulator = withAndroidEmulator, prepare = prepareAndroidRuntime } = {}) {
  const root = path.resolve(options.repo ?? process.cwd());
  const directory = path.resolve(root, options.directory ?? path.join(".data", "android-runs", randomUUID()));
  const runId = options.owner ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid device run owner.");
  const report = { version: 1, runId, status: "blocked", tests: 0, cases: [], evidence: "emulator-test-sdk-adapter" };
  const diagnostics = await createDeviceDiagnostics({ root, runId });
  const signal = options.signal;
  let booted = false;
  let apk, testApk, failureCause;
  const record = (result) => { report.tests += result.tests; report.cases.push(result); };
  try {
    const finished = await emulator({
      ...options, repo: root, directory, owner: runId, diagnostics,
      onWaiting: options.onWaiting ?? ((status) => console.log(`Waiting for emulator slot ${status.position}; ${status.active}/${status.limit} active.`)),
      prepare: async (identity) => {
        const artifacts = await prepare(identity, report, signal, { diagnostics });
        apk = artifacts.apk;
        testApk = artifacts.testApk;
      },
    }, async (device) => {
      device = { ...device, diagnostics };
      booted = true;
      report.platform = process.platform;
      if (device.acceleration) report.acceleration = device.acceleration;
      report.lease = { id: device.leaseId, ports: device.ports };
      const adbRun = device.adb;
      for (const [file, operation] of [[apk, "app"], [testApk, "tests"]]) {
        diagnostics.stage("install", operation);
        await adbRun(["install", "-r", file], 120_000);
      }
      diagnostics.operation("unlock");
      await adbRun(["shell", "input", "keyevent", "82"]);
      await adbRun(["shell", "settings", "put", "secure", "show_ime_with_hard_keyboard", "1"]);
      diagnostics.stage("discovery", "instrumentation");
      const discovery = await adbRun(["shell", "am", "instrument", "-w", "-r", "-e", "log", "true",
        "-e", "notClass", manualClass, "dev.devpocket.app.debug.test/androidx.test.runner.AndroidJUnitRunner"], 120_000);
      report.discoveredClasses = instrumentationClasses(discovery.stdout);
      diagnostics.log("discovery", await writeBoundedWorkerLog(path.join(directory, "discovery.log"), discovery.stdout + discovery.stderr));
      const runCase = async (name, testClass, extra = []) => record(await runNativeCase(device, name, testClass, extra));
      await runCase("native", "NativeFlowTest");
      await runNativeLayouts(device, { all: !!options.layouts, onCase: record });
      const additional = report.discoveredClasses.filter((name) => !baselineClasses.includes(name));
      for (const [index, name] of additional.entries()) await runCase(`change-${index}`, name);
      diagnostics.caseStarted("fixture", "dev.devpocket.app.FixtureFlowTest");
      diagnostics.operation("fixture-start");
      const fixtureFile = path.join(directory, "fixture.local.json");
      const fixture = device.manage(process.execPath, ["--import", "tsx", path.join(root, "backend", "integration", "android-fixture.ts"),
        "--directory", path.join(directory, "fixture"), "--output", fixtureFile],
      process.env, "fixture");
      await waitForAndroid(async () => { await access(fixtureFile); return true; }, "Local relay fixture", 30_000, fixture, device.signal);
      diagnostics.operation("fixture-config");
      const config = JSON.parse(await readFile(fixtureFile, "utf8"));
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(config.relayUrl) ||
          !/^dpp_[A-Za-z0-9_-]{43}$/.test(config.pairingCode) ||
          !/^[A-Za-z0-9 _-]{1,120}$/.test(config.title)) {
        throw Object.assign(new Error("The automated fixture must supply a loopback origin and a bounded synthetic identity."),
          { diagnosticCode: "configuration" });
      }
      const relayPort = new URL(config.relayUrl).port;
      diagnostics.operation("reverse");
      await adbRun(["reverse", `tcp:${relayPort}`, `tcp:${relayPort}`]);
      await runCase("fixture", "FixtureFlowTest", ["-e", "relayUrl", config.relayUrl,
        "-e", "pairingCode", config.pairingCode, "-e", "sessionTitle", config.title]);
      diagnostics.stage("source-check", "verify");
      const finalSource = await sourceSnapshot(root);
      if (finalSource.fingerprint !== report.source.fingerprint || finalSource.head !== report.source.head) {
        throw Object.assign(new Error("Source changed while device evidence was being collected."), { diagnosticCode: "source-changed" });
      }
    });
    report.cleanup = finished.cleanup;
    report.workerDiagnostics = finished.workerDiagnostics;
    report.status = "passed";
  } catch (error) {
    if (error.runDirectory !== directory) {
      diagnostics.fail(error);
      error.deviceDiagnostics = diagnostics.finish("blocked");
      throw error;
    }
    failureCause = error;
    report.status = signal?.aborted ? "blocked" : report.cases.length || booted ? "failed" : "blocked";
    report.error = error.message;
    report.cleanup = error.cleanup;
    report.workerDiagnostics = error.workerDiagnostics;
    if (error.failedCase && !report.cases.some((item) => item.name === error.failedCase.name)) {
      report.cases.push(error.failedCase);
      report.tests += Number.isSafeInteger(error.failedCase.tests) ? error.failedCase.tests : 0;
    }
    if (error.cleanupErrors) report.cleanupErrors = error.cleanupErrors;
    if (error.stdout || error.stderr) {
      try { diagnostics.log("failure", await writeBoundedWorkerLog(path.join(directory, "failure.log"),
        `${error.stdout ?? ""}${error.stderr ?? ""}`)); }
      catch (collectionError) { diagnostics.issue("report", collectionError); }
    }
  }
  report.executionStatus = report.status;
  report.collectionStatus = report.workerDiagnostics?.collectionStatus === "failed" ||
    diagnostics.snapshot().collectionStatus === "failed" ? "failed" : diagnostics.snapshot().collectionStatus;
  if (report.status === "passed" && report.collectionStatus === "failed") {
    report.status = "blocked";
    report.error = "Native execution passed, but diagnostic collection failed.";
  }
  if (report.status === "passed") diagnostics.stage("complete", "done");
  if (report.toolchain) report.toolchain = Object.fromEntries(["java", "adb", "emulator", "imageRevision"]
    .map((name) => [name, diagnosticVersion(report.toolchain[name]) ?? null]));
  report.deviceDiagnostics = diagnostics.finish(report.status);
  try {
    const encoded = JSON.stringify(report, null, 2) + "\n";
    if (Buffer.byteLength(encoded) > 512 * 1024) throw diagnosticError("output-limit");
    await writeFile(path.join(directory, "device-report.json"), encoded, { flag: "wx", mode: 0o600 });
  } catch (error) {
    diagnostics.issue("report", error);
    const failure = failureCause ?? diagnosticError("report-write", error);
    diagnostics.fail(failure);
    failure.deviceDiagnostics = diagnostics.snapshot();
    throw failure;
  }
  return report;
}

async function main() {
  const { values } = parseArgs({ options: {
    repo: { type: "string" }, directory: { type: "string" }, sdk: { type: "string" },
    jdk: { type: "string" }, image: { type: "string" },
    "emulator-sdk": { type: "string" }, owner: { type: "string" }, layouts: { type: "boolean", default: false },
    "queue-timeout": { type: "string" },
  } });
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(diagnosticError("command-cancelled"));
  const input = (value) => { if (value.toString().trim() === "cancel") cancel(); };
  process.stdin.on("data", input);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const report = await runAndroidTests({ ...values, emulatorSdk: values["emulator-sdk"], signal: cancellation.signal,
      queueTimeoutMs: values["queue-timeout"] === undefined ? undefined : Number(values["queue-timeout"]) * 1000 });
    console.log(`${DEVICE_DIAGNOSTIC_PREFIX}${JSON.stringify(report.deviceDiagnostics)}`);
    console.log(`Android device verification: ${report.status}; ${report.tests} tests; cleanup ${report.cleanup}.`);
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    if (error.deviceDiagnostics) console.log(`${DEVICE_DIAGNOSTIC_PREFIX}${JSON.stringify(error.deviceDiagnostics)}`);
    console.error(JSON.stringify({ kind: "device-entry-failure", acceptance: false, ...failureDetails(error) }));
    process.exitCode = 1;
  } finally {
    process.stdin.off("data", input);
    process.stdin.pause();
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch {
    console.error(JSON.stringify({ kind: "device-entry-failure", status: "blocked", acceptance: false,
      phase: "arguments", failure: failureDetails(diagnosticError("configuration")) }));
    process.exitCode = 1;
  }
}
