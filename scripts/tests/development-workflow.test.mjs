import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import fs, { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { checkDevelopmentReadiness, parseRepairDiagnosis, parseTask, runDevelopment, taskSchema } from "../development-workflow.mjs";
import { changedPaths, inspectWorktree, prepareCandidate, sha256, validateCandidateReceiptProof, activeHookSnapshot } from "../candidate-commit.mjs";
import { executeVerification, git, sourceSnapshot, validateVerificationEvidence, verificationPlan } from "../verification.mjs";
import { captureCandidateImplementation, nativeCandidateCommand, requireCandidateImplementation } from "../native-candidate.mjs";
import { syntheticExecution } from "./fixtures/verification-tools.mjs";
import { developmentApprovalDetails, developmentApprovalRequest, developmentApprovalSatisfied, developmentReviewRequirements,
  formatDevelopmentApproval, inspectDevelopmentPolicy, isVerificationPolicyPath, obtainDevelopmentApproval } from "../development-policy.mjs";
import { developmentTaskApprovalRequest, developmentTaskActionAllowed, developmentExecutionAuthorization } from "../development-policy.mjs";
import { originRepository, requirePushTarget } from "../git-state.mjs";

const exec = promisify(execFile);
const verificationInputs = ["verification-executor.mjs", "verification-backend.mjs",
  "verification-android.mjs", "backend-diagnostics.mjs", "verification-preflight.mjs", "verification-run.mjs",
  "verification-transition.mjs", "test-workflow.mjs", "verification-tooling.mjs",
  "verification-admission.mjs", "verification-ci.mjs", "verification-ci-artifact.ps1",
  "owned-command-darwin.py", "local-ipc.mjs", "android-platform.mjs", "emulator-resources.mjs"];
// Top-level tests stay serial; only fresh-workspace cases without shared environment writes use this limit.
const isolatedCases = { concurrency: 2 };

function nativeSession() {
  return { sessionId: "fixture-session", rpc: { tools: {
    getCurrentMetadata: async () => ({ tools: [{ name: "functions.powershell" }] }),
    execute: async (request) => {
      assert.equal(request.name, "functions.powershell");
      assert.equal(request.arguments.mode, "sync");
      assert.match(request.arguments.command, /runFrozenCandidate/);
      assert.match(request.arguments.command, /--request '/);
      try {
        const result = await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", request.arguments.command],
          { timeout: 180_000 });
        return { resultType: "success", textResultForLlm: result.stdout };
      } catch (error) { return { resultType: "failure", textResultForLlm: error.stderr }; }
    },
  } } };
}

async function implemented(root, summary = "Changed") {
  const source = await sourceSnapshot(root);
  return { status: "implemented", summary, source, ownedFiles: await changedPaths(root, source.head) };
}

async function copiedController(root, beforeLoad) {
  const inputs = await captureCandidateImplementation();
  const directory = path.join(root, ".data", "implementation");
  await mkdir(directory, { recursive: true });
  for (const input of inputs.files) {
    const bytes = await readFile(path.join(inputs.directory, input.name));
    assert.equal(sha256(bytes), input.sha256);
    await mkdir(path.dirname(path.join(directory, input.name)), { recursive: true });
    await writeFile(path.join(directory, input.name), bytes, { flag: "wx" });
  }
  await beforeLoad?.(directory);
  return { directory, controller: await import(pathToFileURL(path.join(directory, "development-workflow.mjs")).href) };
}

const passingReview = { verdict: "pass", findings: [] };
const blockingReview = { verdict: "changes_requested", findings: [
  { severity: "blocking", file: "README.md", line: 1, impact: "Missing behavior", reproduction: "Read it" },
] };
test("repository routing discovers the development skill without requiring workflow activation", async () => {
  const [agents, skill, readme, issue, guide, reviewer] = await Promise.all([
    "../../AGENTS.md", "../../.github/skills/devpocket-development/SKILL.md",
    "../../README.md", "../../.github/ISSUE_TEMPLATE/ai-task.yml", "../../docs/DEVELOPMENT-WORKFLOW.md",
    "../../.github/agents/devpocket-reviewer.agent.md",
  ].map((file) => readFile(new URL(file, import.meta.url), "utf8")));
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill)?.[1];
  assert.ok(frontmatter, "The default recipe must be a discoverable skill.");
  assert.match(frontmatter, /^name: devpocket-development$/m);
  assert.match(frontmatter, /^description: .+features and bug fixes/m);
  assert.doesNotMatch(frontmatter, /disable-model-invocation:\s*true/);
  assert.match(agents, /`devpocket-development` skill by default/);
  assert.ok(agents.includes(".github\\skills\\devpocket-development\\SKILL.md"));
  assert.match(agents, /otherwise read that file directly/);
  assert.match(agents, /workflow only when the user explicitly/);
  assert.doesNotMatch(agents, /`devpocket-development` workflow by default/);
  assert.match(skill, /clean linked worktree, implement in the current session/);
  assert.match(skill, /--no-optional-locks -c core\.fsmonitor=false status --porcelain --untracked-files=all --ignore-submodules=none/);
  assert.match(skill, /Continue an existing task in its own worktree/);
  assert.match(skill, /npm run verify -- -Base BASE_COMMIT/);
  assert.match(skill, /read\/search-only `devpocket-reviewer` in a separate context/);
  assert.match(skill, /--combine/);
  assert.match(skill, /source identity matches the review/);
  assert.match(skill, /requiresHumanReview/);
  assert.ok(skill.includes("scripts\\development-policy.mjs"));
  assert.match(skill, /developmentReviewRequirements/);
  assert.match(skill, /CI reports do not supply/);
  assert.match(readme, /skill\*\* is the default agent route/);
  assert.match(issue, /registered workflow is optional/);
  const optional = guide.split("## Optional: registered workflow")[1];
  assert.ok(optional);
  assert.match(optional, /only when the user explicitly selects/);
  assert.match(optional, /Calling `devpocket_start_development` here also invokes that workflow exactly\s+once/);
  assert.match(optional, /Never fall back to creating a\s+child/);
  assert.match(reviewer, /For working-tree implementation/);
  assert.match(reviewer, /For candidate-commit delivery/);
  const invocation = JSON.parse(/```json\r?\n([\s\S]*?)\r?\n```/.exec(optional)?.[1] ?? "null");
  assert.equal(invocation?.name, "devpocket-development");
  assert.ok(invocation.args.goal);
  assert.ok(invocation.args.acceptance.length);
  assert.equal(Object.hasOwn(invocation.args, "maxRepairRounds"), false);
  assert.match(skill, /stating the contract is not another plan-approval/);
  assert.match(skill, /no implicit two-round limit/);
  assert.doesNotMatch(skill, /Allow at most two repair rounds/);
  assert.match(guide, /There is no additional project-default time, cost or repair-round ceiling/);
  assert.match(reviewer, /For \*\*repair diagnosis\*\*/);
  assert.match(reviewer, /Diagnosis never establishes acceptance, approval or publication readiness/);
  assert.match(skill, /`ci-inspection` procedure instead of adopting candidate control/);
  assert.match(guide, /It never excuses failed, partial or unavailable evidence/);
  assert.match(reviewer, /underlying live API\/archive\/source records/);
});

test("the skill freezes an authorized delivery candidate before final verification and review", async () => {
  const skill = await readFile(new URL("../../.github/skills/devpocket-development/SKILL.md", import.meta.url), "utf8");
  const sections = skill.split(/^## \d+\. /m).slice(1);
  assert.deepEqual(sections.map((section) => section.split(/\r?\n/, 1)[0]), [
    "Establish the task", "Select the workspace", "Implement in the owning session",
    "Freeze the verification target", "Obtain source-bound verification",
    "Request independent review", "Repair and recheck", "Hand off or publish",
  ]);
  const [contract, , , target, verification, , repair, handoff] = sections;
  assert.match(contract, /Working-tree implementation/);
  assert.match(contract, /PR delivery/);
  assert.match(contract, /local commit, push and PR creation authorization separately/);
  assert.match(target, /retain the edits without creating a commit/);
  assert.match(target, /once local commit\s+authorization is established/);
  assert.match(target, /clean tracked and non-ignored working tree/);
  assert.match(target, /Keep `BASE_COMMIT` at the original task baseline; never replace/);
  assert.match(verification, /For local candidate-commit evidence, require `source.head` to equal\s+`CANDIDATE_COMMIT`/);
  assert.match(verification, /CI evidence uses the explicit qualification above instead/);
  assert.match(target, /permission to publish pending work, not permission to claim verification, mark\s+ready or merge/);
  assert.match(repair, /new authorized follow-up commit/);
  assert.match(repair, /amend only if the user explicitly requests it/);
  assert.match(repair, /HEAD to remain `CANDIDATE_COMMIT` before publishing/);
  assert.match(handoff, /Missing\s+execution consent blocks CI-triggering publication/);
  assert.match(handoff, /unresolved final-review\s+requirements block ready delivery, not an otherwise authorized pending draft/);
  assert.match(handoff, /An unchanged push does not invalidate local source evidence/);
  assert.match(handoff, /Required remote CI and checks of a/);
});

function durable(ctx) {
  const journal = new Map();
  return { session: nativeSession(), phase() {}, log() {}, ...ctx, step: async (key, producer) => {
    assert.match(key, /^(?:devpocket-development-v8|devpocket-approval-v1:[a-f0-9]{64}|devpocket-task-scope-v1|devpocket-task-grant-v1:[a-f0-9]{64})$/,
      "Older journals must not be replayed as current execution-policy evidence.");
    if (!journal.has(key)) journal.set(key, JSON.parse(JSON.stringify(await producer())));
    return journal.get(key);
  } };
}

async function workspace(t, { separateGitDir = false } = {}) {
  await mkdir(".data/tests", { recursive: true });
  const home = await mkdtemp(path.resolve(".data/tests/development-"));
  const main = path.join(home, "main"), root = path.join(home, "task");
  await mkdir(main);
  await exec("git", ["init", "--quiet",
    ...(separateGitDir ? ["--separate-git-dir", path.join(home, "metadata")] : []), main]);
  await exec("git", ["config", "user.name", "Fixture"], { cwd: main });
  await exec("git", ["config", "user.email", "fixture@example.test"], { cwd: main });
  await writeFile(path.join(main, ".gitignore"), ".data/\n");
  await writeFile(path.join(main, "README.md"), "Before\n");
  await exec("git", ["add", "."], { cwd: main });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Fixture"], { cwd: main });
  await exec("git", ["worktree", "add", "--quiet", "-b", "task", root], { cwd: main });
  t.after(async () => {
    await exec("git", ["worktree", "remove", "--force", root], { cwd: main });
    await rm(home, { recursive: true, force: true });
  });
  return { root, main };
}

function fixtureFsmonitor(t, command) {
  const index = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  assert.ok(Number.isSafeInteger(index) && index >= 0 && index < 128);
  const key = `GIT_CONFIG_KEY_${index}`, value = `GIT_CONFIG_VALUE_${index}`;
  const original = new Map(["GIT_CONFIG_COUNT", key, value].map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, saved] of original) {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });
  // Enable only the fixture's declared monitor despite inherited command-scope settings.
  process.env[key] = "core.fsmonitor";
  process.env[value] = command;
  process.env.GIT_CONFIG_COUNT = String(index + 1);
}

async function registeredStarter(root, {
  names = ["create_session", "run_dynamic_workflow"],
  execute = async () => ({ resultType: "success", textResultForLlm: "Started" }),
} = {}) {
  const { registerDevelopmentExtension } = await import("../workflow-extension.mjs");
  let registration;
  const calls = [], activity = [];
  const session = { rpc: { tools: {
    getCurrentMetadata: async () => { activity.push("metadata"); return { tools: names.map((name) => ({ name })) }; },
    execute: async (request) => { activity.push("execute"); calls.push(request); return execute(request); },
  } } };
  await registerDevelopmentExtension({
    defineWorkflow: (value) => value,
    joinSession: async (value) => { registration = value; return session; },
  }, root);
  return { registration, calls, activity, session, start: registration.tools[0].handler };
}

test("skill delivery verifies a committed candidate against the original task base without weakening identity", async (t) => {
  const { verificationPlan, executeVerification, combineVerification } = await import("../verification.mjs");
  const { root } = await workspace(t);
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await writeFile(path.join(root, "README.md"), "Completed task documentation\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Candidate"], { cwd: root });
  const plan = await verificationPlan(root, base);
  assert.equal(plan.base, base);
  assert.notEqual(plan.source.head, base);
  assert.deepEqual(plan.changedFiles, ["README.md"]);
  assert.deepEqual((await verificationPlan(root, "HEAD")).changedFiles, [],
    "Replacing the task base with the candidate would hide the task's changes.");
  const report = await executeVerification(root, plan, { directory: path.join(root, ".data", "verification", "candidate") });
  assert.equal(report.status, "passed");
  assert.equal(report.complete, true);
  assert.equal(combineVerification(plan, [report]).status, "passed");

  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "--allow-empty", "-m", "Later commit"], { cwd: root });
  const changedHead = await verificationPlan(root, base);
  assert.equal(changedHead.source.fingerprint, plan.source.fingerprint);
  assert.notEqual(changedHead.source.head, plan.source.head);
  assert.throws(() => combineVerification(changedHead, [report]), /source|Source/);
});

test("candidate commits precede final verification/review, and unchanged publication needs only freshness", async (t) => {
  const { runDevelopment } = await import("../development-workflow.mjs");
  const { root } = await workspace(t);
  const calls = [];
  const order = [], verified = [];
  let reviews = 0, edits = 0, verificationCalls = 0;
  const ctx = durable({
    runId: "repair-proof",
    args: { goal: "Improve the documentation", acceptance: ["Explain the behavior"], nonGoals: [], maxRepairRounds: 2 },
    phase() {}, log() {},
    agent: async (_prompt, options) => {
      calls.push(options.agent);
      if (options.agent === "devpocket-reviewer") {
        reviews++;
        order.push("review");
        assert.equal((await inspectWorktree(root)).status, "");
        assert.equal((await sourceSnapshot(root)).head, verified.at(-1).head);
        assert.match(_prompt, new RegExp(verified.at(-1).head));
        return {
          verdict: reviews === 1 ? "changes_requested" : "pass",
          findings: reviews === 1 ? [{ severity: "blocking", file: "README.md", line: 1,
            impact: "The acceptance criterion is missing.", reproduction: "Read the first paragraph." }] : [],
        };
      }
      edits++;
      order.push("implement");
      await writeFile(path.join(root, "README.md"), `Explained behavior, revision ${edits}\n`);
      return implemented(root, "Updated the documentation.");
    },
  });
  const execute = ctx.session.rpc.tools.execute;
  ctx.session.rpc.tools.execute = async (request) => { order.push("commit"); return execute(request); };
  const verify = async (root, plan, options) => {
    verificationCalls++;
    order.push("verify");
    assert.equal((await inspectWorktree(root)).status, "");
    assert.notEqual(plan.source.head, plan.base);
    assert.deepEqual(await sourceSnapshot(root), plan.source);
    verified.push(plan.source);
    return executeVerification(root, plan, options);
  };
  const result = await runDevelopment(ctx, { root, verify });
  assert.equal(result.status, "ready");
  assert.deepEqual(order, ["implement", "commit", "verify", "review", "implement", "commit", "verify", "review"]);
  assert.deepEqual(calls, ["general-purpose", "devpocket-reviewer", "general-purpose", "devpocket-reviewer"]);
  assert.equal(result.round, 1);
  assert.equal(result.verification.complete, true);
  assert.deepEqual(result.review.source, result.verification.source);
  assert.deepEqual(result.source, result.candidate.source);
  assert.equal(result.candidate.commit, result.source.head);
  assert.equal(result.candidate.parent, verified[0].head);
  const body = await git(root, ["show", "-s", "--format=%B", result.candidate.commit]);
  assert.match(body, /Co-authored-by: Copilot App <223556219\+Copilot@users\.noreply\.github\.com>/);
  assert.match(body, /Copilot-Session: fixture-session/);
  const firstReportPath = path.join(root, ".data", "development", ctx.runId, "verification-0.json");
  const firstReport = await readFile(firstReportPath, "utf8");
  assert.equal(JSON.parse(firstReport).source.head, verified[0].head);
  const again = await runDevelopment(ctx, { root, verify });
  assert.equal(again.status, "blocked");
  assert.match(again.reason, /Cached ready proposals/);
  assert.equal(calls.length, 4, "Controller reentry must not execute a completed task twice.");
  const { checkRecordedReadiness } = await import("../workflow-extension.mjs");
  const session = { workflow: {
    getRunDetail: async () => ({ status: "completed", workflowName: "devpocket-development", runId: ctx.runId }),
    getRun: async () => ({ status: "completed", runId: ctx.runId, result }),
  } };
  assert.equal((await checkRecordedReadiness(session, root, { runId: ctx.runId })).status, "ready");
  // Recording an upstream after an authorized unchanged push is not a source edit.
  await git(root, ["config", "branch.task.remote", "origin"]);
  await git(root, ["config", "branch.task.merge", "refs/heads/task"]);
  assert.equal((await checkRecordedReadiness(session, root, { runId: ctx.runId })).status, "ready");
  assert.equal(verificationCalls, 2, "Publication freshness must not repeat final verification.");
  assert.equal(await readFile(firstReportPath, "utf8"), firstReport);
  await writeFile(path.join(root, "README.md"), "Changed after review\n");
  const stale = await checkRecordedReadiness(session, root, { runId: ctx.runId });
  assert.equal(stale.status, "blocked");
  assert.match(stale.reason, /source/i);
});

test("a primary checkout is refused before an implementation agent is started", async (t) => {
  const { runDevelopment } = await import("../development-workflow.mjs");
  const { main } = await workspace(t);
  let calls = 0;
  const result = await runDevelopment(durable({
    runId: "primary-refusal", args: { goal: "Task", acceptance: ["Behavior"], nonGoals: [] },
    phase() {}, log() {}, agent: async () => { calls++; },
  }), { root: main });
  assert.equal(result.status, "blocked");
  assert.equal(calls, 0);
  assert.match(result.reason, /worktree/);
});

test("a hand-written workspace result cannot substitute for a controller-journaled review", async (t) => {
  const { runDevelopment } = await import("../development-workflow.mjs");
  const { sourceSnapshot } = await import("../verification.mjs");
  const { root } = await workspace(t);
  const task = { goal: "Task", acceptance: ["Behavior"], nonGoals: [], maxRepairRounds: 2 };
  const directory = path.join(root, ".data", "development", "forged-result");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "state.json"), JSON.stringify({
    task, source: await sourceSnapshot(root), result: { status: "ready" },
  }));
  const result = await runDevelopment(durable({
    runId: "forged-result", args: task, phase() {}, log() {},
    agent: async () => { assert.fail("An interrupted operation must not be restarted automatically."); },
  }), { root });
  assert.equal(result.status, "blocked");
});

test("review blockers exhaust a bounded repair budget and are never relabelled as passed", async (t) => {
  const { runDevelopment } = await import("../development-workflow.mjs");
  const { root } = await workspace(t);
  let calls = 0;
  const result = await runDevelopment(durable({
    runId: "bounded", args: { goal: "Task", acceptance: ["Behavior"], maxRepairRounds: 0 },
    phase() {}, log() {},
    agent: async (_prompt, options) => {
      calls++;
      if (options.agent === "devpocket-reviewer") return {
        verdict: "changes_requested",
        findings: [{ severity: "blocking", file: "README.md", line: 1, impact: "Missing behavior", reproduction: "Read it" }],
      };
      await writeFile(path.join(root, "README.md"), "Incomplete\n");
      return implemented(root);
    },
  }), { root });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /exhausted/);
  assert.equal(calls, 2);
});

test("repair contracts have no implicit cap and retain explicit user limits beyond two rounds", () => {
  const input = { goal: "Task", acceptance: ["Behavior"] };
  assert.deepEqual(parseTask(input), { ...input, nonGoals: [] });
  assert.deepEqual(taskSchema.properties.maxRepairRounds, { type: "integer" });
  for (const maxRepairRounds of [0, 1, 2, 5, 20, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parseTask({ ...input, maxRepairRounds }).maxRepairRounds, maxRepairRounds);
  }
  for (const maxRepairRounds of [-1, 1.5, null, "5", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseTask({ ...input, maxRepairRounds }), /nonnegative safe integer/);
  }
  assert.throws(() => parseTask({ ...input, timeoutSeconds: 600 }), /Unexpected workflow fields/);
});

test("repair diagnosis requires concrete evidence and a next approach without granting acceptance", () => {
  for (const status of ["progressing", "stalled", "needs_human"]) {
    assert.deepEqual(parseRepairDiagnosis({
      status, evidence: " Observed failure evidence ", nextApproach: " Inspect the next cause ",
    }), { status, evidence: "Observed failure evidence", nextApproach: "Inspect the next cause" });
  }
  for (const value of [
    null, {}, { status: "pass", evidence: "Passed", nextApproach: "Publish" },
    { status: "progressing", evidence: "", nextApproach: "Retry" },
    { status: "progressing", evidence: " \n ", nextApproach: "Retry" },
    { status: "stalled", evidence: "Same failure", nextApproach: "" },
    { status: "progressing", evidence: "x".repeat(8001), nextApproach: "Retry" },
    { status: "progressing", evidence: "Observed", nextApproach: "x".repeat(4001) },
    { status: "progressing", evidence: "Observed", nextApproach: "Retry", approved: true },
  ]) assert.throws(() => parseRepairDiagnosis(value), TypeError);
});

test("failed checks keep repairing beyond two rounds while source-bound diagnosis shows progress", async (t) => {
  const { root } = await workspace(t);
  let implementations = 0, verifications = 0, reviews = 0, diagnoses = 0;
  const verified = [];
  const result = await runDevelopment(durable({
    runId: "progressing-checks", args: { goal: "Fix independent failures", acceptance: ["All checks pass"] },
    agent: async (prompt, options) => {
      if (options.label.includes(":diagnose:")) {
        diagnoses++;
        assert.equal(options.agent, "devpocket-reviewer");
        assert.match(prompt, /This is not a final acceptance review/);
        assert.ok(prompt.includes(verified.at(-1).head));
        const state = JSON.parse(await readFile(path.join(root, ".data", "development", "progressing-checks", "state.json"), "utf8"));
        for (const attempt of state.repairHistory) {
          assert.equal(typeof attempt.diff, "string");
          assert.ok(prompt.includes(JSON.stringify(attempt.diff)));
          const patch = await readFile(path.join(root, attempt.diff), "utf8");
          assert.ok(patch.includes(`+// fixture repair ${attempt.round + 1}`));
        }
        return { status: "progressing", evidence: `Fixture failure ${verifications - 1} was resolved; a different case now fails.`,
          nextApproach: "Inspect and fix the next independently reproduced case." };
      }
      if (options.agent === "devpocket-reviewer") { reviews++; return passingReview; }
      await mkdir(path.join(root, "backend", "tests"), { recursive: true });
      await writeFile(path.join(root, "backend", "tests", "task.test.ts"), `// fixture repair ${++implementations}\n`);
      return implemented(root);
    },
  }), { root, verify: async (_root, plan) => {
    verified.push(plan.source);
    if (++verifications < 5) return { ...plan, group: "all", status: "failed", complete: false,
      checks: plan.requiredChecks.map((id, index) => ({ id, status: index ? "not_run" : "failed",
        exitCode: index ? null : 1, reason: `Fixture case ${verifications} failed` })) };
    return syntheticReport(plan);
  } });
  assert.equal(result.status, "ready", result.reason);
  assert.equal(result.round, 4);
  assert.equal(implementations, 5);
  assert.equal(verifications, 5);
  assert.equal(reviews, 1);
  assert.equal(diagnoses, 3);
  assert.equal(result.repairHistory.length, 4);
  assert.deepEqual(result.review.source, verified.at(-1));
  assert.equal(new Set(verified.map((source) => source.head)).size, 5);
  for (let round = 1; round < 4; round++) {
    const diagnosis = JSON.parse(await readFile(path.join(root, ".data", "development",
      result.runId, `diagnosis-${round}.json`), "utf8"));
    assert.deepEqual(diagnosis.source, verified[round]);
    assert.equal(diagnosis.reviewer, "devpocket-reviewer");
  }
});

test("sustained or cyclic failures try diagnosis and a different approach before stopping", isolatedCases, async (t) => {
  await Promise.all(["checks", "review", "cycle"].map((scenario) => t.test(scenario, async (t) => {
    const { root } = await workspace(t);
    let implementations = 0, diagnoses = 0, verifications = 0;
    const heads = [];
    const result = await runDevelopment(durable({
      runId: `stalled-${scenario}`, args: { goal: "Fix a stubborn failure", acceptance: ["Reproduce and resolve it"] },
      agent: async (prompt, options) => {
        if (options.label.includes(":diagnose:")) {
          diagnoses++;
          assert.match(prompt, /earlier attempts|earlier|Earlier/);
          return { status: "stalled", evidence: "The same reproduced failure remains; source churn did not resolve or narrow it.",
            nextApproach: "Trace the state transition instead of changing another output assertion." };
        }
        if (options.agent === "devpocket-reviewer") return blockingReview;
        implementations++;
        if (implementations === 3) {
          assert.match(prompt, /Trace the state transition/);
          assert.match(prompt, /materially different supported approach/);
        }
        const revision = scenario === "cycle" ? implementations % 2 : implementations;
        await writeFile(path.join(root, "README.md"), `Incomplete fixture revision ${revision}\n`);
        return implemented(root);
      },
    }), { root, verify: async (_root, plan) => {
      verifications++;
      heads.push(plan.source.head);
      return scenario === "checks" ? { ...plan, group: "all", status: "failed", complete: false,
        checks: [{ id: "fixture-check", status: "failed", exitCode: 1 }] } : syntheticReport(plan);
    } });
    assert.equal(result.status, "blocked");
    assert.match(result.reason, /no demonstrated progress/);
    assert.equal(implementations, 3);
    assert.equal(verifications, 3);
    assert.equal(diagnoses, 2);
    assert.equal(result.round, 2);
    assert.equal(result.repairHistory.length, 3);
    assert.deepEqual(result.repairDiagnosis.source, result.source);
    assert.equal(result.repairDiagnosis.status, "stalled");
    assert.equal(new Set(heads).size, 3, "Different commits alone cannot count as progress.");
    if (scenario === "cycle") {
      assert.equal(result.repairHistory[0].source.fingerprint, result.repairHistory[2].source.fingerprint);
    }
  })));
});

