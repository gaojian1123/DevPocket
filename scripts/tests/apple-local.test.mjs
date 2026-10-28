import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAppleMcpTestInvocation } from "../verification-refinement.mjs";
import { appleEnumerationArguments, normalizeAppleTestCatalog } from "../apple-evidence.mjs";

function invocation() {
  const root = "/synthetic-local-checkout", identifier = "workspace-fixture";
  const pair = { before: { value: { observedAt: "2026-10-25T00:00:00.000Z" } },
    after: { value: { observedAt: "2026-10-25T00:01:00.000Z" } } };
  const start = { type: "tool.execution_start", timestamp: "2026-10-25T00:00:10.000Z", data: {
    toolCallId: "synthetic-full-tests", mcpServerName: "xcode", mcpToolName: "RunAllTests",
    arguments: { workspaceIdentifier: identifier },
  } };
  const finish = { type: "tool.execution_complete", timestamp: "2026-10-25T00:00:50.000Z", data: {
    toolCallId: start.data.toolCallId, success: true, result: { structuredContent: {
      schemeName: "DevPocket", truncated: false, xcresultBundlePath: "/synthetic/RunAllTests/result.xcresult",
      counts: { total: 2, passed: 2, failed: 0, skipped: 0, expectedFailures: 0, notRun: 0 },
      totalResults: 2, results: [
        { targetName: "DevPocketTests", identifier: "ModelTests/example()", state: "Passed", errorMessages: [] },
        { targetName: "DevPocketUITests", identifier: "UITests/example()", state: "Passed", errorMessages: [] },
      ],
    } },
  } };
  return { root, identifier, pair, start, finish, target: { role: "mac" } };
}

const validate = (value, selected) => validateAppleMcpTestInvocation(value.start, value.finish,
  value.root, value.pair, value.target, value.identifier, selected);

test("local full-suite records preserve the actual MCP origin and invocation interval", () => {
  const value = invocation(), result = validate(value);
  assert.equal(result.execution.tool, "xcode/RunAllTests");
  assert.equal(result.execution.origin, "local-xcode-mcp");
  assert.equal(result.execution.startedAt, value.start.timestamp);
  assert.equal(result.execution.completedAt, value.finish.timestamp);
  assert.equal(result.result.xcresultBundlePath, value.finish.data.result.structuredContent.xcresultBundlePath);
});

test("a selected subset, stale call, wrong workspace or incomplete count is not full Apple evidence", () => {
  for (const edit of [
    (value) => { value.start.data.mcpToolName = "RunSomeTests"; },
    (value) => { value.start.data.arguments.tests = [{ targetName: "DevPocketUITests", testIdentifier: "UITests/example()" }]; },
    (value) => { value.start.timestamp = "2026-10-24T23:59:59.000Z"; },
    (value) => { value.start.data.arguments.workspaceIdentifier = "another-workspace"; },
    (value) => { value.finish.data.toolCallId = "another-call"; },
    (value) => { value.finish.data.success = false; },
    (value) => { value.finish.data.result.isError = true; },
    (value) => { value.finish.data.result.structuredContent.counts.notRun = 1; },
    (value) => { value.finish.data.result.structuredContent.counts.skipped = 1; },
    (value) => { value.finish.data.result.structuredContent.truncated = true; },
    (value) => { delete value.finish.data.result.structuredContent.xcresultBundlePath; },
    (value) => { delete value.finish.data.result.structuredContent.results[0].targetName; },
    (value) => { value.finish.data.result.structuredContent.results[1] = value.finish.data.result.structuredContent.results[0]; },
    (value) => { value.finish.data.result.structuredContent.results[0] = null; },
  ]) {
    const value = invocation();
    edit(value);
    assert.throws(() => validate(value), { diagnosticCode: "case-evidence" });
  }
});

const targets = ["DevPocketTests", "DevPocketUITests"];
function catalog() {
  return { errors: [], values: [{ testPlan: "DevPocket", disabledTests: [],
    enabledTests: [
      ...Array.from({ length: 137 }, (_, index) => ({ identifier: `DevPocketTests/ModelTests/test${index}()` })),
      { identifier: "DevPocketUITests/WindowTests/testLayout()" },
    ] }] };
}

