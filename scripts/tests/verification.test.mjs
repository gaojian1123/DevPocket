import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fileSystem, { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { CHECKS, CHECK_GROUPS, VERIFICATION_REPORT_VERSION, verificationImpact } from "../verification-policy.mjs";
import { developmentReviewRequirements, isVerificationPolicyPath } from "../development-policy.mjs";
import { syntheticExecution, verificationTools, windowsNodeLauncher } from "./fixtures/verification-tools.mjs";
import { combineVerification, verificationPlan } from "../verification.mjs";
import { openVerificationRun, readVerificationRun } from "../verification-run.mjs";
import { resolveVerificationExecutable, verificationExecutionPolicy } from "../verification-preflight.mjs";
import { capturePromotionContext, prepareVerificationTransition } from "../verification-transition.mjs";
import { WORKFLOW_TEST_FILES } from "../test-workflow.mjs";
import { committedInputsMatch, committedSourceInputs, commitSourceProjection, sourceInputs } from "../git-state.mjs";

const exec = promisify(execFile);
const entry = path.resolve("scripts/verify.mjs");
const toolchains = new Map();

async function repository(t, tools) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/verification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".data/\n.tools/\nnode_modules/\ndist/\n**/build/\n");
  await writeFile(path.join(root, "README.md"), "Original documentation\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
    "test:workflow": "node -e \"process.exit(0)\"",
    typecheck: "node -e \"process.exit(23)\"",
    test: "node -e \"process.exit(0)\"",
    build: "node -e \"process.exit(0)\"",
    schema: "node -e \"process.exit(0)\"",
  } }));
  if (tools) {
    toolchains.set(root, await verificationTools(root, tools));
    t.after(() => toolchains.delete(root));
  }
  await exec("git", ["init", "--quiet", root]);
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Fixture"], { cwd: root });
  return root;
}

