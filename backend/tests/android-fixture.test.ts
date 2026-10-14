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

test("phone question history survives confirmed answers, immutable retry and bridge reconnect through public HTTP", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/question-history-"));
  const fixture = await startAndroidFixture(path.join(directory, "owned"));
  t.after(async () => { await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const paired = await fetch(`${fixture.url}/v1/pair`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: fixture.pairingCode, name: "Question history fixture" }),
  });
  const phone = await paired.json() as { token: string; hostId: string };
  const headers = { Authorization: `Bearer ${phone.token}`, "Content-Type": "application/json" };
  const scoped = `${fixture.url}/v1/hosts/${phone.hostId}/sessions/${fixture.sessionId}`;
  const post = (command: object) => fetch(`${scoped}/commands`, { method: "POST", headers, body: JSON.stringify(command) });
  const events = async () => await (await fetch(`${scoped}/events`, { headers })).json() as EventPage;
  for (const [kind, answer, visibleAnswer] of [
    ["choice", "Beta", "Beta"],
    ["text", "完整的自由文本\nsecond line", "完整的自由文本\nsecond line"],
    ["text", "\u001b[31m", "[REDACTED]"],
    ["text", " \n\t\u0000\u001b[31m ", "[REDACTED]"],
    ["form", "Beta", "Beta"],
    ["race", "Beta", "Beta"],
    ["uncertain", "Beta", "Beta"],
  ]) {
    await post({ commandId: randomUUID(), action: { type: "message", text: `native fixture ask ${kind}`, attachmentIds: [] } });
    let page: EventPage | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      page = await events();
      if (page.events.some((event) => event.kind === "requests" &&
        event.data.items.some((item) => item.detail.includes(`Fixture ${kind} question`)))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const request = page?.events.filter((event) => event.kind === "requests").at(-1)?.data.items
      .find((item) => item.type === "question");
    assert.ok(request?.supported, "The real adapter must expose a supported native question.");
    const expectedStatus = kind === "race" ? "failed" : kind === "uncertain" ? "uncertain" : "completed";
    const command = { commandId: randomUUID(), action: { type: "answer", requestId: request.requestId, answer } };
    assert.equal((await post(command)).status, 202);
    let receipt: Receipt | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      receipt = await (await fetch(`${scoped}/commands/${command.commandId}`, { headers })).json() as Receipt;
      if (receipt.status === expectedStatus) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(receipt?.status, expectedStatus);
    assert.equal(receipt?.result?.resolved, expectedStatus === "completed" ? true : undefined);
    page = await events();
    const history = page.events.filter((event) => event.kind === "question" && event.data.status === "confirmed" &&
      event.data.commandId === command.commandId);
    assert.equal(history.length, expectedStatus === "completed" ? 1 : 0);
    if (expectedStatus === "completed") {
      assert.equal(history[0]?.data.status === "confirmed" && history[0].data.answer, visibleAnswer);
      assert.deepEqual(history[0]?.data.request, request);
    } else {
      assert.equal(page.events.filter((event) => event.kind === "question" &&
        event.data.request.requestId === request.requestId).at(-1)?.data.status, "unknown");
    }
    assert.ok(!page.events.filter((event) => event.kind === "requests").at(-1)?.data.items.some((item) => item.requestId === request.requestId));
    assert.ok(!page.events.some((event) => event.kind === "assistant.message" && event.data.content.includes(answer)));
    assert.ok(!JSON.stringify(page.events).includes("\\u001b"));
    assert.equal((await post(command)).status, 202);
    assert.equal((await post({ ...command, action: { ...command.action, answer: "Changed content" } })).status, 409);
  }
  await fixture.reconnect();
  const replay = await events();
  const confirmed = replay.events.filter((event) => event.kind === "question" && event.data.status === "confirmed");
  assert.equal(confirmed.length, 5);
  assert.equal(confirmed.filter((event) => event.data.status === "confirmed" && event.data.answer === "[REDACTED]").length, 2);
  assert.equal(fixture.answers(), 7);
  assert.equal(fixture.invocations(), 7);
});
