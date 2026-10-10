import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { startAndroidFixture } from "../integration/android-fixture.js";
import type { EventPage, Receipt } from "../src/protocol.js";

test("the Android fixture pairs over real HTTP and preserves one invocation across retry and reconnect", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/android-fixture-"));
  const fixture = await startAndroidFixture(path.join(directory, "owned"));
  t.after(async () => { await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const paired = await fetch(`${fixture.url}/v1/pair`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: fixture.pairingCode, name: "Fixture phone" }),
  });
  assert.equal(paired.status, 201);
  const phone = await paired.json() as { token: string; hostId: string };
  const headers = { Authorization: `Bearer ${phone.token}`, "Content-Type": "application/json" };
  const scoped = `${fixture.url}/v1/hosts/${phone.hostId}/sessions/${fixture.sessionId}`;
  const command = { commandId: randomUUID(), action: { type: "message", text: "fixture hello", attachmentIds: [] } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${scoped}/commands`, { method: "POST", headers, body: JSON.stringify(command) });
    assert.equal(response.status, 202);
  }
  let receipt: Receipt | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    receipt = await (await fetch(`${scoped}/commands/${command.commandId}`, { headers })).json() as Receipt;
    if (receipt.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(receipt?.status, "completed");
  await fixture.reconnect();
  const replay = await (await fetch(`${scoped}/events`, { headers })).json() as EventPage;
  assert.equal(replay.events.filter((event) => event.kind === "user.message" && event.data.content === "fixture hello").length, 1);
  assert.ok(replay.events.some((event) => event.kind === "assistant.message" && event.data.content === "Fixture reply: fixture hello"));
  assert.equal(fixture.invocations(), 1);
});
