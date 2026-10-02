import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, newId, nextFrame, sessionPath, wireHost } from "./harness.js";

test("cursor replay is scoped and duplicate host publications do not duplicate history", async (t) => {
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), sid = newId();
  const ws = f.socket(`/v1/host/stream?sessionId=${sid}`, host.token);
  await wireHost(ws, sid);
  const first = { id: newId(), at: new Date().toISOString(), kind: "user.message",
    data: { messageId: "first", content: "First", attachments: [] } };
  const second = { ...first, id: newId(), data: { ...first.data, messageId: "second", content: "Second" } };
  let ack = nextFrame(ws, "eventsAck");
  ws.send(JSON.stringify({ type: "events", items: [first, second] }));
  await ack;
  ack = nextFrame(ws, "eventsAck");
  ws.send(JSON.stringify({ type: "events", items: [first, second] }));
  await ack;
  const page = await (await f.request(sessionPath(host.hostId, sid) + "/events", phone.token)).json();
  assert.equal(page.events.length, 2);
  const resumed = await (await f.request(sessionPath(host.hostId, sid) + `/events?after=${page.events[0].cursor}`, phone.token)).json();
  assert.deepEqual(resumed.events.map((e: { id: string }) => e.id), [second.id]);
  const reset = await (await f.request(sessionPath(host.hostId, sid) + "/events?after=9999999", phone.token)).json();
  assert.equal(reset.reset, true);
  assert.equal(reset.events.length, 2);
});

test("device revocation closes active subscriptions and prevents further commands and downloads", async (t) => {
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), sid = newId();
  await wireHost(f.socket(`/v1/host/stream?sessionId=${sid}`, host.token), sid);
  const viewer = f.socket(`/v1/events?hostId=${host.hostId}&sessionId=${sid}`, phone.token);
  await nextFrame(viewer, "events");
  const closed = new Promise<number>((resolve) => viewer.once("close", (code) => resolve(code)));
  assert.equal((await f.request(`/v1/host/devices/${phone.deviceId}`, host.token, undefined, "DELETE")).status, 200);
  assert.equal(await closed, 4003);
  assert.equal((await f.request(sessionPath(host.hostId, sid) + "/events", phone.token)).status, 403);
  assert.equal((await f.request(sessionPath(host.hostId, sid) + "/commands", phone.token,
    { commandId: newId(), action: { type: "abort" } })).status, 403);
});

test("pairing expires and anonymous attempts are rate limited even with forged proxy headers", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, () => clock), host = f.host();
  const pairing = await (await f.request("/v1/host/pairings", host.token, {})).json();
  clock += 300001;
  assert.equal((await f.request("/v1/pair", undefined, { code: pairing.code, name: "Expired" })).status, 401);
  let status = 0;
  for (let i = 0; i < 7; i++) {
    status = (await fetch(f.url + "/v1/pair", { method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${i}` },
      body: JSON.stringify({ code: "x".repeat(50), name: "Invalid" }),
    })).status;
  }
  assert.equal(status, 429);
});

test("a disconnected runtime is offline, not completed, and no new offline task is accepted", async (t) => {
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), sid = newId();
  const ws = f.socket(`/v1/host/stream?sessionId=${sid}`, host.token);
  await wireHost(ws, sid);
  const close = new Promise((resolve) => ws.once("close", resolve));
  ws.close(); await close;
  const session = await (await f.request(sessionPath(host.hostId, sid), phone.token)).json();
  assert.equal(session.online, false);
  assert.equal(session.state, "offline");
  assert.equal((await f.request(sessionPath(host.hostId, sid) + "/commands", phone.token,
    { commandId: newId(), action: { type: "message", text: "Must not queue offline" } })).status, 503);
});

test("raw RPC, extra fields and internal model snapshots are not accepted by protocol v1", async (t) => {
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), sid = newId();
  const ws = f.socket(`/v1/host/stream?sessionId=${sid}`, host.token);
  await wireHost(ws, sid);
  assert.equal((await f.request(sessionPath(host.hostId, sid) + "/commands", phone.token,
    { commandId: newId(), action: { type: "rpc", method: "permissions.setApproveAll", enabled: true } })).status, 400);
  const rejected = nextFrame(ws, "error");
  ws.send(JSON.stringify({ type: "events", items: [{
    id: newId(), at: new Date().toISOString(), kind: "model.messages_snapshot", data: { system: "private" },
  }] }));
  assert.equal(((await rejected).error as { code: string }).code, "PROTOCOL_INVALID");
  const events = await (await f.request(sessionPath(host.hostId, sid) + "/events", phone.token)).json();
  assert.ok(events.events.every((event: { kind: string }) => event.kind !== "model.messages_snapshot"));
});

test("long conversation replay is byte-bounded and can be paged without missing events", async (t) => {
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), sid = newId();
  const ws = f.socket(`/v1/host/stream?sessionId=${sid}`, host.token);
  await wireHost(ws, sid);
  const items = Array.from({ length: 45 }, (_, index) => ({
    id: newId(), at: new Date().toISOString(), kind: "user.message",
    data: { messageId: `long-${index}`, content: "x".repeat(30_000), attachments: [] },
  }));
  const ack = nextFrame(ws, "eventsAck");
  ws.send(JSON.stringify({ type: "events", items }));
  await ack;
  let cursor = 0;
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    const response = await f.request(sessionPath(host.hostId, sid) + `/events?after=${cursor}`, phone.token);
    const body = await response.text();
    assert.ok(Buffer.byteLength(body) <= 550 * 1024, "Replay must fit the native client's bounded response buffer.");
    const page = JSON.parse(body);
    ids.push(...page.events.map((event: { id: string }) => event.id));
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  assert.deepEqual(ids, items.map((event) => event.id));
});

test("host reconnection replaces the stale offline event with an authoritative live state", async (t) => {
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), sid = newId();
  const first = f.socket(`/v1/host/stream?sessionId=${sid}`, host.token);
  await wireHost(first, sid);
  const closed = new Promise((resolve) => first.once("close", resolve));
  first.close(); await closed;
  const second = f.socket(`/v1/host/stream?sessionId=${sid}`, host.token);
  await wireHost(second, sid);
  const page = await (await f.request(sessionPath(host.hostId, sid) + "/events", phone.token)).json();
  const state = page.events.filter((event: { kind: string }) => event.kind === "runtime.state").at(-1);
  assert.equal(state.data.state, "idle");
});
