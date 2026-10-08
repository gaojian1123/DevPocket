import assert from "node:assert/strict";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { startBridge } from "../src/bridge.js";
import type { JoinedSession } from "../src/runtime.js";
import { Receipt, SessionSummary, type Action } from "../src/protocol.js";
import { fixture, newId, sessionPath } from "./harness.js";

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), message);
}

async function modelBridgeFixture(t: TestContext) {
  const transport: {
    socket?: WebSocket; bufferedBytes: number; greetings: number;
    acknowledged: Set<string>; onSummary: () => void;
  } = { bufferedBytes: 0, greetings: 0, acknowledged: new Set(), onSummary: () => {} };
  const originalSend = WebSocket.prototype.send;
  const bufferedAmount = Object.getOwnPropertyDescriptor(WebSocket.prototype, "bufferedAmount")!.get!;
  t.mock.getter(WebSocket.prototype, "bufferedAmount", function (this: WebSocket) {
    return this === transport.socket ? transport.bufferedBytes : bufferedAmount.call(this);
  });
  t.mock.method(WebSocket.prototype, "send", function (this: WebSocket, ...args: Parameters<typeof originalSend>) {
    if (typeof args[0] === "string") {
      const frame: { type: string } = JSON.parse(args[0]);
      if (frame.type === "hello") {
        transport.socket = this;
        transport.greetings++;
        this.on("message", (bytes) => {
          const incoming: { type: string; ids?: string[] } = JSON.parse(bytes.toString());
          if (incoming.type === "eventsAck") for (const id of incoming.ids ?? []) transport.acknowledged.add(id);
        });
      }
      if (this === transport.socket && frame.type === "summary") transport.onSummary();
    }
    return originalSend.apply(this, args);
  });
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  t.after(async () => { await bridge?.close(); });
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), sid = newId();
  let listener: (event: unknown) => void = () => {};
  const event = (type: string, data: object) => ({ id: newId(), timestamp: new Date().toISOString(), type, data });
  const session: JoinedSession = {
    sessionId: sid,
    getEvents: async () => [event("session.start", { context: { cwd: f.dataDir } })],
    on: (handler) => { listener = handler; return () => {}; },
    abort: async () => {},
    rpc: {
      metadata: { activity: async () => ({ hasActiveWork: false, abortable: false }) },
      permissions: { pendingRequests: async () => ({ items: [] }) },
      model: {
        getCurrent: async () => ({ modelId: "test-model", reasoningEffort: "high" }),
        list: async () => ({ list: [{ id: "test-model", supportedReasoningEfforts: ["low", "high"] }] }),
        switchTo: async () => ({ modelId: "test-model" }),
      },
    },
  };
  bridge = await startBridge(session, {
    hostId: host.hostId, token: host.token, relayUrl: f.url,
    dataDir: path.join(f.dataDir, "bridge"), allowInsecureLoopback: true,
  });
  await eventually(() => transport.acknowledged.size > 0, "Initial events must be acknowledged before exercising flush.");
  return {
    ...f, host, phone, sid, session, bridge, transport,
    emit: (type: string, data: object) => { const value = event(type, data); listener(value); return value.id; },
    command: async (action: Action) => {
      const route = sessionPath(host.hostId, sid) + "/commands", command = { commandId: newId(), action };
      await f.request(route, phone.token, command);
      let receipt: Receipt | undefined;
      for (let i = 0; i < 100; i++) {
        receipt = Receipt.parse(await (await f.request(`${route}/${command.commandId}`, phone.token)).json());
        if (receipt.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(receipt?.status, "completed");
      return receipt;
    },
    catalogSession: async () => {
      const catalog: { sessions: SessionSummary[] } = await (await f.request("/v1/catalog", phone.token)).json();
      return catalog.sessions.find((item) => item.sessionId === sid)!;
    },
  };
}

test("events resume without reconnecting after a summary crosses the socket backpressure threshold", async (t) => {
  const f = await modelBridgeFixture(t), limit = 2 * 1024 * 1024;
  let eventId = "", summarySent = false;
  f.session.rpc.model!.getCurrent = async () => {
    eventId = f.emit("session.idle", { aborted: true });
    return { modelId: "test-model", reasoningEffort: "high" };
  };
  f.transport.bufferedBytes = limit - 1;
  f.transport.onSummary = () => { f.transport.bufferedBytes = limit; summarySent = true; };
  const command = f.command({ type: "models" });
  await eventually(() => summarySent, "The summary must be sent before event delivery is blocked.");
  assert.ok(!f.transport.acknowledged.has(eventId), "An unsent event cannot have an acknowledgement.");
  f.transport.onSummary = () => {};
  f.transport.bufferedBytes = 0;
  await command;
  await eventually(() => f.transport.acknowledged.has(eventId), "Queued events must resume after backpressure clears.");
  const page = await (await f.request(sessionPath(f.host.hostId, f.sid) + "/events", f.phone.token)).json();
  assert.ok(page.events.some((item: { id: string; kind: string }) => item.id === eventId && item.kind === "runtime.state"));
  assert.equal(f.transport.greetings, 1, "Recovery must not require reconnecting the original runtime.");
});

test("model summaries preserve a live turn start already delivered and acknowledged", async (t) => {
  const f = await modelBridgeFixture(t);
  assert.equal((await f.catalogSession()).state, "idle");
  const eventId = f.emit("assistant.turn_start", {});
  await eventually(() => f.transport.acknowledged.has(eventId), "The live turn start must be acknowledged first.");
  assert.equal((await f.catalogSession()).state, "running");
  await f.command({ type: "models" });
  assert.equal((await f.catalogSession()).state, "running");
});

test("confirmed model switch updates the phone catalogue before its completed receipt", async (t) => {
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  t.after(async () => { await bridge?.close(); });
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), sid = newId();
  let current = { modelId: "old-model", reasoningEffort: "low" };
  let switches = 0;
  const session: JoinedSession = {
    sessionId: sid,
    getEvents: async () => [{
      id: newId(), timestamp: new Date().toISOString(), type: "session.start", data: { context: { cwd: f.dataDir } },
    }],
    on: () => () => {},
    rpc: {
      model: {
        getCurrent: async () => current,
        list: async () => ({ list: ["old-model", "new-model"].map((id) => ({
          id, supportedReasoningEfforts: ["low", "high"],
        })) }),
        switchTo: async (input) => {
          switches++;
          current = { modelId: input.modelId, reasoningEffort: input.reasoningEffort ?? "" };
          return { modelId: current.modelId };
        },
      },
    },
  };
  bridge = await startBridge(session, {
    hostId: host.hostId, token: host.token, relayUrl: f.url,
    dataDir: path.join(f.dataDir, "bridge"), allowInsecureLoopback: true,
  });
  const route = sessionPath(host.hostId, sid) + "/commands";
  const command = {
    commandId: newId(), action: { type: "model.set", modelId: "new-model", reasoningEffort: "high" },
  };
  assert.equal((await f.request(route, phone.token, command)).status, 202);
  let receipt: Receipt | undefined;
  for (let i = 0; i < 100; i++) {
    receipt = Receipt.parse(await (await f.request(`${route}/${command.commandId}`, phone.token)).json());
    if (receipt.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(receipt?.status, "completed");
  assert.deepEqual(current, { modelId: "new-model", reasoningEffort: "high" });
  const catalog = await (await f.request("/v1/catalog", phone.token)).json();
  const visible = catalog.sessions.find((item: { sessionId: string }) => item.sessionId === sid);
  assert.equal(visible.modelId, current.modelId);
  assert.equal(visible.reasoningEffort, current.reasoningEffort);
  const retry = Receipt.parse(await (await f.request(route, phone.token, command)).json());
  assert.equal(retry.status, "completed");
  assert.equal(switches, 1);

  session.abort = async () => {};
  session.rpc.metadata = { activity: async () => ({ hasActiveWork: true, abortable: true }) };
  const stop = { commandId: newId(), action: { type: "abort" } };
  await f.request(route, phone.token, stop);
  for (let i = 0; i < 100; i++) {
    receipt = Receipt.parse(await (await f.request(`${route}/${stop.commandId}`, phone.token)).json());
    if (receipt.status === "cancel_requested") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(receipt?.status, "cancel_requested");
  const afterStop = await (await f.request("/v1/catalog", phone.token)).json();
  assert.equal(afterStop.sessions.find((item: { sessionId: string }) => item.sessionId === sid).state, "cancel_requested");
});

test("bridge restart and duplicate submissions never send a task twice, including response-before-send-ack races", async (t) => {
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  t.after(async () => { await bridge?.close(); });
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), sid = newId();
  let emit: (event: unknown) => void = () => {}, sent = 0, aborted = 0;
  const event = (type: string, data: object) => ({ id: newId(), timestamp: new Date().toISOString(), type, data });
  const session: JoinedSession = {
    sessionId: sid,
    getEvents: async () => [event("session.start", { copilotVersion: "1.0.90-0", context: { cwd: f.dataDir } })],
    on: (listener) => { emit = listener; return () => {}; },
    send: async () => {
      sent++;
      emit(event("assistant.message", { messageId: "answer", originatingMessageId: "origin-1", content: "Visible result" }));
      emit(event("session.idle", {}));
      return "origin-1";
    },
    abort: async () => { aborted++; },
    rpc: {
      permissions: { getMode: async () => ({ mode: "manual" }), pendingRequests: async () => ({ items: [] }),
        paths: { list: async () => ({ primary: f.dataDir }) } },
      metadata: { activity: async () => ({ hasActiveWork: false, abortable: false }) },
    },
  };
  const config = { hostId: host.hostId, token: host.token, relayUrl: f.url, dataDir: path.join(f.dataDir, "bridge"), allowInsecureLoopback: true };
  bridge = await startBridge(session, config);
  const command = { commandId: newId(), action: { type: "message", text: "Exactly once", attachmentIds: [] } };
  const route = sessionPath(host.hostId, sid) + "/commands";
  assert.equal((await f.request(route, phone.token, command)).status, 202);
  let receipt;
  for (let i = 0; i < 100; i++) {
    receipt = await (await f.request(route + `/${command.commandId}`, phone.token)).json();
    if (receipt.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(receipt.status, "completed");
  await bridge.close();
  bridge = await startBridge(session, config);
  const retry = await (await f.request(route, phone.token, command)).json();
  assert.equal(retry.status, "completed");
  assert.equal(sent, 1);
  assert.equal(aborted, 0);
  const events = await (await f.request(sessionPath(host.hostId, sid) + "/events", phone.token)).json();
  assert.ok(events.events.some((e: { kind: string }) => e.kind === "assistant.message"));
});

test("retry after execution and loss of the HTTP response executes the original CLI operation exactly once", async (t) => {
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  const forwarded: { route: string; body: string }[] = [];
  let executions = 0;
  let emit: (event: unknown) => void = () => {};
  const proxy = createServer();
  t.after(async () => {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await bridge?.close();
  });
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), sid = newId();
  const event = (type: string, data: object) => ({ id: newId(), timestamp: new Date().toISOString(), type, data });
  const session: JoinedSession = {
    sessionId: sid,
    getEvents: async () => [event("session.start", { copilotVersion: "1.0.90-0", context: { cwd: f.dataDir } })],
    on: (listener) => { emit = listener; return () => {}; },
    send: async (options) => {
      assert.equal(options.prompt, "Execute exactly once despite a lost response");
      executions++;
      emit(event("assistant.message", { messageId: "reply", originatingMessageId: "once-only", content: "Done" }));
      emit(event("session.idle", {}));
      return "once-only";
    },
    abort: async () => {},
    rpc: {
      permissions: { getMode: async () => ({ mode: "manual" }), pendingRequests: async () => ({ items: [] }),
        paths: { list: async () => ({ primary: f.dataDir }) } },
      metadata: { activity: async () => ({ hasActiveWork: false, abortable: false }) },
    },
  };
  bridge = await startBridge(session, { hostId: host.hostId, token: host.token, relayUrl: f.url,
    dataDir: path.join(f.dataDir, "bridge"), allowInsecureLoopback: true });
  const route = sessionPath(host.hostId, sid) + "/commands";
  const command = { commandId: newId(), action: { type: "message", text: "Execute exactly once despite a lost response", attachmentIds: [] } };
  const body = JSON.stringify(command);
  let dropped = false;
  let droppedAfterExecution = false;
  proxy.on("request", (request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const received = Buffer.concat(chunks).toString();
      forwarded.push({ route: request.url ?? "", body: received });
      const upstream = await f.request(request.url ?? "", phone.token, JSON.parse(received));
      const reply = await upstream.text();
      if (!dropped) {
        dropped = true;
        let completed = false;
        for (let i = 0; i < 100; i++) {
          const result = await (await f.request(route + `/${command.commandId}`, phone.token)).json();
          if (result.status === "completed") { completed = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(completed, "Drop must happen after real relay/bridge execution has completed.");
        assert.equal(executions, 1);
        droppedAfterExecution = true;
        response.destroy();
      } else {
        response.writeHead(upstream.status, { "Content-Type": "application/json" });
        response.end(reply);
      }
    })().catch((error) => response.destroy(error instanceof Error ? error : new Error(String(error))));
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}${route}`;
  const submit = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body,
    signal: AbortSignal.timeout(5000) });
  await assert.rejects(submit(), TypeError);
  assert.equal(droppedAfterExecution, true);
  assert.equal(executions, 1);
  const retried = await (await submit()).json();
  assert.equal(retried.status, "completed");
  assert.equal(executions, 1);
  assert.deepEqual(forwarded, [{ route, body }, { route, body }]);
});

for (const extraFields of [false, true]) test(`unknown mutation ${extraFields ? "fields" : "acknowledgements"} remain uncertain and retries never repeat them`, async (t) => {
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  t.after(async () => { await bridge?.close(); });
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), sid = newId();
  let emit: (event: unknown) => void = () => {};
  const calls: string[] = [];
  const event = (type: string, data: object) => ({ id: newId(), timestamp: new Date().toISOString(), type, data });
  const session: JoinedSession = {
    sessionId: sid,
    getEvents: async () => [event("session.start", { context: { cwd: f.dataDir } })],
    on: (listener) => { emit = listener; return () => {}; },
    send: async () => { calls.push("message"); return { newMessageId: "unknown-shape" }; },
    abort: async () => { calls.push("abort"); return extraFields ? { confirmationRequired: true } : { success: false }; },
    rpc: {
      metadata: { activity: async () => ({ hasActiveWork: false, abortable: false }) },
      permissions: {
        paths: { list: async () => ({ primary: f.dataDir }) },
        pendingRequests: async () => ({ items: [{ requestId: "approval", request: {
          kind: "commands", fullCommandText: "echo harmless",
        } }] }),
        handlePendingPermissionRequest: async () => {
          calls.push("permission"); return extraFields ? { success: true, pending: true } : { resolved: true };
        },
      },
      ui: {
        handlePendingUserInput: async (input) => {
          calls.push(`answer:${input.requestId}`); return extraFields ? { success: true, pending: true } : { accepted: true };
        },
        handlePendingElicitation: async (input) => {
          calls.push(`answer:${input.requestId}`); return extraFields ? { success: true, pending: true } : { accepted: true };
        },
      },
      model: {
        getCurrent: async () => ({ modelId: "test-model" }),
        list: async () => ({ list: [{ id: "test-model" }] }),
        switchTo: async () => {
          calls.push("model.set"); return extraFields ? { modelId: "test-model", pending: true } : {};
        },
      },
    },
  };
  bridge = await startBridge(session, { hostId: host.hostId, token: host.token, relayUrl: f.url,
    dataDir: path.join(f.dataDir, "bridge"), allowInsecureLoopback: true });
  const catalog = await (await f.request("/v1/catalog", phone.token)).json();
  const summary = SessionSummary.strip().parse(catalog.sessions[0]);
  assert.equal(summary.cliVersion, "unknown");
  assert.equal(summary.capabilities.messages, true);
  assert.equal(summary.capabilities.abort, true);
  emit(event("user_input.requested", { requestId: "question", question: "Choose", choices: ["One", "Two"] }));
  emit(event("elicitation.requested", {
    requestId: "form", message: "Choose",
    requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["One", "Two"] } } },
  }));
  const actions: Action[] = [
    { type: "message", text: "Preserve an uncertain send", attachmentIds: [] },
    { type: "abort" },
    { type: "permission", requestId: "approval", decision: "reject" },
    { type: "answer", requestId: "question", answer: "One" },
    { type: "answer", requestId: "form", answer: "One" },
    { type: "model.set", modelId: "test-model" },
  ];
  const key = (action: Action) => action.type === "answer" ? `answer:${action.requestId}` : action.type;
  const route = sessionPath(host.hostId, sid) + "/commands";
  for (const action of actions) {
    const command = { commandId: newId(), action };
    assert.equal((await f.request(route, phone.token, command)).status, 202);
    let receipt = Receipt.parse(await (await f.request(`${route}/${command.commandId}`, phone.token)).json());
    for (let i = 0; i < 100 && receipt.status === "dispatched"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      receipt = Receipt.parse(await (await f.request(`${route}/${command.commandId}`, phone.token)).json());
    }
    assert.equal(receipt.status, "uncertain", action.type);
    assert.equal(receipt.error?.code, "DELIVERY_UNCERTAIN");
    const retry = Receipt.parse(await (await f.request(route, phone.token, command)).json());
    assert.equal(retry.status, "uncertain");
    assert.equal(calls.filter((type) => type === key(action)).length, 1);
  }
  assert.deepEqual(calls, actions.map(key));
});

test("cached relay capabilities cannot veto live recovery while unrelated probes are stalled", async (t) => {
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  let finishCatalogue = () => {};
  let refreshing: Promise<SessionSummary> | undefined;
  t.after(async () => {
    finishCatalogue();
    await refreshing;
    await bridge?.close();
  });
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), sid = newId();
  let available = false, sends = 0;
  let emit: (event: unknown) => void = () => {};
  const event = (type: string, data: object) => ({ id: newId(), timestamp: new Date().toISOString(), type, data });
  const session: JoinedSession = {
    sessionId: sid,
    getEvents: async () => [event("session.start", { copilotVersion: "future-build", context: { cwd: f.dataDir } })],
    on: (listener) => { emit = listener; return () => {}; },
    send: async (options) => {
      sends++;
      assert.equal(options.mode, "enqueue");
      assert.equal(options.source, "user");
      emit(event("assistant.message", { messageId: "recovered-answer", originatingMessageId: "recovered-message", content: "Recovered" }));
      emit(event("session.idle", {}));
      return "recovered-message";
    },
    rpc: {
      metadata: { activity: async () => available ? { hasActiveWork: false, abortable: false } : { hasActiveWork: "unknown" } },
      permissions: {
        paths: { list: async () => ({ primary: f.dataDir }) },
        getMode: async () => ({ mode: "manual" }), pendingRequests: async () => ({ items: [] }),
      },
      model: { list: async () => ({ list: [{ id: "test-model" }] }), getCurrent: async () => ({ modelId: "test-model" }) },
    },
  };
  bridge = await startBridge(session, {
    hostId: host.hostId, token: host.token, relayUrl: f.url,
    dataDir: path.join(f.dataDir, "bridge"), allowInsecureLoopback: true,
  });
  const catalogue = await (await f.request("/v1/catalog", phone.token)).json();
  assert.equal(SessionSummary.strip().parse(catalogue.sessions[0]).capabilities.messages, false);
  const stalled = new Promise<void>((resolve) => { finishCatalogue = resolve; });
  session.rpc.model!.list = async () => { await stalled; return { list: [{ id: "test-model" }] }; };
  available = true;
  refreshing = bridge.runtime.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cached = await (await f.request("/v1/catalog", phone.token)).json();
  assert.equal(SessionSummary.strip().parse(cached.sessions[0]).capabilities.messages, false);
  const route = sessionPath(host.hostId, sid) + "/commands";
  const command = { commandId: newId(), action: { type: "message", text: "Recovered without a full refresh", attachmentIds: [] } };
  assert.equal((await f.request(route, undefined, command)).status, 401);
  assert.equal((await f.request(route, phone.token, command)).status, 202);
  async function receipt(commandId: string): Promise<Receipt> {
    for (let i = 0; i < 100; i++) {
      const value = Receipt.parse(await (await f.request(`${route}/${commandId}`, phone.token)).json());
      if (value.status !== "dispatched") return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("The bridge did not return its action-specific result.");
  }
  assert.equal((await receipt(command.commandId)).status, "completed");
  assert.equal(sends, 1);
  assert.equal(Receipt.parse(await (await f.request(route, phone.token, command)).json()).status, "completed");
  assert.equal(sends, 1);

  available = false;
  const unsupported = { ...command, commandId: newId() };
  assert.equal((await f.request(route, phone.token, unsupported)).status, 202);
  const rejected = await receipt(unsupported.commandId);
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.error?.code, "UNSUPPORTED");
  assert.equal(sends, 1);
  finishCatalogue();
  await refreshing;
  await bridge.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await f.request(route, phone.token, { ...command, commandId: newId() })).status, 503);
  assert.equal(Receipt.parse(await (await f.request(route, phone.token, command)).json()).status, "completed");
});