test("demonstrated progress clears a stalled diagnosis rather than imposing a lifetime stall quota", async (t) => {
  const { root } = await workspace(t);
  const statuses = ["stalled", "progressing", "stalled"];
  let implementations = 0, reviews = 0, diagnoses = 0;
  const result = await runDevelopment(durable({
    runId: "progress-reset", args: { goal: "Resolve failures", acceptance: ["Complete the task"] },
    agent: async (_prompt, options) => {
      if (options.label.includes(":diagnose:")) return { status: statuses[diagnoses++],
        evidence: "The fixture records the observed change in failure evidence.", nextApproach: "Inspect the next causal path." };
      if (options.agent === "devpocket-reviewer") return ++reviews < 5 ? blockingReview : passingReview;
      await writeFile(path.join(root, "README.md"), `Fixture revision ${++implementations}\n`);
      return implemented(root);
    },
  }), { root, verify: async (_root, plan) => syntheticReport(plan) });
  assert.equal(result.status, "ready", result.reason);
  assert.equal(result.round, 4);
  assert.equal(diagnoses, 3);
});

test("an explicit larger repair cap stops before spending another diagnosis or asking for approval", async (t) => {
  const { root } = await workspace(t);
  let implementations = 0, diagnoses = 0;
  const result = await runDevelopment(durable({
    runId: "explicit-cap", args: { goal: "Task", acceptance: ["Behavior"], maxRepairRounds: 3 },
    agent: async (_prompt, options) => {
      if (options.label.includes(":diagnose:")) {
        diagnoses++;
        return { status: "progressing", evidence: "A fixture blocker was resolved.", nextApproach: "Address the next fixture blocker." };
      }
      if (options.agent === "devpocket-reviewer") return blockingReview;
      await writeFile(path.join(root, "README.md"), `Fixture revision ${++implementations}\n`);
      return implemented(root);
    },
  }), { root, verify: async (_root, plan) => syntheticReport(plan) });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /user-selected repair limit is exhausted/);
  assert.equal(result.round, 3);
  assert.equal(implementations, 4);
  assert.equal(diagnoses, 2);
  assert.deepEqual(result.authorization.receipts, []);
});

test("repair diagnosis cannot weaken malformed-result, source, hook or human-decision stops", isolatedCases, async (t) => {
  await Promise.all(["invalid", "source", "hooks", "human"].map((scenario) => t.test(scenario, async (t) => {
    const { root } = await workspace(t);
    let implementations = 0, diagnoses = 0;
    const result = await runDevelopment(durable({
      runId: `diagnosis-${scenario}`, args: { goal: "Task", acceptance: ["Behavior"] },
      agent: async (_prompt, options) => {
        if (options.label.includes(":diagnose:")) {
          diagnoses++;
          if (scenario === "invalid") return { status: "progressing", evidence: "", nextApproach: "Retry" };
          if (scenario === "source") await writeFile(path.join(root, "README.md"), "Unexpected diagnosis edit\n");
          if (scenario === "hooks") await git(root, ["config", "core.hooksPath", ".data/changed-hooks"]);
          return { status: scenario === "human" ? "needs_human" : "progressing",
            evidence: scenario === "human" ? "The product behavior needs a user choice." : "Observed fixture evidence.",
            nextApproach: "Resolve only the specific remaining decision." };
        }
        if (options.agent === "devpocket-reviewer") return blockingReview;
        await writeFile(path.join(root, "README.md"), `Fixture revision ${++implementations}\n`);
        return implemented(root);
      },
    }), { root, verify: async (_root, plan) => syntheticReport(plan) });
    assert.equal(result.status, ["hooks", "human"].includes(scenario) ? "needs_human" : "blocked");
    assert.equal(implementations, 2);
    assert.equal(diagnoses, 1);
    if (scenario === "invalid") assert.match(result.reason, /diagnosis.*invalid/);
    if (scenario === "source") assert.match(result.reason, /Source changed during/);
    if (scenario === "hooks") assert.match(result.reason, /hook policy changed/);
    if (scenario === "human") assert.match(result.reason, /product behavior/);
  })));
});

test("native cancellation and budget errors during diagnosis propagate without a repair retry", isolatedCases, async (t) => {
  await Promise.all(["cancelled", "budget"].map((scenario) => t.test(scenario, async (t) => {
    const { root } = await workspace(t), controller = new AbortController();
    const error = Object.assign(new Error(`Native ${scenario}`), { name: scenario === "budget" ? "ResponseError" : "AbortError" });
    let implementations = 0, diagnoses = 0;
    const ctx = durable({
      runId: `native-${scenario}`, args: { goal: "Task", acceptance: ["Behavior"] }, signal: controller.signal,
      agent: async (_prompt, options) => {
        if (options.label.includes(":diagnose:")) {
          diagnoses++;
          if (scenario === "budget") throw error;
          controller.abort(error);
          return { status: "progressing", evidence: "This result must not override cancellation.", nextApproach: "Retry" };
        }
        if (options.agent === "devpocket-reviewer") return blockingReview;
        await writeFile(path.join(root, "README.md"), `Fixture revision ${++implementations}\n`);
        return implemented(root);
      },
    });
    await assert.rejects(runDevelopment(ctx, { root, verify: async (_root, plan) => syntheticReport(plan) }),
      (actual) => actual === error);
    assert.equal(implementations, 2);
    assert.equal(diagnoses, 1);
    const directory = path.join(root, ".data", "development", ctx.runId);
    const state = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
    assert.equal(state.stage, "diagnosing");
    assert.equal(state.repairHistory.length, 2);
    await assert.rejects(readFile(path.join(directory, "handoff.json")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(root, ".data", "development.lock")), { code: "ENOENT" });
  })));
});

test("a pre-cancelled workflow never starts its journal or inspects a workspace", async () => {
  const controller = new AbortController(), error = new Error("Already cancelled");
  controller.abort(error);
  await assert.rejects(runDevelopment({
    signal: controller.signal,
    args: { goal: "Task", acceptance: ["Behavior"] },
    step: async () => { assert.fail("Cancellation precedes journal entry."); },
  }, { root: "an-unavailable-worktree" }), (actual) => actual === error);
});

test("cancellation after implementation preserves edits without starting a candidate commit", async (t) => {
  const { root } = await workspace(t), controller = new AbortController(), session = nativeSession();
  const error = new Error("Cancelled during implementation");
  const before = await sourceSnapshot(root);
  session.rpc.tools.execute = async () => { assert.fail("Cancelled implementation must not commit."); };
  await assert.rejects(runDevelopment(durable({
    runId: "cancelled-implementation", session, signal: controller.signal,
    args: { goal: "Task", acceptance: ["Behavior"] },
    agent: async () => {
      await writeFile(path.join(root, "README.md"), "Retained incomplete task\n");
      const result = await implemented(root);
      controller.abort(error);
      return result;
    },
  }), { root, verify: async () => { assert.fail("Cancelled implementation must not verify."); } }),
  (actual) => actual === error);
  assert.equal((await sourceSnapshot(root)).head, before.head);
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "Retained incomplete task\n");
});

test("cancellation after native phase results cannot become blocked verification or a ready handoff", isolatedCases, async (t) => {
  await Promise.all(["candidate", "verification", "review", "policy"].map((phase) => t.test(phase, async (t) => {
    const { root } = await workspace(t), controller = new AbortController(), session = nativeSession();
    const error = new Error(`Cancelled during ${phase}`);
    const before = await sourceSnapshot(root);
    let implementations = 0, commits = 0, verifications = 0, reviews = 0;
    const execute = session.rpc.tools.execute;
    session.rpc.tools.execute = async (request) => {
      const response = await execute(request);
      assert.equal(response.resultType, "success", response.textResultForLlm);
      commits++;
      if (phase === "candidate") controller.abort(error);
      return response;
    };
    session.capabilities = { ui: { elicitation: true } };
    session.ui = { elicitation: async () => {
      assert.equal(phase, "policy");
      controller.abort(error);
      return { action: "accept", content: { decision: "approve" } };
    } };
    const ctx = durable({
      runId: `cancelled-${phase}`, session, signal: controller.signal,
      args: { goal: "Task", acceptance: ["Behavior"] },
      agent: async (_prompt, options) => {
        if (options.agent === "devpocket-reviewer") {
          reviews++;
          if (phase === "review") controller.abort(error);
          return passingReview;
        }
        implementations++;
        const file = phase === "policy" ? "scripts/verify.mjs" : "README.md";
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), "// fixture task change\n");
        return implemented(root);
      },
    });
    await assert.rejects(runDevelopment(ctx, { root, verify: async (_root, plan) => {
      verifications++;
      if (phase === "verification") {
        controller.abort(error);
        return { ...plan, group: "all", status: "blocked", complete: false,
          checks: [{ id: "fixture-check", status: "blocked", commandOutcome: { reason: "cancelled" } }] };
      }
      return syntheticReport(plan);
    } }), (actual) => actual === error);
    assert.equal(implementations, 1);
    assert.equal(commits, phase === "policy" ? 0 : 1, "Pre-execution cancellation cannot commit; already completed commits are retained.");
    if (phase === "policy") assert.equal((await sourceSnapshot(root)).head, before.head);
    else assert.notEqual((await sourceSnapshot(root)).head, before.head);
    assert.equal(verifications, ["candidate", "policy"].includes(phase) ? 0 : 1);
    assert.equal(reviews, phase === "review" ? 1 : 0);
    await assert.rejects(readFile(path.join(root, ".data", "development", ctx.runId, "handoff.json")), { code: "ENOENT" });
  })));
});

