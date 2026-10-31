import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CHECKS, CHECK_GROUPS, VERIFICATION_REPORT_VERSION } from "../verification-policy.mjs";

const exec = promisify(execFile);

test("an actual compiler check exposes its trusted source/code through the public diagnostic CLI without assertion values", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/check-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await exec("git", ["init", "--quiet"], { cwd: root });
  const compiler = path.resolve("node_modules/typescript/bin/tsc");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
    "test:tooling": "node -e \"process.exit(0)\"",
    typecheck: `node "${compiler}" --noEmit --pretty false --skipLibCheck backend/src/failure.ts`,
  } }));
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture"], { cwd: root });
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
    "test:tooling": "node --test --test-reporter=spec scripts/tests/development-tools.test.mjs",
  } }));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture"], { cwd: root });
  await mkdir(path.join(root, "scripts", "tests"), { recursive: true });
  await writeFile(path.join(root, "scripts", "tests", "development-tools.test.mjs"), [
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
  assert.deepEqual(report.requiredChecks, ["tooling-tests"]);
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
  assert.equal(Object.hasOwn(diagnostics.selection, "requiresHumanReview"), false);
  assert.equal(Object.hasOwn(diagnostics.selection, "legacyAgentReview"), false);
  assert.deepEqual(diagnostics.selection.selectionReasons[0].paths, ["scripts/tests/development-tools.test.mjs"]);
  assert.equal(diagnostics.checks[0].id, "tooling-tests");
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
  assert.deepEqual(gate.selection.selectionReasons[0].checks, ["tooling-tests"]);
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
      assert.deepEqual(output.selection.legacyAgentReview, { requiresHumanReview: "unknown", approval: "not-established" });
      assert.deepEqual(output.checks.map((check) => check.id), backend);
    });
  }
  const { projectVerificationSelection } = await import("../verification-policy.mjs");
  const file = "scripts/native-candidate.mjs";
  const legacy = projectVerificationSelection({
    version: 1, requiredChecks: backend,
    selectionReasons: [{ rule: "development-tooling", paths: [file] }],
  }, new Set([file]));
  assert.deepEqual(legacy.requiredGroups, ["backend"]);
  assert.deepEqual(legacy.selectionReasons, [], "Current impact rules must not explain a historical plan.");
});

test("historical local review flags are diagnostic-only and cannot manufacture approval or narrow old check selections", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/legacy-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  await exec("git", ["init", "--quiet"], { cwd: root });
  const file = "scripts/development-policy.mjs";
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, file), "// fixture\n");
  for (const version of [1, 2, 3, 4, 5, VERIFICATION_REPORT_VERSION]) {
    for (const [label, requirement] of [["true", true], ["false", false], ["absent", undefined], ["invalid", "PRIVATE_REVIEW_CANARY"]]) {
      await t.test(`${version}: ${label}`, async () => {
        const directory = path.join(root, ".data", "ci", `review-${version}-${label}`);
        await mkdir(directory, { recursive: true });
        const explained = [3, 5, VERIFICATION_REPORT_VERSION].includes(version);
        const toolingId = version === VERIFICATION_REPORT_VERSION ? "tooling-tests" : "workflow-tests";
        const checks = explained ? [toolingId] : CHECKS.filter((check) => check.group !== "apple")
          .map((check) => check.id === "tooling-tests" ? toolingId : check.id);
        await writeFile(path.join(directory, "plan.json"), JSON.stringify({
          version, status: "planned", complete: false, checks: [], requiredChecks: checks,
          requiresHumanReview: requirement, approval: "approved", review: { verdict: "pass" },
          selectionReasons: [{ rule: explained ? "development-tooling" : "verification-infrastructure",
            paths: [file], description: "PRIVATE_REVIEW_CANARY", checks: ["PRIVATE_REVIEW_CANARY"] }],
        }));
        const projected = await exec(process.execPath, [path.resolve("scripts/verification-diagnostics.mjs"),
          "--directory", directory, "--job", "plan"], { cwd: root, timeout: 20000 });
        const output = JSON.parse(await readFile(path.join(directory, "verification-diagnostics.json"), "utf8"));
        assert.equal(output.collectionStatus, "completed");
        assert.equal(output.acceptance, false);
        assert.equal(output.status, "planned");
        assert.deepEqual(output.selection.requiredChecks, checks);
        assert.deepEqual(output.selection.requiredGroups, explained ? ["tooling"]
          : version === 1 ? ["backend", "android", "device"] : CHECK_GROUPS.filter((group) => group !== "apple"));
        assert.equal(Object.hasOwn(output.selection, "requiresHumanReview"), false);
        if (explained) {
          assert.deepEqual(output.selection.selectionReasons[0].paths, [file]);
          assert.deepEqual(output.selection.selectionReasons[0].checks, [toolingId]);
          assert.deepEqual(output.selection.selectionReasons[0].groups, ["tooling"]);
        } else assert.deepEqual(output.selection.selectionReasons, [], "Old full-impact explanations must not be rebuilt as tooling-only.");
        if ([1, 2].includes(version)) {
          assert.deepEqual(output.selection.legacyAgentReview, {
            requiresHumanReview: typeof requirement === "boolean" ? requirement : "unknown", approval: "not-established",
          });
        } else assert.equal(Object.hasOwn(output.selection, "legacyAgentReview"), false);
        assert.ok(!projected.stdout.includes("PRIVATE_REVIEW_CANARY"));
        assert.ok(!JSON.stringify(output).includes('"approved"'));
        assert.ok(!JSON.stringify(output).includes('"verdict"'));
      });
    }
  }
});

