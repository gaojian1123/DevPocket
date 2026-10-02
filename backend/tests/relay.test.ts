import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { startRelay } from "../src/relay.js";
import { provisionHost } from "../src/store.js";

test("only a provisioned host can issue a one-time device pairing credential", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const dataDir = await mkdtemp(path.resolve(".data/tests/relay-"));
  const relay = await startRelay({ dataDir, allowInsecureLoopback: true, port: 0 });
  t.after(async () => { await relay.close(); await rm(dataDir, { recursive: true, force: true }); });
  const host = provisionHost(dataDir, "Development Box");
  const post = (url: string, body: object, token?: string) => fetch(relay.url + url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  assert.equal((await post("/v1/host/pairings", {}, "unprovisioned")).status, 401);
  const pairingResponse = await post("/v1/host/pairings", {}, host.token);
  assert.equal(pairingResponse.status, 201);
  const pairing = await pairingResponse.json() as { code: string };
  assert.ok(pairing.code.length >= 40);
  const paired = await post("/v1/pair", { code: pairing.code, name: "My Android" });
  assert.equal(paired.status, 201);
  const device = await paired.json() as { token: string; deviceId: string };
  assert.notEqual(device.token, host.token);
  const catalog = await fetch(relay.url + "/v1/catalog", {
    headers: { Authorization: `Bearer ${device.token}` },
  });
  assert.equal(catalog.status, 200);
  assert.equal((await catalog.json() as { hosts: { id: string }[] }).hosts[0]?.id, host.hostId);
  assert.equal((await post("/v1/pair", { code: pairing.code, name: "Replay" })).status, 401);
  assert.equal((await fetch(relay.url + "/v1/catalog")).status, 401);
});