test("cancellation during final persistence invalidates ready recovery files", async (t) => {
  for (const phase of ["state", "handoff", "handoff-interrupted", "handoff-cleanup-failure"]) await t.test(phase, async (t) => {
    const { root } = await workspace(t), controller = new AbortController(), session = nativeSession();
    const error = new Error(`Cancelled while persisting ${phase}`);
    const cleanupError = new Error("Fixture cancellation checkpoint failed");
    const runId = `cancel-final-${phase}`;
    const directory = path.join(root, ".data", "development", runId);
    const statePath = path.join(directory, "state.json"), handoffPath = path.join(directory, "handoff.json");
    const original = { rename: fs.rename, writeFile: fs.writeFile, open: fs.open };
    let triggered = false;
    const afterWrite = (file, text) => {
      if (!triggered && phase.startsWith("handoff") && file === handoffPath && JSON.parse(text).status === "ready") {
        triggered = true;
        controller.abort(error);
        if (phase === "handoff-interrupted") throw error;
      }
    };
    session.rpc.tools.execute = async () => { assert.fail("The no-op fixture needs no candidate mutation."); };
    t.mock.method(fs, "rename", async (...args) => {
      if (phase === "handoff-cleanup-failure" && args[1] === statePath &&
          JSON.parse(await readFile(args[0], "utf8")).stage === "cancelled") throw cleanupError;
      const result = await original.rename(...args);
      if (!triggered && phase === "state" && args[1] === statePath &&
          JSON.parse(await readFile(statePath, "utf8")).stage === "ready") {
        triggered = true;
        controller.abort(error);
      }
      return result;
    });
    t.mock.method(fs, "writeFile", async (...args) => {
      const result = await original.writeFile(...args);
      afterWrite(args[0], args[1]);
      return result;
    });
    t.mock.method(fs, "open", async (...args) => {
      const handle = await original.open(...args);
      if (args[0] === handoffPath && args[1] === "wx") {
        const write = handle.writeFile.bind(handle);
        t.mock.method(handle, "writeFile", async (...values) => {
          const result = await write(...values);
          afterWrite(handoffPath, values[0]);
          return result;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(runDevelopment(durable({
        runId, session, signal: controller.signal,
        args: { goal: "Keep completed evidence on cancellation", acceptance: ["Never persist a cancelled task as ready"] },
        agent: async (_prompt, options) => options.agent === "devpocket-reviewer" ? passingReview : implemented(root),
      }), { root, verify: async (_root, plan) => syntheticReport(plan) }), (actual) => {
        if (phase !== "handoff-cleanup-failure") return actual === error;
        return actual instanceof AggregateError && actual.errors.includes(error) && actual.errors.includes(cleanupError) &&
          /recovery artifact invalidation failed/.test(actual.message);
      });
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(triggered, true, "Cancel after the actual ready-state write, not before finalization.");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (phase !== "handoff-cleanup-failure") {
      assert.equal(state.stage, "cancelled");
      assert.equal(state.result.status, "cancelled");
      assert.equal((await checkDevelopmentReadiness(root, state.result)).status, "blocked");
    }
    assert.equal(state.result.verification.status, "passed");
    assert.equal(state.result.review.verdict, "pass");
    assert.equal(state.result.candidate.commit, state.candidate.commit);
    assert.equal((await sourceSnapshot(root)).head, state.candidate.commit);
    assert.equal(JSON.parse(await readFile(path.join(directory, "verification-0.json"), "utf8")).status, "passed");
    await assert.rejects(readFile(handoffPath), { code: "ENOENT" });
  });
});

test("late cancellation invalidates completion and prevents ready journal replay", async (t) => {
  for (const phase of ["lock-cleanup", "journal", "readiness"]) await t.test(phase, async (t) => {
    const { root } = await workspace(t), controller = new AbortController(), session = nativeSession();
    const error = new Error(`Cancelled during ${phase}`);
    const runId = `late-cancel-${phase}`, directory = path.join(root, ".data", "development", runId);
    const originalSource = await sourceSnapshot(root), original = { rm: fs.rm, readFile: fs.readFile };
    let triggered = false, journalReturned = false, implementations = 0, reviews = 0, proposal;
    const cancel = () => { triggered = true; controller.abort(error); };
    session.rpc.tools.execute = async () => { assert.fail("The no-op fixture needs no native mutation."); };
    const ctx = durable({
      runId, session, signal: controller.signal,
      args: { goal: "Preserve cancellation across completion", acceptance: ["No ready replay after cancellation"] },
      agent: async (_prompt, options) => {
        if (options.agent === "devpocket-reviewer") { reviews++; return passingReview; }
        implementations++;
        return implemented(root);
      },
    });
    const step = ctx.step;
    ctx.step = async (key, producer) => {
      const result = await step(key, producer);
      if (key.startsWith("devpocket-development-v")) {
        journalReturned = true;
        if (result.result.status === "ready") proposal = result.result;
        if (!triggered && phase === "journal") cancel();
      }
      return result;
    };
    t.mock.method(fs, "rm", async (...args) => {
      const result = await original.rm(...args);
      if (!triggered && phase === "lock-cleanup" && args[0] === path.join(root, ".data", "development.lock")) cancel();
      return result;
    });
    t.mock.method(fs, "readFile", async (...args) => {
      const result = await original.readFile(...args);
      if (!triggered && phase === "readiness" && journalReturned) cancel();
      return result;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(runDevelopment(ctx, { root, verify: async (_root, plan) => syntheticReport(plan) }),
        (actual) => actual === error);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(triggered, true, "Exercise cancellation after finish, not an earlier phase result.");
    const state = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
    assert.equal(state.stage, "cancelled");
    assert.equal(state.result.status, "cancelled");
    await assert.rejects(readFile(path.join(directory, "handoff.json")), { code: "ENOENT" });
    if (proposal) {
      await writeFile(path.join(directory, "state.json"), JSON.stringify({ ...state, stage: "ready", result: proposal }));
      await writeFile(path.join(directory, "handoff.json"), JSON.stringify(proposal));
    }
    const replay = await runDevelopment({ ...ctx, signal: new AbortController().signal },
      { root, verify: async () => { assert.fail("Replay requires inspected recovery, not new verification."); } });
    assert.notEqual(replay.status, "ready", "A fresh signal must not promote a cancelled attempt's cached ready result.");
    assert.match(replay.reason, /inspect|recover/i);
    assert.equal(state.result.candidate.commit, originalSource.head);
    assert.equal(state.result.verification.status, "passed");
    assert.equal(state.result.review.verdict, "pass");
    assert.equal(implementations, 1);
    assert.equal(reviews, 1);
    assert.deepEqual(await sourceSnapshot(root), originalSource);
    assert.equal(JSON.parse(await readFile(path.join(directory, "verification-0.json"), "utf8")).status, "passed");
  });
});

test("completion cleanup preserves cancellation and every cleanup failure", async (t) => {
  const count = (actual, expected) => actual === expected ? 1 :
    actual instanceof AggregateError ? actual.errors.reduce((total, error) => total + count(error, expected), 0) : 0;
  for (const phase of ["lock-close", "lock-remove", "invalidation-and-remove", "handoff-close",
    "late-lock-close", "late-lock-remove", "late-invalidation-and-remove"]) await t.test(phase, async (t) => {
    const { root } = await workspace(t), controller = new AbortController(), session = nativeSession();
    const late = phase.startsWith("late-"), invalidationFails = phase.endsWith("invalidation-and-remove");
    const cancellation = new Error("Fixture cancellation"), cleanupFailure = new Error(`Fixture ${phase} failed`);
    const invalidationFailure = new Error("Fixture cancellation checkpoint failed");
    const runId = `cleanup-errors-${phase}`, directory = path.join(root, ".data", "development", runId);
    const lockPath = path.join(root, ".data", "development.lock");
    const handoffPath = path.join(directory, "handoff.json"), statePath = path.join(directory, "state.json");
    const original = { open: fs.open, rm: fs.rm, rename: fs.rename };
    let invalidations = 0, lockRemovals = 0, handoffRemovals = 0;
    session.rpc.tools.execute = async () => { assert.fail("The no-op fixture needs no native mutation."); };
    t.mock.method(fs, "open", async (...args) => {
      const handle = await original.open(...args);
      if (args[0] === handoffPath) {
        const write = handle.writeFile.bind(handle);
        t.mock.method(handle, "writeFile", async (...values) => {
          const result = await write(...values);
          if (!late) controller.abort(cancellation);
          if (phase === "handoff-close") throw cancellation;
          return result;
        });
      }
      if (args[0] === lockPath && phase.endsWith("lock-close") || args[0] === handoffPath && phase === "handoff-close") {
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => {
          await close();
          if (late) controller.abort(cancellation);
          throw cleanupFailure;
        });
      }
      return handle;
    });
    t.mock.method(fs, "rename", async (...args) => {
      if (args[1] === statePath && JSON.parse(await readFile(args[0], "utf8")).stage === "cancelled") {
        invalidations++;
        if (invalidationFails) throw invalidationFailure;
      }
      return original.rename(...args);
    });
    t.mock.method(fs, "rm", async (...args) => {
      const result = await original.rm(...args);
      if (args[0] === handoffPath) handoffRemovals++;
      if (args[0] === lockPath) {
        lockRemovals++;
        if (phase.endsWith("lock-remove") || invalidationFails) {
          if (late) controller.abort(cancellation);
          throw cleanupFailure;
        }
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(runDevelopment(durable({
        runId, session, signal: controller.signal,
        args: { goal: "Preserve failure provenance", acceptance: ["Keep cancellation and cleanup errors"] },
        agent: async (_prompt, options) => options.agent === "devpocket-reviewer" ? passingReview : implemented(root),
      }), { root, verify: async (_root, plan) => syntheticReport(plan) }), (error) =>
        count(error, cancellation) === 1 && count(error, cleanupFailure) === 1 &&
        (!invalidationFails || count(error, invalidationFailure) === 1));
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(invalidations, 1, "The outer handler must not repeat a completed or failed invalidation.");
    assert.equal(lockRemovals, 1, "Removing the owned lock must still be attempted after a close failure.");
    assert.equal(handoffRemovals, 1);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (!invalidationFails) assert.equal(state.stage, "cancelled");
    assert.equal((await sourceSnapshot(root)).head, state.candidate.commit);
    assert.equal(JSON.parse(await readFile(path.join(directory, "verification-0.json"), "utf8")).status, "passed");
    await assert.rejects(readFile(handoffPath), { code: "ENOENT" });
    await assert.rejects(readFile(lockPath), { code: "ENOENT" });
  });
});

test("completed runs use native read-only readiness instead of reentering the controller", async (t) => {
  const { root } = await workspace(t), session = nativeSession();
  let implementations = 0, verifications = 0, reviews = 0;
  session.rpc.tools.execute = async () => { assert.fail("The no-op fixture needs no native mutation."); };
  const ctx = durable({
    runId: "completed-readiness", session, args: { goal: "Read completed evidence", acceptance: ["No repeated work"] },
    agent: async (_prompt, options) => {
      if (options.agent === "devpocket-reviewer") { reviews++; return passingReview; }
      implementations++;
      return implemented(root);
    },
  });
  const verify = async (_root, plan) => { verifications++; return syntheticReport(plan); };
  const result = await runDevelopment(ctx, { root, verify });
  assert.equal(result.status, "ready");
  const replay = await runDevelopment(ctx, { root, verify });
  assert.equal(replay.status, "blocked", "Reentry cannot tell native completion from an interrupted journal write.");
  const { checkRecordedReadiness } = await import("../workflow-extension.mjs");
  let status = "completed";
  const runtime = { workflow: {
    getRunDetail: async () => ({ status, workflowName: "devpocket-development", runId: ctx.runId }),
    getRun: async () => ({ status, runId: ctx.runId, result }),
  } };
  assert.equal((await checkRecordedReadiness(runtime, root, { runId: ctx.runId })).status, "ready");
  status = "cancelled";
  assert.equal((await checkRecordedReadiness(runtime, root, { runId: ctx.runId })).status, "blocked");
  assert.equal(implementations, 1);
  assert.equal(verifications, 1);
  assert.equal(reviews, 1);
});

test("cancellation aggregation preserves existing causes and handles cycles", async (t) => {
  for (const scenario of ["cause", "cycle", "cycle-with-cancellation", "primitive"]) await t.test(scenario, async (t) => {
    const { root } = await workspace(t), controller = new AbortController(), session = nativeSession();
    const cancellation = scenario === "primitive" ? "Fixture cancellation" : new Error("Fixture cancellation");
    const failure = scenario.startsWith("cycle") ? new AggregateError([], "Fixture cyclic errors") :
      scenario === "cause" ? new Error("Fixture wrapper", { cause: cancellation }) : new Error("Fixture failure");
    if (scenario.startsWith("cycle")) failure.errors.push(failure);
    if (scenario === "cycle-with-cancellation") failure.errors.unshift(cancellation);
    session.rpc.tools.execute = async () => { assert.fail("Cancelled implementation must not commit."); };
    await assert.rejects(runDevelopment(durable({
      runId: `error-causes-${scenario}`, session, signal: controller.signal,
      args: { goal: "Preserve cancellation provenance", acceptance: ["No lost or duplicate cancellation"] },
      agent: async () => { controller.abort(cancellation); throw failure; },
    }), { root }), (error) => {
      if (["cause", "cycle-with-cancellation"].includes(scenario)) return error === failure;
      return error instanceof AggregateError && error.errors.length === 2 &&
        error.errors[0] === cancellation && error.errors[1] === failure;
    });
  });
});

test("failed verification exposes a readable candidate diff before diagnosis or acceptance review", async (t) => {
  const { root } = await workspace(t), session = nativeSession();
  const runId = "failed-candidate-diff";
  const expectedPatch = path.join(root, ".data", "development", runId, "review-0.patch");
  let patchDuringVerification;
  session.rpc.tools.execute = async () => { assert.fail("The no-op baseline needs no candidate mutation."); };
  const result = await runDevelopment(durable({
    runId, session, args: { goal: "Inspect failed candidates", acceptance: ["Retain readable source evidence"], maxRepairRounds: 0 },
    agent: async (_prompt, options) => {
      assert.equal(options.agent, "general-purpose", "Failed verification must not run an acceptance review.");
      return implemented(root);
    },
  }), { root, verify: async (_root, plan) => {
    try { patchDuringVerification = await readFile(expectedPatch, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return { ...plan, group: "all", status: "failed", complete: false, checks: [] };
  } });
  assert.equal(result.status, "blocked");
  assert.equal(typeof patchDuringVerification, "string", "Persist the diff before invoking verification.");
  assert.equal(result.repairHistory.length, 1);
  assert.equal(path.resolve(root, result.repairHistory[0].diff), expectedPatch);
  assert.equal(await readFile(expectedPatch, "utf8"), patchDuringVerification);
  assert.equal(patchDuringVerification, "", "An unchanged baseline has an empty, but still inspectable, diff.");
});

test("report-level admission blocks stop before dispatching a code repair", async (t) => {
  const { root } = await workspace(t), calls = [], reports = [];
  const profile = path.join(root, ".data", "fixture-profile");
  const admission = path.join(profile, ...(process.platform === "win32" ? [] : [".cache"]),
    "DevPocket", "verification", "admission");
  await mkdir(admission, { recursive: true, mode: 0o700 });
  const owner = path.join(admission, "owner.json"), retained = '{"fixture":"unconfirmed owner"}\n';
  await writeFile(owner, retained, { flag: "wx", mode: 0o600 });
  const env = { ...process.env, [process.platform === "win32" ? "LOCALAPPDATA" : "HOME"]: profile };
  delete env.DEVPOCKET_VERIFIER_ADMISSION;
  const runId = "blocked-admission";
  const result = await runDevelopment(durable({
    runId, args: { goal: "Preserve admission failures", acceptance: ["Do not dispatch code repair"], maxRepairRounds: 1 },
    agent: async (_prompt, options) => {
      calls.push(options.agent);
      assert.equal(options.agent, "general-purpose");
      if (calls.length === 1) {
        const directory = path.join(root, "scripts", "tests");
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "admission.test.mjs"), "// Admission must block before checks run.\n");
      }
      return implemented(root);
    },
  }), { root, verify: async (_root, plan, options) => {
    const file = path.join(root, ".data", "verification", runId, path.basename(options.directory), "report.json");
    await assert.rejects(exec(process.execPath, [path.resolve("scripts/verify.mjs"), "--repo", root,
      "--base", plan.base, "--report", file], { cwd: root, env, timeout: 30000 }),
    (error) => error.code === 1 && /Verification blocked:/.test(error.stdout));
    const report = JSON.parse(await readFile(file, "utf8"));
    assert.equal(report.status, "blocked");
    assert.equal(report.failure.reason, "admission-unconfirmed");
    assert.ok(report.checks.length > 0);
    assert.ok(report.checks.every((check) => check.status === "not_run"));
    reports.push(report);
    return report;
  } });
  assert.deepEqual(calls, ["general-purpose"], "An admission failure must not dispatch another implementation or review.");
  assert.equal(result.status, "blocked");
  assert.equal(result.round, 0);
  assert.equal(reports.length, 1);
  assert.deepEqual(result.verification, reports[0]);
  assert.deepEqual(result.repairHistory, []);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, ".data", "development", runId, "verification-0.json"), "utf8")),
    reports[0]);
  assert.equal(await readFile(owner, "utf8"), retained);
});

test("starter reuses a clean linked worktree through exactly one native workflow dispatch", async (t) => {
  const { root } = await workspace(t);
  const task = {
    goal: "Keep the current task session",
    acceptance: ["复用当前干净 worktree", "Retain native run approval"],
    nonGoals: ["Do not create a child session"],
    maxRepairRounds: 1,
  };
  const result = { resultType: "success", textResultForLlm: "Workflow run: fixture-run" };
  const starter = await registeredStarter(root, { execute: async () => result });
  assert.deepEqual(starter.activity, [], "Registration must not inspect or dispatch through the SDK.");
  assert.strictEqual(await starter.start(task), result);
  assert.equal(starter.calls.filter((call) => call.name === "create_session").length, 0);
  assert.deepEqual(starter.calls, [{
    name: "run_dynamic_workflow", arguments: { name: "devpocket-development", args: task },
  }]);
});

test("starter blocks dirty checkouts without dropping unresolved task dependencies", isolatedCases, async (t) => {
  const cases = [];
  for (const checkout of ["primary", "linked"]) {
    for (const change of ["staged", "unstaged", "untracked"]) {
      cases.push(t.test(`${checkout}: ${change}`, async (t) => {
        const { main, root: linked } = await workspace(t);
        const root = checkout === "primary" ? main : linked;
        const starter = await registeredStarter(root);
        const file = change === "untracked" ? path.join("pending", "new.md") : "README.md";
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), "Unfinished task dependency\n");
        if (change === "staged") await exec("git", ["add", file], { cwd: root });
        if (change === "untracked") await exec("git", ["config", "--local", "status.showUntrackedFiles", "no"], { cwd: root });
        const status = () => exec("git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"], { cwd: root });
        const before = (await status()).stdout;
        const result = await starter.start({ goal: "Task", acceptance: ["Behavior"] });
        assert.deepEqual(starter.calls, [], "Dirty work must not silently move to a new base.");
        assert.equal(result.resultType, "failure");
        assert.match(result.textResultForLlm, /dirty|clean|uncommitted/i);
        assert.match(result.textResultForLlm, /depend/i);
        assert.equal((await status()).stdout, before);
        assert.equal(await readFile(path.join(root, file), "utf8"), "Unfinished task dependency\n");
      }));
    }
  }
  await Promise.all(cases);
});

test("starter allows ignored artifacts and inspects Git without refreshing the index", async (t) => {
  const { root } = await workspace(t);
  await mkdir(path.join(root, ".data"));
  await writeFile(path.join(root, ".data", "artifact.txt"), "Ignored local artifact\n");
  const readme = path.join(root, "README.md");
  await writeFile(readme, await readFile(readme));
  assert.equal((await exec("git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"], { cwd: root })).stdout, "");
  const index = path.resolve(root, (await exec("git", ["rev-parse", "--git-path", "index"], { cwd: root })).stdout.trim());
  const before = await readFile(index);
  const starter = await registeredStarter(root, { names: ["run_dynamic_workflow"] });
  const result = await starter.start({ goal: "Task", acceptance: ["Behavior"] });
  assert.equal(result.resultType, "success", result.textResultForLlm);
  assert.deepEqual(starter.calls, [{
    name: "run_dynamic_workflow",
    arguments: { name: "devpocket-development", args: { goal: "Task", acceptance: ["Behavior"], nonGoals: [] } },
  }]);
  assert.deepEqual(await readFile(index), before);
  assert.equal(await readFile(path.join(root, ".data", "artifact.txt"), "utf8"), "Ignored local artifact\n");
});

test("starter uses actual Git identities for separate metadata and directory aliases", async (t) => {
  const { root, main } = await workspace(t, { separateGitDir: true });
  assert.match(await readFile(path.join(main, ".git"), "utf8"), /^gitdir: /);
  const primary = await registeredStarter(main);
  await primary.start({ goal: "Task", acceptance: ["Behavior"] });
  assert.deepEqual(primary.calls.map((call) => call.name), ["create_session"]);
  const alias = path.join(main, ".data", "linked-alias");
  await mkdir(path.dirname(alias));
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  const linked = await registeredStarter(alias);
  const result = await linked.start({ goal: "Task", acceptance: ["Behavior"] });
  assert.equal(result.resultType, "success", result.textResultForLlm);
  assert.deepEqual(linked.calls.map((call) => call.name), ["run_dynamic_workflow"]);
  const completed = await runDevelopment(documentationTask(alias), { root: alias });
  assert.equal(completed.status, "ready", completed.reason);
  assert.equal((await checkDevelopmentReadiness(alias, completed)).status, "ready");
  const physical = await inspectWorktree(root), aliased = await inspectWorktree(alias);
  assert.deepEqual(aliased.source, physical.source);
  assert.equal(aliased.identity.gitDirectory, physical.identity.gitDirectory);
  assert.equal(aliased.identity.commonDirectory, physical.identity.commonDirectory);
  assert.equal(aliased.identity.root, path.resolve(alias), "Keep the caller's workspace path in the ownership contract.");
  const nestedAlias = path.join(main, ".data", "nested-alias");
  await symlink(path.join(root, ".data"), nestedAlias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(inspectWorktree(nestedAlias), /root of an isolated linked worktree/);
  await assert.rejects(inspectWorktree(main), /not the primary checkout/);
});

test("starter discovers qualified native tool names for reuse and primary isolation", async (t) => {
  const { root, main } = await workspace(t);
  for (const names of [
    ["functions.create_session", "functions.run_dynamic_workflow"],
    ["functions.create_session", "run_dynamic_workflow"],
    ["create_session", "functions.run_dynamic_workflow"],
  ]) {
    for (const [directory, expectedName] of [[root, names[1]], [main, names[0]]]) {
      await t.test(`${names.join(", ")}: ${expectedName}`, async () => {
        const starter = await registeredStarter(directory, { names });
        await starter.start({ goal: "Task", acceptance: ["Behavior"] });
        assert.equal(starter.calls.length, 1);
        assert.equal(starter.calls[0].name, expectedName);
      });
    }
  }
});

test("starter never creates a child when the current workflow tool is unavailable", async (t) => {
  const { root } = await workspace(t);
  for (const tools of [null, [], [{ name: "create_session" }], [{ name: "functions.create_session" }]]) {
    await t.test(JSON.stringify(tools), async () => {
      const starter = await registeredStarter(root);
      starter.session.rpc.tools.getCurrentMetadata = async () => ({ tools });
      const result = await starter.start({ goal: "Task", acceptance: ["Behavior"] });
      assert.equal(result.resultType, "failure");
      assert.match(result.textResultForLlm, /run_dynamic_workflow.*unavailable/);
      assert.deepEqual(starter.calls, []);
    });
  }
});

test("starter preserves failed, rejected and uncertain workflow results without a second dispatch", async (t) => {
  const { root } = await workspace(t);
  for (const resultType of ["failure", "rejected", "denied"]) {
    await t.test(resultType, async () => {
      const result = { resultType, textResultForLlm: `Native workflow outcome: ${resultType}` };
      const starter = await registeredStarter(root, { execute: async () => result });
      assert.strictEqual(await starter.start({ goal: "Task", acceptance: ["Behavior"] }), result);
      assert.equal(starter.calls.length, 1);
      assert.equal(starter.calls[0].name, "run_dynamic_workflow");
    });
  }
  await t.test("uncertain native dispatch", async () => {
    const error = new Error("Connection lost after dispatch; the run outcome is unknown.");
    const starter = await registeredStarter(root, { execute: async () => { throw error; } });
    await assert.rejects(starter.start({ goal: "Task", acceptance: ["Behavior"] }), (actual) => actual === error);
    assert.equal(starter.calls.length, 1);
    assert.equal(starter.calls[0].name, "run_dynamic_workflow");
  });
  await t.test("tool discovery failed", async () => {
    const error = new Error("Native tool discovery failed.");
    const starter = await registeredStarter(root);
    starter.session.rpc.tools.getCurrentMetadata = async () => { throw error; };
    await assert.rejects(starter.start({ goal: "Task", acceptance: ["Behavior"] }), (actual) => actual === error);
    assert.deepEqual(starter.calls, []);
  });
});

test("starter blocks a clean primary checkout when native session creation is unavailable", async (t) => {
  const { main } = await workspace(t);
  const starter = await registeredStarter(main, { names: ["run_dynamic_workflow"] });
  const result = await starter.start({ goal: "Task", acceptance: ["Behavior"] });
  assert.equal(result.resultType, "failure");
  assert.match(result.textResultForLlm, /create_session.*unavailable/);
  assert.deepEqual(starter.calls, []);
});

test("starter reports invalid Git inspection without dispatching a workflow or session", async (t) => {
  const { root } = await workspace(t);
  for (const scenario of ["missing-directory", "invalid-gitdir", "bare", "nested-directory"]) {
    await t.test(scenario, async () => {
      const directory = path.join(root, ".data", scenario);
      if (scenario !== "missing-directory") await mkdir(directory, { recursive: true });
      if (scenario === "invalid-gitdir") await writeFile(path.join(directory, ".git"), "gitdir: missing\n");
      if (scenario === "bare") await exec("git", ["init", "--quiet", "--bare", directory]);
      const starter = await registeredStarter(directory);
      const result = await starter.start({ goal: "Task", acceptance: ["Behavior"] });
      assert.equal(result.resultType, "failure");
      assert.match(result.textResultForLlm, /git.*inspect|inspect.*git/i);
      assert.deepEqual(starter.calls, []);
    });
  }
});

test("extension registration is inert and the starter isolates a clean primary checkout", async (t) => {
  const { registerDevelopmentExtension, requireReadonlyReviewer } = await import("../workflow-extension.mjs");
  let registration, dispatched;
  const { main: root } = await workspace(t);
  const session = { rpc: {
    tools: {
      getCurrentMetadata: async () => ({ tools: [{ name: "create_session" }, { name: "run_dynamic_workflow" }] }),
      execute: async (request) => { dispatched = request; return { resultType: "success", textResultForLlm: "Created" }; },
    },
    agent: { list: async () => ({ agents: [{
      id: "devpocket-reviewer", path: path.join(root, ".github", "agents", "devpocket-reviewer.agent.md"), tools: ["read", "search"],
    }] }) },
  } };
  await registerDevelopmentExtension({
    defineWorkflow: (value) => value,
    joinSession: async (value) => { registration = value; return session; },
  }, root);
  assert.equal(dispatched, undefined);
  assert.equal(registration.workflows[0].meta.name, "devpocket-development");
  assert.deepEqual(registration.workflows[0].meta.phases.map((phase) => phase.title), ["Authorize", "Implement", "Candidate", "Verify", "Review", "Diagnose"]);
  assert.match(registration.workflows[0].meta.description, /recorded hosted grant allows native candidate push/);
  assert.match(registration.workflows[0].meta.description, /only when explicitly selected/);
  assert.equal(registration.workflows[0].meta.limits, undefined, "AI credit limits are chosen at invocation, not guessed.");
  assert.match(registration.tools[0].description, /only when the user explicitly selects the workflow/);
  assert.match(registration.tools[0].description, /clean linked worktree in the current session/);
  assert.match(registration.tools[0].description, /isolate a clean primary checkout/);
  await registration.tools[0].handler({ goal: "Task", acceptance: ["Behavior"] });
  assert.equal(dispatched.name, "create_session");
  assert.equal(dispatched.arguments.workspace_type, "worktree");
  assert.equal(dispatched.arguments.base_branch, undefined);
  assert.match(dispatched.arguments.kickoff.prompt, /run_dynamic_workflow/);
  assert.match(dispatched.arguments.kickoff.prompt, /Only the controller's candidate step/);
  assert.match(dispatched.arguments.kickoff.prompt, /unprepared workflow has no publication authority/);
  assert.match(dispatched.arguments.kickoff.prompt, /Never merge.*without separate target authorization/);
  assert.equal(registration.tools[1].name, "devpocket_check_development_readiness");
  session.workflow = {
    getRunDetail: async () => ({ status: "completed", workflowName: "other", runId: "wrong-run" }),
    getRun: async () => { assert.fail("Another workflow's result is not development evidence."); },
  };
  assert.equal((await registration.tools[1].handler({ runId: "wrong-run" })).resultType, "failure");
  assert.match(dispatched.arguments.kickoff.prompt, /explicitly selected the optional/);
  await requireReadonlyReviewer(session, root);
  session.rpc.agent.list = async () => ({ agents: [{
    id: "devpocket-reviewer", path: path.join(root, ".github", "agents", "devpocket-reviewer.agent.md"), tools: ["*"],
  }] });
  await assert.rejects(requireReadonlyReviewer(session, root), /read\/search-only/);
});

test("workflow registration stays inert without repository dependencies or a usable checkout", async () => {
  const entry = new URL("../workflow-extension.mjs", import.meta.url).href;
  const script = [
    "import assert from 'node:assert/strict';",
    "import {registerHooks} from 'node:module';",
    "registerHooks({resolve(specifier,context,next){",
    "if(!specifier.startsWith('node:')&&!specifier.startsWith('.')&&!specifier.startsWith('file:'))",
    "throw new Error('Repository dependency required before workflow registration: '+specifier);",
    "return next(specifier,context);}});",
    `const {registerDevelopmentExtension}=await import(${JSON.stringify(entry)});`,
    "let registration, definitions=0, joins=0;",
    "const unexpected=()=>assert.fail('Registration must not inspect or dispatch through the SDK.');",
    "const session={rpc:{tools:{getCurrentMetadata:unexpected,execute:unexpected},agent:{list:unexpected}}};",
    "const result=await registerDevelopmentExtension({",
    "defineWorkflow(value){definitions++;return value;},",
    "async joinSession(value){joins++;registration=value;return session;}",
    "},'a-worktree-that-does-not-exist');",
    "assert.equal(result,session);assert.equal(definitions,1);assert.equal(joins,1);",
    "assert.deepEqual(Object.keys(registration).sort(),['tools','workflows']);",
    "assert.equal(registration.workflows[0].meta.name,'devpocket-development');",
    "assert.equal(registration.workflows[0].meta.limits,undefined);",
    "assert.equal(registration.tools.length,2);",
    "assert.equal(registration.tools[0].name,'devpocket_start_development');",
    "assert.equal(registration.tools[1].name,'devpocket_check_development_readiness');",
  ].join("\n");
  await exec(process.execPath, ["--input-type=module", "-e", script]);
});

test("gate changes and missing agent results stop rather than granting self-approval", isolatedCases, async (t) => {
  const { runDevelopment } = await import("../development-workflow.mjs");
  await Promise.all(["policy", "missing-result"].map((scenario) =>
    t.test(scenario, async (t) => {
      const { root } = await workspace(t);
      let calls = 0;
      const result = await runDevelopment(durable({
        runId: scenario, args: { goal: "Task", acceptance: ["Behavior"] }, phase() {}, log() {},
        agent: async () => {
          calls++;
          if (scenario === "missing-result") return null;
          await mkdir(path.join(root, "scripts"));
          await writeFile(path.join(root, "scripts", "verify.mjs"), "process.exit(0);\n");
          return implemented(root, "Changed the gate.");
        },
      }), { root, verify: async () => { assert.fail("Unreviewed replacement policy must not run."); } });
      assert.equal(result.status, scenario === "policy" ? "needs_human" : "blocked");
      assert.equal(calls, 1);
    })));
});

test("tooling-only impact retains the controller's protected-policy stop before any execution or review", isolatedCases, async (t) => {
  const { runDevelopment } = await import("../development-workflow.mjs");
  const { verificationPlan } = await import("../verification.mjs");
  const files = ["AGENTS.md", "scripts/workflow-extension.mjs", "scripts/tests/development-workflow.test.mjs",
    "scripts/development-workflow.mjs", "scripts/development-policy.mjs", "scripts/candidate-commit.mjs",
    "scripts/native-candidate.mjs", "scripts/git-state.mjs", "scripts/verification.mjs", "scripts/verification-policy.mjs",
    "scripts/verify.mjs", "scripts/verify.ps1", "scripts/test-workflow.mjs", "scripts/tests/verification.test.mjs",
    ".github/agents/devpocket-reviewer.agent.md", ".github/skills/devpocket-development/SKILL.md"];
  const { root } = await workspace(t);
  for (const file of files) {
    await t.test(file, async () => {
      const absolute = path.join(root, file);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, "// fixture\n");
      try {
        const plan = await verificationPlan(root, "HEAD");
        assert.deepEqual(plan.requiredChecks, ["workflow-tests"]);
        assert.deepEqual(plan.requiredGroups, ["tooling"]);
        assert.equal(Object.hasOwn(plan, "requiresHumanReview"), false);
        const requirements = developmentReviewRequirements(plan.changedFiles);
        assert.equal(requirements.requiresHumanReview, isVerificationPolicyPath(file));
        assert.deepEqual(requirements.protectedPaths, isVerificationPolicyPath(file) ? [file] : []);
        assert.deepEqual(requirements.reviewPaths, []);
      } finally { await rm(absolute); }
    });
  }
  let calls = 0;
  const result = await runDevelopment(durable({
    runId: "tooling-protection", args: { goal: "Task", acceptance: ["Behavior"] }, phase() {}, log() {},
    agent: async (_prompt, options) => {
      calls++;
      assert.equal(options.agent, "general-purpose");
      for (const file of files) await writeFile(path.join(root, file), "// fixture\n");
      return implemented(root, "Changed routing policy.");
    },
  }), { root, verify: async () => { assert.fail("Tooling-only impact cannot authorize modified policy."); } });
  const plan = await verificationPlan(root, "HEAD");
  assert.equal(result.status, "needs_human");
  assert.equal(calls, 1);
  assert.equal(result.policyReview.requiresHumanReview, true);
  assert.deepEqual(result.policyReview.protectedPaths, files.filter(isVerificationPolicyPath).sort());
  assert.deepEqual(result.policyReview.source, plan.source);
  assert.equal(result.approval.stage, "execution");
  for (const file of result.policyReview.protectedPaths) assert.ok(result.approval.message.includes(file));
  assert.equal(result.verification, undefined);
  assert.equal(result.review, undefined);
});

test("local review requirements preserve trust boundaries independently of impact rules", async () => {
  const { developmentReviewRequirements } = await import("../development-policy.mjs");
  for (const [file, requiresReview, protectedPath] of [
    ["README.md", false, false], ["VALIDATION.md", false, false], ["docs/policy.md", false, false],
    ["AGENTS.md", true, true], ["scripts/development-workflow.mjs", true, true],
    ["scripts/development-policy.mjs", true, true], ["scripts/candidate-commit.mjs", true, true],
    ["scripts/tests/development-workflow.test.mjs", false, false],
    ["scripts/test-workflow.mjs", true, true], ["scripts/tests/workflow-runner.test.mjs", false, false],
    ["scripts/build-android.ps1", true, true], ["scripts/test-android.ps1", true, true],
    ["scripts/android-runner.mjs", true, true], ["scripts/package-extension.ps1", true, true],
    ["scripts/bundle-extension.mjs", true, true], ["scripts/export-schema.ts", true, true],
    [".github/agents/devpocket-reviewer.agent.md", true, true],
    [".github/skills/devpocket-development/SKILL.md", true, true],
    [".github/copilot-instructions.md", true, true],
    [".github/instructions/backend.instructions.md", true, true],
    [".github/instructions/nested/checks.instructions.md", true, true],
    [".github/README.md", false, false],
    ["scripts/verification.mjs", true, true], ["scripts/verification-policy.mjs", true, true],
    ["scripts/verification-preflight.mjs", true, true], ["scripts/verification-run.mjs", true, true],
    ["scripts/verification-transition.mjs", true, true],
    ["scripts/verification-tooling.mjs", true, true], ["scripts/verification-admission.mjs", true, true],
    ["scripts/verification-ci.mjs", true, true], ["scripts/verification-ci-artifact.ps1", true, true],
    ["scripts/verify.mjs", true, true], [".github/workflows/ci.yml", true, true],
    ["package-lock.json", true, true], [".NPMRC", true, true], ["backend/tsconfig.json", true, true],
    ["deployment/azure/probe/requirements-test.txt", true, true],
    ["android/gradlew.bat", true, true], ["android/app/build.gradle.kts", true, true],
    ["android/app/src/main/java/dev/devpocket/app/ui/Screen.kt", false, false],
    ["android/app/src/main/java/dev/devpocket/app/data/Store.kt", false, false],
    ["android/app/src/main/java/dev/devpocket/app/data/Vault.kt", true, false],
    ["android/app/src/main/AndroidManifest.xml", true, false],
    ["backend/tests/fixture.test.ts", false, false], ["backend/integration/fixture.ts", false, false],
    ["backend/src/runtime.ts", true, false], ["backend/src/push.ts", true, false],
    ["backend/src/cli.ts", false, false], ["extension/entry.mjs", true, false],
    ["deployment/setup.ps1", false, false], ["infra/main.bicep", false, false], ["azure.yaml", false, false],
    [".github/ISSUE_TEMPLATE/ai-task.yml", false, false], [".github/CODEOWNERS", true, true],
    ["protocol.schema.json", true, false], ["test-fixtures/fixture.json", false, false],
    ["unclassified.txt", true, false],
  ]) {
    const result = developmentReviewRequirements([file]);
    assert.equal(result.requiresHumanReview, protectedPath, file);
    assert.deepEqual(result.protectedPaths, protectedPath ? [file] : [], file);
    assert.deepEqual(result.reviewPaths, requiresReview && !protectedPath ? [file] : [], file);
    assert.ok(result.reasons.every((reason) => reason.title && reason.why && reason.paths.includes(file)));
  }
  assert.deepEqual(developmentReviewRequirements([]), { requiresHumanReview: false, protectedPaths: [], reviewPaths: [], reasons: [] });
  assert.deepEqual(developmentReviewRequirements(["README.md", "scripts/candidate-commit.mjs", "AGENTS.md", "AGENTS.md"]).protectedPaths,
    ["AGENTS.md", "scripts/candidate-commit.mjs"]);
  for (const invalid of [undefined, null, {}, "README.md", [null], [""], ["../package.json"], [".git/config"], ["C:/outside"]]) {
    assert.throws(() => developmentReviewRequirements(invalid), /actual changed-path list/);
  }
});

test("package metadata does not grant a dependency-policy exemption to executable changes", async (t) => {
  const { root } = await workspace(t), file = "package.json";
  const original = { name: "fixture", version: "1", scripts: { test: "node --test" }, dependencies: { example: "1.0.0" } };
  await writeFile(path.join(root, file), JSON.stringify(original));
  await git(root, ["add", "--", file]);
  await git(root, ["commit", "--quiet", "-m", "Fixture manifest"]);
  const base = (await sourceSnapshot(root)).head;
  for (const [value, needsApproval] of [
    [{ ...original, description: "Clearer description", version: "2" }, false],
    [{ ...original, dependencies: { example: "2.0.0" } }, true],
    [{ ...original, scripts: { test: "node new-runner.mjs" } }, true],
    [{ ...original, config: { registry: "changed" } }, true],
  ]) {
    await writeFile(path.join(root, file), JSON.stringify(value));
    const policy = await inspectDevelopmentPolicy(root, base, [file], git);
    assert.equal(policy.requiresHumanReview, needsApproval);
    assert.equal(policy.inputs.length, needsApproval ? 1 : 0);
  }
  await writeFile(path.join(root, file), JSON.stringify(original));
  assert.equal((await inspectDevelopmentPolicy(root, base, [file], git)).requiresHumanReview, false);
  const retained = await inspectDevelopmentPolicy(root, base, [], git, [file]);
  assert.equal(retained.requiresHumanReview, true, "Restoring a bound manifest must not erase its policy subject.");
  assert.deepEqual(retained.protectedPaths, [file]);
  assert.equal(retained.inputs.length, 1);
  await writeFile(path.join(root, file), "{invalid");
  assert.equal((await inspectDevelopmentPolicy(root, base, [file], git)).requiresHumanReview, true);
  assert.equal(developmentReviewRequirements([file]).requiresHumanReview, true, "Missing originals cannot establish metadata-only change.");
});

function approvalFixture() {
  const file = "scripts/verify.mjs";
  const scope = { sessionId: "fixture-session", runId: "fixture-run", base: "1".repeat(40),
    workspace: { root: path.resolve(".data", "approval-fixture"), branch: "refs/heads/task" },
    task: { goal: "Improve local verification", acceptance: ["Preserve required checks"] } };
  const policy = { ...developmentReviewRequirements([file]), contents: { [file]: "// policy fixture\n" }, inputs: [
    { path: file, kind: "file", mode: 0, sha256: "2".repeat(64) },
  ] };
  return { scope, policy, hooks: { directory: "fixture-hooks", fingerprint: "3".repeat(64) } };
}

test("approval inspection and rendering preserve prototype-like added and existing filenames", async (t) => {
  const { root } = await workspace(t), files = ["__proto__", "constructor", "toString"];
  const base = (await sourceSnapshot(root)).head;
  for (const file of files) await writeFile(path.join(root, file), `original ${file}\n`);
  const added = await inspectDevelopmentPolicy(root, base, files, git);
  assert.equal(Object.getPrototypeOf(added.contents), null);
  assert.equal(Object.getPrototypeOf(added.beforeContents), null);
  for (const file of files) {
    assert.equal(Object.hasOwn(added.contents, file), true);
    assert.equal(added.contents[file], `original ${file}\n`);
    assert.equal(Object.hasOwn(added.beforeContents, file), false);
  }
  const addedDetails = developmentApprovalDetails(base, added, files);
  assert.doesNotMatch(addedDetails, /\[object Object\]|function Object|function toString/);
  assert.ok(files.every((file) => addedDetails.includes(`original ${file}\n`)));
  const inherited = developmentApprovalDetails(base, { beforeContents: {}, contents: {} }, files);
  assert.doesNotMatch(inherited, /\[object Object\]|function/);
  await git(root, ["add", "--", ...files]);
  await git(root, ["commit", "--quiet", "-m", "Fixture named inputs"]);
  const existingBase = (await sourceSnapshot(root)).head;
  for (const file of files) await writeFile(path.join(root, file), `updated ${file}\n`);
  const existing = await inspectDevelopmentPolicy(root, existingBase, files, git);
  for (const file of files) {
    assert.equal(Object.hasOwn(existing.beforeContents, file), true);
    assert.equal(existing.beforeContents[file], `original ${file}\n`);
    assert.equal(existing.contents[file], `updated ${file}\n`);
  }
  const existingDetails = developmentApprovalDetails(existingBase, existing, files);
  assert.ok(files.every((file) => existingDetails.includes(`original ${file}\n`) && existingDetails.includes(`updated ${file}\n`)));
});

test("scoped approval identity follows authority inputs, not unrelated source revisions", () => {
  const { scope, policy, hooks } = approvalFixture();
  const request = developmentApprovalRequest(scope, policy, "execution", hooks);
  const unrelated = { ...policy, source: { head: "4".repeat(40), fingerprint: "5".repeat(64) } };
  assert.equal(developmentApprovalRequest(scope, unrelated, "execution", hooks).id, request.id);
  for (const next of [
    developmentApprovalRequest({ ...scope, runId: "another-task" }, policy, "execution", hooks),
    developmentApprovalRequest({ ...scope, sessionId: "another-session" }, policy, "execution", hooks),
    developmentApprovalRequest({ ...scope, workspace: { ...scope.workspace, branch: "refs/heads/other" } }, policy, "execution", hooks),
    developmentApprovalRequest(scope, { ...policy, inputs: [{ ...policy.inputs[0], sha256: "6".repeat(64) }] }, "execution", hooks),
    developmentApprovalRequest(scope, { ...policy, contents: { "scripts/verify.mjs": "Substituted presentation" } }, "execution", hooks),
    developmentApprovalRequest(scope, policy, "execution", { ...hooks, fingerprint: "7".repeat(64) }),
  ]) assert.notEqual(next.id, request.id);
  const snapshot = developmentApprovalDetails(scope.base, policy, policy.protectedPaths);
  const message = formatDevelopmentApproval(request, "actual-changes.txt", undefined, snapshot);
  for (const label of ["Approval requested:", "Why now:", "Target:", "Changes:", "After approval:", "Not included:", "Valid for:"]) {
    assert.ok(message.includes(label), label);
  }
  assert.ok(message.includes(scope.workspace.root));
  assert.ok(message.includes("scripts/verify.mjs"));
  assert.ok(message.includes("actual-changes.txt"));
  assert.ok(message.includes(snapshot));
  assert.throws(() => formatDevelopmentApproval(request, "actual-changes.txt"), /immutable approval snapshot/);
  assert.throws(() => formatDevelopmentApproval(request, "actual-changes.txt", undefined, "Substituted"), /immutable approval snapshot/);
  assert.equal(developmentApprovalSatisfied(request, [{ requestId: request.id, approved: true }]), false);
  assert.throws(() => developmentApprovalRequest(scope, { ...policy, inputs: [] }, "execution", hooks), /every requested path/);
});

test("approval snapshots cannot escape their native-question code block", () => {
  const { scope, policy, hooks } = approvalFixture();
  policy.contents["scripts/verify.mjs"] = "```text\nuntrusted contents\n```\n";
  const request = developmentApprovalRequest(scope, policy, "execution", hooks);
  const snapshot = developmentApprovalDetails(scope.base, policy, policy.protectedPaths);
  const message = formatDevelopmentApproval(request, "reference-only.txt", undefined, snapshot);
  assert.ok(message.includes(`\n\`\`\`\`text\n${snapshot}\n\`\`\`\``));
});

test("CI execution consent binds the repository and branch without inheriting local-only consent", () => {
  const { scope, policy, hooks } = approvalFixture();
  const local = developmentApprovalRequest(scope, policy, "execution", hooks);
  const target = { repository: "fixture/verification", ref: scope.workspace.branch };
  const request = developmentApprovalRequest({ ...scope, ci: target }, policy, "execution", hooks);
  assert.notEqual(request.id, local.id);
  assert.equal(developmentApprovalSatisfied(request, [{ version: 1, requestId: local.id,
    origin: "original-client", decision: "approved" }]), false);
  const snapshot = developmentApprovalDetails(scope.base, policy, policy.protectedPaths);
  const message = formatDevelopmentApproval(request, "reference-only.txt", "CI-first task", snapshot);
  assert.match(message, /CI target: fixture\/verification/);
  assert.match(message, /No push, PR creation, merge/);
  assert.ok(request.effects.some((effect) => effect.includes("hosted-runner setup")));
  for (const ci of [
    { ...target, ref: "refs/heads/other" }, { ...target, repository: "../verification" },
    { ...target, workflow: "different.yml" },
  ]) assert.throws(() => developmentApprovalRequest({ ...scope, ci }, policy, "execution", hooks), /exact repository and branch/);
});

test("only exact native decisions are journaled and rejection is not automatically re-prompted", async (t) => {
  const { scope, policy, hooks } = approvalFixture();
  const request = developmentApprovalRequest(scope, policy, "execution", hooks);
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/approval-details-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const details = path.join(directory, "actual-changes.txt");
  await writeFile(details, developmentApprovalDetails(scope.base, policy, policy.protectedPaths));
  for (const [response, expected] of [
    [{ action: "accept", content: { decision: "approve" } }, "approved"],
    [{ action: "accept", content: { decision: "reject" } }, "rejected"],
    [{ action: "decline" }, "rejected"],
    [{ action: "cancel" }, "cancelled"],
    [{ action: "accept", content: { decision: true } }, "invalid"],
    [{ action: "accept", content: { decision: "approve", extra: "scope" } }, "invalid"],
    [{ action: "accept", content: { decision: "approve" }, inventedApproval: true }, "invalid"],
    [null, "invalid"],
  ]) {
    let questions = 0;
    const ctx = durable({ session: { capabilities: { ui: { elicitation: true } }, ui: {
      elicitation: async (input) => {
        questions++;
        assert.deepEqual(input.requestedSchema.required, ["decision"]);
        assert.equal(input.requestedSchema.properties.decision.default, undefined);
        return response;
      },
    } } });
    const result = await obtainDevelopmentApproval(ctx, request, details);
    assert.equal((result.receipt ?? result.decision).decision, expected);
    assert.deepEqual(await obtainDevelopmentApproval(ctx, request, details), result);
    assert.equal(questions, 1);
    assert.equal(developmentApprovalSatisfied(request, [result.receipt]), expected === "approved");
  }
  const unavailable = await obtainDevelopmentApproval(durable({}), request, details);
  assert.equal(unavailable.status, "needs_human");
  assert.equal(unavailable.approval.id, request.id);
  assert.match(unavailable.reason, /UI is unavailable/);
});

test("substituted approval details cannot mint a reusable native grant", async (t) => {
  const { scope, policy, hooks } = approvalFixture();
  const request = developmentApprovalRequest(scope, policy, "execution", hooks);
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/approval-details-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const details = path.join(directory, "actual-changes.txt");
  const text = developmentApprovalDetails(scope.base, policy, policy.protectedPaths);
  await writeFile(details, text);
  let questions = 0;
  const ctx = durable({ session: { capabilities: { ui: { elicitation: true } }, ui: {
    elicitation: async () => {
      questions++;
      await writeFile(details, text.replace("policy fixture", "benign fixture"));
      return { action: "accept", content: { decision: "approve" } };
    },
  } } });
  const rejected = await obtainDevelopmentApproval(ctx, request, details);
  assert.equal(rejected.status, "blocked");
  assert.equal(rejected.decision.decision, "invalid");
  await writeFile(details, text);
  assert.equal((await obtainDevelopmentApproval(ctx, request, details)).status, "blocked");
  assert.equal(questions, 1, "Restoring the artifact cannot resurrect an invalid approval or repeat the question.");
});

test("substitution and restoration cannot alter contents presented by the native question", async (t) => {
  const { scope, policy, hooks } = approvalFixture();
  const request = developmentApprovalRequest(scope, policy, "execution", hooks);
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/approval-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const details = path.join(directory, "reference.txt");
  const snapshot = developmentApprovalDetails(scope.base, policy, policy.protectedPaths);
  await writeFile(details, snapshot);
  const ctx = durable({ session: { capabilities: { ui: { elicitation: true } }, ui: {
    elicitation: async (input) => {
      const shown = input.message;
      assert.ok(shown.includes(snapshot));
      assert.match(shown, /Local detail copy \(not authoritative\)/);
      await writeFile(details, snapshot.replace("policy fixture", "benign fixture"));
      assert.match(await readFile(details, "utf8"), /benign fixture/);
      assert.equal(input.message, shown);
      assert.doesNotMatch(input.message, /benign fixture/);
      await writeFile(details, snapshot);
      return { action: "accept", content: { decision: "approve" } };
    },
  } } });
  const decision = await obtainDevelopmentApproval(ctx, request, details);
  assert.equal(developmentApprovalSatisfied(request, [decision.receipt]), true,
    "The decision applies to the original immutable contents shown in the native question, not the substituted copy.");
});

test("native policy approval survives productive repairs beyond two rounds after the UI becomes unavailable", async (t) => {
  const { root } = await workspace(t), session = nativeSession();
  let questions = 0, implementations = 0, verifications = 0, reviews = 0, diagnoses = 0;
  session.capabilities = { ui: { elicitation: true } };
  session.ui = { elicitation: async (input) => {
    questions++;
    assert.match(input.message, /scripts\/verify\.mjs/);
    const detail = /Local detail copy \(not authoritative\): ([^\n]+)/.exec(input.message)[1];
    assert.match(await readFile(detail, "utf8"), /Proposed[\s\S]*policy fixture/);
    assert.match(input.message, /No push, PR creation, merge/);
    session.capabilities.ui.elicitation = false;
    return { action: "accept", content: { decision: "approve" } };
  } };
  const result = await runDevelopment(durable({
    runId: "approved-policy-repair", session, args: { goal: "Improve checks", acceptance: ["Keep coverage"] },
    agent: async (_prompt, options) => {
      if (options.label.includes(":diagnose:")) {
        diagnoses++;
        return { status: "progressing", evidence: "A distinct fixture blocker was resolved.",
          nextApproach: "Address the next independently reproduced fixture blocker." };
      }
      if (options.agent === "devpocket-reviewer") return ++reviews < 4 ? blockingReview : passingReview;
      implementations++;
      if (implementations === 1) {
        await mkdir(path.join(root, "scripts"));
        await writeFile(path.join(root, "scripts", "verify.mjs"), "// policy fixture\n");
      } else await writeFile(path.join(root, "README.md"), `Ordinary repair ${implementations}\n`);
      return implemented(root);
    },
  }), { root, verify: async (_root, plan) => { verifications++; return syntheticReport(plan); } });
  assert.equal(result.status, "ready", result.reason);
  assert.equal(questions, 1);
  assert.equal(implementations, 4);
  assert.equal(verifications, 4);
  assert.equal(reviews, 4);
  assert.equal(diagnoses, 2);
  assert.equal(result.round, 3);
  assert.equal(result.version, 8);
  assert.equal(result.authorization.receipts.length, 1);
  assert.equal(result.policyReview.requiresHumanReview, true, "A satisfied requirement is not a permanent blocker.");
  assert.equal((await checkDevelopmentReadiness(root, result)).status, "ready");
  for (const version of [5, 6]) {
    assert.equal((await checkDevelopmentReadiness(root, { ...result, version })).status, "blocked",
      "Old controller results cannot silently acquire the new completion semantics.");
  }
  assert.equal((await checkDevelopmentReadiness(root, { ...result, authorization: { ...result.authorization, receipts: [] } })).status, "blocked");
  assert.equal(Object.hasOwn(result.policyReview, "contents"), false);
  assert.equal(Object.hasOwn(result.policyReview, "beforeContents"), false);
});

test("a policy-bound manifest requires a new decision when restored to its task base", isolatedCases, async (t) => {
  await Promise.all(["approve", "reject"].map((restorationDecision) => t.test(restorationDecision, async (t) => {
    const { root } = await workspace(t), session = nativeSession();
    const file = "deployment/policy-fixture/package.json";
    const original = JSON.stringify({ name: "fixture", scripts: { test: "node original.mjs" } }) + "\n";
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), original);
    await git(root, ["add", "--", file]);
    await git(root, ["commit", "--quiet", "-m", "Fixture original manifest"]);
    let implementations = 0, questions = 0, verifications = 0, reviews = 0;
    session.capabilities = { ui: { elicitation: true } };
    session.ui = { elicitation: async (input) => {
      questions++;
      assert.ok(input.message.includes(file));
      return { action: "accept", content: { decision: questions === 1 ? "approve" : restorationDecision } };
    } };
    const result = await runDevelopment(durable({
      runId: "manifest-policy-restoration", session,
      args: { goal: "Restore approved execution settings", acceptance: ["Preserve consent history"], maxRepairRounds: 1 },
      agent: async (_prompt, options) => {
        if (options.agent === "devpocket-reviewer") return ++reviews === 1 ? blockingReview : passingReview;
        if (++implementations === 1) {
          await writeFile(path.join(root, file), JSON.stringify({ name: "fixture", scripts: { test: "node changed.mjs" } }) + "\n");
        } else {
          await writeFile(path.join(root, file), original);
          await writeFile(path.join(root, "README.md"), "Ordinary repair\n");
        }
        return implemented(root);
      },
    }), { root, verify: async (_root, plan) => {
      verifications++;
      if (verifications === 2) assert.deepEqual(plan.changedFiles, ["README.md"]);
      return syntheticReport(plan);
    } });
    assert.equal(questions, 2);
    assert.equal(implementations, 2);
    assert.deepEqual(result.policyPaths, [file]);
    assert.deepEqual(result.policyReview.protectedPaths, [file]);
    assert.equal(result.status, restorationDecision === "approve" ? "ready" : "needs_human", result.reason);
    assert.equal(verifications, restorationDecision === "approve" ? 2 : 1);
    assert.equal(result.authorization.receipts.length, restorationDecision === "approve" ? 2 : 1);
    if (restorationDecision === "approve") assert.equal((await checkDevelopmentReadiness(root, result)).status, "ready");
  })));
});

