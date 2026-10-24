import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fileSystem, { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { acquireHostVerificationSlot, admissionVariable } from "../verification-admission.mjs";
import { toolingCatalogue, toolingShardDescriptor } from "../verification-tooling.mjs";
import { combineVerification, verificationPlan } from "../verification.mjs";
import { VERIFICATION_REPORT_VERSION, verificationImpact } from "../verification-policy.mjs";
import { sdkPreparationFixture, syntheticExecution } from "./fixtures/verification-tools.mjs";
import { WORKFLOW_TEST_FILES, WORKFLOW_TEST_SHARDS } from "../test-workflow.mjs";
import { ciReportEnvelope, collectCIReports, githubVerificationContext, qualifyGitHubCI, validateLiveCIEnvelope } from "../verification-ci.mjs";
import { dependencies, verificationArtifacts } from "../verification-preflight.mjs";

const exec = promisify(execFile);

async function fixture(t) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/verification-execution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function workspaceFixture(t) {
  const root = await fixture(t), workspace = path.join(root, "packages", "components");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "@fixture"), { recursive: true });
  const manifest = { name: "@fixture/components", version: "1.0.0", files: ["dist"], dependencies: {} };
  const packageJson = path.join(root, "package.json"), lockFile = path.join(root, "package-lock.json");
  const lock = { lockfileVersion: 3, packages: {
    "": { dependencies: { "@fixture/components": "file:packages/components" } },
    "node_modules/@fixture/components": { resolved: "packages/components", link: true },
    "packages/components": manifest,
  } };
  await writeFile(packageJson, JSON.stringify({ workspaces: ["packages/components"],
    dependencies: { "@fixture/components": "file:packages/components" } }));
  await writeFile(path.join(workspace, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(workspace, "src", "index.js"), "export const value = 1;\n");
  await writeFile(lockFile, JSON.stringify(lock));
  const link = path.join(root, "node_modules", "@fixture", "components");
  await fileSystem.symlink(workspace, link, process.platform === "win32" ? "junction" : "dir");
  return { root, workspace, lock, lockFile, packageJson, link };
}

