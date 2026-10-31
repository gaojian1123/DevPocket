import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { executeLocalAppleRequest } from "../verification-refinement.mjs";
import { APPLE_REQUIREMENTS, validateAppleNativeEvidence } from "../apple-evidence.mjs";
import { combineVerification, executeVerification, verificationPlan } from "../verification.mjs";
import { readVerificationRun } from "../verification-run.mjs";
import { commandPlan, controls, failedPreparationEntry, fixture, fixtureDevice, fullBatches, nativeProbes, nativeTest, save, view } from "./fixtures/apple-refinement.mjs";

nativeTest("the original Apple CLI retains the failing prerequisite privately before public projection", async (t) => {
  const f = await failedPreparationEntry(t);
  const directory = path.join(f.root, ".data/verification/preparation-diagnostics");
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const text = await readFile(path.join(directory, files[0]), "utf8");
  for (const value of ["powershell", "PRIVATE_PREPARATION_OUTPUT", "PRIVATE_PREPARATION_ERROR", "commandOutcome",
    "exitCode: 37", "--apple-request", f.plan.context.source.fingerprint, "notProbed"]) {
    assert.ok(text.includes(value), value);
  }
  assert.ok(!text.includes("[Object]"));
  const binding = `${f.directory}/binding.json`;
  await save(f.root, binding, { action: "binding", plan: `${f.directory}/plan.json` });
  await assert.rejects(executeLocalAppleRequest(f.root, f.base, binding, undefined, path.join(f.root, f.directory)),
    { diagnosticCode: "apple-batch-invalidated" });
  assert.equal(await readFile(path.join(f.root, f.directory, "batch-invalidated.json"), "utf8"), f.invalidation);
});

nativeTest("a private diagnostic write failure leaves the original preflight failure and cleanup status intact", async (t) => {
  const f = await failedPreparationEntry(t, true);
  const diagnostic = f.failure.stderr.split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch (error) { if (!(error instanceof SyntaxError)) throw error; return null; }
  }).find(value => value?.kind === "apple-preparation-diagnostic-failure");
  assert.ok(diagnostic);
  assert.equal(diagnostic.failure.reason, "report-write");
  assert.equal(diagnostic.originalFailure.reason, "preflight-dependencies");
  assert.equal(diagnostic.originalFailure.processTreeStopped, true);
  assert.equal(await readFile(path.join(f.root, ".data/verification/preparation-diagnostics"), "utf8"), "Existing diagnostic path\n");
});

