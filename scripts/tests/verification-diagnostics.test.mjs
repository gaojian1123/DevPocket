import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);

test("an actual compiler check exposes its trusted source/code through the public diagnostic CLI without assertion values", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/check-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture"], { cwd: root });
  const compiler = path.resolve("node_modules/typescript/bin/tsc");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
    "test:workflow": "node -e \"process.exit(0)\"",
    typecheck: `node "${compiler}" --noEmit --pretty false --skipLibCheck backend/src/failure.ts`,
  } }));
  await mkdir(path.join(root, "backend", "src"), { recursive: true });
  await writeFile(path.join(root, "backend", "src", "failure.ts"), 'const value: number = "PRIVATE_COMPILER_CANARY";\n');
  const directory = path.join(root, ".data", "ci", "backend"), report = path.join(directory, "report.json");
  await assert.rejects(exec(process.execPath, [path.resolve("scripts/verify.mjs"), "--repo", root,
    "--base", "HEAD", "--group", "backend", "--report", report], { timeout: 45000 }), (error) => error.code === 1);
  const result = await exec(process.execPath, [path.resolve("scripts/verification-diagnostics.mjs"),
    "--directory", directory, "--job", "backend"], { cwd: root, timeout: 20000 });
  const output = JSON.parse(await readFile(path.join(directory, "verification-diagnostics.json"), "utf8"));
  const check = output.checks.find((item) => item.id === "typecheck");
  assert.equal(check.status, "failed");
  assert.equal(check.failure.phase, "command");
  assert.equal(check.failure.reason, "command-failed");
  assert.ok(check.hints.some((hint) => hint.kind === "compiler" && hint.code === "TS2322" &&
    hint.file === "backend/src/failure.ts" && hint.line === 1));
  assert.equal(output.acceptance, false);
  assert.ok(!result.stdout.includes("PRIVATE_COMPILER_CANARY"));
  assert.ok(!result.stdout.includes(root));
});