test("declared internal workspaces bind their source and generated artifacts without weakening directory-link checks", async (t) => {
  const f = await workspaceFixture(t);
  const before = await dependencies(f.root);
  await mkdir(path.join(f.workspace, "dist"));
  await mkdir(path.join(f.root, "dist"));
  await writeFile(path.join(f.root, "dist", "entry.js"), "// backend output\n");
  await writeFile(path.join(f.workspace, "dist", "index.js"), "// component output\n");
  assert.deepEqual(await dependencies(f.root), before, "Generated output is not an installed dependency input.");
  const plan = { requiredChecks: ["backend-build"] };
  const first = await verificationArtifacts(f.root, plan, "backend");
  assert.equal(first.available, true);
  await writeFile(path.join(f.workspace, "dist", "index.js"), "// changed output\n");
  assert.notDeepEqual(await verificationArtifacts(f.root, plan, "backend"), first,
    "Generated workspace bytes remain bound to backend evidence.");
  await writeFile(path.join(f.workspace, "src", "index.js"), "export const value = 2;\n");
  assert.notDeepEqual(await dependencies(f.root), before, "Workspace implementation bytes are inputs, not opaque directory links.");
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await fileSystem.symlink(outside, path.join(f.root, "node_modules", "unapproved"),
    process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(dependencies(f.root), /preflight|path/i);
});

test("workspace declarations cannot escape, redirect, use globs or disagree with the lockfile", async (t) => {
  for (const scenario of ["escape", "glob", "lock-version", "lock-dependencies", "redirect"]) {
    const f = await workspaceFixture(t);
    if (scenario === "escape" || scenario === "glob") {
      await writeFile(f.packageJson, JSON.stringify({ workspaces: [scenario === "escape" ? "../outside" : "packages/*"],
        dependencies: { "@fixture/components": "file:packages/components" } }));
    } else if (scenario === "lock-version") {
      f.lock.packages["packages/components"].version = "2.0.0";
      await writeFile(f.lockFile, JSON.stringify(f.lock));
    } else if (scenario === "lock-dependencies") {
      f.lock.packages["packages/components"].dependencies = { undeclared: "1.0.0" };
      await writeFile(f.lockFile, JSON.stringify(f.lock));
    } else {
      await fileSystem.unlink(f.link);
      const target = path.join(f.root, "outside");
      await mkdir(target);
      await copyFile(path.join(f.workspace, "package.json"), path.join(target, "package.json"));
      await fileSystem.symlink(target, f.link, process.platform === "win32" ? "junction" : "dir");
    }
    await assert.rejects(dependencies(f.root), /preflight|dependencies|path/i, scenario);
  }
});

test("SDK preparation initializes matching package metadata without accepting licenses or rewriting existing metadata", async (t) => {
  const root = await fixture(t), entry = await sdkPreparationFixture(root);
  const run = () => exec("pwsh", ["-NoProfile", "-NonInteractive", "-File", entry], { timeout: 30000 });
  const models = JSON.parse((await run()).stdout);
  assert.ok(models.every((item) => item.exists), "Archive extraction alone must not leave SDK package metadata missing.");
  assert.deepEqual(models.map((item) => item.path), ["platforms;android-37.2", "build-tools;37.0.0"]);
  assert.ok(models.every((item) => item.rootNamespace === "http://schemas.android.com/repository/android/common/02" &&
    item.remoteNodes === 0 && item.license === "android-sdk-license"));
  assert.deepEqual(models.map((item) => item.typeNamespace), [
    "http://schemas.android.com/sdk/android/repo/repository2/03",
    "http://schemas.android.com/repository/android/generic/02",
  ]);
  const metadata = models.map((item) => path.join(root, ".tools", "android-sdk", ...item.path.split(";"), "package.xml"));
  const bytes = await Promise.all(metadata.map((file) => readFile(file)));
  await run();
  assert.deepEqual(await Promise.all(metadata.map((file) => readFile(file))), bytes);
  assert.equal(await readFile(path.join(root, ".tools", "android-sdk", "licenses", "android-sdk-license"), "utf8"), "fixture-already-accepted\n");
  await writeFile(path.join(root, ".tools", "android-sdk", "build-tools", "37.0.0", "source.properties"), "Pkg.Revision=34.0.0\n");
  await rm(metadata[1]);
  await assert.rejects(run(), (error) => error.code === 1 && /revision/.test(error.stderr));
  await assert.rejects(readFile(metadata[1]), { code: "ENOENT" });
  await rm(path.join(root, "existing-sdk", "licenses", "android-sdk-license"));
  await assert.rejects(run(), (error) => error.code === 1 && /license has not been accepted/.test(error.stderr));
});

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

test("macOS CI selection includes shared infrastructure without adding a local device requirement", () => {
  for (const file of [
    "scripts/owned-command-darwin.py", "scripts/process.mjs", "scripts/local-ipc.mjs",
    "scripts/emulator-resources.mjs", "scripts/verification-preflight.mjs",
    "scripts/verification-policy.mjs", "scripts/verification-ci.mjs", "scripts/test-workflow.mjs",
    "scripts/tests/process.test.mjs", "scripts/tests/emulator-resources.test.mjs",
    "scripts/tests/macos-host.test.mjs", "scripts/tests/android-runner.test.mjs",
    "package.json", "package-lock.json", ".github/workflows/ci.yml", "scripts/unknown-owner.mjs",
  ]) {
    const plan = verificationImpact([file]);
    assert.equal(plan.ciMacos, true, file);
    assert.ok(plan.requiredChecks.includes("workflow-tests"), file);
  }
  for (const files of [
    [], ["README.md"], ["docs/guide.md"], ["backend/src/store.ts"],
    ["android/app/src/main/java/dev/devpocket/app/MainActivity.kt"],
    ["scripts/owned-command-linux.py"], ["scripts/owned-command-windows.mjs"],
    ["scripts/tests/linux-runtime.test.mjs"],
  ]) assert.equal(verificationImpact(files).ciMacos, false, JSON.stringify(files));
  const focused = verificationImpact(["scripts/tests/process.test.mjs"]);
  assert.deepEqual(focused.requiredChecks, ["workflow-tests"]);
  assert.deepEqual(focused.requiredGroups, ["tooling"]);
  assert.equal(focused.layouts, false);
  assert.equal(verificationImpact(["README.md"], true).ciMacos, true);
  assert.equal(verificationImpact(["README.md", "scripts/process.mjs"]).ciMacos, true);
});

test("macOS CI requires its own successful upstream and source-bound native report", async () => {
  const plan = { version: VERIFICATION_REPORT_VERSION, base: "a".repeat(40),
    source: { head: "b".repeat(40), fingerprint: "c".repeat(64) }, ciMacos: true,
    requiredChecks: ["workflow-tests"], requiredGroups: ["tooling"], toolingShards: await toolingCatalogue(process.cwd()) };
  const context = { repository: "fixture/verification", runId: "1234", attempt: 1, event: "pull_request",
    candidate: "d".repeat(40), pullRequest: 11, pullRequestBase: plan.base,
    tested: { head: plan.source.head, tree: "e".repeat(40) }, workflowSha: plan.source.head,
    workflowRef: "fixture/verification/.github/workflows/ci.yml@refs/pull/11/merge" };
  const reports = plan.toolingShards.parts.map((part) => ({
    ...plan, group: "tooling", status: "partial", complete: false,
    environment: { platform: "win32", architecture: "x64" },
    checks: [{ id: "workflow-tests", status: "passed", exitCode: 0,
      toolingShard: toolingShardDescriptor(plan, part.id), execution: syntheticExecution(plan.source),
      executionState: "exited", commandOutcome: {
        observedProcess: "owned-command-supervisor", reason: "exit", exitCode: 0, cleanupFailure: null,
      } }],
  }));
  const windows = reports.map((report) => ciReportEnvelope(report, context, `tooling-${report.checks[0].toolingShard.id}`));
  const upstream = new Map([["tooling", "success"], ["macos", "success"]]);
  assert.throws(() => collectCIReports(plan, context, windows, upstream),
    "Windows tooling cannot substitute for selected macOS coverage.");
  const macos = structuredClone(reports.find((report) => report.checks[0].toolingShard.id === "native"));
  macos.environment = { platform: "darwin", architecture: "arm64" };
  const leaf = ciReportEnvelope(macos, context, "macos");
  const combined = collectCIReports(plan, context, [...windows, leaf], upstream);
  assert.equal(combined.report.complete, true);
  assert.deepEqual(combined.macos.environment, macos.environment);
  assert.deepEqual(combined.macos.checks[0].execution, macos.checks[0].execution);
  assert.ok(combined.inputs.some((input) => input.unit === "macos"));
  const live = { repository: context.repository, candidate: context.candidate,
    pullRequest: { number: 11, state: "open", head: { sha: context.candidate, repo: { full_name: context.repository, id: 1 } },
      base: { sha: plan.base, ref: "main", repo: { full_name: context.repository, id: 1 } } },
    baseReference: { ref: "refs/heads/main", object: { type: "commit", sha: plan.base } },
    run: { id: 1234, event: "pull_request", path: ".github/workflows/ci.yml", run_attempt: 1,
      head_sha: context.candidate, status: "completed", conclusion: "success", pull_requests: [{ number: 11 }] },
    jobs: { jobs: [{ name: "Required verification", status: "completed", conclusion: "success" }] },
    artifact: { name: "verification-summary-attempt-1", expired: false, digest: `sha256:${"a".repeat(64)}`,
      workflow_run: { id: 1234, head_sha: context.candidate, repository_id: 1, head_repository_id: 1 } },
    commit: { sha: context.tested.head, tree: { sha: context.tested.tree },
      parents: [{ sha: plan.base }, { sha: context.candidate }] } };
  assert.equal(validateLiveCIEnvelope(combined, live), combined);
  for (const mutate of [
    (value) => { delete value.macos; },
    (value) => { value.macos.environment.platform = "linux"; },
    (value) => { delete value.macos.checks[0].execution; },
    (value) => { value.macos.checks[0].privateField = "not-a-public-projection"; },
    (value) => { value.inputs = value.inputs.filter((input) => input.unit !== "macos"); },
  ]) {
    const invalid = structuredClone(combined); mutate(invalid);
    assert.throws(() => validateLiveCIEnvelope(invalid, live));
  }
  const rerun = collectCIReports(plan, { ...context, attempt: 2 }, [...windows, leaf], upstream);
  const later = structuredClone(live);
  later.run.run_attempt = 2;
  later.artifact.name = "verification-summary-attempt-2";
  assert.equal(validateLiveCIEnvelope(rerun, later), rerun,
    "A successful Mac shard from the same source's earlier attempt need not rerun with failed jobs.");
  assert.equal(rerun.inputs.find((input) => input.unit === "macos").attempt, 1);
  for (const outcome of ["failure", "cancelled", "skipped", "unknown", undefined]) {
    const results = new Map(upstream);
    if (outcome === undefined) results.delete("macos"); else results.set("macos", outcome);
    assert.throws(() => collectCIReports(plan, context, [...windows, leaf], results));
  }
  for (const mutate of [
    (value) => { value.environment.platform = "win32"; },
    (value) => { value.environment.architecture = "x64"; },
    (value) => { delete value.environment; },
    (value) => { value.source = { ...value.source, head: "f".repeat(40) }; },
    (value) => { value.checks[0].toolingShard.id = "verification"; },
    (value) => { value.checks[0].status = "failed"; },
    (value) => { value.checks[0].executionState = "not-started"; },
    (value) => { value.checks[0].commandOutcome.cleanupFailure = { reason: "cleanup-failed" }; },
  ]) {
    const invalid = structuredClone(macos); mutate(invalid);
    assert.throws(() => collectCIReports(plan, context, [...windows, ciReportEnvelope(invalid, context, "macos")], upstream));
  }
  assert.throws(() => collectCIReports(plan, context, [...windows, leaf, leaf], upstream));
  const unselected = { ...plan, ciMacos: false };
  const ordinary = reports.map((report) => ciReportEnvelope({ ...report, ciMacos: false }, context,
    `tooling-${report.checks[0].toolingShard.id}`));
  assert.equal(collectCIReports(unselected, context, ordinary,
    new Map([["tooling", "success"], ["macos", "skipped"]])).report.complete, true);
});

test("CI cancels superseded runs only for the same pull request", async () => {
  const workflow = (await readFile(".github/workflows/ci.yml", "utf8")).replaceAll("\r\n", "\n");
  assert.ok(workflow.includes([
    "\nconcurrency:",
    "  group: devpocket-verification-${{ github.event.pull_request.number || github.ref }}",
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    "",
  ].join("\n")), "Keep stable per-PR groups and do not cancel manually dispatched runs.");
});

test("macOS CI workflow is plan-selected, source-sealed and required by the final gate", async () => {
  const workflow = (await readFile(".github/workflows/ci.yml", "utf8")).replaceAll("\r\n", "\n");
  const start = workflow.indexOf("  macos:\n");
  assert.ok(start >= 0, "The planned macOS job must exist.");
  const macos = workflow.slice(start, workflow.indexOf("  backend:\n", start));
  assert.match(macos, /needs: plan/);
  assert.match(macos, /needs\.plan\.outputs\.macos == 'true'/);
  assert.match(macos, /runs-on: macos-latest/);
  assert.match(macos, /process\.platform !== 'darwin'/);
  assert.match(macos, /process\.arch !== 'arm64'/);
  assert.match(macos, /--tooling-shard native/);
  assert.match(macos, /--seal --unit macos/);
  assert.match(macos, /verification-macos-attempt-/);
  assert.doesNotMatch(macos, /continue-on-error|prepare-native|sdkmanager|test-android\.ps1/);
  const gate = workflow.slice(workflow.indexOf("  gate:\n"));
  assert.match(gate, /needs: \[plan, tooling, macos, backend, android, device\]/);
  assert.doesNotMatch(workflow, /isolated-boundary|ISOLATION_RESULT|isolated-worker/);
  assert.match(gate, /MACOS_RESULT: \$\{\{ needs\.macos\.result \}\}/);
  assert.match(gate, /'tooling', 'macos', 'backend', 'android', 'device'/);
  assert.match(workflow.slice(workflow.indexOf("  device:\n"), workflow.indexOf("  gate:\n")), /runs-on: ubuntu-24\.04/);
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

test("host admission retries an interrupted live probe only after confirmed release", { timeout: 15000 }, async (t) => {
  const root = await fixture(t);
  for (const mode of ["clean", "retained", "inherited"]) await t.test(mode, async (t) => {
    const directory = path.join(root, mode), first = await acquireHostVerificationSlot(root, { directory });
    let release, admitted, intercepted = false;
    const connect = net.connect;
    const interrupt = t.mock.method(net, "connect", (...args) => {
      const socket = connect(...args);
      if (!intercepted) {
        intercepted = true;
        socket.write = () => {
          release = first.release(mode !== "retained");
          return true;
        };
      }
      return socket;
    });
    try {
      const pending = acquireHostVerificationSlot(root, { directory,
        inherited: mode === "inherited" ? first.environment[admissionVariable] : "" });
      if (mode === "clean") {
        admitted = await pending;
        assert.equal(admitted.evidence.mode, "owned");
      } else await assert.rejects(pending, { diagnosticCode: "admission-unconfirmed" });
      assert.equal(intercepted, true);
      await release;
      if (mode === "retained") assert.ok(await readFile(path.join(directory, "owner.json")));
    } finally {
      interrupt.mock.restore();
      await release;
      await admitted?.release(true);
      await first.release(true);
    }
  });
});

test("host admission rediscovers a replaced owner without transferring inherited authority", { timeout: 15000 }, async (t) => {
  const root = await fixture(t);
  for (const inherited of [false, true]) await t.test(String(inherited), async (t) => {
    const directory = path.join(root, String(inherited)), first = await acquireHostVerificationSlot(root, { directory });
    let replacement, admitted, replace = true, notify;
    const queued = new Promise((resolve) => { notify = resolve; });
    const stat = fileSystem.lstat;
    const handoff = t.mock.method(fileSystem, "lstat", async (file, ...args) => {
      if (file === path.join(directory, "owner.json") && replace) {
        replace = false;
        await first.release(true);
        replacement = await acquireHostVerificationSlot(root, { directory, inherited: "" });
      }
      return stat(file, ...args);
    });
    syncBuiltinESMExports();
    try {
      const pending = acquireHostVerificationSlot(root, { directory, onWait: notify,
        inherited: inherited ? first.environment[admissionVariable] : "" });
      if (inherited) await assert.rejects(pending, { diagnosticCode: "admission-unconfirmed" });
      else {
        const outcome = await Promise.race([queued, pending.then(() => "admitted", (error) => ({ error }))]);
        assert.equal(outcome, undefined, "The next live owner must be queued behind, not treated as corrupt or bypassed.");
        await replacement.release(true);
        admitted = await pending;
        assert.equal(admitted.evidence.mode, "owned");
      }
      assert.equal(replace, false);
    } finally {
      handoff.mock.restore();
      syncBuiltinESMExports();
      await admitted?.release(true);
      await replacement?.release(true);
      await first.release(true);
    }
  });
  await t.test("unverifiable", async (t) => {
    const directory = path.join(root, "unverifiable"), first = await acquireHostVerificationSlot(root, { directory });
    const file = path.join(directory, "owner.json"), owner = JSON.parse(await readFile(file, "utf8"));
    const altered = JSON.stringify({ ...owner, id: randomUUID() });
    await writeFile(file, altered);
    let probes = 0;
    const connect = net.connect;
    const observe = t.mock.method(net, "connect", (...args) => { probes++; return connect(...args); });
    try {
      await assert.rejects(acquireHostVerificationSlot(root, { directory, inherited: "" }),
        { diagnosticCode: "admission-unconfirmed" });
      assert.ok(probes > 0 && probes <= 4, "Conflicting ownership must not cause an unlimited retry loop.");
      assert.equal(await readFile(file, "utf8"), altered);
    } finally {
      observe.mock.restore();
      await first.release(false);
    }
  });
});

async function ciFixture(t, { documentation = false, macos = false } = {}) {
  const root = await fixture(t);
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  await mkdir(path.join(root, ".data"));
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: { "test:workflow": macos ? "node scripts/test-workflow.mjs" : 'node -e "process.exit(0)"' },
  }) + "\n");
  if (macos) await copyFile("scripts/test-workflow.mjs", path.join(root, "scripts", "test-workflow.mjs"));
  await git("init", "--quiet");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "CI base");
  const originalBase = await git("rev-parse", "HEAD");
  await writeFile(path.join(root, "scripts", "verification.mjs"), "// already in the PR base\n");
  for (const name of ["development-paths", "development-policy"]) {
    await writeFile(path.join(root, "scripts", `${name}.mjs`), "// protected fixture input\n");
  }
  await git("add", ".");
  await git("commit", "--quiet", "-m", "Earlier shared infrastructure change");
  const base = await git("rev-parse", "HEAD");
  await git("checkout", "--quiet", "-b", "candidate");
  if (!documentation) await mkdir(path.join(root, "scripts", "tests"));
  await writeFile(path.join(root, documentation ? "README.md" :
    macos ? "scripts/tests/process.test.mjs" : "scripts/tests/linux-runtime.test.mjs"), "// fixture input\n");
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
  const report = { ...plan, group: documentation ? "all" : "tooling", status: "passed", complete: true, fixtureEvidence: true,
    checks: documentation ? [] : [{ id: "workflow-tests", status: "passed", exitCode: 0, execution: syntheticExecution(plan.source) }] };
  return { root, base, originalBase, candidate, repository, pullRequest, env, context, plan, report };
}

