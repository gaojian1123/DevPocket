import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { test } from "node:test";
import { startRelay } from "../src/relay.js";
import { provisionHost, RelayStore } from "../src/store.js";
import { FcmPush } from "../src/push.js";
import type { PushTarget } from "../src/protocol.js";
import { fixture, newId, nextFrame, wireHost } from "./harness.js";
import WebSocket from "ws";

test("an unconfigured relay truthfully refuses FCM registration", async (t) => {
  const f = await fixture(t), host = f.host(), device = await f.pair(host.token);
  assert.equal((await f.request("/v1/push-token", device.token, { provider: "fcm", token: "fixture-token-not-a-real-device" }, "PUT")).status, 409);
  const catalog = await (await f.request("/v1/catalog", device.token)).json();
  assert.equal(catalog.pushConfigured, false);
  assert.equal((await f.request("/v1/push-token", device.token, { provider: "fcm", token: null }, "PUT")).status, 200);
  assert.equal((await f.request("/v1/push-token", device.token,
    { provider: "fcm-fid", fid: "c" + "a".repeat(21) }, "PUT")).status, 409);
  assert.equal((await f.request("/v1/push-token", device.token, { provider: "fcm-fid", fid: null }, "PUT")).status, 200);
});

test("FID registration is explicit, device-scoped and never inferred from legacy token contents", async (t) => {
  const f = await fixture(t, undefined, { send: async () => "sent" });
  const host = f.host(), first = await f.pair(host.token), second = await f.pair(host.token);
  const value = "c" + "a".repeat(21);
  assert.equal((await f.request("/v1/push-token", first.token, { provider: "fcm", token: value }, "PUT")).status, 200);
  assert.equal((await f.request("/v1/push-token", second.token, { provider: "fcm-fid", fid: value }, "PUT")).status, 200);
  const store = new RelayStore(f.dataDir);
  try {
    assert.deepEqual(store.pushTargets(host.hostId).map((entry) => [entry.id, entry.target]).sort(), [
      [first.deviceId, { kind: "token", value }], [second.deviceId, { kind: "fid", value }],
    ].sort());
    assert.equal((await f.request("/v1/push-token", first.token,
      { provider: "fcm-fid", fid: value, token: value }, "PUT")).status, 400);
    assert.equal((await f.request("/v1/push-token", first.token,
      { provider: "fcm-fid", fid: "invalid", deviceId: second.deviceId }, "PUT")).status, 400);
    assert.equal((await f.request("/v1/push-token", first.token, { provider: "fcm-fid", fid: null }, "PUT")).status, 200);
    assert.deepEqual(store.pushTargets(host.hostId).map((entry) => entry.id), [second.deviceId]);
  } finally { store.close(); }
});

test("legacy push records migrate without changing ownership and stale delivery failures cannot clear a new registration", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/push-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = new RelayStore(root), host = original.createHost("Legacy host");
  const device = original.pair(original.pairing(host.hostId).code, "Legacy phone");
  const legacy = { kind: "token", value: "c" + "b".repeat(21) } as const;
  original.setPushTarget(device.deviceId, legacy);
  original.close();
  const old = new DatabaseSync(path.join(root, "relay.sqlite"));
  old.exec("ALTER TABLE devices DROP COLUMN push_fid; ALTER TABLE devices DROP COLUMN push_revision");
  old.close();
  const migrated = new RelayStore(root);
  try {
    const target = migrated.pushTargets(host.hostId)[0]!;
    assert.deepEqual(target, { id: device.deviceId, target: legacy, revision: 0 });
    assert.ok(device.token);
    assert.equal(migrated.device(device.token).id, device.deviceId);
    migrated.authorize(device.deviceId, host.hostId);
    const fid: PushTarget = { kind: "fid", value: "c" + "d".repeat(21) };
    migrated.setPushTarget(device.deviceId, fid);
    const first = migrated.pushTargets(host.hostId)[0]!;
    migrated.setPushTarget(device.deviceId, fid);
    migrated.clearPushTarget(device.deviceId, target.target, target.revision);
    migrated.clearPushTarget(device.deviceId, first.target, first.revision);
    const current = migrated.pushTargets(host.hostId)[0]!;
    assert.deepEqual(current.target, fid);
    assert.ok(current.revision > first.revision);
    migrated.clearPushTarget(device.deviceId, current.target, current.revision);
    assert.deepEqual(migrated.pushTargets(host.hostId), []);
  } finally { migrated.close(); }
  const reopened = new RelayStore(root);
  try {
    reopened.authorize(device.deviceId, host.hostId);
    assert.deepEqual(reopened.pushTargets(host.hostId), []);
  } finally { reopened.close(); }
});

test("FCM sends distinct FID and legacy token fields without making network requests", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/push-payload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = path.join(root, "service-account.json");
  await writeFile(config, JSON.stringify({
    type: "service_account", project_id: "devpocket-test",
    client_email: "fixture@devpocket-test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  }), { mode: 0o600 });
  const sent: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "https://oauth2.googleapis.com/token")
      return new Response(JSON.stringify({ access_token: "fixture-access", expires_in: 3600 }));
    assert.equal(String(input), "https://fcm.googleapis.com/v1/projects/devpocket-test/messages:send");
    const body: { message: Record<string, unknown> } = JSON.parse(String(init?.body));
    sent.push(body.message);
    return new Response(JSON.stringify({ name: "projects/devpocket-test/messages/fixture" }));
  });
  const sender = await FcmPush.fromFile(config), value = "c" + "e".repeat(21);
  const notice = { hostId: newId(), sessionId: newId(), eventId: newId(), kind: "attention" } as const;
  assert.equal(await sender.send({ kind: "fid", value }, notice), "sent");
  assert.equal(await sender.send({ kind: "token", value }, notice), "sent");
  assert.equal(sent[0]!.fid, value);
  assert.equal(Object.hasOwn(sent[0]!, "token"), false);
  assert.equal(sent[1]!.token, value);
  assert.equal(Object.hasOwn(sent[1]!, "fid"), false);
  assert.deepEqual(sent[0]!.data, notice);
});

test("push projection carries no conversation text and revocation prevents later notifications", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/push-"));
  const notices: unknown[] = [];
  const targets: PushTarget[] = [];
  const relay = await startRelay({ dataDir: root, allowInsecureLoopback: true, port: 0,
    pushSender: { send: async (target, notice) => { targets.push(target); notices.push(notice); return "sent"; } } });
  const host = provisionHost(root, "Push fixture"), sid = newId();
  const request = (route: string, token: string | undefined, body?: object, method = body ? "POST" : "GET") =>
    fetch(relay.url + route, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
  const pair = await (await request("/v1/host/pairings", host.token, {})).json();
  const device = await (await request("/v1/pair", undefined, { code: pair.code, name: "Push fixture" })).json();
  const fid = "c" + "f".repeat(21);
  await request("/v1/push-token", device.token, { provider: "fcm-fid", fid }, "PUT");
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
  assert.deepEqual(targets, [{ kind: "fid", value: fid }]);
  assert.ok(!JSON.stringify(notices).includes("PRIVATE_CONVERSATION"));
  assert.ok(!JSON.stringify(notices).includes("SECRET_MESSAGE"));
  await request(`/v1/host/devices/${device.deviceId}`, host.token, undefined, "DELETE");
  await emit();
  assert.equal(notices.length, 1);
});
