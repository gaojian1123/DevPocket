import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommand, spawnOwnedCommand, stopOwnedProcess } from "./process.mjs";
import { cleanDeviceRun } from "./device-run.mjs";
import { acquireEmulatorLease } from "./emulator-resources.mjs";
import { acquireLinuxEmulatorLease, linuxAcceleration, ownsLinuxListener } from "./linux-emulator.mjs";
import { createWorkerObservation, projectWorkerDiagnostics } from "./worker-diagnostics.mjs";

export function createLiveDeviceGuard(workers, inspect, signal) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const invalidate = (error = new Error("An owned emulator or ADB worker exited.")) => {
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
  const observation = ["adb", "emulator"].includes(role) ? createWorkerObservation(role, signal) : undefined;
  const state = { child, settled: false, error: undefined, done: undefined,
    requiresCleanupConfirmation: platform === "linux", cleanupConfirmed: false, workerObservation: observation };
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  child.stderr.on("data", (bytes) => {
    tail = (tail + bytes.toString()).slice(-4096);
    observation?.stderr(bytes);
  });
  child.once("exit", (code, exitSignal) => observation?.exit(code, exitSignal));
  child.once("error", (error) => { state.error = error; });
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") state.error = error; });
  state.done = new Promise((resolve) => child.once("close", () => {
    state.settled = true;
    state.cleanupConfirmed = tail.trimEnd().split(/\r?\n/).at(-1) === "DEVPOCKET_OWNED_TREE_STOPPED";
    output.end(resolve);
  }));
  return state;
}

export function requireManagedCleanup(state) {
  if (state.requiresCleanupConfirmation && !state.cleanupConfirmed) {
    throw new Error("Linux owned-process cleanup was not confirmed; retaining its data and lease.");
  }
}

