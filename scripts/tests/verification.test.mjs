import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { CHECKS, CHECK_GROUPS, VERIFICATION_REPORT_VERSION, verificationImpact } from "../verification-policy.mjs";
import { developmentReviewRequirements, isVerificationPolicyPath } from "../development-policy.mjs";
import { WORKFLOW_TEST_FILES } from "../test-workflow.mjs";

const exec = promisify(execFile);
const entry = path.resolve("scripts/verify.mjs");

async function repository(t) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/verification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".data/\n**/build/\n");
  await writeFile(path.join(root, "README.md"), "Original documentation\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
    "test:workflow": "node -e \"process.exit(0)\"",
    typecheck: "node -e \"process.exit(23)\"",
    test: "node -e \"process.exit(0)\"",
    build: "node -e \"process.exit(0)\"",
    schema: "node -e \"process.exit(0)\"",
  } }));
  await exec("git", ["init", "--quiet", root]);
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Fixture"], { cwd: root });
  return root;
}

async function verify(root, args, env) {
  const report = path.join(root, ".data", "verification", randomUUID(), "report.json");
  let exitCode = 0, stdout;
  try {
    ({ stdout } = await exec(process.execPath, [entry, "--repo", root, "--base", "HEAD", "--report", report, ...args],
      { timeout: 60_000, env: typeof env === "function" ? env(report) : env }));
  } catch (error) {
    exitCode = error.code;
    stdout = error.stdout;
  }
  return { exitCode, stdout, reportPath: report, report: JSON.parse(await readFile(report, "utf8")) };
}

async function changedRepository(t, files) {
  const root = await repository(t);
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), "fixture\n");
  }
  return root;
}

test("a documentation plan identifies the exact source without claiming checks ran", async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, "README.md"), "Revised documentation\n");
  const result = await verify(root, ["--plan"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.status, "planned");
  assert.equal(result.report.complete, false);
  assert.deepEqual(result.report.changedFiles, ["README.md"]);
  assert.deepEqual(result.report.requiredChecks, []);
  assert.match(result.report.source.fingerprint, /^[a-f0-9]{64}$/);
});

test("task-routing tooling selects only its complete regression suite, independently of AGENTS", async (t) => {
  const original = ["AGENTS.md", "README.md", "docs/DEVELOPMENT-WORKFLOW.md",
    "scripts/workflow-extension.mjs", "scripts/tests/development-workflow.test.mjs"];
  for (const files of [original, ["scripts/workflow-extension.mjs"], ["scripts/tests/development-workflow.test.mjs"], ["AGENTS.md"]]) {
    await t.test(files.join(", "), async (t) => {
      const root = await repository(t);
      for (const file of files) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), "fixture\n");
      }
      const result = await verify(root, ["--plan"]);
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.report.requiredChecks, ["workflow-tests"]);
      assert.deepEqual(result.report.requiredGroups, ["tooling"]);
      assert.equal(Object.hasOwn(result.report, "requiresHumanReview"), false);
      assert.equal(developmentReviewRequirements(result.report.changedFiles).requiresHumanReview,
        files.some((file) => file === "AGENTS.md" || file === "scripts/workflow-extension.mjs"));
      assert.equal(result.report.layouts, false);
      assert.deepEqual(result.report.changedFiles, [...files].sort());
      assert.deepEqual(result.report.selectionReasons.flatMap((reason) => reason.paths).sort(), [...files].sort());
      assert.ok(result.report.selectionReasons.every((reason) =>
        ["documentation", "task-routing", "agent-instructions"].includes(reason.rule) && reason.omittedPaths === 0));
      const publicPlan = JSON.parse(result.stdout.split(/\r?\n/).find((line) => line.startsWith("{")));
      assert.deepEqual(publicPlan.selectionReasons, result.report.selectionReasons);
      assert.deepEqual(publicPlan.requiredGroups, ["tooling"]);
      assert.equal(Object.hasOwn(publicPlan, "requiresHumanReview"), false);
    });
  }
});

test("development orchestration and named agent instructions remain protected without selecting application checks", async (t) => {
  const tooling = ["scripts/development-workflow.mjs", "scripts/development-policy.mjs", "scripts/candidate-commit.mjs",
    "scripts/native-candidate.mjs", "scripts/git-state.mjs", "scripts/verification.mjs", "scripts/verification-policy.mjs",
    "scripts/verify.mjs", "scripts/verify.ps1", "scripts/tests/verification.test.mjs",
    "scripts/test-workflow.mjs", "scripts/tests/workflow-runner.test.mjs",
    ".github/extensions/devpocket-development/extension.mjs", ".github/ISSUE_TEMPLATE/ai-task.yml",
    ".github/agents/devpocket-reviewer.agent.md", ".github/skills/devpocket-development/SKILL.md"];
  for (const files of [...tooling.map((file) => [file]), [...tooling, "README.md", "docs/DEVELOPMENT-WORKFLOW.md"]]) {
    await t.test(files.join(", "), async (t) => {
      const root = await changedRepository(t, files);
      const result = await verify(root, ["--plan"]);
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.report.requiredChecks, ["workflow-tests"]);
      assert.deepEqual(result.report.requiredGroups, ["tooling"]);
      assert.equal(result.report.layouts, false);
      assert.equal(Object.hasOwn(result.report, "requiresHumanReview"), false);
      const requirements = developmentReviewRequirements(result.report.changedFiles);
      const protectedPaths = files.filter((file) => tooling.includes(file) &&
        !file.startsWith("scripts/tests/") && file !== ".github/ISSUE_TEMPLATE/ai-task.yml").sort();
      assert.equal(requirements.requiresHumanReview, protectedPaths.length > 0);
      assert.deepEqual(requirements.protectedPaths, protectedPaths);
      assert.deepEqual(requirements.reviewPaths, []);
      const publicPlan = JSON.parse(result.stdout.split(/\r?\n/).find((line) => line.startsWith("{")));
      assert.deepEqual(Object.keys(publicPlan).sort(),
        ["kind", "layouts", "requiredChecks", "requiredGroups", "selectionReasons"]);
      assert.deepEqual(publicPlan.requiredGroups, ["tooling"]);
      assert.deepEqual(result.report.selectionReasons.flatMap((reason) => reason.paths).sort(), [...files].sort());
    });
  }
});

test("the actual CI planner does not load local development trust policy", async (t) => {
  const root = await changedRepository(t, ["scripts/development-workflow.mjs"]);
  const guard = path.join(root, ".data", "trust-import-guard.mjs");
  await mkdir(path.dirname(guard), { recursive: true });
  await writeFile(guard, [
    'import { registerHooks } from "node:module";',
    'registerHooks({ resolve(specifier, context, next) {',
    '  if (specifier.endsWith("/development-policy.mjs")) throw new Error("CI loaded local trust policy");',
    '  return next(specifier, context);',
    '} });',
  ].join("\n"));
  const result = await verify(root, ["--plan"], {
    ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(guard).href}`,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.report.requiredChecks, ["workflow-tests"]);
  assert.deepEqual(result.report.requiredGroups, ["tooling"]);
});

test("the compatibility facade plans and combines real tooling results without loading execution adapters", async (t) => {
  const facade = await import("../verification.mjs"), source = await import("../git-state.mjs");
  for (const name of ["verificationPlan", "executeVerification", "combineVerification", "verificationFailure",
    "verificationFault", "requirePlanCollection", "git", "readOnlyGit", "sourceSnapshot"]) assert.equal(typeof facade[name], "function", name);
  assert.equal(facade.git, source.git);
  assert.equal(facade.readOnlyGit, source.readOnlyGit);
  assert.equal(facade.sourceSnapshot, source.sourceSnapshot);
  const args = ["diff", "--name-only"];
  assert.deepEqual(source.readOnlyGitArgs(args), ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args]);
  assert.deepEqual(args, ["diff", "--name-only"]);
  const files = ["scripts/git-state.mjs", "scripts/native-candidate.mjs",
    "scripts/verification.mjs", "scripts/tests/verification.test.mjs"];
  const root = await changedRepository(t, files);
  const verified = await verify(root, ["--group", "tooling"]);
  assert.equal(verified.exitCode, 0);
  assert.equal(verified.report.complete, true);
  const guard = path.join(root, ".data", "execution-import-guard.mjs");
  await writeFile(guard, [
    'import { registerHooks } from "node:module";',
    'const forbidden = new Set(["verification-executor.mjs", "verification-backend.mjs", "verification-android.mjs",',
    '"process.mjs", "android-runner.mjs", "backend-diagnostics.mjs", "device-run.mjs"]);',
    'registerHooks({ resolve(specifier, context, next) {',
    '  if (forbidden.has(specifier.split("/").at(-1))) throw new Error("Pure verification loaded execution");',
    '  return next(specifier, context);',
    '} });',
  ].join("\n"));
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(guard).href}` };
  const planned = await verify(root, ["--plan"], env);
  assert.equal(planned.exitCode, 0);
  assert.deepEqual(planned.report.requiredGroups, ["tooling"]);
  assert.deepEqual(planned.report.changedFiles, [...files].sort());
  const combined = await verify(root, ["--combine", "--input", verified.reportPath,
    "--upstream", "tooling:success", "--upstream", "backend:skipped", "--upstream", "android:skipped",
    "--upstream", "device:skipped"], env);
  assert.equal(combined.exitCode, 0);
  assert.equal(combined.report.complete, true);
  assert.deepEqual(combined.report.source, verified.report.source);
});

test("documentation and an unchanged checkout select no checks or groups", async (t) => {
  for (const files of [[], ["README.md"], ["VALIDATION.md"], ["docs/DEVELOPMENT-WORKFLOW.md"]]) {
    await t.test(files.join(", ") || "unchanged", async (t) => {
      const root = await changedRepository(t, files);
      const { report, exitCode } = await verify(root, ["--plan"]);
      assert.equal(exitCode, 0);
      assert.deepEqual(report.requiredChecks, []);
      assert.deepEqual(report.requiredGroups, []);
      assert.equal(Object.hasOwn(report, "requiresHumanReview"), false);
      assert.deepEqual(developmentReviewRequirements(report.changedFiles),
        { requiresHumanReview: false, protectedPaths: [], reviewPaths: [], reasons: [] });
      assert.equal(report.layouts, false);
      assert.deepEqual(report.selectionReasons.map((item) => item.rule), files.length ? ["documentation"] : []);
      const combined = await verify(root, ["--combine", ...CHECK_GROUPS.flatMap((group) => ["--upstream", `${group}:skipped`])]);
      assert.equal(combined.exitCode, 0);
      assert.equal(combined.report.complete, true);
    });
  }
});

