import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { executeLocalRefinement } from "../verification-refinement.mjs";
import { combineVerification, executeVerification, verificationPlan } from "../verification.mjs";
import { verificationImpact } from "../verification-policy.mjs";
import { developmentReviewRequirements } from "../development-policy.mjs";
import { windowsNodeLauncher } from "./fixtures/verification-tools.mjs";

const exec = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const view = "apple/DevPocket/DevPocket/ContentView.swift";
const controls = "apple/DevPocket/DevPocket/Controls.swift";
const uiTests = "apple/DevPocket/DevPocketUITests/DevPocketUITests.swift";
const nativeCase = "DevPocketUITests/testWorkbenchListsSessionsWithoutPromotionalCard()";

async function save(root, file, value) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value) + "\n");
  return file;
}

async function fixture(t) {
  const oldPath = process.env.PATH, oldCI = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  t.after(() => {
    process.env.PATH = oldPath;
    if (oldCI === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = oldCI;
  });
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/refinement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await save(root, ".gitignore", ".data/\n.tools/\n");
  await save(root, "package.json", {});
  await save(root, view, "Text(\"Workbench\").font(.body)\n");
  await save(root, controls, "Text(\"Send\").font(.body)\n");
  await save(root, uiTests, "func testWorkbenchListsSessionsWithoutPromotionalCard() {}\n");
  await save(root, "docs/APPLE-CLIENT.md", "Fixture Apple client.\n");
  const decoder = `const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), kind = args[args.indexOf("test-results") + 1];
if (args.includes("-version")) { console.log("Synthetic Xcode fixture"); process.exit(0); }
if (!["summary", "tests"].includes(kind)) throw new Error("Unexpected fixture decoder command");
process.stdout.write(fs.readFileSync(path.join(args[args.indexOf("--path") + 1], kind + ".json")));
`;
  await save(root, "xcresulttool", decoder);
  await save(root, "xcodebuild", decoder);
  const bin = path.join(root, ".tools", "bin");
  await mkdir(bin, { recursive: true });
  if (process.platform === "win32") {
    await copyFile(await windowsNodeLauncher(root), path.join(bin, "xcrun.exe"));
  } else {
    await writeFile(path.join(bin, "xcrun"), `#!/usr/bin/env node\n${decoder}`);
    await chmod(path.join(bin, "xcrun"), 0o755);
  }
  process.env.PATH = bin + path.delimiter + oldPath;
  await exec("git", ["init", "--quiet", root]);
  await exec("git", ["config", "core.autocrlf", "false"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "Fixture"], { cwd: root });
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const plan = await verificationPlan(root, base);
  const report = await executeVerification(root, plan, { directory: path.join(root, ".data/verification/full") });
  assert.equal(report.complete, true);
  await save(root, ".data/verification/full/report.json", report);
  const review = { type: "tool.execution_complete", data: { success: true, toolCallId: "fixture-review",
    toolTelemetry: { restrictedProperties: { agent_name: "devpocket-reviewer", agent_id: "fixture-agent" } },
    result: { content: "```json\n" + JSON.stringify({ verdict: "pass", base, reviewedSource: report.source, findings: [] }) + "\n```" } } };
  await save(root, ".data/apple/review.json", review);
  await save(root, ".data/apple/native.json", { source: report.source, status: "passed", synthetic: true });
  const request = { action: "checkpoint", verification: ".data/verification/full/report.json",
    review: ".data/apple/review.json", nativeEvidence: [".data/apple/native.json"] };
  const invoke = async (value) => {
    const file = `.data/verification/requests/${randomUUID()}.json`;
    await save(root, file, value);
    return executeLocalRefinement(root, base, file);
  };
  const checkpoint = await invoke(request);
  await save(root, ".data/verification/checkpoint.json", checkpoint);
  return { root, base, checkpoint, report, request, review, invoke };
}

function selected(paths = [view]) {
  return {
    reason: "Remove the duplicate promotional entry; session navigation remains covered.",
    unchangedCoverage: "Retain original native evidence for unchanged model/renderer/platform inputs; do not boot Duo.",
    tests: [{ platform: "iOS Simulator", deviceId: "fixture-iphone", osVersion: "27.0", identifiers: [nativeCase] }],
    coverage: paths.map((file) => ({ path: file, tests: [nativeCase], reason: "Exercises the affected workbench and navigation." })),
  };
}

async function planned(f, files = [view]) {
  for (const file of files) await save(f.root, file, "Text(\"Revised workbench\").font(.callout)\n");
  const plan = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected(files) });
  assert.equal(plan.status, "planned");
  await save(f.root, ".data/verification/plan.json", plan);
  return plan;
}

