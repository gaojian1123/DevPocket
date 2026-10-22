import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { diagnosticDirectory } from "./diagnostic-publication.mjs";
import { commandDetails, failureDetails, projectFailureDetails } from "./diagnostic-errors.mjs";
import { inspectWorktree, sameSource, activeHookSnapshot, sameHooks } from "./candidate-commit.mjs";
import { developmentTaskActionAllowed, parseDevelopmentExecution } from "./development-policy.mjs";
import { readOnlyGit, sourceSnapshot } from "./git-state.mjs";
import { combineVerification, verificationPlan,
  requireVerificationReportPath, verificationFailure, verificationFault, verificationCleanupConfirmed } from "./verification.mjs";
import { CHECKS, CHECK_GROUPS } from "./verification-policy.mjs";
import { readDiagnosticReport } from "./worker-diagnostics.mjs";

const exec = promisify(execFile);
const sha = /^[a-f0-9]{40}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export const ISOLATED_WORKFLOW = ".github/workflows/isolated-verification.yml";
const fail = (message) => { throw new Error(`Isolated verification: ${message}`); };
const requireSupportedPlatforms = (plan) => {
  if (plan.ciMacos === true) fail("selected macOS coverage has no approved isolated worker.");
};
const isolationChecks = ["protected-control", "protected-evidence", "protected-ancestors", "runner-channels",
  "descendant-cleanup", "failing-fixed-gate"];

export function validIsolatedWorkerProof(report) {
  const proof = report?.isolation;
  return proof?.version === 1 && proof.kind === "hosted-isolation-proof" && proof.status === "passed" &&
    proof.platform === (report.group === "device" ? "linux" : "win32") && same(proof.checks, isolationChecks) &&
    sha.test(proof.negativeSource?.head ?? "") && /^[a-f0-9]{64}$/.test(proof.negativeSource?.fingerprint ?? "") &&
    /^[a-f0-9]{64}$/.test(proof.negativeReportSha256 ?? "");
}

function requireIsolatedToolingExecutions(plan, tooling) {
  if (!plan.requiredChecks.includes("workflow-tests")) return;
  if (!Array.isArray(tooling?.toolingExecutions) ||
      !same(tooling.toolingExecutions.map((item) => item?.file), plan.toolingShards?.files) ||
      tooling.toolingExecutions.some((item) => item?.status !== "passed" || item.exitCode !== 0 ||
        !executionOrigin(item.execution, plan.source) || item.commandOutcome?.reason !== "exit" ||
        item.commandOutcome.observedProcess !== "owned-command-supervisor" || item.commandOutcome.exitCode !== 0 ||
        item.commandOutcome.cleanupFailure !== null)) fail("trusted tooling selection has incomplete per-file execution evidence.");
}

export function isolatedRequest(value) {
  const execution = parseDevelopmentExecution(value?.execution);
  if (!execution || !sha.test(value.base ?? "") || !sha.test(value.candidate ?? "") ||
      typeof value.branch !== "string" || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.branch) ||
      /(?:\.\.|\/\/|\/\.|\.lock(?:\/|$)|\/$|\.$)/.test(value.branch) ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(value.requestId ?? "")) fail("a complete, scoped candidate request is required.");
  return { version: 1, execution, base: value.base, candidate: value.candidate, branch: value.branch, requestId: value.requestId };
}

export function isolatedMatrix(plan) {
  requireSupportedPlatforms(plan);
  return plan.requiredGroups.map((group) => {
    if (!CHECK_GROUPS.includes(group)) fail("unknown required check group.");
    return { group, os: group === "device" ? "ubuntu-24.04" : "windows-latest" };
  });
}

export function requireIsolatedWorkflowRevision(environment, inputs) {
  const approved = inputs?.trusted_sha;
  if (!sha.test(approved ?? "") || environment.GITHUB_WORKFLOW_SHA !== approved || environment.GITHUB_SHA !== approved) {
    fail("workflow revision differs from the independently approved commit; candidate execution is forbidden.");
  }
  return approved;
}

