import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { CopilotRuntime, type JoinedSession } from "../src/runtime.js";
import { Action, PendingRequest, SessionSummary, UserEvent } from "../src/protocol.js";

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
  const invalidLength = { code: "INVALID_ANSWER", message: "The answer is outside this form's supported length range." };
  await f.runtime.connect();
  f.emit("elicitation.requested", { requestId: "short-form", message: "Enter a label", requestedSchema: {
    type: "object", properties: { label: { type: "string", minLength: 3, maxLength: 5 } }, required: ["label"],
  } });
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "short-form", answer: "a" }), invalidLength);
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "short-form", answer: "abcdef" }), invalidLength);
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "short-form", answer: "abc" })).status, "completed");
  f.emit("elicitation.requested", { requestId: "other-form", message: "Choose or write", requestedSchema: {
    type: "object", properties: {
      choice: { type: "string", enum: ["One", "Other"] },
      detail: { type: "string", minLength: 2, maxLength: 4 },
    }, required: ["choice"],
  } });
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "other-form", answer: "a" }), invalidLength);
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "other-form", answer: "too long" }), invalidLength);
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "other-form", answer: "Two" })).status, "completed");
  assert.deepEqual(answered, [
    { requestId: "short-form", result: { action: "accept", content: { label: "abc" } } },
    { requestId: "other-form", result: { action: "accept", content: { choice: "Other", detail: "Two" } } },
  ]);
});

test("unknown top-level question fields keep the request in the original client", async (t) => {
  const f = await capabilityFixture(t, "future-build");
  let answers = 0;
  f.session.rpc.ui = { handlePendingUserInput: async () => { answers++; return { success: true }; } };
  await f.runtime.connect();
  f.emit("user_input.requested", {
    requestId: "future-question", question: "Choose", choices: ["Yes", "No"], answerMode: "multiple",
  });
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "future-question");
  assert.equal(request?.type, "terminal");
  assert.equal(request.supported, false);
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "future-question", answer: "Yes" }), { code: "TERMINAL_REQUIRED" });
  assert.equal(answers, 0);
});

test("unknown top-level elicitation fields keep the form in the original client", async (t) => {
  const f = await capabilityFixture(t, "future-build");
  let answers = 0;
  f.session.rpc.ui = { handlePendingElicitation: async () => { answers++; return { success: true }; } };
  await f.runtime.connect();
  f.emit("elicitation.requested", {
    requestId: "future-form", message: "Choose", mode: "form", responsePolicy: { confirmationRequired: true },
    requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["Yes", "No"] } }, required: ["choice"] },
  });
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "future-form");
  assert.equal(request?.type, "terminal");
  assert.equal(request.supported, false);
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "future-form", answer: "Yes" }), { code: "TERMINAL_REQUIRED" });
  assert.equal(answers, 0);
});

test("supported question envelopes preserve their semantics without exporting correlation metadata", async (t) => {
  const f = await capabilityFixture(t), answers: unknown[] = [];
  f.session.rpc.ui = {
    handlePendingUserInput: async (input) => { answers.push(input); return { success: true }; },
    handlePendingElicitation: async (input) => { answers.push(input); return { success: true }; },
  };
  await f.runtime.connect();
  const requestedSchema = { type: "object", properties: { label: { type: "string", description: "A short label" } }, required: ["label"] };
  const requests = [
    { type: "user_input.requested", data: {
      requestId: "choice", question: "Choose", choices: ["Yes", "No"], allowFreeform: false, toolCallId: "PRIVATE_CORRELATION",
    }, detail: "Choose", answer: "Yes" },
    { type: "user_input.requested", data: {
      requestId: "freeform", question: "Enter a label", toolCallId: "PRIVATE_CORRELATION",
    }, detail: "Enter a label", answer: "Test" },
    { type: "elicitation.requested", data: {
      requestId: "form", message: "Enter a label", mode: "form", requestedSchema,
      toolCallId: "PRIVATE_CORRELATION", elicitationSource: "Example MCP",
    }, detail: "Source: Example MCP\nEnter a label\nA short label", answer: "Test" },
    { type: "elicitation.requested", data: {
      requestId: "legacy-form", message: "Enter a label", requestedSchema,
    }, detail: "Enter a label\nA short label", answer: "Legacy" },
  ];
  for (const request of requests) {
    f.emit(request.type, request.data);
    const item = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === request.data.requestId);
    assert.equal(item?.supported, true);
    assert.equal(item.detail, request.detail);
    assert.equal((await f.runtime.execute({ type: "answer", requestId: request.data.requestId, answer: request.answer })).status, "completed");
  }
  assert.deepEqual(answers, [
    { requestId: "choice", response: { answer: "Yes", wasFreeform: false } },
    { requestId: "freeform", response: { answer: "Test", wasFreeform: true } },
    { requestId: "form", result: { action: "accept", content: { label: "Test" } } },
    { requestId: "legacy-form", result: { action: "accept", content: { label: "Legacy" } } },
  ]);
  assert.ok(!JSON.stringify(f.events).includes("PRIVATE_CORRELATION"));
  UserEvent.array().parse(f.events);
});

