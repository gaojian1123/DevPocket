import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Receipt, type Action } from "../src/protocol.js";
import { readHistory } from "./history.js";
import {
  beginCliCheck, cliProofRequest, proofArguments, readCliIdentity, readCliProof, requireExactShellPermission,
  requireManualCli, verifyCliAttachment,
} from "./cli-proof.js";

const { values, positionals, directory } = proofArguments({});
if (values["confirm-runtime-checks"] !== true) throw new Error("Real CLI cancellation requires --confirm-runtime-checks for this disposable proof.");
if (positionals.length) throw new Error("Unexpected positional arguments.");
const proof = await readCliProof(directory);
const request = cliProofRequest(proof);
const out = path.join(proof.workspace, ".data", `shell-cancel-${randomUUID()}`);
const commands: { commandId: string; action: Action; receipt?: z.infer<typeof Receipt> }[] = [];
const result: Record<string, unknown> = { runId: proof.runId, startedAt: new Date().toISOString(), status: "running", commands };
const check = await beginCliCheck(proof, "cancellation", result);
const persist = async () => check.save(result);
const prefix = `/v1/hosts/${proof.hostId}/sessions/${proof.sessionId}`;
const events = async () => readHistory(request, prefix);
async function send(action: Action) {
  await readCliIdentity(proof);
  await requireManualCli(proof);
  const command: (typeof commands)[number] = { commandId: randomUUID(), action };
  commands.push(command);
  await persist();
  const receipt = Receipt.parse(await request(prefix + "/commands", command));
  command.receipt = receipt;
  await persist();
  return receipt;
}
async function until<T>(fn: () => Promise<T | undefined>, label: string, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};
try {
  const { registration } = await verifyCliAttachment(proof);
  await requireManualCli(proof, true);
  result.cliVersion = registration.recordedCliVersion;
  await mkdir(out, { recursive: true });
  const script = path.join(out, "shell-wait.mjs");
  await copyFile(path.resolve("backend", "integration", "shell-wait.mjs"), script);
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const shell = `& ${literal(process.execPath)} ${literal(script)} ${literal(out)}`;
  await send({ type: "message", text: `For this isolated cancellation validation, call the built-in powershell tool once with mode sync and initial_wait 120 to run exactly: ${shell}\nThe helper only writes its own PID and heartbeat files under this disposable workspace .data, waits 180 seconds, and starts one bounded child. Do not detach, modify the command, invoke other tools, change permissions, or start unrelated work. Wait for my cancellation.`, attachmentIds: [] });
  const permission = await until(async () => {
    const latest = (await events()).filter((event) => event.kind === "requests").at(-1);
    return latest?.kind === "requests" ? latest.data.items.find((item) => item.type === "permission") : undefined;
  }, "safe shell permission");
  requireExactShellPermission(permission, shell);
  result.permissionRequest = permission.requestId;
  const approval = await send({ type: "permission", requestId: permission.requestId, decision: "approve-once" });
  await until(async () => {
    const receipt = Receipt.parse(await request(prefix + "/commands/" + approval.commandId));
    if (["failed", "uncertain", "cancelled"].includes(receipt.status)) throw new Error(JSON.stringify(receipt));
    return receipt.status === "completed" ? true : undefined;
  }, "approval decision");
  const pids = await until(async () => {
    try {
      return z.object({ parentPid: z.number().int().positive(), childPid: z.number().int().positive(), startedAt: z.string().datetime() })
        .parse(JSON.parse(await readFile(path.join(out, "pids.local.json"), "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }, "actual built-in shell and child startup");
  assert.ok(alive(pids.parentPid) && alive(pids.childPid), "Both real helper processes must be alive before cancellation.");
  result.pids = pids;
  await persist();
  console.log("[cancel] actual shell parent and child running", JSON.stringify(pids));
  const queued = await send({ type: "message", text: `After the current task has ended, reply ${proof.marker}_QUEUED_AFTER_STOP. Do not run tools.`, attachmentIds: [] });
  result.queuedBeforeStop = await until(async () => {
    const receipt = Receipt.parse(await request(prefix + "/commands/" + queued.commandId));
    if (["completed", "failed", "uncertain", "cancelled"].includes(receipt.status)) throw new Error("The test message was not observed queued: " + JSON.stringify(receipt));
    return receipt.status === "queued" ? receipt : undefined;
  }, "runtime queue admission");
  const stopAt = new Date().toISOString();
  const stop = await send({ type: "abort" });
  result.stopCommand = stop.commandId;
  result.queuedCommand = queued.commandId;
  result.stopAt = stopAt;
  const stopped = await until(async () => {
    const receipt = Receipt.parse(await request(prefix + "/commands/" + stop.commandId));
    result.receipt = receipt;
    if (["failed", "uncertain", "cancelled"].includes(receipt.status)) throw new Error(JSON.stringify(receipt));
    return receipt.status === "completed" ? receipt : undefined;
  }, "runtime idle cancellation evidence", 30_000);
  result.receipt = stopped;
  result.queuedReceipt = await until(async () => {
    const receipt = Receipt.parse(await request(prefix + "/commands/" + queued.commandId));
    if (["completed", "failed", "uncertain"].includes(receipt.status)) throw new Error(JSON.stringify(receipt));
    return receipt.status === "cancelled" ? receipt : undefined;
  }, "observed queue cancellation", 30_000);
  result.idleEvidence = await until(async () => (await events()).find((event) => event.kind === "runtime.state" &&
    event.data.state === "idle" && event.data.aborted === true && event.at >= stopAt), "aborted runtime idle event", 30_000);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  result.parentAliveAfterStop = alive(pids.parentPid);
  result.childAliveAfterStop = alive(pids.childPid);
  assert.equal(result.parentAliveAfterStop, false, "Built-in shell parent survived cancellation");
  assert.equal(result.childAliveAfterStop, false, "Built-in shell child survived cancellation");
  const followup = `${proof.marker}_AFTER_ABORT_WORKS`;
  await send({ type: "message", text: `Reply exactly ${followup}. Do not use tools.`, attachmentIds: [] });
  await until(async () => (await events()).some((event) => event.kind === "assistant.message" &&
    event.at >= stopAt && event.data.content === followup) ? true : undefined, "same runtime after abort");
  await readCliIdentity(proof);
  await requireManualCli(proof);
  result.status = "passed";
  console.log("[cancel] runtime idle, real parent/child exit and same-session follow-up verified");
} catch (error) {
  result.status = "failed";
  result.error = error instanceof Error ? error.message : String(error);
  console.error("[cancel]", result.error);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  try { await persist(); } finally { await check.close(); }
}