nativeTest("complete local batches qualify original catalogues, handles, native exports and both normal products", async (t) => {
  const f = await fixture(t, true), native = await fullBatches(f);
  const result = await f.invoke(native.request, native.directory);
  assert.equal(result.status, "passed");
  assert.equal(result.complete, true);
  assert.equal(result.acceptance, false);
  assert.equal(result.reviewRequired, true);
  validateAppleNativeEvidence(result.appleEvidence, await verificationPlan(f.root, f.base), "local-xcode-mcp");
  assert.equal(result.appleEvidence.tests.length, 4);
  assert.ok(result.appleEvidence.tests.every((item) => item.mode === "batches" && item.batches.length === 2 && !item.execution));
  assert.equal(result.appleEvidence.builds.length, 2);
  const qualification = `${native.directory}/qualification.json`;
  await save(f.root, qualification, native.request);
  const gatePlan = await verificationPlan(f.root, f.base);
  const gate = await executeVerification(f.root, gatePlan, {
    directory: path.join(f.root, ".data/verification/full-batch-gate"), appleEvidence: qualification,
  });
  assert.equal(gate.version, 6);
  assert.equal(gate.status, "passed", JSON.stringify(gate));
  assert.equal(gate.complete, true);
  assert.deepEqual((await readVerificationRun(f.root, gate.run.manifest)).report, gate);
  assert.equal(combineVerification(gatePlan, [gate]).complete, true);
  assert.ok(gate.checks.find((item) => item.id === "apple-native").appleEvidence.tests.every((item) =>
    item.batches.every((batch) => batch.execution.tool === "xcode/RunSomeTests")));
  const first = native.request.tests[0].batches[0];
  assert.equal(JSON.parse(await readFile(path.join(f.root, first.requestEvent))).data.arguments.workspaceIdentifier,
    "synthetic-batch-workspace");
  await assert.rejects(f.invoke({ action: "apple-catalog", plan: native.request.plan, role: "mac" },
    `${native.directory}/catalog-mac`), { code: "EEXIST" });
  const mutate = async (file, edit, reason) => {
    const original = await readFile(path.join(f.root, file), "utf8"), value = JSON.parse(original);
    edit(value);
    await save(f.root, file, value);
    await assert.rejects(f.invoke(native.request, native.directory), { diagnosticCode: reason });
    await save(f.root, file, original);
    await assert.rejects(f.invoke(native.request, native.directory), { diagnosticCode: "apple-batch-invalidated" });
    const invalidation = `${native.directory}/batch-invalidated.json`;
    assert.equal(JSON.parse(await readFile(path.join(f.root, invalidation))).kind, "apple-batch-invalidation");
    // Reset only this synthetic fixture between independent invalid-input cases.
    await rm(path.join(f.root, invalidation));
  };
  await mutate(first.responseEvent, (event) => { event.data.success = false;
    event.data.error = { code: -32001, message: "Synthetic timeout; no native tests ran" }; }, "case-evidence");
  await mutate(first.workspaceBinding.responseEvent, (event) => {
    event.data.result.structuredContent.message = "* workspaceIdentifier: synthetic-batch-workspace, workspacePath: /wrong/project";
  }, "execution-origin");
  await mutate(first.binding, (value) => { value.context.source.fingerprint = "0".repeat(64); }, "source-mismatch");
  await mutate(native.request.tests[0].catalog, (value) => {
    value.context.environment.preparation.prepared = "0".repeat(64);
  }, "environment-changed");
  await mutate(native.request.tests[0].catalog, (value) => {
    value.data.values[0].enabledTests.pop();
  }, "artifact-changed");
  await mutate(`${first.resultBundle}/summary.json`, (value) => { value.skippedTests = 1; }, "artifact-changed");
  const duplicate = structuredClone(native.request);
  duplicate.tests[0].batches.push(duplicate.tests[0].batches[0]);
  await assert.rejects(f.invoke(duplicate, native.directory));
  await rm(path.join(f.root, native.directory, "batch-invalidated.json"));
  const missing = structuredClone(native.request);
  missing.tests[0].batches.pop();
  await assert.rejects(f.invoke(missing, native.directory), { diagnosticCode: "case-evidence" });
});

for (const action of ["binding", "qualify"]) nativeTest(`refinement ${action} cannot erase observed drift in a full batch plan`, async (t) => {
  const f = await fixture(t, true), native = await fullBatches(f);
  const original = await readFile(path.join(f.root, view), "utf8");
  await save(f.root, view, original + "// Source changed after batch execution\n");
  await assert.rejects(f.invoke({ action, plan: native.request.plan }), { diagnosticCode: "source-mismatch" });
  await save(f.root, view, original);
  await assert.rejects(f.invoke(native.request, native.directory), { diagnosticCode: "apple-batch-invalidated" });
});

