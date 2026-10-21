import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { cleanDeviceRun } from "./device-run.mjs";
import { projectWorkerDiagnostics, readDiagnosticReport } from "./worker-diagnostics.mjs";
import { deviceSourceCatalogue, projectDeviceDiagnostics, deviceDiagnosticsFromOutput } from "./device-diagnostics.mjs";
import { diagnosticError, failureDetails } from "./diagnostic-errors.mjs";
import { publicDeviceEvidence, validateDeviceEvidence, verificationFailure, verificationFault } from "./verification.mjs";
import { commandCleanupConfirmed } from "./process.mjs";
import { recoverEmulatorLease } from "./emulator-resources.mjs";

export async function androidVerification(root, check, plan, options) {
  if (!["android-build", "android-device"].includes(check.id)) throw verificationFault("configuration", { check: check.id });
  const device = check.id === "android-device", owner = device ? randomUUID() : undefined;
  const directory = path.join(options.directory, "device");
  let catalogue;
  if (device) {
    check.deviceRunId = owner;
    try { catalogue = await deviceSourceCatalogue(root); }
    catch (error) {
      catalogue = { files: [], fingerprint: "unknown" };
      check.collectionStatus = "failed";
      check.diagnosticIssues = [{ operation: "device-catalogue", ...failureDetails(error, "collector-failed") }];
    }
  }
  const args = ["-NoProfile", "-NonInteractive", "-File",
    path.join(root, "scripts", device ? "test-android.ps1" : "build-android.ps1"),
    ...(device ? [] : ["-Lint", "-Instrumentation"])];
  if (options.jdk) args.push("-Jdk", options.jdk);
  if (options.sdk) args.push("-Sdk", options.sdk);
  if (device) {
    args.push("-RunDirectory", directory, "-Owner", owner);
    if (options.image) args.push("-Image", options.image);
    if (plan.layouts) args.push("-Layouts");
  }
  return {
    args, timeoutMs: 30 * 60_000, graceMs: device ? 30_000 : 5000,
    async accept() {
      if (!device) return;
      let phase = "device-validation";
      try {
        const evidence = await readDiagnosticReport(path.join(directory, "device-report.json"));
        if (!evidence) throw diagnosticError("report-missing");
        validateDeviceEvidence(evidence, plan, process.platform);
        if (evidence.runId !== owner) throw verificationFault("ownership-mismatch", { check: check.id });
        for (const [field, parts] of [
          ["apkSha256", ["debug", "app-debug.apk"]],
          ["testApkSha256", ["androidTest", "debug", "app-debug-androidTest.apk"]],
        ]) {
          phase = "artifact-validation";
          const context = { check: check.id, artifact: field === "apkSha256" ? "app" : "instrumentation" };
          let bytes;
          try { bytes = await readFile(path.join(root, "android", "app", "build", "outputs", "apk", ...parts)); }
          catch (error) { throw verificationFault("apk-unavailable", context, error); }
          if (createHash("sha256").update(bytes).digest("hex") !== evidence[field]) throw verificationFault("apk-mismatch", context);
        }
        check.workerDiagnostics = projectWorkerDiagnostics(evidence.workerDiagnostics, owner);
        check.deviceDiagnostics = projectDeviceDiagnostics(evidence.deviceDiagnostics, catalogue, owner);
        check.deviceEvidence = publicDeviceEvidence(evidence, check.workerDiagnostics, check.deviceDiagnostics);
        if (check.collectionStatus === "failed") throw verificationFault("collector-failed", { check: check.id });
      } catch (error) {
        error.verificationContext = { ...error.verificationContext, phase };
        throw error;
      }
    },
    async failure(error, output) {
      if (!device) {
        if (error.code === 78) {
          check.status = "blocked";
          check.reason = "Android build prerequisites are unavailable.";
        }
        return;
      }
      check.deviceDiagnostics = deviceDiagnosticsFromOutput(
        `${error.stdout ?? output?.stdout ?? ""}\n${error.stderr ?? output?.stderr ?? ""}`, catalogue, owner);
      if (error.processTreeStopped) {
        try {
          const cleaned = await cleanDeviceRun(root, directory, owner);
          if (process.platform === "darwin") {
            const command = { file: "pwsh", args, cwd: root };
            const outcome = commandCleanupConfirmed(error, command) ? error : output;
            check.leaseRecovery = await recoverEmulatorLease({ workspace: root, directory, runId: owner }, outcome, args);
          }
          check.cleanup = cleaned ? "completed" : "unknown";
        } catch (cleanupError) {
          check.cleanup = "failed";
          check.diagnosticIssues = [...(check.diagnosticIssues ?? []),
            { operation: "controller-cleanup", ...failureDetails(cleanupError, "cleanup-failed") }];
          check.reason += " Cleanup remains incomplete; inspect retained owned resources.";
        }
      }
      try {
        const evidence = await readDiagnosticReport(path.join(directory, "device-report.json"));
        if (!evidence || typeof evidence !== "object") throw diagnosticError(evidence === null ? "report-missing" : "report-invalid");
        if (evidence.runId === owner) {
          check.workerDiagnostics = projectWorkerDiagnostics(evidence.workerDiagnostics, owner);
          if (evidence.deviceDiagnostics) check.deviceDiagnostics = projectDeviceDiagnostics(evidence.deviceDiagnostics, catalogue, owner);
          if (["passed", "failed", "blocked"].includes(evidence.executionStatus)) check.reportedDeviceExecutionStatus = evidence.executionStatus;
          if (["completed", "failed", "unknown"].includes(evidence.collectionStatus)) check.reportedDeviceCollectionStatus = evidence.collectionStatus;
          if (evidence.collectionStatus === "failed" || check.deviceDiagnostics.collectionStatus === "failed" ||
              check.workerDiagnostics.collectionStatus === "failed") check.collectionStatus = "failed";
        }
        if (evidence.runId === owner && evidence.status === "blocked" && evidence.cleanup === "completed") {
          check.status = "blocked";
          check.reason = "Device prerequisites or worker readiness are unavailable; inspect the bounded worker diagnostics.";
        }
      } catch (evidenceError) {
        if (evidenceError.diagnosticCode !== "report-missing") check.collectionStatus = "failed";
        check.diagnosticIssues = [...(check.diagnosticIssues ?? []),
          { operation: "device-report", ...failureDetails(evidenceError, evidenceError instanceof SyntaxError ? "report-invalid" : "report-unavailable") }];
        check.reason += " No complete device report was available.";
      }
      if (check.deviceDiagnostics.primary) {
        const primary = check.deviceDiagnostics.primary;
        check.reason = `Device failure at ${primary.phase}/${primary.operation}: ${primary.reason}.`;
      } else if (check.reportedDeviceExecutionStatus === "passed" &&
          (check.reportedDeviceCollectionStatus === "failed" || check.deviceDiagnostics.collectionStatus === "failed" ||
            check.workerDiagnostics?.collectionStatus === "failed" || check.collectionStatus === "failed")) {
        if (check.failure.reason === "command-failed") check.failure = verificationFailure(verificationFault("collector-failed", { check: check.id }), "report");
        check.reason = "Native execution passed, but diagnostic collection failed.";
      }
    },
  };
}
