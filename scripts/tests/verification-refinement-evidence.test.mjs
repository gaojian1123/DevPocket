import assert from "node:assert/strict";
import { readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { executeVerification, verificationPlan } from "../verification.mjs";
import { readVerificationRun } from "../verification-run.mjs";
import { controls, fixture, nativeEvidence, nativeTest, planned, save, view } from "./fixtures/apple-refinement.mjs";

nativeTest("all-passed commands with a blocked terminal qualification are not a checkpoint", async (t) => {
  const f = await fixture(t);
  const blocked = { ...f.report, complete: false, status: "blocked", failure: { reason: "environment-changed" } };
  await save(f.root, ".data/verification/blocked.json", blocked);
  await assert.rejects(f.invoke({ ...f.prepareRequest, verification: ".data/verification/blocked.json" }),
    { diagnosticCode: "check-failed" });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, ".data/verification/blocked.json"))), blocked);
});

nativeTest("a historical source, edited report or implementer-written review cannot create a checkpoint", async (t) => {
  const f = await fixture(t);
  await save(f.root, ".data/apple/review.json", { verdict: "pass", reviewedSource: f.report.source });
  await assert.rejects(f.invoke(f.request), { diagnosticCode: "execution-origin" });
  await save(f.root, ".data/apple/review.json", f.review);
  await save(f.root, view, "New source, not the accepted snapshot\n");
  await assert.rejects(f.invoke(f.request), { diagnosticCode: "source-mismatch" });
});

nativeTest("native exports must match the actual xcresult and report every selected test passing", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const summaryFile = `${native.directory}/summary.json`;
  await save(f.root, summaryFile, { ...native.summary, passedTests: 99 });
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "artifact-changed" });
  const failed = { ...native.summary, result: "Failed", failedTests: 1, passedTests: 0 };
  await save(f.root, summaryFile, failed);
  await save(f.root, `${native.directory}/result.xcresult/summary.json`, failed);
  await save(f.root, path.relative(f.root, path.join(native.originalBundle, "summary.json")), failed);
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "check-failed" });
});

nativeTest("old native results, wrong devices and skipped tests are not fresh visual evidence", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  for (const [summary, diagnosticCode] of [
    [{ ...native.summary, startTime: Date.parse(plan.createdAt) / 1000 - 5 }, "execution-origin"],
    [{ ...native.summary, skippedTests: 1 }, "check-failed"],
    [{ ...native.summary, devicesAndConfigurations: [{ ...native.summary.devicesAndConfigurations[0],
      device: { ...native.summary.devicesAndConfigurations[0].device, deviceId: "wrong-device" } }] }, "check-failed"],
  ]) {
    await save(f.root, `${native.directory}/summary.json`, summary);
    await save(f.root, `${native.directory}/result.xcresult/summary.json`, summary);
    await save(f.root, path.relative(f.root, path.join(native.originalBundle, "summary.json")), summary);
    await assert.rejects(f.invoke(native.request), { diagnosticCode });
  }
});

nativeTest("selected test passes require the original invocation, workspace and bundle", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const item = native.request.tests[0];
  const start = JSON.parse(await readFile(path.join(f.root, item.requestEvent)));
  const finish = JSON.parse(await readFile(path.join(f.root, item.responseEvent)));
  for (const [edit, diagnosticCode] of [
    [(request) => { request.data.arguments.workspaceIdentifier = "/another/worktree/DevPocket.xcodeproj"; }, "execution-origin"],
    [(request) => { request.data.mcpToolName = "RunAllTests"; }, "case-evidence"],
    [(request) => { request.timestamp = new Date(Date.parse(plan.createdAt) - 5000).toISOString(); }, "case-evidence"],
    [(request) => { request.data.arguments.tests[0].testIdentifier = "DevPocketUITests/anotherCase()"; }, "case-evidence"],
  ]) {
    const invalid = structuredClone(start);
    edit(invalid);
    await save(f.root, item.requestEvent, invalid);
    await assert.rejects(f.invoke(native.request), { diagnosticCode });
  }
  await save(f.root, item.requestEvent, start);
  await save(f.root, item.responseEvent, { ...finish, data: { ...finish.data, success: false } });
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "case-evidence" });
  await save(f.root, item.responseEvent, finish);
  const omitted = structuredClone(native.request);
  delete omitted.tests[0].requestEvent;
  await assert.rejects(f.invoke(omitted), { diagnosticCode: "ownership-mismatch" });
  await save(f.root, path.relative(f.root, path.join(native.originalBundle, "different-bytes.txt")), "Another producing bundle\n");
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "artifact-changed" });
});

