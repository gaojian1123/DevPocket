import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { checkDevelopmentReadiness, runDevelopment } from "../development-workflow.mjs";
import { changedPaths, inspectWorktree } from "../candidate-commit.mjs";
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

function durable(ctx) {
  const journal = new Map();
  return { session: nativeSession(), phase() {}, log() {}, ...ctx, step: async (key, producer) => {
    assert.equal(key, "devpocket-development-v2", "Old uncommitted journals must not be replayed as candidate evidence.");
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
  assert.deepEqual(registration.workflows[0].meta.phases.map((phase) => phase.title), ["Implement", "Candidate", "Verify", "Review"]);
  assert.match(registration.workflows[0].meta.description, /local candidate commit.*permission/);
  assert.equal(registration.workflows[0].meta.limits, undefined, "AI credit limits are chosen at invocation, not guessed.");
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
          return implemented(root, "Changed the gate.");
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