test("question envelopes reject malformed metadata and unsupported response modes", async (t) => {
  const f = await capabilityFixture(t);
  let answers = 0;
  f.session.rpc.ui = {
    handlePendingUserInput: async () => { answers++; return { success: true }; },
    handlePendingElicitation: async () => { answers++; return { success: true }; },
  };
  await f.runtime.connect();
  const invalidMetadata = [
    { toolCallId: 42 }, { toolCallId: "" }, { toolCallId: "x".repeat(201) },
    { correlation: { toolCallId: "PRIVATE_CORRELATION" } },
    { responsePolicy: { mode: "PRIVATE_UNKNOWN_MODE" } },
  ];
  for (const type of ["user_input.requested", "elicitation.requested"]) {
    const envelope = type === "user_input.requested" ? { question: "Choose", choices: ["Yes", "No"] } : {
      message: "Choose", requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["Yes", "No"] } } },
    };
    const invalid: object[] = type === "user_input.requested" ? invalidMetadata : [
      ...invalidMetadata, { elicitationSource: 42 }, { elicitationSource: "" },
      { mode: "url", url: "https://example.test" }, { mode: "new-form" }, { mode: "form", url: "https://example.test" },
    ];
    for (const [index, extra] of invalid.entries()) {
      const requestId = `${type}-${index}`;
      f.emit(type, { ...envelope, requestId, ...extra });
      const item = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === requestId);
      assert.equal(item?.type, "terminal");
      assert.equal(item.supported, false);
      await assert.rejects(f.runtime.execute({ type: "answer", requestId, answer: "Yes" }), { code: "TERMINAL_REQUIRED" });
    }
  }
  assert.equal(answers, 0);
  assert.ok(!JSON.stringify(f.events).includes("PRIVATE_"));
  UserEvent.array().parse(f.events);
});

test("question envelopes with invalid request identities never enter projected pending state", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  for (const type of ["user_input.requested", "elicitation.requested"]) {
    const envelope = type === "user_input.requested" ? { question: "Choose", choices: ["Yes", "No"] } : {
      message: "Choose", requestedSchema: { type: "object", properties: { choice: { type: "string" } } },
    };
    for (const requestId of [undefined, null, "", 42, "x".repeat(201)]) {
      const before = f.events.length;
      f.emit(type, { ...envelope, ...(requestId !== undefined ? { requestId } : {}) });
      assert.deepEqual(f.events.slice(before).map((event) => event.kind), ["notice"]);
      const notice = f.events.at(-1);
      assert.equal(notice?.kind === "notice" && notice.data.code, "EVENT_UNSUPPORTED");
    }
  }
  const refresh = await f.runtime.execute({ type: "refresh" });
  const requests = PendingRequest.array().parse(refresh.result?.requests);
  assert.ok(requests.every((request) => request.type === "permission"));
  UserEvent.array().parse(f.events);
});

