import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);

test("repository routing discovers the development skill without requiring workflow activation", async () => {
  const [agents, skill, readme, issue, guide] = await Promise.all([
    "../../AGENTS.md", "../../.github/skills/devpocket-development/SKILL.md",
    "../../README.md", "../../.github/ISSUE_TEMPLATE/ai-task.yml", "../../docs/DEVELOPMENT-WORKFLOW.md",
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
  return { ...ctx, step: async (key, producer) => {
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

test("a development run actually dispatches an independent reviewer and rechecks repaired source", async (t) => {
  const { runDevelopment } = await import("../development-workflow.mjs");
  const { root } = await workspace(t);
  const calls = [];
  let reviews = 0, edits = 0;
  const ctx = durable({
    runId: "repair-proof",
    args: { goal: "Improve the documentation", acceptance: ["Explain the behavior"], nonGoals: [], maxRepairRounds: 2 },
    phase() {}, log() {},
    agent: async (_prompt, options) => {
      calls.push(options.agent);
      if (options.agent === "devpocket-reviewer") {
        reviews++;
        return {
          verdict: reviews === 1 ? "changes_requested" : "pass",
          findings: reviews === 1 ? [{ severity: "blocking", file: "README.md", line: 1,
            impact: "The acceptance criterion is missing.", reproduction: "Read the first paragraph." }] : [],
        };
      }
      edits++;
      await writeFile(path.join(root, "README.md"), `Explained behavior, revision ${edits}\n`);
      return { status: "implemented", summary: "Updated the documentation." };
    },
  });
  const result = await runDevelopment(ctx, { root });
  assert.equal(result.status, "ready");
  assert.deepEqual(calls, ["general-purpose", "devpocket-reviewer", "general-purpose", "devpocket-reviewer"]);
  assert.equal(result.round, 1);
  assert.equal(result.verification.complete, true);
  assert.equal(result.review.source.fingerprint, result.verification.source.fingerprint);
  const again = await runDevelopment(ctx, { root });
  assert.equal(again.status, "ready");
  assert.equal(calls.length, 4, "An unchanged completed run is not executed twice.");
  await writeFile(path.join(root, "README.md"), "Changed after review\n");
  const stale = await runDevelopment(ctx, { root });
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
      return { status: "implemented", summary: "Changed" };
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
    "assert.equal(registration.tools.length,1);",
    "assert.equal(registration.tools[0].name,'devpocket_start_development');",
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
          return { status: "implemented", summary: "Changed the gate." };
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
  for (const file of ["AGENTS.md", "scripts/workflow-extension.mjs", "scripts/tests/development-workflow.test.mjs",
    "scripts/development-workflow.mjs", "scripts/development-policy.mjs", "scripts/candidate-commit.mjs",
    "scripts/native-candidate.mjs", "scripts/git-state.mjs", "scripts/verification.mjs", "scripts/verification-policy.mjs",
    "scripts/verify.mjs", "scripts/verify.ps1", "scripts/tests/verification.test.mjs",
    ".github/agents/devpocket-reviewer.agent.md", ".github/skills/devpocket-development/SKILL.md"]) {
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
          return { status: "implemented", summary: "Changed routing policy." };
        },
      }), { root, verify: async () => { assert.fail("Tooling-only impact cannot authorize modified policy."); } });
      assert.equal(result.status, "needs_human");
      assert.equal(calls, 1);
      const plan = await verificationPlan(root, "HEAD");
      assert.deepEqual(plan.requiredChecks, ["workflow-tests"]);
      assert.deepEqual(plan.requiredGroups, ["tooling"]);
      assert.equal(Object.hasOwn(plan, "requiresHumanReview"), false);
      assert.deepEqual(result.policyReview, {
        requiresHumanReview: true, protectedPaths: [file], source: plan.source,
      });
      assert.equal(result.verification, undefined);
      assert.equal(result.review, undefined);
    });
  }
});