nativeTest("refinement accepts whole-second xcresult precision inside an actual MCP invocation", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const rounded = { ...native.summary, startTime: Math.floor(native.summary.startTime),
    finishTime: Math.ceil(native.summary.finishTime) };
  for (const file of [`${native.directory}/summary.json`, `${native.directory}/result.xcresult/summary.json`,
    path.relative(f.root, path.join(native.originalBundle, "summary.json"))]) await save(f.root, file, rounded);
  const result = await f.invoke(native.request);
  assert.equal(result.status, "passed");
  assert.equal(result.checks[0].result.startedAt, new Date(rounded.startTime * 1000).toISOString());
  assert.equal(result.checks[0].execution.startedAt, new Date(native.summary.startTime * 1000).toISOString());
});

nativeTest("changed products and source changes after planning invalidate qualification", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  await save(f.root, native.request.builds[0].bundle + "/DevPocket", "Changed product\n");
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "artifact-changed" });
  await save(f.root, controls, "Changed after the planned source\n");
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "source-mismatch" });
});

nativeTest("failed, omitted and stale build invocations never produce a build pass", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const item = native.request.builds[0];
  const start = JSON.parse(await readFile(path.join(f.root, item.requestEvent)));
  const finish = JSON.parse(await readFile(path.join(f.root, item.responseEvent)));
  const failed = structuredClone(finish);
  failed.data.result.structuredContent.buildResult = "The build failed.";
  failed.data.result.structuredContent.errors = ["Synthetic compiler failure"];
  await save(f.root, item.responseEvent, failed);
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "check-failed" });
  await save(f.root, item.responseEvent, finish);
  await save(f.root, item.requestEvent, { ...start, timestamp: new Date(Date.parse(plan.createdAt) - 1000).toISOString() });
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "check-failed" });
  await save(f.root, item.requestEvent, start);
  const omitted = structuredClone(native.request);
  delete omitted.builds[0].requestEvent;
  await assert.rejects(f.invoke(omitted), { diagnosticCode: "ownership-mismatch" });
});

nativeTest("build logs, workspaces and producing products must match the native invocation", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const item = native.request.builds[0];
  const start = JSON.parse(await readFile(path.join(f.root, item.requestEvent)));
  const finish = JSON.parse(await readFile(path.join(f.root, item.responseEvent)));
  const originalLog = finish.data.result.structuredContent.fullLogPath;
  const log = await readFile(path.join(f.root, item.log), "utf8");
  await save(f.root, item.log, "** BUILD FAILED **\n");
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "artifact-changed" });
  await save(f.root, path.relative(f.root, originalLog), "** BUILD FAILED **\n");
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "execution-origin" });
  await save(f.root, item.log, log);
  await save(f.root, path.relative(f.root, originalLog), log);
  const wrong = structuredClone(start);
  wrong.data.arguments.workspaceIdentifier = "/another/worktree/DevPocket.xcodeproj";
  await save(f.root, item.requestEvent, wrong);
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "execution-origin" });
  await save(f.root, item.requestEvent, start);
  await save(f.root, path.relative(f.root, item.originalProduct) + "/DevPocket", "A different producing product\n");
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "artifact-changed" });
});