test("unsupported replacement envelopes revoke cached form routing", async (t) => {
  const f = await capabilityFixture(t), answers: unknown[] = [];
  f.session.rpc.ui = {
    handlePendingUserInput: async (input) => { answers.push(input); return { success: true }; },
    handlePendingElicitation: async (input) => { answers.push(input); return { success: true }; },
  };
  await f.runtime.connect();
  const form = {
    requestId: "reused", message: "Choose",
    requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["Yes", "No"] } } },
  };
  f.emit("elicitation.requested", form);
  f.emit("elicitation.requested", { ...form, responsePolicy: { confirmationRequired: true } });
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "reused", answer: "Yes" }), { code: "TERMINAL_REQUIRED" });
  assert.deepEqual(answers, []);
  f.emit("user_input.requested", { requestId: "reused", question: "Choose", choices: ["Yes", "No"] });
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "reused", answer: "Yes" })).status, "completed");
  assert.deepEqual(answers, [{ requestId: "reused", response: { answer: "Yes", wasFreeform: false } }]);
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

test("unknown semantic fields in a known permission form require the terminal", async (t) => {
  const f = await capabilityFixture(t, "future-build");
  let decisions = 0;
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [{
    requestId: "future-permission",
    request: { kind: "commands", fullCommandText: "echo harmless", executionScope: "all-sessions" },
  }] });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  await f.runtime.connect();
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items[0];
  assert.equal(request?.supported, false);
  await assert.rejects(f.runtime.execute({
    type: "permission", requestId: "future-permission", decision: "approve-once",
  }), { code: "TERMINAL_REQUIRED" });
  assert.equal(decisions, 0);
});

