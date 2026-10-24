import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Action, PendingRequest, Receipt, utf16String, type WireEvent } from "../src/protocol.js";
import { readHistory } from "./history.js";
import {
  beginCliCheck, cliProofRequest, proofArguments, readCliIdentity, readCliProof, requireExactShellPermission,
  requireExactQuestion, requireManualCli, successfulShellEvidence, verifyCliAttachment,
} from "./cli-proof.js";

const { values, positionals, directory } = proofArguments({ model: { type: "string" }, reasoning: { type: "string" } });
if (values["confirm-runtime-checks"] !== true) throw new Error("Real CLI mutations require --confirm-runtime-checks for this disposable proof.");
if (positionals.length) throw new Error("Unexpected positional arguments.");
if (typeof values.model !== "string" || typeof values.reasoning !== "string") {
  throw new Error("Select an explicit --model and --reasoning for this disposable runtime. No model check is silently skipped.");
}
const modelId = utf16String(200).min(1).parse(values.model), reasoningEffort = utf16String(60).min(1).parse(values.reasoning);
const proof = await readCliProof(directory);
const request = cliProofRequest(proof);
const scoped = `/v1/hosts/${proof.hostId}/sessions/${proof.sessionId}`;
const results: { name: string; at: string; details?: unknown }[] = [];
const check = await beginCliCheck(proof, "live-checks", results);
async function note(name: string, details?: unknown) {
  results.push({ name, at: new Date().toISOString(), details });
  await check.save(results);
  console.log(`[live] ${name}${details ? ` ${JSON.stringify(details)}` : ""}`);
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
  await readCliIdentity(proof);
  await requireManualCli(proof);
  await note("command-dispatch", { commandId, action, outcome: "unconfirmed" });
  const receipt = Receipt.parse(await request(scoped + "/commands", { commandId, action }));
  await note("command-receipt", receipt);
  return receipt;
}
async function finish(commandId: string): Promise<z.infer<typeof Receipt>> {
  const receipt = await until(async () => {
    const receipt = Receipt.parse(await request(scoped + "/commands/" + commandId));
    return ["completed", "failed", "uncertain", "cancelled"].includes(receipt.status) ? receipt : undefined;
  }, `command ${commandId}`);
  await note("command-terminal-receipt", receipt);
  return receipt;
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
  const command = `Write-Output '${marker}'`;
  const cursor = (await history()).at(-1)?.cursor ?? 0;
  const receiptId = await prompt(`This is a safe isolated integration test. Use the built-in powershell tool exactly once to run this exact command:\n${command}\nDo not invoke another tool, do not change permission rules, and do not add arguments, paths, files, delays, or network activity. After it executes, reply exactly ${marker}_DONE.`);
  const request = await until(async () => (await pending()).find((item) => item.type === "permission"), "actual terminal permission");
  requireExactShellPermission(request, command);
  return { receiptId, request, cursor, marker };
}

