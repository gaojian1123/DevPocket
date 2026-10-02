import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { startRelay } from "../src/relay.js";
import { provisionHost } from "../src/store.js";
import { fixture, newId, nextFrame, wireHost } from "./harness.js";
import WebSocket from "ws";

test("an unconfigured relay truthfully refuses FCM registration", async (t) => {
  const f = await fixture(t), host = f.host(), device = await f.pair(host.token);
  assert.equal((await f.request("/v1/push-token", device.token, { provider: "fcm", token: "fixture-token-not-a-real-device" }, "PUT")).status, 409);
  const catalog = await (await f.request("/v1/catalog", device.token)).json();
  assert.equal(catalog.pushConfigured, false);
  assert.equal((await f.request("/v1/push-token", device.token, { provider: "fcm", token: null }, "PUT")).status, 200);
});

test("push projection carries no conversation text and revocation prevents later notifications", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/push-"));
  const notices: unknown[] = [];
  const relay = await startRelay({ dataDir: root, allowInsecureLoopback: true, port: 0,
    pushSender: { send: async (_token, notice) => { notices.push(notice); return "sent"; } } });
  const host = provisionHost(root, "Push fixture"), sid = newId();
  const request = (route: string, token: string | undefined, body?: object, method = body ? "POST" : "GET") =>
    fetch(relay.url + route, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
  const pair = await (await request("/v1/host/pairings", host.token, {})).json();
  const device = await (await request("/v1/pair", undefined, { code: pair.code, name: "Push fixture" })).json();
  await request("/v1/push-token", device.token, { provider: "fcm", token: "fixture-token-not-a-real-device" }, "PUT");
  const ws = new WebSocket(relay.url.replace("http:", "ws:") + `/v1/host/stream?sessionId=${sid}`,
    { headers: { Authorization: `Bearer ${host.token}` } });
  t.after(async () => { ws.terminate(); await relay.close(); await rm(root, { recursive: true, force: true }); });
  await wireHost(ws, sid);
  const emit = async () => {
    const received = nextFrame(ws, "eventsAck");
    ws.send(JSON.stringify({ type: "events", items: [{
      id: newId(), at: new Date().toISOString(), kind: "requests", data: { items: [{
        requestId: "request", type: "question", title: "PRIVATE_CONVERSATION", detail: "SECRET_MESSAGE",
        choices: [], allowFreeform: true, supported: true,
      }] },
    }] }));
    await received;
  };
  await emit();
  assert.equal(notices.length, 1);
  assert.ok(!JSON.stringify(notices).includes("PRIVATE_CONVERSATION"));
  assert.ok(!JSON.stringify(notices).includes("SECRET_MESSAGE"));
  await request(`/v1/host/devices/${device.deviceId}`, host.token, undefined, "DELETE");
  await emit();
  assert.equal(notices.length, 1);
});