async function verify(root, args, env) {
  const report = path.join(root, ".data", "verification", randomUUID(), "report.json");
  let exitCode = 0, stdout;
  const tools = toolchains.get(root);
  const environment = { ...(typeof env === "function" ? env(report) : env ?? process.env), ...tools?.env };
  const toolArgs = tools?.jdk ? [
    ...(!args.includes("--jdk") ? ["--jdk", tools.jdk] : []),
    ...(!args.includes("--sdk") ? ["--sdk", tools.sdk] : []),
  ] : [];
  try {
    ({ stdout } = await exec(process.execPath, [entry, "--repo", root, "--base", "HEAD", "--report", report, ...toolArgs, ...args],
      { timeout: 120_000, env: environment }));
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

function isolatedAdmissionEnvironment(root) {
  const env = { ...process.env, [process.platform === "win32" ? "LOCALAPPDATA" : "HOME"]: path.join(root, ".data", "fixture-profile") };
  delete env.DEVPOCKET_VERIFIER_ADMISSION;
  return env;
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
    await t.test(files.join(", "), () => {
      const impact = verificationImpact(files);
      assert.deepEqual(impact.requiredChecks, ["workflow-tests"]);
      assert.deepEqual(impact.requiredGroups, ["tooling"]);
      assert.equal(impact.layouts, false);
      assert.equal(Object.hasOwn(impact, "requiresHumanReview"), false);
      const requirements = developmentReviewRequirements(files);
      const protectedPaths = files.filter(isVerificationPolicyPath).sort();
      assert.equal(requirements.requiresHumanReview, protectedPaths.length > 0);
      assert.deepEqual(requirements.protectedPaths, protectedPaths);
      assert.deepEqual(requirements.reviewPaths, []);
      assert.deepEqual(impact.selectionReasons.flatMap((reason) => reason.paths).sort(), [...files].sort());
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
    '"verification-preflight.mjs", "verification-run.mjs", "verification-transition.mjs",',
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
  for (const [file, rule] of cases) await t.test(file, () => {
    const impact = verificationImpact([file]);
    assert.deepEqual(impact.requiredChecks, CHECKS.map((check) => check.id));
    assert.deepEqual(impact.requiredGroups, ["tooling", "backend", "android", "device"]);
    assert.equal(Object.hasOwn(impact, "requiresHumanReview"), false);
    assert.equal(developmentReviewRequirements([file]).requiresHumanReview,
      !(rule === "unknown" && file.startsWith("scripts/")));
    assert.equal(impact.layouts, true);
    assert.deepEqual(impact.selectionReasons.map((item) => item.rule), [rule]);
    assert.deepEqual(impact.selectionReasons[0].paths, [file]);
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
  ]) for (const file of files) await t.test(file, () => {
    const impact = verificationImpact([file]);
    assert.deepEqual(impact.requiredChecks, checks);
    assert.deepEqual(impact.requiredGroups, groups);
    assert.equal(impact.layouts, layouts);
    assert.deepEqual(impact.selectionReasons.map((item) => item.rule), [rule]);
    assert.equal(developmentReviewRequirements([file]).requiresHumanReview, isVerificationPolicyPath(file));
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
  ]) await t.test(file, () => {
    const impact = verificationImpact([...tooling, file]);
    assert.deepEqual(impact.requiredChecks, checks);
    assert.deepEqual(impact.requiredGroups, groups);
    assert.deepEqual(impact.requiredGroups, [...new Set(CHECKS.filter((check) => checks.includes(check.id)).map((check) => check.group))]);
    assert.equal(Object.hasOwn(impact, "requiresHumanReview"), false);
    assert.equal(developmentReviewRequirements([...tooling, file]).requiresHumanReview, true);
    assert.equal(impact.layouts, layouts);
    assert.equal(impact.selectionReasons.length, 4);
    assert.deepEqual(impact.selectionReasons.flatMap((item) => item.paths).sort(), [file, ...tooling].sort());
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
    "scripts/verification-executor.mjs", "scripts/unknown.mjs", ".github/workflows/ci.yml",
    ".github/agents/devpocket-reviewer.agent.md", "deployment/azure/package.json"]) await t.test(file, async (t) => {
    const root = await changedRepository(t, [file]), result = await verify(root, ["--plan"]);
    assert.equal(result.exitCode, 0);
    const impact = verificationImpact([file]);
    for (const key of ["requiredChecks", "requiredGroups", "layouts", "selectionReasons"]) {
      assert.deepEqual(result.report[key], impact[key]);
    }
    assert.deepEqual(result.report.changedFiles, [file]);
    const publicPlan = JSON.parse(result.stdout.split(/\r?\n/).find((line) => line.startsWith("{")));
    assert.deepEqual(Object.keys(publicPlan).sort(), ["kind", "layouts", "requiredChecks", "requiredGroups", "selectionReasons", "toolingShards"]);
    assert.deepEqual(publicPlan.requiredGroups, impact.requiredGroups);
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

test("tooling and application regression deadlines remain bounded without masking slow tests", async () => {
  const [executor, backend, android, ci] = await Promise.all([
    "scripts/verification-executor.mjs", "scripts/verification-backend.mjs",
    "scripts/verification-android.mjs", ".github/workflows/ci.yml",
  ].map((file) => readFile(file, "utf8")));
  assert.match(executor, /definition\.group === "tooling" \? \{[\s\S]*?timeoutMs: 30 \* 60_000, graceMs: 5000/);
  assert.match(backend, /timeoutMs: 30 \* 60_000/);
  assert.match(android, /timeoutMs: 30 \* 60_000/);
  const tooling = ci.replaceAll("\r\n", "\n").split("\n  tooling:")[1].split("\n  backend:")[0];
  assert.match(tooling, /timeout-minutes: 30/);
  assert.ok(tooling.includes("'--group', 'tooling'"));
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
    ["origin-optional report", { version: 3 }, "policy-mismatch"],
    ["missing execution", { checks: [{ ...current.checks[0], execution: undefined }] }, "execution-origin"],
    ["missing execution source", { checks: [{ ...current.checks[0], execution: {} }] }, "execution-origin"],
    ["invalid execution time", { checks: [{ ...current.checks[0], execution: {
      ...current.checks[0].execution, completedAt: "2026-13-01T00:00:00.000Z" } }] }, "execution-origin"],
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
          ? { id, status: "not_run" } : { id, status: "passed", exitCode: 0, execution: syntheticExecution(plan.source),
            ...(id === "android-device" ? { deviceEvidence } : {}) }) }));
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
  const root = await repository(t, { operations: true }), directory = path.join(root, ".data");
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
    const root = await repository(t, { native: true }), scripts = path.join(root, "scripts");
    await mkdir(scripts);
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
    const jdk = path.join(root, ".data", "literal jdk ' &"), sdk = path.join(root, ".data", "literal sdk ' &");
    await verificationTools(root, { native: true, jdk, sdk });
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
  const root = await repository(t, { operations: true });
  await writeFile(path.join(root, "deployment", "azure", "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
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
    checks: [{ id: "android-build", status: "passed", exitCode: 0, execution: syntheticExecution(planned.source) },
      { id: "android-device", status: "not_run" }],
  };
  await writeFile(input, JSON.stringify(shard));
  let result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.complete, false);
  assert.match(result.report.error, /android-device/);
  await writeFile(input, JSON.stringify({
    ...shard, group: "all", status: "passed", complete: true,
    checks: planned.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0, execution: syntheticExecution(planned.source),
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
    checks: plan.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0, execution: syntheticExecution(plan.source) })) }));
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
      execution: { ...syntheticExecution(plan.source), privateOrigin: "PRIVATE_AGGREGATE_CANARY" },
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
    checks: plan.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0, execution: syntheticExecution(plan.source),
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
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Source failure fixture"], { cwd: root });
  await mkdir(path.join(root, "backend", "tests"), { recursive: true });
  await writeFile(path.join(root, "backend", "tests", "fixture.ts"), "// fixture\n");
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
  const root = await repository(t, { native: true });
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
  const root = await repository(t, { native: true });
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
  const root = await repository(t, { native: true });
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
  assert.match(device, /name: device-test-diagnostics-attempt-\$\{\{ github\.run_attempt \}\}\n\s+path: \.data\/ci\/device\/device-diagnostics\.json/);
});

test("blocked worker diagnostics stay scoped and cannot publish raw process fields", async (t) => {
  const root = await repository(t, { native: true });
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
  const root = await repository(t, { native: true });
  await writeFile(path.join(root, ".gitignore"), ".data/\n.tools/\nnode_modules/\ndist/\n*.jar\n**/build/\nandroid/app/src/main/java/build\n");
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
  const root = await repository(t, { native: true });
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
    group: "device", directory, signal: controller.signal, ...toolchains.get(root),
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
  const root = await repository(t, { native: true });
  await mkdir(path.join(root, "scripts"));
  const module = pathToFileURL(path.resolve("scripts/verification.mjs")).href;
  await writeFile(path.join(root, "scripts", "device-fixture.mjs"), [
    "import {mkdir,writeFile} from 'node:fs/promises'; import path from 'node:path'; import {createHash} from 'node:crypto';",
    `import {sourceSnapshot} from ${JSON.stringify(module)};`,
    "const [directory,runId]=process.argv.slice(2); await mkdir(directory);",
    "await writeFile(path.join(directory,'owner.json'),JSON.stringify({version:1,root:process.cwd(),runId,pid:process.pid}));",
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
      checks: plan.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0, execution: syntheticExecution(plan.source),
        ...(id === "android-device" ? { deviceEvidence: invalid } : {}) })) }));
    const aggregate = await verify(root, ["--combine", "--input", input]);
    assert.equal(aggregate.exitCode, 1);
    assert.ok(!JSON.stringify(aggregate.report).includes("PRIVATE_CASE_CANARY"));
  }
  for (const field of ["workerDiagnostics", "deviceDiagnostics"]) {
    await writeFile(input, JSON.stringify({ ...plan, status: "passed", group: "all",
      checks: plan.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0, execution: syntheticExecution(plan.source),
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

async function recoveryFixture(t, { candidate = false, sensitive = false } = {}) {
  const primary = await repository(t);
  let root = primary;
  if (candidate) {
    await exec("git", ["config", "core.autocrlf", "false"], { cwd: primary });
    root = `${primary}-linked`;
    await exec("git", ["worktree", "add", "--quiet", "-b", "candidate-fixture", root], { cwd: primary });
    t.after(() => rm(root, { recursive: true, force: true }));
    await exec("git", ["config", "user.name", "Fixture"], { cwd: root });
    await exec("git", ["config", "user.email", "fixture@example.test"], { cwd: root });
  }
  await mkdir(path.join(root, ".data"), { recursive: true });
  await writeFile(path.join(root, "fixture.mjs"), [
    "import {appendFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';",
    "const id=process.argv[2];appendFileSync('.data/counts.jsonl',JSON.stringify(id)+'\\n');",
    "if(id==='backend-build'){mkdirSync('dist',{recursive:true});writeFileSync('dist/result.js','stable build');}",
    "if(existsSync('.data/fail-'+id))process.exit(23);",
    "if(id==='typecheck'&&existsSync('.data/wait')){writeFileSync('.data/started','yes');",
    "while(!existsSync('.data/release'))await new Promise(resolve=>setTimeout(resolve,25));}", "",
  ].join("\n"));
  const script = (id) => `node fixture.mjs ${id}`;
  const manifest = { scripts: {
    "test:workflow": script("tooling"), typecheck: script("typecheck"), test: script("backend-tests"),
    build: script("backend-build"), schema: script("schema"),
  } };
  if (candidate) {
    manifest.devDependencies = { typescript: "5.8.3" };
    manifest.scripts.typecheck = "tsc -p backend/tsconfig.json --noEmit && tsc -p backend/tsconfig.cli-proof.json" +
      (sensitive ? " && node fixture.mjs head-sensitive" : "");
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
      "": { devDependencies: manifest.devDependencies }, "node_modules/typescript": { version: "5.8.3" },
    } }));
    for (const dependency of ["typescript", "@types", "undici-types"]) {
      await cp(path.resolve("node_modules", dependency), path.join(root, "node_modules", dependency),
        { recursive: true, verbatimSymlinks: true });
    }
    await mkdir(path.join(root, "node_modules", ".bin"));
    for (const name of (await readdir(path.resolve("node_modules", ".bin"))).filter((name) => /^tsc(?:\.|$)/.test(name))) {
      await cp(path.resolve("node_modules", ".bin", name), path.join(root, "node_modules", ".bin", name),
        { verbatimSymlinks: true });
    }
    for (const directory of ["src", "integration"]) await mkdir(path.join(root, "backend", directory), { recursive: true });
    for (const config of ["tsconfig.json", "tsconfig.cli-proof.json"]) {
      await copyFile(path.resolve("backend", config), path.join(root, "backend", config));
    }
    await writeFile(path.join(root, "backend", "src", "fixture.ts"), "export {};\n");
    await writeFile(path.join(root, "backend", "integration", "cli-proof.ts"), "export {};\n");
  }
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Observable verification fixtures"], { cwd: root });
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await mkdir(path.join(root, "backend", "tests"), { recursive: true });
  await writeFile(path.join(root, "backend", "tests", "change.test.ts"), "// task input\n");
  const counts = async () => {
    let text;
    try { text = await readFile(path.join(root, ".data", "counts.jsonl"), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
    const result = {};
    for (const line of text.trim().split("\n").filter(Boolean)) {
      const id = JSON.parse(line); result[id] = (result[id] ?? 0) + 1;
    }
    return result;
  };
  return { root, base, counts };
}

async function recordedVerification(root, base, { promotion = false } = {}) {
  const plan = await verificationPlan(root, base);
  assert.ok(plan.requiredChecks.every((id) => ["tooling", "backend"].includes(CHECKS.find((check) => check.id === id).group)),
    "Ledger fixtures do not manufacture native acceptance.");
  const directory = path.join(root, ".data", "verification", randomUUID());
  const policy = await verificationExecutionPolicy();
  const run = await openVerificationRun(root, plan, { directory }, policy,
    promotion ? await capturePromotionContext(root, plan) : null);
  const checks = plan.requiredChecks.map((id) => ({
    id, status: "passed", exitCode: 0, durationMs: 1, execution: syntheticExecution(plan.source), executionState: "exited",
    privateLog: { availability: "retained" },
    commandOutcome: { observedProcess: "owned-command-supervisor", reason: "exit", exitCode: 0, cleanupFailure: null },
  }));
  const environment = "e".repeat(64), artifacts = { available: true, fingerprint: "f".repeat(64) };
  // Data-only contract fixtures use the real signed ledger; separate integration cases execute commands.
  for (const group of plan.requiredGroups) await run.record({
    ...plan, group, status: "partial", complete: false,
    checks: checks.map((check) => CHECKS.find((item) => item.id === check.id).group === group
      ? check : { id: check.id, status: "not_run" }),
  }, environment, artifacts, true);
  const report = { ...plan, group: "all", status: "passed", complete: true, checks, run: run.reference, fixtureEvidence: true };
  combineVerification(plan, [report]);
  await run.finish(report, true, plan.requiredGroups);
  const reportPath = path.join(directory, "report.json");
  await writeFile(reportPath, JSON.stringify(report), { flag: "wx" });
  return { root, base, plan, report, reportPath, policy, environment, artifacts };
}

test("explicit recovery reuses a completed group, reruns failed and unstarted checks, and preserves failed evidence", async (t) => {
  const { root, counts } = await recoveryFixture(t);
  const marker = path.join(root, ".data", "fail-typecheck");
  await writeFile(marker, "environment outage");
  const first = await verify(root, []);
  assert.equal(first.report.status, "failed", JSON.stringify(first.report));
  assert.deepEqual(await counts(), { tooling: 1, typecheck: 1 });
  const reusable = first.report.preflight.groups.find((group) => group.group === "tooling").reusable;
  const original = await readFile(first.reportPath);
  const directory = path.dirname(path.resolve(root, first.report.run.manifest));
  const failedGroup = await readFile(path.join(directory, "0001-backend.json"));
  assert.equal(JSON.parse(failedGroup).record.report.status, "failed");
  await t.test("a deterministic failing group is retried once only per explicit resume", async () => {
    const repeated = await verify(root, ["--resume", first.report.run.manifest]);
    assert.equal(repeated.report.status, "failed");
    assert.deepEqual(await counts(), { tooling: reusable ? 1 : 2, typecheck: 2 });
    if (!reusable) assert.ok(repeated.report.recovery.invalidated.some((item) =>
      item.group === "tooling" && item.reason === "environment-unbound"));
  });
  await rm(marker);
  const second = await verify(root, ["--resume", first.report.run.manifest]);
  assert.equal(second.exitCode, 0, JSON.stringify(second.report));
  assert.equal(second.report.complete, true);
  assert.deepEqual(second.report.recovery.reused, reusable ? [{ group: "tooling", attempt: "0001" }] : []);
  assert.deepEqual(second.report.recovery.executed, reusable ? ["backend"] : ["tooling", "backend"]);
  assert.deepEqual(await counts(), { tooling: reusable ? 1 : 3, typecheck: 3, "backend-tests": 1, "backend-build": 1, schema: 1 });
  assert.deepEqual(await readFile(first.reportPath), original);
  assert.deepEqual(await readFile(path.join(directory, "0001-backend.json")), failedGroup);
  assert.equal((await verify(root, ["--combine", "--input", first.reportPath])).exitCode, 1);
  assert.equal((await verify(root, ["--combine", "--input", second.reportPath])).report.complete, true);
});

test("ordinary aggregates retain execution origins and reject a HEAD-only relabel or stripped origins", async (t) => {
  const { root, base } = await recoveryFixture(t);
  const first = await recordedVerification(root, base);
  assert.equal(first.report.status, "passed", JSON.stringify(first.report));
  const once = await verify(root, ["--combine", "--input", first.reportPath]);
  const twice = await verify(root, ["--combine", "--input", once.reportPath]);
  assert.equal(twice.report.complete, true);
  assert.deepEqual(twice.report.checks.map((check) => check.execution), first.report.checks.map((check) => check.execution));
  const bytes = await readFile(once.reportPath);
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Identical verified fixture inputs"], { cwd: root });
  const candidate = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const input = path.join(root, ".data", "relabeled-report.json");
  for (const kind of ["head-only", "origins-removed", "legacy"]) {
    const forged = structuredClone(twice.report);
    forged.source.head = candidate;
    if (kind === "origins-removed") for (const check of forged.checks) delete check.execution;
    if (kind === "legacy") forged.version = 3;
    await writeFile(input, JSON.stringify(forged));
    const result = await verify(root, ["--base", base, "--combine", "--input", input]);
    assert.equal(result.report.status, "blocked", JSON.stringify(result.report));
    assert.equal(result.report.failure.reason, kind === "head-only" ? "candidate-evidence-required"
      : kind === "origins-removed" ? "execution-origin" : "policy-mismatch");
  }
  assert.deepEqual(await readFile(once.reportPath), bytes);
});

test("failed or unknown device-data cleanup retains the owner and blocks recovery after confirmed process exit", async (t) => {
  for (const kind of ["failed", "unknown"]) await t.test(kind, async (t) => {
    const root = await repository(t, { native: true });
    const env = isolatedAdmissionEnvironment(root);
    await mkdir(path.join(root, "scripts"));
    await writeFile(path.join(root, "scripts", "test-android.ps1"), [
      "param($Jdk,$Sdk,$Image,$RunDirectory,$Owner,[switch]$Layouts)",
      "Add-Content -LiteralPath '.data/device-count' -Value 'called'",
      "New-Item -ItemType Directory -Path (Join-Path $RunDirectory 'fixture') -Force | Out-Null",
      "Set-Content -LiteralPath (Join-Path $RunDirectory 'fixture\\retained.txt') -Value 'retained'",
      ...(kind === "failed" ? [
        "@{version=1;root=(Get-Location).Path;runId='00000000-0000-4000-8000-000000000000';pid=$PID} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RunDirectory 'owner.json')",
      ] : []),
      "exit 23", "",
    ].join("\n"));
    const first = await verify(root, ["--group", "device"], env);
    const check = first.report.checks.find((item) => item.id === "android-device");
    assert.equal(check.cleanup, kind);
    assert.equal(check.commandOutcome.cleanupFailure, null);
    assert.equal(first.report.admission.state, "released", "Confirmed stopped processes must not reserve another workspace's host capacity.");
    const run = path.dirname(path.resolve(root, first.report.run.manifest));
    const finish = JSON.parse(await readFile(path.join(run, "0001-finish.json"), "utf8")).record;
    assert.equal(finish.safeToResume, false);
    const second = await verify(root, ["--group", "device", "--resume", first.report.run.manifest], env);
    assert.equal(second.report.failure.reason, "run-locked");
    const retained = path.join(path.dirname(first.reportPath), "device", "fixture", "retained.txt");
    assert.equal((await readFile(retained, "utf8")).trim(), "retained");
    // Explicit fixture-only inspection cannot turn the original incomplete receipt into resumable evidence.
    await rm(path.join(root, ".data", "verification", "local", "execution.lock"));
    const inspected = await verify(root, ["--group", "device", "--resume", first.report.run.manifest], env);
    assert.equal(inspected.report.failure.reason, "run-incomplete");
    assert.equal((await readFile(path.join(root, ".data", "device-count"), "utf8")).trim().split(/\r?\n/).length, 1);
    const other = await changedRepository(t, ["scripts/tests/unrelated.test.mjs"]);
    const independent = await verify(other, ["--group", "tooling"], env);
    assert.equal(independent.exitCode, 0, JSON.stringify(independent.report));
    assert.equal(independent.report.status, "partial");
    assert.equal(independent.report.checks.find((item) => item.id === "workflow-tests").status, "passed");
    assert.equal(independent.report.admission.state, "released");
  });
});

test("unconfirmed process cleanup retains host capacity even before a check starts", async (t) => {
  const root = await changedRepository(t, ["scripts/tests/ownership.test.mjs"]);
  const env = isolatedAdmissionEnvironment(root), home = process.platform === "win32" ? "LOCALAPPDATA" : "HOME";
  const previous = new Map([home, "DEVPOCKET_VERIFIER_ADMISSION"].map((name) => [name, process.env[name]]));
  const spawn = childProcess.spawn;
  let intercepted = 0;
  const replacement = t.mock.method(childProcess, "spawn", (file, args, options) => {
    if (args.some((arg) => /owned-command-(?:windows\.mjs|linux\.py)$/.test(arg))) {
      intercepted++;
      return spawn(process.execPath, ["-e", "process.exit(0)"], options);
    }
    return spawn(file, args, options);
  });
  syncBuiltinESMExports();
  process.env[home] = env[home];
  delete process.env.DEVPOCKET_VERIFIER_ADMISSION;
  try {
    const { executeVerification } = await import("../verification.mjs");
    const result = await executeVerification(root, await verificationPlan(root, "HEAD"), {
      group: "tooling", directory: path.join(root, ".data", "verification", "unknown-process"),
    });
    assert.ok(intercepted > 0, JSON.stringify(result));
    assert.equal(result.status, "blocked");
    assert.equal(result.admission.state, "unconfirmed");
    assert.ok(result.preflight.groups[0].issues.some((issue) =>
      issue.failure.observedProcess === "owned-command-supervisor" && issue.failure.processTreeStopped === false));
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const other = await changedRepository(t, ["scripts/tests/unrelated.test.mjs"]);
  const blocked = await verify(other, ["--group", "tooling"], env);
  assert.equal(blocked.report.failure.reason, "admission-unconfirmed");
});

test("a fresh signed run survives Windows close-time metadata updates without accepting changed records", async (t) => {
  const root = await repository(t);
  const first = await verify(root, []);
  assert.equal(first.report.status, "passed", JSON.stringify(first.report));
  const resumed = await verify(root, ["--resume", first.report.run.manifest]);
  assert.equal(resumed.report.status, "passed", JSON.stringify(resumed.report));
  const file = path.join(path.dirname(path.resolve(root, first.report.run.manifest)), "0001-finish.json");
  const bytes = await readFile(file);
  await writeFile(file, Buffer.from(bytes.toString().replace('"passed"', '"failed"')));
  const invalid = await verify(root, ["--resume", first.report.run.manifest]);
  assert.equal(invalid.report.status, "blocked");
  assert.equal(invalid.report.failure.reason, "run-untrusted");
});

test("preflight preserves cancellation and owned-process cleanup evidence rather than wrapping it away", async (t) => {
  const { verificationPlan } = await import("../verification.mjs");
  const { verificationPreflight } = await import("../verification-preflight.mjs");
  const { root } = await recoveryFixture(t), cancellation = new AbortController();
  cancellation.abort();
  const result = await verificationPreflight(root, await verificationPlan(root, "HEAD"), {
    directory: path.join(root, ".data", "verification", "preflight-cancel"), group: "tooling", signal: cancellation.signal,
  });
  assert.equal(result.status, "blocked");
  const failures = result.groups.flatMap((group) => group.issues.map((issue) => issue.failure));
  assert.ok(failures.some((failure) => failure.reason === "command-cancelled" &&
    failure.observedProcess === "owned-command-supervisor" && failure.processTreeStopped === true), JSON.stringify(failures));
});

test("recovery rejects changed HEAD, source bytes, base, requirements and selected group before execution", async (t) => {
  const { root, base, counts } = await recoveryFixture(t);
  const first = await recordedVerification(root, base);
  assert.equal(first.report.status, "passed", JSON.stringify(first.report));
  const file = path.join(root, "backend", "tests", "change.test.ts"), original = await readFile(file);
  for (const change of ["source", "base", "requirements", "group", "HEAD"]) await t.test(change, async () => {
    const before = await counts();
    if (change === "HEAD") await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "commit", "--quiet", "--allow-empty", "-m", "Different HEAD"], { cwd: root });
    if (change === "source") await writeFile(file, "// changed input\n");
    try {
      const plan = await verificationPlan(root, change === "base" ? `${base}^` : base, change === "requirements");
      await assert.rejects(openVerificationRun(root, plan, {
        directory: path.join(root, ".data", "verification", randomUUID()), resume: first.report.run.manifest,
        ...(change === "group" ? { group: "backend" } : {}),
      }, first.policy), (error) => ["source-mismatch", "policy-mismatch"].includes(error.diagnosticCode));
      assert.deepEqual(await counts(), before);
    } finally { if (change === "source") await writeFile(file, original); }
  });
});

test("missing, altered and unfinished records cannot be reinterpreted as successful shards", async (t) => {
  const { root, base, counts } = await recoveryFixture(t);
  const first = await recordedVerification(root, base);
  const directory = path.dirname(path.resolve(root, first.report.run.manifest));
  const originals = await Promise.all(["0001-tooling.json", "0001-finish.json", "run.json"].map(async (name) =>
    [path.join(directory, name), await readFile(path.join(directory, name))]));
  for (const change of ["missing", "signature", "unfinished", "legacy"]) await t.test(change, async () => {
    const before = await counts();
    if (change === "missing") await rm(path.join(directory, "0001-tooling.json"));
    if (change === "unfinished") await rm(path.join(directory, "0001-finish.json"));
    if (change === "signature") {
      const file = path.join(directory, "0001-tooling.json"), value = JSON.parse(await readFile(file, "utf8"));
      value.record.report.checks[0].durationMs++;
      await writeFile(file, JSON.stringify(value));
    }
    if (change === "legacy") await writeFile(path.join(directory, "run.json"), JSON.stringify(first.report));
    try {
      await assert.rejects(readVerificationRun(root, first.report.run.manifest));
      if (change === "signature") {
        const result = await verify(root, ["--resume", first.report.run.manifest]);
        assert.equal(result.report.status, "blocked");
        assert.equal(result.report.complete, false);
      }
      assert.deepEqual(await counts(), before);
    } finally { for (const [file, bytes] of originals) await writeFile(file, bytes); }
  });
});

test("removing a complete suffix of run history cannot roll evidence back to an older success", async (t) => {
  const { root, base, counts } = await recoveryFixture(t);
  const first = await recordedVerification(root, base);
  const second = await openVerificationRun(root, first.plan, {
    directory: path.join(root, ".data", "verification", randomUUID()), resume: first.report.run.manifest,
  }, first.policy);
  await second.finish({ ...first.report, run: second.reference }, true, first.plan.requiredGroups);
  const before = await counts(), directory = path.dirname(path.resolve(root, first.report.run.manifest));
  for (const name of await readdir(directory)) if (name.startsWith("0002-")) await rm(path.join(directory, name));
  await assert.rejects(readVerificationRun(root, first.report.run.manifest), { diagnosticCode: "run-incomplete" });
  assert.deepEqual(await counts(), before);
});

test("terminal qualification invalidates only unconfirmed groups and cannot revive them by matching old hashes", async (t) => {
  const { root, base } = await recoveryFixture(t);
  const first = await recordedVerification(root, base);
  const second = await openVerificationRun(root, first.plan, {
    directory: path.join(root, ".data", "verification", randomUUID()), resume: first.report.run.manifest,
  }, first.policy);
  await second.finish({ ...first.report, run: second.reference, status: "blocked", complete: false,
    failure: { reason: "environment-changed", group: "tooling" } }, true, ["backend"]);
  const third = await openVerificationRun(root, first.plan, {
    directory: path.join(root, ".data", "verification", randomUUID()), resume: first.report.run.manifest,
  }, first.policy);
  assert.deepEqual(await third.reusable("tooling", first.environment, first.artifacts, true),
    { status: "invalidated", reason: "environment-changed" });
  assert.equal((await third.reusable("backend", first.environment, first.artifacts, true)).status, "reused");
  await assert.rejects(third.finish(first.report, true), { diagnosticCode: "run-invalid" });
});

test("observed environment drift cannot be erased by restoring the initial dependency bytes", async (t) => {
  const root = await repository(t), dependency = path.join(root, "node_modules", "fixture");
  await mkdir(dependency, { recursive: true });
  await writeFile(path.join(dependency, "package.json"), JSON.stringify({ version: "1.0.0" }));
  const flag = path.join(dependency, "flag");
  await writeFile(flag, "fail");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    dependencies: { fixture: "1.0.0" }, scripts: { "test:workflow": "node workflow.mjs" },
  }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
    "": { dependencies: { fixture: "1.0.0" } }, "node_modules/fixture": { version: "1.0.0" },
  } }));
  await writeFile(path.join(root, "workflow.mjs"), [
    "import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';",
    "appendFileSync('.data/count','called\\n');writeFileSync('.data/ready','yes');",
    "while(!existsSync('.data/release'))await new Promise(resolve=>setTimeout(resolve,20));",
    "if(readFileSync('node_modules/fixture/flag','utf8')!=='pass')process.exit(23);", "",
  ].join("\n"));
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Environment drift fixture"], { cwd: root });
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "workflow-extension.mjs"), "// select tooling\n");
  const running = verify(root, []);
  let ready = false, first;
  try {
    for (let attempt = 0; attempt < 800; attempt++) {
      try { await readFile(path.join(root, ".data", "ready")); ready = true; break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    await writeFile(flag, "pass");
  } finally {
    await writeFile(path.join(root, ".data", "release"), "release");
    first = await running;
  }
  assert.equal(first.report.failure.reason, "environment-changed");
  assert.equal(first.report.failure.prerequisite, "root-dependencies");
  assert.equal(first.report.checks[0].status, "passed");
  const bytes = await readFile(first.reportPath);
  const finish = JSON.parse(await readFile(path.join(path.dirname(first.reportPath), "run", "0001-finish.json"), "utf8")).record;
  assert.deepEqual(finish.qualifiedGroups, []);
  await writeFile(flag, "fail");
  const resumed = await verify(root, ["--resume", first.report.run.manifest]);
  assert.equal(resumed.report.status, "failed", JSON.stringify(resumed.report));
  assert.equal(resumed.report.checks[0].exitCode, 23);
  assert.deepEqual(resumed.report.recovery.reused, []);
  assert.equal(resumed.report.recovery.invalidated[0].reason, "environment-changed");
  assert.equal((await readFile(path.join(root, ".data", "count"), "utf8")).trim().split("\n").length, 2);
  assert.deepEqual(await readFile(first.reportPath), bytes);
});

