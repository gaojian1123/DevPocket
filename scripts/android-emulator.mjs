import { randomUUID } from "node:crypto";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ownedProcessCleanupConfirmed, runCommand, spawnOwnedCommand, stopOwnedProcess } from "./process.mjs";
import { cleanDeviceRun } from "./device-run.mjs";
import { acquireEmulatorLease } from "./emulator-resources.mjs";
import { acquireLinuxEmulatorLease, linuxAcceleration, ownsLinuxListener } from "./linux-emulator.mjs";
import { createWorkerObservation, projectWorkerDiagnostics } from "./worker-diagnostics.mjs";
import { createNativeLifecycleCapture } from "./native-lifecycle.mjs";
import { createBoundedWorkerLog, writeBoundedWorkerLog } from "./bounded-worker-log.mjs";
import { diagnosticError, contextualFailure, failureDetails } from "./diagnostic-errors.mjs";
import { waitForAndroidHome } from "./android-home.mjs";
import { androidImageArchitecture, androidImagePattern, macOSAcceleration } from "./android-platform.mjs";

export function createLiveDeviceGuard(workers, inspect, signal) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const invalidate = (error = Object.assign(new Error("An owned emulator or ADB worker exited."), { diagnosticCode: "worker-exited" })) => {
    if (!controller.signal.aborted) controller.abort(error);
  };
  const handlers = workers.map((worker) => {
    const exited = () => invalidate();
    const failed = (error) => invalidate(error);
    worker.child.on("exit", exited);
    worker.child.on("error", failed);
    return () => { worker.child.off("exit", exited); worker.child.off("error", failed); };
  });
  const assertAlive = () => {
    if (workers.some((worker) => worker.settled || worker.error ||
        worker.child.exitCode !== null || worker.child.signalCode !== null)) invalidate();
    combined.throwIfAborted();
  };
  return {
    signal: combined,
    get failure() { return controller.signal.aborted ? controller.signal.reason : undefined; },
    assertAlive,
    verify: async () => {
      assertAlive();
      try { const evidence = await inspect(); assertAlive(); return evidence; }
      catch (error) {
        if (!signal?.aborted) invalidate(error);
        throw error;
      }
    },
    close: () => handlers.forEach((remove) => remove()),
  };
}

export function trackManagedCommand(child, output, platform = process.platform, { role, signal } = {}) {
  let tail = "";
  const native = child.stdio?.[3] ? createNativeLifecycleCapture() : undefined;
  const observation = ["adb", "emulator"].includes(role) ? createWorkerObservation(role, signal, native) : undefined;
  const state = { child, settled: false, error: undefined, done: undefined,
    role: ["adb", "emulator", "fixture"].includes(role) ? role : "unknown",
    requiresCleanupConfirmation: ["win32", "linux", "darwin"].includes(platform), cleanupConfirmed: false, workerObservation: observation,
    logInfo: () => output.logInfo?.(), logError: undefined, nativeCaptureError: undefined };
  output.on("error", (error) => {
    state.logError = error;
    child.stdout.resume();
    child.stderr.resume();
  });
  child.stdout.pipe(output, { end: false });
  child.stdout.on("data", (bytes) => observation?.stdout(bytes));
  child.stderr.pipe(output, { end: false });
  if (native) {
    child.stdio[3].on("data", native.data);
    child.stdio[3].once("end", native.end);
    child.stdio[3].once("error", (error) => {
      state.nativeCaptureError = error;
      native.fail();
    });
  }
  child.stderr.on("data", (bytes) => {
    tail = (tail + bytes.toString()).slice(-4096);
    observation?.stderr(bytes);
  });
  child.once("exit", (code, exitSignal) => observation?.exit(code, exitSignal));
  child.once("error", (error) => { state.error = error; });
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") state.error = error; });
  state.done = new Promise((resolve) => child.once("close", () => {
    state.settled = true;
    state.cleanupConfirmed = ["win32", "darwin"].includes(platform) ? ownedProcessCleanupConfirmed(child)
      : tail.trimEnd().split(/\r?\n/).at(-1) === "DEVPOCKET_OWNED_TREE_STOPPED";
    if (output.destroyed) resolve();
    else {
      const finish = () => { output.off("error", finish); resolve(); };
      output.once("error", finish);
      output.end(finish);
    }
  }));
  return state;
}

