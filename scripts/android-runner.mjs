import { createHash, randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runCommand } from "./process.mjs";
import { waitForAndroid, withAndroidEmulator } from "./android-emulator.mjs";
import { sourceSnapshot } from "./verification.mjs";

const manualClass = "dev.devpocket.app.ConnectedFlowTest";
const baselineClasses = ["NativeFlowTest", "AdaptiveLayoutTest", "FixtureFlowTest"].map((name) => `dev.devpocket.app.${name}`);

export function instrumentationClasses(output) {
  const classes = [...new Set([...output.matchAll(/^INSTRUMENTATION_STATUS: class=(.+)\r?$/gm)]
    .map((match) => match[1].trim()))].sort();
  if (!/^INSTRUMENTATION_CODE: -1\s*$/m.test(output) || !classes.length ||
      classes.includes(manualClass) || classes.some((name) => !/^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(name)) ||
      baselineClasses.some((name) => !classes.includes(name))) {
    throw new Error("APK test discovery is incomplete or includes the opt-in real-CLI suite.");
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
    throw new Error(`Instrumentation did not complete every required test in ${expectedClass}; skips are not acceptance.`);
  }
  return { tests: Number(end[1]), status: "passed" };
}

export async function runNativeCase(device, name, testClass, extra = [], directory = device.directory) {
  const fullClass = testClass.includes(".") ? testClass : `dev.devpocket.app.${testClass}`;
  await device.adb(["shell", "pm", "clear", "dev.devpocket.app.debug"]);
  const output = await device.adb(["shell", "am", "instrument", "-w", "-r", "-e", "class", fullClass, ...extra,
    "dev.devpocket.app.debug.test/androidx.test.runner.AndroidJUnitRunner"], 300_000);
  await writeFile(path.join(directory, `${name}.log`), output.stdout + output.stderr, { mode: 0o600 });
  try { return { name, class: fullClass, ...instrumentationResult(output.stdout, fullClass) }; }
  catch (error) {
    const crash = await device.adb(["logcat", "-d", "-b", "crash", "-t", "250"]);
    await writeFile(path.join(directory, `${name}-crash.log`), crash.stdout + crash.stderr, { mode: 0o600 });
    throw error;
  }
}

export async function runNativeLayouts(device, { all = true, directory = device.directory, onCase } = {}) {
  const layouts = all ? [
    ["compact", "1080x2400", "420", "1.0"], ["medium", "1400x2200", "320", "1.0"],
    ["expanded", "2400x1800", "240", "1.0"], ["landscape", "2400x1080", "420", "1.0"],
    ["large-font", "1080x2400", "420", "2.0"],
  ] : [["compact", "1080x2400", "420", "1.0"]];
  const results = [];
  try {
    for (const [name, size, density, font] of layouts) {
      await device.adb(["shell", "wm", "size", size]);
      await device.adb(["shell", "wm", "density", density]);
      await device.adb(["shell", "settings", "put", "system", "font_scale", font]);
      const result = await runNativeCase(device, `layout-${name}`, "AdaptiveLayoutTest", [], directory);
      results.push(result);
      onCase?.(result);
    }
  } finally {
    await device.adb(["shell", "wm", "size", "reset"]);
    await device.adb(["shell", "wm", "density", "reset"]);
    await device.adb(["shell", "settings", "put", "system", "font_scale", "1.0"]);
  }
  return results;
}