test("sending does not wait for an unrelated stalled model catalogue", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  let finish!: (value: unknown) => void;
  const catalogue = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.model!.list = () => catalogue;
  let completed = false;
  const command = f.runtime.execute({ type: "message", text: "Continue without model discovery", attachmentIds: [] })
    .then((receipt) => { completed = true; return receipt; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const completedBeforeCatalogue = completed;
  finish({ list: [{ id: "test-model" }] });
  assert.equal((await command).status, "admitted");
  assert.equal(completedBeforeCatalogue, true, "Sending must not wait for an unrelated capability probe.");
});

test("supported permission dialects expose every semantic field and reject unknown ones", async (t) => {
  const forms = [
    {
      kind: "shell", fullCommandText: "echo harmless", intention: "Display output", canOfferSessionApproval: true,
      commands: [{ identifier: "echo", readOnly: true }], commandSegments: [{ identifier: "echo", fullCommandText: "echo harmless" }],
      hasWriteFileRedirection: false, possiblePaths: ["example.txt"], possibleUrls: [{ url: "https://example.test" }],
      resolvedPaths: { "example.txt": "PRIVATE_CANONICAL_PATH" }, resolvedWorkingDirectory: "PRIVATE_CANONICAL_DIRECTORY",
    },
    {
      kind: "commands", fullCommandText: "echo harmless", commandIdentifiers: ["echo"],
      canOfferSessionApproval: false, warning: "Review the command", managedApprovalRequired: true,
    },
    { kind: "read", path: "example.txt", intention: "Read a file", resolvedPath: "PRIVATE_CANONICAL_PATH" },
    { kind: "write", fileName: "example.txt", diff: "-old\n+new", newFileContents: "new", canOfferSessionApproval: false },
    { kind: "url", url: "https://example.test/final", redirectedFrom: "https://example.test/start", intention: "Read a page" },
    {
      kind: "mcp", serverName: "example", toolName: "lookup", toolTitle: "Look up an item", readOnly: true,
      canOfferServerWideApproval: false, args: { query: "example", nested: { executionScope: "visible tool argument" } },
    },
    { kind: "custom-tool", toolName: "example", toolDescription: "A custom tool", skipPermission: false, args: { mode: "preview" } },
    { kind: "shell", args: { command: "echo legacy" } },
    { kind: "read", arguments: { path: "example.txt" } },
    { kind: "write", args: { path: "example.txt" }, newFileContents: "new" },
    { kind: "url", arguments: { url: "https://example.test" } },
    { kind: "mcp", mcpServerName: "example", toolName: "lookup", arguments: { query: "example" } },
    { kind: "custom-tool", toolName: "example", arguments: { mode: "preview" } },
  ];
  for (const [index, form] of forms.entries()) {
    await t.test(`${form.kind}-${index}`, async (t) => {
      const f = await capabilityFixture(t, "future-build"), requestId = `known-${index}`;
      const request = { ...form, toolCallId: "PRIVATE_CORRELATION_ID" };
      let current: Record<string, unknown> = request;
      let decisions = 0;
      f.session.rpc.permissions!.pendingRequests = async () => ({
        items: [{ requestId, request: current, recoveryEpisodeId: "PRIVATE_RECOVERY_ID" }],
      });
      f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
      await f.runtime.connect();
      const item = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === requestId);
      assert.equal(item?.supported, true);
      const visible = Object.fromEntries(Object.entries(request).filter(([key]) =>
        !["toolCallId", "resolvedPath", "resolvedPaths", "resolvedWorkingDirectory"].includes(key)));
      assert.deepEqual(JSON.parse(item.detail), visible);
      assert.ok(!JSON.stringify(item).includes("PRIVATE_"));
      assert.equal((await f.runtime.execute({ type: "permission", requestId, decision: "reject" })).status, "completed");
      assert.equal(decisions, 1);

      current = { ...request, executionScope: "all-sessions" };
      await f.runtime.refresh();
      f.emit("permission.requested", { requestId: `live-${index}`, permissionRequest: current });
      const projected = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items;
      assert.ok(projected?.every((item) => item.type === "terminal" && !item.supported));
      assert.ok(!JSON.stringify(projected).includes("all-sessions"));
      await assert.rejects(f.runtime.execute({ type: "permission", requestId, decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
      assert.equal(decisions, 1);
    });
  }
});

test("permission schemas reject malformed or unknown nested semantic fields", async (t) => {
  const requests = [
    { kind: "shell", fullCommandText: "echo safe", commands: [{ identifier: "echo", readOnly: true, elevated: true }] },
    { kind: "shell", fullCommandText: "echo safe", commandSegments: [{ identifier: "echo", fullCommandText: "echo safe", elevated: true }] },
    { kind: "shell", fullCommandText: "echo safe", possibleUrls: [{ url: "https://example.test", trustRedirects: true }] },
    { kind: "shell", args: { command: "echo safe", runAs: "administrator" } },
    { kind: "read", args: { path: "example.txt", recursive: true } },
    { kind: "write", args: { path: "example.txt", recursive: true }, diff: "+new" },
    { kind: "url", args: { url: "https://example.test", trustRedirects: true } },
    { kind: "mcp", serverName: "example", toolName: "lookup", args: {}, readOnly: "true" },
    { kind: "custom-tool", toolName: "lookup", args: {}, skipPermission: "true" },
    { kind: "commands", fullCommandText: "echo safe", commandIdentifiers: [42] },
    { kind: "read", path: "example.txt", resolvedPath: { unknownIdentity: true } },
    { kind: "commands", fullCommandText: "echo safe", assistedApproval: { approval: "skip-confirmation" } },
    { kind: "shell", fullCommandText: "echo safe", requestSandboxBypass: true },
    { kind: "commands", fullCommandText: "echo safe", requestSandboxPermissive: true },
    { kind: "write", path: "example.txt", diff: "[REDACTED]" },
  ];
  const f = await capabilityFixture(t);
  let decisions = 0;
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: requests.map((request, index) => ({ requestId: `invalid-${index}`, request })) });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  await f.runtime.connect();
  for (const index of requests.keys())
    await assert.rejects(f.runtime.execute({ type: "permission", requestId: `invalid-${index}`, decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
  assert.equal(decisions, 0);
  assert.ok(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.every((item) => !item.supported));
});

test("each command refreshes only its prerequisite evidence", async (t) => {
  const cases: { action: Action; reads: string[]; error?: string }[] = [
    { action: { type: "message", text: "Only activity", attachmentIds: [] }, reads: ["activity", "queue"] },
    { action: { type: "abort" }, reads: ["activity", "queue"] },
    { action: { type: "permission", requestId: "approval-1", decision: "reject" }, reads: ["permissions"] },
    { action: { type: "answer", requestId: "question", answer: "Yes" }, reads: ["activity"] },
    { action: { type: "models" }, reads: ["current-model", "catalogue"] },
    { action: { type: "model.set", modelId: "test-model" }, reads: ["current-model", "catalogue", "current-model", "catalogue"] },
    { action: { type: "files.list", path: "" }, reads: ["directory", "policy", "policy"] },
    { action: { type: "files.read", path: "..\\outside.txt" }, reads: ["directory", "policy"], error: "INVALID_PATH" },
    { action: { type: "git.status" }, reads: ["directory", "policy", "policy"] },
    { action: { type: "git.diff", path: "..\\outside.txt", staged: false }, reads: ["directory", "policy"], error: "INVALID_PATH" },
  ];
  for (const scenario of cases) {
    await t.test(scenario.action.type, async (t) => {
      const f = await capabilityFixture(t);
      await f.runtime.connect();
      f.emit("user_input.requested", { requestId: "question", question: "Continue?", choices: ["Yes", "No"] });
      const reads: string[] = [], rpc = f.session.rpc;
      const tracked = (name: string, read: () => Promise<unknown>) => async () => { reads.push(name); return await read(); };
      rpc.metadata!.activity = tracked("activity", rpc.metadata!.activity!);
      rpc.permissions!.pendingRequests = tracked("permissions", rpc.permissions!.pendingRequests!);
      rpc.permissions!.getMode = tracked("permission-mode", rpc.permissions!.getMode!);
      rpc.permissions!.paths!.list = tracked("directory", rpc.permissions!.paths!.list!);
      rpc.model!.getCurrent = tracked("current-model", rpc.model!.getCurrent!);
      rpc.model!.list = tracked("catalogue", rpc.model!.list!);
      rpc.name!.get = tracked("name", rpc.name!.get!);
      rpc.queue = { pendingItems: tracked("queue", async () => ({ items: [] })) };
      const policy = rpc.contentExclusion!.checkPaths!;
      rpc.contentExclusion!.checkPaths = async (input) => { reads.push("policy"); return await policy(input); };
      if (scenario.error) await assert.rejects(f.runtime.execute(scenario.action), { code: scenario.error });
      else await f.runtime.execute(scenario.action);
      assert.deepEqual(reads, scenario.reads);
    });
  }
});

test("messages and answers do not wait for unrelated probes in an ongoing full refresh", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  f.emit("user_input.requested", { requestId: "question", question: "Continue?", choices: ["Yes", "No"] });
  const rpc = f.session.rpc;
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  const block = (read: () => Promise<unknown>) => async () => { await stalled; return await read(); };
  rpc.model!.list = block(rpc.model!.list!);
  rpc.permissions!.pendingRequests = block(rpc.permissions!.pendingRequests!);
  rpc.name!.get = block(rpc.name!.get!);
  const policy = rpc.contentExclusion!.checkPaths!;
  rpc.contentExclusion!.checkPaths = async (input) => { await stalled; return await policy(input); };
  const refresh = f.runtime.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  let completed = 0;
  const commands = Promise.all([
    f.runtime.execute({ type: "message", text: "No unrelated waits", attachmentIds: [] }),
    f.runtime.execute({ type: "answer", requestId: "question", answer: "Yes" }),
  ].map((command) => command.then((receipt) => { completed++; return receipt; })));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const completedBeforeRelease = completed;
  release();
  await commands;
  await refresh;
  assert.equal(completedBeforeRelease, 2);
});

test("a late unrelated refresh cannot restore a capability rejected by a newer action probe", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  let finish!: (value: unknown) => void, sends = 0;
  const catalogue = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.model!.list = () => catalogue;
  f.session.send = async () => { sends++; return "must-not-send"; };
  const refresh = f.runtime.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.session.rpc.metadata!.activity = async () => ({ hasActiveWork: "unknown" });
  let rejected = false;
  const command = assert.rejects(
    f.runtime.execute({ type: "message", text: "Do not trust old activity", attachmentIds: [] }),
    { code: "UNSUPPORTED" },
  ).then(() => { rejected = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rejectedBeforeCatalogue = rejected;
  finish({ list: [{ id: "test-model" }] });
  await command;
  await refresh;
  assert.equal(rejectedBeforeCatalogue, true);
  assert.equal(sends, 0);
  assert.equal(f.runtime.summary.capabilities.messages, false);
  assert.equal(f.runtime.summary.capabilities.models, true);
  assert.ok(f.runtime.summary.warnings.some((warning) => warning.includes("Runtime activity returned an unsupported response shape")));
});

test("overlapping activity consumers share only the required in-flight probe", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  let finish!: (value: unknown) => void, reads = 0, sends = 0;
  const activity = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.metadata!.activity = () => { reads++; return activity; };
  f.session.send = async () => { sends++; return "must-not-send"; };
  const refresh = f.runtime.refresh();
  const command = assert.rejects(f.runtime.execute({
    type: "message", text: "Await required evidence", attachmentIds: [],
  }), { code: "UNSUPPORTED" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(sends, 0);
  finish({});
  await command;
  await refresh;
  assert.equal(f.runtime.summary.capabilities.messages, false);
  assert.equal(sends, 0);
});

test("unknown live permission envelope semantics cannot be approved after a snapshot refresh", async (t) => {
  const f = await capabilityFixture(t, "future-build");
  let decisions = 0;
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  await f.runtime.connect();
  f.emit("permission.requested", {
    requestId: "approval-1", executionScope: "PRIVATE_FUTURE_SCOPE",
    permissionRequest: { kind: "commands", fullCommandText: "echo harmless" },
  });
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "approval-1");
  assert.equal(request?.supported, false);
  assert.ok(!JSON.stringify(request).includes("PRIVATE_FUTURE_SCOPE"));
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
  assert.equal(decisions, 0);
});

test("competing live permission payload aliases are not selected by precedence", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  f.emit("permission.requested", {
    requestId: "approval-1",
    permissionRequest: { kind: "commands", fullCommandText: "echo safe" },
    request: { kind: "commands", fullCommandText: "echo different" },
  });
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "approval-1");
  assert.equal(request?.supported, false);
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
});

test("elicitation form limits count Unicode code points rather than UTF-16 units", async (t) => {
  const f = await capabilityFixture(t), answers: unknown[] = [];
  f.session.rpc.ui = { handlePendingElicitation: async (input) => { answers.push(input); return { success: true }; } };
  await f.runtime.connect();
  f.emit("elicitation.requested", {
    requestId: "single-character", message: "Enter one character",
    requestedSchema: { type: "object", properties: { label: { type: "string", minLength: 1, maxLength: 1 } }, required: ["label"] },
  });
  const answer = "\u{1F600}";
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "single-character", answer })).status, "completed");
  assert.deepEqual(answers, [{ requestId: "single-character", result: { action: "accept", content: { label: answer } } }]);
});

