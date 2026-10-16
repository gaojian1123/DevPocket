import { randomUUID } from "node:crypto";
import { failureDetails } from "./diagnostic-errors.mjs";
import { verificationFault } from "./verification.mjs";

const commands = new Map([
  ["typecheck", "run typecheck"],
  ["backend-tests", "test"],
  ["backend-build", "run build"],
  ["schema", "run schema"],
  ["extension-package", "run test:extension-package"],
  ["setup", "run test:setup"],
  ["azure-tests", "--prefix deployment\\azure test"],
  ["operations-tests", "run test:operations"],
]);

export async function prepareBackendVerification(root, plan, options) {
  if (!options.backendDiagnostics || !["all", "backend"].includes(options.group ?? "all") ||
      !plan.requiredChecks.includes("backend-tests")) return undefined;
  const diagnostics = await import("./backend-diagnostics.mjs"), runId = randomUUID();
  try {
    const env = await diagnostics.prepareBackendDiagnosticEnvironment(root, runId, process.env, options.signal);
    return { diagnostics, runId, env };
  } catch (error) {
    error.verificationContext = { phase: "preflight", check: "backend-tests" };
    throw error;
  }
}

export function backendVerification(root, check, prepared) {
  const command = commands.get(check.id);
  if (!command) throw verificationFault("configuration", { check: check.id });
  const observed = check.id === "backend-tests" ? prepared : undefined;
  if (observed) check.backendDiagnosticRunId = observed.runId;
  return {
    args: ["-NoProfile", "-NonInteractive", "-Command", `& npm ${command}; exit $LASTEXITCODE`],
    timeoutMs: 30 * 60_000, graceMs: 5000, env: observed?.env,
    async accept(output) {
      if (!observed) return;
      let catalogue;
      try { catalogue = await observed.diagnostics.backendTestCatalogue(root); }
      catch (error) {
        catalogue = { files: [], fingerprint: "unknown" };
        check.collectionStatus = "failed";
        check.diagnosticIssues = [...(check.diagnosticIssues ?? []),
          { operation: "backend-catalogue", ...failureDetails(error, "collector-failed") }];
      }
      const result = observed.diagnostics.parseBackendOutput(output.stdout, catalogue, observed.runId);
      if (result.collectionStatus === "failed") check.collectionStatus = "failed";
      if (typeof result.summary?.success === "boolean") check.reportedBackendTestStatus = result.summary.success ? "passed" : "failed";
    },
  };
}
