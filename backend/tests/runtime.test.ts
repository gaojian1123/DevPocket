import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { CopilotRuntime, type JoinedSession } from "../src/runtime.js";
import { PendingRequest, SessionSummary, type Action, type UserEvent } from "../src/protocol.js";

export function runtimePeer(root: string, version: string | null = "1.0.90-0") {
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
      event("session.start", { sessionId: id, ...(version === null ? {} : { copilotVersion: version }), context: { cwd: root } }),
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

const allCapabilities: SessionSummary["capabilities"] = {
  messages: true, abort: true, permissions: true, questions: true, models: true, files: true, git: true,
};
const capabilityActions: [keyof SessionSummary["capabilities"], Action][] = [
  ["messages", { type: "message", text: "Unavailable control", attachmentIds: [] }],
  ["abort", { type: "abort" }],
  ["permissions", { type: "permission", requestId: "approval-1", decision: "approve-once" }],
  ["questions", { type: "answer", requestId: "question", answer: "Yes" }],
  ["models", { type: "models" }],
  ["models", { type: "model.set", modelId: "test-model" }],
  ["files", { type: "files.list", path: "" }],
  ["files", { type: "files.read", path: "file.txt" }],
  ["git", { type: "git.status" }],
  ["git", { type: "git.diff", path: "file.txt", staged: false }],
];

async function capabilityFixture(t: TestContext, version: string | null = "1.0.90-0") {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/capabilities-"));
  const peer = runtimePeer(root, version), events: UserEvent[] = [];
  const runtime = new CopilotRuntime(peer.session, (event) => events.push(event));
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { ...peer, runtime, events, root };
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

test("capability discovery is read-only and independent of the recorded CLI version", async (t) => {
  for (const version of ["1.0.90-0", "0.0.1", "99.0.0-preview", "custom-build", null]) {
    await t.test(version ?? "missing version", async (t) => {
      const f = await capabilityFixture(t, version), mutations: string[] = [];
      f.session.send = async () => { mutations.push("send"); return "original-runtime-message"; };
      f.session.abort = async () => { mutations.push("abort"); };
      f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { mutations.push("permission"); return { success: true }; };
      f.session.rpc.model!.switchTo = async () => { mutations.push("model"); return { modelId: "test-model" }; };
      f.session.rpc.ui = {
        handlePendingUserInput: async () => { mutations.push("question"); return { success: true }; },
        handlePendingElicitation: async () => { mutations.push("form"); return { success: true }; },
      };
      await f.runtime.connect();
      const summary = await f.runtime.refresh();
      assert.deepEqual(mutations, []);
      assert.equal(summary.sessionId, f.session.sessionId);
      assert.equal(summary.cliVersion, version ?? "unknown");
      assert.deepEqual(summary.capabilities, allCapabilities);
      assert.deepEqual(SessionSummary.parse(JSON.parse(JSON.stringify(summary))), summary);
      assert.ok(!summary.warnings.some((warning) => /unsupported.*version|unknown versions.*read-only/i.test(warning)));
      assert.equal((await f.runtime.execute({ type: "message", text: "Keep the original runtime", attachmentIds: [] })).status, "admitted");
      assert.deepEqual(mutations, ["send"]);
    });
  }
});

test("capabilities require their own validated evidence even for a historically accepted version", async (t) => {
  const cases: {
    name: string; change: (session: JoinedSession) => void; disabled: Partial<SessionSummary["capabilities"]>;
  }[] = [
    { name: "missing RPC tree", change: (s) => { Object.defineProperty(s, "rpc", { value: undefined }); },
      disabled: { messages: false, abort: false, permissions: false, questions: false, models: false, files: false, git: false } },
    { name: "missing send", change: (s) => { delete s.send; }, disabled: { messages: false } },
    { name: "missing abort", change: (s) => { delete s.abort; }, disabled: { abort: false } },
    { name: "unknown abortability", change: (s) => { s.rpc.metadata!.activity = async () => ({ hasActiveWork: false }); },
      disabled: { abort: false } },
    { name: "malformed activity", change: (s) => { s.rpc.metadata!.activity = async () => ({ hasActiveWork: "false", abortable: true }); },
      disabled: { messages: false, abort: false, questions: false } },
    { name: "missing live directory", change: (s) => { delete s.rpc.permissions!.paths; }, disabled: { files: false, git: false } },
    { name: "relative live directory", change: (s) => { s.rpc.permissions!.paths!.list = async () => ({ primary: "relative" }); },
      disabled: { files: false, git: false } },
    { name: "missing permission snapshot", change: (s) => { delete s.rpc.permissions!.pendingRequests; }, disabled: { permissions: false } },
    { name: "incomplete permission snapshot", change: (s) => { s.rpc.permissions!.pendingRequests = async () => ({ items: [{ requestId: "approval-1" }] }); },
      disabled: { permissions: false } },
    { name: "missing permission handler", change: (s) => { delete s.rpc.permissions!.handlePendingPermissionRequest; },
      disabled: { permissions: false } },
    { name: "noncallable permission handler", change: (s) => { Object.defineProperty(s.rpc.permissions, "handlePendingPermissionRequest", { value: true }); },
      disabled: { permissions: false } },
    { name: "missing question handlers", change: (s) => { delete s.rpc.ui; }, disabled: { questions: false } },
    { name: "unknown current model", change: (s) => { s.rpc.model!.getCurrent = async () => ({}); }, disabled: { models: false } },
    { name: "missing catalogue", change: (s) => { delete s.rpc.model!.list; }, disabled: { models: false } },
    { name: "empty catalogue", change: (s) => { s.rpc.model!.list = async () => ({ list: [] }); }, disabled: { models: false } },
    { name: "incomplete model entry", change: (s) => { s.rpc.model!.list = async () => ({ list: [{ name: "No identifier" }] }); },
      disabled: { models: false } },
    { name: "unknown reasoning shape", change: (s) => { s.rpc.model!.list = async () => ({ list: [{ id: "test-model", supportedReasoningEfforts: ["low", 1] }] }); },
      disabled: { models: false } },
    { name: "catalogue error", change: (s) => { s.rpc.model!.list = async () => { throw new Error("PRIVATE_RPC_DETAIL"); }; },
      disabled: { models: false } },
    { name: "missing model mutation", change: (s) => { delete s.rpc.model!.switchTo; }, disabled: { models: false } },
    { name: "unsupported display-only metadata", change: (s) => {
      s.rpc.name!.get = async () => ({ name: 123 });
      s.rpc.permissions!.getMode = async () => ({ mode: false });
    }, disabled: {} },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const f = await capabilityFixture(t);
      scenario.change(f.session);
      const summary = await f.runtime.connect();
      assert.deepEqual(summary.capabilities, { ...allCapabilities, ...scenario.disabled });
      assert.ok(summary.warnings.length > 2);
      assert.ok(!JSON.stringify(summary).includes("PRIVATE_RPC_DETAIL"));
      if (scenario.disabled.permissions === false) {
        const pending = f.events.filter((event) => event.kind === "requests").at(-1);
        assert.ok(pending?.data.items.every((item) => !item.supported));
      }
      for (const [capability, action] of capabilityActions) {
        if (scenario.disabled[capability] === false)
          await assert.rejects(f.runtime.execute(action), { code: "UNSUPPORTED" }, action.type);
      }
    });
  }
});

