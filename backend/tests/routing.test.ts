import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, newId, nextFrame, sessionPath, wireHost } from "./harness.js";

test("a paired phone routes a command once to its exact host and session, never another host", async (t) => {
  const f = await fixture(t);
  const first = f.host("First");
  const second = f.host("Second");
  const phone = await f.pair(first.token);
  const sid = newId();
  const other = newId();
  const ws = f.socket(`/v1/host/stream?sessionId=${sid}`, first.token);
  await wireHost(ws, sid);
  const otherWs = f.socket(`/v1/host/stream?sessionId=${other}`, second.token);
  await wireHost(otherWs, other);
  let count = 0;
  ws.on("message", (raw) => { if (JSON.parse(raw.toString()).type === "command") count++; });
  const body = { commandId: newId(), action: { type: "message", text: "Keep my original terminal", attachmentIds: [] } };
  const frame = nextFrame(ws, "command");
  const response = await f.request(sessionPath(first.hostId, sid) + "/commands", phone.token, body);
  assert.equal(response.status, 202);
  assert.equal((await frame).commandId, body.commandId);
  assert.equal((await f.request(sessionPath(first.hostId, sid) + "/commands", phone.token, body)).status, 202);
  assert.equal(count, 1);
  assert.equal((await f.request(sessionPath(first.hostId, sid) + "/commands", phone.token,
    { ...body, action: { ...body.action, text: "Different content" } })).status, 409);
  assert.equal((await f.request(sessionPath(second.hostId, other) + "/commands", phone.token,
    { ...body, commandId: newId() })).status, 403);
  assert.equal((await f.request(sessionPath(first.hostId, other) + "/commands", phone.token,
    { ...body, commandId: newId() })).status, 404);
  ws.send(JSON.stringify({ type: "result", commandId: body.commandId, status: "admitted", result: { messageId: "runtime-message" } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const receipt = await (await f.request(sessionPath(first.hostId, sid) + `/commands/${body.commandId}`, phone.token)).json();
  assert.equal(receipt.status, "admitted");
  await f.pair(second.token, phone.token);
  const catalog = await (await f.request("/v1/catalog", phone.token)).json();
  assert.equal(catalog.hosts.length, 2);
  assert.equal(catalog.sessions.length, 2);
});