test("shared execution, cross-lane CI, shared dependencies and unknown paths retain all downstream checks", async (t) => {
  const cases = [
    ...["scripts/verification-executor.mjs", "scripts/process.mjs", "scripts/owned-command.ps1",
      "scripts/owned-command.cs", "scripts/owned-command-windows.mjs", "scripts/owned-command-linux.py",
      "scripts/bounded-worker-log.mjs", "scripts/backend-diagnostics.mjs"].map((file) => [file, "shared-execution"]),
    ...[".github/workflows/ci.yml", ".github/CODEOWNERS", "package.json", "package-lock.json", ".npmrc",
      "new-package/package.json"].map((file) => [file, "verification-infrastructure"]),
    ...["scripts/workflow-extension-extra.mjs", "scripts/tests/development-workflow-extra.test.mjs",
      "scripts/development-workflow-extra.mjs", "scripts/development-policy-extra.mjs", "scripts/candidate-commit-extra.mjs",
      "scripts/native-candidate-extra.mjs", "scripts/git-state-extra.mjs", "scripts/verification-extra.mjs",
      ".github/agents/another-reviewer.agent.md", ".github/skills/another-skill/SKILL.md",
      ".github/skills/devpocket-development/extra.md", ".github/actions/new-action/action.yml",
      "previously-unknown/file.txt"].map((file) => [file, "unknown"]),
  ];
  for (const [file, rule] of cases) await t.test(file, async (t) => {
    const root = await changedRepository(t, [file]);
    const { report, exitCode } = await verify(root, ["--plan"]);
    assert.equal(exitCode, 0);
    assert.deepEqual(report.requiredChecks, CHECKS.map((check) => check.id));
    assert.deepEqual(report.requiredGroups, ["tooling", "backend", "android", "device"]);
    assert.equal(Object.hasOwn(report, "requiresHumanReview"), false);
    assert.equal(developmentReviewRequirements(report.changedFiles).requiresHumanReview,
      !(rule === "unknown" && file.startsWith("scripts/")));
    assert.equal(report.layouts, true);
    assert.deepEqual(report.selectionReasons.map((item) => item.rule), [rule]);
    assert.deepEqual(report.selectionReasons[0].paths, [file]);
  });
});

test("backend and native execution inputs select their actual side, including build and device evidence", async (t) => {
  const backend = CHECKS.filter((check) => ["tooling", "backend"].includes(check.group)).map((check) => check.id);
  const native = ["workflow-tests", "android-build", "android-device"];
  for (const [files, checks, groups, layouts, rule] of [
    [["scripts/verification-backend.mjs", "scripts/bundle-extension.mjs", "scripts/package-extension.ps1",
      "scripts/launch-cli-proof.ps1", "scripts/tests/extension-package.test.mjs", "backend/tsconfig.json",
      "backend/tsconfig.cli-proof.json", ".github/workflows/extension-release.yml"],
    backend, ["tooling", "backend"], false, "backend-execution"],
    [["scripts/verification-android.mjs", "scripts/build-android.ps1", "scripts/prepare-android.ps1",
      "scripts/test-android.ps1", "scripts/android-runner.mjs", "scripts/android-emulator.mjs", "scripts/android-home.mjs",
      "scripts/device-run.mjs", "scripts/emulator-resources.mjs", "scripts/linux-emulator.mjs", "scripts/linux-runtime.mjs",
      "scripts/native-startup.mjs", "scripts/platform-diagnostics.mjs", "scripts/manual-emulator.mjs",
      "scripts/start-test-emulator.ps1", "scripts/stop-test-emulator.ps1", "scripts/test-native-layouts.ps1",
      ".github/actions/prepare-native/action.yml", ".github/workflows/native-startup-diagnostics.yml",
      "android/app/build.gradle.kts", "android/gradle.properties", "android/gradlew", "android/gradlew.bat",
      "android/gradle/wrapper/gradle-wrapper.properties", "android/gradle/wrapper/gradle-wrapper.jar"],
    native, ["tooling", "android", "device"], true, "android-execution"],
    [["deployment/azure/package.json", "deployment/azure/package-lock.json", "deployment/azure/probe/requirements-test.txt"],
    ["workflow-tests", "typecheck", "backend-tests", "backend-build", "schema", "setup", "azure-tests", "operations-tests"],
    ["tooling", "backend"], false, "operations"],
  ]) for (const file of files) await t.test(file, async (t) => {
    const root = await changedRepository(t, [file]);
    const { report, exitCode } = await verify(root, ["--plan"]);
    assert.equal(exitCode, 0);
    assert.deepEqual(report.requiredChecks, checks);
    assert.deepEqual(report.requiredGroups, groups);
    assert.equal(report.layouts, layouts);
    assert.deepEqual(report.selectionReasons.map((item) => item.rule), [rule]);
    assert.equal(developmentReviewRequirements(report.changedFiles).requiresHumanReview, isVerificationPolicyPath(file));
  });
});

test("the complete workflow suite and pure evidence modules are tooling, not application execution", async () => {
  const contracts = ["verification-diagnostics", "diagnostic-errors", "diagnostic-publication", "android-diagnostics",
    "device-diagnostics", "worker-diagnostics", "native-lifecycle"].map((name) => `scripts/${name}.mjs`);
  for (const file of [...WORKFLOW_TEST_FILES, "scripts/test-workflow.mjs", ...contracts]) {
    const impact = verificationImpact([file]);
    assert.deepEqual(impact.requiredChecks, ["workflow-tests"], file);
    assert.deepEqual(impact.requiredGroups, ["tooling"], file);
    assert.equal(impact.layouts, false, file);
    const requirements = developmentReviewRequirements([file]);
    const protectedInput = !file.startsWith("scripts/tests/");
    assert.equal(requirements.requiresHumanReview, protectedInput, file);
    assert.deepEqual(requirements.protectedPaths, protectedInput ? [file] : [], file);
    assert.deepEqual(requirements.reviewPaths, [], file);
  }
  assert.ok(CHECKS.every((check) => JSON.stringify(Object.keys(check).sort()) === '["group","id"]'),
    "The impact catalogue cannot carry executable commands or arguments.");
});

test("the workflow entry does not exempt shared dependencies, unknown tests or mixed application changes", () => {
  const entry = ["scripts/test-workflow.mjs", "scripts/tests/workflow-runner.test.mjs"];
  for (const file of ["package.json", "package-lock.json", ".npmrc", ".github/workflows/ci.yml",
    "scripts/test-workflow-extra.mjs", "scripts/tests/workflow-runner-extra.test.mjs", "scripts/tests/unlisted.test.mjs"]) {
    const impact = verificationImpact([...entry, file]);
    assert.deepEqual(impact.requiredChecks, CHECKS.map((check) => check.id), file);
    assert.equal(impact.layouts, true, file);
  }
  assert.deepEqual(verificationImpact([...entry, "backend/tests/fixture.test.ts"]).requiredGroups, ["tooling", "backend"]);
  assert.deepEqual(verificationImpact([...entry, "android/app/src/main/java/dev/devpocket/app/ui/Screen.kt"]).requiredGroups,
    ["tooling", "android", "device"]);
});

test("local Xcode setup and root ignore policy select tooling without weakening mixed or unknown inputs", () => {
  const setup = [".gitignore", "scripts/setup-xcode-mcp.mjs", "config/xcode-mcp.example.json",
    "scripts/tests/xcode-mcp.test.mjs"];
  for (const files of [...setup.map((file) => [file]), [...setup, "README.md", "docs/DEVELOPMENT-WORKFLOW.md"]]) {
    const impact = verificationImpact(files);
    assert.deepEqual(impact.requiredChecks, ["workflow-tests"]);
    assert.deepEqual(impact.requiredGroups, ["tooling"]);
    assert.equal(impact.layouts, false);
    // Tooling coverage is not an approval rule; the unclassified template still needs review.
    assert.equal(developmentReviewRequirements(files).requiresHumanReview, files.includes("config/xcode-mcp.example.json"));
  }
  for (const file of ["package.json", "package-lock.json", "scripts/process.mjs", ".github/workflows/ci.yml",
    "scripts/setup-xcode-mcp-extra.mjs", "config/another-mcp.example.json",
    "scripts/tests/xcode-mcp-extra.test.mjs", "nested/.gitignore"]) {
    const impact = verificationImpact([...setup, file]);
    assert.deepEqual(impact.requiredChecks, CHECKS.map((check) => check.id), file);
    assert.equal(impact.layouts, true, file);
  }
  assert.deepEqual(verificationImpact([...setup, "android/app/src/main/java/dev/devpocket/app/ui/Screen.kt"]).requiredGroups,
    ["tooling", "android", "device"]);
});

test("mixed development tooling and application changes select the union from the single check catalogue", async (t) => {
  const core = ["workflow-tests", "typecheck", "backend-tests", "backend-build", "schema"];
  const tooling = ["scripts/workflow-extension.mjs", "scripts/development-workflow.mjs",
    "scripts/candidate-commit.mjs", ".github/agents/devpocket-reviewer.agent.md"];
  for (const [file, checks, groups, layouts = false] of [
    ["backend/tests/fixture.test.ts", core, ["tooling", "backend"]],
    ["backend/src/protocol.ts", [...core, "extension-package", "setup", "android-build", "android-device"], CHECK_GROUPS],
    ["backend/integration/fixture.ts", [...core, "android-build", "android-device"], CHECK_GROUPS],
    ["protocol.schema.json", [...core, "android-build", "android-device"], CHECK_GROUPS],
    ["test-fixtures/fixture.ts", [...core, "android-build", "android-device"], CHECK_GROUPS],
    ["extension/bridge.mjs", [...core, "extension-package", "setup"], ["tooling", "backend"]],
    ["deployment/azure/src/fixture.ts", [...core, "setup", "azure-tests", "operations-tests"], ["tooling", "backend"]],
    ["android/app/src/main/java/dev/devpocket/app/ui/Screen.kt", ["workflow-tests", "android-build", "android-device"],
      ["tooling", "android", "device"], true],
    ["scripts/verification.mjs", ["workflow-tests"], ["tooling"]],
    ["scripts/git-state.mjs", ["workflow-tests"], ["tooling"]],
    ["scripts/tests/verification.test.mjs", ["workflow-tests"], ["tooling"]],
    ["scripts/verification-backend.mjs", CHECKS.filter((check) => ["tooling", "backend"].includes(check.group)).map((check) => check.id),
      ["tooling", "backend"]],
    ["scripts/verification-android.mjs", ["workflow-tests", "android-build", "android-device"], ["tooling", "android", "device"], true],
    ["scripts/verification-executor.mjs", CHECKS.map((check) => check.id), CHECK_GROUPS, true],
    [".github/workflows/ci.yml", CHECKS.map((check) => check.id), CHECK_GROUPS, true],
    ["unknown.txt", CHECKS.map((check) => check.id), CHECK_GROUPS, true],
  ]) await t.test(file, async (t) => {
    const root = await changedRepository(t, [...tooling, file]);
    const { report, exitCode } = await verify(root, ["--plan"]);
    assert.equal(exitCode, 0);
    assert.deepEqual(report.requiredChecks, checks);
    assert.deepEqual(report.requiredGroups, groups);
    assert.deepEqual(report.requiredGroups, [...new Set(CHECKS.filter((check) => checks.includes(check.id)).map((check) => check.group))]);
    assert.equal(Object.hasOwn(report, "requiresHumanReview"), false);
    assert.equal(developmentReviewRequirements(report.changedFiles).requiresHumanReview, true);
    assert.equal(report.layouts, layouts);
    assert.equal(report.selectionReasons.length, 4);
    assert.deepEqual(report.selectionReasons.flatMap((item) => item.paths).sort(), [file, ...tooling].sort());
  });
});

