import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { diagnosticDirectory } from "./diagnostic-publication.mjs";
import { diagnosticError, failureDetails } from "./diagnostic-errors.mjs";
import { committedInputEntries, readOnlyGit } from "./git-state.mjs";
import { isVerificationPolicyPath } from "./development-paths.mjs";
import { combineVerification, requireToolingShardReport, requireVerificationOutputDirectory, requireVerificationReportPath,
  verificationFailure, verificationPlan } from "./verification.mjs";
import { CHECK_GROUPS, VERIFICATION_REPORT_VERSION } from "./verification-policy.mjs";
import { readDiagnosticReport } from "./worker-diagnostics.mjs";
import { APPLE_CI_ROLES } from "./apple-evidence.mjs";

const exec = promisify(execFile);
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const repositoryName = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const validRepository = (value) => typeof value === "string" && value.length <= 256 && repositoryName.test(value) &&
  value.split("/").every((part) => part !== "." && part !== "..");
const unitName = /^(?:tooling-(?:all|candidate|verification|diagnostics|native)|macos|backend|android|device|apple(?:-(?:mac|iphone|ipad|duo))?|gate)$/;
const artifactName = /^verification-((?:tooling-(?:all|candidate|verification|diagnostics|native))|macos|backend|android|device|apple(?:-(?:mac|iphone|ipad|duo))?)-attempt-([1-9]\d*)$/;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (cause) => diagnosticError("ci-evidence", cause);
const unitsFor = (plan) => [...plan.requiredGroups.flatMap((group) => group === "tooling"
  ? (plan.toolingShards?.parts.map((part) => `tooling-${part.id}`) ?? ["tooling-all"])
  : group === "apple" ? APPLE_CI_ROLES.map((role) => `apple-${role}`) : [group]),
...(plan.ciMacos === true ? ["macos"] : [])];

function macosReport(plan, report) {
  const [check] = requireToolingShardReport(plan, report);
  if (plan.ciMacos !== true || check.toolingShard.id !== "native" ||
      report.environment?.platform !== "darwin" || report.environment.architecture !== "arm64" ||
      report.failure || report.sourceValidation?.status === "failed" || report.policyValidation?.status === "failed" ||
      check.executionState !== "exited" || check.commandOutcome?.observedProcess !== "owned-command-supervisor" ||
      check.commandOutcome.reason !== "exit" || check.commandOutcome.exitCode !== 0 || check.commandOutcome.cleanupFailure !== null) throw fail();
  return {
    version: report.version, base: report.base, source: { ...plan.source }, ciMacos: report.ciMacos,
    requiredChecks: [...plan.requiredChecks], requiredGroups: [...plan.requiredGroups],
    ...(plan.apple ? { apple: structuredClone(plan.apple) } : {}),
    toolingShards: structuredClone(plan.toolingShards), group: report.group, status: report.status, complete: report.complete,
    environment: { platform: report.environment.platform, architecture: report.environment.architecture },
    checks: [{ id: check.id, status: check.status, exitCode: check.exitCode, toolingShard: structuredClone(check.toolingShard),
      execution: { source: { ...plan.source }, startedAt: check.execution.startedAt, completedAt: check.execution.completedAt },
      executionState: check.executionState, commandOutcome: {
        observedProcess: check.commandOutcome.observedProcess, reason: check.commandOutcome.reason,
        exitCode: check.commandOutcome.exitCode, cleanupFailure: check.commandOutcome.cleanupFailure,
      } }],
  };
}

function requireAppleCIContext(evidence, context, attempt, role) {
  if (!APPLE_CI_ROLES.includes(role) || evidence?.version !== 2 || evidence.ciRole !== role ||
      evidence.origin !== "ci-xcodebuild" || evidence.ci?.repository !== context.repository ||
      evidence.ci.runId !== context.runId || evidence.ci.runAttempt !== String(attempt) ||
      evidence.ci.job !== "apple" || evidence.ci.sha !== context.tested.head) throw fail();
}