test("diagnostics preserve each report version's tooling identity, failures and private log without rewriting evidence", async (t) => {
  const { collectVerificationDiagnostics } = await import("../verification-diagnostics.mjs");
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/tooling-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  await exec("git", ["init", "--quiet"], { cwd: root });
  const file = "scripts/tests/known.test.mjs";
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), "// fixture\n");
  const source = { head: "a".repeat(40), fingerprint: "b".repeat(64) };
  const execution = { source, startedAt: "2026-10-01T00:00:00.000Z", completedAt: "2026-10-01T00:00:01.000Z" };
  for (const version of [1, 2, 3, 4, 5, VERIFICATION_REPORT_VERSION]) {
    await t.test(`version ${version}`, async () => {
      const id = version === VERIFICATION_REPORT_VERSION ? "tooling-tests" : "workflow-tests";
      const group = version === 1 ? "backend" : "tooling";
      const directory = path.join(root, ".data", "ci", `version-${version}`);
      await mkdir(directory, { recursive: true });
      const failure = { reason: "command-failed", phase: "command", check: id, group,
        missingChecks: [id, "PRIVATE_CHECK_CANARY"], summary: "PRIVATE_REPORT_CANARY" };
      const report = JSON.stringify({
        version, source, status: "failed", group, requiredChecks: [id], failure,
        sourceValidation: { status: "failed", failure },
        checks: [{ id, status: "failed", exitCode: 1, failure, privateLog: { availability: "retained" },
          ...(version >= 4 ? { execution } : {}) }],
      });
      const log = `test at ${file}:1:1\nPRIVATE_LOG_CANARY\n`;
      await writeFile(path.join(directory, "report.json"), report);
      await writeFile(path.join(directory, `${id}.log`), log);
      const output = await collectVerificationDiagnostics(root, directory, group, "failure");
      assert.equal(output.acceptance, false);
      assert.equal(output.collectionStatus, "completed");
      assert.deepEqual(output.selection.requiredChecks, [id]);
      assert.deepEqual(output.selection.requiredGroups, [group]);
      assert.equal(output.checks[0].id, id);
      assert.equal(output.checks[0].failure.check, id);
      assert.equal(output.failure.check, id);
      assert.equal(output.sourceValidation.failure.check, id);
      assert.deepEqual(output.failure.missingChecks, [id]);
      assert.equal(output.checks[0].privateLog.availability, "available");
      assert.deepEqual(output.checks[0].hints, [{ kind: "test-declaration-hint", file, line: 1, column: 1 }]);
      if (version >= 4) assert.deepEqual(output.checks[0].executionEvidence,
        { kind: "executed", ...execution, approval: "not-established" });
      else assert.equal(Object.hasOwn(output.checks[0], "executionEvidence"), false);
      assert.ok(!JSON.stringify(output).includes("PRIVATE_"));
      assert.equal(await readFile(path.join(directory, "report.json"), "utf8"), report);
      assert.equal(await readFile(path.join(directory, `${id}.log`), "utf8"), log);
    });
  }
});

