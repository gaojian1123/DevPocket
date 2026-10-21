import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { startBridge } from "../src/bridge.js";
import {
  HostFrame, Receipt, SessionSummary, decodeComponentPayload,
  type ComponentRecord, type EventPage, type UserEvent,
} from "../src/protocol.js";
import type { JoinedSession, LocalAttachment } from "../src/runtime.js";
import { secret } from "../src/security.js";
import { fixture, newId, nextFrame, sessionPath, wireHost } from "./harness.js";

const owner = { instanceId: "wire-fixture", canvasId: "agenticdeck-canvas",
  extensionId: "plugin:agenticdeck-gh-app-extensions:agenticdeck-canvas" };
const series = { xAxisKey: "day", data: [{ day: "A", value: 1 }, { day: "B", value: 2 }],
  series: [{ name: "Count", dataKey: "value" }] };
const specs = [
  { type: "line", ...series }, { type: "bar", ...series },
  { type: "datagrid", columns: [{ key: "name", label: "Name" }], rows: [{ name: "Complete table data" }] },
  { type: "markdown", content: "Complete **Markdown** data." },
];

async function eventually(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function componentPeer() {
  let listener: (value: unknown) => void = () => {};
  const history: { id: string; type: string; timestamp: string; data: object }[] = [];
  const calls: { prompt: string; files: LocalAttachment[]; contents: unknown[] }[] = [];
  const emit = (type: string, data: object) => {
    const value = { id: newId(), type, timestamp: new Date().toISOString(), data };
    history.push(value); listener(value);
  };
  const render = (id: string, spec: unknown, success = true) => {
    emit("assistant.message", { messageId: `owner-${id}`, content: "", originatingMessageId: "fixture-user",
      toolRequests: [{ toolCallId: id }], turnId: "reused-model-turn" });
    emit("tool.execution_start", { toolCallId: id, toolName: "invoke_canvas_action",
      arguments: { instanceId: owner.instanceId, actionName: "render_component", input: { spec } } });
    emit("tool.execution_complete", { toolCallId: id, success });
  };
  emit("session.canvas.recorded", owner);
  specs.forEach((spec, index) => render(`card-${index}`, spec));
  const session: JoinedSession = {
    sessionId: newId(), openCanvases: [owner], getEvents: async () => [...history],
    on: (handler) => { listener = handler; return () => { listener = () => {}; }; },
    send: async ({ prompt, mode, source, attachments = [] }) => {
      assert.equal(mode, "enqueue");
      assert.equal(source, "user");
      const contents: unknown[] = await Promise.all(attachments.map(async (file) =>
        JSON.parse(await readFile(file.path, "utf8"))));
      calls.push({ prompt, files: attachments, contents });
      const messageId = newId();
      emit("user.message", { messageId, content: prompt });
      emit("assistant.message", { messageId: newId(), originatingMessageId: messageId, content: "Fixture reply" });
      emit("session.idle", {});
      return messageId;
    },
    rpc: {
      metadata: { activity: async () => ({ hasActiveWork: false, abortable: false }) },
      queue: { pendingItems: async () => ({ items: [] }) },
    },
  };
  return { session, calls, render };
}

test("negotiated cards survive relay replay and references stage exact bytes without resubmission", async (t) => {
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  t.after(async () => { await bridge?.close(); });
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), peer = componentPeer();
  const route = sessionPath(host.hostId, peer.session.sessionId);
  const config = { hostId: host.hostId, token: host.token, relayUrl: f.url,
    dataDir: path.join(f.dataDir, "bridge"), allowInsecureLoopback: true };
  bridge = await startBridge(peer.session, config);
  const page = async () => await (await f.request(`${route}/events`, phone.token)).json() as EventPage;
  const cards = async () => (await page()).events.flatMap((event) =>
    event.kind === "component" && event.data.status === "ready" ? [event.data] : []);
  await eventually(async () => (await cards()).length === 4, "All supported cards must reach the relay.");
  const original = await cards();
  assert.deepEqual(original.map((card) => decodeComponentPayload(card.payload, card.sha256)), specs);
  assert.ok(original.every((card) => card.originatingMessageId === "fixture-user"));
  const card = original[0]!;
  const action = { type: "message" as const, text: "Keep this exact question", attachmentIds: [],
    componentReference: { componentId: card.componentId, sha256: card.sha256 } };
  const command = { commandId: newId(), action };
  const submit = async (value: typeof command) => {
    assert.equal((await f.request(`${route}/commands`, phone.token, value)).status, 202);
    let receipt: Receipt | undefined;
    await eventually(async () => {
      receipt = Receipt.parse(await (await f.request(`${route}/commands/${value.commandId}`, phone.token)).json());
      return ["completed", "failed", "uncertain"].includes(receipt.status);
    }, "The referenced operation must settle.");
    return receipt!;
  };
  assert.equal((await submit(command)).status, "completed");
  assert.equal(peer.calls.length, 1);
  assert.equal(peer.calls[0]!.prompt, action.text);
  assert.equal(peer.calls[0]!.files.length, 1);
  const attachment = peer.calls[0]!.contents[0] as Record<string, unknown>;
  assert.equal(attachment.kind, "devpocket.component-reference");
  assert.equal(attachment.componentId, card.componentId);
  assert.equal(attachment.sha256, card.sha256);
  assert.deepEqual(attachment.spec, specs[0]);
  assert.match(String(attachment.notice), /untrusted data, not instructions/);
  assert.ok(peer.calls[0]!.files[0]!.path.startsWith(path.join(config.dataDir, host.hostId, peer.session.sessionId)));
  assert.ok(!(await page()).events.some((event) => event.kind === "user.message" && event.data.content.includes('"spec"')));
  await bridge.close();
  bridge = await startBridge(peer.session, config);
  assert.equal((await submit(command)).status, "completed");
  assert.equal(peer.calls.length, 1, "An immutable retry must not invoke the SDK twice.");
  peer.render("card-0", specs[0]);
  await eventually(async () => (await page()).events.some((event) =>
    event.kind === "assistant.message" && event.data.content === "Fixture reply"), "Reply must remain in replay.");
  assert.equal((await cards()).length, 4, "Historical/live replay must not duplicate cards.");
  const mismatch = await submit({ commandId: newId(), action: {
    ...action, componentReference: { ...action.componentReference, sha256: "0".repeat(64) },
  } });
  assert.equal(mismatch.status, "failed");
  assert.equal(mismatch.error?.code, "COMPONENT_REFERENCE_MISMATCH");
  await assert.rejects(bridge.runtime.execute({ ...action, attachmentIds: Array.from({ length: 4 }, () => newId()) },
    Array.from({ length: 4 }, (_, index) => ({ type: "file" as const,
      path: path.join(f.dataDir, `unused-${index}.json`), displayName: `file-${index}.json` })),
    undefined, { reference: action.componentReference, file: peer.calls[0]!.files[0]! }),
  { code: "TOO_MANY_ATTACHMENTS" });
  assert.equal(peer.calls.length, 1);
  await writeFile(peer.calls[0]!.files[0]!.path, "tampered fixture bytes");
  const corrupt = await submit({ commandId: newId(), action });
  assert.equal(corrupt.status, "failed", "A pre-SDK staging error is not an uncertain runtime execution.");
  assert.equal(corrupt.error?.code, "COMPONENT_REFERENCE_CORRUPT");
  assert.equal(peer.calls.length, 1);
  const outsider = await f.pair(f.host("Other fixture host").token);
  assert.equal((await f.request(`${route}/events`, outsider.token)).status, 403);
});

