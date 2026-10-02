import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { CopilotRuntime, type JoinedSession } from "../src/runtime.js";
import type { UserEvent } from "../src/protocol.js";

export function runtimePeer(root: string) {
  let listener: (event: unknown) => void = () => {};
  let pending = true;
  const id = randomUUID();
  const at = new Date().toISOString();
  const event = (type: string, data: object) => ({ id: randomUUID(), timestamp: at, type, data });
  const requests = [{ requestId: "approval-1", request: { kind: "commands", toolName: "powershell",
    fullCommandText: "Write-Output 'harmless'", intention: "Read test output" } }];
  const session: JoinedSession = {
    sessionId: id,
    getEvents: async () => [
      event("session.start", { sessionId: id, copilotVersion: "1.0.90-0", context: { cwd: root } }),
      event("user.message", { messageId: "original-user", content: "In the terminal before attachment", source: "system" }),
      event("system.message", { content: "NEVER_EXPORT" }),
      event("model.messages_snapshot", { messages: [{ role: "system", content: "NEVER_EXPORT" }] }),
      event("assistant.reasoning_delta", { deltaContent: "PRIVATE_REASONING" }),
      event("assistant.message", { messageId: "original-answer", content: "Original answer", reasoningText: "NEVER_EXPORT" }),
    ],
    on: (fn) => { listener = fn; return () => { listener = () => {}; }; },
    send: async (options) => {
      assert.equal(options.mode, "enqueue");
      assert.equal(options.source, "user");
      return "runtime-user-id";
    },
    abort: async () => {},
    rpc: {
      permissions: {
        getMode: async () => ({ mode: "manual" }),
        pendingRequests: async () => ({ items: pending ? requests : [] }),
        handlePendingPermissionRequest: async () => { const success = pending; pending = false; return { success }; },
        paths: { list: async () => ({ primary: root, directories: [root] }) },
      },
      metadata: { activity: async () => ({ hasActiveWork: false, abortable: false }) },
      name: { get: async () => ({ name: "Original runtime" }) },
      model: {
        getCurrent: async () => ({ modelId: "test-model", reasoningEffort: "high" }),
        list: async () => ({ list: [{ id: "test-model", name: "Test", supportedReasoningEfforts: ["low", "high"] }] }),
        switchTo: async () => ({ modelId: "test-model" }),
      },
      contentExclusion: { checkPaths: async ({ paths }) => ({ available: true, checks: paths.map((p) => ({ path: p, excluded: false })) }) },
      ui: { handlePendingUserInput: async () => ({ success: true }) },
    },
  };
  return { session, emit: (type: string, data: object) => listener(event(type, data)) };
}

test("runtime attachment exports earlier visible history without system prompts or reasoning internals", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/runtime-"));
  const peer = runtimePeer(root), events: UserEvent[] = [];
  const runtime = new CopilotRuntime(peer.session, (event) => events.push(event));
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  const summary = await runtime.connect();
  assert.equal(summary.sessionId, peer.session.sessionId);
  assert.equal(summary.permissionMode, "manual");
  assert.equal(summary.state, "waiting");
  const text = JSON.stringify(events);
  assert.ok(text.includes("In the terminal before attachment"));
  assert.ok(text.includes("Original answer"));
  assert.ok(!text.includes("NEVER_EXPORT"));
  assert.ok(!text.includes("PRIVATE_REASONING"));
  const receipt = await runtime.execute({ type: "message", text: "Phone continuation", attachmentIds: [] });
  assert.equal(receipt.status, "admitted");
  assert.equal(receipt.result?.messageId, "runtime-user-id");
});

