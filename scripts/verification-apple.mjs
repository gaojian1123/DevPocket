import { writeFile } from "node:fs/promises";
import path from "node:path";
import { readDiagnosticReport } from "./worker-diagnostics.mjs";
import { validateAppleNativeEvidence } from "./apple-evidence.mjs";
import { requireVerificationOutputDirectory, verificationFault, verificationProcessCleanupConfirmed } from "./verification.mjs";

export async function appleVerification(root, check, plan, options) {
  if (check.id !== "apple-native" || !plan.apple) throw verificationFault("configuration");
  const ci = process.env.GITHUB_ACTIONS === "true";
  if (ci && (process.platform !== "darwin" || process.env.RUNNER_ENVIRONMENT !== "github-hosted")) {
    throw verificationFault("configuration");
  }
  if (!ci && !options.appleEvidence) throw verificationFault("apple-evidence-required", { check: check.id });
  const directory = path.join(options.directory, "apple");
  await requireVerificationOutputDirectory(root, directory);
  let reportFile, args;
  if (ci) {
    const planFile = path.join(options.directory, "apple-plan.json");
    await writeFile(planFile, JSON.stringify(plan) + "\n", { flag: "wx", mode: 0o600 });
    args = [path.join(root, "scripts", "apple-runner.mjs"), "--repo", root, "--plan", planFile, "--directory", directory];
    if (check.appleShard) args.push("--role", check.appleShard.role);
    reportFile = path.join(directory, "apple-report.json");
  } else {
    reportFile = path.join(directory, "apple-local-report.json");
    args = [path.join(root, "scripts", "verify.mjs"), "--repo", root, "--base", plan.base,
      "--apple-request", path.resolve(root, options.appleEvidence), "--report", reportFile];
  }
  return {
    file: process.execPath, args, timeoutMs: 30 * 60_000, graceMs: 60_000,
    async accept() {
      const report = await readDiagnosticReport(reportFile, { maximum: 512 * 1024 });
      const evidence = ci ? report : report?.kind === "local-apple-verification" && report.appleEvidence;
      if (!evidence) throw verificationFault("apple-evidence", { check: check.id });
      try {
        if (!ci && !["local-xcode-mcp", "local-xcodebuild"].includes(evidence.origin)) throw verificationFault("execution-origin");
        validateAppleNativeEvidence(evidence, plan, ci ? "ci-xcodebuild" : evidence.origin);
        if (check.appleShard && evidence.ciRole !== check.appleShard.role) throw verificationFault("apple-evidence");
      }
      catch (error) { throw verificationFault("apple-evidence", { check: check.id }, error); }
      check.appleEvidence = evidence;
      check.cleanup = evidence.cleanup;
    },
    async failure(error) {
      let report;
      try { report = await readDiagnosticReport(reportFile, { maximum: 512 * 1024 }); }
      catch (cause) {
        check.diagnosticIssues = [{ operation: "apple-report", reason: cause.diagnosticCode ?? "report-unavailable" }];
      }
      const evidence = ci ? report : report?.appleEvidence;
      if (ci) {
        check.cleanup = evidence?.source?.head === plan.source.head &&
          evidence.source.fingerprint === plan.source.fingerprint && evidence.base === plan.base
          ? evidence.cleanup : "unknown";
      } else {
        // Local collection owns read-only child processes, not the user's running clients or devices.
        check.cleanup = verificationProcessCleanupConfirmed(check) ? "completed" : "unknown";
      }
      if (error.code === 78) check.status = "blocked";
    },
  };
}