test("check log hints accept only source-indexed locations and fixed exception/code identifiers", async () => {
  const { checkLogHints } = await import("../verification-diagnostics.mjs");
  const sources = new Set(["backend/src/known.ts", "deployment/azure/probe/test_receiver.py", "scripts/tests/known.test.mjs"]);
  const frame = pathToFileURL(path.join(process.cwd(), "scripts", "tests", "known.test.mjs")).href;
  const text = [
    "backend/src/known.ts(12,7): error TS2322: PRIVATE_ASSERTION_CANARY",
    "private/PRIVATE_PATH.ts(12,7): error TS2322: private",
    "ModuleNotFoundError: No module named 'PRIVATE_MODULE'",
    `  File "${path.join(process.cwd(), "deployment", "azure", "probe", "test_receiver.py")}", line 12, in PRIVATE_FUNCTION`,
    `    at TestContext.PRIVATE_FUNCTION (${frame}:37:5)`,
    `    at ${frame}:39:7`,
    "    at PRIVATE_FUNCTION (file:///private/PRIVATE_PATH.mjs:12:7)",
    "private.secret.TokenError: PRIVATE_ERROR_VALUE",
  ].join("\n");
  const result = checkLogHints(text, process.cwd(), sources);
  assert.ok(result.some((item) => item.code === "TS2322" && item.file === "backend/src/known.ts"));
  assert.ok(result.some((item) => item.type === "ModuleNotFoundError"));
  assert.ok(result.some((item) => item.file === "deployment/azure/probe/test_receiver.py" && item.line === 12));
  assert.ok(result.some((item) => item.kind === "source-frame" && item.file === "scripts/tests/known.test.mjs" && item.line === 37 && item.column === 5));
  assert.ok(result.some((item) => item.kind === "source-frame" && item.file === "scripts/tests/known.test.mjs" && item.line === 39 && item.column === 7));
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
});

test("PowerShell and lease hints publish fixed reasons without dynamic error identifiers", async () => {
  const { checkLogHints } = await import("../verification-diagnostics.mjs");
  for (const [id, reason] of [
    ["NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand", "process-not-found"],
    ["GetValueInvocationException", "property-read-failed"],
    ["MethodInvocationException", "method-call-failed"],
    ["PreparationWorkerIdentityMismatch", "worker-identity-mismatch"],
    ["PreparationWorkerExited", "worker-exited-before-observation"],
    ["PRIVATE_ERROR_ID_WITH_SECRET", "unclassified"],
    ["GetValueInvocationException PRIVATE_SUFFIX", "unclassified"],
  ]) {
    const result = checkLogHints(`    + FullyQualifiedErrorId : ${id}`, process.cwd(), new Set());
    assert.deepEqual(result, [{ kind: "powershell-failure", reason }]);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  }
  assert.deepEqual(checkLogHints("  code: 'EMULATOR_SLOT_TIMEOUT',", process.cwd(), new Set()),
    [{ kind: "error-code", code: "EMULATOR_SLOT_TIMEOUT" }]);
});

test("macOS owner log hints distinguish fixed terminal failures without publishing exception text", async () => {
  const { checkLogHints } = await import("../verification-diagnostics.mjs");
  for (const [type, message, reason] of [
    ["RuntimeError", "macOS process ownership did not stabilize; cleanup is unconfirmed.", "ownership-unstable"],
    ["RuntimeError", "Nested macOS cleanup was not confirmed.", "nested-ack-missing"],
    ["RuntimeError", "A nested macOS owner exited without confirming cleanup.", "nested-owner-unconfirmed"],
    ["RuntimeError", "Invalid nested macOS cleanup acknowledgement.", "nested-ack-invalid"],
    ["RuntimeError", "Owned macOS processes did not confirm exit.", "cleanup-deadline"],
    ["RuntimeError", "Inherited macOS ownership changed.", "parent-ownership-changed"],
    ["RuntimeError", "Unbound nested macOS ownership request.", "nested-owner-unbound"],
    ["RuntimeError", "macOS process enumeration failed.", "process-enumeration-failed"],
    ["RuntimeError", "macOS process enumeration exceeded its bound.", "process-enumeration-limit"],
    ["RuntimeError", "The macOS kernel did not establish an isolated responsibility scope.", "scope-unavailable"],
    ["RuntimeError", "The command owner changed before startup.", "owner-changed"],
    ["RuntimeError", "The command owner exited before startup.", "owner-exited"],
    ["RuntimeError", "The parent did not register this macOS scope.", "registration-failed"],
    ["RuntimeError", "macOS process identity is incomplete (result 0, OS error 1).", "identity-incomplete"],
    ["OSError", "[Errno 1] Cannot signal the bound macOS process.", "signal-failed"],
    ["PermissionError", "[Errno 1] Cannot signal the bound macOS process.", "signal-failed"],
    ["BrokenPipeError", "[Errno 32] PRIVATE_PIPE_CANARY", "broken-pipe"],
    ["BlockingIOError", "[Errno 35] PRIVATE_CHANNEL_CANARY", "would-block"],
    ["ConnectionResetError", "[Errno 54] PRIVATE_PEER_CANARY", "connection-reset"],
    ["AttributeError", "PRIVATE_NATIVE_SYMBOL_CANARY", "unclassified"],
  ]) {
    const line = `Owned macOS command failed: ${type}: ${message}`;
    assert.deepEqual(checkLogHints(line, process.cwd(), new Set(), "tooling-tests"),
      [{ kind: "macos-owner-failure", type, reason }]);
  }
  const findings = checkLogHints([
    "Owned macOS command failed: RuntimeError: Nested macOS cleanup was not confirmed. PRIVATE_SUFFIX_CANARY",
    "Owned macOS command failed: ValueError: /private/PRIVATE_PATH_CANARY receipt=PRIVATE_RECEIPT_CANARY",
    "Owned macOS command failed: PRIVATE_TYPE_CANARY: PRIVATE_MESSAGE_CANARY",
    `Owned macOS command failed: RuntimeError: ${"PRIVATE_LONG_CANARY".repeat(300)}`,
  ].join("\n"), process.cwd(), new Set(), "tooling-tests");
  assert.deepEqual(findings, [
    { kind: "macos-owner-failure", type: "RuntimeError", reason: "unclassified" },
    { kind: "macos-owner-failure", type: "ValueError", reason: "unclassified" },
  ]);
  assert.ok(!JSON.stringify(findings).includes("PRIVATE_"));
});