test("tooling failures and plan causes survive public diagnostics without raw report or log fields", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/tooling-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
    "test:workflow": "node --test --test-reporter=spec scripts/tests/development-workflow.test.mjs",
  } }));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture"], { cwd: root });
  await mkdir(path.join(root, "scripts", "tests"), { recursive: true });
  await writeFile(path.join(root, "scripts", "tests", "development-workflow.test.mjs"), [
    'import {test} from "node:test";',
    'import assert from "node:assert/strict";',
    'test("synthetic failure", () => { assert.fail("PRIVATE_TOOLING_LOG_CANARY"); });',
  ].join("\n"));
  const directory = path.join(root, ".data", "ci", "tooling"), reportFile = path.join(directory, "report.json");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(exec(process.execPath, [path.resolve("scripts/verify.mjs"), "--repo", root, "--base", "HEAD",
    "--group", "tooling", "--report", reportFile], { env, timeout: 45000 }), (error) => error.code === 1);
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  assert.equal(report.status, "failed");
  assert.deepEqual(report.requiredChecks, ["workflow-tests"]);
  const exporter = path.resolve("scripts/verification-diagnostics.mjs");
  const commands = path.join(root, ".data", "commands", "_runner_file_commands");
  await mkdir(commands, { recursive: true });
  const output = path.join(commands, `set_output_${randomUUID()}`), summary = path.join(commands, `step_summary_${randomUUID()}`);
  await writeFile(output, "");
  await writeFile(summary, "");
  const exported = await exec(process.execPath, [exporter, "--directory", directory, "--job", "tooling", "--step-result", "failure", "--github"],
    { cwd: root, timeout: 20000, env: { ...env, GITHUB_ACTIONS: "true", RUNNER_TEMP: path.dirname(commands),
      GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
  const diagnostics = JSON.parse(await readFile(path.join(directory, "verification-diagnostics.json"), "utf8"));
  assert.equal(diagnostics.job, "tooling");
  assert.equal(diagnostics.acceptance, false);
  assert.equal(diagnostics.collectionStatus, "completed");
  assert.deepEqual(diagnostics.selection.requiredGroups, ["tooling"]);
  assert.deepEqual(diagnostics.selection.selectionReasons[0].paths, ["scripts/tests/development-workflow.test.mjs"]);
  assert.equal(diagnostics.checks[0].id, "workflow-tests");
  assert.equal(diagnostics.checks[0].status, "failed");
  assert.equal(diagnostics.checks[0].failure.reason, "command-failed");
  assert.ok(diagnostics.checks[0].hints.some((hint) => hint.kind === "test-declaration-hint"));
  assert.equal(await readFile(output, "utf8"), "report_ready=true\n");
  assert.ok(!exported.stdout.includes("PRIVATE_TOOLING_LOG_CANARY"));
  assert.ok(!(await readFile(summary, "utf8")).includes("PRIVATE_TOOLING_LOG_CANARY"));
  const injected = path.join(root, ".data", "ci", "injected");
  await mkdir(injected);
  await writeFile(path.join(injected, "gate.json"), JSON.stringify({
    ...report, status: "blocked", checks: [],
    failure: { reason: "upstream-job-failed", phase: "aggregate", group: "tooling", outcome: "skipped",
      summary: "PRIVATE_TOOLING_REPORT_CANARY" },
    selectionReasons: [{ ...report.selectionReasons[0], description: "PRIVATE_TOOLING_REPORT_CANARY",
      paths: [...report.selectionReasons[0].paths, "scripts/PRIVATE_TOOLING_REPORT_CANARY.mjs"],
      checks: ["PRIVATE_TOOLING_REPORT_CANARY"], groups: ["PRIVATE_TOOLING_REPORT_CANARY"] }],
  }));
  const projected = await exec(process.execPath, [exporter, "--directory", injected, "--job", "gate"],
    { cwd: root, timeout: 20000 });
  const gate = JSON.parse(await readFile(path.join(injected, "verification-diagnostics.json"), "utf8"));
  assert.equal(gate.failure.group, "tooling");
  assert.equal(gate.failure.outcome, "skipped");
  assert.equal(gate.selection.selectionReasons[0].omittedPaths, 1);
  assert.deepEqual(gate.selection.selectionReasons[0].checks, ["workflow-tests"]);
  assert.ok(!projected.stdout.includes("PRIVATE_TOOLING_REPORT_CANARY"));
  assert.ok(!JSON.stringify(gate).includes("PRIVATE_TOOLING_REPORT_CANARY"));
});

test("legacy diagnostic selections retain backend grouping without relabelling historical checks", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/legacy-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  await exec("git", ["init", "--quiet"], { cwd: root });
  const backend = ["workflow-tests", "typecheck", "backend-tests", "backend-build", "schema"];
  for (const sample of [
    { name: "backend", requiredChecks: backend, groups: ["backend"] },
    { name: "mixed", requiredChecks: [...backend, "android-build", "android-device"], groups: ["backend", "android", "device"] },
  ]) {
    await t.test(sample.name, async () => {
      const directory = path.join(root, ".data", "ci", sample.name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "report.json"), JSON.stringify({
        version: 1, status: "partial", group: "backend", requiredChecks: sample.requiredChecks,
        checks: sample.requiredChecks.map((id) => backend.includes(id)
          ? { id, status: "passed", exitCode: 0 } : { id, status: "not_run" }),
      }));
      await exec(process.execPath, [path.resolve("scripts/verification-diagnostics.mjs"),
        "--directory", directory, "--job", "backend"], { cwd: root, timeout: 20000 });
      const output = JSON.parse(await readFile(path.join(directory, "verification-diagnostics.json"), "utf8"));
      assert.equal(output.acceptance, false);
      assert.equal(output.collectionStatus, "completed");
      assert.deepEqual(output.selection.requiredChecks, sample.requiredChecks);
      assert.deepEqual(output.selection.requiredGroups, sample.groups);
      assert.deepEqual(output.selection.selectionReasons, []);
      assert.deepEqual(output.checks.map((check) => check.id), backend);
    });
  }
  const { projectVerificationSelection } = await import("../verification-policy.mjs");
  const file = "scripts/workflow-extension.mjs";
  const legacy = projectVerificationSelection({
    version: 1, requiredChecks: backend,
    selectionReasons: [{ rule: "task-routing", paths: [file] }],
  }, new Set([file]));
  assert.deepEqual(legacy.requiredGroups, ["backend"]);
  assert.deepEqual(legacy.selectionReasons, [], "Version-2 impact rules must not explain a version-1 plan.");
});

