import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { assertCandidate, changedPaths, inspectWorktree, prepareCandidate, sha256, validateCandidateCommit,
  validateCandidateReceiptProof, activeHookSnapshot } from "../candidate-commit.mjs";
import { executeVerification, git, sourceSnapshot, verificationPlan } from "../verification.mjs";
import { captureCandidateImplementation, nativeCandidateCommand, requireCandidateImplementation } from "../native-candidate.mjs";
import { developmentApprovalDetails, developmentReviewRequirements, inspectDevelopmentPolicy,
  isVerificationPolicyPath } from "../development-policy.mjs";
import { originRepository, requirePushTarget } from "../git-state.mjs";

const exec = promisify(execFile);
const verificationInputs = ["verification-executor.mjs", "verification-backend.mjs",
  "verification-android.mjs", "backend-diagnostics.mjs", "verification-preflight.mjs", "verification-run.mjs",
  "verification-transition.mjs", "test-tooling.mjs", "verification-tooling.mjs",
  "verification-admission.mjs", "verification-ci.mjs", "verification-ci-artifact.ps1", "development-paths.mjs",
  "owned-command-darwin.py", "local-ipc.mjs", "android-platform.mjs", "emulator-resources.mjs"];
// Top-level tests stay serial; only fresh-workspace cases without shared environment writes use this limit.
const isolatedCases = { concurrency: 2 };

async function copiedImplementation(root, beforeLoad, directory = path.join(root, ".data", "implementation")) {
  const inputs = await captureCandidateImplementation();
  await mkdir(directory, { recursive: true });
  for (const input of inputs.files) {
    const bytes = await readFile(path.join(inputs.directory, input.name));
    assert.equal(sha256(bytes), input.sha256);
    await mkdir(path.dirname(path.join(directory, input.name)), { recursive: true });
    await writeFile(path.join(directory, input.name), bytes, { flag: "wx" });
  }
  await beforeLoad?.(directory);
  return { directory };
}

async function prepareFixtureCandidate(root, {
  edit = () => writeFile(path.join(root, "README.md"), "Explained\n"), implementation,
} = {}) {
  const before = await inspectWorktree(root);
  await edit();
  const source = await sourceSnapshot(root);
  const { request } = await prepareCandidate(root, before, source, await changedPaths(root, before.source.head),
    "fixture-session", "Explain behavior", undefined, implementation ?? await captureCandidateImplementation());
  assert.ok(request);
  const file = path.join(root, ".data", "candidate.json"), bytes = JSON.stringify(request) + "\n";
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: "wx" });
  return { root, before, request, file, hash: sha256(bytes) };
}

async function runFixtureCandidate(prepared, env = process.env) {
  let failure;
  try {
    await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", nativeCandidateCommand(prepared.file, prepared.hash)],
      { cwd: prepared.root, env, timeout: 180_000 });
  } catch (error) {
    if (![1, 78].includes(error.code)) throw error;
    failure = error;
  }
  const receipt = JSON.parse(await readFile(`${prepared.file}.result.json`, "utf8"));
  if (!failure) {
    assert.equal(receipt.status, "committed");
    await validateCandidateCommit(prepared.root, prepared.request, receipt.candidate);
  }
  return { ...receipt, nativeExitCode: failure?.code ?? 0, stderr: failure?.stderr ?? "" };
}