test("changed applicable environment and missing build artifacts explicitly invalidate successful groups", async (t) => {
  const { root, base, counts } = await recoveryFixture(t);
  const first = await recordedVerification(root, base), original = await readFile(first.reportPath);
  const next = () => openVerificationRun(root, first.plan, {
    directory: path.join(root, ".data", "verification", randomUUID()), resume: first.report.run.manifest,
  }, first.policy);
  const second = await next(), environment = "a".repeat(64);
  await t.test("environment", async () => {
    for (const group of first.plan.requiredGroups) {
      assert.equal((await second.reusable(group, first.environment, first.artifacts, true)).status, "reused");
      assert.deepEqual(await second.reusable(group, environment, first.artifacts, true),
        { status: "invalidated", reason: "environment-changed" });
      await second.record({ ...first.report, group, status: "partial", complete: false,
        run: second.reference, checks: first.report.checks.map((check) =>
          CHECKS.find((item) => item.id === check.id).group === group ? check : { id: check.id, status: "not_run" }),
      }, environment, first.artifacts, true);
    }
    await second.finish({ ...first.report, run: second.reference }, true, first.plan.requiredGroups);
  });
  const third = await next();
  await t.test("artifact", async () => {
    const current = await third.reusable("backend", environment, first.artifacts, true);
    assert.equal(current.status, "reused");
    assert.equal(current.attempt, second.reference.attempt);
    for (const artifacts of [{ available: false }, { available: true, fingerprint: "b".repeat(64) }]) {
      assert.deepEqual(await third.reusable("backend", environment, artifacts, true),
        { status: "invalidated", reason: "artifact-changed" });
      const unaffected = await third.reusable("tooling", environment, first.artifacts, true);
      assert.equal(unaffected.status, "reused");
      assert.equal(unaffected.attempt, second.reference.attempt, "Use the newly qualified environment checkpoint.");
    }
  });
  await third.finish({ ...first.report, run: third.reference, status: "blocked", complete: false,
    checks: first.plan.requiredChecks.map((id) => ({ id, status: "not_run" })) }, true);
  assert.deepEqual(await readFile(first.reportPath), original);
  assert.deepEqual(await counts(), {});
});