test("documented paired live permission payloads preserve all approval evidence through refresh", async (t) => {
  const forms: { original: Record<string, unknown>; prompt: Record<string, unknown> }[] = [
    {
      original: { kind: "shell", fullCommandText: "echo safe", commands: [{ identifier: "echo", readOnly: true }],
        possiblePaths: ["example.txt"], possibleUrls: [{ url: "https://example.test" }], hasWriteFileRedirection: false },
      prompt: { kind: "commands", fullCommandText: "echo safe", commandIdentifiers: ["echo"], warning: "Review the command" },
    },
    { original: { kind: "read", path: "example.txt" }, prompt: { kind: "read", path: "example.txt" } },
    {
      original: { kind: "write", fileName: "example.txt", diff: "-old\n+new", newFileContents: "new" },
      prompt: { kind: "write", fileName: "example.txt", diff: "-old\n+new", newFileContents: "new" },
    },
    { original: { kind: "url", url: "https://example.test" }, prompt: { kind: "url", url: "https://example.test" } },
    {
      original: { kind: "mcp", serverName: "example", toolName: "lookup", args: { first: "one", second: "two" }, readOnly: true },
      prompt: { kind: "mcp", serverName: "example", toolName: "lookup", args: { second: "two", first: "one" }, canOfferServerWideApproval: false },
    },
    { original: { kind: "custom-tool", toolName: "example", args: {} }, prompt: { kind: "custom-tool", toolName: "example", args: {} } },
  ];
  for (const { original, prompt } of forms) {
    await t.test(String(original.kind), async (t) => {
      const f = await capabilityFixture(t);
      let decisions = 0;
      f.session.rpc.permissions!.pendingRequests = async () => ({ items: [{ requestId: "paired", request: prompt }] });
      f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
      await f.runtime.connect();
      f.emit("permission.requested", {
        requestId: "paired", permissionRequest: { ...original, toolCallId: "PRIVATE_CORRELATION" }, promptRequest: prompt,
        agentMode: "interactive", permissionMode: "manual", resolvedByHook: false, recoveryEpisodeId: "PRIVATE_RECOVERY",
      });
      await f.runtime.refresh();
      const item = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "paired");
      assert.equal(item?.supported, true);
      assert.ok(item.detail.includes("Agent mode: interactive"));
      assert.ok(item.detail.includes("Permission mode: manual"));
      const [originalDetails, promptDetails] = item.detail.split("\nPrompt details:\n");
      assert.deepEqual(JSON.parse(originalDetails!.split("\n").slice(2).join("\n")), original);
      assert.deepEqual(JSON.parse(promptDetails!), prompt);
      assert.ok(!JSON.stringify(item).includes("PRIVATE_"));
      assert.equal((await f.runtime.execute({ type: "permission", requestId: "paired", decision: "reject" })).status, "completed");
      assert.equal(decisions, 1);
      UserEvent.array().parse(f.events);
    });
  }
});