test("real added, staged, deleted, renamed and mixed paths select a deterministic conservative union", async (t) => {
  const tools = ["scripts/git-state.mjs", "scripts/native-candidate.mjs", "scripts/verification.mjs", "scripts/tests/verification.test.mjs"];
  const backend = CHECKS.filter((check) => ["tooling", "backend"].includes(check.group)).map((check) => check.id);
  const native = ["workflow-tests", "android-build", "android-device"], all = CHECKS.map((check) => check.id);
  for (const scenario of [
    { name: "untracked tools", add: tools, checks: ["workflow-tests"] },
    { name: "staged tools", add: tools, staged: true, checks: ["workflow-tests"] },
    { name: "modified tools", initial: tools, add: tools, checks: ["workflow-tests"] },
    { name: "deleted tools", initial: tools, remove: tools, checks: ["workflow-tests"] },
    { name: "staged deletions", initial: tools, remove: tools, staged: true, checks: ["workflow-tests"] },
    { name: "native renamed to source helper", initial: ["scripts/verification-android.mjs"],
      rename: ["scripts/verification-android.mjs", "scripts/git-state.mjs"], checks: native, layouts: true },
    { name: "source helper renamed to backend executor", initial: ["scripts/git-state.mjs"],
      rename: ["scripts/git-state.mjs", "scripts/verification-backend.mjs"], staged: true, checks: backend },
    { name: "both side executors", add: [...tools, "scripts/verification-backend.mjs", "scripts/verification-android.mjs"],
      checks: all, layouts: true },
    { name: "deleted unknown input", initial: ["scripts/unclassified.mjs"], remove: ["scripts/unclassified.mjs"],
      checks: all, layouts: true },
    { name: "renamed to unclassified input", initial: ["scripts/git-state.mjs"],
      rename: ["scripts/git-state.mjs", "scripts/unclassified.mjs"], checks: all, layouts: true },
    { name: "unknown unusual filename", add: [...tools, "scripts/unknown input.mjs"], checks: all, layouts: true },
  ]) await t.test(scenario.name, async (t) => {
    const root = await changedRepository(t, scenario.initial ?? []);
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "commit", "--quiet", "--allow-empty", "-m", "Initial inputs"], { cwd: root });
    for (const file of scenario.add ?? []) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "changed fixture\n");
    }
    for (const file of scenario.remove ?? []) await rm(path.join(root, file));
    if (scenario.rename) await rename(...scenario.rename.map((file) => path.join(root, file)));
    if (scenario.staged) await exec("git", ["add", "-A"], { cwd: root });
    const index = await readFile(path.join(root, ".git", "index"));
    const first = await verify(root, ["--plan"]), second = await verify(root, ["--plan"]);
    assert.equal(first.exitCode, 0);
    assert.equal(second.exitCode, 0);
    assert.deepEqual(first.report, second.report);
    assert.deepEqual(first.report.changedFiles, [...new Set([
      ...(scenario.add ?? []), ...(scenario.remove ?? []), ...(scenario.rename ?? []),
    ])].sort());
    assert.deepEqual(first.report.requiredChecks, scenario.checks);
    assert.deepEqual(first.report.requiredGroups,
      [...new Set(CHECKS.filter((check) => scenario.checks.includes(check.id)).map((check) => check.group))]);
    assert.equal(first.report.layouts, scenario.layouts ?? false);
    assert.deepEqual(await readFile(path.join(root, ".git", "index")), index, "Planning must not refresh the index.");
  });
});

test("plan explanations are deterministic and bounded without truncating actual impact selection", async (t) => {
  const docs = Array.from({ length: 40 }, (_, index) => `docs/guide-${String(index).padStart(2, "0")}.md`).reverse();
  const root = await changedRepository(t, [...docs, "docs/unusual name.md", "scripts/workflow-extension.mjs"]);
  const first = (await verify(root, ["--plan"])).report;
  const second = (await verify(root, ["--plan"])).report;
  assert.deepEqual(first.selectionReasons, second.selectionReasons);
  assert.deepEqual(first.requiredChecks, ["workflow-tests"]);
  const reason = first.selectionReasons.find((item) => item.rule === "documentation");
  assert.deepEqual(reason.paths, [...docs].sort().slice(0, 16));
  assert.equal(reason.omittedPaths, 25);
  assert.ok(reason.description.length > 0);
  assert.deepEqual(first.selectionReasons.find((item) => item.rule === "task-routing").checks, ["workflow-tests"]);
  const forced = (await verify(root, ["--plan", "--all"])).report;
  assert.deepEqual(forced.requiredChecks, CHECKS.map((check) => check.id));
  assert.deepEqual(forced.requiredGroups, CHECK_GROUPS);
  assert.equal(forced.selectionReasons.at(-1).rule, "all-checks");
  assert.deepEqual(forced.selectionReasons.at(-1).paths, []);
});

test("public plan diagnostics preserve responsibility-specific selections without supplying approval", async (t) => {
  for (const file of ["scripts/git-state.mjs", "scripts/verification-backend.mjs", "scripts/verification-android.mjs",
    "scripts/verification-executor.mjs", "scripts/unknown.mjs"]) await t.test(file, async (t) => {
    const root = await changedRepository(t, [file]), result = await verify(root, ["--plan"]);
    assert.equal(result.exitCode, 0);
    const directory = path.dirname(result.reportPath);
    await rename(result.reportPath, path.join(directory, "plan.json"));
    await exec(process.execPath, [path.resolve("scripts/verification-diagnostics.mjs"),
      "--directory", directory, "--job", "plan"], { cwd: root, timeout: 20000 });
    const diagnostic = JSON.parse(await readFile(path.join(directory, "verification-diagnostics.json"), "utf8"));
    assert.equal(diagnostic.acceptance, false);
    assert.equal(diagnostic.collectionStatus, "completed");
    assert.deepEqual(diagnostic.selection.requiredChecks, result.report.requiredChecks);
    assert.deepEqual(diagnostic.selection.requiredGroups, result.report.requiredGroups);
    assert.deepEqual(diagnostic.selection.selectionReasons, result.report.selectionReasons);
    assert.equal(Object.hasOwn(diagnostic.selection, "requiresHumanReview"), false);
  });
});

test("the CLI and PowerShell tooling shard run no application checks", async (t) => {
  const root = await changedRepository(t, ["scripts/development-workflow.mjs", "scripts/candidate-commit.mjs",
    ".github/agents/devpocket-reviewer.agent.md"]);
  const result = await verify(root, ["--group", "tooling"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.version, VERIFICATION_REPORT_VERSION);
  assert.equal(result.report.group, "tooling");
  assert.equal(result.report.complete, true);
  assert.deepEqual(result.report.checks.map((check) => [check.id, check.status]), [["workflow-tests", "passed"]]);
  const report = path.join(root, ".data", "verification", "powershell", "report.json");
  await exec("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.resolve("scripts/verify.ps1"),
    "-Base", "HEAD", "-Group", "tooling", "-Report", report], { cwd: root, timeout: 30000 });
  const wrapper = JSON.parse(await readFile(report, "utf8"));
  assert.equal(wrapper.group, "tooling");
  assert.equal(wrapper.complete, true);
  assert.deepEqual(wrapper.requiredChecks, ["workflow-tests"]);
  const invalid = await verify(root, ["--plan", "--group", "not-a-group"]);
  assert.equal(invalid.exitCode, 1);
  assert.equal(invalid.report.failure.reason, "configuration");
});

test("tooling aggregation accepts only complete current evidence and ignores unselected skipped jobs", async (t) => {
  const root = await changedRepository(t, ["scripts/workflow-extension.mjs"]);
  const verified = await verify(root, ["--group", "tooling"]);
  assert.equal(verified.exitCode, 0);
  const current = verified.report, input = path.join(root, ".data", "tooling-input.json");
  const upstream = ["tooling:success", "backend:skipped", "android:skipped", "device:skipped"]
    .flatMap((result) => ["--upstream", result]);
  await writeFile(input, JSON.stringify(current));
  const success = await verify(root, ["--combine", "--input", input, ...upstream]);
  assert.equal(success.exitCode, 0);
  assert.equal(success.report.complete, true);
  assert.deepEqual(success.report.requiredGroups, ["tooling"]);
  for (const [name, change, reason] of [
    ["missing tooling", { checks: [] }, "shard-missing"],
    ["unrun tooling", { checks: [{ id: "workflow-tests", status: "not_run" }] }, "shard-missing"],
    ["failed report", { status: "failed" }, "check-failed"],
    ["blocked report", { status: "blocked" }, "check-failed"],
    ["cancelled report", { status: "cancelled" }, "check-failed"],
    ["planned report", { status: "planned" }, "check-failed"],
    ["skipped check", { checks: [{ id: "workflow-tests", status: "skipped", exitCode: 0 }] }, "check-failed"],
    ["cancelled check", { checks: [{ id: "workflow-tests", status: "cancelled", exitCode: 0 }] }, "check-failed"],
    ["duplicate check", { checks: [current.checks[0], current.checks[0]] }, "check-duplicate"],
    ["wrong group", { group: "backend" }, "check-group"],
    ["unknown group", { group: "unrecognized" }, "check-group"],
    ["unexpected check", { checks: [{ id: "backend-tests", status: "passed", exitCode: 0 }] }, "check-unexpected"],
    ["nonzero exit", { checks: [{ id: "workflow-tests", status: "passed", exitCode: 1 }] }, "check-failed"],
    ["stale base", { base: "a".repeat(40) }, "source-mismatch"],
    ["stale head", { source: { ...current.source, head: "b".repeat(40) } }, "source-mismatch"],
    ["stale fingerprint", { source: { ...current.source, fingerprint: "c".repeat(64) } }, "source-mismatch"],
    ["different required checks", { requiredChecks: [] }, "policy-mismatch"],
    ["different required groups", { requiredGroups: ["backend"] }, "policy-mismatch"],
    ["missing group policy", { requiredGroups: undefined }, "policy-mismatch"],
    ["legacy report", { version: 1 }, "policy-mismatch"],
    ["coupled impact and review report", { version: 2 }, "policy-mismatch"],
    ["unknown report version", { version: 999 }, "policy-mismatch"],
  ]) await t.test(name, async () => {
    await writeFile(input, JSON.stringify({ ...current, ...change }));
    const result = await verify(root, ["--combine", "--input", input, ...upstream]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.complete, false);
    assert.equal(result.report.failure.reason, reason);
  });
  await writeFile(input, JSON.stringify(current));
  const duplicate = await verify(root, ["--combine", "--input", input, "--input", input]);
  assert.equal(duplicate.report.failure.reason, "check-duplicate");
  for (const outcome of ["failure", "cancelled", "skipped", "unknown"]) {
    const result = await verify(root, ["--combine", "--input", input, "--upstream", `tooling:${outcome}`]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.failure.reason, "upstream-job-failed");
    assert.equal(result.report.failure.group, "tooling");
    assert.equal(result.report.failure.outcome, outcome);
  }
  const missing = await verify(root, ["--combine", "--input", input, "--upstream", "backend:skipped"]);
  assert.equal(missing.report.failure.reason, "upstream-job-failed");
  assert.equal(missing.report.failure.outcome, "unknown");
  const conflicting = await verify(root, ["--combine", "--input", input, "--upstream", "tooling:success", "--upstream", "tooling:skipped"]);
  assert.equal(conflicting.report.failure.reason, "configuration");
  for (const requiresHumanReview of [true, false]) {
    await writeFile(input, JSON.stringify({ ...current, requiresHumanReview }));
    const result = await verify(root, ["--combine", "--input", input, ...upstream]);
    assert.equal(result.exitCode, 0, "Local-agent review flags cannot approve or block CI test evidence.");
    assert.equal(result.report.complete, true);
    assert.equal(Object.hasOwn(result.report, "requiresHumanReview"), false);
  }
});