test("a concurrent resume cannot acquire the workspace outputs or start another check", async (t) => {
  const { root, counts } = await recoveryFixture(t);
  await writeFile(path.join(root, ".data", "wait"), "wait");
  const report = path.join(root, ".data", "verification", "concurrent", "report.json");
  const running = exec(process.execPath, [entry, "--repo", root, "--base", "HEAD", "--report", report], { timeout: 120000 });
  let started = false;
  try {
    for (let attempt = 0; attempt < 800; attempt++) {
      try { await readFile(path.join(root, ".data", "started")); started = true; break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(started, true);
    const result = await verify(root, ["--resume", path.join(path.dirname(report), "run", "run.json")]);
    assert.equal(result.report.failure.reason, "run-locked");
    assert.deepEqual(await counts(), { tooling: 1, typecheck: 1 });
  } finally {
    await writeFile(path.join(root, ".data", "release"), "release");
    await running;
  }
});

test("an interrupted owner is not automatically reclaimed even after its process has exited", async (t) => {
  const { root, base, counts } = await recoveryFixture(t);
  const first = await recordedVerification(root, base);
  const lock = path.join(root, ".data", "verification", "local", "execution.lock");
  await writeFile(lock, JSON.stringify({ version: 1, pid: 2147483647, owner: randomUUID() }));
  const result = await verify(root, ["--resume", first.report.run.manifest]);
  assert.equal(result.report.failure.reason, "run-locked");
  assert.deepEqual(await counts(), {});
  assert.ok((await readFile(lock, "utf8")).includes("2147483647"));
});

test("resume rejects path aliases rather than reading or replacing another run", async (t) => {
  const { root, base, counts } = await recoveryFixture(t);
  const first = await recordedVerification(root, base), before = await counts();
  const alias = path.join(root, ".data", "verification", "alias");
  await symlink(path.dirname(path.resolve(root, first.report.run.manifest)), alias, process.platform === "win32" ? "junction" : "dir");
  const result = await verify(root, ["--resume", path.join(alias, "run.json")]);
  assert.equal(result.report.status, "blocked");
  assert.equal(result.report.failure.reason, "ownership-mismatch");
  assert.deepEqual(await counts(), before);
});

test("a checkout alias shares the physical verification owner without allowing linked evidence directories", async (t) => {
  const { root, counts } = await recoveryFixture(t), alias = `${root}-alias`;
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  t.after(() => rm(alias, { recursive: true, force: true }));
  const first = await verify(root, ["--group", "tooling"]);
  assert.equal(first.report.status, "partial", JSON.stringify(first.report));
  const resumed = await verify(alias, ["--group", "tooling", "--resume", first.report.run.manifest]);
  assert.equal(resumed.report.status, "partial", JSON.stringify(resumed.report));
  const reusable = first.report.preflight.groups[0].reusable;
  assert.deepEqual(await counts(), { tooling: reusable ? 1 : 2 });
  assert.deepEqual(resumed.report.recovery.reused, reusable ? [{ group: "tooling", attempt: "0001" }] : []);
  if (!reusable) assert.equal(resumed.report.recovery.invalidated[0].reason, "environment-unbound");
  if (process.platform === "win32") {
    const previous = path.dirname(first.reportPath);
    const output = path.join(path.dirname(previous), path.basename(previous).toUpperCase(), "same-output.json");
    await assert.rejects(exec(process.execPath, [entry, "--repo", root, "--base", "HEAD", "--group", "tooling",
      "--resume", first.report.run.manifest, "--report", output], { timeout: 30000 }), (error) => error.code === 1);
    assert.equal(JSON.parse(await readFile(output, "utf8")).failure.reason, "run-output-reused");
  }
  const linked = path.join(root, ".data", "verification", "evidence-link");
  await symlink(path.dirname(path.resolve(root, first.report.run.manifest)), linked, process.platform === "win32" ? "junction" : "dir");
  const rejected = await verify(alias, ["--group", "tooling", "--resume", path.join(linked, "run.json")]);
  assert.equal(rejected.report.status, "blocked");
  assert.equal(rejected.report.failure.reason, "ownership-mismatch");
});
test("selected-group preflight blocks missing dependencies and SDKs before any expensive check", async (t) => {
  for (const missing of ["dependency", "sdk"]) await t.test(missing, async (t) => {
    const { root, counts } = await recoveryFixture(t);
    if (missing === "dependency") {
      const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
      manifest.dependencies = { "missing-fixture": "1.0.0" };
      await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
    } else {
      await mkdir(path.join(root, "scripts"));
      await writeFile(path.join(root, "scripts", "verification-executor.mjs"), "// select shared execution\n");
    }
    const result = await verify(root, missing === "dependency" ? ["--group", "tooling"] : []);
    assert.equal(result.report.status, "blocked", JSON.stringify(result.report));
    assert.equal(result.report.preflight.status, "blocked");
    assert.ok(result.report.preflight.groups.some((item) => item.issues.some((issue) =>
      issue.prerequisite === (missing === "dependency" ? "root-dependencies" : "jdk"))));
    assert.deepEqual(await counts(), {});
    assert.ok(result.report.checks.every((check) => !check.execution));
  });
});

test("missing SDK package metadata blocks before executing the native build", async (t) => {
  const root = await repository(t, { native: true }), tools = toolchains.get(root);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "build-android.ps1"), [
    "param($Jdk,$Sdk,[switch]$Lint,[switch]$Instrumentation)",
    "Set-Content -LiteralPath '.data/native-ran' -Value 'yes'", "",
  ].join("\n"));
  await rm(path.join(tools.sdk, "build-tools", "35.0.0", "package.xml"));
  const result = await verify(root, ["--group", "android"]);
  assert.equal(result.report.status, "blocked", JSON.stringify(result.report));
  assert.ok(result.report.preflight.groups[0].issues.some((issue) => issue.prerequisite === "android-platform-35"));
  assert.equal(result.report.checks.find((item) => item.id === "android-build").executionState, "not-started");
  await assert.rejects(readFile(path.join(root, ".data", "native-ran")), { code: "ENOENT" });
});

test("hosted JDK aliases need a self-contained prepared tree, not weaker preflight", async (t) => {
  const { verificationPreflight } = await import("../verification-preflight.mjs");
  const root = await repository(t, { native: true }), tools = toolchains.get(root);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "build-android.ps1"), "# never executed\n");
  const alias = path.join(root, ".data", "jdk-cache"), store = path.join(root, ".data", "trust-store");
  await mkdir(store);
  await writeFile(path.join(store, "cacerts"), "fixture-trust-store");
  await mkdir(path.join(tools.jdk, "lib"));
  await symlink(store, path.join(tools.jdk, "lib", "security"), process.platform === "win32" ? "junction" : "dir");
  await symlink(tools.jdk, alias, process.platform === "win32" ? "junction" : "dir");
  const plan = await verificationPlan(root, "HEAD", true);
  const preflight = (jdk) => verificationPreflight(root, plan, {
    group: "android", jdk, sdk: tools.sdk, directory: path.join(root, ".data", "verification", "jdk-preflight"),
  });
  for (const jdk of [alias, tools.jdk]) {
    const blocked = await preflight(jdk);
    assert.equal(blocked.status, "blocked");
    assert.ok(blocked.groups[0].issues.some((issue) => issue.prerequisite === "jdk" && issue.failure.reason === "preflight-path"));
  }
  const snapshot = path.join(root, ".data", "jdk-snapshot");
  await cp(tools.jdk, snapshot, { recursive: true, dereference: true });
  assert.equal((await preflight(snapshot)).status, "passed");
  assert.equal(await readFile(path.join(store, "cacerts"), "utf8"), "fixture-trust-store");
  const action = await readFile(".github/actions/prepare-native/action.yml", "utf8");
  assert.match(action, /Snapshot the selected JDK for bounded verification/);
  assert.ok(action.indexOf("Snapshot the selected JDK") < action.indexOf("Prepare hosted KVM"));
  assert.match(action, /native-platform-diagnostics-attempt-\$\{\{ github\.run_attempt \}\}/);
});

test("tooling-only preflight never inspects unrelated Java, SDK, image or probe-Python settings", async (t) => {
  const { verificationPreflight } = await import("../verification-preflight.mjs");
  const { root, counts } = await recoveryFixture(t);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "verification-executor.mjs"), "// select all downstream checks\n");
  const plan = await verificationPlan(root, "HEAD");
  assert.deepEqual(plan.requiredGroups, CHECK_GROUPS);
  const settings = {
    DEVPOCKET_JDK: "missing-jdk", DEVPOCKET_ANDROID_SDK: "missing-sdk",
    DEVPOCKET_ANDROID_IMAGE: "invalid-image", DEVPOCKET_PROBE_PYTHON: "missing-python",
  };
  const original = new Map([...Object.keys(settings), "TZ"].map((name) => [name, process.env[name]]));
  Object.assign(process.env, settings);
  const preflight = () => verificationPreflight(root, plan, {
    group: "tooling", directory: path.join(root, ".data", "verification", "tooling-prerequisites"),
  });
  try {
    const before = await preflight();
    process.env.TZ = process.env.TZ === "UTC" ? "Etc/UTC" : "UTC";
    const after = await preflight();
    for (const result of [before, after]) {
      assert.equal(result.status, "passed", JSON.stringify(result));
      assert.deepEqual(result.groups.map((item) => item.group), ["tooling"]);
    }
    assert.notEqual(after.groups[0].fingerprint, before.groups[0].fingerprint);
    assert.deepEqual(await counts(), {});
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("emulator prerequisites bind capability and version rather than per-process probe logging", async (t) => {
  const { verificationPreflight } = await import("../verification-preflight.mjs");
  const root = await repository(t, { native: true, emulatorNoise: true }), tools = toolchains.get(root);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "test-android.ps1"), "# not executed\n");
  const library = path.join(tools.sdk, "emulator", "fixture-library");
  await writeFile(library, "original-code");
  const plan = await verificationPlan(root, "HEAD", true);
  const preflight = () => verificationPreflight(root, plan, {
    group: "device", jdk: tools.jdk, sdk: tools.sdk, directory: path.join(root, ".data", "verification", "probe"),
  });
  const before = await preflight(), after = await preflight();
  assert.equal(before.status, "passed");
  assert.equal(after.status, "passed");
  assert.equal(after.groups[0].fingerprint, before.groups[0].fingerprint);
  assert.ok(!JSON.stringify(after).includes("PRIVATE_PROBE_PATH"));
  await writeFile(library, "modified-code");
  const changed = await preflight();
  assert.notEqual(changed.groups[0].fingerprint, before.groups[0].fingerprint);
});

test("missing or conflicting emulator facts cannot supply preflight evidence", async (t) => {
  const { verificationPreflight } = await import("../verification-preflight.mjs");
  for (const [configuration, reason] of [
    [{ emulatorVersion: "unknown" }, "preflight-version"],
    [{ emulatorVersion: "35.0.1\nAndroid emulator version 36.0.0" }, "preflight-version"],
    [{ emulatorAcceleration: "KVM is not usable." }, "preflight-acceleration"],
    [{ emulatorAcceleration: "KVM (version 12) is installed and usable.\nKVM (version 13) is installed and usable." }, "preflight-acceleration"],
  ]) {
    const root = await repository(t, { native: true, ...configuration }), tools = toolchains.get(root);
    await mkdir(path.join(root, "scripts"));
    await writeFile(path.join(root, "scripts", "test-android.ps1"), "# not executed\n");
    const result = await verificationPreflight(root, await verificationPlan(root, "HEAD", true), {
      group: "device", jdk: tools.jdk, sdk: tools.sdk, directory: path.join(root, ".data", "verification", "version"),
    });
    assert.equal(result.status, "blocked");
    assert.ok(result.groups[0].issues.some((issue) =>
      issue.prerequisite === "emulator-acceleration" && issue.failure.reason === reason));
  }
});