test("single-payload live permission dialects remain supported", async (t) => {
  const f = await capabilityFixture(t);
  const request = { kind: "read", path: "example.txt" };
  const requests = ["request", "permissionRequest", "promptRequest"].map((field) => ({ requestId: field, request }));
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: requests });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => ({ success: true });
  await f.runtime.connect();
  for (const { requestId } of requests) {
    f.emit("permission.requested", { requestId, [requestId]: request });
    assert.equal((await f.runtime.execute({ type: "permission", requestId, decision: "reject" })).status, "completed");
  }
});

test("unsupported live permission metadata and conflicting paired content stay terminal-only", async (t) => {
  const f = await capabilityFixture(t);
  const request = { kind: "commands", fullCommandText: "echo safe" };
  const invalid: Record<string, unknown>[] = [
    { permissionRequest: request, resolvedByHook: true },
    { permissionRequest: request, resolvedByHook: "false" },
    { permissionRequest: request, agentMode: "future-mode" },
    { permissionRequest: request, permissionMode: "future-policy" },
    { permissionRequest: request, recoveryEpisodeId: 42 },
    { permissionRequest: request, riskAssessment: { rawInternalState: "PRIVATE_RISK" } },
    { permissionRequest: request, request, promptRequest: request },
    { permissionRequest: { kind: "shell", fullCommandText: "echo original" }, promptRequest: request },
    { permissionRequest: { kind: "write", fileName: "original.txt", diff: "+one" },
      promptRequest: { kind: "write", fileName: "different.txt", diff: "+two" } },
    { permissionRequest: { kind: "mcp", serverName: "example", toolName: "read", args: {} },
      promptRequest: { kind: "mcp", serverName: "example", toolName: "write", args: {} } },
    { permissionRequest: { kind: "shell", fullCommandText: "echo safe", requestSandboxBypass: true }, promptRequest: request },
    { permissionRequest: request, promptRequest: { ...request, futureConstraint: true } },
    { permissionRequest: request, promptRequest: null },
    {},
  ];
  let decisions = 0;
  f.session.rpc.permissions!.pendingRequests = async () => ({
    items: invalid.map((_item, index) => ({ requestId: `invalid-${index}`, request })),
  });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  await f.runtime.connect();
  for (const [index, envelope] of invalid.entries()) {
    const requestId = `invalid-${index}`;
    f.emit("permission.requested", { requestId, ...envelope });
    await assert.rejects(f.runtime.execute({ type: "permission", requestId, decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
  }
  assert.equal(decisions, 0);
  const projected = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items;
  assert.ok(projected?.every((item) => !item.supported));
  assert.ok(!JSON.stringify(projected).includes("PRIVATE_RISK"));
  UserEvent.array().parse(f.events);
});

test("late permission snapshots do not erase live restrictions or change the approved subject", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  let finish!: (value: unknown) => void;
  const snapshot = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.permissions!.pendingRequests = () => snapshot;
  const refreshing = f.runtime.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.emit("permission.requested", {
    requestId: "approval-1", permissionRequest: { kind: "commands", fullCommandText: "echo safe" }, futureConstraint: true,
  });
  finish({ items: [{ requestId: "approval-1", request: { kind: "commands", fullCommandText: "echo safe" } }] });
  await refreshing;
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });

  f.emit("permission.completed", { requestId: "approval-1" });
  f.emit("permission.requested", {
    requestId: "approval-1", permissionRequest: { kind: "commands", fullCommandText: "echo changed" },
  });
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [] });
  f.emit("permission.completed", { requestId: "approval-1" });
  await f.runtime.refresh();
  assert.deepEqual(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items, []);
});

