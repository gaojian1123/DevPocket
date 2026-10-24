import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { withAndroidEmulator } from "./android-emulator.mjs";
import { runNativeLayouts } from "./android-runner.mjs";
import { runCommand } from "./process.mjs";
import { sourceSnapshot } from "./verification.mjs";
import { localPipe } from "./local-ipc.mjs";

const controllerPipe = (runId) => localPipe(`devpocket-manual-emulator-${runId}`);
const pathKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;

export async function openManualControl(device, { layouts, stop, signal, validate } = {}) {
  let stopping = false, finished = false, busy, stopReady;
  const sockets = new Set(), stopReplies = new Set();
  const stopped = new Promise((resolve) => { stopReady = resolve; });
  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    stopReady();
    stop?.();
  };
  const response = (socket, value) => {
    socket.end(JSON.stringify({ version: 1, runId: device.runId, ...value }) + "\n");
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); stopReplies.delete(socket); });
    socket.on("error", () => socket.destroy());
    socket.setTimeout(30 * 60_000, () => socket.destroy());
    let buffer = "", received = false;
    socket.on("data", (bytes) => {
      if (received) return;
      buffer += bytes.toString();
      if (buffer.length > 4096) { received = true; response(socket, { status: "rejected", reason: "Request exceeds its bound." }); return; }
      if (!buffer.includes("\n")) return;
      received = true;
      let input;
      try {
        input = JSON.parse(buffer.trim());
        if (!input || input.version !== 1 || input.runId !== device.runId ||
            typeof input.root !== "string" || pathKey(path.resolve(input.root)) !== pathKey(device.root) ||
            Object.keys(input).some((key) => !["version", "runId", "root", "command"].includes(key)) ||
            !["status", "layouts", "stop"].includes(input.command)) throw new Error("Manual emulator ownership or command mismatch.");
      } catch (error) { response(socket, { status: "rejected", reason: error.message }); return; }
      if (input.command === "status") {
        Promise.resolve().then(validate).then(
          () => response(socket, { status: stopping ? "stopping" : busy ? "testing" : "ready", ports: device.ports }),
          (error) => { response(socket, { status: "failed", reason: error.message }); requestStop(); },
        );
      } else if (input.command === "stop") {
        stopReplies.add(socket);
        requestStop();
      } else if (stopping || busy) {
        response(socket, { status: "rejected", reason: "This owned emulator is stopping or already running a manual operation." });
      } else {
        busy = Promise.resolve().then(validate).then(layouts).then(
          (result) => response(socket, result),
          (error) => response(socket, { status: "failed", reason: error.message }),
        ).finally(() => { busy = undefined; });
      }
    });
  });
  server.maxConnections = 8;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(controllerPipe(device.runId), () => { server.removeListener("error", reject); resolve(); });
  });
  signal?.addEventListener("abort", requestStop, { once: true });
  if (signal?.aborted) requestStop();
  try {
    await writeFile(path.join(device.directory, "manual.json"), JSON.stringify({
      version: 1, root: device.root, runId: device.runId, leaseId: device.leaseId,
      pipe: controllerPipe(device.runId), serial: device.serial, avdName: device.avdName, ports: device.ports,
    }, null, 2), { flag: "wx", mode: 0o600 });
  } catch (error) {
    signal?.removeEventListener("abort", requestStop);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return {
    stopping: stopped,
    drain: async () => { await busy; },
    finish: async (result) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", requestStop);
      for (const socket of stopReplies) response(socket, result);
      for (const socket of sockets) if (!stopReplies.has(socket)) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export async function requestManualEmulator({ root = process.cwd(), directory, command, timeoutMs = 30 * 60_000 }) {
  root = path.resolve(root);
  if (!directory) throw new Error("Specify the owned run directory printed by start-test-emulator.ps1.");
  directory = path.resolve(root, directory);
  if (!path.relative(root, directory).startsWith(`.data${path.sep}`)) throw new Error("The run must belong to this checkout.");
  if (pathKey(await realpath(directory)) !== pathKey(directory)) throw new Error("Linked manual run directories are unsupported.");
  const owner = JSON.parse(await readFile(path.join(directory, "manual.json"), "utf8"));
  if (owner.version !== 1 || typeof owner.root !== "string" || pathKey(owner.root) !== pathKey(root) ||
      !/^[a-f0-9-]{36}$/.test(owner.runId) || owner.pipe !== controllerPipe(owner.runId)) {
    throw new Error("The manual run does not belong to this worktree.");
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect(owner.pipe);
    let buffer = "", settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(message));
    };
    socket.setTimeout(timeoutMs, () => fail("Manual operation timed out; its result is unconfirmed and will not be replayed."));
    socket.once("error", () => fail("The exact manual controller is unavailable; no other emulator was selected."));
    socket.once("connect", () => socket.write(JSON.stringify({ version: 1, root, runId: owner.runId, command }) + "\n"));
    socket.on("data", (bytes) => {
      buffer += bytes.toString();
      if (buffer.length > 64 * 1024) fail("Manual response exceeded its supported bound.");
    });
    socket.once("end", () => {
      if (settled) return;
      try {
        const result = JSON.parse(buffer);
        if (result.version !== 1 || result.runId !== owner.runId || typeof result.status !== "string") {
          throw new Error("Invalid manual controller response.");
        }
        if (["failed", "rejected", "blocked"].includes(result.status)) throw new Error(result.reason ?? "Manual operation failed.");
        const supported = command === "layouts" ? result.status === "passed" && Number.isInteger(result.tests) && result.tests > 0
          : command === "stop" ? result.status === "stopped" && result.cleanup === "completed"
          : command === "status" && ["ready", "testing", "stopping"].includes(result.status);
        if (!supported) throw new Error("Invalid or unsupported manual operation acknowledgement.");
        settled = true;
        socket.destroy();
        resolve(result);
      } catch (error) { fail(error.message); }
    });
  });
}