function requireContext(context) {
  if (!context || !validRepository(context.repository) ||
      !/^[1-9]\d*$/.test(context.runId ?? "") || !Number.isSafeInteger(context.attempt) || context.attempt < 1 ||
      !["pull_request", "workflow_dispatch"].includes(context.event) ||
      !sha.test(context.candidate ?? "") || !sha.test(context.tested?.head ?? "") || !sha.test(context.tested?.tree ?? "") ||
      !sha.test(context.workflowSha ?? "") || typeof context.workflowRef !== "string" ||
      !context.workflowRef.startsWith(`${context.repository}/.github/workflows/ci.yml@`) ||
      /[\r\n\0]/.test(context.workflowRef) ||
      context.event === "pull_request" && (!Number.isSafeInteger(context.pullRequest) || context.pullRequest < 1 ||
        !sha.test(context.pullRequestBase ?? ""))) throw fail();
  return context;
}

export async function githubVerificationContext(root, environment = process.env) {
  if (environment.GITHUB_ACTIONS !== "true" || !environment.GITHUB_EVENT_PATH) throw fail();
  const event = await readDiagnosticReport(environment.GITHUB_EVENT_PATH, { maximum: 1024 * 1024 });
  if (!event || typeof event !== "object" || Array.isArray(event)) throw fail();
  const head = (await readOnlyGit(root, ["rev-parse", "HEAD"])).trim();
  const tree = (await readOnlyGit(root, ["rev-parse", "HEAD^{tree}"])).trim();
  const pullRequest = environment.GITHUB_EVENT_NAME === "pull_request" ? event.pull_request : null;
  if (head !== environment.GITHUB_SHA || event.repository?.full_name !== environment.GITHUB_REPOSITORY ||
      pullRequest && (!validRepository(pullRequest.head?.repo?.full_name) ||
        pullRequest.base?.repo?.full_name !== environment.GITHUB_REPOSITORY)) throw fail();
  const context = requireContext({
    repository: environment.GITHUB_REPOSITORY, runId: environment.GITHUB_RUN_ID,
    attempt: Number(environment.GITHUB_RUN_ATTEMPT), event: environment.GITHUB_EVENT_NAME,
    workflowRef: environment.GITHUB_WORKFLOW_REF, workflowSha: environment.GITHUB_WORKFLOW_SHA,
    candidate: pullRequest?.head?.sha ?? head, pullRequest: pullRequest ? event.number : null,
    pullRequestBase: pullRequest?.base?.sha ?? null, tested: { head, tree },
  });
  if (pullRequest) {
    const parents = (await readOnlyGit(root, ["show", "-s", "--format=%P", head])).trim().split(" ");
    if (!equal(parents, [context.pullRequestBase, context.candidate])) throw fail();
  }
  return context;
}

export function ciReportEnvelope(report, context, unit, inputs = [], macos) {
  requireContext(context);
  if (!unitName.test(unit) || report?.version !== VERIFICATION_REPORT_VERSION ||
      !["passed", "partial", "blocked", "failed"].includes(report.status) || macos !== undefined && unit !== "gate") throw fail();
  return { version: 1, kind: "ci-verification-report", context, unit, inputs,
    reportDigest: digest(report), report, ...(macos !== undefined ? { macos } : {}) };
}

function requireEnvelope(value) {
  if (value?.version !== 1 || value.kind !== "ci-verification-report" || !unitName.test(value.unit ?? "") ||
      value.report?.version !== VERIFICATION_REPORT_VERSION || value.reportDigest !== digest(value.report) ||
      !Array.isArray(value.inputs) || value.macos !== undefined && value.unit !== "gate") throw fail();
  requireContext(value.context);
  return value;
}

async function writeEvidence(root, file, value) {
  const absolute = path.resolve(root, file);
  await diagnosticDirectory(root, path.dirname(absolute));
  const bytes = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw diagnosticError("output-limit");
  const output = await open(absolute, "wx", 0o600);
  try { await output.writeFile(bytes); await output.sync(); }
  finally { await output.close(); }
  return absolute;
}