test("check log hints accept only source-indexed locations and fixed exception/code identifiers", async () => {
  const { checkLogHints } = await import("../verification-diagnostics.mjs");
  const sources = new Set(["backend/src/known.ts", "deployment/azure/probe/test_receiver.py"]);
  const text = [
    "backend/src/known.ts(12,7): error TS2322: PRIVATE_ASSERTION_CANARY",
    "private/PRIVATE_PATH.ts(12,7): error TS2322: private",
    "ModuleNotFoundError: No module named 'PRIVATE_MODULE'",
    `  File "${path.join(process.cwd(), "deployment", "azure", "probe", "test_receiver.py")}", line 12, in PRIVATE_FUNCTION`,
    "private.secret.TokenError: PRIVATE_ERROR_VALUE",
  ].join("\n");
  const result = checkLogHints(text, process.cwd(), sources);
  assert.ok(result.some((item) => item.code === "TS2322" && item.file === "backend/src/known.ts"));
  assert.ok(result.some((item) => item.type === "ModuleNotFoundError"));
  assert.ok(result.some((item) => item.file === "deployment/azure/probe/test_receiver.py" && item.line === 12));
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
});

test("actual source-index and log-read collector exceptions publish safe descriptors but remain nonzero", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/collector-exit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  await exec("git", ["init", "--quiet"], { cwd: root });
  const emptyPath = path.join(root, ".data", "empty-bin");
  await mkdir(emptyPath, { recursive: true });
  const exporter = path.resolve("scripts/verification-diagnostics.mjs");
  for (const kind of ["source", "log"]) {
    const directory = path.join(root, ".data", "ci", kind);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "report.json"), JSON.stringify({
      version: 1, status: kind === "source" ? "passed" : "failed", group: "backend",
      checks: kind === "source" ? [] : [{ id: "workflow-tests", status: "failed", exitCode: 1, privateLog: { availability: "retained" } }],
    }));
    if (kind === "log") await mkdir(path.join(directory, "workflow-tests.log"));
    await assert.rejects(exec(process.execPath, [exporter, "--directory", directory, "--job", "backend"],
      { cwd: root, env: kind === "source" ? { ...process.env, PATH: emptyPath } : process.env, timeout: 20000 }),
    (error) => error.code === 1);
    const output = JSON.parse(await readFile(path.join(directory, "verification-diagnostics.json"), "utf8"));
    assert.equal(output.collectionStatus, "failed");
    assert.equal(output.status, kind === "source" ? "passed" : "failed");
    assert.ok(output.collectionErrors.length > 0);
    assert.equal(output.acceptance, false);
  }
});

test("a valid-looking foreign startup report cannot suppress the current owned failure fallback", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/startup-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  await exec("git", ["init", "--quiet"], { cwd: root });
  const directory = path.join(root, ".data", "ci", "native-startup"), owner = randomUUID();
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "owner.json"), JSON.stringify({ version: 1, root, runId: owner, pid: process.pid }));
  await writeFile(path.join(directory, "startup-report.json"), JSON.stringify({
    version: 1, kind: "native-startup-diagnostic", runId: randomUUID(), status: "ready", nativeReadiness: true,
  }));
  const startup = {
    version: 1, kind: "native-startup-diagnostic", runId: owner, status: "failed", phase: "prepare",
    nativeReadiness: false, reportFailure: { reason: "report-write" },
    deviceDiagnostics: { version: 1, runId: owner, catalogueFingerprint: "unknown", phase: "cleanup", operation: "done",
      status: "failed", primary: { phase: "prepare", operation: "jdk", reason: "command-failed", exitCode: 37 } },
  };
  await writeFile(path.join(directory, "startup-entry-report.json"), JSON.stringify({
    kind: "native-startup-entry", runId: owner, status: "failed", startup,
    failure: { reason: "command-failed", exitCode: 1 }, recoveryCleanup: "completed",
  }));
  const commands = path.join(root, ".data", "temp", "_runner_file_commands");
  await mkdir(commands, { recursive: true });
  const output = path.join(commands, `set_output_${randomUUID()}`), summary = path.join(commands, `step_summary_${randomUUID()}`);
  await writeFile(output, "");
  await writeFile(summary, "");
  await assert.rejects(exec(process.execPath, [path.resolve("scripts/verification-diagnostics.mjs"),
    "--directory", directory, "--job", "startup", "--step-result", "failure", "--owner", owner, "--github"],
  { cwd: root, timeout: 20000, env: { ...process.env, GITHUB_ACTIONS: "true", RUNNER_TEMP: path.dirname(commands),
    GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } }), (error) => error.code === 1);
  const report = JSON.parse(await readFile(path.join(directory, "verification-diagnostics.json"), "utf8"));
  assert.equal(report.reportOrigin, "owned-entry-fallback");
  assert.equal(report.startup.runId, owner);
  assert.equal(report.startup.status, "failed");
  assert.equal(report.startup.deviceDiagnostics.primary.exitCode, 37);
  const published = JSON.parse(await readFile(path.join(directory, "public", "startup-report.json"), "utf8"));
  assert.equal(published.runId, owner);
  assert.equal(published.status, "failed");
  assert.match(await readFile(output, "utf8"), /startup_report_ready=true/);
  assert.ok((await readFile(summary, "utf8")).includes('"exitCode": 37'));
  const { collectVerificationDiagnostics } = await import("../verification-diagnostics.mjs");
  const unbound = await collectVerificationDiagnostics(root, directory, "startup", "failure");
  assert.equal(unbound.startup, undefined);
  assert.equal(unbound.collectionStatus, "failed");
  await writeFile(path.join(directory, "startup-report.json"), JSON.stringify({
    version: 1, kind: "native-startup-diagnostic", runId: owner, status: "ready", nativeReadiness: true,
  }));
  const collision = await collectVerificationDiagnostics(root, directory, "startup", "failure", owner);
  assert.equal(collision.reportOrigin, "owned-entry-fallback");
  assert.equal(collision.startup.status, "failed");
  assert.equal(collision.startup.deviceDiagnostics.primary.exitCode, 37);
});

