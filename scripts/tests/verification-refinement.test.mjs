import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { executeLocalRefinement } from "../verification-refinement.mjs";
import { combineVerification, executeVerification, verificationPlan } from "../verification.mjs";
import { verificationImpact } from "../verification-policy.mjs";
import { developmentReviewRequirements } from "../development-policy.mjs";
import { retainApplePreparationFailure } from "../verification-preflight.mjs";
import { diagnosticError, failureDetails } from "../diagnostic-errors.mjs";
import { controls, digest, exec, fixture, nativeEvidence, nativeTest, planned, save, selected, uiTests, view } from "./fixtures/apple-refinement.mjs";

test("private preparation diagnostics preserve raw failure facts without inventing cleanup evidence", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/preparation-diagnostic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cause = Object.assign(new Error("PRIVATE_PREPARATION_ERROR", { cause: new Error("PRIVATE_NESTED_CAUSE") }), {
    stdout: "PRIVATE_PREPARATION_STDOUT", stderr: "PRIVATE_PREPARATION_STDERR", processTreeStopped: false,
    commandOutcome: { observedProcess: "owned-command-supervisor", reason: "timeout", exitCode: null,
      signal: "SIGTERM", outputTruncated: false, capturedBytes: 52,
      cleanupFailure: { reason: "cleanup-failed", processTreeStopped: false } },
  });
  cause[Symbol.for("nodejs.util.inspect.custom")] = () => { throw new Error("Custom inspection must not run"); };
  const failure = failureDetails(cause);
  const preparation = { version: 1, status: "blocked", groups: [{
    group: "backend", status: "blocked", issues: [{ prerequisite: "powershell", failure }],
    notProbed: [{ prerequisite: "npm", blockedBy: ["powershell"] }],
  }] };
  const error = Object.assign(diagnosticError("preflight-dependencies"), {
    processTreeStopped: false, preparation,
    preparationFailures: [{ group: "backend", prerequisite: "powershell", failure, error: cause }],
  });
  const original = failureDetails(error), source = { head: "1".repeat(40), fingerprint: "2".repeat(64) };
  const retained = await retainApplePreparationFailure(root, source, error);
  const bytes = await readFile(path.join(root, retained.path)), contents = bytes.toString("utf8");
  assert.equal(digest(bytes), retained.sha256);
  for (const value of ["PRIVATE_PREPARATION_ERROR", "PRIVATE_NESTED_CAUSE", "PRIVATE_PREPARATION_STDOUT",
    "PRIVATE_PREPARATION_STDERR", source.fingerprint, "notProbed", "blockedBy", "commandOutcome"]) {
    assert.ok(contents.includes(value), value);
  }
  assert.match(contents, /processTreeStopped: false/);
  assert.match(contents, /failedProcessId: 'unknown'/);
  assert.match(contents, /rawCleanupReceipt: 'unknown'/);
  assert.ok(!contents.includes("[Object]"));
  assert.deepEqual(failureDetails(error), original);
  assert.ok(!JSON.stringify(original).includes("PRIVATE_"));
  if (process.platform !== "win32") {
    assert.equal((await lstat(path.join(root, retained.path))).mode & 0o777, 0o600);
    assert.equal((await lstat(path.dirname(path.join(root, retained.path)))).mode & 0o777, 0o700);
  }
  const second = await retainApplePreparationFailure(root, source, error);
  assert.notEqual(second.path, retained.path);
  assert.deepEqual(await readFile(path.join(root, retained.path)), bytes);
});

nativeTest("refinement MCP selections must equal the complete plan and native result set", async (t) => {
  const f = await fixture(t);
  await save(f.root, view, "Text(\"Revised workbench\").font(.callout)\n");
  const selection = selected(), second = "DevPocketUITests/testWorkbenchNavigation()";
  selection.tests[0].identifiers.push(second);
  const plan = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection });
  await save(f.root, ".data/verification/plan.json", plan);
  const native = await nativeEvidence(f, plan);
  native.summary.passedTests = native.summary.totalTestCount = native.summary.devicesAndConfigurations[0].passedTests = 2;
  native.tests.testNodes[0].children.push({ nodeType: "Test Case", nodeIdentifier: second, result: "Passed" });
  for (const [kind, data] of [["summary", native.summary], ["tests", native.tests]]) {
    await save(f.root, `${native.directory}/${kind}.json`, data);
    await save(f.root, `${native.directory}/result.xcresult/${kind}.json`, data);
    await save(f.root, path.relative(f.root, path.join(native.originalBundle, `${kind}.json`)), data);
  }
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "case-evidence" });
});