export async function isolatedContext(root, environment = process.env) {
  if (environment.GITHUB_ACTIONS !== "true" || environment.RUNNER_ENVIRONMENT !== "github-hosted" ||
      environment.GITHUB_EVENT_NAME !== "workflow_dispatch" || !environment.GITHUB_EVENT_PATH) {
    fail("only a GitHub-hosted dispatch of the fixed workflow may execute candidate inputs.");
  }
  const event = await readDiagnosticReport(environment.GITHUB_EVENT_PATH, { maximum: 1024 * 1024 });
  const trustedSha = requireIsolatedWorkflowRevision(environment, event?.inputs);
  const request = isolatedRequest({ execution: {
    kind: "github-hosted", repository: environment.GITHUB_REPOSITORY, trustedRef: environment.GITHUB_REF,
    trustedSha,
  }, base: event?.inputs?.base, candidate: event?.inputs?.candidate,
  branch: event?.inputs?.branch, requestId: event?.inputs?.request_id });
  if (event.repository?.full_name !== request.execution.repository ||
      environment.GITHUB_WORKFLOW_REF !== `${request.execution.repository}/${ISOLATED_WORKFLOW}@${request.execution.trustedRef}` ||
      environment.GITHUB_SHA !== request.execution.trustedSha ||
      !/^[1-9]\d*$/.test(environment.GITHUB_RUN_ID ?? "") ||
      !/^[1-9]\d*$/.test(environment.GITHUB_RUN_ATTEMPT ?? "")) fail("workflow identity is not the approved execution source.");
  const source = await sourceSnapshot(root);
  if (source.head !== request.candidate) fail("candidate checkout differs from the dispatched commit.");
  await readOnlyGit(root, ["merge-base", "--is-ancestor", request.base, request.candidate]);
  const control = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  if ((await readOnlyGit(control, ["rev-parse", "HEAD"])).trim() !== request.execution.trustedSha ||
      control === path.resolve(root)) fail("trusted control and candidate checkouts must be separate.");
  return { request, runId: environment.GITHUB_RUN_ID, attempt: Number(environment.GITHUB_RUN_ATTEMPT), source };
}

export async function readIsolatedReports(root, directory, plan, context) {
  await diagnosticDirectory(root, directory);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length === 1 && entries[0].name === "report.json") {
    if (plan.requiredGroups.length !== 1 || !entries[0].isFile() || entries[0].isSymbolicLink()) {
      fail("a flat artifact must contain one regular report for exactly one required group.");
    }
    return [await readDiagnosticReport(path.join(directory, "report.json"))];
  }
  if (entries.length !== plan.requiredGroups.length) fail("unexpected worker artifacts.");
  const reports = [];
  for (const group of plan.requiredGroups) {
    const name = `isolated-verification-${group}-attempt-${context.attempt}`;
    if (!entries.some((entry) => entry.name === name && entry.isDirectory() && !entry.isSymbolicLink())) fail("worker artifact is missing.");
    const files = await readdir(path.join(directory, name));
    if (!same(files, ["report.json"])) fail("worker artifact contains unexpected content.");
    reports.push(await readDiagnosticReport(path.join(directory, name, "report.json")));
  }
  return reports;
}

export function collectIsolatedReports(plan, context, reports, workerOutcome) {
  requireSupportedPlatforms(plan);
  if (!same(plan.source, context.source) || plan.base !== context.request.base ||
      plan.source.head !== context.request.candidate) fail("plan does not describe the requested source.");
  if (plan.requiredGroups.length && workerOutcome !== "success" ||
      !plan.requiredGroups.length && !["success", "skipped"].includes(workerOutcome)) fail("a required worker failed or did not run.");
  if (reports.length !== plan.requiredGroups.length ||
      new Set(reports.map((report) => report?.group)).size !== reports.length ||
      reports.some((report) => !plan.requiredGroups.includes(report?.group) ||
        report.failure || report.sourceValidation?.status === "failed")) fail("required worker evidence is missing, duplicated or failed.");
  if (reports.some((report) => !validIsolatedWorkerProof(report))) fail("OS-enforced worker isolation evidence is missing or invalid.");
  const report = combineVerification(plan, reports);
  const tooling = reports.find((report) => report.group === "tooling")?.checks?.find((check) => check.id === "workflow-tests");
  requireIsolatedToolingExecutions(plan, tooling);
  if (tooling) {
    report.checks.find((check) => check.id === "workflow-tests").toolingExecutions = structuredClone(tooling.toolingExecutions);
  }
  return { version: 1, kind: "isolated-verification-report", context,
    reportDigest: hash(JSON.stringify(report)), report,
    workerIsolation: reports.map(({ group, isolation }) => ({ group, isolation })) };
}

function executionOrigin(execution, source) {
  const timestamp = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (execution?.kind || !same(execution?.source, source) || !timestamp(execution?.startedAt) ||
      !timestamp(execution?.completedAt) || execution.completedAt < execution.startedAt) return null;
  return { source: { ...execution.source }, startedAt: execution.startedAt, completedAt: execution.completedAt };
}

