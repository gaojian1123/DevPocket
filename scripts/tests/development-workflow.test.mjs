import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);

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
  assert.equal(registration.workflows[0].meta.limits, undefined, "AI credit limits are chosen at invocation, not guessed.");
  await registration.tools[0].handler({ goal: "Task", acceptance: ["Behavior"] });
  assert.equal(dispatched.name, "create_session");
  assert.equal(dispatched.arguments.workspace_type, "worktree");
  assert.equal(dispatched.arguments.base_branch, undefined);
  assert.match(dispatched.arguments.kickoff.prompt, /run_dynamic_workflow/);
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

test("compiler, Gradle launcher and nested dependency policy require review before execution", async (t) => {
  const { runDevelopment } = await import("../development-workflow.mjs");
  for (const file of [".npmrc", ".NPMRC", "backend/tsconfig.json", "android/gradlew.bat",
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