export async function startManualEmulator(options) {
  const cancellation = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
  let controller, deviceDirectory, report;
  try {
    const finished = await withAndroidEmulator({ ...options, signal }, async (device) => {
      deviceDirectory = device.directory;
      controller = await openManualControl(device, {
        signal: device.signal, validate: device.verifyOwnership, stop: () => cancellation.abort(new Error("Manual stop requested.")),
        layouts: async () => {
          const directory = path.join(device.directory, "operations", randomUUID());
          await mkdir(directory, { recursive: true });
          const source = await sourceSnapshot(device.root);
          const output = await runCommand("pwsh", ["-NoProfile", "-NonInteractive", "-File",
            path.join(device.root, "scripts", "build-android.ps1"), "-Jdk", device.jdk, "-Sdk", device.sdk, "-Instrumentation"],
          { cwd: device.root, timeoutMs: 20 * 60_000, signal: device.signal });
          await writeFile(path.join(directory, "build.log"), output.stdout + output.stderr, { mode: 0o600 });
          const apk = path.join(device.root, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
          const testApk = path.join(device.root, "android", "app", "build", "outputs", "apk", "androidTest", "debug", "app-debug-androidTest.apk");
          const sha = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
          const apkSha256 = await sha(apk), testApkSha256 = await sha(testApk);
          await device.verifyOwnership();
          for (const file of [apk, testApk]) await device.adb(["install", "-r", file], 120_000);
          await device.adb(["shell", "input", "keyevent", "82"]);
          await device.adb(["shell", "settings", "put", "secure", "show_ime_with_hard_keyboard", "1"]);
          const cases = await runNativeLayouts(device, { directory });
          const final = await sourceSnapshot(device.root);
          if (JSON.stringify(final) !== JSON.stringify(source) || await sha(apk) !== apkSha256 || await sha(testApk) !== testApkSha256) {
            throw new Error("Source or APK inputs changed during manual validation.");
          }
          const result = { status: "passed", evidence: "manual-layouts", source, apkSha256, testApkSha256,
            tests: cases.reduce((count, item) => count + item.tests, 0), cases, directory };
          await writeFile(path.join(directory, "layout-report.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
          return result;
        },
      });
      console.log(`Owned manual emulator ready. Run directory: ${device.directory}`);
      console.log("Use test-native-layouts.ps1 or stop-test-emulator.ps1 with that exact -RunDirectory.");
      await controller.stopping;
      await controller.drain();
    });
    report = { status: "stopped", cleanup: finished.cleanup, runId: finished.identity.runId };
  } catch (error) {
    report = { status: "failed", reason: error.message, cleanup: error.cleanup ?? "not_started", runId: error.runId };
    deviceDirectory ??= error.runDirectory;
  } finally {
    try {
      if (deviceDirectory) await writeFile(path.join(deviceDirectory, "manual-report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    } catch (error) {
      report = { ...report, status: "failed", reason: `Could not persist the manual result: ${error.message}` };
    } finally { await controller?.finish(report); }
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: "string" }, directory: { type: "string" }, sdk: { type: "string" }, jdk: { type: "string" },
    image: { type: "string" }, "emulator-sdk": { type: "string" }, "queue-timeout": { type: "string" },
    visible: { type: "boolean", default: false },
  } });
  const command = positionals[0];
  if (positionals.length !== 1 || !["start", "layouts", "stop", "status"].includes(command)) {
    throw new Error("Use start, or layouts/stop/status --directory OWNED_RUN_DIRECTORY.");
  }
  let result;
  if (command === "start") {
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("Manual emulator cancelled."));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    result = await startManualEmulator({
      ...values, emulatorSdk: values["emulator-sdk"], signal: controller.signal,
      queueTimeoutMs: values["queue-timeout"] === undefined ? undefined : Number(values["queue-timeout"]) * 1000,
      onWaiting: (status) => console.log(`Waiting for emulator slot ${status.position}; ${status.active}/${status.limit} active.`),
    });
  } else result = await requestManualEmulator({ root: values.repo, directory: values.directory, command });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "failed") process.exitCode = 1;
}