nativeTest("a local Apple refinement retains its full checkpoint and requires independent review", async (t) => {
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
  assert.equal(result.checks[0].execution.tool, "xcode/RunSomeTests");
  assert.equal(result.checks[0].execution.workspace, path.join(f.root, "apple", "DevPocket", "DevPocket.xcodeproj"));
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, ".data/verification/full/report.json"))), f.report);
  assert.throws(() => combineVerification(f.report, [result]), { diagnosticCode: "policy-mismatch" });
  await assert.rejects(f.invoke({ action: "plan", checkpoint: f.subjectFile, selection: selected() }),
    { diagnosticCode: "report-invalid" });
});

nativeTest("the documented npm entry preserves context between the normal gate and checkpoint preparation", async (t) => {
  const f = await fixture(t);
  const invoke = (args) => exec("npm", ["run", "verify", "--", "-Base", f.base, ...args],
    { cwd: f.root, env: process.env, timeout: 120000, maxBuffer: 1024 * 1024 });
  await invoke(["-CaptureRefinementContext", "-Report", ".data/verification/cli-full/report.json"]);
  await save(f.root, ".data/verification/cli-prepare.json",
    { ...f.prepareRequest, verification: ".data/verification/cli-full/report.json" });
  const output = await invoke(["-Refinement", ".data/verification/cli-prepare.json",
    "-Report", ".data/verification/cli-subject/report.json"]);
  const bytes = await readFile(path.join(f.root, ".data/verification/cli-subject/report.json"));
  assert.equal(JSON.parse(bytes).status, "pending_review");
  assert.ok(output.stdout.includes(`Checkpoint subject SHA256: ${digest(bytes)}`));
});

nativeTest("cumulative presentation, added regression and documentation changes keep the original base", async (t) => {
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

nativeTest("unknown/model/build/dependency edits return full_required instead of silently narrowing", async (t) => {
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

nativeTest("deleted presentation and uncovered companion inputs cannot qualify", async (t) => {
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

nativeTest("Git environment changes remain explicit blockers even when source is unchanged", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  await exec("git", ["config", "core.quotePath", "false"], { cwd: f.root });
  const next = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() });
  assert.equal(next.status, "full_required");
  assert.ok(next.reasons.includes("environment-changed"));
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "environment-changed" });
});

nativeTest("native SDK, toolchain and loader environment drift requires the full gate", async (t) => {
  const f = await fixture(t);
  await planned(f);
  for (const name of ["SDKROOT", "TOOLCHAINS", "DYLD_TEST_NATIVE_BINDING"]) {
    const original = process.env[name];
    try {
      process.env[name] = "synthetic-changed-native-input";
      const result = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() });
      assert.equal(result.status, "full_required", name);
      assert.ok(result.reasons.includes("environment-changed"), name);
      assert.deepEqual(result.changedFiles, [view]);
    } finally {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  }
});

nativeTest("checkpoint creation cannot adopt drift after the accepted full run", async (t) => {
  const f = await fixture(t);
  await exec("git", ["config", "core.quotePath", "false"], { cwd: f.root });
  await assert.rejects(f.invoke(f.request), { diagnosticCode: "environment-changed" });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, ".data/verification/full/report.json"))), f.report);
});

nativeTest("old ordinary reports without a captured native context cannot seed refinement", async (t) => {
  const f = await fixture(t), plan = await verificationPlan(f.root, f.base);
  const report = await executeVerification(f.root, plan, { directory: path.join(f.root, ".data/verification/without-context") });
  assert.equal(report.status, "passed");
  await save(f.root, ".data/verification/without-context/report.json", report);
  await assert.rejects(f.invoke({ ...f.prepareRequest, verification: ".data/verification/without-context/report.json" }),
    { diagnosticCode: "environment-changed" });
});