test("an existing tampered detail copy records a blocked handoff instead of escaping as EEXIST", async (t) => {
  const { root } = await workspace(t), session = nativeSession();
  let implementations = 0, verifications = 0, questions = 0, detailPath;
  session.capabilities = { ui: { elicitation: true } };
  session.ui = { elicitation: async (input) => {
    questions++;
    detailPath = /Local detail copy \(not authoritative\): ([^\n]+)/.exec(input.message)[1];
    return { action: "accept", content: { decision: "approve" } };
  } };
  const ctx = durable({
    runId: "retained-tampered-details", session,
    args: { goal: "Reject altered reference copies", acceptance: ["Persist the blocked result"], maxRepairRounds: 1 },
    agent: async (_prompt, options) => {
      if (options.agent === "devpocket-reviewer") return blockingReview;
      if (++implementations === 1) {
        await mkdir(path.join(root, "scripts"));
        await writeFile(path.join(root, "scripts", "verify.mjs"), "// policy fixture\n");
      } else {
        await writeFile(path.join(root, "README.md"), "Ordinary repair\n");
        await writeFile(detailPath, (await readFile(detailPath, "utf8")).replace("policy fixture", "benign fixture"));
        session.capabilities.ui.elicitation = false;
      }
      return implemented(root);
    },
  });
  const result = await runDevelopment(ctx, { root, verify: async (_root, plan) => {
    verifications++;
    return syntheticReport(plan);
  } });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /details changed|unsupported file type/);
  assert.equal(questions, 1);
  assert.equal(verifications, 1);
  for (const file of ["state.json", "handoff.json"]) {
    const saved = JSON.parse(await readFile(path.join(root, ".data", "development", ctx.runId, file), "utf8"));
    assert.equal((file === "state.json" ? saved.result : saved).status, "blocked");
  }
  ctx.agent = async () => { assert.fail("A recorded block must not replay implementation."); };
  assert.equal((await runDevelopment(ctx, { root })).status, "blocked");
});

test("ordinary test edits do not require project approval or reduce the selected checks", async (t) => {
  const { root } = await workspace(t), session = nativeSession();
  session.capabilities = { ui: { elicitation: true } };
  session.ui = { elicitation: async () => { assert.fail("Routine local tests are within task scope."); } };
  const result = await runDevelopment(documentationTask(root, { session, agent: async (_prompt, options) => {
    if (options.agent === "devpocket-reviewer") return passingReview;
    await mkdir(path.join(root, "scripts", "tests"), { recursive: true });
    await writeFile(path.join(root, "scripts", "tests", "verification.test.mjs"), "// local regression\n");
    return implemented(root);
  } }), { root, verify: async (_root, plan) => {
    assert.deepEqual(plan.requiredChecks, ["workflow-tests"]);
    return syntheticReport(plan);
  } });
  assert.equal(result.status, "ready", result.reason);
  assert.equal(result.authorization.receipts.length, 0);
});

test("known execution and instruction entrypoints stop before candidate or verification without consent", isolatedCases, async (t) => {
  await Promise.all(["scripts/build-android.ps1", "scripts/test-android.ps1", "scripts/android-runner.mjs",
    ".github/copilot-instructions.md", ".github/instructions/backend.instructions.md",
    ".github/instructions/nested/checks.instructions.md"].map((file) =>
    t.test(file, async (t) => {
      const { root } = await workspace(t), session = nativeSession();
      session.rpc.tools.execute = async () => { assert.fail("Changed build entrypoints need policy consent before candidate mutation."); };
      const result = await runDevelopment(documentationTask(root, { session, agent: async () => {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), "# changed build controller\n");
        return implemented(root);
      } }), { root, verify: async () => { assert.fail("Unapproved build policy must not execute."); } });
      assert.equal(result.status, "needs_human");
      assert.equal(result.approval.stage, "execution");
      assert.deepEqual(result.policyReview.protectedPaths, [file]);
      assert.equal(result.candidate, undefined);
    })));
});

test("ignored approval detail substitution stops before native candidate execution", isolatedCases, async (t) => {
  await Promise.all(["replace", "delete"].map((change) => t.test(change, async (t) => {
    const { root } = await workspace(t), session = nativeSession();
    let requestedSource;
    session.capabilities = { ui: { elicitation: true } };
    session.ui = { elicitation: async (input) => {
      requestedSource = await sourceSnapshot(root);
      const details = /Local detail copy \(not authoritative\): ([^\n]+)/.exec(input.message)[1];
      if (change === "delete") await rm(details);
      else {
        const original = await readFile(details, "utf8");
        const altered = original.replace("policy fixture", "benign fixture");
        assert.notEqual(original, altered);
        assert.equal(Buffer.byteLength(original), Buffer.byteLength(altered));
        await writeFile(details, altered);
      }
      return { action: "accept", content: { decision: "approve" } };
    } };
    session.rpc.tools.execute = async () => { assert.fail("Substituted approval details must not authorize a commit."); };
    const result = await runDevelopment(documentationTask(root, { session, agent: async () => {
      await mkdir(path.join(root, "scripts"));
      await writeFile(path.join(root, "scripts", "verify.mjs"), "// policy fixture\n");
      return implemented(root);
    } }), { root, verify: async () => { assert.fail("Substituted approval details must not authorize verification."); } });
    assert.equal(result.status, "blocked");
    assert.equal(result.decision.decision, "invalid");
    assert.deepEqual(await sourceSnapshot(root), requestedSource, "Ignored detail mutation does not alter source identity.");
    assert.equal(result.candidate, undefined);
    assert.equal(result.authorization.receipts.length, 0);
  })));
});

test("approved protected-path reversion retains the pending path set and continues the repair", isolatedCases, async (t) => {
  await Promise.all([false, true].map((keepAnotherPolicy) => t.test(`remaining policy: ${keepAnotherPolicy}`, async (t) => {
    const { root } = await workspace(t), session = nativeSession(), requests = [];
    let implementations = 0, reviews = 0, verifications = 0, diagnoses = 0;
    const rounds = keepAnotherPolicy ? 3 : 2;
    session.capabilities = { ui: { elicitation: true } };
    session.ui = { elicitation: async (input) => {
      requests.push(input.message);
      return { action: "accept", content: { decision: "approve" } };
    } };
    const result = await runDevelopment(durable({
      runId: "approved-policy-reversion", session,
      args: { goal: "Repair the local gate", acceptance: ["Keep coverage"], maxRepairRounds: rounds - 1 },
      agent: async (_prompt, options) => {
        if (options.label.includes(":diagnose:")) {
          diagnoses++;
          return { status: "progressing", evidence: "The fixture removed one obsolete execution policy and preserved the remaining one.",
            nextApproach: "Finish the remaining ordinary repair without changing the retained policy inputs." };
        }
        if (options.agent === "devpocket-reviewer") return ++reviews < rounds ? blockingReview : passingReview;
        if (++implementations === 1) {
          await mkdir(path.join(root, "scripts"));
          await writeFile(path.join(root, "scripts", "verify.mjs"), "// task-added gate\n");
          if (keepAnotherPolicy) await writeFile(path.join(root, "scripts", "verify.ps1"), "# another task gate\n");
        } else {
          if (implementations === 2) await rm(path.join(root, "scripts", "verify.mjs"));
          await writeFile(path.join(root, "README.md"), `Ordinary repair ${implementations}\n`);
        }
        return implemented(root);
      },
    }), { root, verify: async (_root, plan) => {
      if (++verifications >= 2) assert.deepEqual(plan.changedFiles,
        keepAnotherPolicy ? ["README.md", "scripts/verify.ps1"] : ["README.md"]);
      return syntheticReport(plan);
    } });
    assert.equal(result.status, "ready", result.reason);
    assert.equal(implementations, rounds);
    assert.equal(verifications, rounds);
    assert.equal(reviews, rounds);
    assert.equal(diagnoses, keepAnotherPolicy ? 1 : 0);
    assert.equal(requests.length, 2);
    assert.match(requests[1], /scripts\/verify\.mjs \[deleted\]/);
    assert.equal(result.authorization.receipts.length, 2);
    assert.deepEqual(result.policyPaths, keepAnotherPolicy ? ["scripts/verify.mjs", "scripts/verify.ps1"] : ["scripts/verify.mjs"]);
    assert.deepEqual(result.policyReview.protectedPaths, result.policyPaths);
    assert.equal((await checkDevelopmentReadiness(root, result)).status, "ready");
  })));
});