test("additive read-only probe metadata is tolerated but never exported", async (t) => {
  const f = await capabilityFixture(t, "future-build");
  const extra = { privateInternalField: "PRIVATE_API_METADATA" };
  f.session.rpc.metadata!.activity = async () => ({ hasActiveWork: false, abortable: false, ...extra });
  f.session.rpc.permissions!.paths!.list = async () => ({ primary: f.root, ...extra });
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [], ...extra });
  f.session.rpc.model!.getCurrent = async () => ({ modelId: "test-model", ...extra });
  f.session.rpc.model!.list = async () => ({ list: [{ id: "test-model", ...extra }], ...extra });
  const summary = await f.runtime.connect();
  assert.deepEqual(summary.capabilities, allCapabilities);
  const models = await f.runtime.execute({ type: "models" });
  assert.ok(!JSON.stringify({ summary, models, events: f.events }).includes("PRIVATE_API_METADATA"));
});

test("missing messaging does not block independently supported runtime operations", async (t) => {
  const f = await capabilityFixture(t, "unlisted-build");
  delete f.session.send;
  await f.runtime.connect();
  await assert.rejects(f.runtime.execute({ type: "message", text: "Unavailable", attachmentIds: [] }), { code: "UNSUPPORTED" });
  assert.equal((await f.runtime.execute({ type: "models" })).status, "completed");
  assert.equal((await f.runtime.execute({ type: "model.set", modelId: "test-model", reasoningEffort: "low" })).status, "completed");
  assert.equal((await f.runtime.execute({ type: "files.list", path: "" })).status, "completed");
  assert.equal((await f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "reject" })).status, "completed");
  f.emit("user_input.requested", { requestId: "question", question: "Continue?", choices: ["Yes", "No"], allowFreeform: false });
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "question", answer: "No" })).status, "completed");
  assert.equal((await f.runtime.execute({ type: "abort" })).status, "cancel_requested");
  f.session.rpc.metadata!.activity = async () => undefined;
  assert.equal((await f.runtime.refresh()).state, "cancel_requested");
});