test("mixed and full plans require every tooling and application shard with strict job outcomes", async (t) => {
  for (const [name, files] of [
    ["mixed", ["scripts/workflow-extension.mjs", "backend/tests/fixture.ts"]],
    ["full", ["scripts/verification-executor.mjs"]],
  ]) await t.test(name, async (t) => {
    const root = await changedRepository(t, files), plan = (await verify(root, ["--plan"])).report;
    const cases = [
      { name: "native", class: "dev.devpocket.app.NativeFlowTest", status: "passed", tests: 2 },
      ...["compact", ...(plan.layouts ? ["medium", "expanded", "landscape", "large-font"] : [])].map((name) =>
        ({ name: `layout-${name}`, class: "dev.devpocket.app.AdaptiveLayoutTest", status: "passed", tests: 1 })),
      { name: "fixture", class: "dev.devpocket.app.FixtureFlowTest", status: "passed", tests: 1 },
    ];
    const deviceEvidence = { version: 1, runId: randomUUID(), status: "passed", cleanup: "completed",
      evidence: "emulator-test-sdk-adapter", source: plan.source, cases, tests: cases.reduce((count, item) => count + item.tests, 0),
      apkSha256: "a".repeat(64), testApkSha256: "b".repeat(64), discoveredClasses: [...new Set(cases.map((item) => item.class))] };
    const inputs = new Map();
    for (const group of plan.requiredGroups) {
      const file = path.join(root, ".data", `${group}-input.json`);
      await writeFile(file, JSON.stringify({ ...plan, group, status: "partial", complete: false,
        checks: plan.requiredChecks.map((id) => CHECKS.find((check) => check.id === id).group !== group
          ? { id, status: "not_run" } : { id, status: "passed", exitCode: 0, ...(id === "android-device" ? { deviceEvidence } : {}) }) }));
      inputs.set(group, file);
    }
    const args = [...inputs.values()].flatMap((file) => ["--input", file]);
    const upstream = (failedGroup, outcome) => CHECK_GROUPS.flatMap((group) =>
      ["--upstream", `${group}:${group === failedGroup ? outcome : plan.requiredGroups.includes(group) ? "success" : "skipped"}`]);
    const complete = await verify(root, ["--combine", ...args, ...upstream()]);
    assert.equal(complete.exitCode, 0);
    assert.equal(complete.report.complete, true);
    for (const group of plan.requiredGroups) {
      const missing = await verify(root, ["--combine", ...[...inputs.entries()].filter(([key]) => key !== group)
        .flatMap(([, file]) => ["--input", file]), ...upstream()]);
      assert.equal(missing.exitCode, 1);
      assert.equal(missing.report.failure.reason, "shard-missing");
      assert.deepEqual(missing.report.failure.missingChecks,
        CHECKS.filter((check) => check.group === group && plan.requiredChecks.includes(check.id)).map((check) => check.id));
      for (const outcome of ["failure", "cancelled", "skipped"]) {
        const failed = await verify(root, ["--combine", ...args, ...upstream(group, outcome)]);
        assert.equal(failed.exitCode, 1);
        assert.equal(failed.report.failure.reason, "upstream-job-failed");
        assert.equal(failed.report.failure.group, group);
      }
    }
  });
});

test("CI projects actual planner groups and forwards selected and unselected job outcomes without reclassifying checks", async (t) => {
  const workflow = (await readFile(".github/workflows/ci.yml", "utf8")).replaceAll("\r\n", "\n");
  const planning = workflow.split("\n  plan:")[1].split("\n  tooling:")[0], gate = workflow.split("\n  gate:")[1];
  const loop = (text) => text.match(/ {10}foreach \(\$group in @\([^\n]+\)\) \{\n[\s\S]+?\n {10}\}/)?.[0];
  const projection = loop(planning), upstream = loop(gate);
  assert.ok(projection);
  assert.ok(upstream);
  assert.doesNotMatch(planning, /Where-Object|requiredChecks -contains/);
  assert.doesNotMatch(planning + gate, /requiresHumanReview|development-policy/);
  for (const [name, files, groups] of [
    ["documentation", ["README.md"], []],
    ["tooling", ["scripts/workflow-extension.mjs"], ["tooling"]],
    ["development", ["scripts/development-workflow.mjs", "scripts/candidate-commit.mjs",
      ".github/agents/devpocket-reviewer.agent.md"], ["tooling"]],
    ["contracts", ["scripts/git-state.mjs", "scripts/native-candidate.mjs", "scripts/verification.mjs",
      "scripts/tests/verification.test.mjs"], ["tooling"]],
    ["backend", ["scripts/verification-backend.mjs"], ["tooling", "backend"]],
    ["native", ["scripts/verification-android.mjs"], ["tooling", "android", "device"]],
    ["full", ["scripts/verification-executor.mjs"], CHECK_GROUPS],
  ]) await t.test(name, async (t) => {
    const root = await changedRepository(t, files), plan = await verify(root, ["--plan"]);
    const output = path.join(root, ".data", "job-outputs");
    await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
      `$plan = Get-Content -LiteralPath $env:PLAN_FILE -Raw | ConvertFrom-Json\n${projection}`],
    { cwd: root, env: { ...process.env, PLAN_FILE: plan.reportPath, GITHUB_OUTPUT: output }, timeout: 20000 });
    const flags = Object.fromEntries((await readFile(output, "utf8")).trim().split(/\r?\n/).map((line) => line.split("=")));
    assert.deepEqual(flags, Object.fromEntries(CHECK_GROUPS.map((group) => [group, String(groups.includes(group))])));
    const results = Object.fromEntries(CHECK_GROUPS.map((group) =>
      [`${group.toUpperCase()}_RESULT`, groups.includes(group) ? "success" : "skipped"]));
    const forwarded = await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
      `$arguments = @()\n${upstream}\nConvertTo-Json -InputObject @($arguments) -Compress`],
    { cwd: root, env: { ...process.env, ...results }, timeout: 20000 });
    assert.deepEqual(JSON.parse(forwarded.stdout),
      CHECK_GROUPS.flatMap((group) => ["--upstream", `${group}:${groups.includes(group) ? "success" : "skipped"}`]));
  });
});

test("app, wire, unrelated skills and unknown changes cannot omit device checks", async (t) => {
  for (const file of [
    "android/app/src/main/java/Screen.kt",
    "backend/src/protocol.ts",
    "scripts/verification-executor.mjs",
    ".github/skills/another-skill/SKILL.md",
    "new-unclassified-file",
  ]) {
    await t.test(file, async (t) => {
      const root = await repository(t);
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "fixture");
      const result = await verify(root, ["--plan"]);
      assert.equal(result.exitCode, 0);
      assert.ok(result.report.requiredChecks.includes("android-device"));
      assert.ok(result.report.requiredChecks.includes("android-build"));
      assert.equal(Object.hasOwn(result.report, "requiresHumanReview"), false);
      if (!file.startsWith("android/")) assert.equal(developmentReviewRequirements(result.report.changedFiles).requiresHumanReview, true);
      if (file.startsWith(".github/skills/")) {
        assert.deepEqual(result.report.requiredChecks, CHECKS.map((check) => check.id));
        assert.deepEqual(result.report.requiredGroups, CHECK_GROUPS);
      }
    });
  }
});

test("a failed command exits unsuccessfully and leaves later required checks not_run", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "backend", "tests"), { recursive: true });
  await writeFile(path.join(root, "backend", "tests", "fixture.test.ts"), "// fixture\n");
  const result = await verify(root, []);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.complete, false);
  assert.equal(result.report.checks.find((check) => check.id === "typecheck").status, "failed");
  assert.equal(result.report.checks.find((check) => check.id === "typecheck").exitCode, 23);
  assert.equal(result.report.checks.find((check) => check.id === "backend-tests").status, "not_run");
});

test("the backend adapter runs every fixed npm entry with the correct working directory and no native commands", async (t) => {
  const root = await repository(t), directory = path.join(root, ".data");
  await mkdir(directory);
  const calls = path.join(directory, "commands.jsonl"), recorder = path.join(directory, "record.mjs");
  await writeFile(recorder, `import {appendFileSync} from "node:fs";\n` +
    `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({id:process.argv[2],cwd:process.cwd()})+"\\n");\n`);
  const entries = [
    ["typecheck", "typecheck"], ["test", "backend-tests"], ["build", "backend-build"], ["schema", "schema"],
    ["test:extension-package", "extension-package"], ["test:setup", "setup"], ["test:operations", "operations-tests"],
  ];
  const script = (id) => `node "${recorder}" ${id}`;
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
    ...Object.fromEntries(entries.map(([name, id]) => [name, script(id)])), "test:workflow": script("must-not-run"),
  } }));
  const azure = path.join(root, "deployment", "azure");
  await mkdir(azure, { recursive: true });
  await writeFile(path.join(azure, "package.json"), JSON.stringify({ scripts: { test: script("azure-tests") } }));
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Fixed command fixtures"], { cwd: root });
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "verification-backend.mjs"), "// adapter change\n");
  const result = await verify(root, ["--group", "backend"]);
  assert.equal(result.exitCode, 0, JSON.stringify(result.report));
  assert.equal(result.report.status, "partial");
  const expected = CHECKS.filter((check) => check.group === "backend").map((check) => check.id);
  assert.deepEqual(JSON.parse("[" + (await readFile(calls, "utf8")).trim().split("\n").join(",") + "]"),
    expected.map((id) => ({ id, cwd: id === "azure-tests" ? azure : root })));
  assert.deepEqual(result.report.checks.filter((check) => check.status === "passed").map((check) => check.id), expected);
  assert.equal(result.report.checks[0].status, "not_run");
  assert.ok(result.report.checks.every((check) => check.id === "workflow-tests" ||
    check.commandOutcome?.reason === "exit" && check.commandOutcome.exitCode === 0 &&
      check.commandOutcome.cleanupFailure === null), JSON.stringify(result.report.checks));
});

