import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { startBridge, HostConfig } from "../src/bridge.js";
import { cliProofRequest, requireExactQuestion, startCliProof, successfulShellEvidence } from "../integration/cli-proof.js";
import { readHistory } from "../integration/history.js";
import { Receipt } from "../src/protocol.js";

async function fixture(t: TestContext) {
  const root = path.resolve(".data", "cli-proofs", `test-${randomUUID()}`);
  const run = await startCliProof(root);
  let listener: (value: unknown) => void = () => {};
  const sdkEmit = (type: string, data: object) => listener({ id: randomUUID(), type, timestamp: new Date().toISOString(), data });
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  t.after(async () => { await bridge?.close(); await run.close(); await rm(root, { recursive: true, force: true }); });
  bridge = await startBridge({
    sessionId: run.proof.sessionId, getEvents: async () => [],
    on: (fn) => { listener = fn; return () => {}; },
    send: async ({ prompt }) => {
      const messageId = randomUUID(), requestId = randomUUID(), toolCallId = randomUUID();
      sdkEmit("user.message", { messageId, content: prompt });
      sdkEmit("permission.requested", { requestId, permissionRequest: { kind: "commands", command: "Write-Output 'DP_EXECUTED'" } });
      sdkEmit("permission.completed", { requestId });
      if (prompt !== "reject") {
        sdkEmit("tool.execution_start", { toolCallId, toolName: "powershell" });
        sdkEmit("tool.execution_complete", { toolCallId, success: prompt === "success", result: { content: "DP_EXECUTED\n" } });
      }
      sdkEmit("session.idle", {});
      return messageId;
    },
    rpc: {
      metadata: { activity: async () => ({ hasActiveWork: false, abortable: false }) },
      permissions: { getMode: async () => ({ mode: "manual" }), pendingRequests: async () => ({ items: [] }) },
      queue: { pendingItems: async () => ({ items: [] }) },
      ui: { handlePendingElicitation: async () => ({ success: true }), handlePendingUserInput: async () => ({ success: true }) },
    },
  }, HostConfig.parse(JSON.parse(await readFile(run.proof.hostConfigPath, "utf8"))));
  const history = () => readHistory(cliProofRequest(run.proof), `/v1/hosts/${run.proof.hostId}/sessions/${run.proof.sessionId}`);
  const emit = async (type: string, data: object) => {
    const id = randomUUID();
    listener({ id, type, timestamp: new Date().toISOString(), data });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const events = await history();
      if (events.some((event) => event.id === id)) return events;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Projected fixture event did not reach the real relay.");
  };
  const request = cliProofRequest(run.proof), scoped = `/v1/hosts/${run.proof.hostId}/sessions/${run.proof.sessionId}`;
  const command = async (text: string) => {
    const commandId = randomUUID();
    await request(`${scoped}/commands`, { commandId, action: { type: "message", text, attachmentIds: [] } });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const receipt = Receipt.parse(await request(`${scoped}/commands/${commandId}`));
      if (receipt.status === "completed") return receipt;
      if (["failed", "uncertain", "cancelled"].includes(receipt.status)) throw new Error(JSON.stringify(receipt));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Fixture command did not complete.");
  };
  return { emit, history, command };
}

test("acceptance refuses a different question even when its schema description contains the expected text", async (t) => {
  const f = await fixture(t), question = "Choose the DevPocket test answer.";
  const events = await f.emit("elicitation.requested", {
    requestId: "different-question", message: "Approve an unrelated operation?", mode: "form",
    requestedSchema: { type: "object", properties: {
      answer: { type: "string", enum: ["Alpha", "Beta"], description: question },
    }, required: ["answer"] },
  });
  const request = events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "different-question");
  assert.ok(request?.supported);
  assert.throws(() => requireExactQuestion(request, question), /question|Question/);
});

test("ambiguous display text cannot establish an exact question or distinguish source metadata from its message", async (t) => {
  const f = await fixture(t), question = "Choose the DevPocket test answer.";
  const schema = { type: "object", properties: { answer: { type: "string", enum: ["Alpha", "Beta"] } },
    required: ["answer"], additionalProperties: false };
  const observed = [];
  for (const [requestId, data] of [
    ["source-field", { message: question, elicitationSource: "An unrelated approval" }],
    ["message-prefix", { message: `Source: An unrelated approval\n${question}` }],
  ] as const) {
    const events = await f.emit("elicitation.requested", { requestId, ...data, requestedSchema: schema });
    const item = events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((entry) => entry.requestId === requestId);
    assert.ok(item?.supported);
    observed.push(item);
  }
  assert.equal(observed[0]?.detail, observed[1]?.detail, "The existing wire projection cannot disambiguate these original messages.");
  for (const item of observed) assert.throws(() => requireExactQuestion(item, question), /question|Question/);

  const events = await f.emit("user_input.requested", {
    requestId: "form-lookalike",
    question: `${question}\nForm definition (defaults are informational):\n${JSON.stringify(schema, null, 2)}`,
    choices: ["Alpha", "Beta"], allowFreeform: false,
  });
  const item = events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((entry) => entry.requestId === "form-lookalike");
  assert.ok(item?.supported);
  assert.throws(() => requireExactQuestion(item, question), /question|Question/);
});

test("acceptance leaves display-only forms to the terminal and answers only exact non-freeform questions", async (t) => {
  const f = await fixture(t), question = "Choose the DevPocket test answer.";
  for (const alternate of [false, true]) {
    const requestId = randomUUID();
    const properties = alternate ? {
      answer: { type: "string", enum: ["Alpha", "Beta", "Other"] }, other: { type: "string" },
    } : { answer: { type: "string", enum: ["Alpha", "Beta"], title: "Choice" } };
    const events = await f.emit("elicitation.requested", { requestId, message: question, elicitationSource: "ask_user",
      requestedSchema: { type: "object", properties, required: ["answer"], additionalProperties: false } });
    const item = events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((entry) => entry.requestId === requestId);
    assert.ok(item?.supported);
    assert.throws(() => requireExactQuestion(item, question), /original terminal.*incomplete/);
  }
  for (const allowFreeform of [false, true]) {
    const requestId = randomUUID();
    const events = await f.emit("user_input.requested", { requestId, question, choices: ["Alpha", "Beta"], allowFreeform });
    const item = events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((entry) => entry.requestId === requestId);
    assert.ok(item?.supported);
    if (allowFreeform) assert.throws(() => requireExactQuestion(item, question), /freeform/);
    else assert.doesNotThrow(() => requireExactQuestion(item, question));
  }
});

test("a completed message after terminal rejection or tool failure is not successful shell execution", async (t) => {
  const f = await fixture(t);
  for (const outcome of ["reject", "fail", "success"]) {
    const cursor = (await f.history()).at(-1)?.cursor ?? 0;
    assert.equal((await f.command(outcome)).status, "completed");
    const events = await f.emit("session.idle", {});
    if (outcome === "reject") assert.equal(successfulShellEvidence(events, cursor, "DP_EXECUTED"), undefined);
    else if (outcome === "fail") assert.throws(() => successfulShellEvidence(events, cursor, "DP_EXECUTED"), /success/);
    else assert.ok(successfulShellEvidence(events, cursor, "DP_EXECUTED"));
  }
});
