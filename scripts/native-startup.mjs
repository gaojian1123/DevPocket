import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { prepareAndroidRuntime } from "./android-runner.mjs";
import { withAndroidEmulator } from "./android-emulator.mjs";
import { projectWorkerDiagnostics } from "./worker-diagnostics.mjs";
import { sourceSnapshot, verificationPlan } from "./verification.mjs";
import { runCommand } from "./process.mjs";
import { cleanDeviceRun } from "./device-run.mjs";

function requireHostedLinux() {
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true" ||
      process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("Native startup diagnostics require the explicitly selected hosted Linux job.");
  }
}

async function binaryHash(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

async function availableBytes(directory) {
  try {
    const value = await statfs(directory);
    const bytes = value.bavail * value.bsize;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : "unknown";
  } catch {
    return "unknown";
  }
}

export function projectStartupReport(value) {
  const hash = (input, length) => typeof input === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(input) ? input : "unknown";
  const count = (input) => Number.isSafeInteger(input) && input >= 0 ? input : "unknown";
  const version = (input) => typeof input === "string" && /^[0-9][A-Za-z0-9._+-]{0,63}$/.test(input) &&
    !/gh[pousr]_|github_pat_|token|secret|password|bearer/i.test(input) ? input : "unknown";
  const head = hash(value?.source?.head, 40), fingerprint = hash(value?.source?.fingerprint, 64);
  return {
    version: 1, kind: "native-startup-diagnostic", acceptance: false,
    runId: typeof value?.runId === "string" && /^[a-f0-9-]{36}$/.test(value.runId) ? value.runId : "unknown",
    base: hash(value?.base, 40),
    source: head !== "unknown" && fingerprint !== "unknown" ? { head, fingerprint } : null,
    variant: ["same-build", "without-build"].includes(value?.variant) ? value.variant : "unknown",
    phase: ["prepare", "launch", "ready"].includes(value?.phase) ? value.phase : "unknown",
    status: ["ready", "failed", "blocked", "incomplete"].includes(value?.status) ? value.status : "unknown",
    nativeReadiness: typeof value?.nativeReadiness === "boolean" ? value.nativeReadiness : "unknown",
    cleanup: ["completed", "failed"].includes(value?.cleanup) ? value.cleanup : "unknown",
    failureCategory: ["preparation-failed", "worker-readiness-failed", "source-changed"].includes(value?.failureCategory)
      ? value.failureCategory : "unknown",
    availableDiskBytes: {
      beforePreparation: count(value?.availableDiskBytes?.beforePreparation),
      afterPreparation: count(value?.availableDiskBytes?.afterPreparation),
    },
    binaryHashes: { emulator: hash(value?.binaryHashes?.emulator, 64), adb: hash(value?.binaryHashes?.adb, 64) },
    toolchain: Object.fromEntries(["java", "adb", "emulator", "imageRevision"].map((name) => [name, version(value?.toolchain?.[name])])),
    image: typeof value?.image === "string" && /^system-images[\\/]android-\d+(?:\.\d+)?[\\/](?:google_apis(?:_playstore)?|default)[\\/]x86_64$/.test(value.image)
      ? value.image : "unknown",
    apkSha256: hash(value?.apkSha256, 64),
    testApkSha256: hash(value?.testApkSha256, 64),
    acceleration: value?.acceleration?.provider === "KVM" && value.acceleration.usable === true
      ? { provider: "KVM", usable: true } : "unknown",
    workerDiagnostics: projectWorkerDiagnostics(value?.workerDiagnostics, value?.runId),
  };
}

export async function runNativeStartup(options) {
  requireHostedLinux();
  const variant = options.variant ?? "same-build";
  if (!["same-build", "without-build"].includes(variant)) throw new Error("Unknown startup experiment variant.");
  const root = process.cwd(), directory = path.resolve(root, options.directory);
  const plan = await verificationPlan(root, options.base);
  const report = {
    version: 1, kind: "native-startup-diagnostic", acceptance: false,
    runId: options.owner ?? randomUUID(), base: plan.base, source: plan.source, variant,
    phase: "prepare", status: "blocked", nativeReadiness: false,
    availableDiskBytes: { beforePreparation: "unknown", afterPreparation: "unknown" },
  };
  try {
    const completed = await withAndroidEmulator({
      ...options, repo: root, directory, owner: report.runId,
      prepare: async (identity) => {
        report.availableDiskBytes.beforePreparation = await availableBytes(directory);
        report.binaryHashes = {
          emulator: await binaryHash(identity.executable),
          adb: await binaryHash(identity.adbPath),
        };
        await prepareAndroidRuntime(identity, report, options.signal, { buildApks: variant === "same-build" });
        report.availableDiskBytes.afterPreparation = await availableBytes(directory);
        report.phase = "launch";
      },
    }, async (device) => {
      if (device.acceleration?.provider !== "KVM" || device.acceleration.usable !== true) {
        throw new Error("Startup readiness lacks confirmed KVM acceleration.");
      }
      report.phase = "ready";
      report.nativeReadiness = true;
      report.acceleration = device.acceleration;
    });
    report.cleanup = completed.cleanup;
    report.workerDiagnostics = projectWorkerDiagnostics(completed.workerDiagnostics, report.runId);
    report.status = report.workerDiagnostics.workers.length === 2 &&
      report.workerDiagnostics.workers.every((worker) => worker.nativeLifecycle.availability === "complete" &&
        worker.workerLog.status === "retained")
      ? "ready" : "incomplete";
  } catch (error) {
    if (error.runDirectory !== directory) throw error;
    report.status = options.signal?.aborted ? "blocked" : "failed";
    report.cleanup = ["completed", "failed"].includes(error.cleanup) ? error.cleanup : "unknown";
    report.workerDiagnostics = projectWorkerDiagnostics(error.workerDiagnostics, report.runId);
    report.failureCategory = report.phase === "prepare" ? "preparation-failed" : "worker-readiness-failed";
  }
  const current = await sourceSnapshot(root);
  if (current.head !== report.source.head || current.fingerprint !== report.source.fingerprint) {
    report.status = "blocked";
    report.failureCategory = "source-changed";
  }
  const projected = projectStartupReport(report);
  const bytes = JSON.stringify(projected, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > 16384) throw new Error("Startup diagnostic projection exceeded its output budget.");
  await writeFile(path.join(directory, "startup-report.json"), bytes, { flag: "wx", mode: 0o600 });
  return projected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    base: { type: "string" }, directory: { type: "string" }, variant: { type: "string" },
    sdk: { type: "string" }, jdk: { type: "string" }, image: { type: "string" },
    owner: { type: "string" }, execute: { type: "boolean", default: false },
    "emulator-sdk": { type: "string" }, "queue-timeout": { type: "string" },
  } });
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error("Startup diagnostic cancelled."));
  const input = (bytes) => { if (bytes.toString().trim() === "cancel") cancel(); };
  process.stdin.on("data", input);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    requireHostedLinux();
    if (!values.base || !values.directory || !["same-build", "without-build"].includes(values.variant ?? "same-build")) {
      throw new Error("Startup diagnostics require a base, run directory and known variant.");
    }
    if (values.execute) {
      const report = await runNativeStartup({ ...values, signal: cancellation.signal,
        emulatorSdk: values["emulator-sdk"],
        queueTimeoutMs: values["queue-timeout"] === undefined ? undefined : Number(values["queue-timeout"]) * 1000 });
      console.log(JSON.stringify(report));
      if (report.status !== "ready") process.exitCode = 1;
    } else {
      const root = process.cwd(), directory = path.resolve(root, values.directory);
      if (!path.relative(root, directory).startsWith(`.data${path.sep}`)) throw new Error("Unscoped startup report directory.");
      const owner = randomUUID();
      const args = ["-NoProfile", "-NonInteractive", "-File", path.join(root, "scripts", "test-android.ps1"),
        "-StartupDiagnostic", "-Base", values.base, "-Variant", values.variant ?? "same-build",
        "-RunDirectory", directory, "-Owner", owner];
      for (const [name, value] of [["Jdk", values.jdk], ["Sdk", values.sdk], ["Image", values.image],
        ["EmulatorSdk", values["emulator-sdk"]], ["QueueTimeoutSeconds", values["queue-timeout"]]]) {
        if (value) args.push(`-${name}`, value);
      }
      try {
        await runCommand("pwsh", args, { cwd: root, timeoutMs: 30 * 60_000, graceMs: 30000, signal: cancellation.signal });
        console.log("Native startup diagnostic entry completed; inspect the scoped startup report, not an acceptance result.");
      } catch (error) {
        if (error.processTreeStopped) await cleanDeviceRun(root, directory, owner);
        console.error(JSON.stringify({ kind: "native-startup-entry", status: "failed",
          exitCode: Number.isInteger(error.code) ? error.code : "unknown", acceptance: false }));
        process.exitCode = 1;
      }
    }
  } catch {
    console.error("Native startup diagnostic failed before a complete bounded report was available.");
    process.exitCode = 1;
  } finally {
    process.stdin.off("data", input);
    process.stdin.pause();
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