test("the native adapter preserves literal parameters, mandatory instrumentation and device failures through both entries", async (t) => {
  for (const layouts of [false, true]) await t.test(`layouts=${layouts}`, async (t) => {
    const root = await repository(t), scripts = path.join(root, "scripts");
    await mkdir(scripts);
    await mkdir(path.join(root, ".data"));
    await writeFile(path.join(scripts, "build-android.ps1"), [
      "param($Jdk,$Sdk,[switch]$Lint,[switch]$Instrumentation)",
      "@{Jdk=$Jdk;Sdk=$Sdk;Lint=[bool]$Lint;Instrumentation=[bool]$Instrumentation} | ConvertTo-Json -Compress | Set-Content -LiteralPath '.data/build-args.json'",
      "exit 0", "",
    ].join("\n"));
    await writeFile(path.join(scripts, "test-android.ps1"), [
      "param($Jdk,$Sdk,$Image,$RunDirectory,$Owner,[switch]$Layouts)",
      "@{Jdk=$Jdk;Sdk=$Sdk;Image=$Image;RunDirectory=$RunDirectory;Owner=$Owner;Layouts=[bool]$Layouts;LayoutsBound=$PSBoundParameters.ContainsKey('Layouts')} | ConvertTo-Json -Compress | Set-Content -LiteralPath '.data/device-args.json'",
      "exit 37", "",
    ].join("\n"));
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "commit", "--quiet", "-m", "Native entry fixtures"], { cwd: root });
    const changed = layouts ? "scripts/verification-android.mjs" : "android/screen.kt";
    await mkdir(path.dirname(path.join(root, changed)), { recursive: true });
    await writeFile(path.join(root, changed), "// fixture\n");
    const jdk = path.join(root, "literal jdk ' &"), sdk = path.join(root, "literal sdk ' &");
    const report = path.join(root, ".data", "verification", "native-wrapper", "report.json");
    await exec("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.resolve("scripts/verify.ps1"),
      "-Base", "HEAD", "-Group", "android", "-Jdk", jdk, "-Sdk", sdk, "-Report", report],
    { cwd: root, timeout: 30000 });
    assert.deepEqual(JSON.parse(await readFile(path.join(root, ".data", "build-args.json"), "utf8")),
      { Jdk: jdk, Sdk: sdk, Lint: true, Instrumentation: true });
    const build = JSON.parse(await readFile(report, "utf8"));
    assert.equal(build.status, "partial");
    assert.equal(build.checks.find((check) => check.id === "android-build").status, "passed");
    assert.equal(build.checks.find((check) => check.id === "android-device").status, "not_run");
    const image = "system-images/android-35/google_apis/x86_64";
    const device = await verify(root, ["--group", "device", "--jdk", jdk, "--sdk", sdk, "--image", image]);
    assert.equal(device.exitCode, 1);
    const check = device.report.checks.find((item) => item.id === "android-device");
    assert.equal(check.exitCode, 37);
    assert.equal(check.status, "failed");
    assert.equal(device.report.complete, false);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, ".data", "device-args.json"), "utf8")), {
      Jdk: jdk, Sdk: sdk, Image: image, RunDirectory: path.join(path.dirname(device.reportPath), "device"),
      Owner: check.deviceRunId, Layouts: layouts, LayoutsBound: layouts,
    });
    assert.match(check.deviceRunId, /^[a-f0-9-]{36}$/);
    assert.equal(device.report.checks.find((item) => item.id === "android-build").status, "not_run");
  });
});

test("backend diagnostics observe the ordered backend entry without running the independent tooling suite", async (t) => {
  const root = await repository(t);
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  manifest.type = "module";
  manifest.scripts.typecheck = "node -e \"process.exit(0)\"";
  manifest.scripts.test = "node --import tsx --test backend/tests/*.test.ts";
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "backend-diagnostics.mjs"), await readFile("scripts/backend-diagnostics.mjs"));
  await writeFile(path.join(root, "scripts", "bounded-worker-log.mjs"), await readFile("scripts/bounded-worker-log.mjs"));
  await mkdir(path.join(root, "backend", "tests"), { recursive: true });
  await writeFile(path.join(root, "backend", "tests", "fixture.test.ts"), [
    'import {test} from "node:test";import assert from "node:assert/strict";',
    'test("trusted controller failure",()=>{console.log("synthetic-private-sdk-event");assert.equal(1,2);});',
  ].join("\n"));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = await verify(root, ["--group", "backend", "--backend-diagnostics"], env);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.checks.find((check) => check.id === "workflow-tests").status, "not_run");
  assert.equal(result.report.checks.find((check) => check.id === "typecheck").status, "passed");
  const backend = result.report.checks.find((check) => check.id === "backend-tests");
  assert.equal(backend.status, "failed");
  assert.equal(backend.exitCode, 1);
  assert.match(backend.backendDiagnosticRunId, /^[a-f0-9-]{36}$/);
  assert.equal(backend.backendDiagnosticLogTruncated, false);
  assert.equal(result.report.checks.find((check) => check.id === "backend-build").status, "not_run");
  assert.equal(result.report.complete, false);
  const log = await readFile(path.join(root, backend.log), "utf8");
  assert.match(log, /DEVPOCKET_BACKEND_DIAGNOSTIC /);
  assert.ok(!log.includes("synthetic-private-sdk-event"));
  const { combineVerification } = await import("../verification.mjs");
  assert.throws(() => combineVerification(result.report, [result.report]), /failed, blocked/);
});

test("diagnostic preflight rejects raw reporter configuration before workflow-test predecessors can write artifacts", async (t) => {
  const root = await repository(t);
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  manifest.type = "module";
  manifest.scripts["test:workflow"] = "node --test workflow-canary.test.mjs";
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(root, "workflow-canary.test.mjs"), [
    'import {test} from "node:test";import assert from "node:assert/strict";import {writeFileSync} from "node:fs";',
    'test("synthetic raw predecessor",()=>{writeFileSync("predecessor-ran","yes");',
    'assert.fail("PRIVATE_PREDECESSOR_CANARY".repeat(1024));});',
  ].join("\n"));
  const caller = { ...process.env };
  delete caller.NODE_TEST_CONTEXT;
  const result = await verify(root, ["--group", "all", "--backend-diagnostics"], (report) => ({
    ...caller,
    NODE_OPTIONS: `--title='x --test_reporter=spec --test_reporter_destination=${report} --title=y'`,
  }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "blocked");
  assert.equal(result.report.complete, false);
  assert.ok(!JSON.stringify(result.report).includes("PRIVATE_PREDECESSOR_CANARY"));
  await assert.rejects(readFile(path.join(root, "predecessor-ran")), { code: "ENOENT" });
});

test("npm interpolation cannot introduce a raw reporter after diagnostic preflight", async (t) => {
  const root = await repository(t);
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  manifest.type = "module";
  manifest.scripts.typecheck = "node -e \"process.exit(0)\"";
  manifest.scripts.test = "node --import tsx --test backend/tests/*.test.ts";
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "backend-diagnostics.mjs"), await readFile("scripts/backend-diagnostics.mjs"));
  await writeFile(path.join(root, "scripts", "bounded-worker-log.mjs"), await readFile("scripts/bounded-worker-log.mjs"));
  await mkdir(path.join(root, "backend", "tests"), { recursive: true });
  await writeFile(path.join(root, "backend", "tests", "fixture.test.ts"), [
    'import {test} from "node:test";import assert from "node:assert/strict";import {writeFileSync} from "node:fs";',
    'test("synthetic interpolation",()=>{writeFileSync("backend-ran","yes");',
    'assert.fail("PRIVATE_INTERPOLATION_CANARY".repeat(1024));});',
  ].join("\n"));
  const caller = { ...process.env };
  delete caller.NODE_TEST_CONTEXT;
  for (const key of Object.keys(caller)) if (key.toLowerCase().replaceAll("-", "_") === "npm_config_node_options") delete caller[key];
  const result = await verify(root, ["--group", "backend", "--backend-diagnostics"], (report) => ({
    ...caller, NODE_OPTIONS: "--title=${DP_BG_OPTIONS}",
    DP_BG_OPTIONS: `x --test-reporter=spec --test-reporter-destination=${report}`,
  }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "blocked");
  assert.match(result.report.error, /interpolation/);
  assert.ok(!JSON.stringify(result.report).includes("PRIVATE_INTERPOLATION_CANARY"));
  await assert.rejects(readFile(path.join(root, "backend-ran")), { code: "ENOENT" });
});

test("combining reports refuses absent device evidence and stale source fingerprints", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "android"), { recursive: true });
  await writeFile(path.join(root, "android", "screen.kt"), "// fixture\n");
  const planned = (await verify(root, ["--plan"])).report;
  const input = path.join(root, ".data", "android.json");
  const shard = {
    ...planned, group: "android", status: "partial", complete: false,
    checks: [{ id: "android-build", status: "passed", exitCode: 0 }, { id: "android-device", status: "not_run" }],
  };
  await writeFile(input, JSON.stringify(shard));
  let result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.complete, false);
  assert.match(result.report.error, /android-device/);
  await writeFile(input, JSON.stringify({
    ...shard, group: "all", status: "passed", complete: true,
    checks: planned.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0,
      ...(id === "android-device" ? { deviceEvidence: {
        status: "passed", cleanup: "completed", source: planned.source, evidence: "emulator-test-sdk-adapter",
        runId: "11111111-1111-4111-8111-111111111111",
        discoveredClasses: ["dev.devpocket.app.AdaptiveLayoutTest", "dev.devpocket.app.FixtureFlowTest", "dev.devpocket.app.NativeFlowTest"],
        apkSha256: "a".repeat(64), testApkSha256: "b".repeat(64), tests: 4,
        cases: [
          { name: "native", class: "dev.devpocket.app.NativeFlowTest", status: "passed", tests: 2 },
          { name: "layout-compact", class: "dev.devpocket.app.AdaptiveLayoutTest", status: "passed", tests: 1 },
          { name: "fixture", class: "dev.devpocket.app.FixtureFlowTest", status: "passed", tests: 1 },
        ],
      } } : {}),
    })),
  }));
  result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.complete, true);
  const linux = JSON.parse(await readFile(input, "utf8"));
  linux.environment = { platform: "linux" };
  const native = linux.checks.find((check) => check.id === "android-device").deviceEvidence;
  await writeFile(input, JSON.stringify(linux));
  result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 1, "Linux reports cannot omit platform/acceleration evidence.");
  native.platform = "linux";
  native.acceleration = { provider: "WHPX", usable: true };
  await writeFile(input, JSON.stringify(linux));
  result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 1, "A different hypervisor cannot qualify Linux KVM.");
  native.acceleration = { provider: "KVM", usable: true };
  await writeFile(input, JSON.stringify(linux));
  result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 0);
  await writeFile(path.join(root, "android", "screen.kt"), "// new source\n");
  result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 1);
  assert.match(result.report.error, /source|Source/);
});

test("the actual aggregate CLI publishes distinct safe missing, invalid, source and policy reasons", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "android"));
  await writeFile(path.join(root, "android", "screen.kt"), "// fixture\n");
  const plan = (await verify(root, ["--plan"])).report;
  const file = path.join(root, ".data", "input.json");
  const cases = [
    { name: "missing input", input: undefined, args: ["--input", file], reason: "report-missing" },
    { name: "invalid input", input: "PRIVATE_REPORT_CANARY invalid JSON", args: ["--input", file], reason: "report-invalid" },
    { name: "source mismatch", input: JSON.stringify({ ...plan, group: "android", status: "partial",
      source: { head: "c".repeat(40), fingerprint: "d".repeat(64) } }), args: ["--input", file], reason: "source-mismatch" },
    { name: "policy mismatch", input: JSON.stringify({ ...plan, group: "android", status: "partial", requiredChecks: [] }),
      args: ["--input", file], reason: "policy-mismatch" },
    { name: "missing shard", input: undefined, args: [], reason: "shard-missing" },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    if (scenario.input !== undefined) await writeFile(file, scenario.input);
    const result = await verify(root, ["--combine", ...scenario.args]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.status, "blocked");
    assert.equal(result.report.failure?.reason, scenario.reason);
    assert.equal(result.report.failure.phase, "aggregate");
    assert.ok(!JSON.stringify(result.report).includes("PRIVATE_REPORT_CANARY"));
    assert.equal(result.report.complete, false);
  });
});