function executedCheckFailure(check, source) {
  const outcome = check?.commandOutcome;
  return check?.status === "failed" && Number.isInteger(check.exitCode) && check.exitCode !== 0 &&
    check.executionState === "exited" && check.failure?.phase === "command" && check.collectionStatus !== "failed" &&
    outcome?.observedProcess === "owned-command-supervisor" && outcome.reason === "exit" &&
    outcome.exitCode === check.exitCode && verificationCleanupConfirmed(check) && Boolean(executionOrigin(check.execution, source));
}

function diagnosticFailure(value) {
  return { ...projectFailureDetails(value),
    phase: ["arguments", "plan", "admission", "preflight", "command", "device-validation", "artifact-validation",
      "source-validation", "log", "aggregate", "report"].includes(value?.phase) ? value.phase : "unknown" };
}

export function diagnoseIsolatedReports(plan, context, reports, workerOutcome, cause) {
  const observed = new Map(), groups = new Set(), provenFailures = new Set();
  let coherent = same(plan.source, context?.source) && plan.base === context?.request?.base &&
    plan.source.head === context?.request?.candidate && Array.isArray(reports) && reports.length === plan.requiredGroups.length;
  let blocked = plan.ciMacos === true, reportedBlocker;
  for (const report of Array.isArray(reports) ? reports : []) {
    if (!report || report.version !== plan.version || report.base !== plan.base || !same(report.source, plan.source) ||
        !same(report.requiredChecks, plan.requiredChecks) || !same(report.requiredGroups, plan.requiredGroups) ||
        !same(report.toolingShards ?? null, plan.toolingShards ?? null) ||
        !plan.requiredGroups.includes(report.group) || groups.has(report.group) || !Array.isArray(report.checks) ||
        !["passed", "partial", "failed", "blocked"].includes(report.status) || !validIsolatedWorkerProof(report)) {
      coherent = false;
      continue;
    }
    groups.add(report.group);
    blocked ||= report.status === "blocked" || report.preflight?.status === "blocked" ||
      Boolean(report.failure) || report.sourceValidation?.status === "failed";
    if (report.failure) reportedBlocker ??= diagnosticFailure(report.failure);
    else if (report.sourceValidation?.status === "failed") {
      reportedBlocker ??= report.sourceValidation.failure ? diagnosticFailure(report.sourceValidation.failure)
        : verificationFailure(verificationFault("source-unavailable"), "source-validation");
    }
    const seen = new Set();
    for (const check of report.checks) {
      const definition = CHECKS.find((item) => item.id === check?.id);
      if (!definition || !plan.requiredChecks.includes(check.id) || seen.has(check.id) ||
          !["passed", "failed", "blocked", "not_run"].includes(check.status)) {
        coherent = false;
        continue;
      }
      seen.add(check.id);
      if (definition.group !== report.group) {
        if (check.status !== "not_run") coherent = false;
        continue;
      }
      blocked ||= check.status === "blocked" || check.collectionStatus === "failed" || !verificationCleanupConfirmed(check);
      if (check.status === "blocked" && check.failure) {
        reportedBlocker ??= { ...diagnosticFailure(check.failure), check: check.id, group: report.group };
      }
      if (check.status === "failed" && ["passed", "partial"].includes(report.status)) coherent = false;
      if (report.status === "failed" && executedCheckFailure(check, plan.source)) provenFailures.add(check.id);
      const projected = { id: check.id, status: check.status };
      if (check.collectionStatus === "failed") projected.collectionStatus = "failed";
      if (Number.isInteger(check.exitCode)) projected.exitCode = check.exitCode;
      if (["not-started", "started", "exited"].includes(check.executionState)) projected.executionState = check.executionState;
      if (check.commandOutcome) projected.commandOutcome = commandDetails(check.commandOutcome);
      if (check.failure) projected.failure = diagnosticFailure(check.failure);
      if (check.id === "android-device") {
        if (check.cleanup !== undefined) projected.cleanup = ["completed", "failed"].includes(check.cleanup) ? check.cleanup : "unknown";
        if (check.deviceEvidence) {
          projected.deviceEvidence = { cleanup: ["completed", "failed"].includes(check.deviceEvidence.cleanup)
            ? check.deviceEvidence.cleanup : "unknown" };
        }
        if (check.diagnosticIssues !== undefined) {
          projected.diagnosticIssues = Array.isArray(check.diagnosticIssues)
            ? check.diagnosticIssues.filter((issue) => issue?.operation === "controller-cleanup").map(() => ({ operation: "controller-cleanup" }))
            : null;
        }
      }
      const origin = executionOrigin(check.execution, plan.source);
      if (origin) projected.execution = origin;
      else if (["passed", "failed"].includes(check.status)) coherent = false;
      observed.set(check.id, projected);
    }
    if (seen.size !== plan.requiredChecks.length) coherent = false;
  }
  coherent &&= groups.size === plan.requiredGroups.length;
  const checks = coherent ? plan.requiredChecks.map((id) => observed.get(id) ?? { id, status: "not_run" }) : [];
  const repairable = coherent && !blocked && workerOutcome === "failure" &&
    checks.some((check) => provenFailures.has(check.id) && executedCheckFailure(check, plan.source));
  const report = { ...plan, group: "all", status: repairable ? "failed" : "blocked", complete: false, acceptance: false, checks,
    failure: coherent && reportedBlocker ? reportedBlocker
      : verificationFailure(verificationFault(repairable ? "check-failed" : "collector-failed", {}, cause), "aggregate") };
  return { version: 1, kind: "isolated-verification-failure", context,
    reportDigest: hash(JSON.stringify(report)), report };
}