test("the CI collector CLI cannot qualify selected macOS coverage from Windows artifacts alone", async (t) => {
  const item = await ciFixture(t, { macos: true }), inputs = path.join(item.root, ".data", "ci", "inputs");
  assert.equal(item.plan.ciMacos, true);
  const reports = item.plan.toolingShards.parts.map((part) => ({
    ...item.plan, fixtureEvidence: true, group: "tooling", status: "partial", complete: false,
    environment: { platform: "win32", architecture: "x64" },
    checks: [{ id: "workflow-tests", status: "passed", exitCode: 0,
      toolingShard: toolingShardDescriptor(item.plan, part.id), execution: syntheticExecution(item.plan.source),
      executionState: "exited", commandOutcome: {
        observedProcess: "owned-command-supervisor", reason: "exit", exitCode: 0, cleanupFailure: null,
      } }],
  }));
  const store = async (unit, report) => {
    const directory = path.join(inputs, `verification-${unit}-attempt-2`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "ci-report.json"), JSON.stringify(ciReportEnvelope(report, item.context, unit)));
  };
  for (const report of reports) await store(`tooling-${report.checks[0].toolingShard.id}`, report);
  const invoke = async (name, status) => {
    const report = path.join(item.root, ".data", "ci", name, "ci-report.json");
    await exec(process.execPath, [path.resolve("scripts/verification-ci.mjs"), "--collect", "--base", item.base,
      "--inputs", inputs, "--report", report, "--upstream", "tooling:success", "--upstream", `macos:${status}`],
    { cwd: item.root, env: item.env, timeout: 30000 });
    return JSON.parse(await readFile(report, "utf8"));
  };
  await assert.rejects(invoke("missing-mac", "success"), { code: 1 });
  const macos = structuredClone(reports.find((report) => report.checks[0].toolingShard.id === "native"));
  macos.environment = { platform: "darwin", architecture: "arm64" };
  await store("macos", macos);
  const accepted = await invoke("complete", "success");
  assert.equal(accepted.report.complete, true);
  assert.equal(accepted.macos.environment.platform, "darwin");
  assert.equal(accepted.inputs.find((input) => input.unit === "macos").attempt, 2);
  await assert.rejects(invoke("cancelled-mac", "cancelled"), { code: 1 });
  const blocked = JSON.parse(await readFile(path.join(item.root, ".data", "ci", "cancelled-mac", "gate.json"), "utf8"));
  assert.equal(blocked.complete, false);
});

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