try {
  const { before, registration } = await verifyCliAttachment(proof);
  await requireManualCli(proof, true);
  const old = (await history()).find((event) => event.kind === "assistant.message" && event.data.content === `${proof.marker}_READY`);
  assert.ok(old);
  assert.ok(Date.parse(old.at) < Date.parse(registration.attachedAt));
  await note("same-process-and-pre-attachment-history", { parentPid: before.parentPid, sessionId: before.sessionId, eventId: old.id, eventAt: old.at,
    attachedAt: registration.attachedAt, version: registration.recordedCliVersion });
  const reply = `${proof.marker}_FROM_RELAY`;
  const remotePrompt = `Reply exactly ${reply}. Do not use tools.`;
  assert.equal((await finish(await prompt(remotePrompt))).status, "completed");
  await until(async () => (await history()).some((event) => event.kind === "assistant.message" && event.data.content === reply) ? true : undefined, "remote reply");
  assert.equal((await history()).filter((event) => event.kind === "user.message" && event.data.content === remotePrompt).length, 1);
  await note("relay-command-to-original-runtime");
  const models = await finish((await send({ type: "models" })).commandId);
  assert.equal(models.status, "completed", JSON.stringify(models));
  const catalog = z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean(), reasoningEfforts: z.array(z.string()) }))
    .parse(models.result?.models);
  await note("live-model-catalog", { count: catalog.length, models: catalog.map((model) => ({ id: model.id, efforts: model.reasoningEfforts })) });
  const chosen = catalog.find((item) => item.id === modelId && item.enabled);
  assert.ok(chosen, "The explicitly selected model is not enabled in the live catalog.");
  assert.ok(!chosen.reasoningEfforts.length || chosen.reasoningEfforts.includes(reasoningEffort), "The requested effort contradicts the live catalog.");
  const changed = await finish((await send({ type: "model.set", modelId, reasoningEffort })).commandId);
  assert.equal(changed.status, "completed", JSON.stringify(changed));
  const observedModel = await finish((await send({ type: "models" })).commandId);
  assert.equal(observedModel.status, "completed", JSON.stringify(observedModel));
  assert.deepEqual(observedModel.result?.current, { modelId, reasoningEffort }, "Admission is not proof that model/effort selection took effect.");
  await note("model-control-on-disposable-runtime", observedModel.result?.current);
  const first = await permissions(`${proof.marker}_REMOTE_APPROVAL`);
  const approved = await finish((await send({ type: "permission", requestId: first.request.requestId, decision: "approve-once" })).commandId);
  assert.equal(approved.status, "completed", JSON.stringify(approved));
  const duplicate = await finish((await send({ type: "permission", requestId: first.request.requestId, decision: "approve-once" })).commandId);
  assert.equal(duplicate.status, "failed");
  assert.equal(duplicate.error?.code, "REQUEST_STALE");
  assert.equal((await finish(first.receiptId)).status, "completed");
  await until(async () => successfulShellEvidence(await history(), first.cursor, first.marker), "successful phone-approved shell execution", 15_000);
  await note("phone-first-approval-and-stale-rejection", { requestId: first.request.requestId });
  const questionText = `Choose the DevPocket test answer ${proof.marker}.`;
  const questionMessage = await prompt(`For this isolated test, call the ask_user tool with exactly one question: ${questionText} Offer exactly two choices: Alpha and Beta. Do not run any other tool. After I answer, reply ${proof.marker}_QUESTION_ followed by my exact answer.`);
  const question = await until(async () => (await pending()).find((item) => item.type === "question"), "actual ask_user request");
  requireExactQuestion(question, questionText);
  const answered = await finish((await send({ type: "answer", requestId: question.requestId, answer: "Alpha" })).commandId);
  assert.equal(answered.status, "completed", JSON.stringify(answered));
  assert.equal((await finish(questionMessage)).status, "completed");
  await until(async () => (await history()).some((event) => event.kind === "assistant.message" &&
    event.data.content === `${proof.marker}_QUESTION_Alpha`) ? true : undefined, "question reply");
  await note("actual-question-roundtrip", { requestId: question.requestId });
  const second = await permissions(`${proof.marker}_TERMINAL_APPROVAL`);
  await writeFile(path.join(proof.root, "terminal-approval.local.json"), JSON.stringify(second, null, 2), { flag: "wx", mode: 0o600 });
  await note("waiting-for-terminal-first-approval", { requestId: second.request.requestId });
  await until(async () => (await pending()).some((item) => item.requestId === second.request.requestId) ? undefined : true,
    "explicit terminal approval", 180_000);
  const stale = await finish((await send({ type: "permission", requestId: second.request.requestId, decision: "approve-once" })).commandId);
  assert.equal(stale.status, "failed");
  assert.equal(stale.error?.code, "REQUEST_STALE");
  assert.equal((await finish(second.receiptId)).status, "completed");
  await until(async () => successfulShellEvidence(await history(), second.cursor, second.marker), "successful terminal-approved shell execution", 15_000);
  await note("terminal-first-approval-and-stale-phone-rejection");
  await readCliIdentity(proof);
  await requireManualCli(proof, true);
  await note("manual-permission-mode-preserved");
  await note("PASSED", { runId: proof.runId, version: registration.recordedCliVersion, modelId, reasoningEffort });
} catch (error) {
  await note("FAILED", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await check.close();
}
