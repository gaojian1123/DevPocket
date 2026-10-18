import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { acquireHostVerificationSlot, admissionVariable } from "../verification-admission.mjs";
import { toolingCatalogue, toolingShardDescriptor } from "../verification-tooling.mjs";
import { combineVerification, verificationPlan } from "../verification.mjs";
import { VERIFICATION_REPORT_VERSION } from "../verification-policy.mjs";
import { syntheticExecution } from "./fixtures/verification-tools.mjs";
import { WORKFLOW_TEST_FILES, WORKFLOW_TEST_SHARDS } from "../test-workflow.mjs";
import { ciReportEnvelope, collectCIReports, githubVerificationContext, validateLiveCIEnvelope } from "../verification-ci.mjs";

const exec = promisify(execFile);

async function fixture(t) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/verification-execution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("tooling shards partition the complete declared suite and preserve every execution origin", async () => {
  const catalogue = await toolingCatalogue(process.cwd());
  assert.ok(catalogue);
  const files = catalogue.parts.flatMap((part) => part.files).sort();
  assert.deepEqual(files, [...catalogue.files].sort());
  assert.equal(new Set(files).size, files.length);
  const plan = { version: VERIFICATION_REPORT_VERSION, base: "a".repeat(40),
    source: { head: "b".repeat(40), fingerprint: "c".repeat(64) },
    requiredChecks: ["workflow-tests"], requiredGroups: ["tooling"], toolingShards: catalogue };
  const reports = catalogue.parts.map((part) => ({
    ...plan, group: "tooling", status: "partial", complete: false,
    checks: [{ id: "workflow-tests", status: "passed", exitCode: 0,
      toolingShard: toolingShardDescriptor(plan, part.id), execution: syntheticExecution(plan.source) }],
  }));
  const combined = combineVerification(plan, reports);
  assert.equal(combined.complete, true);
  assert.equal(combined.checks[0].execution.kind, "tooling-shards");
  assert.deepEqual(combined.checks[0].execution.parts.map((part) => part.execution),
    reports.map((report) => report.checks[0].execution));
  assert.deepEqual(combineVerification(plan, [combined]), combined);
  for (const change of [
    (rows) => rows.pop(),
    (rows) => rows.push(rows[0]),
    (rows) => { rows[0].complete = true; rows[0].status = "passed"; },
    (rows) => { rows[0].checks[0].status = "failed"; },
    (rows) => { rows[0].checks[0].toolingShard.catalogue = "d".repeat(64); },
    (rows) => { rows[0].checks[0].execution.source.head = "d".repeat(40); },
    (rows) => { rows[0].version = 4; },
  ]) {
    const altered = structuredClone(reports); change(altered);
    assert.throws(() => combineVerification(plan, altered));
  }
  const stripped = structuredClone(combined);
  stripped.checks[0].execution.parts.pop();
  assert.throws(() => combineVerification(plan, [stripped]));
});

test("the actual shard CLI executes only its assigned files and cannot independently complete verification", async (t) => {
  const root = await fixture(t), scripts = path.join(root, "scripts");
  await mkdir(path.join(scripts, "tests"), { recursive: true });
  await mkdir(path.join(root, ".data"));
  await copyFile(path.resolve("scripts", "test-workflow.mjs"), path.join(scripts, "test-workflow.mjs"));
  for (const [index, file] of WORKFLOW_TEST_FILES.entries()) {
    await writeFile(path.join(root, file),
      `import {test} from 'node:test';import {appendFileSync} from 'node:fs';test('part-${index}',()=>appendFileSync('.data/counts','${index}\\n'));\n`);
  }
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: {
    "test:workflow": "node scripts/test-workflow.mjs",
  } }));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "-m", "Shard fixture"], { cwd: root });
  await writeFile(path.join(scripts, "verification.mjs"), "// changed tooling contract\n");
  const reports = [];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const { id: part } of WORKFLOW_TEST_SHARDS) {
    const report = path.join(root, ".data", "verification", part, "report.json");
    await exec(process.execPath, [path.resolve("scripts/verify.mjs"), "--repo", root, "--base", "HEAD",
      "--group", "tooling", "--tooling-shard", part, "--report", report], { timeout: 120000, env });
    reports.push(JSON.parse(await readFile(report, "utf8")));
    assert.equal(reports.at(-1).status, "partial");
    assert.equal(reports.at(-1).complete, false);
  }
  const counts = (await readFile(path.join(root, ".data", "counts"), "utf8")).trim().split("\n").map(Number).sort((a, b) => a - b);
  assert.deepEqual(counts, WORKFLOW_TEST_FILES.map((_, index) => index));
  const combined = combineVerification(reports[0], reports);
  assert.equal(combined.complete, true);
  assert.equal(combined.checks[0].execution.parts.length, WORKFLOW_TEST_SHARDS.length);
  await assert.rejects(exec(process.execPath, [path.resolve("scripts/verify.mjs"), "--repo", root, "--base", "HEAD",
    "--group", "tooling", "--resume", path.join(root, reports[0].run.manifest),
    "--report", path.join(root, ".data", "verification", "wrong-scope", "report.json")], { timeout: 120000, env }));
  assert.deepEqual((await readFile(path.join(root, ".data", "counts"), "utf8")).trim().split("\n").map(Number).sort((a, b) => a - b), counts);
});