async function writeReport(root, file, value) {
  await requireVerificationReportPath(root, path.resolve(file));
  await diagnosticDirectory(root, path.dirname(path.resolve(file)));
  const bytes = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(bytes) > 1024 * 1024) fail("report exceeds the output bound.");
  const output = await open(file, "wx", 0o600);
  try { await output.writeFile(bytes); await output.sync(); }
  finally { await output.close(); }
}

async function github(endpoint, method, body) {
  const args = ["api", "--hostname", "github.com", endpoint];
  if (method) args.push("--method", method);
  if (body) args.push("--input", "-");
  const pending = exec("gh", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 60000 });
  if (body) pending.child.stdin.end(JSON.stringify(body));
  const result = await pending;
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

export async function originRepository(root) {
  return githubRepositoryUrl((await readOnlyGit(root, ["remote", "get-url", "origin"])).trim());
}

function githubRepositoryUrl(url) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  if (!match) fail("the effective Git URL is not an authenticated GitHub.com repository URL.");
  return match[1];
}

export async function requireIsolatedPushTarget(root, repository) {
  const urls = (await readOnlyGit(root, ["remote", "get-url", "--push", "--all", "origin"])).trim().split(/\r?\n/);
  if (urls.length !== 1 || githubRepositoryUrl(urls[0]) !== repository) {
    fail("every effective push destination must be the single authorized GitHub repository.");
  }
  return urls[0];
}

export function isolatedPushArguments(request) {
  request = isolatedRequest(request);
  return ["--no-pager", "-c", "push.autoSetupRemote=false", "-c", "remote.origin.mirror=false", "push", "--no-follow-tags", "--no-mirror",
    "--no-force", "--recurse-submodules=no", "origin", `${request.candidate}:${request.branch}`];
}

export function validateIsolatedEnvelope(value, request, { run, jobs, artifact, repository, trustedRef, candidateRef }, outcome = "success") {
  request = isolatedRequest(request);
  if (!["success", "failure"].includes(outcome)) fail("unsupported run outcome.");
  const diagnostic = outcome === "failure";
  const context = value?.context, report = value?.report;
  const gate = jobs?.jobs?.filter((job) => job.name === "Isolated Required verification") ?? [];
  if (value?.version !== 1 || value.kind !== (diagnostic ? "isolated-verification-failure" : "isolated-verification-report") ||
      !same(context?.request, request) || context.runId !== String(run.id) ||
      context.attempt !== run.run_attempt || !same(context.source, report?.source) ||
      report?.source?.head !== request.candidate || report.base !== request.base ||
      (diagnostic ? !["failed", "blocked"].includes(report.status) || report.complete !== false || report.acceptance !== false
        : report.status !== "passed" || report.complete !== true) ||
      value.reportDigest !== hash(JSON.stringify(report)) ||
      run.path !== ISOLATED_WORKFLOW || run.event !== "workflow_dispatch" ||
      run.head_sha !== request.execution.trustedSha ||
      run.display_title !== `DevPocket isolated verification ${request.requestId}` ||
      run.status !== "completed" || run.conclusion !== outcome ||
      gate.length !== 1 || gate[0].status !== "completed" || gate[0].conclusion !== outcome ||
      repository.full_name !== request.execution.repository || !Number.isSafeInteger(repository.id) ||
      run.repository?.id !== repository.id ||
      artifact.expired !== false || artifact.name !== `isolated-summary-attempt-${context.attempt}` ||
      String(artifact.workflow_run?.id) !== context.runId ||
      artifact.workflow_run?.head_sha !== request.execution.trustedSha ||
      artifact.workflow_run?.repository_id !== repository.id ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") ||
      trustedRef?.ref !== request.execution.trustedRef || trustedRef.object?.type !== "commit" ||
      trustedRef.object.sha !== request.execution.trustedSha ||
      candidateRef?.ref !== request.branch || candidateRef.object?.type !== "commit" ||
      candidateRef.object.sha !== request.candidate) fail("live run, trusted source, candidate or artifact identity changed.");
  if (diagnostic) {
    if (!Array.isArray(report.checks) || report.status === "failed" &&
        (!report.checks.some((check) => executedCheckFailure(check, report.source)) ||
          report.checks.some((check) => check.status === "blocked" || check.collectionStatus === "failed" ||
            !verificationCleanupConfirmed(check)))) fail("failed diagnostics do not establish an executed-check failure.");
  } else {
    requireSupportedPlatforms(report);
    combineVerification(report, [report]);
    requireIsolatedToolingExecutions(report, report.checks.find((check) => check.id === "workflow-tests"));
  }
  return value;
}