export function collectCIReports(plan, context, envelopes, upstream) {
  requireContext(context);
  const expectedUnits = unitsFor(plan);
  const reports = [], inputs = [], seen = new Set();
  let macos;
  for (const input of envelopes) {
    const value = requireEnvelope(input), { attempt, ...identity } = value.context;
    const { attempt: currentAttempt, ...currentIdentity } = context;
    if (!equal(identity, currentIdentity) || attempt > currentAttempt ||
        !expectedUnits.includes(value.unit) || seen.has(value.unit) ||
        value.report.source?.head !== context.tested.head || value.report.base !== plan.base) throw fail();
    seen.add(value.unit);
    const group = value.unit.startsWith("tooling-") || value.unit === "macos" ? "tooling"
      : value.unit.startsWith("apple-") ? "apple" : value.unit;
    if (value.report.group !== group) throw fail();
    if (group === "apple") {
      const role = value.unit.slice("apple-".length);
      const check = value.report.checks?.find((check) => check.id === "apple-native");
      if (check?.appleShard?.role !== role) throw fail();
      requireAppleCIContext(check.appleEvidence, context, attempt, role);
    }
    if (value.unit === "macos") macos = macosReport(plan, value.report);
    else if (group === "tooling") {
      const descriptor = value.report.checks?.find((check) => check.id === "tooling-tests")?.toolingShard;
      if (value.unit !== `tooling-${descriptor?.id ?? "all"}`) throw fail();
    }
    if (value.unit !== "macos") reports.push(value.report);
    inputs.push({ unit: value.unit, attempt, reportDigest: value.reportDigest });
  }
  if (expectedUnits.some((unit) => !seen.has(unit)) ||
      plan.requiredGroups.some((group) => upstream.get(group) !== "success") ||
      plan.ciMacos === true && upstream.get("macos") !== "success") throw fail();
  return ciReportEnvelope(combineVerification(plan, reports), context, "gate",
    inputs.sort((a, b) => a.unit.localeCompare(b.unit)), macos);
}

async function readLatestInputs(root, directory, context) {
  await requireVerificationOutputDirectory(root, directory);
  directory = await diagnosticDirectory(root, directory);
  const latest = new Map(), entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 1024) throw diagnosticError("output-limit");
  const flat = entries.find((entry) => entry.name === "ci-report.json");
  for (const entry of entries) {
    const match = artifactName.exec(entry.name);
    if (!match) {
      if (entry.name.startsWith("verification-") && !/^verification-summary-attempt-[1-9]\d*$/.test(entry.name)) throw fail();
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw fail();
    const attempt = Number(match[2]);
    if (!Number.isSafeInteger(attempt) || attempt > context.attempt) throw fail();
    if (latest.has(match[1]) && latest.get(match[1]).attempt === attempt) throw fail();
    if (!latest.has(match[1]) || latest.get(match[1]).attempt < attempt) {
      latest.set(match[1], { attempt, file: path.join(directory, entry.name, "ci-report.json") });
    }
  }
  if (flat) {
    if (!flat.isFile() || flat.isSymbolicLink() || latest.size) throw fail();
    const envelope = requireEnvelope(await readDiagnosticReport(path.join(directory, flat.name), { maximum: 1024 * 1024 }));
    return envelope.unit === "gate" ? [] : [envelope];
  }
  return Promise.all([...latest].map(async ([unit, value]) => {
    const envelope = requireEnvelope(await readDiagnosticReport(value.file, { maximum: 1024 * 1024 }));
    if (envelope.unit !== unit || envelope.context.attempt !== value.attempt) throw fail();
    return envelope;
  }));
}