test("fresh native enumeration retains every target-qualified case, including beyond MCP's inline limit", () => {
  const tests = normalizeAppleTestCatalog(catalog(), targets);
  assert.equal(tests.length, 138);
  assert.ok(tests.some((item) => item.targetName === "DevPocketTests" && item.testIdentifier === "ModelTests/test136()"));
  const args = appleEnumerationArguments("/owned/worktree", ".data/verification/plan/catalog-mac",
    { role: "mac", platform: "macOS", deviceId: "owned-mac-id" });
  assert.equal(args.at(-1), "test");
  assert.ok(args.includes("-enumerate-tests"));
  assert.equal(args[args.indexOf("-test-enumeration-style") + 1], "flat");
  assert.equal(args[args.indexOf("-derivedDataPath") + 1], "/owned/worktree/.data/verification/plan/catalog-mac/derived");
  assert.equal(args[args.indexOf("-destination") + 1], "platform=macOS,id=owned-mac-id");
  assert.ok(args.every((arg) => !/only-testing|skip-testing|testPlan|test-without-building/.test(arg)));
});

test("cached MCP lists, disabled/error/duplicate/unknown or incomplete native catalogues fail closed", () => {
  assert.throws(() => normalizeAppleTestCatalog({ truncated: false, results: [], totalResults: 0 }, targets));
  for (const edit of [
    (value) => { value.errors = ["Test runner never connected"]; },
    (value) => { delete value.errors; },
    (value) => { value.truncated = true; },
    (value) => { value.values[0].disabledTests.push(value.values[0].enabledTests.pop()); },
    (value) => { delete value.values[0].disabledTests; },
    (value) => { value.values[0].enabledTests.pop(); },
    (value) => { value.values[0].enabledTests.push(value.values[0].enabledTests[0]); },
    (value) => { value.values[0].enabledTests.push({ identifier: "UnknownTests/Hidden/test()" }); },
    (value) => { value.values[0].enabledTests[0].identifier = "DevPocketTests/"; },
    (value) => { value.values.push(value.values[0]); },
  ]) {
    const value = catalog();
    edit(value);
    assert.throws(() => normalizeAppleTestCatalog(value, targets));
  }
});

test("batched MCP filters use actual target names, not a class-name guess, and match every returned case", () => {
  const value = invocation();
  value.start.data.mcpToolName = "RunSomeTests";
  const allowed = value.finish.data.result.structuredContent.results.map((item) =>
    ({ targetName: item.targetName, testIdentifier: item.identifier }));
  value.start.data.arguments.tests = allowed;
  const result = validate(value, allowed);
  assert.equal(result.execution.tool, "xcode/RunSomeTests");
  assert.deepEqual(result.selected, allowed);
  for (const edit of [
    (value) => { value.start.data.arguments.tests[0].targetName = "ModelTests"; },
    (value) => { value.start.data.arguments.tests[0].testIdentifier = "ModelTests/*"; },
    (value) => { value.start.data.arguments.tests.push(value.start.data.arguments.tests[0]); },
    (value) => { value.start.data.arguments.tests.pop(); },
    (value) => { delete value.start.data.arguments.tests; },
    (value) => { value.finish.data.result.structuredContent.results[0].identifier = "ModelTests/unknown()"; },
    (value) => { value.finish.data.result.structuredContent.results[0].state = "Cancelled"; },
    (value) => { value.finish.data.result.structuredContent.counts.notRun = 1; },
    (value) => { value.finish.data.result.structuredContent.truncated = true; },
    (value) => { value.finish.data.success = false; value.finish.data.error = { code: -32001, message: "Timed out" }; },
  ]) {
    const changed = structuredClone(value);
    edit(changed);
    assert.throws(() => validate(changed, allowed), { diagnosticCode: "case-evidence" });
  }
});