test("a failed required job cannot qualify through an otherwise successful check report", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "backend", "tests"), { recursive: true });
  await writeFile(path.join(root, "backend", "tests", "fixture.test.ts"), "// fixture\n");
  const plan = (await verify(root, ["--plan"])).report;
  const input = path.join(root, ".data", "backend.json");
  await writeFile(input, JSON.stringify({ ...plan, group: "all", status: "passed", complete: true,
    checks: plan.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0 })) }));
  const result = await verify(root, ["--combine", "--input", input, "--upstream", "tooling:success", "--upstream", "backend:failure"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.complete, false);
  assert.equal(result.report.failure.reason, "upstream-job-failed");
  assert.equal(result.report.failure.group, "backend");
  assert.equal(result.report.failure.outcome, "failure");
});

test("aggregation never republishes arbitrary check fields from otherwise valid shards", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "backend", "tests"), { recursive: true });
  await writeFile(path.join(root, "backend", "tests", "fixture.test.ts"), "// fixture\n");
  const plan = (await verify(root, ["--plan"])).report;
  const input = path.join(root, ".data", "backend.json");
  await writeFile(input, JSON.stringify({ ...plan, group: "all", status: "passed",
    checks: plan.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0,
      rawAssertion: "PRIVATE_AGGREGATE_CANARY", deviceDiagnostics: { raw: "PRIVATE_AGGREGATE_CANARY" } })) }));
  const result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.complete, true);
  assert.ok(!JSON.stringify(result.report).includes("PRIVATE_AGGREGATE_CANARY"));
  const contradictory = JSON.parse(await readFile(input, "utf8"));
  contradictory.checks[0].collectionStatus = "failed";
  await writeFile(input, JSON.stringify(contradictory));
  const blocked = await verify(root, ["--combine", "--input", input]);
  assert.equal(blocked.exitCode, 1);
  assert.equal(blocked.report.failure.reason, "collector-failed");
});

test("a planning catalogue exception cannot qualify an otherwise valid current aggregate", async (t) => {
  const root = await repository(t);
  const parent = path.join(root, "android", "app", "src", "main", "java");
  await mkdir(parent, { recursive: true });
  await writeFile(path.join(root, "android", "screen.kt"), "// fixture\n");
  await writeFile(path.join(root, ".git", "info", "exclude"), "android/app/src/main/java/build\n");
  const plan = (await verify(root, ["--plan"])).report;
  const cases = [
    { name: "native", class: "dev.devpocket.app.NativeFlowTest", status: "passed", tests: 2 },
    { name: "layout-compact", class: "dev.devpocket.app.AdaptiveLayoutTest", status: "passed", tests: 1 },
    { name: "fixture", class: "dev.devpocket.app.FixtureFlowTest", status: "passed", tests: 1 },
  ];
  const evidence = { version: 1, runId: randomUUID(), source: plan.source, status: "passed", cleanup: "completed",
    evidence: "emulator-test-sdk-adapter", platform: process.platform, acceleration: { provider: "KVM", usable: true },
    apkSha256: "a".repeat(64), testApkSha256: "b".repeat(64), tests: 4, cases,
    discoveredClasses: cases.map((item) => item.class) };
  const input = path.join(root, ".data", "current.json");
  await writeFile(input, JSON.stringify({ ...plan, status: "passed", group: "all",
    checks: plan.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0,
      ...(id === "android-device" ? { deviceEvidence: evidence } : {}) })) }));
  const target = path.join(root, ".data", "catalogue-target");
  await mkdir(target);
  await symlink(target, path.join(parent, "build"), "junction");
  const result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.failure.reason, "collector-failed");
  assert.equal(result.report.complete, false);
  const planning = await verify(root, ["--plan"]);
  assert.equal(planning.exitCode, 1);
  assert.equal(planning.report.failure.reason, "collector-failed");
  const { prepareStartupPlan } = await import("../native-startup.mjs");
  const owner = randomUUID();
  await assert.rejects(prepareStartupPlan(root, "HEAD", owner, "same-build"), (error) => {
    assert.equal(error.diagnosticCode, "collector-failed");
    assert.equal(error.startupReport.phase, "plan");
    assert.equal(error.startupReport.runId, owner);
    assert.equal(error.startupReport.collectionStatus, "failed");
    return true;
  });
});
test("log initialization failure is a visible blocked check and never runs its command", async (t) => {
  const root = await repository(t);
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  manifest.scripts["test:workflow"] = "node -e \"require('fs').writeFileSync('must-not-run','unsafe')\"";
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  const directory = path.join(root, ".data", "verification", "log-init");
  await mkdir(path.join(directory, "workflow-tests.log"), { recursive: true });
  const report = path.join(directory, "report.json");
  await assert.rejects(exec(process.execPath, [entry, "--repo", root, "--base", "HEAD", "--group", "tooling", "--report", report],
    { timeout: 20000 }), (error) => error.code === 1);
  const value = JSON.parse(await readFile(report, "utf8")), check = value.checks.find((item) => item.id === "workflow-tests");
  assert.equal(check.status, "blocked");
  assert.equal(check.executionState, "not-started");
  assert.equal(check.failure.phase, "log");
  assert.equal(check.failure.reason, "report-write");
  assert.equal(check.privateLog.availability, "not-produced");
  await assert.rejects(readFile(path.join(root, "must-not-run")), { code: "ENOENT" });
});
test("source changes made by a successful check invalidate its green result", async (t) => {
  const root = await repository(t);
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  manifest.scripts.typecheck = "node -e \"require('fs').writeFileSync('README.md','changed by check')\"";
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Check fixture"], { cwd: root });
  await mkdir(path.join(root, "backend", "tests"), { recursive: true });
  await writeFile(path.join(root, "backend", "tests", "fixture.ts"), "// fixture\n");
  const result = await verify(root, []);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.complete, false);
  assert.match(result.report.error, /Source changed/);
});

test("final source inspection failure preserves an earlier real check exit and reports the source failure separately", async (t) => {
  const root = await repository(t);
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  manifest.scripts.typecheck = "node -e \"const f=require('fs');f.unlinkSync('README.md');f.mkdirSync('README.md');process.exit(23)\"";
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  const result = await verify(root, ["--group", "backend"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.checks.find((check) => check.id === "typecheck")?.exitCode, 23);
  assert.equal(result.report.checks.find((check) => check.id === "typecheck").status, "failed");
  assert.equal(result.report.sourceValidation.status, "failed");
  assert.equal(result.report.sourceValidation.failure.phase, "source-validation");
  assert.equal(result.report.sourceValidation.failure.reason, "source-unavailable");
  assert.equal(result.report.complete, false);
});
test("a zero-exit device command without instrumentation evidence cannot pass its shard", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "test-android.ps1"),
    "param($Jdk,$Sdk,$Image,$RunDirectory,[switch]$Layouts)\nexit 0\n");
  const result = await verify(root, ["--group", "device"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.complete, false);
  assert.equal(result.report.checks.find((check) => check.id === "android-device").status, "blocked");
});

test("Git executable-mode changes invalidate source evidence even when bytes are identical", async (t) => {
  const root = await repository(t);
  const before = (await verify(root, ["--plan"])).report.source.fingerprint;
  await exec("git", ["update-index", "--chmod=+x", "README.md"], { cwd: root });
  const after = (await verify(root, ["--plan"])).report.source.fingerprint;
  assert.notEqual(after, before);
});

test("source identity detects content, nonignored additions, staged inputs and deletions without normalizing bytes", async (t) => {
  const { sourceSnapshot } = await import("../git-state.mjs");
  const root = await repository(t), original = await sourceSnapshot(root);
  await mkdir(path.join(root, ".data"));
  await writeFile(path.join(root, ".data", "ignored.txt"), "not a source input\n");
  assert.deepEqual(await sourceSnapshot(root), original);
  const file = path.join(root, "README.md");
  await writeFile(file, "changed bytes\n");
  const changed = await sourceSnapshot(root);
  assert.equal(changed.head, original.head);
  assert.notEqual(changed.fingerprint, original.fingerprint);
  await exec("git", ["add", "README.md"], { cwd: root });
  assert.deepEqual(await sourceSnapshot(root), changed, "Staging identical worktree bytes cannot manufacture a different source.");
  await writeFile(file, "changed bytes\r\n");
  const raw = await sourceSnapshot(root);
  assert.notEqual(raw.fingerprint, changed.fingerprint);
  await writeFile(file, "changed bytes\n");
  assert.deepEqual(await sourceSnapshot(root), changed, "The worktree, not a stale staged blob, defines bytes to execute.");
  await writeFile(path.join(root, "new-source.txt"), "untracked bytes\n");
  const untracked = await sourceSnapshot(root);
  assert.notEqual(untracked.fingerprint, changed.fingerprint);
  await exec("git", ["add", "new-source.txt"], { cwd: root });
  assert.deepEqual(await sourceSnapshot(root), untracked);
  await rm(file);
  const deleted = await sourceSnapshot(root);
  assert.notEqual(deleted.fingerprint, untracked.fingerprint);
  assert.deepEqual(await sourceSnapshot(root), deleted);
  await exec("git", ["add", "-u"], { cwd: root });
  assert.notEqual((await sourceSnapshot(root)).fingerprint, untracked.fingerprint);
});

test("HEAD identity and an unmerged index are independent of the source byte fingerprint", async (t) => {
  const { sourceSnapshot } = await import("../git-state.mjs");
  const root = await repository(t), before = await sourceSnapshot(root);
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "--allow-empty", "-m", "New HEAD with identical inputs"], { cwd: root });
  const after = await sourceSnapshot(root);
  assert.notEqual(after.head, before.head);
  assert.equal(after.fingerprint, before.fingerprint);
  const oid = (await exec("git", ["hash-object", "-w", "README.md"], { cwd: root })).stdout.trim();
  await exec("git", ["update-index", "--force-remove", "README.md"], { cwd: root });
  const update = exec("git", ["update-index", "--index-info"], { cwd: root });
  update.child.stdin.end([1, 2, 3].map((stage) => `100644 ${oid} ${stage}\tREADME.md\n`).join(""));
  await update;
  await assert.rejects(sourceSnapshot(root), /unmerged index/);
  const plan = await verify(root, ["--plan"]);
  assert.equal(plan.exitCode, 1);
  assert.equal(plan.report.complete, false);
});