test("changed source during a policy question cannot consume a stale approval", async (t) => {
  const { root } = await workspace(t), session = nativeSession();
  const parent = (await sourceSnapshot(root)).head;
  session.capabilities = { ui: { elicitation: true } };
  session.ui = { elicitation: async () => {
    await writeFile(path.join(root, "README.md"), "Concurrent edit\n");
    return { action: "accept", content: { decision: "approve" } };
  } };
  session.rpc.tools.execute = async () => { assert.fail("A stale approval cannot commit."); };
  const result = await runDevelopment(documentationTask(root, { session, agent: async () => {
    await mkdir(path.join(root, "scripts"));
    await writeFile(path.join(root, "scripts", "verify.mjs"), "// policy fixture\n");
    return implemented(root);
  } }), { root, verify: async () => { assert.fail("A stale approval cannot execute policy."); } });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /changed while awaiting approval/);
  assert.equal((await sourceSnapshot(root)).head, parent);
});

test("sensitive paths require verification and independent review without a human approval dialog", isolatedCases, async (t) => {
  await Promise.all(["approve", "reject"].map((decision) => t.test(decision, async (t) => {
    const { root } = await workspace(t), session = nativeSession(), order = [];
    session.capabilities = { ui: { elicitation: true } };
    session.ui = { elicitation: async () => { assert.fail("A sensitive filename alone must not ask for human approval."); } };
    const result = await runDevelopment(documentationTask(root, { session, agent: async (_prompt, options) => {
      if (options.agent === "devpocket-reviewer") { order.push("independent"); return passingReview; }
      await mkdir(path.join(root, "extension"), { recursive: true });
      await writeFile(path.join(root, "extension", "entry.mjs"), "// sensitive fixture\n");
      return implemented(root);
    } }), { root, verify: async (_root, plan) => { order.push("verify"); return syntheticReport(plan); } });
    assert.deepEqual(order, ["verify", "independent"]);
    assert.equal(result.status, "ready", result.reason);
    assert.deepEqual(result.policyReview.reviewPaths, ["extension/entry.mjs"]);
    assert.equal(result.verification.complete, true);
    assert.equal(result.review.verdict, "pass");
  })));
});

test("post-review controller handoff uses local requirements even when verification carries a contrary review flag", isolatedCases, async (t) => {
  const { runDevelopment } = await import("../development-workflow.mjs");
  await Promise.all([["backend/tests/fixture.test.ts", false], ["extension/entry.mjs", false]].map(([file, requiresHumanReview]) =>
    t.test(file, async (t) => {
      const { root } = await workspace(t), calls = [];
      let executions = 0;
      const result = await runDevelopment(durable({
        runId: "local-review", args: { goal: "Task", acceptance: ["Behavior"] }, phase() {}, log() {},
        agent: async (_prompt, options) => {
          calls.push(options.agent);
          if (options.agent === "devpocket-reviewer") return { verdict: "pass", findings: [] };
          await mkdir(path.dirname(path.join(root, file)), { recursive: true });
          await writeFile(path.join(root, file), "// fixture\n");
          return implemented(root, "Changed source.");
        },
      }), { root, verify: async (_root, plan) => {
        executions++;
        assert.equal(Object.hasOwn(plan, "requiresHumanReview"), false);
        assert.deepEqual(plan.requiredGroups, ["tooling", "backend"]);
        return { ...plan, status: "passed", complete: true, group: "all", requiresHumanReview: !requiresHumanReview,
          checks: plan.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0, execution: syntheticExecution(plan.source) })) };
      } });
      assert.equal(executions, 1);
      assert.deepEqual(calls, ["general-purpose", "devpocket-reviewer"]);
      assert.equal(result.status, requiresHumanReview ? "needs_human" : "ready");
      assert.equal(result.policyReview.requiresHumanReview, requiresHumanReview);
      assert.deepEqual(result.policyReview.protectedPaths, []);
      assert.deepEqual(result.policyReview.source, result.source);
      assert.equal(result.verification.complete, true);
      assert.equal(result.review.verdict, "pass");
      assert.deepEqual(result.review.source, result.policyReview.source);
      if (requiresHumanReview) {
        const forged = structuredClone(result);
        forged.status = "ready";
        forged.policyReview.requiresHumanReview = false;
        assert.equal((await checkDevelopmentReadiness(root, forged)).status, "blocked");
      } else {
        const missing = structuredClone(result);
        delete missing.policyReview;
        assert.equal((await checkDevelopmentReadiness(root, missing)).status, "blocked");
        const stale = structuredClone(result);
        stale.policyReview.source.head = "0".repeat(40);
        assert.equal((await checkDevelopmentReadiness(root, stale)).status, "blocked");
      }
    })));
});

test("configured active hooks require policy approval before staging or committing changes", isolatedCases, async (t) => {
  const cases = [];
  for (const [folder, hook, absolute] of [[".githooks", "pre-commit", false], ["custom-hooks", "post-index-change", true]]) {
    for (const changed of [false, true]) {
      cases.push(t.test(`${folder}: ${hook}: ${changed ? "changed" : "unchanged"}`, async (t) => {
        const { root } = await workspace(t);
        const directory = path.join(root, folder), file = path.join(directory, hook);
        const marker = path.join(root, ".data", "hook-observation");
        await mkdir(directory);
        await mkdir(path.dirname(marker));
        const baseline = "#!/bin/sh\nprintf 'baseline\\n' > .data/hook-observation\n";
        const edited = "#!/bin/sh\nprintf 'changed\\n' > .data/hook-observation\n";
        await writeFile(file, baseline, { mode: 0o755 });
        await git(root, ["config", "--local", "core.hooksPath", absolute ? directory : folder]);
        await git(root, ["add", "--", `${folder}/${hook}`]);
        await git(root, ["commit", "--quiet", "-m", "Configure fixture hooks"]);
        await rm(marker, { force: true });
        const parent = (await sourceSnapshot(root)).head;
        const session = nativeSession(), execute = session.rpc.tools.execute;
        let mutations = 0, verifications = 0, reviews = 0;
        session.rpc.tools.execute = async (request) => { mutations++; return execute(request); };
        const result = await runDevelopment(documentationTask(root, {
          session,
          agent: async (_prompt, options) => {
            if (options.agent === "devpocket-reviewer") { reviews++; return passingReview; }
            if (changed) await writeFile(file, edited);
            else await writeFile(path.join(root, "README.md"), "Inspected task change\n");
            return implemented(root);
          },
        }), {
          root,
          verify: async (directory, plan, options) => {
            verifications++;
            if (changed) return { ...plan, group: "all", status: "blocked", complete: false,
              checks: plan.requiredChecks.map((id) => ({ id, status: "blocked" })) };
            return executeVerification(directory, plan, options);
          },
        });
        if (changed) {
          await assert.rejects(readFile(marker), { code: "ENOENT" }, "Changed active hook code must not execute before approval.");
          assert.equal(result.status, "needs_human", result.reason);
          assert.equal(mutations, 0);
          assert.equal(verifications, 0);
          assert.equal(reviews, 0);
          assert.equal((await sourceSnapshot(root)).head, parent);
          assert.equal(await readFile(file, "utf8"), edited);
        } else {
          assert.equal(result.status, "ready", result.reason);
          assert.equal(await readFile(marker, "utf8"), "baseline\n");
          assert.equal(mutations, 1);
          assert.equal(verifications, 1);
          assert.equal(reviews, 1);
        }
      }));
    }
  }
  await Promise.all(cases);
});

test("a configured hook changed after candidate preparation cannot execute", async (t) => {
  const { root } = await workspace(t);
  const hooks = path.join(root, ".githooks"), hook = path.join(hooks, "pre-commit");
  await mkdir(hooks);
  await writeFile(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await git(root, ["config", "--local", "core.hooksPath", ".githooks"]);
  await git(root, ["add", "--", ".githooks/pre-commit"]);
  await git(root, ["commit", "--quiet", "-m", "Configure fixture hook"]);
  const before = await inspectWorktree(root);
  await writeFile(path.join(root, "README.md"), "Inspected task change\n");
  const { request } = await prepareCandidate(root, before, await sourceSnapshot(root),
    ["README.md"], "fixture-session", "Keep hook policy fixed", undefined, await captureCandidateImplementation());
  await mkdir(path.join(root, ".data"));
  const file = path.join(root, ".data", "candidate-request.json"), bytes = JSON.stringify(request) + "\n";
  await writeFile(file, bytes);
  await writeFile(hook, "#!/bin/sh\nprintf changed > .data/changed-hook-ran\n");
  await assert.rejects(exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", nativeCandidateCommand(file, sha256(bytes))],
    { cwd: root, timeout: 30_000 }), { code: 1 });
  await assert.rejects(readFile(path.join(root, ".data", "changed-hook-ran")), { code: "ENOENT" });
  const after = await inspectWorktree(root);
  assert.equal(after.source.head, before.source.head);
  assert.equal(after.index, before.index);
});

test("native receipt proof prerequisites are checked before candidate mutation", isolatedCases, async (t) => {
  await Promise.all(["missing", "valid", "truncated", "hook-change"].map((scenario) =>
    t.test(scenario, async (t) => {
      const { root, main } = await workspace(t), directory = path.join(root, ".data", "verification", "local");
      await mkdir(directory, { recursive: true });
      const key = path.join(directory, "receipt.key");
      if (scenario !== "missing") await writeFile(key, Buffer.alloc(scenario === "truncated" ? 31 : 32, 7), { mode: 0o600 });
      if (scenario === "hook-change") await writeFile(path.join(main, ".git", "hooks", "pre-commit"),
        "#!/bin/sh\nprintf changed > .data/verification/local/receipt.key\n", { mode: 0o755 });
      const before = await inspectWorktree(root);
      await writeFile(path.join(root, "README.md"), "Candidate proof fixture\n");
      const { request } = await prepareCandidate(root, before, await sourceSnapshot(root),
        ["README.md"], "fixture-session", "Keep commit outcome separate from proof availability",
        undefined, await captureCandidateImplementation());
      const file = path.join(root, ".data", "candidate-proof.json"), bytes = JSON.stringify(request) + "\n";
      await writeFile(file, bytes);
      let failure;
      try {
        await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", nativeCandidateCommand(file, sha256(bytes))],
          { cwd: root, timeout: 60000 });
      } catch (error) { failure = error; }
      const receipt = JSON.parse(await readFile(`${file}.result.json`, "utf8")), after = await inspectWorktree(root);
      if (scenario === "truncated") {
        assert.equal(receipt.status, "blocked");
        assert.equal(failure?.code, 1);
        assert.equal(after.source.head, before.source.head, "Invalid proof storage must stop before advancing HEAD.");
        assert.equal(after.index, before.index);
      } else {
        assert.equal(receipt.status, "committed", failure?.stderr);
        assert.equal(failure, undefined);
        assert.equal(receipt.candidate.commit, after.source.head);
        assert.equal(receipt.candidate.parent, before.source.head);
        if (scenario === "valid") await validateCandidateReceiptProof(root, sha256(bytes), receipt);
        else if (scenario === "missing") assert.equal(receipt.verificationProof, undefined);
        else {
          assert.match(receipt.verificationProof.signature, /^[a-f0-9]{64}$/);
          await assert.rejects(validateCandidateReceiptProof(root, sha256(bytes), receipt));
        }
      }
    })));
});

test("verification cannot refresh changed external hooks into a repair baseline", async (t) => {
  const { root, main } = await workspace(t);
  const hooks = path.join(main, ".data", "shared-hooks"), hook = path.join(hooks, "pre-commit");
  await mkdir(hooks, { recursive: true });
  await writeFile(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await git(root, ["config", "--local", "core.hooksPath", hooks]);
  let implementations = 0, verifications = 0;
  const result = await runDevelopment(documentationTask(root, {
    args: { goal: "Keep the approved hook baseline", acceptance: ["Changed hooks stop before repair"], maxRepairRounds: 1 },
    agent: async (_prompt, options) => {
      if (options.agent === "devpocket-reviewer") return passingReview;
      implementations++;
      await writeFile(path.join(root, "README.md"), `Task revision ${implementations}\n`);
      return implemented(root);
    },
  }), {
    root,
    verify: async (_root, plan) => {
      verifications++;
      await writeFile(hook, "#!/bin/sh\nprintf changed > .data/repair-hook-ran\n");
      return { ...plan, group: "all", status: "failed", complete: false, checks: [] };
    },
  });
  assert.equal(result.status, "needs_human", result.reason);
  assert.match(result.reason, /hook policy changed/i);
  assert.equal(implementations, 1);
  assert.equal(verifications, 1);
  await assert.rejects(readFile(path.join(root, ".data", "repair-hook-ran")), { code: "ENOENT" });
});

test("ready results retain their original external-hook baseline", async (t) => {
  const { root, main } = await workspace(t);
  const hooks = path.join(main, ".data", "shared-hooks"), hook = path.join(hooks, "pre-commit");
  await mkdir(hooks, { recursive: true });
  await writeFile(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await git(root, ["config", "--local", "core.hooksPath", hooks]);
  const result = await runDevelopment(documentationTask(root), { root });
  assert.equal(result.status, "ready", result.reason);
  await writeFile(hook, "#!/bin/sh\nprintf changed > .data/reused-hook-ran\n");
  const stale = await checkDevelopmentReadiness(root, result);
  assert.equal(stale.status, "blocked");
  assert.match(stale.reason, /hook policy changed/i);
  await assert.rejects(readFile(path.join(root, ".data", "reused-hook-ran")), { code: "ENOENT" });
});

test("read-only Git probes do not execute configured filesystem monitors", async (t) => {
  const { verificationPlan } = await import("../verification.mjs");
  const { diagnosticSourceFiles } = await import("../verification-diagnostics.mjs");
  for (const probe of ["source", "paths", "plan", "worktree", "linked-starter", "primary-starter", "diagnostics"]) {
    await t.test(probe, async (t) => {
      const fixture = await workspace(t), root = probe === "primary-starter" ? fixture.main : fixture.root;
      const hook = path.join(fixture.main, ".git", "hooks", "fsmonitor-watchman");
      const marker = path.join(root, ".data", "monitor-ran");
      const base = (await git(root, ["rev-parse", "HEAD"])).trim();
      await mkdir(path.join(root, ".data"));
      await writeFile(hook, "#!/bin/sh\nprintf ran >> .data/monitor-ran\nprintf 'monitor-token\\0/\\0'\n", { mode: 0o755 });
      await git(root, ["config", "--local", "core.fsmonitor", hook.replaceAll("\\", "/")]);
      await git(root, ["config", "--local", "core.fsmonitorHookVersion", "2"]);
      fixtureFsmonitor(t, hook.replaceAll("\\", "/"));
      const configuration = await git(root, ["config", "--null", "--list", "--show-origin", "--show-scope"]);
      await writeFile(path.join(root, "README.md"), "Inspected dirty file\n");
      await mkdir(path.join(root, "docs"));
      await writeFile(path.join(root, "docs", "monitor.md"), "Untracked documentation\n");
      if (probe === "source") assert.equal((await sourceSnapshot(root)).head, base);
      if (probe === "paths") assert.deepEqual(await changedPaths(root, base), ["README.md", "docs/monitor.md"]);
      if (probe === "plan") assert.deepEqual((await verificationPlan(root, base)).changedFiles, ["README.md", "docs/monitor.md"]);
      if (probe === "diagnostics") {
        await mkdir(path.join(root, "scripts"));
        await writeFile(path.join(root, "scripts", "monitor.mjs"), "export {};\n");
        assert.deepEqual([...await diagnosticSourceFiles(root)], ["scripts/monitor.mjs"]);
      }
      if (probe === "worktree") {
        const current = await inspectWorktree(root);
        assert.equal(current.configuration, sha256(configuration), "Configuration evidence must not include probe-only overrides.");
        assert.match(current.status, /README\.md/);
        assert.match(current.status, /docs\/monitor\.md/);
      }
      if (probe.endsWith("starter")) {
        const starter = await registeredStarter(root);
        const result = await starter.start({ goal: "Inspect safely", acceptance: ["Dirty work stays untouched"] });
        assert.equal(result.resultType, "failure");
        assert.deepEqual(starter.calls, []);
      }
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      assert.equal(sha256(await git(root, ["config", "--null", "--list", "--show-origin", "--show-scope"])), sha256(configuration));
      if (probe === "source") {
        await git(root, ["add", "--", "README.md"]);
        assert.match(await readFile(marker, "utf8"), /^(?:ran)+$/, "Native mutation keeps the user's configured monitor behavior.");
      }
    });
  }
});

test("readiness rejects a changed filesystem-monitor hook without executing it", async (t) => {
  const { root, main } = await workspace(t);
  const hook = path.join(main, ".git", "hooks", "fsmonitor-watchman");
  await mkdir(path.join(root, ".data"));
  await writeFile(hook, "#!/bin/sh\nprintf 'monitor-token\\0/\\0'\n", { mode: 0o755 });
  await git(root, ["config", "--local", "core.fsmonitor", hook.replaceAll("\\", "/")]);
  await git(root, ["config", "--local", "core.fsmonitorHookVersion", "2"]);
  fixtureFsmonitor(t, hook.replaceAll("\\", "/"));
  const result = await runDevelopment(documentationTask(root, {
    agent: async (_prompt, options) => options.agent === "devpocket-reviewer" ? passingReview : implemented(root, "No source change"),
  }), { root });
  assert.equal(result.status, "ready", result.reason);
  await writeFile(hook, "#!/bin/sh\nprintf changed >> .data/changed-monitor-ran\nprintf 'monitor-token\\0/\\0'\n");
  const stale = await checkDevelopmentReadiness(root, result);
  assert.equal(stale.status, "blocked");
  assert.match(stale.reason, /hook policy changed/i);
  await assert.rejects(readFile(path.join(root, ".data", "changed-monitor-ran")), { code: "ENOENT" });
  assert.equal((await git(root, ["config", "--get", "core.fsmonitor"])).trim(), hook.replaceAll("\\", "/"));
});

test("changed filesystem-monitor configuration is rejected before it can execute", async (t) => {
  const { root } = await workspace(t);
  const parent = (await git(root, ["rev-parse", "HEAD"])).trim();
  const hook = path.join(root, ".data", "unapproved-monitor");
  await mkdir(path.join(root, ".data"));
  await writeFile(hook, "#!/bin/sh\nprintf changed >> .data/changed-monitor-ran\nprintf 'monitor-token\\0/\\0'\n", { mode: 0o755 });
  await git(root, ["config", "--local", "core.fsmonitorHookVersion", "2"]);
  const result = await runDevelopment(documentationTask(root, {
    agent: async () => {
      await writeFile(path.join(root, "README.md"), "Task edit\n");
      await git(root, ["config", "--local", "core.fsmonitor", hook.replaceAll("\\", "/")]);
      fixtureFsmonitor(t, hook.replaceAll("\\", "/"));
      return implemented(root);
    },
  }), { root, verify: async () => { assert.fail("Changed configuration must stop before verification."); } });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /configuration changed/i);
  await assert.rejects(readFile(path.join(root, ".data", "changed-monitor-ran")), { code: "ENOENT" });
  assert.equal((await git(root, ["rev-parse", "HEAD"])).trim(), parent);
  assert.equal((await git(root, ["config", "--get", "core.fsmonitor"])).trim(), hook.replaceAll("\\", "/"));
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "Task edit\n");
});

test("skill, compiler, Gradle launcher and nested dependency policy require review before execution", isolatedCases, async (t) => {
  const { runDevelopment } = await import("../development-workflow.mjs");
  const files = [".github/skills/devpocket-development/SKILL.md", ".npmrc", ".NPMRC", "backend/tsconfig.json", "android/gradlew.bat",
    "android/gradle/wrapper/gradle-wrapper.properties", "deployment/azure/package.json"];
  for (const file of files) {
    await t.test(file, () => {
      const requirements = developmentReviewRequirements([file]);
      assert.equal(requirements.requiresHumanReview, true);
      assert.deepEqual(requirements.protectedPaths, [file]);
    });
  }
  const { root } = await workspace(t);
  const result = await runDevelopment(durable({
    runId: "policy-input", args: { goal: "Task", acceptance: ["Behavior"] }, phase() {}, log() {},
    agent: async () => {
      for (const file of files.filter((file) => file !== ".NPMRC")) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), "{}\n");
      }
      return implemented(root, "Changed policy inputs.");
    },
  }), { root, verify: async () => { assert.fail("The replacement policy must not execute."); } });
  assert.equal(result.status, "needs_human");
});

function documentationTask(root, overrides = {}) {
  return durable({
    runId: "candidate-test", args: { goal: "Explain behavior", acceptance: ["Document the behavior"], maxRepairRounds: 0 },
    agent: async (_prompt, options) => {
      if (options.agent === "devpocket-reviewer") return passingReview;
      await writeFile(path.join(root, "README.md"), "Explained\n");
      return implemented(root);
    },
    ...overrides,
  });
}

function syntheticReport(plan) {
  return { ...plan, group: "all", status: "passed", complete: true,
    checks: plan.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0, execution: syntheticExecution(plan.source) })) };
}

test("a no-op initial task verifies and reviews the existing clean HEAD without an empty commit", async (t) => {
  const { root } = await workspace(t);
  const original = await sourceSnapshot(root), session = nativeSession();
  session.rpc.tools.execute = async () => { assert.fail("No empty commit or other native mutation is needed."); };
  let verifications = 0, reviews = 0;
  const result = await runDevelopment(documentationTask(root, {
    session,
    agent: async (_prompt, options) => {
      if (options.agent === "devpocket-reviewer") { reviews++; return passingReview; }
      return implemented(root, "The requested behavior is already present.");
    },
  }), { root, verify: async (...args) => { verifications++; return executeVerification(...args); } });
  assert.equal(result.status, "ready");
  assert.equal(result.candidate.created, false);
  assert.equal(result.candidate.commit, original.head);
  assert.deepEqual(result.source, original);
  assert.equal(verifications, 1);
  assert.equal(reviews, 1);
});

test("additions and deletions commit only literal task paths without losing source binding", async (t) => {
  const { root } = await workspace(t);
  const result = await runDevelopment(documentationTask(root, {
    agent: async (_prompt, options) => {
      if (options.agent === "devpocket-reviewer") return passingReview;
      await rm(path.join(root, "README.md"));
      await mkdir(path.join(root, "docs"));
      await writeFile(path.join(root, "docs", "reader's [notes].md"), "Replacement documentation\n");
      return implemented(root);
    },
  }), { root });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.changedFiles, ["README.md", "docs/reader's [notes].md"]);
  assert.equal((await inspectWorktree(root)).status, "");
  assert.deepEqual(result.review.source, result.source);
});

test("the SDK's string tool-result form still requires a validated native commit receipt", async (t) => {
  const { root } = await workspace(t), session = nativeSession();
  const execute = session.rpc.tools.execute;
  session.rpc.tools.execute = async (request) => {
    const result = await execute(request);
    return result.resultType === "success" ? result.textResultForLlm : result;
  };
  const result = await runDevelopment(documentationTask(root, { session }), { root });
  assert.equal(result.status, "ready");
  assert.equal(result.candidate.created, true);
  assert.equal((await inspectWorktree(root)).status, "");
});

test("signed candidates preserve signature settings while reading commit trailers", async (t) => {
  const { root, main } = await workspace(t);
  const directory = path.join(main, ".data", "signing");
  await mkdir(directory, { recursive: true });
  const key = path.join(directory, "fixture-key"), allowed = path.join(directory, "allowed-signers");
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "fixture@example.test", "-f", key], { timeout: 30_000 });
  await writeFile(allowed, `fixture@example.test ${(await readFile(`${key}.pub`, "utf8")).trim()}\n`);
  for (const [name, value] of [
    ["gpg.format", "ssh"], ["gpg.ssh.program", "ssh-keygen"], ["user.signingkey", key],
    ["gpg.ssh.allowedSignersFile", allowed], ["commit.gpgsign", "true"], ["log.showSignature", "true"],
  ]) await git(root, ["config", "--local", name, value]);
  const before = await inspectWorktree(root);
  const result = await runDevelopment(documentationTask(root), { root });
  assert.equal(result.status, "ready", result.reason);
  await git(root, ["verify-commit", result.candidate.commit]);
  assert.equal((await inspectWorktree(root)).configuration, before.configuration);
  const visible = await git(root, ["show", "-s", "--format=%(trailers:key=Copilot-Session,valueonly)", result.candidate.commit]);
  assert.notEqual(visible.trim(), "fixture-session", "Signature display remains enabled outside machine-readable queries.");
});

test("candidate implementation capture includes every verification adapter and rejects the older input set", async () => {
  const captured = await captureCandidateImplementation();
  assert.equal(captured.version, 2);
  for (const name of verificationInputs) {
    assert.match(captured.files.find((file) => file.name === name)?.sha256 ?? "", /^[a-f0-9]{64}$/);
  }
  await requireCandidateImplementation(captured);
  for (const name of ["development-controller.mjs", "owned-command.cs", "verification-ci.mjs"]) {
    assert.ok(captured.files.some((file) => file.name === name));
    assert.equal(isVerificationPolicyPath(`scripts/${name}`), true);
  }
  const legacy = { ...captured, files: captured.files.filter((file) => !verificationInputs.includes(file.name)) };
  await assert.rejects(requireCandidateImplementation(legacy), /captured controller\/helper implementation/);
});

