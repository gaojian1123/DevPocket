import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function workspace(t) {
  await mkdir(".data/tests", { recursive: true });
  const home = await mkdtemp(path.resolve(".data/tests/development-"));
  const main = path.join(home, "main"), root = path.join(home, "task");
  await mkdir(main);
  await exec("git", ["init", "--quiet", main]);
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

test("extension registration is inert and its explicit start tool uses the App's isolated worktree path", async () => {
  const { registerDevelopmentExtension, requireReadonlyReviewer } = await import("../workflow-extension.mjs");
  let registration, dispatched;
  const root = path.resolve(".");
  const session = { rpc: {
    tools: {
      getCurrentMetadata: async () => ({ tools: [{ name: "create_session" }] }),
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

test("workflow registration can load in a fresh worktree before npm dependencies are restored", async () => {
  const entry = new URL("../workflow-extension.mjs", import.meta.url).href;
  const script = [
    "import {registerHooks} from 'node:module';",
    "registerHooks({resolve(specifier,context,next){",
    "if(!specifier.startsWith('node:')&&!specifier.startsWith('.')&&!specifier.startsWith('file:'))",
    "throw new Error('Repository dependency required before workflow registration: '+specifier);",
    "return next(specifier,context);}});",
    `await import(${JSON.stringify(entry)});`,
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