async function nativeEvidence(f, plan) {
  const directory = ".data/apple/fresh";
  const before = await f.invoke({ action: "binding", plan: ".data/verification/plan.json" });
  await save(f.root, directory + "/before.json", before);
  const device = { deviceId: "fixture-iphone", platform: "iOS Simulator", osVersion: "27.0", architecture: "arm64" };
  const now = Date.now() / 1000;
  const summary = { result: "Passed", failedTests: 0, skippedTests: 0, expectedFailures: 0,
    passedTests: 1, totalTestCount: 1, testFailures: [], startTime: now, finishTime: now,
    devicesAndConfigurations: [{ device, failedTests: 0, skippedTests: 0, expectedFailures: 0, passedTests: 1 }] };
  const tests = { devices: [device], testNodes: [
    { nodeType: "Test Plan", children: [{ nodeType: "Test Case", nodeIdentifier: nativeCase, result: "Passed" }] },
  ] };
  for (const [name, value] of [["summary", summary], ["tests", tests]]) {
    await save(f.root, `${directory}/${name}.json`, value);
    await save(f.root, `${directory}/result.xcresult/${name}.json`, value);
  }
  const request = { action: "qualify", plan: ".data/verification/plan.json",
    tests: [{ binding: directory + "/binding.json", summary: directory + "/summary.json",
      tests: directory + "/tests.json", resultBundle: directory + "/result.xcresult" }], builds: [] };
  for (const platform of ["ios", "macos"]) {
    const bundle = `${directory}/${platform}/DevPocket.app`;
    const files = platform === "macos" ? ["Contents/Info.plist", "Contents/MacOS/DevPocket"] : ["Info.plist", "DevPocket"];
    const hashes = {};
    for (const file of files) {
      await save(f.root, bundle + "/" + file, "Synthetic product, not native acceptance.\n");
      hashes[file] = digest("Synthetic product, not native acceptance.\n");
    }
    const seal = `${directory}/${platform}/artifact.json`;
    await save(f.root, seal, { source: plan.context.source, bundleId: "dev.devpocket.apple.fixtures",
      minimumOS: "27.0", signatureExitCode: 0, files: hashes });
    await save(f.root, `${directory}/${platform}/build.log`, "Synthetic build log\n");
    request.builds.push({ platform, artifact: seal, bundle, log: `${directory}/${platform}/build.log`,
      binding: directory + "/binding.json" });
  }
  const after = await f.invoke({ action: "binding", plan: ".data/verification/plan.json", before: directory + "/before.json" });
  await save(f.root, directory + "/binding.json", after);
  return { request, summary, tests, directory };
}

test("a local Apple refinement retains its full checkpoint and requires independent review", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const result = await f.invoke(native.request);
  assert.equal(result.status, "passed");
  assert.equal(result.complete, true);
  assert.equal(result.acceptance, false);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.base, f.base);
  assert.deepEqual(result.source, plan.context.source);
  assert.notEqual(result.source.fingerprint, f.checkpoint.context.source.fingerprint);
  assert.equal(result.checks.length, 3);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, ".data/verification/full/report.json"))), f.report);
  assert.throws(() => combineVerification(f.report, [result]), { diagnosticCode: "policy-mismatch" });
});

test("cumulative presentation, added regression and documentation changes keep the original base", async (t) => {
  const f = await fixture(t);
  const first = await planned(f);
  await save(f.root, controls, "Text(\"Send\").font(.caption)\n");
  await save(f.root, uiTests, "func testWorkbenchListsSessionsWithoutPromotionalCard() { /* stronger regression */ }\n");
  await save(f.root, "docs/APPLE-CLIENT.md", "The workbench no longer contains the promotional card.\n");
  const second = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json",
    selection: selected([view, controls, uiTests]) });
  assert.equal(second.status, "planned");
  assert.equal(second.base, f.base);
  assert.deepEqual(second.changedFiles, [view, controls, uiTests, "docs/APPLE-CLIENT.md"].sort());
  assert.equal(second.delta.find((item) => item.path === view).before, f.checkpoint.sources[view]);
  assert.notEqual(second.context.source.fingerprint, first.context.source.fingerprint);
  assert.equal(second.selection.tests.length, 1);
});

test("unknown/model/build/dependency edits return full_required instead of silently narrowing", async (t) => {
  const f = await fixture(t);
  await planned(f);
  for (const file of ["apple/DevPocket/DevPocket/FixtureState.swift", "apple/prepare-components.mjs",
    "apple/DevPocket/DevPocket.xcodeproj/project.pbxproj", "backend/src/protocol.ts"]) {
    await save(f.root, file, "An out-of-scope fixture change\n");
  }
  const result = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() });
  assert.equal(result.status, "full_required");
  assert.equal(result.complete, false);
  assert.ok(result.reasons.includes("outside-apple-presentation"));
});