test("native preflight binds tool bytes rather than incidental file timestamps", async (t) => {
  const { verificationPreflight } = await import("../verification-preflight.mjs");
  const root = await repository(t, { native: true }), tools = toolchains.get(root);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "test-android.ps1"), "# synthetic entry, never executed\n");
  const plan = await verificationPlan(root, "HEAD", true);
  const options = { group: "device", jdk: tools.jdk, sdk: tools.sdk, directory: path.join(root, ".data", "preflight") };
  const preflight = async () => {
    const result = await verificationPreflight(root, plan, options);
    assert.equal(result.status, "passed", JSON.stringify(result));
    return result.groups[0];
  };
  const files = [
    ["jdk", path.join(tools.jdk, "release")],
    ["build-tools", path.join(tools.sdk, "build-tools", "35.0.0", process.platform === "win32" ? "aapt2.exe" : "aapt2")],
    ["image", path.join(tools.sdk, "system-images", "android-35", "google_apis", "x86_64", "system.img")],
    ["emulator", path.join(tools.sdk, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator")],
  ];
  for (const [, file] of files) await fileSystem.utimes(file, 1, 1);
  const before = await preflight();
  for (const [, file] of files) await fileSystem.utimes(file, 2, 1);
  assert.deepEqual(await preflight(), before, "Access-time changes do not change the executable inputs.");
  for (const [name, file] of files.filter(([name]) => name === "jdk" || name === "image")) {
    const bytes = await readFile(file);
    try {
      await writeFile(file, Buffer.concat([bytes, Buffer.from("\n")]));
      await fileSystem.utimes(file, 2, 1);
      const after = await preflight(), prerequisite = name === "jdk" ? "jdk" : "android-image";
      assert.notEqual(after.fingerprint, before.fingerprint, "Restoring timestamps must not hide changed bytes.");
      assert.deepEqual(after.prerequisites.filter((item, index) =>
        item.fingerprint !== before.prerequisites[index].fingerprint).map((item) => item.prerequisite), [prerequisite]);
    } finally { await writeFile(file, bytes); }
  }
  const image = files.find(([name]) => name === "image")[1];
  await rm(image);
  await mkdir(image);
  const missingImage = await verificationPreflight(root, plan, options);
  assert.equal(missingImage.status, "blocked");
  assert.ok(missingImage.groups[0].issues.some((issue) => issue.prerequisite === "android-image"));
});

test("native preflight binds ignored SDK overrides before the build can execute", async (t) => {
  const root = await repository(t, { native: true }), tools = toolchains.get(root);
  await writeFile(path.join(root, ".gitignore"), (await readFile(path.join(root, ".gitignore"), "utf8")) + "android/local.properties\n");
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "build-android.ps1"), [
    "param($Jdk,$Sdk,[switch]$Lint,[switch]$Instrumentation)",
    "Set-Content -LiteralPath '.data/native-ran' -Value 'yes'", "",
  ].join("\n"));
  const property = (value) => value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
  const local = path.join(root, "android", "local.properties");
  const foreign = path.join(root, ".data", "foreign-sdk");
  await mkdir(foreign);
  await writeFile(local, `sdk.dir=${property(foreign)}\n`);
  const blocked = await verify(root, ["--group", "android"]);
  assert.equal(blocked.report.status, "blocked", JSON.stringify(blocked.report));
  assert.ok(blocked.report.preflight.groups[0].issues.some((issue) => issue.prerequisite === "native-configuration"));
  await assert.rejects(readFile(path.join(root, ".data", "native-ran")), { code: "ENOENT" });
  await writeFile(local, `sdk.dir=${property(tools.sdk)}\n`);
  const resumed = await verify(root, ["--group", "android", "--resume", blocked.report.run.manifest]);
  assert.equal(resumed.report.status, "partial", JSON.stringify(resumed.report));
  assert.equal((await readFile(path.join(root, ".data", "native-ran"), "utf8")).trim(), "yes");
});

test("native applicability binds Gradle environment properties and PowerShell Node resolution", async (t) => {
  const { verificationPreflight } = await import("../verification-preflight.mjs");
  const root = await repository(t, { native: true }), tools = toolchains.get(root);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "build-android.ps1"), "param($Jdk,$Sdk)\nexit 0\n");
  const deviceEntry = path.join(root, "scripts", "test-android.ps1");
  await copyFile(path.resolve("scripts", "test-android.ps1"), deviceEntry);
  const plan = await verificationPlan(root, "HEAD");
  const preflight = () => verificationPreflight(root, plan, {
    jdk: tools.jdk, sdk: tools.sdk, directory: path.join(root, ".data", "verification", "native-inputs"),
  });
  const baseline = await preflight();
  assert.equal(baseline.status, "passed", JSON.stringify(baseline));
  const group = (result, name) => result.groups.find((item) => item.group === name);
  await t.test("Gradle project properties change only native applicability", async () => {
    const name = "ORG_GRADLE_PROJECT_devpocket.fcm.applicationId", previous = process.env[name];
    process.env[name] = "GRADLE_PROJECT_CANARY\ninvalid";
    try {
      const changed = await preflight();
      assert.equal(changed.status, "passed", JSON.stringify(changed));
      for (const name of ["android", "device"]) {
        assert.notEqual(group(changed, name).fingerprint, group(baseline, name).fingerprint);
      }
      assert.equal(group(changed, "tooling").fingerprint, group(baseline, "tooling").fingerprint);
      assert.ok(!JSON.stringify(changed).includes("GRADLE_PROJECT_CANARY"));
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });
  await t.test("a PowerShell-only Node launcher cannot hide behind native and CMD resolution",
    { skip: process.platform !== "win32" }, async () => {
      const directory = path.join(root, ".data", "powershell-node"), marker = path.join(root, ".data", "powershell-node-ran");
      await mkdir(directory);
      const file = path.join(directory, "node.ps1"), quote = (value) => `'${value.replaceAll("'", "''")}'`;
      const original = [
        `Set-Content -LiteralPath ${quote(marker)} -Value 'called'`,
        `& ${quote(process.execPath)} @args; exit $LASTEXITCODE`, "",
      ].join("\n");
      await writeFile(file, original);
      const previous = process.env.PATH;
      process.env.PATH = `${directory}${path.delimiter}${previous}`;
      try {
        assert.equal((await resolveVerificationExecutable(root, "node")).toLowerCase(), process.execPath.toLowerCase());
        assert.equal((await resolveVerificationExecutable(root, "node", { shell: true })).toLowerCase(), process.execPath.toLowerCase());
        const before = await preflight();
        assert.equal(before.status, "passed", JSON.stringify(before));
        assert.equal(group(before, "device").reusable, false);
        await assert.rejects(readFile(marker), { code: "ENOENT" }, "Discovery must not execute the unknown launcher.");
        await writeFile(file, [
          `Set-Content -LiteralPath ${quote(marker)} -Value 'called'`,
          "if($args.Count -gt 0 -and $args[0] -like '*android-runner.mjs'){exit 23}",
          `& ${quote(process.execPath)} @args; exit $LASTEXITCODE`, "",
        ].join("\n"));
        const after = await preflight();
        assert.equal(after.status, "passed", JSON.stringify(after));
        assert.equal(group(after, "device").reusable, false);
        assert.notEqual(group(after, "device").fingerprint, group(before, "device").fingerprint);
        await assert.rejects(readFile(marker), { code: "ENOENT" });
        await assert.rejects(exec("pwsh", ["-NoProfile", "-NonInteractive", "-File", deviceEntry],
          { cwd: root, timeout: 30000 }), (error) => error.code === 23);
        assert.equal((await readFile(marker, "utf8")).trim(), "called");
      } finally { process.env.PATH = previous; }
    });
});

test("native artifact identity detects changed Gradle code without treating lock churn as a new toolchain", async (t) => {
  const { verificationArtifacts } = await import("../verification-preflight.mjs");
  const root = await repository(t), plan = { requiredChecks: ["android-build", "android-device"] };
  for (const relative of ["android/app/build/outputs/apk/debug/app-debug.apk",
    "android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
    ".tools/gradle-cache/wrapper/dists/gradle-fixture/lib/gradle-core.jar",
    ".tools/gradle-cache/caches/modules-2/fixture.jar"]) {
    const file = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "stable artifact");
  }
  const initial = await verificationArtifacts(root, plan, "android");
  assert.equal(initial.available, true);
  await writeFile(path.join(root, ".tools", "gradle-cache", "caches", "gc.properties"), "mutable bookkeeping");
  await writeFile(path.join(root, ".tools", "gradle-cache", "caches", "fixture.lck"), "lock");
  assert.deepEqual(await verificationArtifacts(root, plan, "android"), initial);
  await writeFile(path.join(root, ".tools", "gradle-cache", "caches", "modules-2", "fixture.jar"), "different dependency");
  assert.notDeepEqual(await verificationArtifacts(root, plan, "android"), initial);
});

test("script and batch locators cannot inherit direct Node identity through a physical-target alias",
  { skip: process.platform !== "win32" }, async (t) => {
    const { verificationPreflight } = await import("../verification-preflight.mjs");
    const { root, base } = await recoveryFixture(t, { candidate: true });
    const directory = path.join(root, ".data", "node-aliases");
    await mkdir(directory);
    const plan = await verificationPlan(root, base), previous = process.env.PATH;
    process.env.PATH = `${directory}${path.delimiter}${previous}`;
    const preflight = () => verificationPreflight(root, plan, {
      group: "backend", directory: path.join(root, ".data", "verification", "node-locators"),
    });
    try {
      const control = await preflight();
      assert.equal(control.status, "passed", JSON.stringify(control));
      const eligibility = control.groups[0].candidateEligibility;
      assert.ok(eligibility.status === "bound" || eligibility.reason === "npm-unrecognized");
      for (const extension of ["ps1", "cmd", "bat"]) await t.test(extension, async () => {
        const file = path.join(directory, `node.${extension}`);
        await writeFile(file, extension === "ps1" ? "throw 'ALIAS_MUST_NOT_EXECUTE'\n" : "@echo off\r\nexit /b 23\r\n");
        const discovered = JSON.parse((await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
          "$c=Get-Command node -CommandType Application,ExternalScript | Select-Object -First 1; " +
          "@{file=$c.Source;kind=$c.CommandType.ToString()} | ConvertTo-Json -Compress"])).stdout);
        assert.equal(discovered.file.toLowerCase(), file.toLowerCase());
        assert.equal(discovered.kind, extension === "ps1" ? "ExternalScript" : "Application");
        let aliases = 0;
        const invocations = [], originalRealpath = fileSystem.realpath, originalSpawn = childProcess.spawn;
        const resolve = t.mock.method(fileSystem, "realpath", async (value, ...options) => {
          if (typeof value === "string" && path.resolve(value).toLowerCase() === file.toLowerCase()) {
            aliases++;
            return process.execPath;
          }
          return originalRealpath(value, ...options);
        });
        const observe = t.mock.method(childProcess, "spawn", (program, args, options) => {
          const child = originalSpawn(program, args, options);
          if (options?.cwd === root && args.some((arg) => /owned-command-(?:windows\.mjs|linux\.py)$/.test(arg))) {
            const write = child.stdin.write;
            let first = true;
            child.stdin.write = function (chunk, ...rest) {
              if (first) {
                first = false;
                const request = JSON.parse(chunk);
                if (request.file.toLowerCase() === file.toLowerCase() || request.arguments.some((argument) =>
                  argument.replaceAll("''", "'").toLowerCase().includes(file.toLowerCase()) ||
                  /(?:^|[;&]\s*)(?:&\s*)?node\s+(?:--version|-v)(?:\s|;|$)/i.test(argument))) {
                  invocations.push(request.file);
                }
              }
              return write.call(this, chunk, ...rest);
            };
          }
          return child;
        });
        syncBuiltinESMExports();
        try {
          if (extension !== "ps1") {
            assert.equal((await resolveVerificationExecutable(root, "node", { shell: true })).toLowerCase(), file.toLowerCase());
          }
          const result = await preflight();
          assert.deepEqual(invocations, [], "Classification must precede any alias compatibility probe.");
          assert.ok(aliases > 0, "The simulated physical-target alias must be exercised.");
          assert.equal(result.status, "passed", JSON.stringify(result));
          assert.equal(result.groups[0].reusable, false);
          assert.equal(result.groups[0].candidateEligibility.status, "unbound");
          assert.notEqual(result.groups[0].fingerprint, control.groups[0].fingerprint);
        } finally {
          resolve.mock.restore();
          observe.mock.restore();
          syncBuiltinESMExports();
          await rm(file);
        }
      });
    } finally { process.env.PATH = previous; }
  });