test("candidate implementation capture rejects linked execution inputs", async (t) => {
  const { root } = await workspace(t), { directory } = await copiedController(root);
  const original = path.join(directory, "development-policy.mjs"), saved = original + ".saved", target = path.join(directory, "alias-target");
  await fs.rename(original, saved);
  await mkdir(target);
  await symlink(target, original, process.platform === "win32" ? "junction" : "dir");
  try { await assert.rejects(captureCandidateImplementation(directory), /implementation input is unavailable/); }
  finally { await rm(original); await fs.rename(saved, original); }
});
test("cached emulator recovery remains bound to both controller and verifier execution snapshots", async (t) => {
  const { root } = await workspace(t);
  const { directory } = await copiedController(root, (directory) =>
    fs.copyFile(path.resolve("scripts/emulator-resources.mjs"), path.join(directory, "emulator-resources.mjs")));
  await import(pathToFileURL(path.join(directory, "verification-android.mjs")).href);
  const verifier = await import(pathToFileURL(path.join(directory, "verification-preflight.mjs")).href);
  const captured = await captureCandidateImplementation(directory), before = await verifier.verificationExecutionPolicy();
  const file = path.join(directory, "emulator-resources.mjs");
  await writeFile(file, (await readFile(file, "utf8")) + "\n// changed in-process recovery policy\n");
  const controllerRejected = await requireCandidateImplementation(captured).then(() => false, (error) => {
    assert.match(error.message, /implementation changed/);
    return true;
  });
  assert.deepEqual({
    controllerRejected, verifierChanged: await verifier.verificationExecutionPolicy() !== before,
  }, { controllerRejected: true, verifierChanged: true });
});

test("cold capture only settles byte-identical Windows metadata, never a changed executable input", async (t) => {
  for (const changedBytes of [false, true]) await t.test(changedBytes ? "changed bytes" : "metadata only", async (t) => {
    const { root } = await workspace(t);
    const { directory } = await copiedController(root);
    const target = await fs.realpath(path.join(directory, "verification-backend.mjs"));
    const expected = await readFile(target);
    await fs.utimes(target, 1, 1);
    const originalOpen = fs.open;
    let injected = false;
    const mocked = t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await originalOpen(file, ...args);
      if (file !== target) return handle;
      return new Proxy(handle, { get(value, key) {
        if (key === "read") return async (...parameters) => {
          const result = await value.read(...parameters);
          if (!injected) {
            injected = true;
            if (changedBytes) {
              const altered = Buffer.from(expected);
              altered[0] ^= 1;
              await writeFile(target, altered);
            }
            await fs.utimes(target, 2, 1);
          }
          return result;
        };
        const member = Reflect.get(value, key, value);
        return typeof member === "function" ? member.bind(value) : member;
      } });
    });
    syncBuiltinESMExports();
    try {
      if (changedBytes || process.platform !== "win32") {
        await assert.rejects(captureCandidateImplementation(directory), /changed while being captured/);
      } else {
        const captured = await captureCandidateImplementation(directory);
        assert.equal(captured.files.find((file) => file.name === "verification-backend.mjs").sha256, sha256(expected));
      }
      assert.equal(injected, true);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  });
});

test("native capture retries identical metadata churn but rejects content changes or persistent instability", async () => {
  const entry = new URL("../native-candidate.mjs", import.meta.url).href;
  const script = [
    'import assert from "node:assert/strict";',
    'import fs from "node:fs/promises";',
    'import { syncBuiltinESMExports } from "node:module";',
    `const target = await fs.realpath(new URL(${JSON.stringify(entry)}));`,
    'const original = fs.lstat, originalOpen = fs.open, mode = process.argv[1];',
    'let observed = 0, reads = 0;',
    'fs.lstat = async (file, ...args) => {',
    '  const info = await original(file, ...args);',
    '  if (file === target) {',
    '    observed++;',
    '    if (mode === "open" && observed === 1) info.ctimeMs -= 1;',
    '    if (["transient", "content"].includes(mode) && observed === 2) info.ctimeMs += 1;',
    '    if (mode === "during" && observed > 1) info.ctimeMs += 1;',
    '  }',
    '  return info;',
    '};',
    'fs.open = async (file, ...args) => {',
    '  const handle = await originalOpen(file, ...args);',
    '  if (file === target && mode === "content") {',
    '    const read = handle.read.bind(handle);',
    '    handle.read = async (...options) => {',
    '      const result = await read(...options);',
    '      if (++reads === 2) result.buffer[0] ^= 1;',
    '      return result;',
    '    };',
    '  }',
    '  return handle;',
    '};',
    'syncBuiltinESMExports();',
    `const { captureCandidateImplementation } = await import(${JSON.stringify(entry)});`,
    'if (mode === "open" || mode === "transient" && process.platform === "win32") {',
    '  const result = await captureCandidateImplementation();',
    '  assert.ok(result.files.some(file => file.name === "native-candidate.mjs"));',
    '} else await assert.rejects(captureCandidateImplementation(), /changed while being captured/);',
    'assert.equal(observed, mode === "open" || process.platform !== "win32" ? 2 : 3);',
    'console.log("capture validated");',
  ].join("\n");
  for (const mode of ["open", "transient", "during", "content"]) {
    const result = await exec(process.execPath, ["--input-type=module", "-e", script, mode], { timeout: 30_000 });
    assert.match(result.stdout, /capture validated/);
  }
});

test("native approval cannot execute a changed helper, import or wrapper", isolatedCases, async (t) => {
  await Promise.all(["candidate-commit.mjs", "git-state.mjs", "native-candidate.mjs", "development-workflow.mjs",
    "development-policy.mjs", "workflow-extension.mjs", ...verificationInputs].map((name) =>
    t.test(name, async (t) => {
      const { root } = await workspace(t), session = nativeSession();
      const { directory, controller } = await copiedController(root);
      const originalHead = (await sourceSnapshot(root)).head;
      const marker = path.join(root, ".data", "unapproved-code-ran");
      const execute = session.rpc.tools.execute;
      session.rpc.tools.execute = async (request) => {
        const file = path.join(directory, name);
        await writeFile(file, await readFile(file, "utf8") +
          `\nawait import("node:fs/promises").then(fs => fs.writeFile(${JSON.stringify(marker)}, "executed"));\n`);
        return execute(request);
      };
      const result = await controller.runDevelopment(documentationTask(root, { session }), {
        root, verify: async () => { assert.fail("Changed executable inputs must not reach verification."); },
      });
      assert.equal(result.status, "blocked");
      assert.match(result.reason, /helper|imported|implementation/i);
      assert.equal((await sourceSnapshot(root)).head, originalHead);
      assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    })));
});

test("capturing verification adapters does not widen the closed native candidate loader", async (t) => {
  const { root } = await workspace(t), session = nativeSession();
  const { controller } = await copiedController(root, async (directory) => {
    const helper = path.join(directory, "candidate-commit.mjs"), content = await readFile(helper, "utf8");
    const entry = "export async function runCandidateRequest(file, hash) {";
    assert.ok(content.includes(entry));
    await writeFile(helper, content.replace(entry, `${entry}\n  await import("./verification-backend.mjs");`));
  });
  const parent = (await sourceSnapshot(root)).head, execute = session.rpc.tools.execute;
  let nativeResult;
  session.rpc.tools.execute = async (request) => {
    nativeResult = await execute(request);
    return nativeResult;
  };
  const result = await controller.runDevelopment(documentationTask(root, { session }), {
    root, verify: async () => { assert.fail("A non-native import cannot reach verification."); },
  });
  assert.equal(result.status, "blocked");
  assert.match(nativeResult.textResultForLlm, /unclassified candidate import/i);
  assert.equal((await sourceSnapshot(root)).head, parent);
  assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
});

test("native startup refuses unbound Node preloads before they can execute", isolatedCases, async (t) => {
  await Promise.all(["import", "require"].map((option) =>
    t.test(option, async (t) => {
      const { root } = await workspace(t), session = nativeSession();
      const directory = path.join(root, ".data");
      await mkdir(directory);
      const preload = path.join(directory, option === "import" ? "preload.mjs" : "preload.cjs");
      const marker = path.join(directory, "unapproved-startup-ran");
      await writeFile(preload, option === "import" ? "export {};\n" : "");
      const parent = (await sourceSnapshot(root)).head, originalOptions = process.env.NODE_OPTIONS;
      const options = option === "import" ? `--import=${pathToFileURL(preload).href}`
        : `--require=${JSON.stringify(preload.replaceAll("\\", "/"))}`;
      session.rpc.tools.execute = async (request) => {
        await writeFile(preload, option === "import"
          ? `await import("node:fs/promises").then(fs => fs.writeFile(${JSON.stringify(marker)}, "executed"));\n`
          : `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`);
        try {
          const result = await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", request.arguments.command],
            { timeout: 30_000, env: { ...process.env, NODE_OPTIONS: options } });
          return { resultType: "success", textResultForLlm: result.stdout };
        } catch (error) { return { resultType: "failure", textResultForLlm: error.stderr }; }
      };
      const result = await runDevelopment(documentationTask(root, { session }), {
        root, verify: async () => { assert.fail("Unbound startup code must not reach verification."); },
      });
      assert.equal(result.status, "blocked");
      assert.match(result.reason, /NODE_OPTIONS.*before Node started/);
      assert.equal((await sourceSnapshot(root)).head, parent);
      assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
      assert.equal(process.env.NODE_OPTIONS, originalOptions);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      const receipt = JSON.parse(await readFile(path.join(root, ".data", "development", "candidate-test",
        "candidate-0.json.result.json"), "utf8"));
      assert.equal(receipt.failure, "execution-startup-unbound");
    })));
});

test("a stale loaded controller cannot adopt a newer on-disk implementation", isolatedCases, async (t) => {
  await Promise.all(["candidate-commit.mjs", ...verificationInputs].map((name) => t.test(name, async (t) => {
    const { root } = await workspace(t);
    const { directory, controller } = await copiedController(root);
    const file = path.join(directory, name);
    await writeFile(file, await readFile(file, "utf8") + "\n// different implementation revision\n");
    const result = await controller.runDevelopment(documentationTask(root, {
      agent: async () => { assert.fail("Stale implementation must stop before dispatch."); },
    }), { root });
    assert.equal(result.status, "needs_human");
    assert.match(result.reason, /implementation changed/);
  })));
});

test("verifiers cannot mutate the controller's source or check-selection snapshot", isolatedCases, async (t) => {
  await Promise.all(["source", "checks"].map((field) =>
    t.test(field, async (t) => {
      const { root } = await workspace(t);
      let reviewCalls = 0, mutationBlocked = false;
      const result = await runDevelopment(documentationTask(root, {
        agent: async (_prompt, options) => {
          if (options.agent === "devpocket-reviewer") { reviewCalls++; return passingReview; }
          await mkdir(path.join(root, "backend", "tests"), { recursive: true });
          await writeFile(path.join(root, "backend", "tests", "changed.test.ts"), "export {};\n");
          return implemented(root);
        },
      }), {
        root,
        verify: async (_root, plan) => {
          try {
            if (field === "source") plan.source.head = "0".repeat(40);
            else { plan.requiredChecks.length = 0; plan.requiredGroups.length = 0; }
          } catch (error) { assert.ok(error instanceof TypeError); mutationBlocked = true; }
          const report = syntheticReport(plan);
          if (field === "source") report.source = { ...plan.source, head: "0".repeat(40) };
          else { report.requiredChecks = []; report.requiredGroups = []; report.checks = []; }
          return report;
        },
      });
      assert.equal(mutationBlocked, true);
      assert.equal(result.status, "blocked");
      assert.equal(reviewCalls, 0, "A verifier cannot weaken the policy consumed by independent review.");
    })));
});

test("pre-existing user changes are preserved without dispatching or staging", async (t) => {
  const { root } = await workspace(t);
  await writeFile(path.join(root, "README.md"), "User draft\n");
  await git(root, ["add", "--", "README.md"]);
  const before = await inspectWorktree(root);
  const result = await runDevelopment(documentationTask(root, {
    agent: async () => { assert.fail("A dirty starting worktree must be refused."); },
  }), { root });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /clean/);
  assert.deepEqual(await inspectWorktree(root), before);
});

test("commit permission, native-tool and hook failures never reach final verification", isolatedCases, async (t) => {
  await Promise.all(["denied", "missing-tool", "missing-pipeline", "missing-session", "missing-receipt",
    "hook-error", "hook-post-commit-error", "hook-post-index-error", "hook-mutates", "hook-removes-trailer"].map((scenario) =>
    t.test(scenario, async (t) => {
      const { root, main } = await workspace(t), session = nativeSession();
      const parent = (await sourceSnapshot(root)).head;
      if (scenario === "denied") session.rpc.tools.execute = async () => ({ resultType: "denied" });
      if (scenario === "missing-tool") session.rpc.tools.getCurrentMetadata = async () => ({ tools: [] });
      if (scenario === "missing-pipeline") delete session.rpc.tools;
      if (scenario === "missing-session") delete session.sessionId;
      if (scenario === "missing-receipt") session.rpc.tools.execute = async () => ({ resultType: "success" });
      if (scenario.startsWith("hook")) {
        const hook = scenario === "hook-removes-trailer" ? "commit-msg" :
          scenario === "hook-post-commit-error" ? "post-commit" :
          scenario === "hook-post-index-error" ? "post-index-change" : "pre-commit";
        const body = scenario.endsWith("error") ? "echo fixture-hook-failed >&2\nexit 19\n" :
          scenario === "hook-mutates" ? "echo hook-content > README.md\ngit add -- README.md\n" :
          "printf 'Hook replaced message\\n' > \"$1\"\n";
        await writeFile(path.join(main, ".git", "hooks", hook), `#!/bin/sh\n${body}`, { mode: 0o755 });
      }
      const result = await runDevelopment(documentationTask(root, { session }), {
        root, verify: async () => { assert.fail("Commit failure is not PR readiness or authority to run final verification."); },
      });
      assert.equal(result.status, "blocked");
      assert.match(result.reason, /commit|hook|pipeline|PowerShell|session identity/i);
      const current = await inspectWorktree(root);
      assert.equal(current.identity.branch, "refs/heads/task");
      const index = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "index"])).trim());
      await assert.rejects(readFile(`${index}.lock`), { code: "ENOENT" });
      if (["hook-post-commit-error", "hook-removes-trailer"].includes(scenario)) {
        assert.notEqual(current.source.head, parent, "A failed candidate remains history; it is never reset/amended.");
      } else assert.equal(current.source.head, parent);
      if (scenario === "hook-mutates") {
        assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "hook-content\n", "Retain hook edits without admitting a different tree.");
        assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
      }
      if (scenario === "hook-error") {
        assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "", "A failed isolated commit leaves the original live index intact.");
        assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "Explained\n");
        const receipt = JSON.parse(await readFile(path.join(root, ".data", "development", "candidate-test",
          "candidate-0.json.result.json"), "utf8"));
        assert.equal(receipt.failure, "commit-failed");
        assert.equal(receipt.exitCode, 1, "Record Git's observed failure, not an invented hook-process exit.");
        assert.equal(JSON.stringify(receipt).includes("fixture-hook-failed"), false, "Raw hook output stays in the native tool output.");
      }
      if (scenario === "hook-post-commit-error" || scenario === "hook-post-index-error") {
        const receipt = JSON.parse(await readFile(path.join(root, ".data", "development", "candidate-test",
          "candidate-0.json.result.json"), "utf8"));
        assert.equal(receipt.failure, "hook-failed");
        assert.equal(receipt.exitCode, 0, "A hook failure must not invent a failing Git command exit.");
        assert.deepEqual(receipt.hookFailures, [{
          hook: scenario === "hook-post-commit-error" ? "post-commit" : "post-index-change", exitCode: 19,
        }]);
        assert.equal(JSON.stringify(receipt).includes("fixture-hook-failed"), false);
      }
    })));
});

test("nested Git hook failures cannot qualify an otherwise successful commit", async (t) => {
  const { root, main } = await workspace(t);
  await writeFile(path.join(main, ".git", "hooks", "post-index-change"), [
    "#!/bin/sh",
    "if test -e .data/inside-pre-commit; then",
    "  printf observed > .data/nested-hook-ran",
    "  printf 'private nested hook detail\\n' >&2",
    "  exit 19",
    "fi",
    "",
  ].join("\n"), { mode: 0o755 });
  await writeFile(path.join(main, ".git", "hooks", "pre-commit"), [
    "#!/bin/sh",
    ": > .data/inside-pre-commit",
    "printf 'Explained\\n' > README.md",
    "git add -- README.md",
    "code=$?",
    "rm .data/inside-pre-commit",
    "exit \"$code\"",
    "",
  ].join("\n"), { mode: 0o755 });
  let verifications = 0;
  const result = await runDevelopment(documentationTask(root), {
    root, verify: async (directory, plan, options) => { verifications++; return executeVerification(directory, plan, options); },
  });
  assert.equal(await readFile(path.join(root, ".data", "nested-hook-ran"), "utf8"), "observed");
  assert.equal(result.status, "blocked", "An ignored nested hook failure is not a successful candidate.");
  assert.equal(verifications, 0);
  const receipt = JSON.parse(await readFile(path.join(root, ".data", "development", "candidate-test",
    "candidate-0.json.result.json"), "utf8"));
  assert.equal(receipt.failure, "hook-failed");
  assert.equal(receipt.exitCode, 0, "Keep the root Git command's successful exit distinct from the failed nested hook.");
  assert.ok(receipt.hookFailures.some((failure) => failure.hook === "post-index-change" && failure.exitCode === 19));
  assert.equal(JSON.stringify(receipt).includes("private nested hook detail"), false);
});

test("nested hook evidence is not limited to the candidate routing set", isolatedCases, async (t) => {
  await Promise.all([["post-checkout", 0], ["post-checkout", 19], ["fixture-unsupported-hook", 0]].map(([hook, exitCode]) =>
    t.test(`${hook}: ${exitCode}`, async (t) => {
      const { root, main } = await workspace(t);
      let unknownHookOption = "";
      if (hook === "fixture-unsupported-hook") {
        let help;
        try {
          const output = await exec("git", ["hook", "run", "-h"], { cwd: root, timeout: 30_000 });
          help = output.stdout + output.stderr;
        } catch (error) {
          if (error.code !== 129) throw error;
          help = error.stdout + error.stderr;
        }
        assert.match(help, /git hook run/);
        if (help.includes("--allow-unknown-hook-name")) unknownHookOption = "--allow-unknown-hook-name ";
      }
      await writeFile(path.join(main, ".git", "hooks", hook), [
        "#!/bin/sh",
        "printf ran >> .data/nested-observed-hook",
        "printf 'private nested hook output\\n' >&2",
        `exit ${exitCode}`,
        "",
      ].join("\n"), { mode: 0o755 });
      await writeFile(path.join(main, ".git", "hooks", "pre-commit"), [
        "#!/bin/sh",
        hook === "post-checkout" ? "git -c core.autocrlf=false checkout -- README.md" : `git hook run ${unknownHookOption}${hook}`,
        "exit 0",
        "",
      ].join("\n"), { mode: 0o755 });
      const before = await inspectWorktree(root);
      let verifications = 0;
      const result = await runDevelopment(documentationTask(root), {
        root, verify: async (...args) => { verifications++; return executeVerification(...args); },
      });
      const receiptText = await readFile(path.join(root, ".data", "development", "candidate-test",
        "candidate-0.json.result.json"), "utf8");
      const receipt = JSON.parse(receiptText), current = await inspectWorktree(root);
      const accepted = hook === "post-checkout" && exitCode === 0;
      assert.equal(await readFile(path.join(root, ".data", "nested-observed-hook"), "utf8"), "ran");
      assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "Explained\n");
      assert.equal((await git(root, ["rev-list", "--count", `${before.source.head}..HEAD`])).trim(), "1",
        "Inspect the completed native commit rather than aborting before the nested hook runs.");
      assert.equal(result.status, accepted ? "ready" : "blocked", result.reason);
      assert.equal(verifications, accepted ? 1 : 0);
      assert.equal(receiptText.includes("private nested hook output"), false);
      if (accepted) {
        assert.equal(current.status, "");
        assert.equal(receipt.status, "committed");
        assert.equal(receipt.candidate.reference.commit, current.source.head);
      } else {
        assert.equal(receipt.status, "blocked");
        assert.equal(receipt.failure, hook === "post-checkout" ? "hook-failed" : "hook-evidence");
        assert.equal(receipt.exitCode, 0, "Retain the successful root Git exit separately from nested hook evidence.");
        assert.equal(current.index, before.index, "Failure must not publish the private index.");
        if (hook === "post-checkout") assert.deepEqual(receipt.hookFailures, [{ hook, exitCode }]);
      }
    })));
});

test("successful hooks run once normally even when their output or nested Git commands look like failures", async (t) => {
  const { root, main } = await workspace(t);
  await writeFile(path.join(main, ".git", "hooks", "post-commit"), [
    "#!/bin/sh",
    "echo fixture-hook-failed >&2",
    "git diff --quiet HEAD^ HEAD -- README.md",
    "echo ran >> .data/hook-invocations",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  const result = await runDevelopment(documentationTask(root), { root });
  assert.equal(result.status, "ready");
  assert.equal(await readFile(path.join(root, ".data", "hook-invocations"), "utf8"), "ran\n");
});

test("unavailable hook-exit evidence blocks a completed commit without replaying it", isolatedCases, async (t) => {
  await Promise.all([': > "$GIT_TRACE2_EVENT"', 'echo invalid-json >> "$GIT_TRACE2_EVENT"'].map((body) =>
    t.test(body, async (t) => {
      const { root, main } = await workspace(t);
      const parent = (await sourceSnapshot(root)).head;
      await writeFile(path.join(main, ".git", "hooks", "post-commit"), `#!/bin/sh\n${body}\nexit 0\n`, { mode: 0o755 });
      const result = await runDevelopment(documentationTask(root), {
        root, verify: async () => { assert.fail("Missing hook evidence cannot qualify a candidate."); },
      });
      assert.equal(result.status, "blocked");
      assert.match(result.reason, /hook-exit evidence/);
      assert.notEqual((await sourceSnapshot(root)).head, parent);
      assert.equal((await git(root, ["rev-list", "--count", `${parent}..HEAD`])).trim(), "1");
      const receipt = JSON.parse(await readFile(path.join(root, ".data", "development", "candidate-test",
        "candidate-0.json.result.json"), "utf8"));
      assert.equal(receipt.failure, "hook-evidence");
      assert.equal(receipt.exitCode, 0);
    })));
});

test("candidate and publication inspections do not refresh the index or invoke its hook", async (t) => {
  const original = process.env.GIT_OPTIONAL_LOCKS;
  process.env.GIT_OPTIONAL_LOCKS = "1";
  t.after(() => {
    if (original === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
    else process.env.GIT_OPTIONAL_LOCKS = original;
  });
  const { root, main } = await workspace(t);
  await writeFile(path.join(main, ".git", "hooks", "post-index-change"), [
    "#!/bin/sh",
    "if test -f .data/after-commit; then",
    "  echo unexpected-refresh >> .data/index-refreshed",
    "  exit 19",
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  await writeFile(path.join(main, ".git", "hooks", "post-commit"), [
    "#!/bin/sh",
    "touch -t 200001010000 README.md",
    "touch .data/after-commit",
    "",
  ].join("\n"), { mode: 0o755 });
  const result = await runDevelopment(documentationTask(root), { root });
  assert.equal(result.status, "ready");
  assert.equal((await checkDevelopmentReadiness(root, result)).status, "ready");
  await assert.rejects(readFile(path.join(root, ".data", "index-refreshed")), { code: "ENOENT" });
});

test("unowned or post-inspection changes and implementer history/index changes stop before committing", isolatedCases, async (t) => {
  await Promise.all(["unowned", "source", "index", "history", "branch", "configuration"].map((scenario) =>
    t.test(scenario, async (t) => {
      const { root } = await workspace(t);
      const session = nativeSession();
      session.rpc.tools.execute = async () => { assert.fail("Unexpected changes cannot be committed by the controller."); };
      const result = await runDevelopment(documentationTask(root, {
        session,
        agent: async () => {
          await writeFile(path.join(root, "README.md"), "Task change\n");
          const value = await implemented(root);
          if (scenario === "unowned") {
            await writeFile(path.join(root, "user-notes.md"), "Concurrent user notes\n");
            value.source = await sourceSnapshot(root);
          }
          if (scenario === "source") await writeFile(path.join(root, "README.md"), "Concurrent edit\n");
          if (scenario === "index") await git(root, ["add", "--", "README.md"]);
          if (scenario === "history") {
            await git(root, ["add", "--", "README.md"]);
            await git(root, ["commit", "--quiet", "-m", "Unexpected implementation commit"]);
          }
          if (scenario === "branch") await git(root, ["checkout", "--quiet", "-b", "unexpected"]);
          if (scenario === "configuration") await git(root, ["config", "user.name", "Concurrent user"]);
          return value;
        },
      }), { root, verify: async () => { assert.fail("Unexpected changes require inspection."); } });
      assert.equal(result.status, "blocked");
      assert.match(result.reason, /source|concurrent|index|history|branch|configuration/i);
      if (scenario === "unowned") assert.equal(await readFile(path.join(root, "user-notes.md"), "utf8"), "Concurrent user notes\n");
      if (scenario === "configuration") assert.equal((await git(root, ["config", "user.name"])).trim(), "Concurrent user");
    })));
});

test("the native candidate boundary rejects concurrent changes instead of committing new content", isolatedCases, async (t) => {
  await Promise.all(["source", "index", "history", "branch", "request", "existing-receipt"].map((scenario) =>
    t.test(scenario, async (t) => {
      const { root } = await workspace(t), session = nativeSession();
      const original = (await sourceSnapshot(root)).head, execute = session.rpc.tools.execute;
      session.rpc.tools.execute = async (request) => {
        if (scenario === "source") await writeFile(path.join(root, "README.md"), "Concurrent user edit\n");
        if (scenario === "index") await git(root, ["add", "--", "README.md"]);
        if (scenario === "history") await git(root, ["commit", "--allow-empty", "--quiet", "-m", "Concurrent commit"]);
        if (scenario === "branch") await git(root, ["checkout", "--quiet", "-b", "concurrent"]);
        if (scenario === "request") {
          const file = request.arguments.command.match(/--request '((?:[^']|'')*)'/)[1].replaceAll("''", "'");
          await writeFile(file, "{}\n");
        }
        if (scenario === "existing-receipt") {
          const file = request.arguments.command.match(/--request '((?:[^']|'')*)'/)[1].replaceAll("''", "'");
          await writeFile(`${file}.result.json`, '{"status":"committed","candidate":{"commit":"forged"}}\n');
        }
        return execute(request);
      };
      const result = await runDevelopment(documentationTask(root, { session }), {
        root, verify: async () => { assert.fail("Concurrent commit inputs cannot be verified as an accepted candidate."); },
      });
      assert.equal(result.status, "blocked");
      if (scenario !== "history") assert.equal((await sourceSnapshot(root)).head, original);
      if (scenario === "source") assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "Concurrent user edit\n");
      if (scenario === "index") assert.match(await git(root, ["diff", "--cached", "--name-only"]), /README.md/);
      if (scenario === "existing-receipt") assert.equal(await readFile(path.join(root, ".data", "development",
        "candidate-test", "candidate-0.json.result.json"), "utf8"), '{"status":"committed","candidate":{"commit":"forged"}}\n');
    })));
});

