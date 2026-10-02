import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Action, PendingRequest, Receipt, type WireEvent } from "../src/protocol.js";
import { HostConfig } from "../src/bridge.js";
import { readHistory } from "./history.js";

const proof = z.object({ root: z.string(), hostId: z.string(), sessionId: z.string(), relayUrl: z.string(),
  deviceToken: z.string(), marker: z.string(), hostConfigPath: z.string() })
  .parse(JSON.parse(await readFile(".data/active-proof.local.json", "utf8")));
const scoped = `/v1/hosts/${proof.hostId}/sessions/${proof.sessionId}`;
const results: { name: string; at: string; details?: unknown }[] = [];
async function note(name: string, details?: unknown) {
  results.push({ name, at: new Date().toISOString(), details });
  await writeFile(path.join(proof.root, "live-checks.json"), JSON.stringify(results, null, 2));
  console.log(`[live] ${name}${details ? ` ${JSON.stringify(details)}` : ""}`);
}
async function request(route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(proof.relayUrl + route, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${proof.deviceToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
async function until<T>(fn: () => Promise<T | undefined>, label: string, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${label}`);
}
const history = async (): Promise<WireEvent[]> => readHistory(request, scoped);
async function send(action: z.infer<typeof Action>, commandId = randomUUID()): Promise<z.infer<typeof Receipt>> {
  return Receipt.parse(await request(scoped + "/commands", { commandId, action }));
}
async function finish(commandId: string): Promise<z.infer<typeof Receipt>> {
  return until(async () => {
    const receipt = Receipt.parse(await request(scoped + "/commands/" + commandId));
    return ["completed", "failed", "uncertain", "cancelled"].includes(receipt.status) ? receipt : undefined;
  }, `command ${commandId}`);
}
async function pending(): Promise<z.infer<typeof PendingRequest>[]> {
  const event = (await history()).filter((event) => event.kind === "requests").at(-1);
  return event?.kind === "requests" ? event.data.items : [];
}
async function prompt(text: string): Promise<string> {
  const receipt = await send({ type: "message", text, attachmentIds: [] });
  return receipt.commandId;
}
async function permissions(marker: string) {
  const receiptId = await prompt(`This is a safe isolated integration test. Use the built-in powershell tool exactly once to run this exact command: Write-Output '${marker}'. Do not invoke another tool, do not change permission rules, and do not add arguments, paths, files, delays, or network activity. After it executes, reply exactly ${marker}_DONE.`);
  const request = await until(async () => (await pending()).find((item) => item.type === "permission"), "actual terminal permission");
  assert.equal(request.supported, true, request.detail);
  assert.ok(request.detail.includes(marker), request.detail);
  return { receiptId, request };
}

try {
  const before = JSON.parse(await readFile(path.join(proof.root, "before-attachment.evidence.json"), "utf8")) as { parentPid: number; sessionId: string };
  const registration = JSON.parse(await readFile(path.join(proof.root, "bridge", proof.hostId, proof.sessionId, "registration.json"), "utf8")) as {
    parentPid: number; sessionId: string; attachedAt: string; recordedCliVersion: string;
  };
  assert.equal(registration.parentPid, before.parentPid);
  assert.equal(registration.sessionId, before.sessionId);
  const old = (await history()).find((event) => event.kind === "assistant.message" && event.data.content === `${proof.marker}_READY`);
  assert.ok(old);
  assert.ok(Date.parse(old.at) < Date.parse(registration.attachedAt));
  await note("same-process-and-pre-attachment-history", { parentPid: before.parentPid, sessionId: before.sessionId, eventId: old.id, eventAt: old.at,
    attachedAt: registration.attachedAt, version: registration.recordedCliVersion });
  await until(async () => (await history()).some((event) => event.kind === "assistant.message" && event.data.content.includes("DP_FROM_RELAY_READY")) ? true : undefined, "remote reply");
  await note("relay-command-to-original-runtime");
  const models = await finish((await send({ type: "models" })).commandId);
  assert.equal(models.status, "completed", JSON.stringify(models));
  const catalog = z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean(), reasoningEfforts: z.array(z.string()) }))
    .parse(models.result?.models);
  await note("live-model-catalog", { count: catalog.length, models: catalog.map((model) => ({ id: model.id, efforts: model.reasoningEfforts })) });
  const chosen = catalog.find((item) => item.id === "gpt-5-mini" && item.enabled);
  if (chosen) {
    const changed = await finish((await send({ type: "model.set", modelId: chosen.id,
      reasoningEffort: "low" })).commandId);
    assert.equal(changed.status, "completed", JSON.stringify(changed));
    await note("model-control-on-disposable-runtime", changed.result);
  }
  const first = await permissions("DP_REMOTE_APPROVAL");
  const approved = await finish((await send({ type: "permission", requestId: first.request.requestId, decision: "approve-once" })).commandId);
  assert.equal(approved.status, "completed", JSON.stringify(approved));
  const duplicate = await finish((await send({ type: "permission", requestId: first.request.requestId, decision: "approve-once" })).commandId);
  assert.equal(duplicate.status, "failed");
  assert.equal(duplicate.error?.code, "REQUEST_STALE");
  assert.equal((await finish(first.receiptId)).status, "completed");
  await note("phone-first-approval-and-stale-rejection", { requestId: first.request.requestId });
  const questionMessage = await prompt("For this isolated test, call the ask_user tool with exactly one question: Choose the DevPocket test answer. Offer exactly two choices: Alpha and Beta. Do not run any other tool. After I answer, reply DP_QUESTION_ followed by my exact answer.");
  const question = await until(async () => (await pending()).find((item) => item.type === "question"), "actual ask_user request");
  const answered = await finish((await send({ type: "answer", requestId: question.requestId, answer: "Alpha" })).commandId);
  assert.equal(answered.status, "completed", JSON.stringify(answered));
  assert.equal((await finish(questionMessage)).status, "completed");
  await note("actual-question-roundtrip", { requestId: question.requestId });
  const second = await permissions("DP_TERMINAL_APPROVAL");
  await writeFile(path.join(proof.root, "terminal-approval.local.json"), JSON.stringify(second, null, 2));
  await note("waiting-for-terminal-first-approval", { requestId: second.request.requestId });
  await until(async () => (await pending()).some((item) => item.requestId === second.request.requestId) ? undefined : true,
    "explicit terminal approval", 180_000);
  const stale = await finish((await send({ type: "permission", requestId: second.request.requestId, decision: "approve-once" })).commandId);
  assert.equal(stale.status, "failed");
  assert.equal(stale.error?.code, "REQUEST_STALE");
  assert.equal((await finish(second.receiptId)).status, "completed");
  await note("terminal-first-approval-and-stale-phone-rejection");
  const terminalScope = await request("/v1/catalog") as { sessions: { sessionId: string; permissionMode: string }[] };
  assert.equal(terminalScope.sessions.find((session) => session.sessionId === proof.sessionId)?.permissionMode, "manual");
  const hostConfig = HostConfig.parse(JSON.parse(await readFile(proof.hostConfigPath, "utf8")));
  assert.equal(hostConfig.relayUrl, proof.relayUrl);
  await note("manual-permission-mode-preserved");
} catch (error) {
  await note("FAILED", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