test("source identity records a tracked link itself rather than following its ignored target", async (t) => {
  const { sourceSnapshot } = await import("../git-state.mjs");
  const root = await repository(t), link = path.join(root, "tracked-link");
  await writeFile(link, "placeholder");
  const oid = (await exec("git", ["hash-object", "-w", "tracked-link"], { cwd: root })).stdout.trim();
  await exec("git", ["update-index", "--add", "--cacheinfo", `120000,${oid},tracked-link`], { cwd: root });
  await writeFile(path.join(root, ".gitignore"), ".data/\n**/build/\ntracked-link/*\n");
  await rm(link);
  const targets = [path.join(root, ".data", "target-one"), path.join(root, ".data", "target-two")];
  for (const target of targets) await mkdir(target, { recursive: true });
  await symlink(targets[0], link, process.platform === "win32" ? "junction" : "dir");
  t.after(async () => {
    try { await rm(link); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  });
  const before = await sourceSnapshot(root);
  await writeFile(path.join(targets[0], "ignored-content.txt"), "not followed");
  assert.deepEqual(await sourceSnapshot(root), before);
  await rm(link);
  await symlink(targets[1], link, process.platform === "win32" ? "junction" : "dir");
  assert.notEqual((await sourceSnapshot(root)).fingerprint, before.fingerprint);
});

test("source fingerprints retain Git modes and bytes across distinct unnormalized checkouts", async (t) => {
  const { sourceSnapshot } = await import("../verification.mjs");
  const root = await repository(t);
  await exec("git", ["update-index", "--chmod=+x", "README.md"], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Mode fixture"], { cwd: root });
  const linked = `${root}-worktree`;
  await exec("git", ["-c", "core.autocrlf=false", "worktree", "add", "--quiet", "--detach", linked, "HEAD"], { cwd: root });
  try {
    assert.deepEqual(await sourceSnapshot(linked), await sourceSnapshot(root),
      "Linked-worktree Git metadata must not enter source identity.");
  } finally {
    await exec("git", ["worktree", "remove", linked], { cwd: root });
  }
  const clone = `${root}-clone`;
  t.after(() => rm(clone, { recursive: true, force: true }));
  await exec("git", ["-c", "core.autocrlf=false", "clone", "--quiet", "--no-local", root, clone]);
  assert.deepEqual(await sourceSnapshot(clone), await sourceSnapshot(root),
    "Absolute host checkout paths and filesystem executable bits are not source identity.");
  await writeFile(path.join(clone, "README.md"), "Original documentation\r\n");
  assert.notEqual((await sourceSnapshot(clone)).fingerprint, (await sourceSnapshot(root)).fingerprint,
    "Different checkout bytes must not be hidden by normalization.");
});

test("planning refuses sealed or existing evidence destinations without overwriting them", async (t) => {
  const root = await repository(t);
  for (const parts of [["artifacts", "build-002", "build.json"], ["verification", "existing.json"]]) {
    const target = path.join(root, ".data", ...parts);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "sealed evidence");
    await assert.rejects(exec(process.execPath, [entry, "--repo", root, "--base", "HEAD", "--plan", "--report", target]));
    assert.equal(await readFile(target, "utf8"), "sealed evidence");
  }
});

test("blocked native prerequisites remain blocked at the verification interface", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "test-android.ps1"), [
    "param($Jdk,$Sdk,$Image,$RunDirectory,$Owner,[switch]$Layouts)",
    "New-Item -ItemType Directory -Path $RunDirectory | Out-Null",
    "@{version=1;runId=$Owner;status='blocked';tests=0;cases=@();cleanup='completed';error='Missing test image.'} | ConvertTo-Json | Set-Content (Join-Path $RunDirectory 'device-report.json')",
    "exit 1", "",
  ].join("\n"));
  const result = await verify(root, ["--group", "device"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.checks.find((check) => check.id === "android-device").status, "blocked");
});

test("the real device runner failure phase survives PowerShell and controller wrappers without exposing its private SDK path", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "scripts"));
  const runner = path.resolve("scripts/android-runner.mjs").replaceAll("'", "''");
  await writeFile(path.join(root, "scripts", "test-android.ps1"), [
    "param($Jdk,$Sdk,$Image,$RunDirectory,$Owner,[switch]$Layouts)",
    "$sdk=Join-Path (Get-Location).Path '.data\\PRIVATE_DEVICE_SDK_CANARY'",
    `& node '${runner}' --repo (Get-Location).Path --directory $RunDirectory --owner $Owner --sdk $sdk --emulator-sdk $sdk`,
    "exit $LASTEXITCODE", "",
  ].join("\n"));
  const result = await verify(root, ["--group", "device"]);
  const check = result.report.checks.find((item) => item.id === "android-device");
  assert.equal(result.exitCode, 1);
  assert.equal(check.status, "blocked");
  assert.equal(check.deviceDiagnostics?.primary?.phase, "resources");
  assert.equal(check.deviceDiagnostics.primary.reason, "resource-unavailable");
  assert.equal(check.deviceDiagnostics.acceptance, false);
  assert.match(check.deviceRunId, /^[a-f0-9-]{36}$/);
  assert.equal(check.deviceDiagnostics.runId, check.deviceRunId);
  assert.ok(!JSON.stringify(result.report).includes("PRIVATE_DEVICE_SDK_CANARY"));
  const directory = path.dirname(result.reportPath);
  const temp = path.join(root, ".data", "github-temp"), commands = path.join(temp, "_runner_file_commands");
  await mkdir(commands, { recursive: true });
  const output = path.join(commands, `set_output_${randomUUID()}`), summary = path.join(commands, `step_summary_${randomUUID()}`);
  await writeFile(output, "");
  await writeFile(summary, "");
  const exported = await exec(process.execPath, [path.resolve("scripts/device-diagnostics.mjs"), "--directory", directory, "--github"],
    { cwd: root, timeout: 20000, env: { ...process.env, GITHUB_ACTIONS: "true", RUNNER_TEMP: temp,
      GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
  const diagnostic = JSON.parse(await readFile(path.join(directory, "device-diagnostics.json"), "utf8"));
  assert.equal(diagnostic.primary.phase, "resources");
  assert.equal(diagnostic.checkStatus, "blocked");
  assert.equal(diagnostic.verificationStatus, "blocked");
  assert.equal(await readFile(output, "utf8"), "report_ready=true\n");
  assert.ok((await readFile(summary, "utf8")).includes("resource-unavailable"));
  assert.ok(!exported.stdout.includes("PRIVATE_DEVICE_SDK_CANARY"));
  assert.ok(!(await readFile(summary, "utf8")).includes("PRIVATE_DEVICE_SDK_CANARY"));
  const workflow = (await readFile(".github/workflows/ci.yml", "utf8")).replaceAll("\r\n", "\n");
  const device = workflow.split("\n  device:")[1].split("\n  gate:")[0];
  assert.match(device, /node scripts\/device-diagnostics\.mjs --directory \.data\/ci\/device --github/);
  assert.match(device, /steps\.device_diagnostics\.outputs\.report_ready == 'true'/);
  assert.match(device, /name: device-test-diagnostics\n\s+path: \.data\/ci\/device\/device-diagnostics\.json/);
});

test("blocked worker diagnostics stay scoped and cannot publish raw process fields", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "test-android.ps1"), [
    "param($Jdk,$Sdk,$Image,$RunDirectory,$Owner,[switch]$Layouts)",
    "New-Item -ItemType Directory -Path $RunDirectory | Out-Null",
    "$worker=@{role='emulator';observation='exit';context='unexpected';exitCode=23;signal='none';failureCategory='unknown';argv=@('private-worker-argv')}",
    "@{version=1;runId=$Owner;status='blocked';tests=0;cases=@();cleanup='completed';error='C:\\private-worker-argv\\unknown-worker exited';",
    "workerDiagnostics=@{runId=$Owner;cleanup='completed';workers=@($worker)}} | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $RunDirectory 'device-report.json')",
    "exit 1", "",
  ].join("\n"));
  const result = await verify(root, ["--group", "device"]);
  assert.equal(result.exitCode, 1);
  const check = result.report.checks.find((item) => item.id === "android-device");
  assert.equal(check.status, "blocked");
  assert.equal(check.workerDiagnostics.workers[0].exitCode, 23);
  assert.equal(check.workerDiagnostics.workers[0].context, "unexpected");
  assert.ok(!JSON.stringify(result.report).includes("private-worker-argv"));
});

test("an initial real catalogue exception remains failed through later healthy reads, runner success and public export", async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, ".gitignore"), ".data/\n**/build/\nandroid/app/src/main/java/build\n");
  await mkdir(path.join(root, "scripts"));
  const declarations = path.join(root, "android", "app", "src", "androidTest", "java", "dev", "devpocket", "app");
  await mkdir(declarations, { recursive: true });
  await mkdir(path.join(root, "android", "app", "src", "main", "java"), { recursive: true });
  for (const name of ["NativeFlowTest", "AdaptiveLayoutTest", "FixtureFlowTest"]) {
    await writeFile(path.join(declarations, `${name}.kt`), `package dev.devpocket.app\nclass ${name} { @Test fun synthetic() {} }\n`);
  }
  const runner = pathToFileURL(path.resolve("scripts/android-runner.mjs")).href;
  const verifier = pathToFileURL(path.resolve("scripts/verification.mjs")).href;
  await writeFile(path.join(root, "scripts", "catalogue-fixture.mjs"), [
    "import {mkdir,writeFile,rm,symlink} from 'node:fs/promises';import {writeFileSync} from 'node:fs';",
    "import path from 'node:path';import {createHash} from 'node:crypto';",
    `import {runAndroidTests} from ${JSON.stringify(runner)};import {sourceSnapshot} from ${JSON.stringify(verifier)};`,
    "const [directory,owner]=process.argv.slice(2),root=process.cwd();",
    "const target=path.join(root,'.data','catalogue-target'),link=path.join(root,'android/app/src/main/java/build');",
    "await mkdir(target,{recursive:true});await symlink(target,link,'junction');",
    "const runtime={prepare:async(_identity,report)=>{",
    "report.source=await sourceSnapshot(root);const outputs=['debug/app-debug.apk','androidTest/debug/app-debug-androidTest.apk'];",
    "for(const output of outputs){const file=path.join(root,'android/app/build/outputs/apk',output);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'synthetic');}",
    "report.apkSha256=report.testApkSha256=createHash('sha256').update('synthetic').digest('hex');",
    "return {apk:'synthetic',testApk:'synthetic'};},",
    "emulator:async(options,operation)=>{await rm(link,{recursive:true});await mkdir(directory);",
    "await writeFile(path.join(directory,'owner.json'),JSON.stringify({version:1,root,runId:owner,pid:process.pid}));await options.prepare({});",
    "const value=await operation({root,directory,runId:owner,leaseId:owner,ports:{},acceleration:{provider:'KVM',usable:true},",
    "manage(_file,args){writeFileSync(args[args.indexOf('--output')+1],JSON.stringify({relayUrl:'http://127.0.0.1:54321',pairingCode:'dpp_'+'A'.repeat(43),title:'synthetic'}));return {settled:false};},",
    "adb:async(args)=>{if(!args.includes('instrument'))return {stdout:'Success\\n',stderr:''};",
    "if(args.includes('log'))return {stdout:['NativeFlowTest','AdaptiveLayoutTest','FixtureFlowTest'].map(name=>'INSTRUMENTATION_STATUS: class=dev.devpocket.app.'+name).join('\\n')+'\\nINSTRUMENTATION_CODE: -1\\n',stderr:''};",
    "const cls=args[args.indexOf('class')+1],n=cls.endsWith('NativeFlowTest')?2:1;",
    "return {stdout:Array.from({length:n},()=>`INSTRUMENTATION_STATUS: class=${cls}\\nINSTRUMENTATION_STATUS_CODE: 0\\n`).join('')+`OK (${n} tests)\\nINSTRUMENTATION_CODE: -1\\n`,stderr:''};}});",
    "return {result:value,cleanup:'completed',workerDiagnostics:{runId:owner,cleanup:'completed',collectionStatus:'completed',workers:[]}};}};",
    "const report=await runAndroidTests({repo:root,directory,owner,layouts:true},runtime);",
    "console.log('DEVPOCKET_DEVICE_DIAGNOSTIC '+JSON.stringify(report.deviceDiagnostics));process.exitCode=report.status==='passed'?0:1;",
  ].join("\n"));
  await writeFile(path.join(root, "scripts", "test-android.ps1"), [
    "param($Jdk,$Sdk,$Image,$RunDirectory,$Owner,[switch]$Layouts)",
    "& node (Join-Path $PSScriptRoot 'catalogue-fixture.mjs') $RunDirectory $Owner", "exit $LASTEXITCODE",
  ].join("\n"));
  const result = await verify(root, ["--group", "device"]);
  assert.equal(result.exitCode, 1);
  const check = result.report.checks.find((item) => item.id === "android-device");
  assert.equal(check.reportedDeviceExecutionStatus, "passed");
  assert.equal(check.deviceDiagnostics.collectionStatus, "failed");
  assert.ok(check.deviceDiagnostics.cases.every((item) => item.status === "passed"));
  await assert.rejects(exec(process.execPath, [path.resolve("scripts/device-diagnostics.mjs"),
    "--directory", path.dirname(result.reportPath)], { cwd: root, timeout: 20000 }), (error) => error.code === 1);
  const published = JSON.parse(await readFile(path.join(path.dirname(result.reportPath), "device-diagnostics.json"), "utf8"));
  assert.equal(published.collectionStatus, "failed");
  assert.equal(published.executionStatus, "passed");
});