test("directory-entry discovery avoids redundant file stats while retaining digest and replacement checks", async (t) => {
  const { verificationArtifacts } = await import("../verification-preflight.mjs");
  const root = await repository(t), directory = path.join(root, "dist"), plan = { requiredChecks: ["backend-build"] };
  await mkdir(directory);
  const files = Array.from({ length: 24 }, (_, index) => path.join(directory, `input-${index}.js`));
  await Promise.all(files.map((file) => writeFile(file, "export const value = 1;\n")));
  const stats = new Map(), originalStat = fileSystem.lstat;
  const observed = t.mock.method(fileSystem, "lstat", async (file, ...args) => {
    if (files.includes(file)) stats.set(file, (stats.get(file) ?? 0) + 1);
    return originalStat(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    const first = await verificationArtifacts(root, plan, "backend");
    assert.equal(first.available, true);
    for (const file of files) assert.equal(stats.get(file), 2, "Keep before/after checks, not a third sequential discovery stat.");
    assert.deepEqual(await verificationArtifacts(root, plan, "backend"), first);
    await writeFile(files[0], "export const value = 2;\n");
    assert.notDeepEqual(await verificationArtifacts(root, plan, "backend"), first);
  } finally { observed.mock.restore(); syncBuiltinESMExports(); }
  const outside = path.join(root, ".data", "outside");
  await mkdir(outside, { recursive: true });
  const link = path.join(directory, "inner-link");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verificationArtifacts(root, plan, "backend"), { diagnosticCode: "preflight-path" });
  await rm(link);
  const originalOpen = fileSystem.open;
  let replaced = false;
  const replace = t.mock.method(fileSystem, "open", async (file, ...args) => {
    if (file === files[0] && !replaced) {
      replaced = true;
      await rename(file, `${file}.saved`);
      await writeFile(file, await readFile(`${file}.saved`));
    }
    return originalOpen(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(verificationArtifacts(root, plan, "backend"), { diagnosticCode: "environment-changed" });
    assert.equal(replaced, true);
  } finally { replace.mock.restore(); syncBuiltinESMExports(); }
});

test("Gradle JVM property startup code cannot be reused after its external agent changes", async (t) => {
  const root = await repository(t, { native: true });
  await mkdir(path.join(root, "scripts"));
  const artifacts = ["android/app/build/outputs/apk/debug/app-debug.apk",
    "android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
    ".tools/gradle-cache/wrapper/dists/fixture/lib/gradle.jar",
    ".tools/gradle-cache/caches/modules-2/fixture.jar"];
  for (const relative of artifacts) {
    const file = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "stable native artifact");
  }
  await writeFile(path.join(root, ".tools", "gradle-cache", "gradle.properties"),
    "org.gradle.jvmargs=-Xmx512m -javaagent:../reuse-agent.jar\n");
  const agent = path.join(root, ".tools", "reuse-agent.jar");
  await writeFile(agent, "valid fixture agent");
  await writeFile(path.join(root, "scripts", "build-android.ps1"), [
    "param($Jdk,$Sdk,[switch]$Lint,[switch]$Instrumentation)",
    "Add-Content -LiteralPath '.data/build-count' -Value 'called'",
    "if([IO.File]::ReadAllText((Join-Path (Get-Location).Path '.tools\\reuse-agent.jar')) -ne 'valid fixture agent'){exit 23}",
    "exit 0", "",
  ].join("\n"));
  const first = await verify(root, ["--group", "android"]);
  assert.equal(first.report.status, "partial", JSON.stringify(first.report));
  assert.equal(first.report.preflight.groups[0].reusable, false);
  await writeFile(agent, "invalid fixture agent");
  const resumed = await verify(root, ["--group", "android", "--resume", first.report.run.manifest]);
  assert.equal(resumed.report.status, "failed", JSON.stringify(resumed.report));
  assert.deepEqual(resumed.report.recovery.reused, []);
  assert.equal(resumed.report.recovery.invalidated[0].reason, "environment-unbound");
  assert.equal(resumed.report.checks.find((check) => check.id === "android-build").exitCode, 23);
  assert.equal((await readFile(path.join(root, ".data", "build-count"), "utf8")).trim().split(/\r?\n/).length, 2);
});

test("source link identity alone cannot qualify cached execution of its external target", async (t) => {
  const { verificationPlan } = await import("../verification.mjs");
  const { verificationPreflight } = await import("../verification-preflight.mjs");
  const { root } = await recoveryFixture(t), link = path.join(root, "source-link");
  const target = path.join(root, ".data", "external-input");
  await mkdir(target);
  await writeFile(link, "placeholder");
  const oid = (await exec("git", ["hash-object", "-w", "source-link"], { cwd: root })).stdout.trim();
  await exec("git", ["update-index", "--add", "--cacheinfo", `120000,${oid},source-link`], { cwd: root });
  await rm(link);
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  const result = await verificationPreflight(root, await verificationPlan(root, "HEAD"), {
    group: "tooling", directory: path.join(root, ".data", "verification", "linked-input"),
  });
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(result.groups[0].reusable, false);
});

test("unbound Node preloads cannot be cached merely because their option text stayed unchanged", async (t) => {
  const { root, counts } = await recoveryFixture(t);
  const preload = path.join(root, ".data", "preload.mjs");
  await writeFile(preload, "export {};\n");
  const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  const first = await verify(root, ["--group", "tooling"], env);
  assert.equal(first.report.status, "partial", JSON.stringify(first.report));
  assert.equal(first.report.preflight.groups[0].reusable, false);
  await writeFile(preload, [
    "import {writeFileSync} from 'node:fs';",
    "if(process.argv[1]?.endsWith('fixture.mjs'))writeFileSync('.data/preload-ran','yes');", "",
  ].join("\n"));
  const resumed = await verify(root, ["--group", "tooling", "--resume", first.report.run.manifest], env);
  assert.equal(resumed.report.status, "partial", JSON.stringify(resumed.report));
  assert.deepEqual(resumed.report.recovery.reused, []);
  assert.equal(resumed.report.recovery.invalidated[0].reason, "environment-unbound");
  assert.equal((await counts()).tooling, 2);
  assert.equal(await readFile(path.join(root, ".data", "preload-ran"), "utf8"), "yes");
});

test("ordinary verification supports a detached linked worktree without granting candidate conversion", async (t) => {
  const primary = await repository(t), root = `${primary}-detached`;
  await exec("git", ["worktree", "add", "--quiet", "--detach", root, "HEAD"], { cwd: primary });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "README.md"), "documentation-only change\n");
  const first = await verify(root, []);
  assert.equal(first.report.status, "passed", JSON.stringify(first.report));
  assert.equal(first.report.complete, true);
  assert.deepEqual(first.report.candidateConversion, { status: "unavailable", reason: "attached-branch-required" });
  const resumed = await verify(root, ["--resume", first.report.run.manifest]);
  assert.equal(resumed.report.status, "passed", JSON.stringify(resumed.report));
});

test("a changed captured execution policy cannot resume an earlier successful run", async (t) => {
  const { root, base, counts } = await recoveryFixture(t);
  const first = await recordedVerification(root, base);
  const copied = path.join(root, ".data", "implementation");
  await mkdir(copied);
  for (const name of await readdir(path.resolve("scripts"))) {
    if (/\.(?:mjs|ps1|py|cs)$/.test(name)) await copyFile(path.resolve("scripts", name), path.join(copied, name));
  }
  const copiedPolicy = await import(pathToFileURL(path.join(copied, "verification-preflight.mjs")).href);
  assert.equal(await copiedPolicy.verificationExecutionPolicy(), first.policy, "The copied policy must match before mutation.");
  for (const name of ["test-workflow.mjs", "verification-tooling.mjs", "verification-admission.mjs",
    "verification-ci.mjs", "verification-ci-artifact.ps1", "development-policy.mjs"]) await t.test(name, async () => {
    const file = path.join(copied, name), original = await readFile(file);
    try {
      await writeFile(file, Buffer.concat([original, Buffer.from("\n")]));
      assert.notEqual(await copiedPolicy.verificationExecutionPolicy(), first.policy, `${name} must remain a bound execution input.`);
    } finally { await writeFile(file, original); }
  });
  const run = async (extra = []) => {
    const report = path.join(root, ".data", "verification", randomUUID(), "report.json");
    try {
      await exec(process.execPath, [path.join(copied, "verify.mjs"), "--repo", root, "--base", "HEAD",
        "--report", report, ...extra], { timeout: 120000 });
    } catch (error) { assert.equal(error.code, 1); }
    return JSON.parse(await readFile(report, "utf8"));
  };
  const file = path.join(copied, "verification-preflight.mjs");
  await writeFile(file, await readFile(file, "utf8") + "\n// changed execution policy\n");
  assert.notEqual(await copiedPolicy.verificationExecutionPolicy(), first.policy);
  const resumed = await run(["--resume", first.report.run.manifest]);
  assert.equal(resumed.failure.reason, "policy-mismatch");
  assert.deepEqual(await counts(), {});
});

async function commitFixtureCandidate(root) {
  const { changedPaths, inspectWorktree, prepareCandidate, sha256 } = await import("../candidate-commit.mjs");
  const { captureCandidateImplementation, nativeCandidateCommand } = await import("../native-candidate.mjs");
  const before = await inspectWorktree(root);
  const { request } = await prepareCandidate(root, before, before.source, await changedPaths(root, before.source.head),
    "verification-transition-fixture", "Commit the verified fixture", undefined, await captureCandidateImplementation());
  const directory = path.join(root, ".data", "verification", randomUUID());
  await mkdir(directory);
  const file = path.join(directory, "candidate.json"), bytes = JSON.stringify(request) + "\n";
  await writeFile(file, bytes);
  await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", nativeCandidateCommand(file, sha256(bytes))], { timeout: 120000 });
  return file;
}