async function githubJson(endpoint) {
  const output = await exec("gh", ["api", "--hostname", "github.com", endpoint],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
  return JSON.parse(output.stdout);
}

async function artifactsFor(repository, run, api) {
  const artifacts = [];
  for (let page = 1; page <= 20; page++) {
    const result = await api(`repos/${repository}/actions/runs/${run}/artifacts?per_page=100&page=${page}`);
    if (!Array.isArray(result.artifacts)) throw fail();
    artifacts.push(...result.artifacts);
    if (artifacts.length >= result.total_count) return artifacts;
  }
  throw diagnosticError("output-limit");
}

function requireLiveBaseReference(reference, branch, expected) {
  if (reference?.ref !== `refs/heads/${branch}` || reference.object?.type !== "commit" ||
      !sha.test(reference.object?.sha ?? "")) throw fail();
  if (reference.object.sha !== expected) throw diagnosticError("ci-base-changed");
}

export function validateLiveCIEnvelope(envelope, { repository, pullRequest, baseReference, run, jobs, artifact, commit, candidate }) {
  const value = requireEnvelope(envelope), context = value.context;
  const gateJobs = jobs.jobs?.filter((job) => job.name === "Required verification") ?? [];
  if (value.unit !== "gate" || context.repository !== repository || context.event !== "pull_request" ||
      pullRequest.state !== "open" || pullRequest.head?.repo?.full_name !== repository ||
      pullRequest.base?.repo?.full_name !== repository || pullRequest.head?.sha !== candidate ||
      typeof pullRequest.base.ref !== "string" || !pullRequest.base.ref.length ||
      context.pullRequest !== pullRequest.number || context.candidate !== candidate ||
      !sha.test(pullRequest.base.sha ?? "") ||
      run.event !== "pull_request" || run.path !== ".github/workflows/ci.yml" ||
      run.status !== "completed" || run.conclusion !== "success" || run.head_sha !== candidate ||
      String(run.id) !== context.runId || run.run_attempt !== context.attempt ||
      !run.pull_requests?.some((pr) => pr.number === pullRequest.number) ||
      gateJobs.length !== 1 || gateJobs[0].status !== "completed" || gateJobs[0].conclusion !== "success" ||
      !Number.isSafeInteger(pullRequest.base.repo.id) || !Number.isSafeInteger(pullRequest.head.repo.id) ||
      artifact.expired !== false || artifact.name !== `verification-summary-attempt-${context.attempt}` ||
      String(artifact.workflow_run?.id) !== context.runId || artifact.workflow_run?.head_sha !== candidate ||
      artifact.workflow_run?.repository_id !== pullRequest.base.repo.id ||
      artifact.workflow_run?.head_repository_id !== pullRequest.head.repo.id ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") ||
      commit.sha !== context.tested.head || commit.tree?.sha !== context.tested.tree ||
      !equal(commit.parents?.map((parent) => parent.sha), [context.pullRequestBase, candidate]) ||
      value.report.source?.head !== context.tested.head || value.report.base !== context.pullRequestBase ||
      value.report.status !== "passed" || value.report.complete !== true) throw fail();
  requireLiveBaseReference(baseReference, pullRequest.base.ref, context.pullRequestBase);
  combineVerification(value.report, [value.report]);
  if (value.report.ciMacos === true) {
    if (!equal(value.macos, macosReport(value.report, value.macos))) throw fail();
  } else if (value.macos !== undefined) throw fail();
  const expected = unitsFor(value.report), units = value.inputs.map((input) => input.unit);
  if (units.length !== expected.length || new Set(units).size !== units.length ||
      expected.some((unit) => !units.includes(unit)) || value.inputs.some((input) =>
        !Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > context.attempt ||
        !/^[a-f0-9]{64}$/.test(input.reportDigest ?? ""))) throw fail();
  if (value.report.requiredGroups.includes("apple")) {
    const evidence = value.report.checks.find((check) => check.id === "apple-native")?.appleEvidence;
    if (evidence?.kind !== "apple-native-matrix" || evidence.nativeAcceptanceRequired !== true ||
        !Array.isArray(evidence.parts) || evidence.parts.length !== APPLE_CI_ROLES.length) throw fail();
    for (const role of APPLE_CI_ROLES) {
      const part = evidence.parts.find((part) => part.ciRole === role);
      requireAppleCIContext(part, context, value.inputs.find((input) => input.unit === `apple-${role}`).attempt, role);
    }
  }
  return value;
}

async function requirePolicyIdentity(root, candidate, repository, commit, api) {
  const local = new Map((await committedInputEntries(root, candidate))
    .filter((entry) => isVerificationPolicyPath(entry.file)).map((entry) => [entry.file, `${entry.mode}:${entry.oid}`]));
  const tree = await api(`repos/${repository}/git/trees/${commit}?recursive=1`);
  if (tree.truncated || !Array.isArray(tree.tree)) throw fail();
  const remote = new Map(tree.tree.filter((entry) => entry.type === "blob" && isVerificationPolicyPath(entry.path))
    .map((entry) => [entry.path, `${entry.mode}:${entry.sha}`]));
  if (local.size !== remote.size || [...local].some(([file, value]) => remote.get(file) !== value)) {
    throw diagnosticError("ci-policy-mismatch");
  }
}

export async function qualifyGitHubCI(root, options) {
  const { repository, pullRequest, runId, base, directory, api = githubJson } = options;
  if (!validRepository(repository) || !/^[1-9]\d*$/.test(String(pullRequest)) ||
      !/^[1-9]\d*$/.test(String(runId))) throw diagnosticError("configuration");
  await requireVerificationOutputDirectory(root, directory);
  const { inspectWorktree } = await import("./candidate-commit.mjs");
  const { runCommand } = await import("./process.mjs");
  const before = await inspectWorktree(root);
  if (before.status) throw diagnosticError("source-changed");
  const origin = (await readOnlyGit(root, ["remote", "get-url", "origin"])).trim();
  const originRepository = origin.replace(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/, "").replace(/\.git$/, "");
  if (originRepository !== repository) throw fail();
  const plan = await verificationPlan(root, base), candidate = before.source.head;
  try { await readOnlyGit(root, ["merge-base", "--is-ancestor", plan.base, candidate]); }
  catch (error) { throw diagnosticError("source-mismatch", error); }
  const [pr, run] = await Promise.all([
    api(`repos/${repository}/pulls/${pullRequest}`), api(`repos/${repository}/actions/runs/${runId}`),
  ]);
  if (pr.head?.sha !== candidate || run.head_sha !== candidate ||
      run.status !== "completed" || run.conclusion !== "success" || !Number.isSafeInteger(run.run_attempt) ||
      pr.base?.repo?.full_name !== repository || typeof pr.base?.ref !== "string" ||
      !pr.base.ref.length || pr.base.ref.length > 1024 || /[\x00-\x1f]/.test(pr.base.ref)) throw fail();
  const baseEndpoint = `repos/${repository}/git/ref/heads/${encodeURIComponent(pr.base.ref)}`;
  const [jobs, artifacts, baseReference] = await Promise.all([
    api(`repos/${repository}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`),
    artifactsFor(repository, runId, api),
    api(baseEndpoint),
  ]);
  if (jobs.total_count > 100) throw fail();
  const matches = artifacts.filter((artifact) => artifact.name === `verification-summary-attempt-${run.run_attempt}`);
  if (matches.length !== 1) throw fail();
  const artifact = matches[0];
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 1 || artifact.expired ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") ||
      !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 ||
      artifact.size_in_bytes > 4 * 1024 * 1024) throw fail();
  const destination = await diagnosticDirectory(root, directory), archive = path.join(destination, "ci-evidence.zip");
  const downloaded = await exec("gh", ["api", "--hostname", "github.com", `repos/${repository}/actions/artifacts/${artifact.id}/zip`],
    { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, timeout: 60000 });
  const output = await open(archive, "wx", 0o600);
  try { await output.writeFile(downloaded.stdout); await output.sync(); }
  finally { await output.close(); }
  const helper = fileURLToPath(new URL("./verification-ci-artifact.ps1", import.meta.url));
  const result = await runCommand("pwsh", ["-NoProfile", "-NonInteractive", "-File", helper,
    "-Archive", archive, "-Sha256", artifact.digest.slice(7)], { cwd: root, timeoutMs: 30000, graceMs: 5000 });
  const envelope = requireEnvelope(JSON.parse(result.stdout));
  const commit = await api(`repos/${repository}/git/commits/${envelope.context.tested.head}`);
  validateLiveCIEnvelope(envelope, { repository, pullRequest: pr, baseReference, run, jobs, artifact, commit, candidate });
  if (plan.requiredChecks.some((check) => !envelope.report.requiredChecks.includes(check)) ||
      plan.ciMacos === true && envelope.report.ciMacos !== true ||
      plan.layouts && !envelope.report.layouts ||
      (plan.trustedDeviceClasses ?? []).some((name) => !envelope.report.trustedDeviceClasses?.includes(name))) throw fail();
  for (const policyCommit of new Set([envelope.context.tested.head, envelope.context.workflowSha])) {
    const object = policyCommit === commit.sha ? commit : await api(`repos/${repository}/git/commits/${policyCommit}`);
    if (object.sha !== policyCommit || !sha.test(object.tree?.sha ?? "")) throw fail();
    await requirePolicyIdentity(root, candidate, repository, object.tree.sha, api);
  }
  const [afterPR, afterRun, afterBase, after] = await Promise.all([
    api(`repos/${repository}/pulls/${pullRequest}`), api(`repos/${repository}/actions/runs/${runId}`),
    api(baseEndpoint), inspectWorktree(root),
  ]);
  requireLiveBaseReference(afterBase, pr.base.ref, envelope.context.pullRequestBase);
  if (afterPR.state !== "open" || afterPR.head?.sha !== candidate ||
      afterPR.base?.ref !== pr.base.ref ||
      afterRun.run_attempt !== run.run_attempt || afterRun.status !== "completed" || afterRun.conclusion !== "success" ||
      after.status || !equal(before.source, after.source) || !equal(before.identity, after.identity) ||
      before.index !== after.index || before.configuration !== after.configuration) throw fail();
  const evidence = await writeEvidence(root, path.join(destination, "ci-report.json"), envelope);
  const nativeAcceptanceRequired = envelope.report.checks.some((check) =>
    check.id === "apple-native" && check.appleEvidence?.nativeAcceptanceRequired === true);
  return { version: 1, kind: "ci-qualification", status: "verified", base: plan.base, candidate: before.source,
    tested: envelope.context.tested, pullRequest: { repository, number: pr.number, base: baseReference.object.sha, baseRef: pr.base.ref },
    workflow: { runId: String(run.id), attempt: run.run_attempt, url: run.html_url },
    artifact: { id: artifact.id, digest: artifact.digest }, evidence: path.relative(root, evidence),
    reportDigest: envelope.reportDigest, ...(nativeAcceptanceRequired ? { nativeAcceptanceRequired: true } : {}),
    qualification: nativeAcceptanceRequired
      ? "Hosted CI checks only; same-candidate complete native acceptance, independent review and delivery authorization remain required."
      : "CI checks only; independent review and delivery authorization remain separate." };
}