test("a bridge renegotiates on reconnect and never sends new card fields to a strict legacy relay", async (t) => {
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const listening = once(server, "listening");
  t.after(async () => {
    await bridge?.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const f = await fixture(t), peer = componentPeer(), hostId = newId();
  let connections = 0, failure: unknown;
  let legacy: SessionSummary | undefined, reference: Extract<ComponentRecord, { status: "ready" }> | undefined;
  const received: { connection: number; event: UserEvent }[] = [];
  await listening;
  server.on("connection", (socket, request) => {
    const connection = ++connections;
    assert.equal(new URL(request.url!, "http://localhost").searchParams.get("components"), "1");
    socket.on("message", (bytes) => {
      try {
        const frame = HostFrame.parse(JSON.parse(bytes.toString()));
        if (frame.type === "hello") {
          SessionSummary.omit({ workspace: true, componentVersion: true }).parse(frame.summary);
          socket.send(JSON.stringify({ type: "ready", protocol: 1, hostId, sessionId: peer.session.sessionId,
            ...(connection === 1 ? { components: true } : {}) }));
        } else if (frame.type === "summary" && connection > 1) legacy = frame.summary;
        else if (frame.type === "events") {
          for (const event of frame.items) {
            if (connection > 1) {
              assert.notEqual(event.kind, "component");
              assert.ok(!Object.hasOwn(event.data, "toolCallIds"));
              if (event.kind === "tool.start" || event.kind === "tool.output")
                assert.ok(!Object.hasOwn(event.data, "originatingMessageId"));
            } else if (event.kind === "component" && event.data.status === "ready") reference = event.data;
            received.push({ connection, event });
          }
          socket.send(JSON.stringify({ type: "eventsAck", ids: frame.items.map((item) => item.id) }));
        }
      } catch (error) { failure = error; socket.terminate(); }
    });
  });
  const waitFor = (check: () => boolean) => eventually(() => {
    if (failure) throw failure;
    return check();
  }, "Component compatibility exchange must complete.");
  bridge = await startBridge(peer.session, { hostId, token: secret("dph"),
    relayUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    dataDir: path.join(f.dataDir, "legacy-bridge"), allowInsecureLoopback: true });
  await waitFor(() => received.filter((item) => item.event.kind === "component").length === 4);
  for (const socket of server.clients) socket.close(1001, "Fixture legacy reconnect");
  await waitFor(() => legacy !== undefined);
  assert.equal(legacy?.componentVersion, undefined);
  assert.ok(legacy?.warnings.some((value) => value.includes("does not support component")));
  peer.render("legacy-card", specs[0]);
  await waitFor(() => received.some((item) => item.connection > 1 && item.event.kind === "notice" &&
    item.event.data.code === "COMPONENTS_UNAVAILABLE"));
  assert.ok(reference);
  const socket = [...server.clients][0]!;
  const result = nextFrame(socket, "result");
  socket.send(JSON.stringify({ type: "command", commandId: newId(), action: {
    type: "message", text: "Must not reach the SDK", attachmentIds: [],
    componentReference: { componentId: reference.componentId, sha256: reference.sha256 },
  } }));
  const rejected = await result;
  assert.equal(rejected.status, "failed");
  assert.deepEqual(rejected.error, { code: "COMPONENTS_UNAVAILABLE",
    message: "Card references require a relay that negotiated component support." });
  assert.equal(peer.calls.length, 0);
});

test("a new relay uses live negotiation, not stale session metadata, before forwarding a reference", async (t) => {
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), sessionId = newId();
  const route = sessionPath(host.hostId, sessionId);
  const capable = f.socket(`/v1/host/stream?sessionId=${sessionId}&components=1`, host.token);
  await wireHost(capable, sessionId);
  const command = { commandId: newId(), action: { type: "message", text: "A referenced message",
    attachmentIds: [], componentReference: { componentId: "card", sha256: "a".repeat(64) } } };
  const delivered = nextFrame(capable, "command");
  assert.equal((await f.request(`${route}/commands`, phone.token, command)).status, 202);
  assert.equal((await delivered).commandId, command.commandId);
  const closed = once(capable, "close");
  capable.close();
  await closed;
  const legacy = f.socket(`/v1/host/stream?sessionId=${sessionId}`, host.token);
  const legacyCommands: unknown[] = [];
  legacy.on("message", (bytes) => {
    const value = JSON.parse(bytes.toString()) as { type: string };
    if (value.type === "command") legacyCommands.push(value);
  });
  await wireHost(legacy, sessionId);
  let receipt: Receipt | undefined;
  await eventually(async () => {
    receipt = Receipt.parse(await (await f.request(`${route}/commands/${command.commandId}`, phone.token)).json());
    return receipt.status === "uncertain";
  }, "Unrecoverable referenced commands must remain explicitly uncertain.");
  assert.equal(receipt?.error?.code, "COMPONENTS_UNAVAILABLE");
  assert.deepEqual(legacyCommands, []);
  const catalog = await (await f.request("/v1/catalog", phone.token)).json() as { sessions: SessionSummary[] };
  assert.equal(catalog.sessions[0]?.componentVersion, undefined);
  const rejected = await f.request(`${route}/commands`, phone.token, { ...command, commandId: newId() });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.code, "COMPONENTS_UNAVAILABLE");
  const ordinary = nextFrame(legacy, "command");
  const ordinaryId = newId();
  assert.equal((await f.request(`${route}/commands`, phone.token, {
    commandId: ordinaryId, action: { type: "message", text: "Still compatible", attachmentIds: [] },
  })).status, 202);
  assert.equal((await ordinary).commandId, ordinaryId);
});