test("controller cancellation removes only its owned device data after the process job stops", async (t) => {
  const { executeVerification, verificationPlan } = await import("../verification.mjs");
  const root = await repository(t);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "runner-fixture.mjs"), [
    "import {mkdir,writeFile} from 'node:fs/promises'; import path from 'node:path';",
    "const [directory,runId]=process.argv.slice(2);",
    "await mkdir(directory);",
    "await writeFile(path.join(directory,'owner.json'),JSON.stringify({version:1,root:process.cwd(),runId,pid:process.pid}));",
    "await mkdir(path.join(directory,'fixture'));",
    "await writeFile(path.join(directory,'fixture','synthetic.txt'),'fixture-only');",
    "process.stdin.on('data',()=>process.exit(1)); setInterval(()=>{},1000);",
  ].join("\n"));
  await writeFile(path.join(root, "scripts", "test-android.ps1"), [
    "param($Jdk,$Sdk,$Image,$RunDirectory,$Owner,[switch]$Layouts)",
    "& node (Join-Path $PSScriptRoot 'runner-fixture.mjs') $RunDirectory $Owner",
    "exit $LASTEXITCODE", "",
  ].join("\n"));
  const controller = new AbortController();
  const directory = path.join(root, ".data", "verification", "cancel");
  const running = executeVerification(root, await verificationPlan(root, "HEAD"), {
    group: "device", directory, signal: controller.signal,
  });
  const marker = path.join(directory, "device", "fixture", "synthetic.txt");
  let started = false;
  for (let attempt = 0; attempt < 400; attempt++) {
    try { await readFile(marker); started = true; break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  controller.abort();
  const report = await running;
  assert.equal(started, true, "The owned fixture must start before cancellation.");
  assert.equal(report.status, "blocked");
  const check = report.checks.find((item) => item.id === "android-device");
  assert.equal(check.failure.reason, "command-cancelled");
  assert.equal(check.cleanup, "completed", JSON.stringify({
    check, log: await readFile(path.join(directory, "android-device.log"), "utf8"),
  }));
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("a device shard accepts current complete case and APK evidence without fabricating other shards", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "scripts"));
  const module = pathToFileURL(path.resolve("scripts/verification.mjs")).href;
  await writeFile(path.join(root, "scripts", "device-fixture.mjs"), [
    "import {mkdir,writeFile} from 'node:fs/promises'; import path from 'node:path'; import {createHash} from 'node:crypto';",
    `import {sourceSnapshot} from ${JSON.stringify(module)};`,
    "const [directory,runId]=process.argv.slice(2); await mkdir(directory);",
    "const apk=path.resolve('android/app/build/outputs/apk/debug/app-debug.apk');",
    "const testApk=path.resolve('android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk');",
    "for(const file of [apk,testApk]) { await mkdir(path.dirname(file),{recursive:true}); await writeFile(file,'synthetic APK'); }",
    "const cases=[{name:'native',class:'dev.devpocket.app.NativeFlowTest',tests:2,status:'passed'},",
    "...['compact','medium','expanded','landscape','large-font'].map(name=>({name:'layout-'+name,class:'dev.devpocket.app.AdaptiveLayoutTest',tests:1,status:'passed'})),",
    "{name:'fixture',class:'dev.devpocket.app.FixtureFlowTest',tests:1,status:'passed'}];",
    "const sha=createHash('sha256').update('synthetic APK').digest('hex');",
    "await writeFile(path.join(directory,'device-report.json'),JSON.stringify({version:1,runId,status:'passed',cleanup:'completed',",
    "source:await sourceSnapshot(process.cwd()),evidence:'emulator-test-sdk-adapter',apkSha256:sha,testApkSha256:sha,",
    "tests:8,cases,discoveredClasses:['dev.devpocket.app.AdaptiveLayoutTest','dev.devpocket.app.FixtureFlowTest','dev.devpocket.app.NativeFlowTest'],",
    "workerDiagnostics:{runId,cleanup:'completed',workers:[{role:'emulator',observation:'exit',context:'during-cleanup',exitCode:0,signal:'none',argv:['private-worker-argv']}]}}));",
  ].join("\n"));
  await writeFile(path.join(root, "scripts", "test-android.ps1"), [
    "param($Jdk,$Sdk,$Image,$RunDirectory,$Owner,[switch]$Layouts)",
    "& node (Join-Path $PSScriptRoot 'device-fixture.mjs') $RunDirectory $Owner",
    "exit $LASTEXITCODE", "",
  ].join("\n"));
  const result = await verify(root, ["--group", "device"]);
  assert.equal(result.exitCode, 0, JSON.stringify(result.report));
  assert.equal(result.report.status, "partial");
  assert.equal(result.report.complete, false);
  assert.equal(result.report.checks.find((check) => check.id === "android-device").status, "passed");
  assert.ok(!JSON.stringify(result.report).includes("private-worker-argv"),
    "Both deviceEvidence and the direct worker projection must exclude raw process fields.");
  const fixture = path.join(root, "scripts", "device-fixture.mjs");
  const source = await readFile(fixture, "utf8");
  const modified = source.replace("tests:8,cases,discoveredClasses:",
    "tests:9,cases:[...cases,{name:'change-0',class:'PRIVATE_DISCOVERY_CANARY',tests:1,status:'passed'}],discoveredClasses:")
    .replace("'dev.devpocket.app.NativeFlowTest'],", "'dev.devpocket.app.NativeFlowTest','PRIVATE_DISCOVERY_CANARY'],");
  assert.notEqual(modified, source);
  await writeFile(fixture, modified);
  const rejected = await verify(root, ["--group", "device"]);
  assert.equal(rejected.exitCode, 1);
  assert.ok(!JSON.stringify(rejected.report).includes("PRIVATE_DISCOVERY_CANARY"));
  for (const name of ["PRIVATE_CASE_CANARY", "native"]) {
    await writeFile(fixture, source.replace("tests:8,cases,discoveredClasses:",
      `tests:9,cases:[...cases,{name:${JSON.stringify(name)},tests:1,status:'passed'}],discoveredClasses:`));
    const invalid = await verify(root, ["--group", "device"]);
    assert.equal(invalid.exitCode, 1, "Unknown or duplicate classless cases must not qualify.");
    assert.ok(!JSON.stringify(invalid.report).includes("PRIVATE_CASE_CANARY"));
  }
  await writeFile(fixture, source);
  const plan = (await verify(root, ["--plan"])).report;
  const evidence = result.report.checks.find((check) => check.id === "android-device").deviceEvidence;
  const input = path.join(root, ".data", "case-shard.json");
  for (const name of ["PRIVATE_CASE_CANARY", "native"]) {
    const invalid = { ...evidence, tests: 9, cases: [...evidence.cases, { name, status: "passed", tests: 1 }] };
    await writeFile(input, JSON.stringify({ ...plan, status: "passed", group: "all",
      checks: plan.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0,
        ...(id === "android-device" ? { deviceEvidence: invalid } : {}) })) }));
    const aggregate = await verify(root, ["--combine", "--input", input]);
    assert.equal(aggregate.exitCode, 1);
    assert.ok(!JSON.stringify(aggregate.report).includes("PRIVATE_CASE_CANARY"));
  }
  for (const field of ["workerDiagnostics", "deviceDiagnostics"]) {
    await writeFile(input, JSON.stringify({ ...plan, status: "passed", group: "all",
      checks: plan.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0,
        ...(id === "android-device" ? { deviceEvidence: evidence, [field]: { collectionStatus: "failed" } } : {}) })) }));
    const aggregate = await verify(root, ["--combine", "--input", input]);
    assert.equal(aggregate.exitCode, 1);
    assert.equal(aggregate.report.failure.reason, "collector-failed");
    assert.equal(aggregate.report.complete, false);
  }
});

test("schema regeneration preserves a Windows checkout's unchanged source bytes", async (t) => {
  const root = await repository(t);
  const schema = (await readFile("protocol.schema.json", "utf8")).replace(/\r?\n/g, "\r\n");
  await writeFile(path.join(root, "protocol.schema.json"), schema);
  await exec(process.execPath, ["--import", "tsx", path.resolve("scripts/export-schema.ts")], { cwd: root });
  const actual = await readFile(path.join(root, "protocol.schema.json"));
  assert.equal(createHash("sha256").update(actual).digest("hex"),
    createHash("sha256").update(schema).digest("hex"), "Unchanged schema generation must preserve source bytes.");
});

test("the build prerequisite gate blocks before spending a code-repair round", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "build-android.ps1"), await readFile("scripts/build-android.ps1"));
  const result = await verify(root, ["--group", "android", "--jdk", path.join(root, "missing-jdk")]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "blocked");
  assert.equal(result.report.checks.find((check) => check.id === "android-build").status, "blocked");
  assert.equal(result.report.checks.find((check) => check.id === "android-device").status, "not_run");
});