nativeTest("catalogue output collisions are refused before any enumeration can launch", async (t) => {
  const f = await fixture(t, true), native = await fullBatches(f);
  const directory = `${native.directory}/catalog-collision`;
  await save(f.root, `${directory}/stdout.txt`, "Retained conflicting output\n");
  await mkdir(path.join(f.root, directory, "enumeration.json"));
  await assert.rejects(f.invoke({ action: "apple-catalog", plan: native.request.plan, role: "mac" }, directory));
  await assert.rejects(readFile(path.join(f.root, directory, "command-request.json")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.root, directory, "stdout.txt"), "utf8"), "Retained conflicting output\n");
  const probes = nativeProbes();
  probes.catalogOutputRace = true;
  await save(f.root, ".data/native-probes.json", probes);
  const raced = `${native.directory}/catalog-race`;
  await assert.rejects(f.invoke({ action: "apple-catalog", plan: native.request.plan, role: "mac" }, raced),
    { diagnosticCode: "report-write" });
  const completion = JSON.parse(await readFile(path.join(f.root, raced, "command-response.json")));
  assert.equal(completion.status, "failed");
  assert.equal(completion.outcome.exitCode, 1);
  assert.equal(completion.cleanup, "completed");
  assert.equal(completion.failure.reason, "command-failed");
  assert.equal(completion.retentionFailures.length, 1);
  const invalidated = JSON.parse(await readFile(path.join(f.root, native.directory, "batch-invalidated.json")));
  assert.equal(invalidated.execution.id, completion.id);
  assert.deepEqual(invalidated.execution.outcome, completion.outcome);
  await assert.rejects(f.invoke(native.request, native.directory), { diagnosticCode: "apple-batch-invalidated" });
});

nativeTest("local command planning retains all exact roles without executing a native test", async (t) => {
  const f = await fixture(t, true), p = await commandPlan(f);
  assert.equal(p.plan.selection.testMode, "xcodebuild");
  assert.equal(p.plan.selection.fullSuite, true);
  assert.deepEqual(p.plan.selection.builds, ["ios", "macos"]);
  assert.deepEqual(p.plan.selection.tests.map((target) => target.deviceId),
    APPLE_REQUIREMENTS.targets.map((_target, index) => fixtureDevice(index)));
  assert.equal(p.plan.complete, false);
  assert.equal(p.plan.acceptance, false);
  assert.ok(!(await readdir(path.join(f.root, p.directory))).includes("command-started.json"));
});

nativeTest("a used local command plan cannot start another native run", async (t) => {
  const f = await fixture(t, true), p = await commandPlan(f);
  await save(f.root, `${p.directory}/command-started.json`, { original: "Synthetic already admitted run" });
  await assert.rejects(f.invoke({ action: "apple-run", plan: p.file }, `${p.directory}/execution`),
    (error) => error.code === "EEXIST" && error.appleCommandNotStarted === true);
  assert.ok(!(await readdir(path.join(f.root, p.directory))).includes("command-invalidated.json"));
});

nativeTest("local command qualification cannot turn MCP receipts into command evidence", async (t) => {
  const f = await fixture(t, true), p = await commandPlan(f);
  await assert.rejects(f.invoke({ action: "apple-qualify", plan: p.file, tests: [], builds: [] }, p.directory),
    { diagnosticCode: "configuration" });
  const file = `${p.directory}/command-invalidated.json`, original = await readFile(path.join(f.root, file), "utf8");
  assert.equal(JSON.parse(original).kind, "apple-command-invalidation");
  await assert.rejects(f.invoke({ action: "binding", plan: p.file }, p.directory),
    { diagnosticCode: "apple-command-invalidated" });
  assert.equal(await readFile(path.join(f.root, file), "utf8"), original);
});

nativeTest("source drift permanently invalidates the local command plan", async (t) => {
  const f = await fixture(t, true), p = await commandPlan(f);
  const old = await readFile(path.join(f.root, controls), "utf8");
  await save(f.root, controls, old + "// A real changed source input in this synthetic fixture\n");
  await assert.rejects(f.invoke({ action: "binding", plan: p.file }, p.directory), { diagnosticCode: "source-mismatch" });
  await save(f.root, controls, old);
  await assert.rejects(f.invoke({ action: "binding", plan: p.file }, p.directory), { diagnosticCode: "apple-command-invalidated" });
});
