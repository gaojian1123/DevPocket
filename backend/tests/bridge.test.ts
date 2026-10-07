import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startBridge } from "../src/bridge.js";
import type { JoinedSession } from "../src/runtime.js";
import { Receipt, SessionSummary, type Action } from "../src/protocol.js";
import { fixture, newId, sessionPath } from "./harness.js";

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
  assert.equal(summary.capabilities.abort, false);
  emit(event("user_input.requested", { requestId: "question", question: "Choose", choices: ["One", "Two"] }));
  emit(event("elicitation.requested", {
    requestId: "form", message: "Choose",
    requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["One", "Two"] } } },
  }));
  const actions: Action[] = [
    { type: "message", text: "Preserve an uncertain send", attachmentIds: [] },
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