test("deleted presentation and uncovered companion inputs cannot qualify", async (t) => {
  const f = await fixture(t);
  await planned(f);
  await save(f.root, uiTests, "Changed test driver\n");
  await assert.rejects(f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() }),
    { diagnosticCode: "configuration" });
  await rm(path.join(f.root, view));
  const missing = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() });
  assert.equal(missing.status, "full_required");
  assert.ok(missing.reasons.includes("unsupported-source-change"));
});

test("Git environment changes remain explicit blockers even when source is unchanged", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  await exec("git", ["config", "core.quotePath", "false"], { cwd: f.root });
  const next = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() });
  assert.equal(next.status, "full_required");
  assert.ok(next.reasons.includes("environment-changed"));
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "environment-changed" });
});

test("all-passed commands with a blocked terminal qualification are not a checkpoint", async (t) => {
  const f = await fixture(t);
  const blocked = { ...f.report, complete: false, status: "blocked", failure: { reason: "environment-changed" } };
  await save(f.root, ".data/verification/blocked.json", blocked);
  await assert.rejects(f.invoke({ ...f.request, verification: ".data/verification/blocked.json" }),
    { diagnosticCode: "check-failed" });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, ".data/verification/blocked.json"))), blocked);
});

test("a historical source, edited report or implementer-written review cannot create a checkpoint", async (t) => {
  const f = await fixture(t);
  await save(f.root, ".data/apple/review.json", { verdict: "pass", reviewedSource: f.report.source });
  await assert.rejects(f.invoke(f.request), { diagnosticCode: "execution-origin" });
  await save(f.root, ".data/apple/review.json", f.review);
  await save(f.root, view, "New source, not the accepted snapshot\n");
  await assert.rejects(f.invoke(f.request), { diagnosticCode: "source-mismatch" });
});

test("native exports must match the actual xcresult and report every selected test passing", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const summaryFile = `${native.directory}/summary.json`;
  await save(f.root, summaryFile, { ...native.summary, passedTests: 99 });
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "artifact-changed" });
  const failed = { ...native.summary, result: "Failed", failedTests: 1, passedTests: 0 };
  await save(f.root, summaryFile, failed);
  await save(f.root, `${native.directory}/result.xcresult/summary.json`, failed);
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "check-failed" });
});

test("old native results, wrong devices and skipped tests are not fresh visual evidence", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  for (const summary of [
    { ...native.summary, startTime: Date.parse(plan.createdAt) / 1000 - 1 },
    { ...native.summary, skippedTests: 1 },
    { ...native.summary, devicesAndConfigurations: [{ ...native.summary.devicesAndConfigurations[0],
      device: { ...native.summary.devicesAndConfigurations[0].device, deviceId: "wrong-device" } }] },
  ]) {
    await save(f.root, `${native.directory}/summary.json`, summary);
    await save(f.root, `${native.directory}/result.xcresult/summary.json`, summary);
    await assert.rejects(f.invoke(native.request), { diagnosticCode: "check-failed" });
  }
});

test("changed products and source changes after planning invalidate qualification", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  await save(f.root, native.request.builds[0].bundle + "/DevPocket", "Changed product\n");
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "artifact-changed" });
  await save(f.root, controls, "Changed after the planned source\n");
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "source-mismatch" });
});

test("retained evidence paths cannot escape the worktree or follow symlinks", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.invoke({ ...f.request, review: "../review.json" }), { diagnosticCode: "ownership-mismatch" });
  const link = path.join(f.root, ".data", "linked");
  await symlink(path.join(f.root, ".data", "apple"), link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.invoke({ ...f.request, review: ".data/linked/review.json" }), { diagnosticCode: "ownership-mismatch" });
});

test("hosted CI and ordinary gate aggregation cannot consume local refinement", async (t) => {
  const f = await fixture(t);
  process.env.GITHUB_ACTIONS = "true";
  await assert.rejects(f.invoke(f.request), { diagnosticCode: "configuration" });
  const entry = path.resolve("scripts/verify.mjs");
  await assert.rejects(exec(process.execPath, [entry, "--repo", f.root, "--base", f.base,
    "--refinement", ".data/verification/request.json", "--all"], { env: { ...process.env, GITHUB_ACTIONS: "false" } }),
  (error) => error.code === 1 && error.stderr.includes("configuration"));
  assert.deepEqual(verificationImpact(["apple/DevPocket/DevPocket/ContentView.swift"]).selectionReasons.map((item) => item.rule), ["unknown"]);
  assert.equal(developmentReviewRequirements(["scripts/verification-refinement.mjs"]).requiresHumanReview, true);
  assert.deepEqual(verificationImpact(["scripts/tests/verification-refinement.test.mjs"]).requiredChecks, ["tooling-tests"]);
});