test("CI collection rejects raw gate report collisions before writing", async (t) => {
  const item = await ciFixture(t), inputs = path.join(item.root, ".data", "ci", "inputs");
  await mkdir(inputs, { recursive: true });
  const input = path.join(inputs, "ci-report.json");
  const bytes = JSON.stringify(ciReportEnvelope(item.report, item.context, "tooling-all"));
  await writeFile(input, bytes);
  const invoke = (report, directory = inputs) => exec(process.execPath,
    [path.resolve("scripts/verification-ci.mjs"), "--collect", "--base", item.base,
      "--inputs", directory, "--report", report, "--upstream", "tooling:success"],
    { cwd: item.root, env: item.env, timeout: 30000 });
  const names = process.platform === "win32" ? ["gate.json", "GATE.JSON", "Gate.Json"] : ["gate.json"];
  for (const [index, name] of names.entries()) await t.test(name, async () => {
    const directory = path.join(item.root, ".data", "ci", `collision-${index}`);
    await assert.rejects(invoke(path.join(directory, name)), { code: 1 });
    await assert.rejects(fileSystem.lstat(directory), { code: "ENOENT" },
      "A rejected envelope filename must not leave a raw report or output directory.");
    assert.equal(await readFile(input, "utf8"), bytes);
  });
  await t.test("missing input directory", async () => {
    const directory = path.join(item.root, ".data", "ci", "missing-input");
    const output = path.join(item.root, ".data", "ci", "invalid-output", "gate.json");
    await assert.rejects(invoke(output, directory), (error) => error.code === 1 &&
      JSON.parse(error.stderr).failure.reason === "configuration");
    await assert.rejects(fileSystem.lstat(directory), { code: "ENOENT" });
    await assert.rejects(fileSystem.lstat(path.dirname(output)), { code: "ENOENT" });
  });
  await t.test("distinct envelope and diagnostic reports", async () => {
    const directory = path.join(item.root, ".data", "ci", "accepted"), report = path.join(directory, "ci-report.json");
    await invoke(report);
    const envelope = JSON.parse(await readFile(report, "utf8"));
    assert.equal(envelope.kind, "ci-verification-report");
    assert.equal(envelope.report.status, "passed");
    assert.equal(envelope.report.complete, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "gate.json"), "utf8")), envelope.report);
    assert.equal(await readFile(input, "utf8"), bytes);
  });
});