test("permission races, unknown forms and strict question choices never produce false approval success", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/approvals-"));
  const peer = runtimePeer(root), events: UserEvent[] = [];
  const runtime = new CopilotRuntime(peer.session, (event) => events.push(event));
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.connect();
  const permission = await runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" });
  assert.equal(permission.status, "completed");
  await assert.rejects(runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "REQUEST_STALE" });
  peer.emit("user_input.requested", { requestId: "question-1", question: "Choose a branch?", choices: ["Keep", "Stop"], allowFreeform: false });
  await assert.rejects(runtime.execute({ type: "answer", requestId: "question-1", answer: "Do everything" }), { code: "INVALID_CHOICE" });
  peer.emit("user_input.completed", { requestId: "question-1", answer: "Keep" });
  await assert.rejects(runtime.execute({ type: "answer", requestId: "question-1", answer: "Stop" }), { code: "REQUEST_STALE" });
  peer.emit("elicitation.requested", { requestId: "complex-1", requestedSchema: { anything: true } });
  const requests = events.filter((event) => event.kind === "requests").at(-1);
  assert.equal(requests?.data.items[0]?.type, "terminal");
  assert.equal(requests?.data.items[0]?.supported, false);
  const stop = await runtime.execute({ type: "abort" });
  assert.equal(stop.status, "cancel_requested");
  assert.equal(stop.result?.stopped, false);
  assert.equal(events.at(-1)?.kind, "runtime.state");
  assert.ok(!events.some((event) => event.kind === "runtime.state" && event.data.state === "idle"));
  peer.emit("session.idle", { aborted: true });
  assert.equal(events.at(-1)?.kind === "runtime.state" && events.at(-1)?.data.state, "idle");
});

test("a previously recorded question is not revived as pending after first attachment without a live question snapshot", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/questions-"));
  const peer = runtimePeer(root), events: UserEvent[] = [];
  const history = peer.session.getEvents;
  peer.session.getEvents = async () => [...await history(), {
    id: randomUUID(), timestamp: new Date().toISOString(), type: "user_input.requested",
    data: { requestId: "old-question", question: "Answered before attachment", choices: ["Yes", "No"] },
  }];
  const runtime = new CopilotRuntime(peer.session, (event) => events.push(event));
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.connect();
  assert.ok(!events.some((event) => event.kind === "requests" && event.data.items.some((item) => item.requestId === "old-question")));
});

test("simple native elicitation questions survive permission refresh and resolve with the exact schema field", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/elicitation-"));
  const peer = runtimePeer(root), events: UserEvent[] = [];
  let answer: unknown;
  peer.session.rpc.ui = {
    handlePendingElicitation: async (input) => { answer = input; return { success: true }; },
  };
  const runtime = new CopilotRuntime(peer.session, (event) => events.push(event));
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.connect();
  peer.emit("elicitation.requested", {
    requestId: "form-1", message: "Choose one", mode: "form",
    requestedSchema: { type: "object", properties: { selection: { type: "string", enum: ["Alpha", "Beta"], title: "Choice" } }, required: ["selection"] },
  });

  await runtime.refresh();
  const event = events.filter((event) => event.kind === "requests").at(-1);
  const item = event?.data.items.find((item) => item.requestId === "form-1");
  assert.equal(item?.type, "question");
  assert.equal(item.supported, true);
  await assert.rejects(runtime.execute({ type: "answer", requestId: "form-1", answer: "Not an option" }), { code: "INVALID_CHOICE" });
  assert.equal((await runtime.execute({ type: "answer", requestId: "form-1", answer: "Alpha" })).status, "completed");
  assert.deepEqual(answer, { requestId: "form-1", result: { action: "accept", content: { selection: "Alpha" } } });
});

test("a message observed in the runtime queue is reported queued rather than processing", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/queue-"));
  const peer = runtimePeer(root);
  peer.session.rpc.queue = { pendingItems: async () => ({ items: [{ kind: "message", messageId: "runtime-user-id" }] }) };
  const runtime = new CopilotRuntime(peer.session, () => {});
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.connect();
  assert.equal((await runtime.execute({ type: "message", text: "Wait behind the running tool", attachmentIds: [] })).status, "queued");
  const stop = await runtime.execute({ type: "abort" });
  assert.equal(stop.status, "cancel_requested");
  assert.deepEqual(stop.result?.cancelledMessageIds, ["runtime-user-id"]);
});