nativeTest("actual workspace mappings bind handle-based MCP calls without rewriting the request", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  const item = native.request.builds[0], request = JSON.parse(await readFile(path.join(f.root, item.requestEvent)));
  const before = JSON.parse(await readFile(path.join(f.root, ".data/apple/fresh/before.json")));
  request.data.arguments.workspaceIdentifier = "workspace-fixture";
  await save(f.root, item.requestEvent, request);
  const requestEvent = ".data/apple/fresh/workspaces-request.json";
  const responseEvent = ".data/apple/fresh/workspaces-response.json";
  await save(f.root, requestEvent, { type: "tool.execution_start", timestamp: before.observedAt, data: {
    toolCallId: "fixture-workspaces", mcpServerName: "xcode", mcpToolName: "XcodeListWorkspaces", arguments: {},
  } });
  const response = { type: "tool.execution_complete", timestamp: before.observedAt, data: {
    toolCallId: "fixture-workspaces", success: true, result: { structuredContent: {
      message: `* workspaceIdentifier: workspace-fixture, workspacePath: ${path.join(f.root, "apple", "DevPocket", "DevPocket.xcodeproj")}`,
    } },
  } };
  await save(f.root, responseEvent, response);
  item.workspaceBinding = { requestEvent, responseEvent };
  const testItem = native.request.tests[0];
  const testRequest = JSON.parse(await readFile(path.join(f.root, testItem.requestEvent)));
  testRequest.data.arguments.workspaceIdentifier = "workspace-fixture";
  await save(f.root, testItem.requestEvent, testRequest);
  testItem.workspaceBinding = { requestEvent, responseEvent };
  assert.equal((await f.invoke(native.request)).status, "passed");
  for (const alter of [
    (value) => { value.data.result.structuredContent.message = "* workspaceIdentifier: workspace-fixture, workspacePath: /another/DevPocket.xcodeproj"; },
    (value) => { value.data.result.structuredContent.message += "\n" + value.data.result.structuredContent.message; },
    (value) => { value.data.result.structuredContent.message = value.data.result.structuredContent.message.replace("workspace-fixture", "another-handle"); },
    (value) => { value.timestamp = new Date(Date.parse(before.observedAt) - 1).toISOString(); },
    (value) => { value.timestamp = new Date(Date.parse(request.timestamp) + 1).toISOString(); },
    (value) => { value.data.toolCallId = "another-call"; },
    (value) => { value.data.result.isError = true; },
  ]) {
    const invalid = structuredClone(response);
    alter(invalid);
    await save(f.root, responseEvent, invalid);
    await assert.rejects(f.invoke(native.request), { diagnosticCode: "execution-origin" });
  }
});

nativeTest("a missing local Apple request blocks before execution and releases the owned gate", async (t) => {
  const f = await fixture(t);
  await save(f.root, "apple/DevPocket/DevPocket.xcodeproj/project.pbxproj", "// Synthetic project; never built\n");
  await save(f.root, "scripts/apple-runner.mjs", "// Synthetic entry; never executed\n");
  const plan = await verificationPlan(f.root, f.base);
  const report = await executeVerification(f.root, plan, {
    group: "apple", directory: path.join(f.root, ".data/verification/missing-apple-request"),
  });
  const check = report.checks.find((item) => item.id === "apple-native");
  assert.equal(report.status, "blocked");
  assert.equal(check.failure.reason, "apple-evidence-required", JSON.stringify(report));
  assert.equal(check.executionState, "not-started");
  assert.equal(report.admission.state, report.admission.mode === "inherited" ? "returned" : "released");
  const recorded = await readVerificationRun(f.root, report.run.manifest);
  assert.deepEqual(recorded.report, report);
  assert.equal(recorded.latest.get("apple").report.group, "apple");
  const resumed = await executeVerification(f.root, plan, {
    group: "apple", resume: report.run.manifest,
    directory: path.join(f.root, ".data/verification/missing-apple-request-resumed"),
  });
  assert.equal(resumed.checks.find((item) => item.id === "apple-native").failure.reason, "apple-evidence-required");
  assert.equal((await readVerificationRun(f.root, resumed.run.manifest)).count, 2);
});

nativeTest("retained evidence paths cannot escape the worktree or follow symlinks", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.invoke({ ...f.request, review: "../review.json" }), { diagnosticCode: "ownership-mismatch" });
  const link = path.join(f.root, ".data", "linked");
  await symlink(path.join(f.root, ".data", "apple"), link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.invoke({ ...f.request, review: ".data/linked/review.json" }), { diagnosticCode: "ownership-mismatch" });
});