export async function runAndroidTests(options) {
  const root = path.resolve(options.repo ?? process.cwd());
  const directory = path.resolve(root, options.directory ?? path.join(".data", "android-runs", randomUUID()));
  const runId = options.owner ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid device run owner.");
  const report = { version: 1, runId, status: "blocked", tests: 0, cases: [], evidence: "emulator-test-sdk-adapter" };
  const signal = options.signal;
  let booted = false;
  let apk, testApk;
  const record = (result) => { report.tests += result.tests; report.cases.push(result); };
  try {
    const finished = await withAndroidEmulator({
      ...options, repo: root, directory, owner: runId,
      onWaiting: options.onWaiting ?? ((status) => console.log(`Waiting for emulator slot ${status.position}; ${status.active}/${status.limit} active.`)),
      prepare: async ({ jdk, sdk, image, imageDir, executable, adbPath, javaPath }) => {
        await access(javaPath);
        report.source = await sourceSnapshot(root);
        report.image = image;
        const java = await runCommand(javaPath, ["-version"], { signal });
        const adbVersion = await runCommand(adbPath, ["version"], { signal });
        const emulatorVersion = await runCommand(executable, ["-version"], { signal });
        const imageProperties = await readFile(path.join(imageDir, "source.properties"), "utf8");
        report.toolchain = {
          java: /version "([A-Za-z0-9._+-]+)"/.exec(java.stdout + java.stderr)?.[1] ?? null,
          adb: /^Android Debug Bridge version ([A-Za-z0-9._+-]+)/m.exec(adbVersion.stdout)?.[1] ?? null,
          emulator: /Android emulator version ([A-Za-z0-9._+-]+)/.exec(emulatorVersion.stdout + emulatorVersion.stderr)?.[1] ?? null,
          imageRevision: /^Pkg\.Revision=([0-9.]+)\s*$/m.exec(imageProperties)?.[1] ?? null,
        };
        report.toolchainWarnings = Object.entries(report.toolchain).filter(([, value]) => value === null)
          .map(([tool]) => `${tool} did not report a recognized diagnostic version.`);
        const build = await runCommand("pwsh", ["-NoProfile", "-NonInteractive", "-File",
          path.join(root, "scripts", "build-android.ps1"), "-Jdk", jdk, "-Sdk", sdk, "-Instrumentation"],
        { cwd: root, timeoutMs: 20 * 60_000, signal });
        await writeFile(path.join(directory, "build.log"), build.stdout + build.stderr);
        apk = path.join(root, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
        testApk = path.join(root, "android", "app", "build", "outputs", "apk", "androidTest", "debug", "app-debug-androidTest.apk");
        report.apkSha256 = createHash("sha256").update(await readFile(apk)).digest("hex");
        report.testApkSha256 = createHash("sha256").update(await readFile(testApk)).digest("hex");
      },
    }, async (device) => {
      booted = true;
      report.platform = process.platform;
      if (device.acceleration) report.acceleration = device.acceleration;
      report.lease = { id: device.leaseId, ports: device.ports };
      const adbRun = device.adb;
      for (const file of [apk, testApk]) await adbRun(["install", "-r", file], 120_000);
      await adbRun(["shell", "input", "keyevent", "82"]);
      await adbRun(["shell", "settings", "put", "secure", "show_ime_with_hard_keyboard", "1"]);
      const discovery = await adbRun(["shell", "am", "instrument", "-w", "-r", "-e", "log", "true",
        "-e", "notClass", manualClass, "dev.devpocket.app.debug.test/androidx.test.runner.AndroidJUnitRunner"], 120_000);
      report.discoveredClasses = instrumentationClasses(discovery.stdout);
      await writeFile(path.join(directory, "discovery.log"), discovery.stdout + discovery.stderr);
      const runCase = async (name, testClass, extra = []) => record(await runNativeCase(device, name, testClass, extra));
      await runCase("native", "NativeFlowTest");
      await runNativeLayouts(device, { all: !!options.layouts, onCase: record });
      const additional = report.discoveredClasses.filter((name) => !baselineClasses.includes(name));
      for (const [index, name] of additional.entries()) await runCase(`change-${index}`, name);
      const fixtureFile = path.join(directory, "fixture.local.json");
      const fixture = device.manage(process.execPath, ["--import", "tsx", path.join(root, "backend", "integration", "android-fixture.ts"),
        "--directory", path.join(directory, "fixture"), "--output", fixtureFile],
      process.env, "fixture");
      await waitForAndroid(async () => { await access(fixtureFile); return true; }, "Local relay fixture", 30_000, fixture, device.signal);
      const config = JSON.parse(await readFile(fixtureFile, "utf8"));
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(config.relayUrl) ||
          !/^dpp_[A-Za-z0-9_-]{43}$/.test(config.pairingCode) ||
          !/^[A-Za-z0-9 _-]{1,120}$/.test(config.title)) {
        throw new Error("The automated fixture must supply a loopback origin and a bounded synthetic identity.");
      }
      const relayPort = new URL(config.relayUrl).port;
      await adbRun(["reverse", `tcp:${relayPort}`, `tcp:${relayPort}`]);
      await runCase("fixture", "FixtureFlowTest", ["-e", "relayUrl", config.relayUrl,
        "-e", "pairingCode", config.pairingCode, "-e", "sessionTitle", config.title]);
      const finalSource = await sourceSnapshot(root);
      if (finalSource.fingerprint !== report.source.fingerprint || finalSource.head !== report.source.head) {
        throw new Error("Source changed while device evidence was being collected.");
      }
    });
    report.cleanup = finished.cleanup;
    report.status = "passed";
  } catch (error) {
    if (error.runDirectory !== directory) throw error;
    report.status = signal?.aborted ? "blocked" : report.cases.length || booted ? "failed" : "blocked";
    report.error = error.message;
    report.cleanup = error.cleanup;
    if (error.cleanupErrors) report.cleanupErrors = error.cleanupErrors;
    if (error.stdout || error.stderr) await writeFile(path.join(directory, "failure.log"),
      `${error.stdout ?? ""}${error.stderr ?? ""}`, { mode: 0o600 });
  }
  await writeFile(path.join(directory, "device-report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    repo: { type: "string" }, directory: { type: "string" }, sdk: { type: "string" },
    jdk: { type: "string" }, image: { type: "string" },
    "emulator-sdk": { type: "string" }, owner: { type: "string" }, layouts: { type: "boolean", default: false },
    "queue-timeout": { type: "string" },
  } });
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error("Device verification cancelled."));
  const input = (value) => { if (value.toString().trim() === "cancel") cancel(); };
  process.stdin.on("data", input);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const report = await runAndroidTests({ ...values, emulatorSdk: values["emulator-sdk"], signal: cancellation.signal,
    queueTimeoutMs: values["queue-timeout"] === undefined ? undefined : Number(values["queue-timeout"]) * 1000 });
  process.stdin.off("data", input);
  process.stdin.pause();
  console.log(`Android device verification: ${report.status}; ${report.tests} tests; cleanup ${report.cleanup}.`);
  if (report.error) console.error(report.error);
  if (report.status !== "passed") process.exitCode = 1;
}