export function managedWorkerDiagnostics(processes, runId, cleanup) {
  const collectionFailures = processes.flatMap((state) => [
    ...(state.logError || state.logInfo()?.status === "unavailable"
      ? [{ role: state.role, channel: "worker-log", failure: failureDetails(state.logError, "collector-failed") }] : []),
    ...(state.nativeCaptureError
      ? [{ role: state.role, channel: "native-lifecycle", failure: failureDetails(state.nativeCaptureError, "collector-failed") }] : []),
  ]);
  return projectWorkerDiagnostics({
    runId, cleanup, collectionFailures,
    workers: processes.flatMap((state) => state.workerObservation
      ? [{ ...state.workerObservation.snapshot(), workerLog: state.logInfo() }] : []),
  });
}

export function requireManagedCleanup(state) {
  if (state.requiresCleanupConfirmation && !state.cleanupConfirmed) {
    throw new Error("Owned-process cleanup was not confirmed; retaining its data and lease.");
  }
}

export async function waitForAndroid(check, label, timeoutMs, processState, signal) {
  const deadline = Date.now() + timeoutMs;
  let last = "not ready";
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (processState?.settled) throw Object.assign(new Error(`${label}: owned process exited before readiness.`), { diagnosticCode: "worker-exited" });
    try { if (await check()) return; }
    catch (error) {
      if (error.processTreeStopped === false) throw error;
      last = `${error.message} ${(error.stderr ?? "").trim()}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Object.assign(new Error(`${label} timed out: ${last}`), { diagnosticCode: "readiness-timeout" });
}

async function ownsListener(port, rootPid, signal) {
  if (process.platform === "darwin") {
    const result = await runCommand("python3", ["-B",
      fileURLToPath(new URL("./owned-command-darwin.py", import.meta.url)),
      "--listener", String(port), String(rootPid)], { timeoutMs: 20_000, signal });
    if (!["owned", "not-owned"].includes(result.stdout.trim())) throw new Error("Invalid macOS listener ownership evidence.");
    return result.stdout.trim() === "owned";
  }
  if (process.platform === "linux") {
    signal?.throwIfAborted();
    return ownsLinuxListener(port, rootPid);
  }
  const result = await runCommand("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; $listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); ` +
    `$owned=$listeners.Count -gt 0; foreach($listenerId in $listeners) { $current=[int]$listenerId; $matched=$false; ` +
    `for($depth=0;$depth -lt 64 -and $current -gt 0;$depth++) { if($current -eq ${rootPid}) { $matched=$true; break }; ` +
    `$item=Get-CimInstance Win32_Process -Filter "ProcessId=$current"; if(-not $item) { break }; $current=[int]$item.ParentProcessId }; ` +
    `if(-not $matched) { $owned=$false } }; if($owned) { 'owned' } else { 'not-owned' }`], { timeoutMs: 20_000, signal });
  return result.stdout.trim() === "owned";
}

async function createRunDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (!relative.startsWith(`.data${path.sep}`) || relative.split(path.sep).includes("..")) {
    throw new Error("An emulator run must use a new directory beneath this checkout's .data.");
  }
  await mkdir(path.dirname(directory), { recursive: true });
  const canonical = await realpath(path.dirname(directory));
  const expected = path.dirname(directory);
  if (process.platform === "win32" ? canonical.toLowerCase() !== expected.toLowerCase() : canonical !== expected) {
    throw new Error("Linked emulator run directories are not supported.");
  }
  await mkdir(directory);
}

