import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAppleMcpTestInvocation } from "../verification-refinement.mjs";

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

const validate = (value) => validateAppleMcpTestInvocation(value.start, value.finish,
  value.root, value.pair, value.target, value.identifier);

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