test("a native candidate transition reuses content-only execution across Git normalization without rewriting its old HEAD or time", async (t) => {
  const { root, base, counts } = await recoveryFixture(t, { candidate: true });
  // CI's process-level Git override otherwise takes precedence over the disposable repository's config.
  const index = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  assert.ok(Number.isSafeInteger(index) && index >= 0 && index < 128);
  const key = `GIT_CONFIG_KEY_${index}`, value = `GIT_CONFIG_VALUE_${index}`;
  const originalGit = new Map(["GIT_CONFIG_COUNT", key, value].map((name) => [name, process.env[name]]));
  Object.assign(process.env, { GIT_CONFIG_COUNT: String(index + 1), [key]: "core.autocrlf", [value]: "true" });
  t.after(() => {
    for (const [name, saved] of originalGit) {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });
  await exec("git", ["config", "core.autocrlf", "true"], { cwd: root });
  await writeFile(path.join(root, "backend", "tests", "normalized.txt"), "unchanged execution input\r\n");
  await rm(path.join(root, "README.md"));
  const { executeVerification, verificationPlan } = await import("../verification.mjs");
  let typecheckCommands = 0;
  const spawn = childProcess.spawn;
  const observation = t.mock.method(childProcess, "spawn", (file, args, options) => {
    const child = spawn(file, args, options);
    if (options?.cwd === root && args.some((arg) => /owned-command-(?:windows\.mjs|linux\.py)$/.test(arg))) {
      const write = child.stdin.write;
      let initial = true;
      child.stdin.write = function (chunk, ...rest) {
        if (initial) {
          initial = false;
          const request = JSON.parse(chunk);
          if (request.arguments?.includes("& npm run typecheck; exit $LASTEXITCODE")) typecheckCommands++;
        }
        return write.call(this, chunk, ...rest);
      };
    }
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { observation.mock.restore(); syncBuiltinESMExports(); });
  const run = async (options = {}) => {
    const directory = path.join(root, ".data", "verification", randomUUID());
    const report = await executeVerification(root, await verificationPlan(root, base), { ...options, directory });
    const reportPath = path.join(directory, "report.json");
    await writeFile(reportPath, JSON.stringify(report), { flag: "wx" });
    return { report, reportPath };
  };
  const first = await run();
  assert.equal(first.report.status, "passed", JSON.stringify(first.report));
  const toolingReusable = first.report.preflight.groups.find((group) => group.group === "tooling").reusable;
  assert.equal(typecheckCommands, 1, "Observe the real npm typecheck command, not just its report.");
  const eligibility = first.report.preflight.groups.find((group) => group.group === "backend").candidateEligibility;
  const supportsReuse = eligibility.status === "bound";
  if (process.platform === "win32") assert.ok(supportsReuse || eligibility.reason === "npm-unrecognized", JSON.stringify(eligibility));
  const original = await readFile(first.reportPath), check = first.report.checks.find((item) => item.id === "typecheck");
  const request = await commitFixtureCandidate(root);
  assert.equal(await readFile(path.join(root, "backend", "tests", "normalized.txt"), "utf8"), "unchanged execution input\r\n");
  assert.equal((await exec("git", ["show", "HEAD:backend/tests/normalized.txt"], { cwd: root })).stdout, "unchanged execution input\n");
  const result = await run({ promote: first.report.run.manifest, candidateRequest: request });
  assert.equal(result.report.status, "passed", JSON.stringify(result.report));
  assert.equal(result.report.complete, true);
  assert.notEqual(result.report.source.head, first.report.source.head);
  const reused = result.report.checks.find((item) => item.id === "typecheck");
  if (supportsReuse) {
    assert.deepEqual(reused.execution, check.execution);
    assert.equal(reused.candidateReuse.run, first.report.run.id);
    assert.equal(typecheckCommands, 1);
  } else {
    assert.equal(reused.execution.source.head, result.report.source.head);
    assert.equal(typecheckCommands, 2, "An unrecognized compiler launcher must execute on the candidate.");
  }
  assert.deepEqual(await counts(), { tooling: 2, "backend-tests": 2, "backend-build": 2, schema: 2 });
  assert.deepEqual(await readFile(first.reportPath), original);
  const ordinary = await verify(root, ["--base", base, "--combine", "--input", result.reportPath]);
  assert.equal(ordinary.report.failure.reason, "candidate-evidence-required");
  const qualified = await verify(root, ["--base", base, "--combine", "--candidate-evidence", "--input", result.reportPath]);
  assert.equal(qualified.report.status, "passed", JSON.stringify(qualified.report));
  assert.deepEqual(await counts(), { tooling: 2, "backend-tests": 2, "backend-build": 2, schema: 2 });
  await t.test("candidate conversion proves added and deleted inputs against real committed blobs, not fingerprint equality alone", async () => {
    assert.notEqual(result.report.source.fingerprint, first.report.source.fingerprint);
    assert.equal(result.report.recovery.reusedChecks.includes("typecheck"), supportsReuse);
  });
  await t.test("converted candidate failures resume their own run without promoting the original reports again", async () => {
    const marker = path.join(root, ".data", "fail-backend-tests");
    await writeFile(marker, "transient candidate check failure");
    await rm(path.join(root, "dist", "result.js"));
    const failed = await run({ resume: result.report.run.manifest });
    assert.equal(failed.report.status, "failed", JSON.stringify(failed.report));
    const backendReusable = result.report.preflight.groups.find((group) => group.group === "backend").reusable;
    assert.ok(failed.report.recovery.invalidated.some((item) =>
      item.group === "backend" && item.reason === (backendReusable ? "artifact-changed" : "environment-unbound")));
    await rm(marker);
    const resumed = await run({ resume: failed.report.run.manifest });
    assert.equal(resumed.report.status, "passed", JSON.stringify(resumed.report));
    assert.equal(resumed.report.recovery.reusedChecks.includes("typecheck"), supportsReuse);
    assert.deepEqual(await counts(), { tooling: toolingReusable ? 2 : 4, "backend-tests": 4, "backend-build": 3, schema: 3 });
    assert.equal(typecheckCommands, supportsReuse ? 1 : 4);
    assert.deepEqual(await readFile(first.reportPath), original);
  });
});

test("commit projections bind text policy and permit only the proven storage representation", async (t) => {
  const root = await repository(t);
  await exec("git", ["config", "core.autocrlf", "false"], { cwd: root });
  await writeFile(path.join(root, ".gitattributes"), "*.txt text=auto eol=lf\n*.bin -text\n");
  await writeFile(path.join(root, "text.txt"), "checked bytes\r\n");
  await writeFile(path.join(root, "opaque.bin"), Buffer.from([0, 13, 10, 255]));
  const inputs = await sourceInputs(root), projection = await commitSourceProjection(root, inputs);
  assert.equal(projection.status, "bound");
  assert.deepEqual(projection.normalized.map(([file]) => file), ["text.txt"]);
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "Text conversion"], { cwd: root });
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const committed = await committedSourceInputs(root, head);
  assert.deepEqual(await sourceInputs(root), inputs);
  assert.notDeepEqual(committed, inputs);
  assert.equal(committedInputsMatch(inputs, committed, projection), true);
  for (const change of [
    (rows) => rows.pop(),
    (rows) => rows.push(["unexpected.txt", "100644", "file", "a".repeat(64)]),
    (rows) => { rows.find(([file]) => file === "text.txt")[1] = "100755"; },
    (rows) => { rows.find(([file]) => file === "text.txt")[3] = "a".repeat(64); },
    (rows) => { rows.find(([file]) => file === "opaque.bin")[3] = "a".repeat(64); },
  ]) {
    const altered = structuredClone(committed); change(altered);
    assert.equal(committedInputsMatch(inputs, altered, projection), false);
  }
  await writeFile(path.join(root, ".git", "info", "attributes"), "*.txt -text\n");
  const changedPolicy = await commitSourceProjection(root, inputs);
  assert.notEqual(changedPolicy.policy, projection.policy);
  assert.equal(committedInputsMatch(inputs, committed, changedPolicy), false);
  await exec("git", ["config", "filter.unsafe.clean",
    "node -e \"require('node:fs').writeFileSync('.data/filter-executed','unexpected')\""], { cwd: root });
  for (const attribute of ["filter=unsafe", "-filter", "working-tree-encoding=UTF-16", "ident"]) {
    await writeFile(path.join(root, ".git", "info", "attributes"), `*.txt ${attribute}\n`);
    assert.equal((await commitSourceProjection(root, inputs)).status, "unsupported");
  }
  await assert.rejects(readFile(path.join(root, ".data", "filter-executed")), { code: "ENOENT" });
});

test("a changed or commit-sensitive command cannot inherit content-only reuse", async (t) => {
  const { root, base, counts } = await recoveryFixture(t, { candidate: true, sensitive: true });
  const first = await verify(root, []);
  assert.equal(first.report.status, "passed", JSON.stringify(first.report));
  const request = await commitFixtureCandidate(root);
  const result = await verify(root, ["--base", base, "--promote", first.report.run.manifest, "--candidate-request", request]);
  assert.equal(result.report.status, "passed", JSON.stringify(result.report));
  assert.deepEqual(result.report.recovery.reusedChecks, []);
  assert.equal(result.report.checks.find((check) => check.id === "typecheck").execution.source.head, result.report.source.head);
  assert.equal((await counts())["head-sensitive"], 2);
});

test("an unchanged HEAD-sensitive compiler shim or implementation cannot inherit the official typecheck contract", async (t) => {
  const { verificationPreflight } = await import("../verification-preflight.mjs");
  const { root, base } = await recoveryFixture(t, { candidate: true });
  const plan = await verificationPlan(root, base);
  const preflight = () => verificationPreflight(root, plan, {
    group: "backend", directory: path.join(root, ".data", "verification", "compiler-contract"),
  });
  const control = await preflight();
  assert.equal(control.status, "passed", JSON.stringify(control));
  const eligibility = control.groups[0].candidateEligibility;
  assert.ok(eligibility.status === "bound" || ["npm-unrecognized", "startup-unrecognized"].includes(eligibility.reason));
  const guard = `require('node:fs').appendFileSync('.data/compiler-count','called\\n');` +
    `if(require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==${JSON.stringify(base)})process.exit(23);\n`;
  for (const kind of ["shim", "implementation"]) await t.test(kind, async () => {
    const file = kind === "shim"
      ? path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc")
      : path.join(root, "node_modules", "typescript", "lib", "_tsc.js");
    const backup = path.join(root, ".data", `${kind}-original`);
    await cp(file, backup, { verbatimSymlinks: true });
    try {
      if (kind === "shim") {
        await rm(file);
        await writeFile(file, process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" .data\\compiler.cjs\r\nexit /b %ERRORLEVEL%\r\n`
          : `#!/bin/sh\n"${process.execPath}" .data/compiler.cjs\n`);
        if (process.platform !== "win32") await chmod(file, 0o755);
        await writeFile(path.join(root, ".data", "compiler.cjs"), guard);
      } else await writeFile(file, guard + await readFile(file, "utf8"));
      const result = await preflight();
      assert.equal(result.status, "passed", JSON.stringify(result));
      assert.equal(result.groups[0].candidateEligibility.status, "unbound");
      assert.equal(result.groups[0].candidateEligibility.reason,
        eligibility.status === "bound" ? "compiler-unrecognized" : eligibility.reason);
      assert.equal(result.groups[0].reusable, control.groups[0].reusable);
      assert.notEqual(result.groups[0].fingerprint, control.groups[0].fingerprint);
      await assert.rejects(readFile(path.join(root, ".data", "compiler-count")), { code: "ENOENT" });
    } finally {
      await rm(file);
      await cp(backup, file, { verbatimSymlinks: true });
      await rm(backup);
    }
  });
});