export async function withAndroidEmulator(options, operation) {
  if (!["win32", "linux", "darwin"].includes(process.platform)) throw new Error("Android emulator coordination requires Windows, Linux or macOS.");
  const linux = process.platform === "linux";
  const windows = process.platform === "win32";
  const root = path.resolve(options.repo ?? process.cwd());
  const directory = path.resolve(root, options.directory ?? path.join(".data", "android-runs", randomUUID()));
  const runId = options.owner ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid device run owner.");
  await createRunDirectory(root, directory);
  const processes = [];
  let lease, failure, result, guard, workerDiagnostics, closing = false, commandCleanupUnconfirmed = false;
  const signal = options.signal;
  const diagnostics = options.diagnostics;
  const sdk = path.resolve(options.sdk ?? process.env.DEVPOCKET_ANDROID_SDK ?? path.join(root, ".tools", "android-sdk"));
  const emulatorSdk = path.resolve(options.emulatorSdk ?? process.env.DEVPOCKET_EMULATOR_SDK ?? sdk);
  const jdk = path.resolve(options.jdk ?? process.env.DEVPOCKET_JDK ?? path.join(root, ".tools", "jdk-21"));
  const architecture = androidImageArchitecture();
  const image = (options.image ?? process.env.DEVPOCKET_ANDROID_IMAGE ??
    path.join("system-images", "android-35", "google_apis", architecture)).replaceAll("\\", path.sep);
  const identity = { root, directory, runId, sdk, emulatorSdk, jdk, image };
  const manage = (file, args, env, name) => {
    if (closing) throw new Error("The emulator run is closing.");
    const output = createBoundedWorkerLog(path.join(directory, `${name}.log`));
    const child = spawnOwnedCommand(file, args, { cwd: root, env, timeoutMs: 24 * 60 * 60_000, persistent: true,
      nativeLifecycle: linux && ["adb", "emulator"].includes(name) });
    const state = trackManagedCommand(child, output, process.platform, { role: name, signal });
    processes.push(state);
    return state;
  };
  try {
    signal?.throwIfAborted();
    diagnostics?.stage("resources", "image");
    if (androidImagePattern.exec(image)?.[1] !== architecture) {
      throw Object.assign(new Error(`Image must name an installed ${architecture} SDK system-image directory.`), { diagnosticCode: "resource-unavailable" });
    }
    const imageDir = path.resolve(emulatorSdk, image);
    const executable = path.join(emulatorSdk, "emulator", windows ? "emulator.exe" : "emulator");
    const adb = path.join(emulatorSdk, "platform-tools", windows ? "adb.exe" : "adb");
    const javaPath = path.join(jdk, "bin", windows ? "java.exe" : "java");
    Object.assign(identity, { imageDir, executable, adbPath: adb, javaPath });
    for (const [file, operation] of [[executable, "emulator"], [adb, "adb"], [path.join(imageDir, "system.img"), "image"]]) {
      diagnostics?.operation(operation);
      try { await access(file); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        throw Object.assign(new Error(`Missing Android prerequisite: ${file}. Provision tools and licenses explicitly.`),
          { diagnosticCode: "resource-unavailable" });
      }
    }
    diagnostics?.stage("lease", "start");
    lease = await (linux ? acquireLinuxEmulatorLease : acquireEmulatorLease)({
      workspace: root, runId, signal, timeoutMs: options.queueTimeoutMs,
      onWaiting: options.onWaiting,
    });
    Object.assign(identity, { leaseId: lease.id, ports: lease.ports,
      serial: `emulator-${lease.ports.console}`, avdName: `DevPocketCI_${runId.replaceAll("-", "")}` });
    await writeFile(path.join(directory, "owner.json"), JSON.stringify({ version: 1, root, runId, pid: process.pid }), { flag: "wx" });
    diagnostics?.stage("prepare", "start");
    await options.prepare?.(identity);
    diagnostics?.stage("avd", "start");
    const home = path.join(directory, "home"), avdHome = path.join(directory, "avd");
    const emulatorHome = path.join(directory, "emulator-home");
    await Promise.all([home, avdHome, emulatorHome].map((folder) => mkdir(folder)));
    const avd = path.join(avdHome, `${identity.avdName}.avd`);
    await mkdir(avd);
    const api = /android-(\d+)/.exec(image)[1];
    await writeFile(path.join(avdHome, `${identity.avdName}.ini`), `avd.ini.encoding=UTF-8\npath=${avd}\ntarget=android-${api}\n`);
    const gpu = windows ? "swiftshader_indirect" : "swiftshader";
    await writeFile(path.join(avd, "config.ini"), [
      `AvdId=${identity.avdName}`, `avd.ini.displayname=${identity.avdName}`, `abi.type=${architecture}`,
      `hw.cpu.arch=${architecture === "arm64-v8a" ? "arm64" : "x86_64"}`,
      "hw.cpu.ncore=4", "hw.ramSize=4096", "hw.lcd.width=1080", "hw.lcd.height=2400", "hw.lcd.density=420",
      "hw.keyboard=yes", "hw.mainKeys=no", "hw.gpu.enabled=yes", `hw.gpu.mode=${gpu}`,
      "disk.dataPartition.size=2G", `image.sysdir.1=${imageDir}${path.sep}`, "tag.id=google_apis",
      "showDeviceFrame=no", "fastboot.forceColdBoot=yes", "fastboot.forceFastBoot=no", "skin.dynamic=yes", "",
    ].join("\n"));
    const env = { ...process.env, ANDROID_HOME: emulatorSdk, ANDROID_SDK_ROOT: emulatorSdk,
      ANDROID_AVD_HOME: avdHome, ANDROID_EMULATOR_HOME: emulatorHome,
      ANDROID_USER_HOME: home, ANDROID_SDK_HOME: directory, HOME: home, USERPROFILE: home,
      ANDROID_ADB_SERVER_PORT: String(lease.ports.adb), ADB_SERVER_PORT: String(lease.ports.adb),
      ADB_SERVER_SOCKET: `tcp:${lease.ports.adb}` };
    const adbRun = async (args, timeoutMs = 30_000) => {
      if (closing) throw new Error("The emulator run is closing.");
      guard?.assertAlive();
      const command = args[0] === "shell"
        ? ["shell", ...args.slice(1).map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)] : args;
      try {
        return await runCommand(adb, ["-P", String(lease.ports.adb), "-s", identity.serial, ...command],
          { cwd: root, env, timeoutMs, signal: guard?.signal ?? signal });
      } catch (error) {
        if (error.processTreeStopped === false) commandCleanupUnconfirmed = true;
        throw error;
      }
    };
    diagnostics?.stage("acceleration", "verify");
    const acceleration = await runCommand(executable, ["-accel-check"], { env, timeoutMs: 30_000, signal });
    if (linux) identity.acceleration = linuxAcceleration(acceleration.stdout + acceleration.stderr);
    if (process.platform === "darwin") identity.acceleration = macOSAcceleration(acceleration.stdout + acceleration.stderr);
    await lease.handoff();
    diagnostics?.stage("adb", "start");
    const adbServer = manage(adb, ["-L", `tcp:${lease.ports.adb}`, "nodaemon", "server"], env, "adb");
    await waitForAndroid(() => ownsListener(lease.ports.adb, adbServer.child.pid, signal),
      "Owned ADB listener", 30_000, adbServer, signal);
    diagnostics?.stage("boot", "start");
    const emulator = manage(executable, ["-avd", identity.avdName, "-port", String(lease.ports.console),
      "-grpc", String(lease.ports.grpc), windows ? "-grpc-use-jwt" : "-grpc-use-token", "-no-window", "-no-audio",
      "-no-boot-anim", "-no-snapshot", "-no-metrics", "-show-kernel", "-gpu", gpu,
      ...(!windows ? ["-accel", "on"] : [])], env, "emulator");
    const bootDeadline = Date.now() + 600_000;
    guard = createLiveDeviceGuard([adbServer, emulator], async () => {
      if (!await ownsListener(lease.ports.adb, adbServer.child.pid, guard.signal)) {
        throw Object.assign(new Error("The leased ADB listener is no longer owned by this run."), { diagnosticCode: "ownership-mismatch" });
      }
      for (const port of [lease.ports.console, lease.ports.device, lease.ports.grpc]) {
        if (!await ownsListener(port, emulator.child.pid, guard.signal)) {
          throw Object.assign(new Error("A leased emulator listener is no longer owned by this run."), { diagnosticCode: "ownership-mismatch" });
        }
      }
      const observed = (await adbRun(["shell", "getprop", "ro.boot.qemu.avd_name"])).stdout.trim();
      if (observed !== identity.avdName) throw Object.assign(new Error("Emulator ownership mismatch; no application operation was attempted."),
        { diagnosticCode: "ownership-mismatch" });
      return observed;
    }, signal);
    await waitForAndroid(async () => (await adbRun(["shell", "getprop", "sys.boot_completed"], 10_000)).stdout.trim() === "1",
      "Emulator boot", Math.max(0, bootDeadline - Date.now()), emulator, guard.signal);
    diagnostics?.stage("ownership", "verify");
    const observed = await guard.verify();
    await writeFile(path.join(directory, "ownership.json"), JSON.stringify({
      expected: identity.avdName, observed, serial: identity.serial, adbPort: lease.ports.adb, leaseId: lease.id, ports: lease.ports,
    }));
    if (!linux) {
      diagnostics?.stage("boot", "window");
      try {
        const readiness = await waitForAndroidHome(adbRun, {
          deadline: bootDeadline, signal: guard.signal,
          observe: (state) => writeFile(path.join(directory, "home-readiness.json"), JSON.stringify({ runId, ...state })),
        });
        Object.assign(identity, { homeReadiness: readiness });
      } catch (error) {
        diagnostics?.fail(error);
        if (error.readinessReason === "launcher-anr") {
          for (const [name, args] of [
            ["home-anr", ["shell", "dumpsys", "dropbox", "--print", "system_app_anr"]],
            ["home-window", ["shell", "dumpsys", "window", "displays"]],
          ]) {
            try {
              const output = await adbRun(args, 10_000);
              await writeBoundedWorkerLog(path.join(directory, `${name}.log`), output.stdout + output.stderr);
            } catch (collectionError) {
              diagnostics?.issue("logcat", collectionError);
              error.diagnosticIssues = [...(error.diagnosticIssues ?? []),
                { operation: "logcat", ...failureDetails(collectionError, "collector-failed") }];
            }
          }
        }
        throw error;
      }
    }
    result = await operation({ ...identity, adb: adbRun, manage, verifyOwnership: guard.verify, signal: guard.signal });
    if (guard.failure) throw guard.failure;
  } catch (error) {
    failure = contextualFailure(error, signal);
    diagnostics?.fail(failure);
    failure.failedCase ??= diagnostics?.failedCase();
  } finally {
    closing = true;
    guard?.close();
    diagnostics?.stage("cleanup", "processes");
    // A worker can exit while another worker is being stopped.
    for (const state of processes) state.workerObservation?.markCleanup();
    const errors = commandCleanupUnconfirmed || failure?.processTreeStopped === false
      ? ["An owned command did not confirm process-tree cleanup."] : [];
    if (errors.length) diagnostics?.issue("cleanup", diagnosticError("cleanup-failed"));
    for (const state of processes.reverse()) {
      try {
        if (!state.settled) await stopOwnedProcess(state.child);
        await state.done;
        requireManagedCleanup(state);
      } catch (error) { errors.push(error.message); diagnostics?.issue("cleanup", error); }
    }
    try { await lease?.handoff(); }
    catch (error) { errors.push(error.message); diagnostics?.issue("cleanup", error); }
    if (!errors.length) {
      try {
        diagnostics?.operation("data");
        const cleaned = await cleanDeviceRun(root, directory, runId);
        if (lease && !cleaned) throw new Error("An acquired emulator lease lost its run owner record; cleanup is unconfirmed.");
      }
      catch (error) { errors.push(error.message); diagnostics?.issue("cleanup", error); }
      if (!errors.length) {
        try { diagnostics?.operation("lease"); await lease?.release(); }
        catch (error) { errors.push(error.message); diagnostics?.issue("cleanup", error); }
      }
    }
    if (errors.length) {
      failure ??= diagnosticError("cleanup-failed");
      failure.cleanupErrors = errors;
      diagnostics?.fail(failure);
    }
    for (const state of processes) {
      if (state.logError) diagnostics?.issue("worker-log", state.logError);
      if (state.nativeCaptureError) diagnostics?.issue("native-lifecycle", state.nativeCaptureError);
    }
    workerDiagnostics = managedWorkerDiagnostics(processes, runId, errors.length ? "failed" : "completed");
    if (failure) {
      failure.cleanup = errors.length ? "failed" : "completed";
      failure.runDirectory = directory;
      failure.runId = runId;
      failure.workerDiagnostics = workerDiagnostics;
      if (diagnostics) failure.deviceDiagnostics = diagnostics.snapshot();
    }
  }
  if (failure) throw failure;
  return { result, identity, cleanup: "completed", workerDiagnostics };
}