test("host admission queues independent worktrees and permits only a live inherited ticket", async (t) => {
  const root = await fixture(t), directory = path.join(root, "admission");
  const firstRoot = path.join(root, "worktree-a"), secondRoot = path.join(root, "worktree-b");
  await mkdir(firstRoot); await mkdir(secondRoot);
  const first = await acquireHostVerificationSlot(firstRoot, { directory });
  t.after(() => first.release(true));
  const borrowed = await acquireHostVerificationSlot(root, {
    directory, inherited: first.environment[admissionVariable],
  });
  assert.equal(borrowed.evidence.mode, "inherited");
  await borrowed.release(true);
  await assert.rejects(acquireHostVerificationSlot(root, { directory,
    inherited: JSON.stringify({ ...JSON.parse(first.environment[admissionVariable]), token: "0".repeat(64) }) }),
  { diagnosticCode: "admission-unconfirmed" });
  let notify;
  const queued = new Promise((resolve) => { notify = resolve; });
  const second = acquireHostVerificationSlot(secondRoot, { directory, inherited: "", onWait: notify });
  await queued;
  let entered = false;
  second.then(() => { entered = true; });
  assert.equal(entered, false);
  await first.release(true);
  const admitted = await second;
  assert.equal(admitted.evidence.mode, "owned");
  assert.ok(admitted.evidence.waitedMs > 0);
  await admitted.release(true);
  await assert.rejects(acquireHostVerificationSlot(root, {
    directory, inherited: first.environment[admissionVariable],
  }), { diagnosticCode: "admission-unconfirmed" });
});

test("cancelled admission does not release another owner and unknown cleanup cannot be reclaimed", async (t) => {
  const root = await fixture(t), directory = path.join(root, "admission");
  const first = await acquireHostVerificationSlot(root, { directory });
  t.after(() => first.release(false));
  const cancellation = new AbortController();
  let notify;
  const queued = new Promise((resolve) => { notify = resolve; });
  const waiting = acquireHostVerificationSlot(root, {
    directory, inherited: "", signal: cancellation.signal, onWait: notify,
  });
  const rejected = assert.rejects(waiting, (error) => error === cancellation.signal.reason ||
    error.code === "ABORT_ERR" && error.cause === cancellation.signal.reason);
  await queued;
  cancellation.abort(new Error("Stop waiting"));
  await rejected;
  assert.ok(await readFile(path.join(directory, "owner.json")));
  await first.release(false);
  await assert.rejects(acquireHostVerificationSlot(root, { directory, inherited: "" }),
    { diagnosticCode: "admission-unconfirmed" });
});