export async function waitForAndroid(check, label, timeoutMs, processState, signal) {
  const deadline = Date.now() + timeoutMs;
  let last = "not ready";
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (processState?.settled) throw new Error(`${label}: owned process exited before readiness.`);
    try { if (await check()) return; }
    catch (error) { last = `${error.message} ${(error.stderr ?? "").trim()}`; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out: ${last}`);
}

async function ownsListener(port, rootPid, signal) {
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
  if (!["win32", "linux"].includes(process.platform)) throw new Error("Android emulator coordination requires Windows or Linux.");
  const linux = process.platform === "linux";
  const root = path.resolve(options.repo ?? process.cwd());
  const directory = path.resolve(root, options.directory ?? path.join(".data", "android-runs", randomUUID()));
  const runId = options.owner ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid device run owner.");
  await createRunDirectory(root, directory);
  const processes = [];
  let lease, failure, result, guard, workerDiagnostics, closing = false;
  const signal = options.signal;
  const sdk = path.resolve(options.sdk ?? process.env.DEVPOCKET_ANDROID_SDK ?? path.join(root, ".tools", "android-sdk"));
  const emulatorSdk = path.resolve(options.emulatorSdk ?? process.env.DEVPOCKET_EMULATOR_SDK ?? sdk);
  const jdk = path.resolve(options.jdk ?? process.env.DEVPOCKET_JDK ?? path.join(root, ".tools", "jdk-21"));
  const image = (options.image ?? process.env.DEVPOCKET_ANDROID_IMAGE ??
    path.join("system-images", "android-35", "google_apis", "x86_64")).replaceAll("\\", path.sep);
  const identity = { root, directory, runId, sdk, emulatorSdk, jdk, image };
  const manage = (file, args, env, name) => {
    if (closing) throw new Error("The emulator run is closing.");
    const output = createWriteStream(path.join(directory, `${name}.log`), { flags: "wx", mode: 0o600 });
    const child = spawnOwnedCommand(file, args, { cwd: root, env, timeoutMs: 24 * 60 * 60_000, persistent: true });
    const state = trackManagedCommand(child, output, process.platform, { role: name, signal });
    processes.push(state);
    return state;
  };
  try {
    if (!/^system-images[\\/]android-\d+(?:\.\d+)?[\\/](?:google_apis(?:_playstore)?|default)[\\/]x86_64$/.test(image)) {
      throw new Error("Image must name an installed x86_64 SDK system-image directory.");
    }
    const imageDir = path.resolve(emulatorSdk, image);
    const executable = path.join(emulatorSdk, "emulator", linux ? "emulator" : "emulator.exe");
    const adb = path.join(emulatorSdk, "platform-tools", linux ? "adb" : "adb.exe");
    const javaPath = path.join(jdk, "bin", linux ? "java" : "java.exe");
    Object.assign(identity, { imageDir, executable, adbPath: adb, javaPath });
    for (const file of [executable, adb, path.join(imageDir, "system.img")]) {
      try { await access(file); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        throw new Error(`Missing Android prerequisite: ${file}. Provision tools and licenses explicitly.`);
      }
    }
    lease = await (linux ? acquireLinuxEmulatorLease : acquireEmulatorLease)({
      workspace: root, runId, signal, timeoutMs: options.queueTimeoutMs,
      onWaiting: options.onWaiting,
    });
    Object.assign(identity, { leaseId: lease.id, ports: lease.ports,
      serial: `emulator-${lease.ports.console}`, avdName: `DevPocketCI_${runId.replaceAll("-", "")}` });
    await writeFile(path.join(directory, "owner.json"), JSON.stringify({ version: 1, root, runId, pid: process.pid }), { flag: "wx" });
    await options.prepare?.(identity);
    const home = path.join(directory, "home"), avdHome = path.join(directory, "avd");
    const emulatorHome = path.join(directory, "emulator-home");
    await Promise.all([home, avdHome, emulatorHome].map((folder) => mkdir(folder)));
    const avd = path.join(avdHome, `${identity.avdName}.avd`);
    await mkdir(avd);
    const api = /android-(\d+)/.exec(image)[1];
    await writeFile(path.join(avdHome, `${identity.avdName}.ini`), `avd.ini.encoding=UTF-8\npath=${avd}\ntarget=android-${api}\n`);
    const gpu = linux ? "swiftshader" : "swiftshader_indirect";
    await writeFile(path.join(avd, "config.ini"), [
      `AvdId=${identity.avdName}`, `avd.ini.displayname=${identity.avdName}`, "abi.type=x86_64", "hw.cpu.arch=x86_64",
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
      return runCommand(adb, ["-P", String(lease.ports.adb), "-s", identity.serial, ...command],
        { cwd: root, env, timeoutMs, signal: guard?.signal ?? signal });
    };
    const acceleration = await runCommand(executable, ["-accel-check"], { env, timeoutMs: 30_000, signal });
    if (linux) identity.acceleration = linuxAcceleration(acceleration.stdout + acceleration.stderr);
    await lease.handoff();
    const adbServer = manage(adb, ["-L", `tcp:${lease.ports.adb}`, "nodaemon", "server"], env, "adb");
    await waitForAndroid(() => ownsListener(lease.ports.adb, adbServer.child.pid, signal),
      "Owned ADB listener", 30_000, adbServer, signal);
    const emulator = manage(executable, ["-avd", identity.avdName, "-port", String(lease.ports.console),
      "-grpc", String(lease.ports.grpc), linux ? "-grpc-use-token" : "-grpc-use-jwt", "-no-window", "-no-audio",
      "-no-boot-anim", "-no-snapshot", "-no-metrics", "-show-kernel", "-gpu", gpu,
      ...(linux ? ["-accel", "on"] : [])], env, "emulator");
    guard = createLiveDeviceGuard([adbServer, emulator], async () => {
      if (!await ownsListener(lease.ports.adb, adbServer.child.pid, guard.signal)) {
        throw new Error("The leased ADB listener is no longer owned by this run.");
      }
      for (const port of [lease.ports.console, lease.ports.device, lease.ports.grpc]) {
        if (!await ownsListener(port, emulator.child.pid, guard.signal)) {
          throw new Error("A leased emulator listener is no longer owned by this run.");
        }
      }
      const observed = (await adbRun(["shell", "getprop", "ro.boot.qemu.avd_name"])).stdout.trim();
      if (observed !== identity.avdName) throw new Error("Emulator ownership mismatch; no application operation was attempted.");
      return observed;
    }, signal);
    await waitForAndroid(async () => (await adbRun(["shell", "getprop", "sys.boot_completed"], 10_000)).stdout.trim() === "1",
      "Emulator boot", 600_000, emulator, guard.signal);
    const observed = await guard.verify();
    await writeFile(path.join(directory, "ownership.json"), JSON.stringify({
      expected: identity.avdName, observed, serial: identity.serial, adbPort: lease.ports.adb, leaseId: lease.id, ports: lease.ports,
    }));
    result = await operation({ ...identity, adb: adbRun, manage, verifyOwnership: guard.verify, signal: guard.signal });
    if (guard.failure) throw guard.failure;
  } catch (error) {
    failure = error;
  } finally {
    closing = true;
    guard?.close();
    // A worker can exit while another worker is being stopped.
    for (const state of processes) state.workerObservation?.markCleanup();
    const errors = [];
    for (const state of processes.reverse()) {
      try {
        if (!state.settled) await stopOwnedProcess(state.child);
        await state.done;
        requireManagedCleanup(state);
      } catch (error) { errors.push(error.message); }
    }
    if (!errors.length) {
      try { await cleanDeviceRun(root, directory, runId); }
      catch (error) { errors.push(error.message); }
      try { await lease?.release(); }
      catch (error) { errors.push(error.message); }
    }
    if (errors.length) {
      failure ??= new Error("Emulator cleanup did not complete.");
      failure.cleanupErrors = errors;
    }
    workerDiagnostics = projectWorkerDiagnostics({
      runId, cleanup: errors.length ? "failed" : "completed",
      workers: processes.flatMap((state) => state.workerObservation ? [state.workerObservation.snapshot()] : []),
    });
    if (failure) {
      failure.cleanup = errors.length ? "failed" : "completed";
      failure.runDirectory = directory;
      failure.runId = runId;
      failure.workerDiagnostics = workerDiagnostics;
    }
  }
  if (failure) throw failure;
  return { result, identity, cleanup: "completed", workerDiagnostics };
}
