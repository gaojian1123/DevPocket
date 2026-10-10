import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runCommand, spawnOwnedCommand, stopOwnedProcess } from "./process.mjs";
import { cleanDeviceRun } from "./device-run.mjs";
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

async function freePort(port = 0) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  const value = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return value;
}

async function emulatorPort() {
  for (let port = 5554; port <= 5680; port += 2) {
    try { await freePort(port); await freePort(port + 1); return port; }
    catch (error) { if (error.code !== "EADDRINUSE") throw error; }
  }
  throw new Error("No unused emulator port pair is available.");
}

async function waitFor(check, label, timeoutMs, processState, signal) {
  const deadline = Date.now() + timeoutMs;
  let last = "not ready";
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (processState?.settled) throw new Error(`${label}: owned process exited before readiness.`);
    try { if (await check()) return; }
    catch (error) { last = `${error.message} ${(error.stderr ?? "").trim()}`; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} timed out: ${last}`);
}

function managed(file, args, cwd, env, logPath) {
  const output = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
  const child = spawnOwnedCommand(file, args, { cwd, env, timeoutMs: 30 * 60_000, persistent: true });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  const state = { child, settled: false, error: undefined, done: undefined };
  child.once("error", (error) => { state.error = error; });
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") state.error = error; });
  state.done = new Promise((resolve) => child.once("close", () => {
    state.settled = true;
    output.end(resolve);
  }));
  return state;
}

async function ownedDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (!relative.startsWith(`.data${path.sep}`) || relative.split(path.sep).includes("..")) {
    throw new Error("An automated emulator run must have a new directory beneath this checkout's .data.");
  }
  const parent = path.dirname(directory);
  await mkdir(parent, { recursive: true });
  if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase()) throw new Error("Linked run directories are not supported.");
  await mkdir(directory);
}

export async function runAndroidTests(options) {
  const root = path.resolve(options.repo ?? process.cwd());
  const directory = path.resolve(options.directory ?? path.join(root, ".data", "android-runs", randomUUID()));
  await ownedDirectory(root, directory);
  const runId = options.owner ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid device run owner.");
  const report = { version: 1, runId, status: "blocked", tests: 0, cases: [], evidence: "emulator-test-sdk-adapter" };
  const processes = [];
  const signal = options.signal;
  let booted = false, adb, serial, avdName, adbPort, env;
  const adbRun = (args, timeoutMs = 30_000) => {
    const command = args[0] === "shell"
      ? ["shell", ...args.slice(1).map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)] : args;
    return runCommand(adb, ["-P", String(adbPort), "-s", serial, ...command], { cwd: root, env, timeoutMs, signal });
  };
  try {
    if (process.platform !== "win32") throw new Error("This runner currently requires an isolated Windows executor.");
    const sdk = path.resolve(options.sdk ?? process.env.DEVPOCKET_ANDROID_SDK ?? path.join(root, ".tools", "android-sdk"));
    const emulatorSdk = path.resolve(options.emulatorSdk ?? process.env.DEVPOCKET_EMULATOR_SDK ?? sdk);
    const jdk = path.resolve(options.jdk ?? process.env.DEVPOCKET_JDK ?? path.join(root, ".tools", "jdk-21"));
    const image = options.image ?? process.env.DEVPOCKET_ANDROID_IMAGE ?? "system-images\\android-35\\google_apis\\x86_64";
    if (!/^system-images[\\/]android-\d+(?:\.\d+)?[\\/](?:google_apis(?:_playstore)?|default)[\\/]x86_64$/.test(image)) {
      throw new Error("Image must name an installed x86_64 SDK system-image directory.");
    }
    const imageDir = path.resolve(emulatorSdk, image), executable = path.join(emulatorSdk, "emulator", "emulator.exe");
    adb = path.join(emulatorSdk, "platform-tools", "adb.exe");
    for (const file of [executable, adb, path.join(jdk, "bin", "java.exe"), path.join(imageDir, "system.img")]) {
      try { await access(file); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        throw new Error(`Missing Android prerequisite: ${file}. Provision tools and accepted licenses explicitly.`);
      }
    }
    report.source = await sourceSnapshot(root);
    report.image = image;
    const java = await runCommand(path.join(jdk, "bin", "java.exe"), ["-version"], { signal });
    const adbVersion = await runCommand(adb, ["version"], { signal });
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
    await writeFile(path.join(directory, "owner.json"),
      JSON.stringify({ version: 1, root, runId, pid: process.pid }), { flag: "wx" });
    const build = await runCommand("pwsh", ["-NoProfile", "-NonInteractive", "-File",
      path.join(root, "scripts", "build-android.ps1"), "-Jdk", jdk, "-Sdk", sdk, "-Instrumentation"],
    { cwd: root, timeoutMs: 20 * 60_000, signal });
    await writeFile(path.join(directory, "build.log"), build.stdout + build.stderr);
    const apk = path.join(root, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
    const testApk = path.join(root, "android", "app", "build", "outputs", "apk", "androidTest", "debug", "app-debug-androidTest.apk");
    report.apkSha256 = createHash("sha256").update(await readFile(apk)).digest("hex");
    report.testApkSha256 = createHash("sha256").update(await readFile(testApk)).digest("hex");
    const home = path.join(directory, "home"), avdHome = path.join(directory, "avd");
    const emulatorHome = path.join(directory, "emulator-home");
    await Promise.all([home, avdHome, emulatorHome].map((folder) => mkdir(folder)));
    adbPort = await freePort();
    const port = await emulatorPort();
    serial = `emulator-${port}`;
    avdName = `DevPocketCI_${randomUUID().replaceAll("-", "")}`;
    const avd = path.join(avdHome, `${avdName}.avd`);
    await mkdir(avd);
    const api = /android-(\d+)/.exec(image)[1];
    await writeFile(path.join(avdHome, `${avdName}.ini`), `avd.ini.encoding=UTF-8\npath=${avd}\ntarget=android-${api}\n`);
    await writeFile(path.join(avd, "config.ini"), [
      `AvdId=${avdName}`, `avd.ini.displayname=${avdName}`, "abi.type=x86_64", "hw.cpu.arch=x86_64",
      "hw.cpu.ncore=4", "hw.ramSize=4096", "hw.lcd.width=1080", "hw.lcd.height=2400", "hw.lcd.density=420",
      "hw.keyboard=yes", "hw.mainKeys=no", "hw.gpu.enabled=yes", "hw.gpu.mode=swiftshader_indirect",
      "disk.dataPartition.size=2G", `image.sysdir.1=${imageDir}${path.sep}`, "tag.id=google_apis",
      "showDeviceFrame=no", "fastboot.forceColdBoot=yes", "fastboot.forceFastBoot=no", "skin.dynamic=yes", "",
    ].join("\n"));
    env = { ...process.env, ANDROID_HOME: emulatorSdk, ANDROID_AVD_HOME: avdHome, ANDROID_EMULATOR_HOME: emulatorHome,
      ANDROID_USER_HOME: home, ANDROID_SDK_HOME: directory, HOME: home, USERPROFILE: home,
      ANDROID_ADB_SERVER_PORT: String(adbPort), ADB_SERVER_PORT: String(adbPort),
      ADB_SERVER_SOCKET: `tcp:${adbPort}` };
    await runCommand(executable, ["-accel-check"], { env, timeoutMs: 30_000, signal });
    const adbServer = managed(adb, ["-L", `tcp:${adbPort}`, "nodaemon", "server"],
      root, env, path.join(directory, "adb.log"));
    processes.push(adbServer);
    await waitFor(async () => {
      const socket = net.connect({ host: "127.0.0.1", port: adbPort });
      return await new Promise((resolve) => {
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => { socket.destroy(); resolve(false); });
      });
    }, "Owned ADB server", 20_000, adbServer, signal);
    const emulator = managed(executable, ["-avd", avdName, "-port", String(port), "-no-window", "-no-audio",
      "-no-boot-anim", "-no-snapshot", "-no-metrics", "-show-kernel", "-gpu", "swiftshader_indirect"],
    root, env, path.join(directory, "emulator.log"));
    processes.push(emulator);
    await waitFor(async () => (await adbRun(["shell", "getprop", "sys.boot_completed"], 10_000)).stdout.trim() === "1",
      "Emulator boot", 600_000, emulator, signal);
    const identity = await adbRun(["shell", "getprop", "ro.boot.qemu.avd_name"]);
    const actualAvd = identity.stdout.trim();
    await writeFile(path.join(directory, "ownership.json"), JSON.stringify({ expected: avdName, observed: actualAvd, serial, adbPort }));
    if (actualAvd !== avdName) throw new Error("Emulator ownership mismatch; no application operation was attempted.");
    booted = true;
    for (const file of [apk, testApk]) await adbRun(["install", "-r", file], 120_000);
    await adbRun(["shell", "input", "keyevent", "82"]);
    await adbRun(["shell", "settings", "put", "secure", "show_ime_with_hard_keyboard", "1"]);
    const discovery = await adbRun(["shell", "am", "instrument", "-w", "-r", "-e", "log", "true",
      "-e", "notClass", manualClass, "dev.devpocket.app.debug.test/androidx.test.runner.AndroidJUnitRunner"], 120_000);
    report.discoveredClasses = instrumentationClasses(discovery.stdout);
    await writeFile(path.join(directory, "discovery.log"), discovery.stdout + discovery.stderr);
    const runCase = async (name, testClass, extra = []) => {
      const fullClass = testClass.includes(".") ? testClass : `dev.devpocket.app.${testClass}`;
      await adbRun(["shell", "pm", "clear", "dev.devpocket.app.debug"]);
      const output = await adbRun(["shell", "am", "instrument", "-w", "-r", "-e", "class", fullClass, ...extra,
        "dev.devpocket.app.debug.test/androidx.test.runner.AndroidJUnitRunner"], 300_000);
      await writeFile(path.join(directory, `${name}.log`), output.stdout + output.stderr, { mode: 0o600 });
      let result;
      try { result = instrumentationResult(output.stdout, fullClass); }
      catch (error) {
        const crash = await adbRun(["logcat", "-d", "-b", "crash", "-t", "250"]);
        await writeFile(path.join(directory, `${name}-crash.log`), crash.stdout + crash.stderr, { mode: 0o600 });
        throw error;
      }
      report.tests += result.tests;
      report.cases.push({ name, class: fullClass, ...result });
    };
    await runCase("native", "NativeFlowTest");
    const layouts = options.layouts ? [
      ["compact", "1080x2400", "420", "1.0"], ["medium", "1400x2200", "320", "1.0"],
      ["expanded", "2400x1800", "240", "1.0"], ["landscape", "2400x1080", "420", "1.0"],
      ["large-font", "1080x2400", "420", "2.0"],
    ] : [["compact", "1080x2400", "420", "1.0"]];
    for (const [name, size, density, font] of layouts) {
      await adbRun(["shell", "wm", "size", size]);
      await adbRun(["shell", "wm", "density", density]);
      await adbRun(["shell", "settings", "put", "system", "font_scale", font]);
      await runCase(`layout-${name}`, "AdaptiveLayoutTest");
    }
    await adbRun(["shell", "wm", "size", "reset"]);
    await adbRun(["shell", "wm", "density", "reset"]);
    await adbRun(["shell", "settings", "put", "system", "font_scale", "1.0"]);
    const additional = report.discoveredClasses.filter((name) => !baselineClasses.includes(name));
    for (const [index, name] of additional.entries()) await runCase(`change-${index}`, name);
    const fixtureFile = path.join(directory, "fixture.local.json");
    const fixture = managed(process.execPath, ["--import", "tsx", path.join(root, "backend", "integration", "android-fixture.ts"),
      "--directory", path.join(directory, "fixture"), "--output", fixtureFile],
    root, process.env, path.join(directory, "fixture.log"));
    processes.push(fixture);
    await waitFor(async () => { await access(fixtureFile); return true; }, "Local relay fixture", 30_000, fixture, signal);
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
    report.status = "passed";
  } catch (error) {
    report.status = signal?.aborted ? "blocked" : report.cases.length || booted ? "failed" : "blocked";
    report.error = error.message;
    if (error.stdout || error.stderr) await writeFile(path.join(directory, "failure.log"),
      `${error.stdout ?? ""}${error.stderr ?? ""}`, { mode: 0o600 });
  } finally {
    const errors = [];
    for (const state of processes.reverse()) {
      try {
        if (!state.settled) {
          await stopOwnedProcess(state.child);
          await state.done;
        }
      } catch (error) { errors.push(error.message); }
    }
    if (!errors.length) {
      try { await cleanDeviceRun(root, directory, runId); }
      catch (error) { errors.push(error.message); }
    }
    report.cleanup = errors.length ? "failed" : "completed";
    if (errors.length) { report.status = "failed"; report.cleanupErrors = errors; }
    await writeFile(path.join(directory, "device-report.json"), JSON.stringify(report, null, 2) + "\n");
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    repo: { type: "string" }, directory: { type: "string" }, sdk: { type: "string" },
    jdk: { type: "string" }, image: { type: "string" },
    "emulator-sdk": { type: "string" }, owner: { type: "string" }, layouts: { type: "boolean", default: false },
  } });
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error("Device verification cancelled."));
  const input = (value) => { if (value.toString().trim() === "cancel") cancel(); };
  process.stdin.on("data", input);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const report = await runAndroidTests({ ...values, emulatorSdk: values["emulator-sdk"], signal: cancellation.signal });
  process.stdin.off("data", input);
  process.stdin.pause();
  console.log(`Android device verification: ${report.status}; ${report.tests} tests; cleanup ${report.cleanup}.`);
  if (report.error) console.error(report.error);
  if (report.status !== "passed") process.exitCode = 1;
}