test("invalid live permission identifiers never poison projected request frames", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  for (const requestId of [undefined, null, "", 42, "x".repeat(201)]) {
    f.emit("permission.requested", { requestId, permissionRequest: { kind: "read", path: "example.txt" } });
    assert.equal(f.events.at(-1)?.kind, "notice");
  }
  UserEvent.array().parse(f.events);
});

test("unsupported historical permission envelopes stay unavailable after reattachment", async (t) => {
  const f = await capabilityFixture(t);
  const history = f.session.getEvents;
  f.session.getEvents = async () => [...await history(), {
    id: randomUUID(), timestamp: new Date().toISOString(), type: "permission.requested",
    data: { requestId: "approval-1", permissionRequest: { kind: "commands", fullCommandText: "echo safe" }, futureConstraint: true },
  }];
  await f.runtime.connect();
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
  assert.equal(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items[0]?.supported, false);
});

test("Unicode min and max constraints apply to primary and alternate answers without changing wire limits", async (t) => {
  const f = await capabilityFixture(t), answered: unknown[] = [];
  f.session.rpc.ui = { handlePendingElicitation: async (input) => { answered.push(input); return { success: true }; } };
  await f.runtime.connect();
  const emoji = "\u{1F600}";
  for (const alternate of [false, true]) {
    for (const length of [1, 2]) {
      const requestId = `${alternate ? "alternate" : "primary"}-${length}`;
      const field = { type: "string", minLength: length, maxLength: length };
      const properties = alternate
        ? { choice: { type: "string", enum: ["One", "Other"] }, answer: field }
        : { answer: field };
      f.emit("elicitation.requested", {
        requestId, message: "Enter characters",
        requestedSchema: { type: "object", properties, required: [alternate ? "choice" : "answer"] },
      });
      if (length === 2)
        await assert.rejects(f.runtime.execute({ type: "answer", requestId, answer: emoji }), { code: "INVALID_ANSWER" });
      await assert.rejects(f.runtime.execute({ type: "answer", requestId, answer: "e\u0301".repeat(length) }), { code: "INVALID_ANSWER" });
      const answer = emoji.repeat(length);
      assert.equal((await f.runtime.execute({ type: "answer", requestId, answer })).status, "completed");
      assert.deepEqual(answered.at(-1), {
        requestId, result: { action: "accept", content: alternate ? { choice: "Other", answer } : { answer } },
      });
    }
  }
  assert.equal(Action.safeParse({ type: "answer", requestId: "wire-limit", answer: emoji.repeat(4000) }).success, true);
  assert.equal(Action.safeParse({ type: "answer", requestId: "wire-limit", answer: emoji.repeat(4001) }).success, false);
});

test("known mutation result variants remain supported and unknown nested confirmations are rejected", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  f.session.rpc.model!.switchTo = async () => ({ modelId: "test-model", message: "Selected" });
  assert.equal((await f.runtime.execute({ type: "model.set", modelId: "test-model" })).status, "completed");
  f.session.rpc.model!.switchTo = async () => ({ deferred: true, message: "Queued" });
  assert.equal((await f.runtime.execute({ type: "model.set", modelId: "test-model" })).result?.deferred, true);
  const confirmation = { targetModelDisplayName: "Test", currentTokens: 100, targetLimit: 50 };
  f.session.rpc.model!.switchTo = async () => ({ confirmation });
  await assert.rejects(f.runtime.execute({ type: "model.set", modelId: "test-model" }), { code: "TERMINAL_REQUIRED" });
  for (const unknown of [false, {}, { ...confirmation, skipApproval: true }]) {
    f.session.rpc.model!.switchTo = async () => ({ modelId: "test-model", confirmation: unknown });
    await assert.rejects(f.runtime.execute({ type: "model.set", modelId: "test-model" }), { name: "ZodError" });
  }
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => ({ success: false });
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "REQUEST_STALE" });
});