test("file capability needs an explicit complete allow decision for the live directory", async (t) => {
  const cases: [string, (root: string) => unknown][] = [
    ["unavailable", (root) => ({ available: false, checks: [{ path: root, excluded: false }] })],
    ["missing checks", () => ({ available: true })],
    ["empty checks", () => ({ available: true, checks: [] })],
    ["mismatched path", (root) => ({ available: true, checks: [{ path: path.join(root, "other"), excluded: false }] })],
    ["incomplete check", (root) => ({ available: true, checks: [{ path: root }] })],
    ["nonboolean decision", (root) => ({ available: true, checks: [{ path: root, excluded: "false" }] })],
    ["duplicate checks", (root) => ({ available: true, checks: [{ path: root, excluded: false }, { path: root, excluded: false }] })],
    ["excluded directory", (root) => ({ available: true, checks: [{ path: root, excluded: true }] })],
  ];
  for (const [name, response] of cases) {
    await t.test(name, async (t) => {
      const f = await capabilityFixture(t);
      f.session.rpc.contentExclusion!.checkPaths = async () => response(f.root);
      const summary = await f.runtime.connect();
      assert.deepEqual(summary.capabilities, { ...allCapabilities, files: false, git: false });
      await assert.rejects(f.runtime.execute({ type: "files.list", path: "" }), { code: "UNSUPPORTED" });
      await assert.rejects(f.runtime.execute({ type: "git.status" }), { code: "UNSUPPORTED" });
    });
  }
});

test("execution refreshes stale grants and request projections recover without stale warnings", async (t) => {
  const f = await capabilityFixture(t), permissions = f.session.rpc.permissions!, activity = f.session.rpc.metadata!;
  const pending = permissions.pendingRequests, active = activity.activity;
  let decisions = 0;
  permissions.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  await f.runtime.connect();
  f.emit("user_input.requested", { requestId: "live-question", question: "Choose", choices: ["One", "Two"] });
  permissions.pendingRequests = async () => ({ items: "unknown" });
  activity.activity = async () => { throw new Error("PRIVATE_RUNTIME_ERROR"); };
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "UNSUPPORTED" });
  assert.equal(decisions, 0);
  const result = await f.runtime.execute({ type: "refresh" });
  assert.ok(PendingRequest.array().parse(result.result?.requests).every((item) => !item.supported));
  assert.ok(!JSON.stringify(f.runtime.summary).includes("PRIVATE_RUNTIME_ERROR"));
  assert.equal(f.runtime.summary.capabilities.models, true);
  assert.equal(f.runtime.summary.capabilities.files, true);
  permissions.pendingRequests = pending;
  activity.activity = active;
  const summary = await f.runtime.refresh();
  assert.deepEqual(summary.capabilities, allCapabilities);
  assert.ok(!summary.warnings.some((warning) => /probe failed|unsupported response shape/.test(warning)));
  assert.ok(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.every((item) => item.supported));
});

test("a stalled optional probe times out without granting support from its late response", async (t) => {
  const f = await capabilityFixture(t);
  let started!: () => void, finish!: (response: unknown) => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const response = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.model!.list = () => { started(); return response; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const connecting = f.runtime.connect();
  await reading;
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5000);
  const summary = await connecting;
  assert.deepEqual(summary.capabilities, { ...allCapabilities, models: false });
  assert.ok(summary.warnings.some((warning) => warning === "Model catalogue probe timed out; use the terminal."));
  finish({ list: [{ id: "test-model" }] });
  await Promise.resolve();
  assert.equal(f.runtime.summary.capabilities.models, false);
  const recovered = await f.runtime.refresh();
  assert.equal(recovered.capabilities.models, true);
  assert.ok(!recovered.warnings.some((warning) => warning.includes("timed out")));
});

test("request controls require the matching handler, not another question dialect", async (t) => {
  const f = await capabilityFixture(t);
  f.session.rpc.ui = { handlePendingElicitation: async () => ({ success: true }) };
  await f.runtime.connect();
  assert.equal(f.runtime.summary.capabilities.questions, true);
  f.emit("user_input.requested", { requestId: "native", question: "Choose", choices: ["One", "Two"] });
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "native");
  assert.equal(request?.supported, false);
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "native", answer: "One" }), { code: "TERMINAL_REQUIRED" });
});