test("a one-shot capacity I/O exception survives recovery through startup publication and its public collector", async (t) => {
  const { availableBytes, publishStartupReport } = await import("../native-startup.mjs");
  const { createDeviceDiagnostics } = await import("../device-diagnostics.mjs");
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/startup-capacity-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  await exec("git", ["init", "--quiet"], { cwd: root });
  for (const failureIndex of [0, 1]) {
    const directory = path.join(root, ".data", "ci", `capacity-${failureIndex}`), owner = randomUUID();
    await mkdir(directory, { recursive: true });
    const diagnostics = await createDeviceDiagnostics({ root, runId: owner });
    diagnostics.stage("prepare", "start");
    let attempts = 0;
    const inspect = (file) => attempts++ === failureIndex
      ? Promise.reject(Object.assign(new Error("PRIVATE_CAPACITY_IO"), { code: "EIO" })) : statfs(file);
    const disk = {
      beforePreparation: await availableBytes(directory, diagnostics, "capacity-before-prepare", inspect),
      afterPreparation: await availableBytes(directory, diagnostics, "capacity-after-prepare", inspect),
    };
    assert.equal(Object.values(disk)[failureIndex], "unknown");
    assert.ok(Number.isSafeInteger(await availableBytes(directory, diagnostics, "capacity-after-prepare")));
    diagnostics.stage("cleanup", "done");
    const report = await publishStartupReport({
      version: 1, runId: owner, status: "ready", phase: "ready", nativeReadiness: true, cleanup: "completed",
      availableDiskBytes: disk, deviceDiagnostics: diagnostics.finish("passed"),
      workerDiagnostics: { runId: owner, cleanup: "completed",
        workers: ["adb", "emulator"].map((role) => ({ role, observation: "exit", context: "during-cleanup", exitCode: 0,
          signal: "none", workerLog: { status: "retained", truncated: false, retainedBytes: 10 } })) },
    }, directory, diagnostics);
    assert.equal(report.status, "incomplete");
    assert.equal(report.collectionStatus, "failed");
    assert.equal(report.nativeReadiness, true);
    assert.equal(report.cleanup, "completed");
    assert.equal(report.deviceDiagnostics.primary, null);
    const expectedOperation = failureIndex === 0 ? "capacity-before-prepare" : "capacity-after-prepare";
    assert.ok(report.deviceDiagnostics.secondary.some((issue) => issue.operation === expectedOperation && issue.osCode === "EIO"));
    await assert.rejects(exec(process.execPath, [path.resolve("scripts/verification-diagnostics.mjs"),
      "--directory", directory, "--job", "startup", "--owner", owner, "--step-result", "success"],
    { cwd: root, timeout: 20000 }), (error) => error.code === 1);
    const output = JSON.parse(await readFile(path.join(directory, "verification-diagnostics.json"), "utf8"));
    assert.equal(output.collectionStatus, "failed");
    assert.equal(output.startup.nativeReadiness, true);
    assert.equal(output.startup.cleanup, "completed");
    assert.ok(!JSON.stringify(output).includes("PRIVATE_CAPACITY_IO"));
  }
});