test("repository development uses the skill and shared tools", async () => {
  const [agents, skill, readme, issue, guide, reviewer] = await Promise.all([
    "../../AGENTS.md", "../../.github/skills/devpocket-development/SKILL.md",
    "../../README.md", "../../.github/ISSUE_TEMPLATE/ai-task.yml", "../../docs/DEVELOPMENT-WORKFLOW.md",
    "../../.github/agents/devpocket-reviewer.agent.md",
  ].map((file) => readFile(new URL(file, import.meta.url), "utf8")));
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill)?.[1];
  assert.ok(frontmatter);
  assert.match(frontmatter, /^name: devpocket-development$/m);
  assert.match(frontmatter, /^description: .+features and bug fixes/m);
  assert.doesNotMatch(frontmatter, /disable-model-invocation:\s*true/);
  assert.match(agents, /`devpocket-development` skill by default/);
  assert.ok(agents.includes(".github\\skills\\devpocket-development\\SKILL.md"));
  assert.match(agents, /otherwise read that file directly/);
  assert.match(skill, /clean linked worktree, implement in the current session/);
  assert.match(skill, /--no-optional-locks -c core\.fsmonitor=false status --porcelain --untracked-files=all --ignore-submodules=none/);
  assert.match(skill, /Continue an existing task in its own worktree/);
  assert.match(skill, /npm run verify -- -Base BASE_COMMIT/);
  assert.match(skill, /read\/search-only `devpocket-reviewer` in a separate context/);
  assert.match(skill, /source identity matches the review/);
  assert.match(skill, /developmentReviewRequirements/);
  assert.match(skill, /CI reports do not supply/);
  assert.match(agents, /within the worktree without another project approval/);
  assert.match(skill, /\[Workspace-local prerequisites\]/);
  assert.match(skill, /concise behavior summary/);
  assert.match(guide, /### Workspace-local prerequisites/);
  assert.match(guide, /This setup scope does not approve changed\s+dependency\/build inputs/);
  assert.match(guide, /Viewing details grants no authority/);
  assert.match(skill, /Stating the contract is not another plan-approval/);
  assert.match(skill, /no project-default repair cap/);
  assert.match(skill, /`ci-inspection` procedure instead of adopting candidate control/);
  assert.match(readme, /skill\*\* is the default agent route/);
  assert.match(issue, /devpocket-development skill and AGENTS\.md/);
  assert.match(guide, /There is no additional project-default time, cost or repair-round ceiling/);
  assert.match(guide, /It never excuses failed, partial or unavailable evidence/);
  assert.match(reviewer, /For working-tree implementation/);
  assert.match(reviewer, /For candidate-commit delivery/);
  assert.match(reviewer, /Diagnosis never establishes acceptance, approval or publication readiness/);
  assert.match(reviewer, /underlying live API\/archive\/source records/);
  assert.equal([...skill.matchAll(/^\*\*Complete when:\*\*/gm)].length, 8);
  for (const anchor of ["delivery-targets-and-candidate-preparation", "local-verification-and-acceptance",
    "ci-first-delivery-and-live-qualification", "selected-group-preflight-and-explicit-recovery",
    "working-tree-evidence-to-an-authorized-candidate", "independent-review-and-delivery-freshness", "stops-and-recovery"]) {
    assert.ok(skill.includes(`DEVELOPMENT-WORKFLOW.md#${anchor}`), anchor);
  }
  for (const match of skill.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const [file, anchor] = match[1].split("#");
    const target = new URL(file, new URL("../../.github/skills/devpocket-development/SKILL.md", import.meta.url));
    const text = await readFile(target, "utf8");
    if (anchor) {
      const headings = [...text.matchAll(/^#{1,6} (.+)$/gm)].map((item) =>
        item[1].toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-"));
      assert.ok(headings.includes(anchor), `Missing skill reference: ${match[1]}`);
    }
  }
  assert.ok((await fs.stat(new URL("../../extension", import.meta.url))).isDirectory());
});

test("the skill freezes an authorized delivery candidate before final verification and review", async () => {
  const [skill, guide] = await Promise.all([
    "../../.github/skills/devpocket-development/SKILL.md", "../../docs/DEVELOPMENT-WORKFLOW.md",
  ].map((file) => readFile(new URL(file, import.meta.url), "utf8")));
  const sections = skill.split(/^## \d+\. /m).slice(1);
  assert.deepEqual(sections.map((section) => section.split(/\r?\n/, 1)[0]), [
    "Establish the task", "Select the workspace", "Implement in the owning session",
    "Freeze the verification target", "Obtain source-bound verification",
    "Request independent review", "Repair and recheck", "Hand off or publish",
  ]);
  const [contract, , , target, verification, review, repair, handoff] = sections;
  assert.match(contract, /working-tree implementation/);
  assert.match(contract, /PR delivery/);
  assert.match(contract, /local commit, push and PR creation authorization\s+separately/);
  assert.match(target, /retains the edits without creating a commit/);
  assert.match(target, /matching commit and hook authority/);
  assert.match(target, /clean tracked and non-ignored working\s+tree/);
  assert.match(target, /Keep `BASE_COMMIT` unchanged/);
  assert.match(verification, /evidence binds `source.head` to `CANDIDATE_COMMIT`/);
  assert.match(verification, /CI keeps candidate and tested\s+merge ref distinct/);
  assert.match(target, /pending draft is `ci-pending`, not `ready`/);
  assert.match(review, /Only after complete evidence/);
  assert.match(repair, /new follow-up\s+commit, with amendment only when explicitly requested/);
  assert.match(repair, /candidate is still clean at\s+`CANDIDATE_COMMIT`/);
  assert.match(handoff, /mark the\s+same authorized draft ready only after freshness/);
  assert.match(guide, /Missing execution consent blocks CI-triggering publication/);
  assert.match(guide, /blocks ready delivery, not an otherwise authorized pending draft/);
  assert.match(guide, /An unchanged push does not invalidate local source evidence/);
  assert.match(guide, /Required remote CI\s+and checks of a different PR\/merge ref still apply/);
  assert.match(guide, /`pass` with blockers, `changes_requested` without a blocker/);
  assert.match(guide, /keep the\s+approved local tools fixed/);
});

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

test("candidate inspection requires the actual linked worktree and original session identity", async (t) => {
  for (const separateGitDir of [false, true]) await t.test(String(separateGitDir), async (t) => {
    const { root, main } = await workspace(t, { separateGitDir });
    await assert.rejects(inspectWorktree(main), /isolated linked worktree/);
    const before = await inspectWorktree(root);
    assert.notEqual(before.identity.gitDirectory, before.identity.commonDirectory);
    await writeFile(path.join(root, "README.md"), "Task edit\n");
    const source = await sourceSnapshot(root), implementation = await captureCandidateImplementation();
    for (const session of [undefined, "", "not a session"]) {
      await assert.rejects(prepareCandidate(root, before, source, ["README.md"], session, "Task", undefined, implementation),
        /original session identity/);
    }
    await assert.rejects(prepareCandidate(root, before, source, ["README.md"], "fixture-session", "Task"),
      /captured native implementation/);
    assert.equal((await sourceSnapshot(root)).head, before.source.head);
    assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
  });
});

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

test("read-only Git probes do not execute configured filesystem monitors", async (t) => {
  const { verificationPlan } = await import("../verification.mjs");
  const { diagnosticSourceFiles } = await import("../verification-diagnostics.mjs");
  for (const probe of ["source", "paths", "plan", "worktree", "diagnostics"]) {
    await t.test(probe, async (t) => {
      const fixture = await workspace(t), root = fixture.root;
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
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      assert.equal(sha256(await git(root, ["config", "--null", "--list", "--show-origin", "--show-scope"])), sha256(configuration));
      if (probe === "source") {
        await git(root, ["add", "--", "README.md"]);
        assert.match(await readFile(marker, "utf8"), /^(?:ran)+$/, "Native mutation keeps the user's configured monitor behavior.");
      }
    });
  }
});

test("no-op candidate preparation preserves the existing clean HEAD without an empty commit", async (t) => {
  const { root } = await workspace(t);
  const before = await inspectWorktree(root);
  const result = await prepareCandidate(root, before, before.source, [],
    "fixture-session", "Already documented", undefined, await captureCandidateImplementation());
  assert.equal(result.request, undefined);
  assert.equal(result.candidate.created, false);
  assert.equal(result.candidate.commit, before.source.head);
  assert.deepEqual(await assertCandidate(root, before, result.candidate), before);
});

test("additions and deletions commit only literal task paths without losing source binding", async (t) => {
  const { root } = await workspace(t);
  const prepared = await prepareFixtureCandidate(root, {
    edit: async () => {
      await rm(path.join(root, "README.md"));
      await mkdir(path.join(root, "docs"));
      await writeFile(path.join(root, "docs", "reader's [notes].md"), "Replacement documentation\n");
    },
  });
  const result = await runFixtureCandidate(prepared);
  assert.equal(result.status, "committed");
  assert.deepEqual(prepared.request.files, ["README.md", "docs/reader's [notes].md"]);
  assert.equal((await inspectWorktree(root)).status, "");
  assert.deepEqual(result.candidate.source, await sourceSnapshot(root));
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
  const result = await runFixtureCandidate(await prepareFixtureCandidate(root));
  assert.equal(result.status, "committed", result.stderr);
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
  for (const name of ["native-candidate.mjs", "owned-command.cs", "verification-ci.mjs", "development-paths.mjs"]) {
    assert.ok(captured.files.some((file) => file.name === name));
    assert.equal(isVerificationPolicyPath(`scripts/${name}`), true);
  }
  const legacy = { ...captured, files: captured.files.filter((file) => !verificationInputs.includes(file.name)) };
  await assert.rejects(requireCandidateImplementation(legacy), /captured candidate\/verification implementation/);
  await assert.rejects(requireCandidateImplementation({ ...captured,
    files: [...captured.files, { name: "unlisted-control.mjs", sha256: "0".repeat(64) }].sort((a, b) => a.name.localeCompare(b.name)),
  }), /current captured candidate\/verification implementation/);
});

test("candidate implementation capture rejects linked execution inputs", async (t) => {
  const { root } = await workspace(t), { directory } = await copiedImplementation(root);
  const original = path.join(directory, "development-policy.mjs"), saved = original + ".saved", target = path.join(directory, "alias-target");
  await fs.rename(original, saved);
  await mkdir(target);
  await symlink(target, original, process.platform === "win32" ? "junction" : "dir");
  try { await assert.rejects(captureCandidateImplementation(directory), /implementation input is unavailable/); }
  finally { await rm(original); await fs.rename(saved, original); }
});
test("cached emulator recovery remains bound to both candidate and verifier execution snapshots", async (t) => {
  const { root } = await workspace(t);
  const { directory } = await copiedImplementation(root, (directory) =>
    fs.copyFile(path.resolve("scripts/emulator-resources.mjs"), path.join(directory, "emulator-resources.mjs")));
  await import(pathToFileURL(path.join(directory, "verification-android.mjs")).href);
  const verifier = await import(pathToFileURL(path.join(directory, "verification-preflight.mjs")).href);
  const captured = await captureCandidateImplementation(directory), before = await verifier.verificationExecutionPolicy();
  const file = path.join(directory, "emulator-resources.mjs");
  await writeFile(file, (await readFile(file, "utf8")) + "\n// changed in-process recovery policy\n");
  const candidateRejected = await requireCandidateImplementation(captured).then(() => false, (error) => {
    assert.match(error.message, /implementation changed/);
    return true;
  });
  assert.deepEqual({
    candidateRejected, verifierChanged: await verifier.verificationExecutionPolicy() !== before,
  }, { candidateRejected: true, verifierChanged: true });
});

test("cold capture only settles byte-identical Windows metadata, never a changed executable input", async (t) => {
  for (const changedBytes of [false, true]) await t.test(changedBytes ? "changed bytes" : "metadata only", async (t) => {
    const { root } = await workspace(t);
    const { directory } = await copiedImplementation(root);
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
  await Promise.all(["candidate-commit.mjs", "git-state.mjs", "native-candidate.mjs",
    "development-policy.mjs", ...verificationInputs].map((name) =>
    t.test(name, async (t) => {
      const { root } = await workspace(t), { directory } = await copiedImplementation(root);
      const originalHead = (await sourceSnapshot(root)).head;
      const marker = path.join(root, ".data", "unapproved-code-ran");
      const prepared = await prepareFixtureCandidate(root, { implementation: await captureCandidateImplementation(directory) });
      const file = path.join(directory, name);
      await writeFile(file, await readFile(file, "utf8") +
        `\nawait import("node:fs/promises").then(fs => fs.writeFile(${JSON.stringify(marker)}, "executed"));\n`);
      const result = await runFixtureCandidate(prepared);
      assert.equal(result.status, "blocked");
      assert.equal(result.failure, "execution-inputs-changed");
      assert.equal(result.nativeExitCode, 1);
      assert.equal((await sourceSnapshot(root)).head, originalHead);
      assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    })));
});

test("capturing verification adapters does not widen the closed native candidate loader", async (t) => {
  const { root } = await workspace(t);
  const { directory } = await copiedImplementation(root, async (directory) => {
    const helper = path.join(directory, "candidate-commit.mjs"), content = await readFile(helper, "utf8");
    const entry = "export async function runCandidateRequest(file, hash) {";
    assert.ok(content.includes(entry));
    await writeFile(helper, content.replace(entry, `${entry}\n  await import("./verification-backend.mjs");`));
  });
  const parent = (await sourceSnapshot(root)).head;
  const prepared = await prepareFixtureCandidate(root, { implementation: await captureCandidateImplementation(directory) });
  await assert.rejects(exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", nativeCandidateCommand(prepared.file, prepared.hash)],
    { cwd: root, timeout: 30_000 }), (error) => error.code === 1 && /unclassified candidate import/i.test(error.stderr));
  await assert.rejects(readFile(`${prepared.file}.result.json`), { code: "ENOENT" });
  assert.equal((await sourceSnapshot(root)).head, parent);
  assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
});

test("native startup refuses unbound Node preloads before they can execute", isolatedCases, async (t) => {
  await Promise.all(["import", "require"].map((option) =>
    t.test(option, async (t) => {
      const { root } = await workspace(t);
      const directory = path.join(root, ".data");
      await mkdir(directory);
      const preload = path.join(directory, option === "import" ? "preload.mjs" : "preload.cjs");
      const marker = path.join(directory, "unapproved-startup-ran");
      await writeFile(preload, option === "import" ? "export {};\n" : "");
      const parent = (await sourceSnapshot(root)).head, originalOptions = process.env.NODE_OPTIONS;
      const options = option === "import" ? `--import=${pathToFileURL(preload).href}`
        : `--require=${JSON.stringify(preload.replaceAll("\\", "/"))}`;
      const prepared = await prepareFixtureCandidate(root);
      await writeFile(preload, option === "import"
        ? `await import("node:fs/promises").then(fs => fs.writeFile(${JSON.stringify(marker)}, "executed"));\n`
        : `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`);
      const result = await runFixtureCandidate(prepared, { ...process.env, NODE_OPTIONS: options });
      assert.equal(result.status, "blocked");
      assert.equal(result.nativeExitCode, 78);
      assert.match(result.stderr, /NODE_OPTIONS/);
      assert.equal((await sourceSnapshot(root)).head, parent);
      assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
      assert.equal(process.env.NODE_OPTIONS, originalOptions);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      assert.equal(result.failure, "execution-startup-unbound");
    })));
});

test("hook failures and changed commit content cannot qualify a native candidate", isolatedCases, async (t) => {
  await Promise.all(["hook-error", "hook-post-commit-error", "hook-post-index-error", "hook-mutates", "hook-removes-trailer"].map((scenario) =>
    t.test(scenario, async (t) => {
      const { root, main } = await workspace(t);
      const parent = (await sourceSnapshot(root)).head;
      if (scenario.startsWith("hook")) {
        const hook = scenario === "hook-removes-trailer" ? "commit-msg" :
          scenario === "hook-post-commit-error" ? "post-commit" :
          scenario === "hook-post-index-error" ? "post-index-change" : "pre-commit";
        const body = scenario.endsWith("error") ? "echo fixture-hook-failed >&2\nexit 19\n" :
          scenario === "hook-mutates" ? "echo hook-content > README.md\ngit add -- README.md\n" :
          "printf 'Hook replaced message\\n' > \"$1\"\n";
        await writeFile(path.join(main, ".git", "hooks", hook), `#!/bin/sh\n${body}`, { mode: 0o755 });
      }
      const prepared = await prepareFixtureCandidate(root), result = await runFixtureCandidate(prepared);
      assert.equal(result.status, "blocked");
      assert.equal(result.nativeExitCode, 1);
      assert.match(result.stderr, /commit|hook|candidate/i);
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
        const receipt = JSON.parse(await readFile(`${prepared.file}.result.json`, "utf8"));
        assert.equal(receipt.failure, "commit-failed");
        assert.equal(receipt.exitCode, 1, "Record Git's observed failure, not an invented hook-process exit.");
        assert.equal(JSON.stringify(receipt).includes("fixture-hook-failed"), false, "Raw hook output stays in the native tool output.");
      }
      if (scenario === "hook-post-commit-error" || scenario === "hook-post-index-error") {
        const receipt = JSON.parse(await readFile(`${prepared.file}.result.json`, "utf8"));
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
  const prepared = await prepareFixtureCandidate(root), result = await runFixtureCandidate(prepared);
  assert.equal(await readFile(path.join(root, ".data", "nested-hook-ran"), "utf8"), "observed");
  assert.equal(result.status, "blocked", "An ignored nested hook failure is not a successful candidate.");
  assert.equal(result.nativeExitCode, 1);
  const receipt = JSON.parse(await readFile(`${prepared.file}.result.json`, "utf8"));
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
      const prepared = await prepareFixtureCandidate(root), result = await runFixtureCandidate(prepared);
      const receiptText = await readFile(`${prepared.file}.result.json`, "utf8");
      const receipt = JSON.parse(receiptText), current = await inspectWorktree(root);
      const accepted = hook === "post-checkout" && exitCode === 0;
      assert.equal(await readFile(path.join(root, ".data", "nested-observed-hook"), "utf8"), "ran");
      assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "Explained\n");
      assert.equal((await git(root, ["rev-list", "--count", `${before.source.head}..HEAD`])).trim(), "1",
        "Inspect the completed native commit rather than aborting before the nested hook runs.");
      assert.equal(result.status, accepted ? "committed" : "blocked", result.stderr);
      assert.equal(result.nativeExitCode, accepted ? 0 : 1);
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
  const result = await runFixtureCandidate(await prepareFixtureCandidate(root));
  assert.equal(result.status, "committed");
  assert.equal(await readFile(path.join(root, ".data", "hook-invocations"), "utf8"), "ran\n");
});

test("unavailable hook-exit evidence blocks a completed commit without replaying it", isolatedCases, async (t) => {
  await Promise.all([': > "$GIT_TRACE2_EVENT"', 'echo invalid-json >> "$GIT_TRACE2_EVENT"'].map((body) =>
    t.test(body, async (t) => {
      const { root, main } = await workspace(t);
      const parent = (await sourceSnapshot(root)).head;
      await writeFile(path.join(main, ".git", "hooks", "post-commit"), `#!/bin/sh\n${body}\nexit 0\n`, { mode: 0o755 });
      const prepared = await prepareFixtureCandidate(root), result = await runFixtureCandidate(prepared);
      assert.equal(result.status, "blocked");
      assert.equal(result.nativeExitCode, 1);
      assert.match(result.stderr, /hook-exit evidence/);
      assert.notEqual((await sourceSnapshot(root)).head, parent);
      assert.equal((await git(root, ["rev-list", "--count", `${parent}..HEAD`])).trim(), "1");
      const receipt = JSON.parse(await readFile(`${prepared.file}.result.json`, "utf8"));
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
  const prepared = await prepareFixtureCandidate(root), result = await runFixtureCandidate(prepared);
  assert.equal(result.status, "committed");
  await assertCandidate(root, prepared.before, result.candidate);
  await assert.rejects(readFile(path.join(root, ".data", "index-refreshed")), { code: "ENOENT" });
});

test("unowned or post-inspection changes and implementer history/index changes stop before committing", isolatedCases, async (t) => {
  await Promise.all(["unowned", "source", "index", "history", "branch", "configuration", "hooks"].map((scenario) =>
    t.test(scenario, async (t) => {
      const { root, main } = await workspace(t);
      const before = await inspectWorktree(root), hooks = await activeHookSnapshot(root);
      await writeFile(path.join(root, "README.md"), "Task change\n");
      let source = await sourceSnapshot(root);
      if (scenario === "unowned") {
        await writeFile(path.join(root, "user-notes.md"), "Concurrent user notes\n");
        source = await sourceSnapshot(root);
      }
      if (scenario === "source") await writeFile(path.join(root, "README.md"), "Concurrent edit\n");
      if (scenario === "index") await git(root, ["add", "--", "README.md"]);
      if (scenario === "history") {
        await git(root, ["add", "--", "README.md"]);
        await git(root, ["commit", "--quiet", "-m", "Unexpected implementation commit"]);
      }
      if (scenario === "branch") await git(root, ["checkout", "--quiet", "-b", "unexpected"]);
      if (scenario === "configuration") await git(root, ["config", "user.name", "Concurrent user"]);
      if (scenario === "hooks") await writeFile(path.join(main, ".git", "hooks", "pre-commit"),
        "#!/bin/sh\nprintf changed > .data/unapproved-hook-ran\n", { mode: 0o755 });
      await assert.rejects(prepareCandidate(root, before, source, ["README.md"], "fixture-session", "Task", hooks,
        await captureCandidateImplementation()), /source|concurrent|index|history|branch|configuration|hook policy/i);
      await assert.rejects(readFile(path.join(root, ".data", "unapproved-hook-ran")), { code: "ENOENT" });
      if (scenario === "unowned") assert.equal(await readFile(path.join(root, "user-notes.md"), "utf8"), "Concurrent user notes\n");
      if (scenario === "configuration") assert.equal((await git(root, ["config", "user.name"])).trim(), "Concurrent user");
    })));
});

test("the native candidate boundary rejects concurrent changes instead of committing new content", isolatedCases, async (t) => {
  await Promise.all(["source", "index", "history", "branch", "request", "existing-receipt"].map((scenario) =>
    t.test(scenario, async (t) => {
      const { root } = await workspace(t), prepared = await prepareFixtureCandidate(root);
      const original = prepared.before.source.head;
      if (scenario === "source") await writeFile(path.join(root, "README.md"), "Concurrent user edit\n");
      if (scenario === "index") await git(root, ["add", "--", "README.md"]);
      if (scenario === "history") await git(root, ["commit", "--allow-empty", "--quiet", "-m", "Concurrent commit"]);
      if (scenario === "branch") await git(root, ["checkout", "--quiet", "-b", "concurrent"]);
      if (scenario === "request") await writeFile(prepared.file, "{}\n");
      if (scenario === "existing-receipt") await writeFile(`${prepared.file}.result.json`, '{"status":"committed","candidate":{"commit":"forged"}}\n');
      const result = await runFixtureCandidate(prepared);
      assert.equal(result.nativeExitCode, 1);
      if (scenario !== "existing-receipt") assert.equal(result.status, "blocked");
      if (scenario !== "history") assert.equal((await sourceSnapshot(root)).head, original);
      if (scenario === "source") assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "Concurrent user edit\n");
      if (scenario === "index") assert.match(await git(root, ["diff", "--cached", "--name-only"]), /README.md/);
      if (scenario === "existing-receipt") assert.equal(await readFile(`${prepared.file}.result.json`, "utf8"),
        '{"status":"committed","candidate":{"commit":"forged"}}\n');
    })));
});

test("a hook-staged unowned file cannot enter retained candidate history", async (t) => {
  const { root, main } = await workspace(t);
  const parent = (await sourceSnapshot(root)).head;
  await writeFile(path.join(main, ".git", "hooks", "pre-commit"),
    "#!/bin/sh\nprintf 'Unowned hook content\\n' > hook-unowned.txt\ngit add -- hook-unowned.txt\n", { mode: 0o755 });
  const result = await runFixtureCandidate(await prepareFixtureCandidate(root));
  assert.equal(result.status, "blocked");
  assert.equal(result.nativeExitCode, 1);
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
      const result = await runFixtureCandidate(await prepareFixtureCandidate(root));
      assert.equal(result.status, veto ? "blocked" : "committed", result.stderr);
      assert.equal(result.nativeExitCode, veto ? 1 : 0);
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
