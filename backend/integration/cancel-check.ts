import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Receipt, type WireEvent } from "../src/protocol.js";
import { readHistory } from "./history.js";

const proof = z.object({ root: z.string(), workspace: z.string(), hostId: z.string(), sessionId: z.string(),
  deviceToken: z.string(), relayUrl: z.string() }).parse(JSON.parse(await readFile(".data/active-proof.local.json", "utf8")));
const out = path.join(proof.workspace, ".data", `shell-cancel-${Date.now()}`);
await mkdir(out, { recursive: true });
const result: Record<string, unknown> = { startedAt: new Date().toISOString(), status: "running" };
const resultFile = path.join(proof.root, "cancellation.json");
const persist = async () => writeFile(resultFile, JSON.stringify(result, null, 2));
const prefix = `/v1/hosts/${proof.hostId}/sessions/${proof.sessionId}`;
async function request(route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(proof.relayUrl + route, { method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${proof.deviceToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
const events = async () => readHistory(request, prefix);
async function send(action: object) {
  return Receipt.parse(await request(prefix + "/commands", { commandId: randomUUID(), action }));
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
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  const script = path.join(out, "shell-wait.mjs");
  await copyFile(path.resolve("backend", "integration", "shell-wait.mjs"), script);
  const shell = `& '${process.execPath}' '${script}' '${out}'`;
  await send({ type: "message", text: `For this isolated cancellation validation, call the built-in powershell tool once with mode sync and initial_wait 120 to run exactly: ${shell}\nThe helper only writes its own PID and heartbeat files under this disposable workspace .data, waits 180 seconds, and starts one bounded child. Do not detach, modify the command, invoke other tools, change permissions, or start unrelated work. Wait for my cancellation.`, attachmentIds: [] });
  const permission = await until(async () => {
    const latest = (await events()).filter((event) => event.kind === "requests").at(-1);
    return latest?.kind === "requests" ? latest.data.items.find((item) => item.type === "permission" && item.detail.includes("shell-wait.mjs")) : undefined;
  }, "safe shell permission");
  assert.equal(permission.supported, true, permission.detail);
  result.permissionRequest = permission.requestId;
  const approval = await send({ type: "permission", requestId: permission.requestId, decision: "approve-once" });
  await until(async () => {
    const receipt = Receipt.parse(await request(prefix + "/commands/" + approval.commandId));
    if (receipt.status === "failed") throw new Error(JSON.stringify(receipt));
    return receipt.status === "completed" ? true : undefined;
  }, "approval decision");
  const pids = await until(async () => {
    try {
      return z.object({ parentPid: z.number(), childPid: z.number(), startedAt: z.string() })
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
  const queued = await send({ type: "message", text: "After the current task has ended, reply DP_QUEUED_AFTER_STOP. Do not run tools.", attachmentIds: [] });
  const stopAt = new Date().toISOString();
  const stop = await send({ type: "abort" });
  result.stopCommand = stop.commandId;
  result.queuedCommand = queued.commandId;
  result.stopAt = stopAt;
  const stopped = await until(async () => {
    const receipt = Receipt.parse(await request(prefix + "/commands/" + stop.commandId));
    if (receipt.status === "failed") throw new Error(JSON.stringify(receipt));
    return receipt.status === "completed" ? receipt : undefined;
  }, "runtime idle cancellation evidence", 30_000);
  result.receipt = stopped;
  result.queuedReceipt = await request(prefix + "/commands/" + queued.commandId);
  assert.equal(Receipt.parse(result.queuedReceipt).status, "cancelled", "Known queued input must not remain falsely queued after an observed abort.");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  result.parentAliveAfterStop = alive(pids.parentPid);
  result.childAliveAfterStop = alive(pids.childPid);
  assert.equal(result.parentAliveAfterStop, false, "Built-in shell parent survived cancellation");
  assert.equal(result.childAliveAfterStop, false, "Built-in shell child survived cancellation");
  await send({ type: "message", text: "Reply exactly DP_AFTER_ABORT_WORKS. Do not use tools.", attachmentIds: [] });
  await until(async () => (await events()).some((event) => event.kind === "assistant.message" &&
    event.at >= stopAt && event.data.content.includes("DP_AFTER_ABORT_WORKS")) ? true : undefined, "same runtime after abort");
  result.status = "passed";
  console.log("[cancel] runtime idle, real parent/child exit and same-session follow-up verified");
} catch (error) {
  result.status = "failed";
  result.error = error instanceof Error ? error.message : String(error);
  console.error("[cancel]", result.error);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  await persist();
}