async function main() {
  const { values } = parseArgs({ options: {
    seal: { type: "boolean" }, collect: { type: "boolean" }, qualify: { type: "boolean" },
    input: { type: "string" }, inputs: { type: "string" }, report: { type: "string" }, unit: { type: "string" },
    base: { type: "string" }, repository: { type: "string" }, pr: { type: "string" }, run: { type: "string" },
    upstream: { type: "string", multiple: true, default: [] },
  } });
  if ([values.seal, values.collect, values.qualify].filter(Boolean).length !== 1 || !values.report) {
    throw diagnosticError("configuration");
  }
  const root = process.cwd(), report = path.resolve(values.report);
  await requireVerificationReportPath(root, report);
  const name = path.basename(report);
  if (values.collect && (process.platform === "win32" ? name.toLowerCase() : name) === "gate.json") {
    throw diagnosticError("configuration");
  }
  let result;
  if (values.qualify) {
    result = await qualifyGitHubCI(root, { repository: values.repository, pullRequest: values.pr,
      runId: values.run, base: values.base, directory: `${report}.evidence` });
  } else {
    const context = await githubVerificationContext(root);
    if (values.seal) {
      if (!values.input) throw diagnosticError("configuration");
      await requireVerificationOutputDirectory(root, path.dirname(path.resolve(values.input)));
      await diagnosticDirectory(root, path.dirname(path.resolve(values.input)));
      result = ciReportEnvelope(await readDiagnosticReport(values.input), context, values.unit);
    } else {
      if (!values.inputs || !values.base) throw diagnosticError("configuration");
      const upstream = new Map();
      for (const value of values.upstream) {
        const [group, status, extra] = value.split(":");
        if (![...CHECK_GROUPS, "macos"].includes(group) || upstream.has(group) || extra !== undefined ||
            !["success", "failure", "cancelled", "skipped", "unknown"].includes(status)) throw diagnosticError("configuration");
        upstream.set(group, status);
      }
      const plan = await verificationPlan(root, values.base);
      try {
        result = collectCIReports(plan, context, await readLatestInputs(root, values.inputs, context), upstream);
      } catch (error) {
        result = ciReportEnvelope({ ...plan, group: "all", status: "blocked", complete: false, checks: [],
          failure: verificationFailure(error, "aggregate") }, context, "gate");
        process.exitCode = 1;
      }
      await writeEvidence(root, path.join(path.dirname(path.resolve(values.report)), "gate.json"), result.report);
    }
  }
  await writeEvidence(root, values.report, result);
  console.log(JSON.stringify({ kind: result.kind, status: result.status ?? result.report?.status, report: values.report }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    console.error(JSON.stringify({ kind: "ci-evidence-failure", status: "blocked", failure: failureDetails(error, "ci-evidence") }));
    process.exitCode = 1;
  }
}