test("fork CI seals and collects eligible evidence without relaxing base or merge ancestry", async (t) => {
  for (const documentation of [false, true]) await t.test(documentation ? "documentation" : "tooling", async (t) => {
    const item = await ciFixture(t, { documentation }), eventPath = item.env.GITHUB_EVENT_PATH;
    const event = JSON.parse(await readFile(eventPath, "utf8"));
    event.pull_request.head.repo = { full_name: "contributor/verification", id: 2 };
    await writeFile(eventPath, JSON.stringify(event));
    const context = await githubVerificationContext(item.root, item.env);
    assert.equal(context.candidate, item.candidate);
    assert.equal(context.pullRequestBase, item.base);
    const input = path.join(item.root, ".data", "ci", "inputs"), directory = path.join(item.root, ".data", "ci", "gate");
    await mkdir(input, { recursive: true });
    if (!documentation) {
      const report = path.join(input, "report.json");
      await writeFile(report, JSON.stringify(item.report));
      await exec(process.execPath, [path.resolve("scripts/verification-ci.mjs"), "--seal", "--unit", "tooling-all",
        "--input", report, "--report", path.join(input, "ci-report.json")],
      { cwd: item.root, env: item.env, timeout: 30000 });
    }
    const report = path.join(directory, "ci-report.json");
    await exec(process.execPath, [path.resolve("scripts/verification-ci.mjs"), "--collect", "--base", item.base,
      "--inputs", input, "--report", report, ...(!documentation ? ["--upstream", "tooling:success"] : [])],
    { cwd: item.root, env: item.env, timeout: 30000 });
    assert.equal(JSON.parse(await readFile(report, "utf8")).report.complete, true);
    for (const change of [
      (value) => { value.repository.full_name = "foreign/verification"; },
      (value) => { value.pull_request.base.repo.full_name = "foreign/verification"; },
      (value) => { value.pull_request.head.repo.full_name = "../verification"; },
      (value) => { value.pull_request.head.sha = item.base; },
    ]) {
      const invalid = structuredClone(event); change(invalid);
      await writeFile(eventPath, JSON.stringify(invalid));
      await assert.rejects(githubVerificationContext(item.root, item.env), { diagnosticCode: "ci-evidence" });
    }
  });
  const workflow = (await readFile(".github/workflows/ci.yml", "utf8")).replaceAll("\r\n", "\n");
  const device = workflow.slice(workflow.indexOf("  device:\n"), workflow.indexOf("  gate:\n"));
  assert.ok(device.includes("github.event.pull_request.head.repo.full_name == github.repository"));
});