async function liveRun(request, runId, api) {
  const repository = request.execution.repository;
  const [run, repositoryInfo, trustedRef, candidateRef] = await Promise.all([
    api(`repos/${repository}/actions/runs/${runId}`), api(`repos/${repository}`),
    api(`repos/${repository}/git/ref/${request.execution.trustedRef.slice(5)}`),
    api(`repos/${repository}/git/ref/${request.branch.slice(5)}`),
  ]);
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) fail("invalid run attempt.");
  const [jobs, artifacts] = await Promise.all([
    api(`repos/${repository}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`),
    api(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`),
  ]);
  if (jobs.total_count > 100 || artifacts.total_count > 100 || !Array.isArray(artifacts.artifacts)) fail("ambiguous evidence inventory.");
  const matches = artifacts.artifacts.filter((item) => item.name === `isolated-summary-attempt-${run.run_attempt}`);
  if (matches.length !== 1) fail("one current gate artifact is required.");
  return { run, repository: repositoryInfo, trustedRef, candidateRef, jobs, artifact: matches[0] };
}

async function inspectIsolatedEvidence(root, request, runId, directory, { api = github, download } = {}, outcome = "success") {
  request = isolatedRequest(request);
  if (!/^[1-9]\d*$/.test(String(runId))) fail("invalid run identifier.");
  const before = await inspectWorktree(root);
  if (before.status || before.source.head !== request.candidate || before.identity.branch !== request.branch ||
      await originRepository(root) !== request.execution.repository) fail("local candidate is not clean, current and in the authorized repository.");
  const plan = await verificationPlan(root, request.base, false, { trustedTooling: true });
  if (outcome === "success") requireSupportedPlatforms(plan);
  const observed = await liveRun(request, runId, api), { artifact } = observed;
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 1 || artifact.expired ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") ||
      !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 ||
      artifact.size_in_bytes > 4 * 1024 * 1024) fail("unavailable or oversized evidence artifact.");
  await requireVerificationReportPath(root, path.join(directory, "qualification.json"));
  await diagnosticDirectory(root, directory);
  const bytes = download ? await download(artifact) : (await exec("gh",
    ["api", "--hostname", "github.com", `repos/${request.execution.repository}/actions/artifacts/${artifact.id}/zip`],
    { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, timeout: 60000 })).stdout;
  const archive = path.join(directory, "ci-evidence.zip"), output = await open(archive, "wx", 0o600);
  try { await output.writeFile(bytes); await output.sync(); }
  finally { await output.close(); }
  const extracted = await exec("pwsh", ["-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("./verification-ci-artifact.ps1", import.meta.url)), "-Archive", archive, "-Sha256", artifact.digest.slice(7)],
  { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30000 });
  const envelope = validateIsolatedEnvelope(JSON.parse(extracted.stdout), request, observed, outcome);
  if (!same(plan.requiredChecks, envelope.report.requiredChecks) ||
      Boolean(plan.ciMacos) !== Boolean(envelope.report.ciMacos) ||
      !same(plan.toolingShards ?? null, envelope.report.toolingShards ?? null) || plan.layouts !== envelope.report.layouts ||
      !same(plan.trustedDeviceClasses ?? [], envelope.report.trustedDeviceClasses ?? [])) fail("trusted local acceptance is not covered by the hosted report.");
  const afterRun = await liveRun(request, runId, api), after = await inspectWorktree(root);
  validateIsolatedEnvelope(envelope, request, afterRun, outcome);
  if (!same(observed.artifact, afterRun.artifact) || !same(before, after)) fail("candidate or evidence changed during qualification.");
  await writeReport(root, path.join(directory, "ci-report.json"), envelope);
  const result = { version: 1, kind: outcome === "success" ? "isolated-qualification" : "isolated-failure",
    status: outcome === "success" ? "verified" : envelope.report.status, request, runId: String(runId),
    attempt: observed.run.run_attempt, candidate: before.source, tested: envelope.report.source,
    artifact: { id: artifact.id, digest: artifact.digest }, reportDigest: envelope.reportDigest,
    evidence: path.relative(root, path.join(directory, "ci-report.json")), report: envelope.report };
  await writeReport(root, path.join(directory, outcome === "success" ? "qualification.json" : "failure.json"), result);
  return result;
}

export async function qualifyIsolatedVerification(root, request, runId, directory, options = {}) {
  return inspectIsolatedEvidence(root, request, runId, directory, options);
}

export async function requireIsolatedPublication(root, request, api = github, expected) {
  request = isolatedRequest(request);
  const state = await inspectWorktree(root);
  if (expected && !same(state, expected)) fail("workspace or Git configuration changed across the native permission boundary.");
  const origin = await originRepository(root);
  if (origin !== request.execution.repository || state.status || state.source.head !== request.candidate ||
      state.identity.branch !== request.branch || request.branch === request.execution.trustedRef) fail("publication target does not match the authorized candidate branch.");
  await requireIsolatedPushTarget(root, origin);
  const trusted = await api(`repos/${origin}/git/ref/${request.execution.trustedRef.slice(5)}`);
  if (trusted?.ref !== request.execution.trustedRef || trusted.object?.sha !== request.execution.trustedSha ||
      trusted.object?.type !== "commit") fail("trusted execution branch changed; approval does not transfer to a new version.");
  await readOnlyGit(root, ["merge-base", "--is-ancestor", request.base, request.candidate]);
  const policyDelta = await readOnlyGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--name-only",
    request.execution.trustedSha, request.candidate, "--", ".github/workflows", ".github/actions"]);
  if (policyDelta.trim()) fail("candidate workflow/action changes cannot be activated by an unattended push. Test them as data and obtain separate adoption authority.");
  return state;
}

function requirePublicationAuthority(scope, request, hooks, implementation, receipts, expected) {
  if (!same(scope?.workspace, expected?.identity) || scope?.base !== request.base ||
      !same(parseDevelopmentExecution(scope?.task?.execution), request.execution) ||
      !developmentTaskActionAllowed(scope, hooks, implementation, receipts, "ordinary-ci")) {
    fail("ordinary repository CI needs explicit task authority before candidate publication.");
  }
}

async function publishAndSubmit(root, request, directory, hooks, expected, implementation, authorization) {
  if (!expected) fail("the pre-permission workspace/configuration snapshot is required.");
  requirePublicationAuthority(authorization?.scope, request, hooks, implementation, authorization?.receipts, expected);
  const before = await requireIsolatedPublication(root, request, github, expected);
  if (!sameHooks(await activeHookSnapshot(root), hooks)) fail("active hooks changed before publication.");
  await diagnosticDirectory(root, directory);
  const intent = path.join(directory, "dispatch-intent.json");
  await writeReport(root, intent, { request, status: "dispatching" });
  // The durable intent is created before either side effect. Recovery inspects it; it never redispatches.
  await exec("git", isolatedPushArguments(request),
    { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120000 });
  if (!same(before, await inspectWorktree(root)) || !sameHooks(await activeHookSnapshot(root), hooks)) fail("candidate or hooks changed during push.");
  await github(`repos/${request.execution.repository}/actions/workflows/${encodeURIComponent(ISOLATED_WORKFLOW.split("/").at(-1))}/dispatches`,
    "POST", { ref: request.execution.trustedRef, inputs: {
      candidate: request.candidate, base: request.base, branch: request.branch, request_id: request.requestId,
      trusted_sha: request.execution.trustedSha,
    } });
  await writeReport(root, path.join(directory, "dispatch.json"), { request, status: "submitted" });
}

async function observeDispatchedRun(request) {
  let run;
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await github(`repos/${request.execution.repository}/actions/workflows/${encodeURIComponent(ISOLATED_WORKFLOW.split("/").at(-1))}/runs?event=workflow_dispatch&per_page=100`);
    const matches = result.workflow_runs?.filter((item) => item.display_title === `DevPocket isolated verification ${request.requestId}`) ?? [];
    if (matches.length > 1) fail("dispatch has multiple matching runs; inspect without retrying.");
    if (matches.length === 1) { run = matches[0]; break; }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!run) fail("dispatch is not yet observable; inspect the retained dispatch intent without repeating the side effect.");
  if (run.head_sha !== request.execution.trustedSha || run.event !== "workflow_dispatch") fail("dispatched run used a different trusted revision.");
  return run;
}

export async function prepareIsolatedExecution(root, scope, candidate, hooks, implementation, directory, receipts = []) {
  const current = await inspectWorktree(root);
  if (current.status || !sameSource(current.source, candidate) ||
      !same(current.identity, scope.workspace) || !sameHooks(await activeHookSnapshot(root), hooks)) {
    fail("the candidate, workspace or approved hooks changed before native preparation.");
  }
  const request = isolatedRequest({ execution: scope.task.execution, branch: scope.workspace.branch,
    base: scope.base, candidate: candidate.head, requestId: randomUUID() });
  requirePublicationAuthority(scope, request, hooks, implementation, receipts, current);
  requireSupportedPlatforms(await verificationPlan(root, scope.base, false, { trustedTooling: true }));
  await requireIsolatedPushTarget(root, request.execution.repository);
  const file = path.join(directory, "native-isolated-request.json");
  const body = JSON.stringify({ root, request, directory, hooks, expected: current, execution: implementation,
    authorization: { scope, receipts } });
  await requireVerificationReportPath(root, file);
  await diagnosticDirectory(root, directory);
  const output = await open(file, "wx", 0o600);
  try { await output.writeFile(body); await output.sync(); }
  finally { await output.close(); }
  const { nativeIsolatedCommand } = await import("./native-candidate.mjs");
  return { request, file, sha256: hash(body), command: nativeIsolatedCommand(file, hash(body)) };
}

export async function executeIsolatedVerification(ctx, root, scope, candidate, hooks, implementation, directory, receipts = []) {
  ctx.signal?.throwIfAborted();
  const prepared = await prepareIsolatedExecution(root, scope, candidate, hooks, implementation, directory, receipts);
  const { request } = prepared;
  const metadata = await ctx.session?.rpc?.tools?.getCurrentMetadata();
  ctx.signal?.throwIfAborted();
  const tool = metadata?.tools?.find((item) => ["powershell", "functions.powershell"].includes(item.name));
  if (!tool || !ctx.session.rpc.tools.execute) fail("the original native tool/permission pipeline is unavailable.");
  const response = await ctx.session.rpc.tools.execute({ name: tool.name, arguments: {
    command: prepared.command,
    description: "Push the scoped candidate and verify it on approved disposable GitHub-hosted workers",
    mode: "sync", initial_wait: 600,
  } });
  ctx.signal?.throwIfAborted();
  if (response?.resultType !== "success" && typeof response !== "string") fail("native execution was denied, failed or is uncertain; inspect the retained dispatch without retrying.");
  const dispatched = await readDiagnosticReport(path.join(directory, "dispatch.json"));
  if (dispatched?.status !== "submitted" || !same(dispatched.request, request)) fail("native dispatch receipt is missing; inspect before any retry.");
  const run = await observeDispatchedRun(request);
  await writeReport(root, path.join(directory, "dispatched-run.json"), { request, runId: String(run.id) });
  try {
    await exec("gh", ["run", "watch", String(run.id), "--repo", request.execution.repository, "--exit-status", "--interval", "10"],
      { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, signal: ctx.signal,
        env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" } });
  } catch (error) {
    ctx.signal?.throwIfAborted();
    const failed = await github(`repos/${request.execution.repository}/actions/runs/${run.id}`);
    if (failed.status !== "completed" || failed.conclusion !== "failure" || failed.path !== ISOLATED_WORKFLOW ||
        failed.head_sha !== request.execution.trustedSha || failed.display_title !== run.display_title) throw error;
    const plan = await verificationPlan(root, request.base, false, { trustedTooling: true });
    if (!sameSource(plan.source, candidate)) fail("candidate changed while its failed run was observed.");
    let result;
    try {
      result = await inspectIsolatedEvidence(root, request, String(run.id), path.join(directory, "failed-evidence"), {}, "failure");
    } catch (evidenceError) {
      ctx.signal?.throwIfAborted();
      const blocked = diagnoseIsolatedReports(plan, { request, source: plan.source }, [], "failure", evidenceError);
      result = { kind: "isolated-failure", status: "blocked", request, runId: String(run.id), attempt: failed.run_attempt,
        candidate, report: blocked.report, diagnosticIssue: failureDetails(evidenceError, "ci-evidence") };
    }
    try {
      const log = await exec("gh", ["run", "view", String(run.id), "--repo", request.execution.repository,
        "--attempt", String(failed.run_attempt), "--log-failed"],
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 60000, env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" } });
      const diagnostic = path.join(directory, "failed-ci.log"), output = await open(diagnostic, "wx", 0o600);
      try { await output.writeFile(log.stdout); await output.sync(); }
      finally { await output.close(); }
      result.diagnostics = path.relative(root, diagnostic);
    } catch (logError) {
      ctx.signal?.throwIfAborted();
      result.logDiagnosticIssue = failureDetails(logError, "collector-failed");
    }
    await writeReport(root, path.join(directory, "failed-run.json"), result);
    return result;
  }
  const result = await qualifyIsolatedVerification(root, request, String(run.id), path.join(directory, "qualified"));
  if (result?.kind !== "isolated-qualification" || result.status !== "verified" ||
      !same(result.request, request) || !sameSource(result.candidate, candidate)) fail("native hosted qualification is unavailable or stale.");
  return result;
}

export async function runIsolatedRequest(file, expectedHash) {
  const info = await lstat(file), bytes = await readFile(file);
  if (!info.isFile() || info.isSymbolicLink() || bytes.length > 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(expectedHash ?? "") || hash(bytes) !== expectedHash) fail("native request changed.");
  const input = JSON.parse(bytes);
  const { requireCandidateImplementation } = await import("./native-candidate.mjs");
  await requireCandidateImplementation(input.execution);
  await publishAndSubmit(input.root, isolatedRequest(input.request), input.directory, input.hooks, input.expected,
    input.execution, input.authorization);
  await requireCandidateImplementation(input.execution);
}

async function main() {
  const { values } = parseArgs({ options: {
    prepare: { type: "boolean" },
    plan: { type: "boolean" }, run: { type: "boolean" }, collect: { type: "boolean" },
    qualify: { type: "boolean" }, repo: { type: "string", default: process.cwd() },
    base: { type: "string" }, group: { type: "string" }, report: { type: "string" },
    inputs: { type: "string" }, outcome: { type: "string" }, request: { type: "string" },
    "run-id": { type: "string" },
  } });
  const root = path.resolve(values.repo);
  if ([values.prepare, values.plan, values.run, values.collect, values.qualify].filter(Boolean).length !== 1) {
    fail("select exactly one execution phase.");
  }
  if (values.prepare) {
    if (!values.request || !values.report || path.basename(values.report) !== "native-isolated-request.json") {
      fail("preparation needs the recorded scope and a fresh native-isolated-request.json destination.");
    }
    const input = await readDiagnosticReport(values.request);
    const { requireCandidateImplementation } = await import("./native-candidate.mjs");
    await requireCandidateImplementation(input?.implementation);
    const prepared = await prepareIsolatedExecution(root, input.scope, await sourceSnapshot(root), input.hooks,
      input.implementation, path.dirname(path.resolve(values.report)), input.receipts);
    console.log(JSON.stringify({ status: "prepared", authority: "Original-client user scope is required; this file does not grant authority.", ...prepared }));
    return;
  }
  if (values.qualify) {
    if (!values.request || !values.report || path.basename(values.report) !== "qualification.json") {
      fail("qualification needs its original request and a fresh qualification.json destination.");
    }
    const record = await readDiagnosticReport(values.request);
    await qualifyIsolatedVerification(root, record?.request ?? record,
      values["run-id"] ?? record?.runId, path.dirname(path.resolve(values.report)));
    return;
  }
  if (!values.report) fail("select an output for this execution phase.");
  if (values.run) fail("direct candidate execution is disabled; use the sealed hosted worker bootstrap.");
  const context = await isolatedContext(root);
  const outputRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const plan = await verificationPlan(root, context.request.base, false, { trustedTooling: true });
  let result;
  if (values.plan) {
    result = { ...plan, status: "planned", complete: false, context, matrix: isolatedMatrix(plan) };
  } else {
    const directory = path.resolve(values.inputs ?? "");
    let reports = [];
    try {
      reports = await readIsolatedReports(outputRoot, directory, plan, context);
      result = collectIsolatedReports(plan, context, reports, values.outcome);
    } catch (error) {
      result = diagnoseIsolatedReports(plan, context, reports, values.outcome, error);
      process.exitCode = 1;
    }
    await writeReport(outputRoot, path.join(path.dirname(path.resolve(values.report)), "gate.json"), result.report);
  }
  await writeReport(outputRoot, path.resolve(values.report), result);
  console.log(JSON.stringify({ status: result.status ?? result.report?.status, report: values.report }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    console.error(JSON.stringify({ status: "blocked", reason: error.message }));
    process.exitCode = 1;
  }
}
