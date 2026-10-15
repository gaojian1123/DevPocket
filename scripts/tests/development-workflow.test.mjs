import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { checkDevelopmentReadiness, runDevelopment } from "../development-workflow.mjs";
import { changedPaths, inspectWorktree, prepareCandidate, sha256 } from "../candidate-commit.mjs";
import { executeVerification, git, sourceSnapshot } from "../verification.mjs";

const exec = promisify(execFile);

function nativeSession() {
  return { sessionId: "fixture-session", rpc: { tools: {
    getCurrentMetadata: async () => ({ tools: [{ name: "functions.powershell" }] }),
    execute: async (request) => {
      assert.equal(request.name, "functions.powershell");
      assert.equal(request.arguments.mode, "sync");
      assert.match(request.arguments.command, /candidate-commit\.mjs' --request /);
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
  assert.match(skill, /--no-optional-locks status --porcelain --untracked-files=all --ignore-submodules=none/);
  assert.match(skill, /Continue an existing task in its own worktree/);
  assert.match(skill, /npm run verify -- -Base BASE_COMMIT/);
  assert.match(skill, /read\/search-only `devpocket-reviewer` in a separate context/);
  assert.match(skill, /--combine/);
  assert.match(skill, /source identity matches the review/);
  assert.match(skill, /requiresHumanReview/);
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
  assert.match(verification, /`source.head` to equal `CANDIDATE_COMMIT`/);
  assert.match(repair, /new authorized follow-up commit/);
  assert.match(repair, /amend only if the user explicitly requests it/);
  assert.match(repair, /HEAD to remain `CANDIDATE_COMMIT` before publishing/);
  assert.match(handoff, /Pending human policy review still blocks publication/);
  assert.match(handoff, /An unchanged push does not invalidate local source evidence/);
  assert.match(handoff, /Required remote CI and checks of a/);
});

function durable(ctx) {
  const journal = new Map();
  return { session: nativeSession(), phase() {}, log() {}, ...ctx, step: async (key, producer) => {
    assert.equal(key, "devpocket-development-v2", "Old uncommitted journals must not be replayed as candidate evidence.");
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
  const report = await executeVerification(root, plan, { directory: path.join(root, ".data", "candidate") });
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
  assert.equal(again.status, "ready");
  assert.equal(calls.length, 4, "An unchanged completed run is not executed twice.");
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
  const stale = await runDevelopment(ctx, { root, verify });
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

test("starter blocks dirty checkouts without dropping unresolved task dependencies", async (t) => {
  for (const checkout of ["primary", "linked"]) {
    for (const change of ["staged", "unstaged", "untracked"]) {
      await t.test(`${checkout}: ${change}`, async (t) => {
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
      });
    }
  }
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
    arguments: { name: "devpocket-development", args: { goal: "Task", acceptance: ["Behavior"], nonGoals: [], maxRepairRounds: 2 } },
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
  assert.deepEqual(registration.workflows[0].meta.phases.map((phase) => phase.title), ["Implement", "Candidate", "Verify", "Review"]);
  assert.match(registration.workflows[0].meta.description, /local candidate commit.*permission/);
  assert.match(registration.workflows[0].meta.description, /only when the user explicitly selects this workflow/);
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
  assert.match(dispatched.arguments.kickoff.prompt, /Do not independently commit, push, create a PR/);
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

test("gate changes and missing agent results stop rather than granting self-approval", async (t) => {
  const { runDevelopment } = await import("../development-workflow.mjs");
  for (const scenario of ["policy", "missing-result"]) {
    await t.test(scenario, async (t) => {
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
    });
  }
});

test("tooling-only impact retains the controller's protected-policy stop before any execution or review", async (t) => {
  const { runDevelopment } = await import("../development-workflow.mjs");
  const { verificationPlan } = await import("../verification.mjs");
  for (const file of ["AGENTS.md", "scripts/workflow-extension.mjs", "scripts/tests/development-workflow.test.mjs"]) {
    await t.test(file, async (t) => {
      const { root } = await workspace(t);
      let calls = 0;
      const result = await runDevelopment(durable({
        runId: "tooling-protection", args: { goal: "Task", acceptance: ["Behavior"] }, phase() {}, log() {},
        agent: async (_prompt, options) => {
          calls++;
          assert.equal(options.agent, "general-purpose");
          await mkdir(path.dirname(path.join(root, file)), { recursive: true });
          await writeFile(path.join(root, file), "// fixture\n");
          return implemented(root, "Changed routing policy.");
        },
      }), { root, verify: async () => { assert.fail("Tooling-only impact cannot authorize modified policy."); } });
      assert.equal(result.status, "needs_human");
      assert.equal(calls, 1);
      const plan = await verificationPlan(root, "HEAD");
      assert.deepEqual(plan.requiredChecks, ["workflow-tests"]);
      assert.deepEqual(plan.requiredGroups, ["tooling"]);
      assert.equal(plan.requiresHumanReview, true);
    });
  }
});

test("skill, compiler, Gradle launcher and nested dependency policy require review before execution", async (t) => {
  const { runDevelopment } = await import("../development-workflow.mjs");
  for (const file of [".github/skills/devpocket-development/SKILL.md", ".npmrc", ".NPMRC", "backend/tsconfig.json", "android/gradlew.bat",
    "android/gradle/wrapper/gradle-wrapper.properties", "deployment/azure/package.json"]) {
    await t.test(file, async (t) => {
      const { root } = await workspace(t);
      const result = await runDevelopment(durable({
        runId: "policy-input", args: { goal: "Task", acceptance: ["Behavior"] }, phase() {}, log() {},
        agent: async () => {
          await mkdir(path.dirname(path.join(root, file)), { recursive: true });
          await writeFile(path.join(root, file), "{}\n");
          return implemented(root, "Changed a policy input.");
        },
      }), { root, verify: async () => { assert.fail("The replacement policy must not execute."); } });
      assert.equal(result.status, "needs_human");
    });
  }
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
    checks: plan.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0 })) };
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

test("commit permission, native-tool and hook failures never reach final verification", async (t) => {
  for (const scenario of ["denied", "missing-tool", "missing-pipeline", "missing-session", "missing-receipt",
    "hook-error", "hook-post-commit-error", "hook-post-index-error", "hook-mutates", "hook-removes-trailer"]) {
    await t.test(scenario, async (t) => {
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
      if (["hook-post-commit-error", "hook-mutates", "hook-removes-trailer"].includes(scenario)) {
        assert.notEqual(current.source.head, parent, "A failed candidate remains history; it is never reset/amended.");
      } else assert.equal(current.source.head, parent);
      if (scenario === "hook-error") {
        assert.match(await git(root, ["diff", "--cached", "--name-only"]), /README.md/, "Failed staging is preserved for inspection.");
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
    });
  }
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

test("unavailable hook-exit evidence blocks a completed commit without replaying it", async (t) => {
  for (const body of [': > "$GIT_TRACE2_EVENT"', 'echo invalid-json >> "$GIT_TRACE2_EVENT"']) {
    await t.test(body, async (t) => {
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
    });
  }
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

test("unowned or post-inspection changes and implementer history/index changes stop before committing", async (t) => {
  for (const scenario of ["unowned", "source", "index", "history", "branch", "configuration"]) {
    await t.test(scenario, async (t) => {
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
    });
  }
});

test("the native candidate boundary rejects concurrent changes instead of committing new content", async (t) => {
  for (const scenario of ["source", "index", "history", "branch", "request", "existing-receipt"]) {
    await t.test(scenario, async (t) => {
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
    });
  }
});

test("staging after final inspection never commits an unowned file", async (t) => {
  const { root } = await workspace(t);
  const before = await inspectWorktree(root);
  await writeFile(path.join(root, "README.md"), "Inspected task change\n");
  const { request } = await prepareCandidate(root, before, await sourceSnapshot(root),
    ["README.md"], "fixture-session", "Commit the inspected task");
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
  const entry = fileURLToPath(new URL("../candidate-commit.mjs", import.meta.url));
  let failure;
  await assert.rejects(exec(process.execPath, ["--import", pathToFileURL(preload).href, entry,
    "--request", requestFile, "--sha256", sha256(bytes)], { cwd: root, timeout: 30_000 }), (error) => {
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

test("stale, partial, incomplete and missing-native verification cannot qualify a committed candidate", async (t) => {
  for (const scenario of ["stale-head", "partial", "missing-check", "missing-native"]) {
    await t.test(scenario, async (t) => {
      const { root } = await workspace(t);
      const result = await runDevelopment(documentationTask(root, {
        agent: async (_prompt, options) => {
          assert.notEqual(options.agent, "devpocket-reviewer", "Invalid verification is never sent for approval.");
          const directory = path.join(root, "backend", scenario === "missing-native" ? "src" : "tests");
          await mkdir(directory, { recursive: true });
          await writeFile(path.join(directory, "fixture.ts"), "// fixture\n");
          return implemented(root);
        },
      }), { root, verify: async (_root, plan) => {
        const value = syntheticReport(plan);
        if (scenario === "stale-head") value.source = { ...plan.source, head: plan.base };
        if (scenario === "partial") { value.status = "partial"; value.complete = false; }
        if (scenario === "missing-check") value.checks = [];
        return value;
      } });
      assert.equal(result.status, "blocked");
      assert.notEqual(result.candidate.commit, result.base);
    });
  }
});

test("high-risk review and protected policy boundaries remain distinct from committed readiness", async (t) => {
  for (const file of ["deployment/change.txt", "scripts/candidate-commit.mjs", ".github/agents/devpocket-reviewer.agent.md", "AGENTS.md"]) {
    await t.test(file, async (t) => {
      const { root } = await workspace(t), session = nativeSession();
      const policy = file !== "deployment/change.txt";
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
      assert.equal(result.status, "needs_human");
      if (policy) assert.equal((await sourceSnapshot(root)).head, original);
      else {
        assert.notEqual(result.candidate.commit, original);
        assert.equal(result.review.verdict, "pass");
        assert.match(result.reason, /High-risk/);
      }
      assert.equal((await checkDevelopmentReadiness(root, result)).status, "blocked");
    });
  }
});

test("clean-tree and source guards reject edits during final verification or independent review", async (t) => {
  for (const phase of ["verify", "review"]) {
    await t.test(phase, async (t) => {
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
    });
  }
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