async function ciFixture(t) {
  const root = await fixture(t);
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  await mkdir(path.join(root, ".data"));
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  await writeFile(path.join(root, "package.json"), '{"scripts":{"test:workflow":"node -e \\"process.exit(0)\\""}}\n');
  await git("init", "--quiet");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "CI base");
  const base = await git("rev-parse", "HEAD");
  await git("checkout", "--quiet", "-b", "candidate");
  await writeFile(path.join(root, "scripts", "verification.mjs"), "// fixture input\n");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "CI candidate");
  const candidate = await git("rev-parse", "HEAD");
  await git("checkout", "--quiet", "--detach", base);
  await git("merge", "--quiet", "--no-ff", "-m", "CI merge ref", candidate);
  const head = await git("rev-parse", "HEAD"), repository = "fixture/verification";
  const eventPath = path.join(root, ".data", "event.json");
  const pullRequest = { number: 11, state: "open",
    head: { sha: candidate, repo: { full_name: repository, id: 1 } },
    base: { sha: base, ref: "main", repo: { full_name: repository, id: 1 } } };
  await writeFile(eventPath, JSON.stringify({ number: 11, repository: { full_name: repository }, pull_request: pullRequest }));
  const env = { ...process.env, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: head, GITHUB_WORKFLOW_SHA: head,
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/pull/11/merge` };
  delete env.NODE_TEST_CONTEXT;
  const context = await githubVerificationContext(root, env), plan = await verificationPlan(root, base);
  const report = { ...plan, group: "tooling", status: "passed", complete: true, fixtureEvidence: true,
    checks: [{ id: "workflow-tests", status: "passed", exitCode: 0, execution: syntheticExecution(plan.source) }] };
  return { root, base, candidate, repository, pullRequest, env, context, plan, report };
}

test("CI collection binds real merge ancestry while preserving earlier failed attempts", async (t) => {
  const item = await ciFixture(t), inputs = path.join(item.root, ".data", "ci", "inputs");
  const failed = { ...structuredClone(item.report), status: "failed", complete: false };
  failed.checks[0].status = "failed"; failed.checks[0].exitCode = 1;
  const writeAttempt = async (attempt, report) => {
    const directory = path.join(inputs, `verification-tooling-all-attempt-${attempt}`);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "ci-report.json");
    await writeFile(file, JSON.stringify(ciReportEnvelope(report, { ...item.context, attempt }, "tooling-all")));
    return file;
  };
  const original = await writeAttempt(1, failed), bytes = await readFile(original);
  await writeAttempt(2, item.report);
  const invoke = async (name, env, inputDirectory = inputs) => {
    const file = path.join(item.root, ".data", "ci", name, "ci-report.json");
    await exec(process.execPath, [path.resolve("scripts/verification-ci.mjs"), "--collect", "--base", item.base,
      "--inputs", inputDirectory, "--report", file, "--upstream", "tooling:success"], { cwd: item.root, env, timeout: 30000 });
    return JSON.parse(await readFile(file, "utf8"));
  };
  const accepted = await invoke("accepted", item.env);
  assert.equal(accepted.report.status, "passed");
  assert.equal(accepted.context.candidate, item.candidate);
  assert.notEqual(accepted.report.source.head, item.candidate);
  assert.deepEqual(accepted.inputs.map(({ unit, attempt }) => ({ unit, attempt })), [{ unit: "tooling-all", attempt: 2 }]);
  assert.deepEqual(await readFile(original), bytes);
  const flat = path.join(item.root, ".data", "ci", "single-input");
  await mkdir(flat);
  await writeFile(path.join(flat, "ci-report.json"), JSON.stringify(ciReportEnvelope(item.report, item.context, "tooling-all")));
  assert.equal((await invoke("flat", item.env, flat)).report.complete, true);
  await writeAttempt(3, failed);
  await assert.rejects(invoke("failed", { ...item.env, GITHUB_RUN_ATTEMPT: "3" }));
  const blocked = JSON.parse(await readFile(path.join(item.root, ".data", "ci", "failed", "gate.json"), "utf8"));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.complete, false);
  assert.deepEqual(await readFile(original), bytes);
  await assert.rejects(githubVerificationContext(item.root, { ...item.env, GITHUB_SHA: item.candidate }));
});

test("CI qualification rejects stale, foreign, incomplete and relabelled platform evidence", async (t) => {
  const item = await ciFixture(t);
  const leaf = ciReportEnvelope(item.report, item.context, "tooling-all");
  const gate = collectCIReports(item.plan, item.context, [leaf], new Map([["tooling", "success"]]));
  const live = { repository: item.repository, pullRequest: item.pullRequest, candidate: item.candidate,
    run: { id: 1234, event: "pull_request", path: ".github/workflows/ci.yml", run_attempt: 2,
      head_sha: item.candidate, status: "completed", conclusion: "success", pull_requests: [{ number: 11 }] },
    jobs: { jobs: [{ name: "Required verification", status: "completed", conclusion: "success" }] },
    artifact: { name: "verification-summary-attempt-2", expired: false, digest: `sha256:${"a".repeat(64)}`,
      workflow_run: { id: 1234, head_sha: item.candidate, repository_id: 1, head_repository_id: 1 } },
    commit: { sha: item.context.tested.head, tree: { sha: item.context.tested.tree },
      parents: [{ sha: item.base }, { sha: item.candidate }] } };
  assert.equal(validateLiveCIEnvelope(gate, live), gate);
  for (const mutate of [
    (value) => { value.pullRequest.head.sha = "f".repeat(40); },
    (value) => { value.pullRequest.base.sha = "f".repeat(40); },
    (value) => { value.run.run_attempt = 3; },
    (value) => { value.run.path = ".github/workflows/not-verification.yml"; },
    (value) => { value.run.conclusion = "cancelled"; },
    (value) => { value.jobs.jobs = []; },
    (value) => { value.artifact.expired = true; },
    (value) => { value.artifact.workflow_run.repository_id = 2; },
    (value) => { value.commit.parents.reverse(); },
    (value) => { value.commit.tree.sha = "f".repeat(40); },
  ]) {
    const invalid = structuredClone(live); mutate(invalid);
    assert.throws(() => validateLiveCIEnvelope(gate, invalid));
  }
  const withoutOrigins = structuredClone(gate);
  delete withoutOrigins.report.checks[0].execution;
  withoutOrigins.reportDigest = createHash("sha256").update(JSON.stringify(withoutOrigins.report)).digest("hex");
  assert.throws(() => validateLiveCIEnvelope(withoutOrigins, live));
  const withoutInputs = structuredClone(gate);
  withoutInputs.inputs = [];
  assert.throws(() => validateLiveCIEnvelope(withoutInputs, live));
  assert.throws(() => collectCIReports(item.plan, item.context, [leaf, leaf], new Map([["tooling", "success"]])));
  assert.throws(() => collectCIReports(item.plan, item.context, [leaf], new Map([["tooling", "cancelled"]])));
  const foreign = ciReportEnvelope(item.report, { ...item.context, runId: "5678" }, "tooling-all");
  assert.throws(() => collectCIReports(item.plan, item.context, [foreign], new Map([["tooling", "success"]])));
});

test("the CI artifact reader verifies authenticated bytes and never extracts unexpected paths", async (t) => {
  const root = await fixture(t), creator = path.join(root, "archive-fixture.ps1");
  await writeFile(creator, [
    "param([string]$Archive,[string]$Entry)",
    "$ErrorActionPreference='Stop'",
    "$zip=[IO.Compression.ZipFile]::Open($Archive,[IO.Compression.ZipArchiveMode]::Create)",
    "try {",
    "  foreach($name in @('gate.json',$Entry)) {",
    "    $writer=[IO.StreamWriter]::new($zip.CreateEntry($name).Open(),[Text.UTF8Encoding]::new($false))",
    "    try { $writer.Write('{\"fixture\":\"bounded\"}') } finally { $writer.Dispose() }",
    "  }",
    "} finally { $zip.Dispose() }",
  ].join("\n"));
  const helper = path.resolve("scripts/verification-ci-artifact.ps1");
  for (const [index, entry] of ["ci-report.json", "../ci-report.json"].entries()) {
    const archive = path.join(root, `evidence-${index}.zip`);
    await exec("pwsh", ["-NoProfile", "-File", creator, "-Archive", archive, "-Entry", entry], { timeout: 30000 });
    const hash = createHash("sha256").update(await readFile(archive)).digest("hex");
    const args = ["-NoProfile", "-File", helper, "-Archive", archive, "-Sha256"];
    await assert.rejects(exec("pwsh", [...args, "0".repeat(64)], { timeout: 30000 }));
    if (index) await assert.rejects(exec("pwsh", [...args, hash], { timeout: 30000 }));
    else assert.deepEqual(JSON.parse((await exec("pwsh", [...args, hash], { timeout: 30000 })).stdout), { fixture: "bounded" });
  }
  await assert.rejects(readFile(path.join(root, "ci-report.json")), { code: "ENOENT" });
});
