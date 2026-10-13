import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runCommand } from "./process.mjs";
import { sourceSnapshot } from "./verification.mjs";
import { backendDiagnosticEnvironment, backendTestCatalogue, LINUX_PLATFORM_TESTS, parseBackendOutput } from "./backend-diagnostics.mjs";
import { diagnosticDirectory, publishDiagnostic } from "./diagnostic-publication.mjs";
import { writeBoundedWorkerLog } from "./bounded-worker-log.mjs";
import { diagnosticError, failureDetails } from "./diagnostic-errors.mjs";

export async function runPlatformChecks({
  root = process.cwd(), directory = path.join(".data", "ci", "preparation"), environment = process.env,
  platform = process.platform, run = runCommand, signal,
} = {}) {
  if (platform !== "linux" || environment.GITHUB_ACTIONS !== "true" || environment.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw diagnosticError("configuration");
  }
  const outputDirectory = await diagnosticDirectory(root, directory), runId = randomUUID();
  backendDiagnosticEnvironment(root, runId, environment);
  const source = await sourceSnapshot(root), catalogue = await backendTestCatalogue(root, "linux-platform");
  let output, failure, privateLog;
  try {
    output = await run(process.execPath, ["--enable-source-maps", "--test",
      `--test-reporter=${pathToFileURL(path.join(root, "scripts", "backend-diagnostics.mjs")).href}`,
      "--test-reporter-destination=stdout", ...LINUX_PLATFORM_TESTS],
    { cwd: root, timeoutMs: 10 * 60_000, signal,
      env: { ...environment, DEVPOCKET_BACKEND_DIAGNOSTIC_ID: runId, DEVPOCKET_TEST_DIAGNOSTIC_SCOPE: "linux-platform" } });
  } catch (error) { failure = error; output = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; }
  let collectionFailure;
  try { privateLog = await writeBoundedWorkerLog(path.join(outputDirectory, "platform-tests.log"), output.stdout + output.stderr); }
  catch (error) { collectionFailure = failureDetails(error, "report-write"); }
  const tests = parseBackendOutput(output.stdout, catalogue, runId);
  if (!failure && (output.processTreeStopped !== true || tests.availability !== "complete" ||
      tests.summary?.success !== true || tests.summary?.counts?.tests < 1 ||
      tests.summary?.counts?.failed !== 0 || tests.summary?.counts?.cancelled !== 0 || tests.summary?.counts?.skipped !== 0)) {
    failure = diagnosticError(output.processTreeStopped !== true ? "cleanup-failed" : "report-invalid");
  }
  try {
    const current = await sourceSnapshot(root);
    if (current.head !== source.head || current.fingerprint !== source.fingerprint) failure ??= diagnosticError("source-changed");
  } catch (error) { collectionFailure ??= failureDetails(error, "collector-failed"); }
  return {
    version: 1, kind: "platform-check-diagnostics", acceptance: false, runId, source,
    phase: "linux-platform-tests", status: failure ? "failed" : collectionFailure ? "blocked" : "passed",
    failure: failure ? failureDetails(failure) : null, collectionFailure: collectionFailure ?? null,
    tests, privateLog: privateLog ?? { status: "unavailable", truncated: "unknown", retainedBytes: "unknown" },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const { values } = parseArgs({ options: { github: { type: "boolean", default: false } } });
    const report = await runPlatformChecks({ signal: cancellation.signal });
    await publishDiagnostic({ directory: path.join(".data", "ci", "preparation"), name: "platform-diagnostics.json",
      value: report, limit: 32768, github: values.github });
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ kind: "platform-check-diagnostics", acceptance: false, phase: "linux-platform-tests",
      status: "blocked", diagnosticAvailability: "not-produced", failure: failureDetails(error) }));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