test("a hook-staged unowned file cannot enter retained candidate history", async (t) => {
  const { root, main } = await workspace(t);
  const parent = (await sourceSnapshot(root)).head;
  await writeFile(path.join(main, ".git", "hooks", "pre-commit"),
    "#!/bin/sh\nprintf 'Unowned hook content\\n' > hook-unowned.txt\ngit add -- hook-unowned.txt\n", { mode: 0o755 });
  const result = await runDevelopment(documentationTask(root), {
    root, verify: async () => { assert.fail("Unowned committed content cannot reach verification."); },
  });
  assert.equal(result.status, "blocked");
  assert.equal((await sourceSnapshot(root)).head, parent, "Reject the new tree before advancing the branch.");
  assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "", "Preserve the original live index.");
  assert.equal(await readFile(path.join(root, "hook-unowned.txt"), "utf8"), "Unowned hook content\n");
});

test("late AUTO_MERGE creation cannot be deleted as an assumed no-op", async (t) => {
  const { root, main } = await workspace(t);
  const expected = (await git(root, ["rev-parse", "HEAD^{tree}"])).trim();
  await writeFile(path.join(main, ".git", "hooks", "commit-msg"),
    "#!/bin/sh\ngit update-ref AUTO_MERGE \"$(git rev-parse HEAD^{tree})\"\n", { mode: 0o755 });
  const before = await inspectWorktree(root);
  await writeFile(path.join(root, "README.md"), "Inspected task change\n");
  const { request } = await prepareCandidate(root, before, await sourceSnapshot(root),
    ["README.md"], "fixture-session", "Preserve newly created metadata", undefined, await captureCandidateImplementation());
  await mkdir(path.join(root, ".data"));
  const file = path.join(root, ".data", "candidate-request.json"), bytes = JSON.stringify(request) + "\n";
  await writeFile(file, bytes);
  let failure;
  try {
    await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", nativeCandidateCommand(file, sha256(bytes))],
      { cwd: root, timeout: 60_000 });
  } catch (error) { failure = error; }
  let retained;
  try { retained = (await git(root, ["rev-parse", "--verify", "--quiet", "AUTO_MERGE"])).trim(); }
  catch (error) { if (error.code !== 1) throw error; }
  assert.equal(retained, expected, "A hook-created ref must survive an unconditional zero-old cleanup.");
  assert.equal(failure?.code, 1);
  const receipt = JSON.parse(await readFile(`${file}.result.json`, "utf8"));
  assert.equal(receipt.status, "blocked");
});

test("reference preparing notifications stay advisory until locked admission", isolatedCases, async (t) => {
  await Promise.all(["commit", "hook-tree-change", "hook-veto", "unknown-phase"].map((scenario) =>
    t.test(scenario, async (t) => {
      const { root, main } = await workspace(t);
      const directory = path.join(root, ".data");
      await mkdir(directory);
      await writeFile(path.join(main, ".git", "hooks", "reference-transaction"), [
        "#!/bin/sh",
        'if test "$1" = preparing; then',
        "  printf preparing >> .data/preparing-count",
        scenario === "hook-veto" ? "  exit 19" : "  :",
        "fi",
        "cat > /dev/null",
        "",
      ].join("\n"), { mode: 0o755 });
      if (scenario === "hook-tree-change") {
        await writeFile(path.join(main, ".git", "hooks", "pre-commit"),
          "#!/bin/sh\nprintf 'Unowned\\n' > unowned.txt\ngit add -- unowned.txt\n", { mode: 0o755 });
      }
      const before = await inspectWorktree(root);
      await writeFile(path.join(root, "README.md"), "Inspected change\n");
      const { request } = await prepareCandidate(root, before, await sourceSnapshot(root),
        ["README.md"], "fixture-session", "Keep preparing advisory", undefined, await captureCandidateImplementation());
      const file = path.join(directory, "candidate-request.json"), bytes = JSON.stringify(request) + "\n";
      await writeFile(file, bytes);
      const preload = path.join(directory, "preparing-protocol.mjs");
      await writeFile(preload, [
        "import assert from 'node:assert/strict';",
        "import childProcess from 'node:child_process';",
        "import { syncBuiltinESMExports } from 'node:module';",
        "import { promisify } from 'node:util';",
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        `const target = ${JSON.stringify(root)}, unknown = ${scenario === "unknown-phase"};`,
        "const original = childProcess.execFile, execute = promisify(original);",
        "const intercepted = (...args) => original(...args);",
        "intercepted[promisify.custom] = (program, args, options) => {",
        "  const routing = args.find((value) => value.startsWith('core.hooksPath='));",
        "  if (program === 'git' && options?.cwd === target && routing && (args.includes('update-ref') || args.includes('commit'))) {",
        "    const guard = routing.slice('core.hooksPath='.length);",
        "    const env = { ...options.env }; delete env.GIT_TRACE2_EVENT;",
        "    const query = (args) => childProcess.execFileSync('git', args, { cwd: target, env, encoding: 'utf8' }).trim();",
        "    const parent = query(['rev-parse', 'HEAD']), branch = query(['symbolic-ref', 'HEAD']), zero = '0'.repeat(parent.length);",
        "    const counter = path.join(target, '.data', 'preparing-count');",
        "    const count = () => existsSync(counter) ? readFileSync(counter, 'utf8') : '';",
        "    const invoke = (label, input, forwarded) => {",
        "      const stdin = path.join(target, '.data', `${label}-input`), previous = count();",
        "      writeFileSync(stdin, input);",
        "      writeFileSync(path.join(target, '.data', 'preparing-observed'), `${label}:entered\\n`, { flag: 'a' });",
        "      childProcess.execFileSync('git', ['-c', routing, 'hook', 'run', `--to-stdin=${stdin}`,",
        "        'reference-transaction', '--', unknown ? 'future-phase' : 'preparing'],",
        "        { cwd: target, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });",
        "      assert.equal(count(), previous + (forwarded ? 'preparing' : ''), 'Forward a user phase once, never forward the private probe.');",
        "      for (const name of ['probe.json', 'prepared.json', 'cleanup-prepared.json']) {",
        "        assert.equal(existsSync(path.join(guard, name)), false, 'Pre-lock notifications cannot create locked evidence.');",
        "      }",
        "      writeFileSync(path.join(target, '.data', 'preparing-observed'), `${label}:accepted\\n`, { flag: 'a' });",
        "    };",
        "    if (args.includes('update-ref')) invoke('probe', `${parent} ${zero} ${branch}\\n`, false);",
        "    else {",
        "      const tree = query(['write-tree']);",
        "      const proposed = query(['commit-tree', tree, '-p', parent, '-m', 'Pre-lock fixture object']);",
        "      invoke('commit', `${parent} ${proposed} HEAD\\n`, true);",
        "      invoke('cleanup', `${zero} ${zero} AUTO_MERGE\\n`, true);",
        "    }",
        "  }",
        "  return execute(program, args, options);",
        "}; childProcess.execFile = intercepted; syncBuiltinESMExports();",
        "",
      ].join("\n"));
      const command = nativeCandidateCommand(file, sha256(bytes)).replace(" --input-type=module",
        ` --import '${pathToFileURL(preload).href.replaceAll("'", "''")}' --input-type=module`);
      let failure;
      try {
        await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd: root, timeout: 90_000 });
      } catch (error) { failure = error; }
      const observed = await readFile(path.join(directory, "preparing-observed"), "utf8");
      const receipt = JSON.parse(await readFile(`${file}.result.json`, "utf8"));
      const current = await inspectWorktree(root);
      if (scenario === "commit") {
        assert.equal(receipt.status, "committed", failure?.stderr);
        assert.equal(failure, undefined);
        assert.equal(receipt.candidate.reference.commit, current.source.head);
        assert.equal(receipt.candidate.reference.tree, (await git(root, ["rev-parse", "HEAD^{tree}"])).trim());
        assert.match(observed, /probe:accepted\ncommit:entered\ncommit:accepted\ncleanup:entered\ncleanup:accepted\n/);
      } else {
        assert.equal(receipt.status, "blocked");
        assert.equal(failure?.code, 1);
        assert.equal(current.source.head, before.source.head);
        assert.equal(current.index, before.index);
        if (scenario === "hook-tree-change") {
          assert.match(observed, /cleanup:accepted/);
          assert.equal(await readFile(path.join(root, "unowned.txt"), "utf8"), "Unowned\n");
        } else if (scenario === "hook-veto") {
          assert.equal(observed, "probe:entered\nprobe:accepted\ncommit:entered\n");
          assert.equal(await readFile(path.join(directory, "preparing-count"), "utf8"), "preparing");
        } else assert.equal(observed, "probe:entered\n");
      }
    })));
});

test("transaction guards preserve configured hooks, original configuration and hook vetoes", isolatedCases, async (t) => {
  await Promise.all([false, true].map((veto) =>
    t.test(veto ? "reference veto" : "normal reference hooks", async (t) => {
      const { root } = await workspace(t);
      const hooks = path.join(root, ".githooks"), data = path.join(root, ".data");
      await mkdir(hooks); await mkdir(data);
      await git(root, ["config", "--local", "core.hooksPath", ".githooks"]);
      await writeFile(path.join(hooks, "pre-commit"),
        "#!/bin/sh\ngit config --null --list --show-origin --show-scope > .data/hook-config\nprintf pre >> .data/pre-count\n",
        { mode: 0o755 });
      await writeFile(path.join(hooks, "reference-transaction"), [
        "#!/bin/sh",
        'printf "%s\\n" "$1" >> .data/reference-phases',
        'cat >> .data/reference-phases',
        veto ? 'if test "$1" = prepared && test -e .data/enable-veto; then exit 19; fi' : "exit 0",
        "",
      ].join("\n"), { mode: 0o755 });
      await git(root, ["add", "--", ".githooks"]);
      await git(root, ["commit", "--quiet", "-m", "Configure original hooks"]);
      await rm(path.join(data, "pre-count"), { force: true });
      await rm(path.join(data, "reference-phases"), { force: true });
      if (veto) await writeFile(path.join(data, "enable-veto"), "yes");
      const before = await inspectWorktree(root);
      const result = await runDevelopment(documentationTask(root), { root });
      assert.equal(result.status, veto ? "blocked" : "ready", result.reason);
      assert.equal(await readFile(path.join(data, "pre-count"), "utf8"), "pre");
      assert.equal(sha256(await readFile(path.join(data, "hook-config"))), before.configuration);
      assert.equal((await inspectWorktree(root)).configuration, before.configuration);
      if (veto) assert.equal((await sourceSnapshot(root)).head, before.source.head);
      else {
        const phases = await readFile(path.join(data, "reference-phases"), "utf8");
        assert.equal(phases.match(/refs\/heads\/task\n/g)?.length, 2, "Forward the actual prepared/committed update once; the capability probe is private.");
        assert.equal(result.candidate.reference.branch, "refs/heads/task");
        assert.equal(result.candidate.reference.parent, before.source.head);
        assert.equal(result.candidate.reference.tree, result.candidate.tree);
      }
    })));
});

test("ref changes at commit admission cannot advance an unintended branch or parent", isolatedCases, async (t) => {
  await Promise.all(["branch", "parent", "commit-hook-branch"].map((scenario) =>
    t.test(scenario, async (t) => {
      const { root, main } = await workspace(t);
      const parent = (await sourceSnapshot(root)).head;
      const tree = (await git(root, ["rev-parse", "HEAD^{tree}"])).trim();
      const otherParent = scenario === "commit-hook-branch" ? parent
        : (await git(root, ["commit-tree", tree, "-p", parent, "-m", "Other fixture parent"])).trim();
      await git(root, ["branch", "other", otherParent]);
      if (scenario === "commit-hook-branch") {
        await writeFile(path.join(main, ".git", "hooks", "commit-msg"),
          "#!/bin/sh\ngit symbolic-ref HEAD refs/heads/other\n", { mode: 0o755 });
      }
      const before = await inspectWorktree(root);
      await writeFile(path.join(root, "README.md"), "Inspected task change\n");
      const { request } = await prepareCandidate(root, before, await sourceSnapshot(root),
        ["README.md"], "fixture-session", "Keep the expected ref transaction", undefined, await captureCandidateImplementation());
      await mkdir(path.join(root, ".data"));
      const file = path.join(root, ".data", "candidate-request.json"), bytes = JSON.stringify(request) + "\n";
      await writeFile(file, bytes);
      let command = nativeCandidateCommand(file, sha256(bytes));
      if (scenario !== "commit-hook-branch") {
        const preload = path.join(root, ".data", "concurrent-ref.mjs");
        const action = scenario === "branch" ? ["symbolic-ref", "HEAD", "refs/heads/other"]
          : ["update-ref", "refs/heads/task", otherParent, parent];
        await writeFile(preload, [
          "import childProcess from 'node:child_process';",
          "import { syncBuiltinESMExports } from 'node:module';",
          "import { promisify } from 'node:util';",
          "import { writeFileSync } from 'node:fs';",
          `const target = ${JSON.stringify(root)}, action = ${JSON.stringify(action)};`,
          "const original = childProcess.execFile, execute = promisify(original);",
          "const intercepted = (...args) => original(...args); let changed = false;",
          "intercepted[promisify.custom] = (program, args, options) => {",
          "  if (!changed && program === 'git' && options?.cwd === target && args.includes('commit')) {",
          "    changed = true; childProcess.execFileSync('git', action, { cwd: target });",
          `    writeFileSync(${JSON.stringify(path.join(root, ".data", "ref-change-observed"))}, "changed");`,
          "  }",
          "  return execute(program, args, options);",
          "}; childProcess.execFile = intercepted; syncBuiltinESMExports();",
          "",
        ].join("\n"));
        command = command.replace(" --input-type=module",
          ` --import '${pathToFileURL(preload).href.replaceAll("'", "''")}' --input-type=module`);
      }
      await assert.rejects(exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command],
        { cwd: root, timeout: 60_000 }));
      if (scenario !== "commit-hook-branch") {
        assert.equal(await readFile(path.join(root, ".data", "ref-change-observed"), "utf8"), "changed");
      }
      assert.equal((await git(root, ["symbolic-ref", "HEAD"])).trim(),
        scenario === "parent" ? "refs/heads/task" : "refs/heads/other", "Preserve the concurrent actor's HEAD selection.");
      assert.equal((await git(root, ["rev-parse", "refs/heads/other"])).trim(), otherParent,
        "The candidate must not advance the other branch.");
      assert.equal((await git(root, ["rev-parse", "refs/heads/task"])).trim(),
        scenario === "parent" ? otherParent : parent, "The candidate must not replace the concurrent parent update.");
      const receipt = JSON.parse(await readFile(`${file}.result.json`, "utf8"));
      assert.equal(receipt.status, "blocked");
    })));
});

test("a staged-only edit between preflight and staging is never overwritten", async (t) => {
  const { root } = await workspace(t);
  const before = await inspectWorktree(root);
  await writeFile(path.join(root, "README.md"), "Inspected task change\n");
  const { request } = await prepareCandidate(root, before, await sourceSnapshot(root),
    ["README.md"], "fixture-session", "Preserve concurrent staged work", undefined, await captureCandidateImplementation());
  const directory = path.join(root, ".data");
  await mkdir(directory);
  const requestFile = path.join(directory, "candidate-request.json"), bytes = JSON.stringify(request) + "\n";
  await writeFile(requestFile, bytes);
  const preload = path.join(directory, "concurrent-staging.mjs");
  await writeFile(preload, [
    "import childProcess from 'node:child_process';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { promisify } from 'node:util';",
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    `const target = ${JSON.stringify(root)};`,
    "const original = childProcess.execFile, execute = promisify(original);",
    "const intercepted = (...args) => original(...args);",
    "let injected = false;",
    "intercepted[promisify.custom] = (command, args, options) => {",
    "  if (!injected && command === 'git' && options?.cwd === target && args.includes('add')) {",
    "    injected = true;",
    "    const blob = childProcess.execFileSync('git', ['hash-object', '-w', '--stdin'],",
    "      { cwd: target, encoding: 'utf8', input: 'Concurrent staged-only change\\n' }).trim();",
    "    const staged = childProcess.spawnSync('git', ['update-index', '--cacheinfo', `100644,${blob},README.md`],",
    "      { cwd: target, encoding: 'utf8' });",
    "    const index = childProcess.execFileSync('git', ['rev-parse', '--git-path', 'index'], { cwd: target, encoding: 'utf8' }).trim();",
    "    writeFileSync(path.join(target, '.data', 'staged-only-attempt.json'), JSON.stringify({",
    "      blob, exitCode: staged.status, lockPresent: existsSync(path.resolve(target, index) + '.lock'),",
    "    }));",
    "  }",
    "  return execute(command, args, options);",
    "};",
    "childProcess.execFile = intercepted;",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"));
  const command = nativeCandidateCommand(requestFile, sha256(bytes)).replace(" --input-type=module",
    ` --import '${pathToFileURL(preload).href.replaceAll("'", "''")}' --input-type=module`);
  let failure;
  try {
    await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd: root, timeout: 30_000 });
  } catch (error) { failure = error; }
  const attempt = JSON.parse(await readFile(path.join(directory, "staged-only-attempt.json"), "utf8"));
  const receipt = JSON.parse(await readFile(`${requestFile}.result.json`, "utf8"));
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "Inspected task change\n");
  if (attempt.exitCode === 0) {
    assert.equal((await git(root, ["rev-parse", ":README.md"])).trim(), attempt.blob,
      "A successful concurrent index-only edit must not be replaced by task staging.");
    assert.equal(receipt.status, "blocked");
    assert.equal(failure?.code, 1);
  } else {
    assert.equal(attempt.exitCode, 128, "Only Git's index-lock refusal can exclude the concurrent writer.");
    assert.equal(attempt.lockPresent, true);
    assert.equal(receipt.status, "committed", failure?.stderr);
    assert.equal(failure, undefined);
    assert.equal(receipt.candidate.parent, before.source.head);
    assert.equal((await inspectWorktree(root)).status, "");
    assert.equal(await git(root, ["show", "--no-show-signature", "HEAD:README.md"]), "Inspected task change\n");
  }
});

test("staging after final inspection never commits an unowned file", async (t) => {
  const { root } = await workspace(t);
  const before = await inspectWorktree(root);
  await writeFile(path.join(root, "README.md"), "Inspected task change\n");
  const { request } = await prepareCandidate(root, before, await sourceSnapshot(root),
    ["README.md"], "fixture-session", "Commit the inspected task", undefined, await captureCandidateImplementation());
  const directory = path.join(root, ".data");
  await mkdir(directory);
  const requestFile = path.join(directory, "candidate-request.json");
  const bytes = JSON.stringify(request) + "\n";
  await writeFile(requestFile, bytes);
  const preload = path.join(directory, "concurrent-index.mjs");
  await writeFile(preload, [
    "import childProcess from 'node:child_process';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { promisify } from 'node:util';",
    "import { writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const original = childProcess.execFile, execute = promisify(original);",
    "const intercepted = (...args) => original(...args);",
    "intercepted[promisify.custom] = (command, args, options) => {",
    "  if (command === 'git' && args.includes('commit')) {",
    "    writeFileSync(path.join(options.cwd, 'unowned.txt'), 'Concurrent user change\\n');",
    "    const staged = childProcess.spawnSync('git', ['add', '--', 'unowned.txt'], { cwd: options.cwd });",
    "    writeFileSync(path.join(options.cwd, '.data', 'race-stage-status'), String(staged.status));",
    "  }",
    "  return execute(command, args, options);",
    "};",
    "childProcess.execFile = intercepted;",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"));
  const command = nativeCandidateCommand(requestFile, sha256(bytes)).replace(" --input-type=module",
    ` --import '${pathToFileURL(preload).href.replaceAll("'", "''")}' --input-type=module`);
  let failure;
  await assert.rejects(exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd: root, timeout: 30_000 }), (error) => {
    failure = error;
    return error.code === 1;
  });
  const unowned = await readFile(path.join(root, "unowned.txt"), "utf8").catch(() => {
    assert.fail(`The concurrent staging injection did not execute: ${failure.stderr}`);
  });
  assert.equal(unowned, "Concurrent user change\n");
  assert.ok(["0", "128"].includes(await readFile(path.join(directory, "race-stage-status"), "utf8")));
  assert.notEqual((await sourceSnapshot(root)).head, before.source.head, "Exercise the real candidate commit after the concurrent staging attempt.");
  const committed = (await git(root, ["ls-tree", "-r", "--name-only", "HEAD"])).trim().split("\n");
  assert.equal(committed.includes("unowned.txt"), false, "Reject before unowned staged data enters retained history.");
  assert.deepEqual((await git(root, ["diff", "--name-only", before.source.head, "HEAD"])).trim().split("\n"), ["README.md"]);
  const index = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "index"])).trim());
  await assert.rejects(readFile(`${index}.lock`), { code: "ENOENT" });
});

test("failing checks produce a new repair commit and fresh evidence without rewriting the first attempt", async (t) => {
  const { root } = await workspace(t);
  let implementations = 0, verifications = 0, reviews = 0;
  const heads = [];
  const ctx = documentationTask(root, {
    args: { goal: "Task fixture", acceptance: ["Behavior"], maxRepairRounds: 1 },
    agent: async (_prompt, options) => {
      if (options.agent === "devpocket-reviewer") { reviews++; return passingReview; }
      await mkdir(path.join(root, "backend", "tests"), { recursive: true });
      await writeFile(path.join(root, "backend", "tests", "task.test.ts"), `// revision ${++implementations}\n`);
      return implemented(root);
    },
  });
  const result = await runDevelopment(ctx, { root, verify: async (_root, plan) => {
    assert.equal((await inspectWorktree(root)).status, "");
    heads.push(plan.source.head);
    if (++verifications === 1) return { ...plan, group: "all", status: "failed", complete: false,
      checks: plan.requiredChecks.map((id, index) => ({ id, status: index === 0 ? "failed" : "not_run", exitCode: index === 0 ? 1 : null })) };
    return syntheticReport(plan);
  } });
  assert.equal(result.status, "ready");
  assert.equal(reviews, 1, "A failed final check does not dispatch an approval review.");
  assert.equal(result.round, 1);
  assert.notEqual(heads[0], heads[1]);
  assert.equal(result.candidate.parent, heads[0]);
  for (const [round, head] of heads.entries()) {
    const report = JSON.parse(await readFile(path.join(root, ".data", "development", ctx.runId, `verification-${round}.json`), "utf8"));
    assert.equal(report.source.head, head);
    assert.equal(report.status, round ? "passed" : "failed");
  }
});

test("a no-op repair retains the failed candidate instead of repeating acceptance or making an empty commit", async (t) => {
  const { root } = await workspace(t);
  let implementations = 0, verifications = 0;
  const result = await runDevelopment(documentationTask(root, {
    args: { goal: "Task", acceptance: ["Behavior"], maxRepairRounds: 2 },
    agent: async (_prompt, options) => {
      if (options.agent === "devpocket-reviewer") return blockingReview;
      if (!implementations++) await writeFile(path.join(root, "README.md"), "Incomplete\n");
      return implemented(root);
    },
  }), { root, verify: async (...args) => { verifications++; return executeVerification(...args); } });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /no task changes/);
  assert.equal(verifications, 1);
  assert.equal((await git(root, ["rev-list", "--count", `${result.base}..HEAD`])).trim(), "1");
});