test("CI qualification rejects stale, foreign, incomplete and relabelled platform evidence", async (t) => {
  const item = await ciFixture(t);
  const leaf = ciReportEnvelope(item.report, item.context, "tooling-all");
  const gate = collectCIReports(item.plan, item.context, [leaf], new Map([["tooling", "success"]]));
  const live = { repository: item.repository, pullRequest: item.pullRequest, candidate: item.candidate,
    baseReference: { ref: "refs/heads/main", object: { type: "commit", sha: item.base } },
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
    (value) => { value.baseReference.object.sha = "f".repeat(40); },
    (value) => { delete value.baseReference; },
    (value) => { value.baseReference.ref = "refs/heads/other"; },
    (value) => { value.baseReference.object.type = "tag"; },
    (value) => {
      value.pullRequest.head.repo = { full_name: "contributor/verification", id: 2 };
      value.artifact.workflow_run.head_repository_id = 2;
    },
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
  const laggedSnapshot = structuredClone(live);
  laggedSnapshot.pullRequest.base.sha = "f".repeat(40);
  assert.equal(validateLiveCIEnvelope(gate, laggedSnapshot), gate,
    "The authenticated live branch, not a lagged PR snapshot, identifies the current base.");
  assert.equal(laggedSnapshot.pullRequest.base.sha, "f".repeat(40), "Retain the original PR response unchanged.");
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

test("the qualification CLI isolates approval code and keeps report names separate from authenticated evidence", async (t) => {
  const item = await ciFixture(t), workspace = path.join(item.root, ".data", "qualification-worktree");
  await exec("git", ["remote", "add", "origin", `https://github.com/${item.repository}.git`], { cwd: item.root });
  await exec("git", ["worktree", "add", "--quiet", workspace, "candidate"], { cwd: item.root });
  try {
    const leaf = ciReportEnvelope(item.report, item.context, "tooling-all");
    const envelope = collectCIReports(item.plan, item.context, [leaf], new Map([["tooling", "success"]]));
    const directory = path.join(item.root, ".data", "qualification-fixture");
    await mkdir(directory);
    const body = path.join(directory, "ci-report.json"), gate = path.join(directory, "gate.json");
    await writeFile(body, JSON.stringify(envelope));
    await writeFile(gate, JSON.stringify(envelope.report));
    const creator = path.join(directory, "archive.ps1"), archive = path.join(directory, "evidence.zip");
    await writeFile(creator, [
      "param($Archive,$Envelope,$Gate)",
      "$ErrorActionPreference='Stop'",
      "$zip=[IO.Compression.ZipFile]::Open($Archive,[IO.Compression.ZipArchiveMode]::Create)",
      "try { foreach($item in @(@('ci-report.json',$Envelope),@('gate.json',$Gate))) {",
      " $writer=[IO.StreamWriter]::new($zip.CreateEntry($item[0]).Open(),[Text.UTF8Encoding]::new($false))",
      " try { $writer.Write([IO.File]::ReadAllText($item[1])) } finally { $writer.Dispose() }",
      "} } finally { $zip.Dispose() }",
    ].join("\n"));
    await exec("pwsh", ["-NoProfile", "-NonInteractive", "-File", creator, "-Archive", archive,
      "-Envelope", body, "-Gate", gate], { timeout: 30000 });
    const bytes = await readFile(archive), digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const commit = { sha: item.context.tested.head, tree: { sha: item.context.tested.tree },
      parents: [{ sha: item.base }, { sha: item.candidate }] };
    const rows = (await exec("git", ["ls-tree", "-r", "-z", item.context.tested.head], { cwd: item.root })).stdout
      .split("\0").filter(Boolean).map((line) => {
        const [, mode, type, sha, file] = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
        return { mode, type, sha, path: file };
      });
    const run = { id: 1234, event: "pull_request", path: ".github/workflows/ci.yml", run_attempt: 2,
      head_sha: item.candidate, status: "completed", conclusion: "success", pull_requests: [{ number: 11 }],
      html_url: `https://github.com/${item.repository}/actions/runs/1234` };
    const artifact = { id: 42, name: "verification-summary-attempt-2", expired: false, digest, size_in_bytes: bytes.length,
      workflow_run: { id: 1234, head_sha: item.candidate, repository_id: 1, head_repository_id: 1 } };
    const prefix = `repos/${item.repository}`;
    const baseEndpoint = `${prefix}/git/ref/heads/main`;
    const baseReference = { ref: "refs/heads/main", object: { type: "commit", sha: item.base } };
    const api = {
      [`${prefix}/pulls/11`]: item.pullRequest,
      [baseEndpoint]: baseReference,
      [`${prefix}/actions/runs/1234`]: run,
      [`${prefix}/actions/runs/1234/attempts/2/jobs?per_page=100`]: {
        total_count: 1, jobs: [{ name: "Required verification", status: "completed", conclusion: "success" }],
      },
      [`${prefix}/actions/runs/1234/artifacts?per_page=100&page=1`]: { total_count: 1, artifacts: [artifact] },
      [`${prefix}/git/commits/${commit.sha}`]: commit,
      [`${prefix}/git/trees/${commit.tree.sha}?recursive=1`]: { truncated: false, tree: rows },
    };
    const fixtureData = path.join(directory, "api.json"), preload = path.join(directory, "github-fixture.mjs");
    const calls = path.join(directory, "github-calls.jsonl");
    const responses = { api, archive: bytes.toString("base64"), download: `${prefix}/actions/artifacts/42/zip` };
    await writeFile(fixtureData, JSON.stringify(responses));
    await writeFile(preload, [
      "import childProcess from 'node:child_process';import {readFileSync,appendFileSync} from 'node:fs';",
      "import {promisify} from 'node:util';import {syncBuiltinESMExports,registerHooks} from 'node:module';",
      "registerHooks({resolve(specifier,context,next){",
      " if(specifier.endsWith('/development-policy.mjs'))throw new Error('Qualification loaded approval implementation');",
      " return next(specifier,context);",
      "}});",
      `const fixture=JSON.parse(readFileSync(${JSON.stringify(fixtureData)},'utf8'));`,
      "const original=childProcess.execFile, native=promisify(original);",
      "const replacement=(file,...args)=>{if(file==='gh')throw new Error('Unexpected non-promisified GitHub call');return original(file,...args);};",
      "replacement[promisify.custom]=(file,args,options)=>{",
      " if(file!=='gh')return native(file,args,options);",
      " if(args.length!==4||args[0]!=='api'||args[1]!=='--hostname'||args[2]!=='github.com')throw new Error('Unexpected GitHub invocation');",
      ` appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');`,
      " const endpoint=args[3];let stdout;",
      " if(endpoint===fixture.download)stdout=Buffer.from(fixture.archive,'base64');",
      " else{if(!Object.hasOwn(fixture.api,endpoint))throw new Error('Unmapped GitHub endpoint');",
      "  const value=fixture.api[endpoint];stdout=JSON.stringify(Array.isArray(value)?(value.length>1?value.shift():value[0]):value);}",
      " return Promise.resolve({stdout,stderr:''});",
      "};childProcess.execFile=replacement;syncBuiltinESMExports();",
    ].join("\n"));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const [index, name] of ["qualification.json", "ci-report.json", "ci-evidence.zip", "gate.json", "evidence"].entries()) {
      await t.test(name, async () => {
        const file = path.join(workspace, ".data", "verification", `output-${index}`, name);
        const args = ["--import", pathToFileURL(preload).href, path.resolve("scripts/verification-ci.mjs"),
          "--qualify", "--repository", item.repository, "--pr", "11", "--run", "1234",
          "--base", item.base, "--report", file];
        await exec(process.execPath, args, { cwd: workspace, env, timeout: 60000 });
        const qualified = JSON.parse(await readFile(file, "utf8"));
        assert.equal(qualified.kind, "ci-qualification");
        assert.equal(qualified.status, "verified");
        assert.equal(qualified.candidate.head, item.candidate);
        assert.equal(qualified.tested.head, item.context.tested.head);
        assert.deepEqual(JSON.parse(await readFile(path.resolve(workspace, qualified.evidence), "utf8")), envelope);
        assert.notEqual(path.resolve(workspace, qualified.evidence), file);
        assert.equal(path.dirname(path.resolve(workspace, qualified.evidence)), `${file}.evidence`);
        assert.deepEqual(await readFile(path.join(path.dirname(path.resolve(workspace, qualified.evidence)), "ci-evidence.zip")), bytes);
        if (index === 0) {
          const retained = await readFile(file);
          await assert.rejects(exec(process.execPath, args, { cwd: workspace, env, timeout: 60000 }));
          assert.deepEqual(await readFile(file), retained);
          assert.deepEqual(JSON.parse(await readFile(path.resolve(workspace, qualified.evidence), "utf8")), envelope);
        }
      });
    }
    await t.test("approval presentation edits do not load candidate approval code", async () => {
      const { captureCandidateImplementation } = await import("../native-candidate.mjs");
      const captured = await captureCandidateImplementation(), implementation = path.join(directory, "presentation-edit");
      await mkdir(implementation);
      for (const { name } of captured.files) await copyFile(path.join(captured.directory, name), path.join(implementation, name));
      await writeFile(path.join(implementation, "development-policy.mjs"),
        "throw new Error('Candidate approval presentation must not be evaluated by qualification');\n");
      const file = path.join(workspace, ".data", "verification", "presentation-edit", "qualification.json");
      await exec(process.execPath, ["--import", pathToFileURL(preload).href, path.join(implementation, "verification-ci.mjs"),
        "--qualify", "--repository", item.repository, "--pr", "11", "--run", "1234",
        "--base", item.base, "--report", file], { cwd: workspace, env, timeout: 60000 });
      assert.equal(JSON.parse(await readFile(file, "utf8")).status, "verified");
    });
    for (const name of ["development-paths", "development-policy"]) await t.test(`protected ${name} identity`, async () => {
      const changed = structuredClone(responses);
      const tree = changed.api[`${prefix}/git/trees/${commit.tree.sha}?recursive=1`];
      tree.tree.find((entry) => entry.path === `scripts/${name}.mjs`).sha = "f".repeat(40);
      await writeFile(fixtureData, JSON.stringify(changed));
      const file = path.join(workspace, ".data", "verification", `changed-${name}`, "qualification.json");
      try {
        await assert.rejects(exec(process.execPath, ["--import", pathToFileURL(preload).href,
          path.resolve("scripts/verification-ci.mjs"), "--qualify", "--repository", item.repository,
          "--pr", "11", "--run", "1234", "--base", item.base, "--report", file],
        { cwd: workspace, env, timeout: 60000 }), (error) => error.code === 1 && /ci-policy-mismatch/.test(error.stderr));
        await assert.rejects(readFile(file), { code: "ENOENT" });
      } finally { await writeFile(fixtureData, JSON.stringify(responses)); }
    });
    for (const when of ["initial", "final", "snapshot-only"]) await t.test(`live base ${when}`, async () => {
      const changed = structuredClone(responses);
      if (when === "snapshot-only") {
        const old = structuredClone(item.pullRequest);
        old.base.sha = "f".repeat(40);
        changed.api[`${prefix}/pulls/11`] = [old, item.pullRequest];
      } else {
        const advanced = { ...baseReference, object: { type: "commit", sha: "f".repeat(40) } };
        changed.api[baseEndpoint] = when === "initial" ? advanced : [baseReference, advanced];
      }
      await writeFile(fixtureData, JSON.stringify(changed));
      const file = path.join(workspace, ".data", "verification", `base-${when}`, "qualification.json");
      const invoke = () => exec(process.execPath, ["--import", pathToFileURL(preload).href,
        path.resolve("scripts/verification-ci.mjs"), "--qualify", "--repository", item.repository,
        "--pr", "11", "--run", "1234", "--base", item.base, "--report", file],
      { cwd: workspace, env, timeout: 60000 });
      try {
        if (when === "snapshot-only") {
          await invoke();
          const qualified = JSON.parse(await readFile(file, "utf8"));
          assert.equal(qualified.status, "verified");
          assert.equal(qualified.pullRequest.base, item.base);
        } else {
          await assert.rejects(invoke(), (error) => error.code === 1 && /ci-base-changed/.test(error.stderr));
          await assert.rejects(readFile(file), { code: "ENOENT" });
        }
      } finally { await writeFile(fixtureData, JSON.stringify(responses)); }
    });
    await t.test("original task Mac coverage cannot disappear under a narrower PR base", async () => {
      const original = await verificationPlan(workspace, item.originalBase);
      assert.deepEqual(original.requiredChecks, item.plan.requiredChecks);
      assert.equal(original.ciMacos, true);
      assert.equal(item.plan.ciMacos, false);
      const file = path.join(workspace, ".data", "verification", "missing-original-macos", "qualification.json");
      await assert.rejects(exec(process.execPath, ["--import", pathToFileURL(preload).href,
        path.resolve("scripts/verification-ci.mjs"), "--qualify", "--repository", item.repository,
        "--pr", "11", "--run", "1234", "--base", item.originalBase, "--report", file],
      { cwd: workspace, env, timeout: 60000 }), (error) => error.code === 1 && /ci-evidence/.test(error.stderr));
      await assert.rejects(readFile(file), { code: "ENOENT" });
    });
    const ledger = path.join(workspace, ".data", "verification", "retained", "run");
    await mkdir(ledger, { recursive: true });
    await writeFile(path.join(ledger, "run.json"), "Retained ledger marker\n");
    const before = await readFile(calls);
    await t.test("retained ledger", async () => {
      const file = path.join(ledger, "qualification.json");
      await assert.rejects(exec(process.execPath, ["--import", pathToFileURL(preload).href,
        path.resolve("scripts/verification-ci.mjs"), "--qualify", "--repository", item.repository,
        "--pr", "11", "--run", "1234", "--base", item.base, "--report", file],
      { cwd: workspace, env, timeout: 60000 }), (error) => error.code === 1 && /run-output-reused/.test(error.stderr));
      assert.deepEqual(await readFile(calls), before, "An invalid output must fail before GitHub access.");
      await assert.rejects(readFile(file), { code: "ENOENT" });
    });
    await t.test("direct retained ledger", async () => {
      await assert.rejects(qualifyGitHubCI(workspace, { repository: item.repository, pullRequest: 11, runId: 1234,
        base: item.base, directory: ledger, api: () => assert.fail("Invalid direct output must not access GitHub.") }),
      { diagnosticCode: "run-output-reused" });
    });
    await t.test("direct private control storage", async () => {
      const directory = path.join(workspace, ".data", "verification", "local");
      await assert.rejects(qualifyGitHubCI(workspace, { repository: item.repository, pullRequest: 11, runId: 1234,
        base: item.base, directory, api: () => assert.fail("Private control storage must not access GitHub.") }),
      { diagnosticCode: "run-output-reused" });
      await assert.rejects(fileSystem.lstat(directory), { code: "ENOENT" });
    });
    await t.test("CLI private control storage", async () => {
      const control = path.join(workspace, ".data", "verification", "local");
      for (const file of [control, path.join(control, "execution.lock"), path.join(control, "receipt.key")]) {
        await assert.rejects(exec(process.execPath, ["--import", pathToFileURL(preload).href,
          path.resolve("scripts/verification-ci.mjs"), "--qualify", "--repository", item.repository,
          "--pr", "11", "--run", "1234", "--base", item.base, "--report", file],
        { cwd: workspace, env, timeout: 60000 }), (error) => error.code === 1 && /run-output-reused/.test(error.stderr));
        assert.deepEqual(await readFile(calls), before);
        await assert.rejects(fileSystem.lstat(control), { code: "ENOENT" });
      }
    });
    await t.test("reserved ledger filename", async () => {
      const file = path.join(workspace, ".data", "verification", "reserved", "run.json");
      await assert.rejects(exec(process.execPath, ["--import", pathToFileURL(preload).href,
        path.resolve("scripts/verification-ci.mjs"), "--qualify", "--repository", item.repository,
        "--pr", "11", "--run", "1234", "--base", item.base, "--report", file],
      { cwd: workspace, env, timeout: 60000 }), (error) => error.code === 1 && /run-output-reused/.test(error.stderr));
      assert.deepEqual(await readFile(calls), before);
      await assert.rejects(readFile(file), { code: "ENOENT" });
    });
    await t.test("collection cannot create input directories inside a ledger", async () => {
      const retained = path.join(item.root, ".data", "verification", "retained", "run");
      const input = path.join(retained, "nested"), output = path.join(item.root, ".data", "ci", "invalid-input", "ci-report.json");
      await mkdir(retained, { recursive: true });
      await writeFile(path.join(retained, "run.json"), "Retained ledger marker\n");
      await assert.rejects(exec(process.execPath, [path.resolve("scripts/verification-ci.mjs"), "--collect",
        "--inputs", input, "--report", output, "--base", item.base, "--upstream", "tooling:success"],
      { cwd: item.root, env: item.env, timeout: 30000 }), { code: 1 });
      const result = JSON.parse(await readFile(output, "utf8"));
      assert.equal(result.report.failure.reason, "run-output-reused");
      await assert.rejects(fileSystem.lstat(input), { code: "ENOENT" });
      assert.equal(await readFile(path.join(retained, "run.json"), "utf8"), "Retained ledger marker\n");
    });
  } finally {
    await exec("git", ["worktree", "remove", "--force", workspace], { cwd: item.root });
  }
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