test("an unchanged HEAD-sensitive npm launcher cannot qualify typecheck and altered npm code is unrecognized",
  { skip: process.platform !== "win32" }, async (t) => {
    const { verificationPreflight } = await import("../verification-preflight.mjs");
    const { root, base } = await recoveryFixture(t, { candidate: true });
    const launcher = (await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-Command npm -CommandType Application,ExternalScript | Select-Object -First 1).Source"])).stdout.trim();
    const wrapper = path.join(root, ".data", "npm-wrapper"), entry = path.join(wrapper, "npm.ps1");
    const original = await readFile(launcher, "utf8");
    await mkdir(wrapper);
    await cp(path.join(path.dirname(launcher), "node_modules", "npm"), path.join(wrapper, "node_modules", "npm"),
      { recursive: true, verbatimSymlinks: true });
    await writeFile(entry, original);
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (/^path$/i.test(name)) delete env[name];
    env.PATH = `${wrapper}${path.delimiter}${process.env.PATH}`;
    const preflight = async () => {
      const previous = process.env.PATH;
      process.env.PATH = env.PATH;
      try {
        return await verificationPreflight(root, await verificationPlan(root, base), {
          group: "backend", directory: path.join(root, ".data", "verification", "npm-preflight"),
        });
      } finally { process.env.PATH = previous; }
    };
    const control = (await preflight()).groups[0].candidateEligibility;
    assert.ok(control.status === "bound" || control.reason === "npm-unrecognized",
      "A genuine but unrecognized npm distribution must use fresh execution.");
    await writeFile(entry, [
      "if($args.Count -ge 2 -and $args[0] -eq 'run' -and $args[1] -eq 'typecheck'){",
      "Add-Content -LiteralPath '.data/npm-count' -Value 'called'",
      `$head=& git rev-parse HEAD; if($head.Trim() -ne '${base}'){exit 23}`,
      "}", original,
    ].join("\n"));
    await t.test("an unrecognized wrapper cannot supply reusable execution evidence", async () => {
      const report = await preflight();
      assert.equal(report.status, "passed");
      assert.equal(report.groups[0].candidateEligibility.reason, "npm-unrecognized");
      assert.equal(report.groups[0].reusable, false);
      await assert.rejects(readFile(path.join(root, ".data", "npm-count")), { code: "ENOENT" });
    });
    await t.test("an unchanged launcher cannot hide changes in the npm implementation", async () => {
      await writeFile(entry, original);
      const cli = path.join(wrapper, "node_modules", "npm", "bin", "npm-cli.js");
      const bytes = await readFile(cli, "utf8");
      const guard = `if(process.argv[2]==='run'&&process.argv[3]==='typecheck'){` +
        `require('node:fs').appendFileSync('.data/npm-count','called\\n');` +
        `if(require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==${JSON.stringify(base)})process.exit(23);}\n`;
      await writeFile(cli, bytes.replace("\n", "\n" + guard));
      const report = await preflight();
      assert.equal(report.status, "passed");
      assert.equal(report.groups[0].candidateEligibility.reason, "npm-unrecognized");
      assert.equal(report.groups[0].reusable, false);
    });
    await t.test("genuine npm prefix redirection cannot attest its unrecognized effective implementation", async () => {
      const redirectedEnv = { ...process.env };
      for (const name of Object.keys(redirectedEnv)) if (/^npm_config_prefix$/i.test(name)) delete redirectedEnv[name];
      redirectedEnv.NPM_CONFIG_PREFIX = wrapper;
      const first = await verify(root, [], redirectedEnv);
      assert.equal(first.report.status, "passed", JSON.stringify(first.report));
      const backend = first.report.preflight.groups.find((group) => group.group === "backend");
      assert.equal(backend.candidateEligibility.reason, "npm-unrecognized");
      assert.equal(backend.reusable, false);
      assert.equal((await readVerificationRun(root, first.report.run.manifest)).latest.get("backend").reusable, false);
      const before = await readFile(first.reportPath);
      const request = await commitFixtureCandidate(root);
      const result = await verify(root, ["--base", base, "--promote", first.report.run.manifest, "--candidate-request", request], redirectedEnv);
      assert.equal(result.report.status, "failed", JSON.stringify(result.report));
      assert.deepEqual(result.report.recovery.reusedChecks, []);
      assert.equal(result.report.checks.find((check) => check.id === "typecheck").exitCode, 23);
      assert.equal((await readFile(path.join(root, ".data", "npm-count"), "utf8")).trim().split(/\r?\n/).length, 2);
      assert.deepEqual(await readFile(first.reportPath), before);
    });
  });

test("Windows lookup matches native and CMD selection, including COM, PATH quoting and the verification cwd",
  { skip: process.platform !== "win32" }, async (t) => {
    const root = await repository(t), binary = await windowsNodeLauncher(root);
    const directory = path.join(root, ".data", "search path");
    await mkdir(directory);
    for (const name of ["node.com", "node.exe", "node"]) await copyFile(binary, path.join(directory, name));
    for (const name of ["node.cmd", "node.bat"]) {
      await writeFile(path.join(directory, name), '@echo off\r\necho "%~f0"\r\n');
    }
    const saved = Object.entries(process.env).filter(([key]) => /^(?:PATH|PATHEXT|NoDefaultCurrentDirectoryInExePath)$/i.test(key));
    const restore = () => {
      for (const key of Object.keys(process.env)) if (/^(?:PATH|PATHEXT|NoDefaultCurrentDirectoryInExePath)$/i.test(key)) delete process.env[key];
      for (const [key, value] of saved) process.env[key] = value;
    };
    const originalPath = process.env.PATH;
    try {
      for (const row of [
        { name: "COM before EXE", entry: directory, native: "node.com", shell: "node.com" },
        { name: "quoted PATH", entry: `"${directory}"`, native: "node.com", shell: "node.com" },
        { name: "relative PATH uses verification cwd", entry: path.relative(root, directory), native: "node.com", shell: "node.com" },
        { name: "PATHEXT only changes CMD", entry: directory, extensions: ".EXE;.COM;.BAT;.CMD", native: "node.com", shell: "node.exe" },
        { name: "CMD before BAT", entry: directory, extensions: ".CMD;.BAT;.EXE;.COM", native: "node.com", shell: "node.cmd" },
        { name: "BAT before CMD", entry: directory, extensions: ".BAT;.CMD;.EXE;.COM", native: "node.com", shell: "node.bat" },
        { name: "empty PATH entry stops CMD search", entry: `;${directory}`, native: "node.com", shell: null },
        { name: "implicit cwd", entry: directory, cwd: true, native: "node.com", shell: "node.com", current: true },
        { name: "suppressed cwd", entry: directory, native: "node.com", shell: "node.com" },
        { name: "explicit dot with suppressed cwd", entry: `.;${directory}`, native: "node.com", shell: "node.com", current: true },
      ]) await t.test(row.name, async () => {
        restore();
        process.env.PATH = `${row.entry}${path.delimiter}${originalPath}`;
        process.env.PATHEXT = row.extensions ?? ".COM;.EXE;.BAT;.CMD";
        if (row.cwd) {
          delete process.env.NoDefaultCurrentDirectoryInExePath;
          await copyFile(binary, path.join(root, "node.com"));
        } else process.env.NoDefaultCurrentDirectoryInExePath = "1";
        for (const shell of [false, true]) {
          const file = shell ? process.env.ComSpec : "node";
          const args = shell ? ["/d", "/s", "/c", "node --lookup-path"] : ["--lookup-path"];
          const expected = row[shell ? "shell" : "native"];
          if (expected === null) {
            await assert.rejects(exec(file, args, { cwd: root }), (error) => error.code === 1);
            await assert.rejects(resolveVerificationExecutable(root, "node", { shell }), { diagnosticCode: "preflight-tool" });
            continue;
          }
          const actual = path.resolve((await exec(file, args, { cwd: root })).stdout.trim().replace(/^"|"$/g, ""));
          const resolved = await resolveVerificationExecutable(root, "node", { shell });
          assert.equal(actual.toLowerCase(), path.join(row.current ? root : directory, expected).toLowerCase());
          assert.equal(resolved.toLowerCase(), actual.toLowerCase());
        }
      });
      process.env.PATH = `"${directory}`;
      await assert.rejects(resolveVerificationExecutable(root, "node"), { diagnosticCode: "preflight-path" });
    } finally { restore(); }
  });

test("an unchanged HEAD-sensitive node.com cannot qualify candidate reuse or hide same-source binary changes",
  { skip: process.platform !== "win32" }, async (t) => {
    const { verificationPreflight } = await import("../verification-preflight.mjs");
    const { root, base } = await recoveryFixture(t, { candidate: true });
    const binary = await windowsNodeLauncher(root, base), file = path.join(path.dirname(binary), "node.com");
    await copyFile(binary, file);
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (/^path$/i.test(name)) delete env[name];
    env.PATH = `${path.dirname(file)}${path.delimiter}${process.env.PATH}`;
    const first = await verify(root, [], env);
    assert.equal(first.report.status, "passed", JSON.stringify(first.report));
    const backend = first.report.preflight.groups.find((group) => group.group === "backend");
    assert.equal(backend.reusable, false);
    assert.equal(backend.candidateEligibility.reason, "startup-unrecognized");
    const original = await readFile(file), reportBytes = await readFile(first.reportPath);
    const saved = process.env.PATH;
    process.env.PATH = env.PATH;
    try {
      const plan = await verificationPlan(root, base);
      const options = { group: "backend", directory: path.join(root, ".data", "verification", "node-identity") };
      const before = await verificationPreflight(root, plan, options);
      await writeFile(file, Buffer.concat([original, Buffer.from("\nchanged executable bytes\n")]));
      const after = await verificationPreflight(root, plan, options);
      assert.equal(after.status, "passed", JSON.stringify(after));
      assert.equal(after.groups[0].reusable, false);
      assert.notEqual(after.groups[0].fingerprint, before.groups[0].fingerprint);
      await t.test("a CMD-only launcher remains unbound even when native lookup finds the genuine Node", async () => {
        const command = path.join(path.dirname(file), "node.cmd");
        await rename(file, `${file}.held`);
        await rename(binary, `${binary}.held`);
        try {
          await writeFile(command, `@echo off\r\n"${process.execPath}" %*\r\n`);
          assert.equal((await resolveVerificationExecutable(root, "node")).toLowerCase(), process.execPath.toLowerCase());
          assert.equal((await resolveVerificationExecutable(root, "node", { shell: true })).toLowerCase(), command.toLowerCase());
          const result = await verificationPreflight(root, plan, options);
          assert.equal(result.status, "passed", JSON.stringify(result));
          assert.equal(result.groups[0].candidateEligibility.reason, "startup-unrecognized");
          assert.equal(result.groups[0].reusable, false);
        } finally {
          await rm(command);
          await rename(`${binary}.held`, binary);
          await rename(`${file}.held`, file);
        }
      });
    } finally { process.env.PATH = saved; await writeFile(file, original); }
    const request = await commitFixtureCandidate(root);
    const result = await verify(root, ["--base", base, "--promote", first.report.run.manifest, "--candidate-request", request], env);
    assert.equal(result.report.status, "failed", JSON.stringify(result.report));
    assert.deepEqual(result.report.recovery.reusedChecks, []);
    assert.equal(result.report.checks.find((check) => check.id === "typecheck").exitCode, 23);
    assert.equal((await readFile(path.join(root, ".data", "node-launch-count"), "utf8")).trim().split(/\r?\n/).length, 3);
    assert.deepEqual(await readFile(first.reportPath), reportBytes);
    assert.deepEqual(await readFile(file), original);
  });

test("candidate conversion rejects forged receipts, changed hooks, index modes, source and extra history", async (t) => {
  for (const change of ["mode", "source"]) await t.test(change, async (t) => {
    const { root, base, counts } = await recoveryFixture(t, { candidate: true });
    const first = await recordedVerification(root, base, { promotion: true });
    if (change === "source") await writeFile(path.join(root, "backend", "tests", "change.test.ts"), "// different tested bytes\n");
    if (change === "mode") await exec("git", ["update-index", "--chmod=+x", "fixture.mjs"], { cwd: root });
    const request = await commitFixtureCandidate(root);
    const before = await counts();
    await assert.rejects(prepareVerificationTransition(root, await verificationPlan(root, base), {
      promote: first.report.run.manifest, candidateRequest: request,
    }));
    assert.deepEqual(await counts(), before);
  });
  const { root, base, counts } = await recoveryFixture(t, { candidate: true });
  const first = await recordedVerification(root, base, { promotion: true }), request = await commitFixtureCandidate(root);
  const receiptFile = `${request}.result.json`, receiptBytes = await readFile(receiptFile);
  const hooks = (await exec("git", ["rev-parse", "--git-path", "hooks"], { cwd: root })).stdout.trim();
  const hook = path.join(path.resolve(root, hooks), "pre-commit");
  for (const change of ["receipt", "hooks", "history"]) await t.test(change, async () => {
    if (change === "receipt") {
      const receipt = JSON.parse(receiptBytes);
      receipt.verificationProof.signature = "0".repeat(64);
      await writeFile(receiptFile, JSON.stringify(receipt));
    }
    if (change === "hooks") await writeFile(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    if (change === "history") await exec("git", ["commit", "--quiet", "--allow-empty", "-m", "Extra history"], { cwd: root });
    const before = await counts();
    try {
      await assert.rejects(prepareVerificationTransition(root, await verificationPlan(root, base), {
        promote: first.report.run.manifest, candidateRequest: request,
      }));
      if (change === "receipt") {
        const result = await verify(root, ["--base", base, "--promote", first.report.run.manifest, "--candidate-request", request]);
        assert.equal(result.report.status, "blocked", JSON.stringify(result.report));
        assert.equal(result.report.complete, false);
      }
      assert.deepEqual(await counts(), before);
    } finally {
      if (change === "receipt") await writeFile(receiptFile, receiptBytes);
      if (change === "hooks") await rm(hook);
    }
  });
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