nativeTest("ignored renderer, prepared-module and installed-dependency drift require the ordinary route", async (t) => {
  const f = await fixture(t);
  await planned(f);
  for (const file of ["apple/DevPocket/Renderer/component.js", "packages/components/dist/spec.js",
    "node_modules/fixture-dependency/index.js"]) {
    const original = await readFile(path.join(f.root, file), "utf8");
    await save(f.root, file, original + "\n// Changed ignored input\n");
    const result = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() });
    assert.equal(result.status, "full_required");
    assert.ok(result.reasons.includes("environment-changed"));
    assert.deepEqual(result.changedFiles, [view]);
    await save(f.root, file, original);
  }
});

nativeTest("ignored native drift during a binding cannot be qualified", async (t) => {
  const f = await fixture(t);
  await planned(f);
  const before = await f.invoke({ action: "binding", plan: ".data/verification/plan.json" });
  await save(f.root, ".data/apple/before-drift.json", before);
  await save(f.root, "apple/DevPocket/Renderer/component.js", "Changed after observation\n");
  await assert.rejects(f.invoke({ action: "binding", plan: ".data/verification/plan.json", before: ".data/apple/before-drift.json" }),
    { diagnosticCode: "environment-changed" });
});

nativeTest("a self-consistent app seal does not replace the accepted prepared renderer", async (t) => {
  const f = await fixture(t), item = f.prepareRequest.acceptedProducts[0];
  const seal = JSON.parse(await readFile(path.join(f.root, item.artifact)));
  await save(f.root, item.bundle + "/Renderer/component.js", "Different packaged renderer\n");
  seal.files["Renderer/component.js"] = digest("Different packaged renderer\n");
  await save(f.root, item.artifact, seal);
  await assert.rejects(f.invoke(f.prepareRequest), { diagnosticCode: "artifact-changed" });
});

nativeTest("an old same-source review cannot accept a new environment or verification subject", async (t) => {
  const f = await fixture(t);
  await exec("git", ["config", "core.quotePath", "false"], { cwd: f.root });
  const report = await executeVerification(f.root, await verificationPlan(f.root, f.base),
    { directory: path.join(f.root, ".data/verification/new-context"), captureRefinementContext: true });
  assert.equal(report.complete, true);
  await save(f.root, ".data/verification/new-context/report.json", report);
  const subject = await f.invoke({ ...f.prepareRequest, verification: ".data/verification/new-context/report.json" });
  await save(f.root, ".data/verification/new-subject.json", subject);
  await assert.rejects(f.invoke({ ...f.request, subject: ".data/verification/new-subject.json" }),
    { diagnosticCode: "check-failed" });
});

test("hosted CI and ordinary gate aggregation cannot consume local refinement", async (t) => {
  const oldCI = process.env.GITHUB_ACTIONS;
  t.after(() => { if (oldCI === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = oldCI; });
  process.env.GITHUB_ACTIONS = "true";
  await assert.rejects(executeLocalRefinement(process.cwd(), "not-a-base", "not-a-request"), { diagnosticCode: "configuration" });
  await assert.rejects(executeVerification(process.cwd(), { version: 6, requiredChecks: [], requiredGroups: [] },
    { captureRefinementContext: true }), { diagnosticCode: "configuration" });
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/refinement-rejection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = path.resolve("scripts/verify.mjs");
  await assert.rejects(exec(process.execPath, [entry, "--repo", root, "--base", "not-a-base",
    "--refinement", ".data/verification/request.json", "--all"], { env: { ...process.env, GITHUB_ACTIONS: "false" } }),
  (error) => error.code === 1 && error.stderr.includes("configuration"));
  assert.deepEqual(verificationImpact(["apple/DevPocket/DevPocket/ContentView.swift"]).selectionReasons.map((item) => item.rule), ["apple"]);
  assert.equal(developmentReviewRequirements(["scripts/verification-refinement.mjs"]).requiresHumanReview, true);
  assert.deepEqual(verificationImpact(["scripts/tests/verification-refinement.test.mjs"]).requiredChecks, ["tooling-tests"]);
});
