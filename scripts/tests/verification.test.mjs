import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

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
  let exitCode = 0;
  try {
    await exec(process.execPath, [entry, "--repo", root, "--base", "HEAD", "--report", report, ...args],
      { timeout: 60_000, env: typeof env === "function" ? env(report) : env });
  } catch (error) {
    exitCode = error.code;
  }
  return { exitCode, reportPath: report, report: JSON.parse(await readFile(report, "utf8")) };
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

test("app, wire and unknown changes cannot omit device checks or lower their risk", async (t) => {
  for (const file of [
    "android/app/src/main/java/Screen.kt",
    "backend/src/protocol.ts",
    "scripts/verify.mjs",
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
      if (!file.startsWith("android/")) assert.equal(result.report.requiresHumanReview, true);
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

test("backend diagnostics observe the normal ordered controller entry without accepting a failing suite", async (t) => {
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
  assert.equal(result.report.checks.find((check) => check.id === "workflow-tests").status, "passed");
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
  const result = await verify(root, ["--group", "backend", "--backend-diagnostics"], (report) => ({
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
  await writeFile(input, JSON.stringify({ ...plan, group: "backend", status: "partial", complete: false,
    checks: plan.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0 })) }));
  const result = await verify(root, ["--combine", "--input", input, "--upstream", "backend:failure"]);
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
  await writeFile(input, JSON.stringify({ ...plan, group: "backend", status: "partial",
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
  await assert.rejects(exec(process.execPath, [entry, "--repo", root, "--base", "HEAD", "--group", "backend", "--report", report],
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

test("source fingerprints retain Git modes and bytes across distinct unnormalized checkouts", async (t) => {
  const { sourceSnapshot } = await import("../verification.mjs");
  const root = await repository(t);
  await exec("git", ["update-index", "--chmod=+x", "README.md"], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Mode fixture"], { cwd: root });
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
