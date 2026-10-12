import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { prepareAndroidRuntime } from "./android-runner.mjs";
import { withAndroidEmulator } from "./android-emulator.mjs";
import { projectWorkerDiagnostics, readDiagnosticReport } from "./worker-diagnostics.mjs";
import { sourceSnapshot, verificationPlan, requirePlanCollection } from "./verification.mjs";
import { runCommand } from "./process.mjs";
import { cleanDeviceRun } from "./device-run.mjs";
import { createDeviceDiagnostics, deviceSourceCatalogue, projectDeviceDiagnostics } from "./device-diagnostics.mjs";
import { diagnosticError, failureDetails, projectFailureDetails, diagnosticVersion } from "./diagnostic-errors.mjs";
import { publishStartupOwner } from "./diagnostic-publication.mjs";
const fallbackPrefix = "DEVPOCKET_STARTUP_DIAGNOSTIC ";

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

export async function availableBytes(directory, diagnostics, operation, inspect = statfs) {
  try {
    const value = await inspect(directory);
    const bytes = value.bavail * value.bsize;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : "unknown";
  } catch (error) {
    if (!["ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) diagnostics.issue(operation, error);
    return "unknown";
  }
}

export function projectStartupReport(value, catalogue = { files: [], fingerprint: "unknown" }) {
  const hash = (input, length) => typeof input === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(input) ? input : "unknown";
  const count = (input) => Number.isSafeInteger(input) && input >= 0 ? input : "unknown";
  const version = (input) => diagnosticVersion(input) ?? "unknown";
  const head = hash(value?.source?.head, 40), fingerprint = hash(value?.source?.fingerprint, 64);
  const workerDiagnostics = projectWorkerDiagnostics(value?.workerDiagnostics, value?.runId);
  const deviceDiagnostics = projectDeviceDiagnostics(value?.deviceDiagnostics, catalogue, value?.runId);
  const collectionStatus = value?.collectionStatus === "failed" || value?.planningCollectionFailure ||
    workerDiagnostics.collectionStatus === "failed" || deviceDiagnostics.collectionStatus === "failed"
    ? "failed" : workerDiagnostics.collectionStatus === "completed" && deviceDiagnostics.collectionStatus === "completed"
      ? "completed" : "unknown";
  const status = ["ready", "failed", "blocked", "incomplete"].includes(value?.status) ? value.status : "unknown";
  return {
    version: 1, kind: "native-startup-diagnostic", acceptance: false,
    runId: typeof value?.runId === "string" && /^[a-f0-9-]{36}$/.test(value.runId) ? value.runId : "unknown",
    base: hash(value?.base, 40),
    source: head !== "unknown" && fingerprint !== "unknown" ? { head, fingerprint } : null,
    variant: ["same-build", "without-build"].includes(value?.variant) ? value.variant : "unknown",
    phase: ["plan", "prepare", "launch", "ready"].includes(value?.phase) ? value.phase : "unknown",
    status: status === "ready" && collectionStatus === "failed" ? "incomplete" : status,
    executionStatus: value?.nativeReadiness === true ? "ready" : ["failed", "blocked"].includes(status) ? status : "unknown",
    collectionStatus,
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
    workerDiagnostics, deviceDiagnostics,
    sourceValidation: value?.sourceValidation?.status === "failed"
      ? { status: "failed", phase: "source-validation", failure: projectFailureDetails(value.sourceValidation.failure) } : null,
    reportFailure: value?.reportFailure ? projectFailureDetails(value.reportFailure) : null,
    planningCollectionFailure: value?.planningCollectionFailure ? projectFailureDetails(value.planningCollectionFailure) : null,
  };
}

export async function publishStartupReport(report, directory, diagnostics, primaryFailure) {
  try {
    const projected = projectStartupReport(report, diagnostics.catalogue);
    const bytes = JSON.stringify(projected, null, 2) + "\n";
    if (Buffer.byteLength(bytes) > 16384) throw diagnosticError("output-limit");
    await writeFile(path.join(directory, "startup-report.json"), bytes, { flag: "wx", mode: 0o600 });
    return projected;
  } catch (error) {
    diagnostics.issue("report", error);
    report.reportFailure = failureDetails(error, "report-write");
    if (report.status === "ready") report.status = "blocked";
    report.deviceDiagnostics = diagnostics.finish(report.status === "failed" ? "failed" : "blocked");
    const failure = primaryFailure ?? diagnosticError("report-write", error);
    failure.startupReport = projectStartupReport(report, diagnostics.catalogue);
    throw failure;
  }
}

export async function prepareStartupPlan(root, base, runId, variant) {
  const plan = await verificationPlan(root, base);
  try { requirePlanCollection(plan); }
  catch (error) {
    error.startupReport = projectStartupReport({
      version: 1, runId, base: plan.base, source: plan.source, variant,
      status: "blocked", phase: "plan", nativeReadiness: false,
      planningCollectionFailure: plan.deviceClassCatalogueFailure,
    });
    throw error;
  }
  return plan;
}

export async function runNativeStartup(options) {
  requireHostedLinux();
  const variant = options.variant ?? "same-build";
  if (!["same-build", "without-build"].includes(variant)) throw new Error("Unknown startup experiment variant.");
  const root = process.cwd(), directory = path.resolve(root, options.directory);
  const owner = options.owner ?? randomUUID();
  const plan = await prepareStartupPlan(root, options.base, owner, variant);
  const report = {
    version: 1, kind: "native-startup-diagnostic", acceptance: false,
    runId: owner, base: plan.base, source: plan.source, variant,
    phase: "prepare", status: "blocked", nativeReadiness: false,
    availableDiskBytes: { beforePreparation: "unknown", afterPreparation: "unknown" },
  };
  const diagnostics = await createDeviceDiagnostics({ root, runId: report.runId });
  let primaryFailure;
  try {
    const completed = await withAndroidEmulator({
      ...options, repo: root, directory, owner: report.runId, diagnostics,
      prepare: async (identity) => {
        report.availableDiskBytes.beforePreparation = await availableBytes(directory, diagnostics, "capacity-before-prepare");
        report.binaryHashes = {
          emulator: await binaryHash(identity.executable),
          adb: await binaryHash(identity.adbPath),
        };
        await prepareAndroidRuntime(identity, report, options.signal, { buildApks: variant === "same-build", diagnostics });
        report.availableDiskBytes.afterPreparation = await availableBytes(directory, diagnostics, "capacity-after-prepare");
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
    primaryFailure = error;
    report.status = options.signal?.aborted ? "blocked" : "failed";
    report.cleanup = ["completed", "failed"].includes(error.cleanup) ? error.cleanup : "unknown";
    report.workerDiagnostics = projectWorkerDiagnostics(error.workerDiagnostics, report.runId);
    report.failureCategory = report.phase === "prepare" ? "preparation-failed" : "worker-readiness-failed";
  }
  try {
    const current = await sourceSnapshot(root);
    if (current.head !== report.source.head || current.fingerprint !== report.source.fingerprint) {
      report.status = "blocked";
      report.failureCategory = "source-changed";
    }
  } catch (error) {
    error.diagnosticCode = "source-unavailable";
    report.sourceValidation = { status: "failed", failure: failureDetails(error) };
    if (report.status !== "failed") report.status = "blocked";
    diagnostics.issue("report", error);
  }
  report.deviceDiagnostics = diagnostics.finish(report.status === "ready" ? "passed" : report.status === "failed" ? "failed" : "blocked");
  return publishStartupReport(report, directory, diagnostics, primaryFailure);
}

export async function runStartupEntry(options, { run = runCommand, cleanup = cleanDeviceRun } = {}) {
  const root = path.resolve(options.root ?? process.cwd()), directory = path.resolve(root, options.directory);
  if (!path.relative(root, directory).startsWith(`.data${path.sep}`)) throw diagnosticError("ownership-mismatch");
  const owner = randomUUID();
  if (options.github) await publishStartupOwner(owner);
  const args = ["-NoProfile", "-NonInteractive", "-File", path.join(root, "scripts", "test-android.ps1"),
    "-StartupDiagnostic", "-Base", options.base, "-Variant", options.variant ?? "same-build",
    "-RunDirectory", directory, "-Owner", owner];
  for (const [name, value] of [["Jdk", options.jdk], ["Sdk", options.sdk], ["Image", options.image],
    ["EmulatorSdk", options["emulator-sdk"]], ["QueueTimeoutSeconds", options["queue-timeout"]]]) {
    if (value) args.push(`-${name}`, value);
  }
  try {
    await run("pwsh", args, { cwd: root, timeoutMs: 30 * 60_000, graceMs: 30000, signal: options.signal });
    return { kind: "native-startup-entry", status: "completed", acceptance: false, runId: owner };
  } catch (error) {
    let recoveryCleanup = "not-attempted", cleanupFailure = null;
    if (error.processTreeStopped) {
      try { recoveryCleanup = await cleanup(root, directory, owner) ? "completed" : "unknown"; }
      catch (cleanupError) {
        recoveryCleanup = "failed";
        cleanupFailure = failureDetails(cleanupError, "cleanup-failed");
      }
    }
    let startup;
    const lines = typeof error.stdout === "string" && error.stdout.length <= 1024 * 1024
      ? error.stdout.split(/\r?\n/).filter((line) => line.startsWith(fallbackPrefix)) : [];
    if (lines.length === 1 && Buffer.byteLength(lines[0]) <= 32768) {
      try {
        const value = JSON.parse(lines[0].slice(fallbackPrefix.length));
        if (value.runId === owner) {
          let catalogue;
          try { catalogue = await deviceSourceCatalogue(root); }
          catch { catalogue = { files: [], fingerprint: "unknown" }; }
          startup = projectStartupReport(value, catalogue);
        }
      } catch { /* The original exit remains available; an invalid fallback is never copied. */ }
    }
    const result = { kind: "native-startup-entry", status: "failed", phase: "entry", runId: owner,
      exitCode: Number.isInteger(error.code) ? error.code : "unknown", acceptance: false,
      failure: failureDetails(error), recoveryCleanup, cleanupFailure, ...(startup ? { startup } : {}) };
    if (startup) {
      try {
        const canonical = await realpath(directory), expected = path.resolve(directory);
        const same = process.platform === "win32" ? canonical.toLowerCase() === expected.toLowerCase() : canonical === expected;
        const record = await readDiagnosticReport(path.join(directory, "owner.json"));
        if (!same || record?.runId !== owner || record.root !== root) throw diagnosticError("ownership-mismatch");
        const bytes = JSON.stringify(result, null, 2) + "\n";
        if (Buffer.byteLength(bytes) > 32768) throw diagnosticError("output-limit");
        await writeFile(path.join(directory, "startup-entry-report.json"), bytes, { flag: "wx", mode: 0o600 });
      } catch (publicationError) { result.entryReportFailure = failureDetails(publicationError, "report-write"); }
    }
    return result;
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    base: { type: "string" }, directory: { type: "string" }, variant: { type: "string" },
    sdk: { type: "string" }, jdk: { type: "string" }, image: { type: "string" },
    owner: { type: "string" }, execute: { type: "boolean", default: false },
    github: { type: "boolean", default: false },
    "emulator-sdk": { type: "string" }, "queue-timeout": { type: "string" },
  } });
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(diagnosticError("command-cancelled"));
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
      const result = await runStartupEntry({ ...values, signal: cancellation.signal });
      console.log(JSON.stringify(result));
      if (result.status !== "completed") process.exitCode = 1;
    }
  } catch (error) {
    if (error.startupReport) console.log(`${fallbackPrefix}${JSON.stringify(error.startupReport)}`);
    console.error(JSON.stringify({ kind: "native-startup-entry", status: "failed", acceptance: false,
      phase: "entry", failure: failureDetails(error) }));
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
    console.error(JSON.stringify({ kind: "native-startup-entry", status: "blocked", acceptance: false,
      phase: "arguments", failure: failureDetails(diagnosticError("configuration")) }));
    process.exitCode = 1;
  }
}