test("explicitly unsupported and non-representable capacity remains unknown without inventing collection failure", async () => {
  const { availableBytes } = await import("../native-startup.mjs");
  const { createDeviceDiagnostics } = await import("../device-diagnostics.mjs");
  const diagnostics = await createDeviceDiagnostics({ root: process.cwd(), runId: randomUUID() });
  for (const code of ["ENOSYS", "ENOTSUP", "EOPNOTSUPP"]) {
    const result = await availableBytes(process.cwd(), diagnostics, "capacity-before-prepare",
      async () => { throw Object.assign(new Error("PRIVATE_UNSUPPORTED"), { code }); });
    assert.equal(result, "unknown");
  }
  for (const bavail of [-1, Number.MAX_SAFE_INTEGER, NaN, Infinity]) {
    assert.equal(await availableBytes(process.cwd(), diagnostics, "capacity-after-prepare",
      async () => ({ bavail, bsize: 4096 })), "unknown");
  }
  assert.equal(diagnostics.snapshot().collectionStatus, "completed");
  assert.deepEqual(diagnostics.snapshot().secondary, []);
});

test("a ready startup with a recorded collection exception cannot have a green public collection outcome", async (t) => {
  const { projectStartupReport } = await import("../native-startup.mjs");
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/startup-recorded-collection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  await exec("git", ["init", "--quiet"], { cwd: root });
  const directory = path.join(root, ".data", "ci", "startup"), owner = randomUUID();
  await mkdir(directory, { recursive: true });
  const startup = { version: 1, kind: "native-startup-diagnostic", runId: owner, status: "ready", phase: "ready",
    nativeReadiness: true, cleanup: "completed",
    deviceDiagnostics: { version: 1, runId: owner, catalogueFingerprint: "unknown", status: "passed", phase: "cleanup",
      operation: "done", collectionStatus: "failed", secondary: [{ operation: "catalogue", reason: "collector-failed" }] } };
  await writeFile(path.join(directory, "startup-report.json"), JSON.stringify(startup));
  const qualified = projectStartupReport(startup);
  assert.notEqual(qualified.status, "ready");
  assert.equal(qualified.nativeReadiness, true);
  assert.equal(qualified.collectionStatus, "failed");
  await assert.rejects(exec(process.execPath, [path.resolve("scripts/verification-diagnostics.mjs"),
    "--directory", directory, "--job", "startup", "--owner", owner, "--step-result", "success"],
  { cwd: root, timeout: 20000 }), (error) => error.code === 1);
  const report = JSON.parse(await readFile(path.join(directory, "verification-diagnostics.json"), "utf8"));
  assert.equal(report.collectionStatus, "failed");
  assert.equal(report.startup.nativeReadiness, true);
  assert.equal(report.startup.cleanup, "completed");
  const workerDirectory = path.join(root, ".data", "ci", "startup-worker");
  await mkdir(workerDirectory);
  const workerFailure = { ...startup, deviceDiagnostics: undefined,
    workerDiagnostics: { runId: owner, cleanup: "completed", collectionStatus: "failed", collectionFailures: [],
      workers: ["adb", "emulator"].map((role) => ({ role, observation: "exit", context: "during-cleanup", exitCode: 0,
        signal: "none", workerLog: { status: "retained", truncated: false, retainedBytes: 10 } })) } };
  await writeFile(path.join(workerDirectory, "startup-report.json"), JSON.stringify(workerFailure));
  assert.equal(projectStartupReport(workerFailure).collectionStatus, "failed");
  assert.notEqual(projectStartupReport(workerFailure).status, "ready");
  await assert.rejects(exec(process.execPath, [path.resolve("scripts/verification-diagnostics.mjs"),
    "--directory", workerDirectory, "--job", "startup", "--owner", owner, "--step-result", "success"],
  { cwd: root, timeout: 20000 }), (error) => error.code === 1);
  const rootDirectory = path.join(root, ".data", "ci", "startup-root");
  await mkdir(rootDirectory);
  const rootFailure = { ...startup, deviceDiagnostics: undefined, collectionStatus: "failed" };
  await writeFile(path.join(rootDirectory, "startup-report.json"), JSON.stringify(rootFailure));
  assert.equal(projectStartupReport(rootFailure).collectionStatus, "failed");
  assert.notEqual(projectStartupReport(rootFailure).status, "ready");
  await assert.rejects(exec(process.execPath, [path.resolve("scripts/verification-diagnostics.mjs"),
    "--directory", rootDirectory, "--job", "startup", "--owner", owner, "--step-result", "success"],
  { cwd: root, timeout: 20000 }), (error) => error.code === 1);
});