test("incomplete known permission and question forms cannot be approved on unfamiliar runtimes", async (t) => {
  const f = await capabilityFixture(t, "future-build");
  let decisions = 0;
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [
    { requestId: "incomplete", request: { kind: "commands", toolName: "powershell" } },
    { requestId: "unknown-flag", request: { kind: "commands", fullCommandText: "echo safe", requestSandboxBypass: "true" } },
  ] });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  f.session.rpc.ui = {
    handlePendingUserInput: async () => { decisions++; return { success: true }; },
    handlePendingElicitation: async () => { decisions++; return { success: true }; },
  };
  await f.runtime.connect();
  for (const requestId of ["incomplete", "unknown-flag"])
    await assert.rejects(f.runtime.execute({ type: "permission", requestId, decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
  const questions = [
    { requestId: "no-question", choices: ["Yes"] },
    { requestId: "bad-choices", question: "Choose", choices: "Yes" },
    { requestId: "bad-freeform", question: "Choose", choices: ["Yes"], allowFreeform: "false" },
    { requestId: "no-answer-form", question: "Choose", choices: [], allowFreeform: false },
  ];
  for (const question of questions) {
    f.emit("user_input.requested", question);
    await assert.rejects(f.runtime.execute({ type: "answer", requestId: question.requestId, answer: "Yes" }), { code: "TERMINAL_REQUIRED" });
  }
  const schemas = [
    { properties: { choice: { type: "string" } } },
    { type: "object", properties: { choice: { type: "string", enum: ["Yes", 1] } } },
    { type: "object", properties: { choice: { type: "string" } }, required: "choice" },
    { type: "object", properties: { choice: { type: "string", pattern: "^Yes$" } } },
    { type: "object", properties: { choice: { type: "string" }, other: { type: "string", format: "uri" } } },
  ];
  for (const [index, requestedSchema] of schemas.entries()) {
    const requestId = `form-${index}`;
    f.emit("elicitation.requested", { requestId, message: "Choose", requestedSchema });
    await assert.rejects(f.runtime.execute({ type: "answer", requestId, answer: "Yes" }), { code: "TERMINAL_REQUIRED" });
  }
  assert.equal(decisions, 0);
  assert.ok(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.every((item) => !item.supported));
});

test("simple elicitation forms enforce the actual primary and alternate string limits", async (t) => {
  const f = await capabilityFixture(t), answered: unknown[] = [];
  f.session.rpc.ui = { handlePendingElicitation: async (input) => { answered.push(input); return { success: true }; } };
  await f.runtime.connect();
  f.emit("elicitation.requested", { requestId: "short-form", message: "Enter a label", requestedSchema: {
    type: "object", properties: { label: { type: "string", minLength: 3, maxLength: 5 } }, required: ["label"],
  } });
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "short-form", answer: "a" }), { code: "INVALID_ANSWER" });
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "short-form", answer: "abcdef" }), { code: "INVALID_ANSWER" });
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "short-form", answer: "abc" })).status, "completed");
  f.emit("elicitation.requested", { requestId: "other-form", message: "Choose or write", requestedSchema: {
    type: "object", properties: {
      choice: { type: "string", enum: ["One", "Other"] },
      detail: { type: "string", minLength: 2, maxLength: 4 },
    }, required: ["choice"],
  } });
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "other-form", answer: "too long" }), { code: "INVALID_ANSWER" });
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "other-form", answer: "Two" })).status, "completed");
  assert.deepEqual(answered, [
    { requestId: "short-form", result: { action: "accept", content: { label: "abc" } } },
    { requestId: "other-form", result: { action: "accept", content: { choice: "Other", detail: "Two" } } },
  ]);
});

test("malformed optional queue evidence cannot claim that a message is queued or cancelled", async (t) => {
  const f = await capabilityFixture(t);
  f.session.rpc.queue = { pendingItems: async () => ({ items: [{ messageId: "runtime-user-id" }, { messageId: 42 }] }) };
  await f.runtime.connect();
  assert.equal((await f.runtime.execute({ type: "message", text: "Do not infer queue state", attachmentIds: [] })).status, "admitted");
  const stop = await f.runtime.execute({ type: "abort" });
  assert.equal(stop.status, "cancel_requested");
  assert.deepEqual(stop.result?.cancelledMessageIds, []);
});