test("local review requirements preserve trust boundaries independently of impact rules", async () => {
  const { developmentReviewRequirements } = await import("../development-policy.mjs");
  for (const [file, requiresHumanReview, protectedPath] of [
    ["README.md", false, false], ["VALIDATION.md", false, false], ["docs/policy.md", false, false],
    ["AGENTS.md", true, true], ["scripts/development-workflow.mjs", true, true],
    ["scripts/development-policy.mjs", true, true], ["scripts/candidate-commit.mjs", true, true],
    ["scripts/tests/development-workflow.test.mjs", true, true],
    [".github/agents/devpocket-reviewer.agent.md", true, true],
    [".github/skills/devpocket-development/SKILL.md", true, true],
    ["scripts/verification.mjs", true, true], ["scripts/verification-policy.mjs", true, true],
    ["scripts/verify.mjs", true, true], [".github/workflows/ci.yml", true, true],
    ["package-lock.json", true, true], [".NPMRC", true, true], ["backend/tsconfig.json", true, true],
    ["deployment/azure/probe/requirements-test.txt", true, true],
    ["android/gradlew.bat", true, true], ["android/app/build.gradle.kts", true, true],
    ["android/app/src/main/java/dev/devpocket/app/ui/Screen.kt", false, false],
    ["android/app/src/main/java/dev/devpocket/app/data/Store.kt", true, false],
    ["android/app/src/main/AndroidManifest.xml", true, false],
    ["backend/tests/fixture.test.ts", false, false], ["backend/integration/fixture.ts", false, false],
    ["backend/src/runtime.ts", true, false], ["extension/entry.mjs", true, false],
    ["deployment/setup.ps1", true, false], ["infra/main.bicep", true, false], ["azure.yaml", true, false],
    ["protocol.schema.json", true, false], ["test-fixtures/fixture.json", true, false],
    ["unclassified.txt", true, false],
  ]) assert.deepEqual(developmentReviewRequirements([file]), {
    requiresHumanReview, protectedPaths: protectedPath ? [file] : [],
  }, file);
  assert.deepEqual(developmentReviewRequirements([]), { requiresHumanReview: false, protectedPaths: [] });
  assert.deepEqual(developmentReviewRequirements(["README.md", "scripts/candidate-commit.mjs", "AGENTS.md", "AGENTS.md"]), {
    requiresHumanReview: true, protectedPaths: ["AGENTS.md", "scripts/candidate-commit.mjs"],
  });
  for (const invalid of [undefined, null, {}, "README.md", [null], [""]]) {
    assert.throws(() => developmentReviewRequirements(invalid), /actual changed-path list/);
  }
});

test("post-review controller handoff uses local requirements even when verification carries a contrary review flag", async (t) => {
  const { runDevelopment } = await import("../development-workflow.mjs");
  for (const [file, requiresHumanReview] of [["backend/tests/fixture.test.ts", false], ["extension/entry.mjs", true]]) {
    await t.test(file, async (t) => {
      const { root } = await workspace(t), calls = [];
      let executions = 0;
      const result = await runDevelopment(durable({
        runId: "local-review", args: { goal: "Task", acceptance: ["Behavior"] }, phase() {}, log() {},
        agent: async (_prompt, options) => {
          calls.push(options.agent);
          if (options.agent === "devpocket-reviewer") return { verdict: "pass", findings: [] };
          await mkdir(path.dirname(path.join(root, file)), { recursive: true });
          await writeFile(path.join(root, file), "// fixture\n");
          return { status: "implemented", summary: "Changed source." };
        },
      }), { root, verify: async (_root, plan) => {
        executions++;
        assert.equal(Object.hasOwn(plan, "requiresHumanReview"), false);
        assert.deepEqual(plan.requiredGroups, ["tooling", "backend"]);
        return { ...plan, status: "passed", complete: true, group: "all", requiresHumanReview: !requiresHumanReview,
          checks: plan.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0 })) };
      } });
      assert.equal(executions, 1);
      assert.deepEqual(calls, ["general-purpose", "devpocket-reviewer"]);
      assert.equal(result.status, requiresHumanReview ? "needs_human" : "ready");
      assert.deepEqual(result.policyReview, { requiresHumanReview, protectedPaths: [], source: result.source });
      assert.equal(result.verification.complete, true);
      assert.equal(result.review.verdict, "pass");
      assert.deepEqual(result.review.source, result.policyReview.source);
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
          return { status: "implemented", summary: "Changed a policy input." };
        },
      }), { root, verify: async () => { assert.fail("The replacement policy must not execute."); } });
      assert.equal(result.status, "needs_human");
    });
  }
});