test("the public collector preserves failed cleanup while projecting only a fixed macOS owner hint", async (t) => {
  await mkdir(".data/verification", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/verification/fixture-macos-owner-diagnostic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = { head: "a".repeat(40), fingerprint: "b".repeat(64) };
  await writeFile(path.join(directory, "report.json"), JSON.stringify({
    version: VERIFICATION_REPORT_VERSION, source, status: "failed",
    checks: [{ id: "tooling-tests", status: "failed", exitCode: 1, executionState: "exited",
      failure: { reason: "cleanup-failed", processTreeStopped: false },
      privateLog: { availability: "retained", truncated: false } }],
  }));
  await writeFile(path.join(directory, "tooling-tests.log"),
    "Owned macOS command failed: RuntimeError: Nested macOS cleanup was not confirmed.\nPRIVATE_NATIVE_LOG_CANARY\n");
  const result = await exec(process.execPath, ["scripts/verification-diagnostics.mjs",
    "--directory", directory, "--job", "tooling", "--step-result", "failure"], { cwd: process.cwd() });
  const published = await readFile(path.join(directory, "verification-diagnostics.json"), "utf8");
  const diagnostic = JSON.parse(published);
  assert.equal(diagnostic.acceptance, false);
  assert.equal(diagnostic.status, "failed");
  assert.equal(diagnostic.executionStep.result, "failure");
  assert.deepEqual(diagnostic.source, source);
  assert.equal(diagnostic.checks[0].failure.processTreeStopped, false);
  assert.deepEqual(diagnostic.checks[0].hints, [
    { kind: "macos-owner-failure", type: "RuntimeError", reason: "nested-ack-missing" },
  ]);
  assert.ok(!result.stdout.includes("PRIVATE_"));
  assert.ok(!published.includes("PRIVATE_"));
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
  for (const [version, id, group] of [[1, "workflow-tests", "backend"], [VERIFICATION_REPORT_VERSION, "tooling-tests", "tooling"]]) {
    for (const kind of ["source", "log"]) await t.test(`${version}: ${kind}`, async () => {
      const directory = path.join(root, ".data", "ci", `${version}-${kind}`);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "report.json"), JSON.stringify({
        version, status: kind === "source" ? "passed" : "failed", group,
        checks: kind === "source" ? [] : [{ id, status: "failed", exitCode: 1, privateLog: { availability: "retained" } }],
      }));
      if (kind === "log") await mkdir(path.join(directory, `${id}.log`));
      await assert.rejects(exec(process.execPath, [exporter, "--directory", directory, "--job", group],
        { cwd: root, env: kind === "source" ? { ...process.env, PATH: emptyPath } : process.env, timeout: 20000 }),
      (error) => error.code === 1);
      const output = JSON.parse(await readFile(path.join(directory, "verification-diagnostics.json"), "utf8"));
      assert.equal(output.collectionStatus, "failed");
      assert.equal(output.status, kind === "source" ? "passed" : "failed");
      assert.ok(output.collectionErrors.length > 0);
      assert.equal(output.acceptance, false);
    });
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