test("stale, partial and incomplete verification cannot qualify an otherwise valid non-native candidate", async (t) => {
  const { root } = await workspace(t);
  const result = await runDevelopment(documentationTask(root, {
    agent: async (_prompt, options) => {
      assert.notEqual(options.agent, "devpocket-reviewer", "Invalid verification is never sent for approval.");
      const directory = path.join(root, "backend", "tests");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "fixture.test.ts"), "// fixture\n");
      return implemented(root);
    },
  }), { root, verify: async (_root, plan) => {
    assert.equal(plan.requiredChecks.includes("android-device"), false);
    assert.equal((await validateVerificationEvidence(root, plan, [syntheticReport(plan)], {
      candidateEvidence: true, requireComplete: true,
    })).complete, true);
    for (const [scenario, reason] of [
      ["stale-head", "source-mismatch"], ["partial", "check-failed"], ["missing-check", "shard-missing"],
    ]) {
      await t.test(scenario, async () => {
        const value = syntheticReport(plan);
        if (scenario === "stale-head") value.source = { ...plan.source, head: plan.base };
        if (scenario === "partial") {
          value.status = "partial"; value.complete = false;
          assert.equal((await validateVerificationEvidence(root, plan, [value])).complete, true,
            "Without the complete-report requirement, this otherwise valid partial input must aggregate.");
        }
        if (scenario === "missing-check") value.checks = [];
        await assert.rejects(validateVerificationEvidence(root, plan, [value], {
          candidateEvidence: true, requireComplete: true,
        }), { diagnosticCode: reason });
      });
    }
    return { ...syntheticReport(plan), status: "partial", complete: false };
  } });
  assert.equal(result.status, "blocked");
  assert.notEqual(result.candidate.commit, result.base);
});

test("native verification without device evidence cannot qualify separately from partial-report checks", async (t) => {
  const { root } = await workspace(t), directory = path.join(root, "backend", "src");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "fixture.ts"), "// native-impact fixture\n");
  const plan = await verificationPlan(root, "HEAD");
  assert.ok(plan.requiredChecks.includes("android-device"));
  await assert.rejects(validateVerificationEvidence(root, plan, [syntheticReport(plan)], {
    candidateEvidence: true, requireComplete: true,
  }), { diagnosticCode: "device-evidence" });
});

test("high-risk review and protected policy boundaries remain distinct from committed readiness", isolatedCases, async (t) => {
  await Promise.all(["extension/entry.mjs", "scripts/candidate-commit.mjs", ".github/agents/devpocket-reviewer.agent.md", "AGENTS.md"].map((file) =>
    t.test(file, async (t) => {
      const { root } = await workspace(t), session = nativeSession();
      const policy = file !== "extension/entry.mjs";
      const original = (await sourceSnapshot(root)).head;
      if (policy) session.rpc.tools.execute = async () => { assert.fail("Protected-policy review precedes candidate mutation."); };
      const result = await runDevelopment(documentationTask(root, {
        session,
        agent: async (_prompt, options) => {
          if (options.agent === "devpocket-reviewer") return passingReview;
          await mkdir(path.dirname(path.join(root, file)), { recursive: true });
          await writeFile(path.join(root, file), "Task change\n");
          return implemented(root);
        },
      }), { root, verify: async (_root, plan) => {
        assert.equal(policy, false, "Modified protected policy never executes before authorization.");
        return syntheticReport(plan);
      } });
      assert.equal(result.status, policy ? "needs_human" : "ready");
      assert.equal(result.policyReview.requiresHumanReview, policy);
      assert.deepEqual(result.policyReview.protectedPaths, policy ? [file] : []);
      assert.deepEqual(result.policyReview.source, result.source);
      if (policy) assert.equal((await sourceSnapshot(root)).head, original);
      else {
        assert.notEqual(result.candidate.commit, original);
        assert.equal(result.review.verdict, "pass");
        assert.equal(result.approval, undefined);
        assert.deepEqual(result.policyReview.reviewPaths, [file]);
        assert.equal(Object.hasOwn(result.verification, "requiresHumanReview"), false);
      }
      assert.equal((await checkDevelopmentReadiness(root, result)).status, policy ? "blocked" : "ready");
    })));
});

test("clean-tree and source guards reject edits during final verification or independent review", isolatedCases, async (t) => {
  await Promise.all(["verify", "review"].map((phase) =>
    t.test(phase, async (t) => {
      const { root } = await workspace(t);
      const mutateIndex = async () => {
        const text = await readFile(path.join(root, "README.md"), "utf8");
        await writeFile(path.join(root, "README.md"), "Concurrent staged content\n");
        await git(root, ["add", "--", "README.md"]);
        await writeFile(path.join(root, "README.md"), text);
      };
      const ctx = documentationTask(root);
      const agent = ctx.agent;
      ctx.agent = async (prompt, options) => {
        if (phase === "review" && options.agent === "devpocket-reviewer") await mutateIndex();
        return agent(prompt, options);
      };
      const result = await runDevelopment(ctx, { root, verify: async (...args) => {
        const value = await executeVerification(...args);
        if (phase === "verify") await mutateIndex();
        return value;
      } });
      assert.equal(result.status, "blocked");
      assert.match(result.reason, /changed during/);
      assert.deepEqual(await sourceSnapshot(root), result.candidate.source, "HEAD plus working bytes alone cannot detect the dirty index.");
      assert.notEqual((await inspectWorktree(root)).status, "");
    })));
});

test("readiness rejects later commits, changed branch/index, and legacy or nonready evidence", async (t) => {
  const { root } = await workspace(t);
  const result = await runDevelopment(documentationTask(root), { root });
  assert.equal(result.status, "ready");
  assert.equal((await checkDevelopmentReadiness(root, { ...result, version: 1 })).status, "blocked");
  assert.equal((await checkDevelopmentReadiness(root, { ...result, status: "needs_human" })).status, "blocked");
  await git(root, ["checkout", "--quiet", "-b", "other-task"]);
  assert.equal((await checkDevelopmentReadiness(root, result)).status, "blocked");
  await git(root, ["checkout", "--quiet", "task"]);
  await git(root, ["commit", "--quiet", "--allow-empty", "-m", "New revision with identical bytes"]);
  assert.equal((await sourceSnapshot(root)).fingerprint, result.source.fingerprint);
  assert.equal((await checkDevelopmentReadiness(root, result)).status, "blocked", "Same bytes on a new commit never reuse old readiness.");
});

test("interruption after the local commit never replays a commit or trusts an unjournaled handoff", async (t) => {
  const { root } = await workspace(t), session = nativeSession();
  const original = (await sourceSnapshot(root)).head, execute = session.rpc.tools.execute;
  session.rpc.tools.execute = async (request) => {
    const response = await execute(request);
    assert.equal(response.resultType, "success");
    throw Object.assign(new Error("Fixture lost the runtime connection after commit."), { name: "ConnectionError" });
  };
  const ctx = documentationTask(root, { session });
  await assert.rejects(runDevelopment(ctx, { root }), /lost the runtime connection/);
  const candidate = (await sourceSnapshot(root)).head;
  assert.notEqual(candidate, original);
  const state = JSON.parse(await readFile(path.join(root, ".data", "development", ctx.runId, "state.json"), "utf8"));
  assert.equal(state.stage, "committing");
  ctx.agent = async () => { assert.fail("Interrupted tasks require inspection, not agent replay."); };
  session.rpc.tools.execute = async () => { assert.fail("An uncertain commit must not be repeated."); };
  const recovered = await runDevelopment(ctx, { root });
  assert.equal(recovered.status, "blocked");
  assert.match(recovered.reason, /Interrupted/);
  assert.equal((await sourceSnapshot(root)).head, candidate);
  assert.equal((await git(root, ["rev-list", "--count", `${original}..HEAD`])).trim(), "1");
});

test("existing workflow reports remain immutable and cannot become a new ready handoff", async (t) => {
  const { root } = await workspace(t);
  const report = path.join(root, ".data", "development", "candidate-test", "verification-0.json");
  const ctx = documentationTask(root);
  const agent = ctx.agent;
  ctx.agent = async (prompt, options) => {
    assert.notEqual(options.agent, "devpocket-reviewer", "A report collision requires inspection before review.");
    return agent(prompt, options);
  };
  await assert.rejects(runDevelopment(ctx, { root, verify: async (...args) => {
    const value = await executeVerification(...args);
    await writeFile(report, "Existing retained evidence\n", { flag: "wx" });
    return value;
  } }), { code: "EEXIST" });
  assert.equal(await readFile(report, "utf8"), "Existing retained evidence\n");
  const state = JSON.parse(await readFile(path.join(root, ".data", "development", ctx.runId, "state.json"), "utf8"));
  assert.equal(state.stage, "verifying");
  assert.equal(state.result, undefined);
});

test("task grants allow ordinary CI repairs without approving changed local tools", () => {
  const { scope, policy, hooks } = approvalFixture();
  scope.task = { ...scope.task, mode: "autopilot", prepare: true, delivery: "pull-request" };
  scope.ci = { repository: "owner/repo", ref: scope.workspace.branch };
  const implementation = { version: 2, directory: "approved-controller",
    files: [{ name: "development-policy.mjs", sha256: "5".repeat(64) }] };
  const { request, snapshot } = developmentTaskApprovalRequest(scope, hooks, implementation);
  const receipt = { version: 1, requestId: request.id, origin: "original-client", decision: "approved" };
  assert.match(snapshot, /ordinary disposable runner identity without per-revision project approval/);
  assert.match(snapshot, /ordinary CI, not an adversarial sandbox/);
  for (const action of ["commit", "push", "create-draft-pr", "mark-pr-ready", "ordinary-ci"]) {
    assert.equal(developmentTaskActionAllowed(scope, hooks, implementation, [], action), false);
    assert.equal(developmentTaskActionAllowed(scope, hooks, implementation, [receipt], action), true);
  }
  for (const action of ["merge", "deploy", "local-install", "adopt-policy", "reload", "isolated-execution"]) {
    assert.equal(developmentTaskActionAllowed(scope, hooks, implementation, [receipt], action), false);
  }
  assert.equal(developmentExecutionAuthorization(scope, policy, hooks, implementation, [receipt]).status, "needs_human");
  assert.equal(developmentExecutionAuthorization(scope, policy, hooks, implementation, [], "ci").status, "needs_human");
  const allowed = developmentExecutionAuthorization(scope, policy, hooks, implementation, [receipt], "ci");
  assert.equal(allowed.route, "github-hosted");
  assert.equal(allowed.adoption, "not-authorized");
  const repaired = { ...policy, inputs: policy.inputs.map((input) => ({ ...input, sha256: "6".repeat(64) })) };
  assert.equal(developmentExecutionAuthorization(scope, repaired, hooks, implementation, [receipt], "ci").status, "allowed");
  for (const mutate of [
    (value) => { value.base = "7".repeat(40); },
    (value) => { value.runId = "another-task"; },
    (value) => { value.ci.repository = "owner/another"; },
    (value) => { value.workspace.branch = value.ci.ref = "refs/heads/another"; },
  ]) {
    const changed = structuredClone(scope);
    mutate(changed);
    assert.equal(developmentTaskActionAllowed(changed, hooks, implementation, [receipt], "ordinary-ci"), false);
  }
  const legacy = { ...scope, task: { ...scope.task, execution: { kind: "github-hosted",
    repository: "owner/repo", trustedRef: "refs/heads/main", trustedSha: "4".repeat(40) } } };
  assert.throws(() => developmentTaskApprovalRequest(legacy, hooks, implementation), /retired/);
  assert.throws(() => parseTask(legacy.task), /Unexpected workflow fields/);
  assert.throws(() => developmentExecutionAuthorization(scope, policy, hooks, implementation, [receipt], "unknown"),
    /Choose local execution or ordinary CI explicitly/);
  const localOnly = { ...scope, task: { ...scope.task, delivery: "local-commit" } };
  assert.match(developmentExecutionAuthorization(localOnly, policy, hooks, implementation, [receipt], "ci").reason,
    /explicit PR delivery scope/);
});

test("local-verification PR grants bind ordinary CI authority to the repository and branch", () => {
  const { scope, hooks } = approvalFixture();
  scope.task.delivery = "pull-request";
  scope.ci = { repository: "owner/repo", ref: scope.workspace.branch };
  const implementation = { version: 2, directory: "trusted-controller",
    files: [{ name: "development-policy.mjs", sha256: "5".repeat(64) }] };
  const { request, snapshot } = developmentTaskApprovalRequest(scope, hooks, implementation);
  const receipt = { version: 1, requestId: request.id, origin: "original-client", decision: "approved" };
  assert.deepEqual(request.actions, ["edit", "check", "independent-review", "repair", "commit",
    "push", "create-draft-pr", "mark-pr-ready", "ordinary-ci"]);
  assert.match(snapshot, /automatic repository CI for owner\/repo refs\/heads\/task/);
  assert.doesNotMatch(snapshot, /Use existing local checks only/);
  const question = formatDevelopmentApproval(request, "diagnostic-copy.txt", "", snapshot);
  assert.match(question, /CI target: owner\/repo at refs\/heads\/task/);
  assert.doesNotMatch(question, /ci\.yml only/);
  for (const action of ["push", "create-draft-pr", "mark-pr-ready", "ordinary-ci"]) {
    assert.equal(developmentTaskActionAllowed(scope, hooks, implementation, [receipt], action), true);
    assert.equal(developmentTaskActionAllowed(scope, hooks, implementation, [], action), false);
    for (const target of [{ repository: "owner/another", ref: "refs/heads/task" },
      { repository: "owner/repo", ref: "refs/heads/another" }]) {
      const changed = { ...scope, ci: target, workspace: { ...scope.workspace, branch: target.ref } };
      assert.equal(developmentTaskActionAllowed(changed, hooks, implementation, [receipt], action), false);
    }
  }
  for (const ci of [undefined, null, { repository: "owner/repo", ref: "refs/heads/another" },
    { repository: "../repo", ref: scope.workspace.branch }]) {
    assert.throws(() => developmentTaskApprovalRequest({ ...scope, ci }, hooks, implementation), /CI.*repository and branch/);
  }
  for (const delivery of ["working-tree", "local-commit"]) {
    const local = { ...scope, ci: undefined, task: { ...scope.task, delivery } };
    const localRequest = developmentTaskApprovalRequest(local, hooks, implementation).request;
    assert.deepEqual(localRequest.actions, ["edit", "check", "independent-review", "repair",
      ...(delivery === "local-commit" ? ["commit"] : [])]);
    assert.match(localRequest.effects.join(" "), /Use existing local checks only/);
  }
});

test("autopilot with missing authority returns a retained decision instead of opening a question", async (t) => {
  const { root } = await workspace(t), session = nativeSession();
  session.capabilities = { ui: { elicitation: true } };
  session.ui = { elicitation: async () => { assert.fail("Unattended execution must not ask for missing authority."); } };
  const ctx = durable({ runId: "unprepared", session,
    args: { goal: "Task", acceptance: ["Behavior"], mode: "autopilot" },
    agent: async () => { assert.fail("Missing scope must stop before implementation."); } });
  const result = await runDevelopment(ctx, { root });
  assert.equal(result.status, "needs_human");
  assert.match(result.reason, /No question/);
  const { scope, policy, hooks } = approvalFixture(), request = developmentApprovalRequest(scope, policy, "execution", hooks);
  const details = path.join(root, ".data", "approval.txt");
  await mkdir(path.dirname(details), { recursive: true });
  await writeFile(details, developmentApprovalDetails(scope.base, policy, request.inputs.map((item) => item.path)));
  const missing = await obtainDevelopmentApproval(ctx, request, details, "Candidate execution change");
  assert.equal(missing.status, "needs_human");
  assert.match(missing.reason, /no question/);
});

test("native preparation grants one scope then resumes the same task unattended across repairs and UI loss", async (t) => {
  const { root } = await workspace(t), session = nativeSession();
  let questions = 0, paused = false, implementations = 0, reviews = 0;
  session.capabilities = { ui: { elicitation: true } };
  session.ui = { elicitation: async (input) => {
    questions++;
    assert.match(input.message, /Authorize this task's unattended development and delivery scope/);
    assert.match(input.message, /No merge, deployment/);
    return { action: "accept", content: { decision: "approve" } };
  } };
  const ctx = durable({
    runId: "prepared-unattended", session,
    args: { goal: "Explain behavior", acceptance: ["Complete explanation"], mode: "autopilot", prepare: true },
    pause: async (key) => {
      assert.equal(key, "devpocket-authorized-task-v1");
      if (!paused) { paused = true; throw Object.assign(new Error("Prepared and paused"), { name: "AbortError" }); }
    },
    agent: async (prompt, options) => {
      if (options.agent === "devpocket-reviewer") return ++reviews === 1 ? blockingReview : passingReview;
      assert.match(prompt, /Do not ask questions or approve permissions/);
      assert.ok(prompt.includes(JSON.stringify(path.join((await captureCandidateImplementation()).directory, "git-state.mjs"))));
      assert.doesNotMatch(prompt, /sourceSnapshot\(root\) exported by scripts\/verification\.mjs/);
      await writeFile(path.join(root, "README.md"), `Complete explanation ${++implementations}\n`);
      return implemented(root);
    },
  });
  await assert.rejects(runDevelopment(ctx, { root }), { name: "AbortError" });
  assert.equal(implementations, 0);
  assert.equal(questions, 1);
  session.capabilities.ui.elicitation = false;
  delete session.ui;
  const result = await runDevelopment(ctx, { root });
  assert.equal(result.status, "ready", result.reason);
  assert.equal(questions, 1);
  assert.equal(implementations, 2);
  assert.equal(reviews, 2);
  assert.deepEqual(result.authorizedDeliveryActions, []);
  assert.equal((await checkDevelopmentReadiness(root, result)).status, "ready");
});

test("changed baseline after preparation cannot consume a stale task grant", async (t) => {
  const { root } = await workspace(t), session = nativeSession();
  let paused = false, questions = 0;
  session.capabilities = { ui: { elicitation: true } };
  session.ui = { elicitation: async () => {
    questions++;
    return { action: "accept", content: { decision: "approve" } };
  } };
  const ctx = durable({ runId: "changed-preparation", session,
    args: { goal: "Task", acceptance: ["Behavior"], mode: "autopilot", prepare: true },
    pause: async () => { if (!paused) { paused = true; throw new Error("Prepared pause"); } },
    agent: async () => { assert.fail("A changed preparation baseline is not authorized."); },
  });
  await assert.rejects(runDevelopment(ctx, { root }), /Prepared pause/);
  await writeFile(path.join(root, "README.md"), "Concurrent work\n");
  const result = await runDevelopment(ctx, { root });
  assert.equal(result.status, "blocked");
  assert.equal(questions, 1);
  assert.match(result.reason, /baseline changed/);
});

test("starter propagates explicit autopilot selection without inventing publication authority", async (t) => {
  const { main } = await workspace(t), fixture = await registeredStarter(main);
  const args = { goal: "Task", acceptance: ["Behavior"], mode: "autopilot", prepare: true, delivery: "pull-request" };
  await fixture.start(args);
  const kickoff = fixture.calls[0].arguments.kickoff;
  assert.equal(kickoff.mode, "autopilot");
  assert.match(kickoff.prompt, /autopilot does not grant missing authority/);
  assert.match(kickoff.prompt, /"prepare":true/);
});

test("frozen controller continues to use approved code while candidate tools change", async (t) => {
  const { root } = await workspace(t);
  const original = await captureCandidateImplementation();
  await mkdir(path.join(root, "scripts"));
  for (const file of original.files) {
    await mkdir(path.dirname(path.join(root, "scripts", file.name)), { recursive: true });
    await writeFile(path.join(root, "scripts", file.name), await readFile(path.join(original.directory, file.name)));
  }
  const { freezeDevelopmentController } = await import("../development-controller.mjs");
  const frozen = await freezeDevelopmentController(root);
  await writeFile(path.join(root, "scripts", "development-policy.mjs"), "throw new Error('Candidate policy must not be adopted');\n");
  await requireCandidateImplementation(frozen.implementation);
  const control = await import(pathToFileURL(path.join(frozen.directory, "development-policy.mjs")).href);
  assert.equal(control.developmentReviewRequirements(["backend/src/runtime.ts"]).requiresHumanReview, false);
  const protectedFile = path.join(frozen.directory, "development-policy.mjs");
  await fs.chmod(protectedFile, 0o600);
  await writeFile(protectedFile, "// altered trusted snapshot\n");
  await assert.rejects(requireCandidateImplementation(frozen.implementation), /changed/);
});

function syntheticTaskGrant(scope, hooks, implementation) {
  const { request } = developmentTaskApprovalRequest(scope, hooks, implementation);
  return [{ version: 1, requestId: request.id, origin: "original-client", decision: "approved" }];
}

test("publication scope checks the actual origin and every effective push destination", async (t) => {
  const { root } = await workspace(t);
  await git(root, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  assert.equal(await originRepository(root), "owner/repo");
  assert.equal(await requirePushTarget(root, "owner/repo"), "https://github.com/owner/repo.git");
  await git(root, ["config", "remote.origin.pushurl", "https://github.com/other/repo.git"]);
  await assert.rejects(requirePushTarget(root, "owner/repo"), /single authorized GitHub repository/);
  await git(root, ["config", "--unset-all", "remote.origin.pushurl"]);
  await git(root, ["config", "--add", "remote.origin.pushurl", "https://github.com/owner/repo.git"]);
  await git(root, ["config", "--add", "remote.origin.pushurl", "https://github.com/other/repo.git"]);
  await assert.rejects(requirePushTarget(root, "owner/repo"), /single authorized GitHub repository/);
});

test("prepared delivery readiness requires ordinary CI authority and rejects a changed publication target", isolatedCases, async (t) => {
  await Promise.all(["remote.origin.url", "remote.origin.pushurl"].map((key) => t.test(key, async (t) => {
    const { root } = await workspace(t), session = nativeSession();
    await git(root, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
    session.capabilities = { ui: { elicitation: true } };
    session.ui = { elicitation: async ({ message }) => {
      assert.match(message, /automatic repository CI for owner\/repo refs\/heads\/task/);
      assert.match(message, /ordinary disposable runner identity/);
      return { action: "accept", content: { decision: "approve" } };
    } };
    const ctx = documentationTask(root, {
      session, args: { goal: "Explain behavior", acceptance: ["Document the behavior"], prepare: true,
        mode: "autopilot", delivery: "pull-request" },
      pause: async () => {},
    });
    const result = await runDevelopment(ctx, { root });
    assert.equal(result.status, "ready", result.reason);
    assert.deepEqual(result.authorization.scope.ci, { repository: "owner/repo", ref: "refs/heads/task" });
    assert.deepEqual(result.authorizedDeliveryActions, ["push", "create-draft-pr", "mark-pr-ready", "ordinary-ci"]);
    for (const mutate of [
      (value) => { value.authorization.receipts = []; },
      (value) => {
        value.authorization.scope.ci.repository = "owner/another";
        value.authorization.receipts = syntheticTaskGrant(value.authorization.scope, value.hooks, value.execution);
      },
    ]) {
      const changed = structuredClone(result);
      mutate(changed);
      assert.equal((await checkDevelopmentReadiness(root, changed)).status, "blocked");
    }
    await git(root, ["config", key, "https://github.com/another/repo.git"]);
    assert.equal((await checkDevelopmentReadiness(root, result)).status, "blocked",
      "A native grant must not follow a changed publication destination.");
  })));
});

test("prepared PR authority rejects A-to-B-to-A target discovery and approval races", async (t) => {
  for (const phase of ["discovery", "approval"]) await t.test(phase, async (t) => {
    const { root } = await workspace(t), session = nativeSession();
    const origin = "https://github.com/owner/repo.git", temporary = "https://github.com/owner/another.git";
    await git(root, ["remote", "add", "origin", origin]);
    const before = await inspectWorktree(root), original = childProcess.execFile;
    let changed = false, restored = false, questions = 0;
    const restore = async () => {
      await git(root, ["config", "remote.origin.url", origin]);
      restored = true;
    };
    const intercepted = (...args) => original(...args);
    intercepted[promisify.custom] = async (file, args, options) => {
      const relevant = file === "git" && options?.cwd === root;
      if (relevant && !changed && args.slice(-3).join(" ") === "remote get-url origin") {
        await git(root, ["config", "remote.origin.url", temporary]);
        changed = true;
      }
      const result = await exec(file, args, options);
      if (relevant && changed && !restored && phase === "discovery" && args.includes("--push")) await restore();
      return result;
    };
    childProcess.execFile = intercepted;
    syncBuiltinESMExports();
    try {
      const { controller } = await copiedController(root);
      session.capabilities = { ui: { elicitation: true } };
      session.ui = { elicitation: async ({ message }) => {
        questions++;
        assert.match(message, /automatic repository CI for owner\/another refs\/heads\/task/);
        await restore();
        return { action: "accept", content: { decision: "approve" } };
      } };
      const ctx = documentationTask(root, {
        session, args: { goal: "Explain behavior", acceptance: ["Document the behavior"],
          prepare: true, mode: "autopilot", delivery: "pull-request" },
        pause: async () => {},
        agent: async () => { assert.fail("A mismatched publication grant must stop before implementation."); },
      });
      const result = await controller.runDevelopment(ctx, { root });
      assert.equal(result.status, "blocked", result.reason);
      assert.match(result.reason, /publication destination/i);
      assert.equal(questions, phase === "approval" ? 1 : 0);
      assert.equal(changed && restored, true);
      assert.deepEqual(await inspectWorktree(root), before, "Restoring A defeats configuration-hash-only checks.");
    } finally {
      childProcess.execFile = original;
      syncBuiltinESMExports();
      await restore();
    }
  });
});
