import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { requireValue, sha } from "./handoff.mjs";

export const MAX_BODY = 36369;
const actions = ["inspect", "register", "finalize"];
const save = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
export function requireHostApproval(scope, approval, action) {
  requireValue(approval && approval.scopeHash === scope.scopeHash, "HOST_APPROVAL_REQUIRED");
  requireValue(actions.includes(action) && approval.phases?.includes("host-" + action), "HOST_PHASE_DENIED");
  requireValue(Date.now() < approval.expiresAt && approval.expiresAt === scope.expiresAt &&
    approval.expiresAt - approval.issuedAt <= 4 * 3600_000, "HOST_APPROVAL_EXPIRED");
}
export async function renderAction(root, scope, action, acknowledgement) {
  requireValue(actions.includes(action), "HOST_ACTION_DENIED");
  const built = await build({ entryPoints: [path.join(root, "deployment", "onboarding", "cloud-host.mjs")],
    bundle: true, platform: "node", format: "esm", write: false, minifyWhitespace: true, minifySyntax: true,
    external: ["/app/dist/store.js"], logLevel: "silent" });
  const nodeBundle = built.outputFiles[0].text;
  const payload = { scope, publicKeyPem: scope.publicKeyPem, action, nodeBundle, acknowledgement };
  const template = await readFile(path.join(root, "deployment", "onboarding", "guest.py"), "utf8");
  const script = template.replace("__DEVPOCKET_HOST_PAYLOAD__", Buffer.from(JSON.stringify(payload)).toString("base64"));
  const body = { commandId: "RunShellScript", script: ["#!/bin/sh", "set -eu", "umask 077",
    "timeout --kill-after=10s 75s python3 - <<'DEVPOCKET_HOST_HELPER'", script, "DEVPOCKET_HOST_HELPER"] };
  requireValue(Buffer.byteLength(JSON.stringify(body)) <= MAX_BODY, "MEASURED_ACTION_LIMIT");
  return body;
}
export function parseResult(raw, scope) {
  const text = (raw.value ?? []).map((r) => String(r.message ?? "")).join("\n");
  requireValue(!/dph_[A-Za-z0-9_-]{43}|-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(text), "SECRET_OUTPUT");
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith("DEVPOCKET_HOST_RESULT="));
  requireValue(lines.length === 1 && Buffer.byteLength(lines[0]) < 3800, "UNSAFE_RESULT");
  const result = JSON.parse(lines[0].slice("DEVPOCKET_HOST_RESULT=".length));
  const fields = {
    registration_ready: ["scopeHash", "status", "sameNameCount", "schemaVersion", "target"],
    host_registered: ["scopeHash", "status", "hostId", "duplicate", "recovered", "envelope", "target"],
    handoff_cleaned: ["scopeHash", "status", "hostId", "handoffRemoved", "hostRetained", "logAudit", "target"],
    failed: ["scopeHash", "status", "code"],
  }[result.status];
  requireValue(result.scopeHash === scope.scopeHash && fields &&
    Object.keys(result).sort().join() === [...fields].sort().join(), "UNSAFE_RESULT");
  if (result.status === "failed") {
    requireValue(/^[A-Z][A-Z0-9_]{0,79}$/.test(result.code), "UNSAFE_RESULT");
    return result;
  }
  const target = result.target;
  requireValue(target && Object.keys(target).sort().join() === "containerId,databasePath,imageId,ownerVerified,releaseId,vmVerified" &&
    target.vmVerified === true && target.ownerVerified === true && target.imageId === scope.imageId &&
    target.releaseId === scope.releaseId && /^[a-f0-9]{12,64}$/.test(target.containerId) &&
    target.databasePath === "/srv/devpocket/relay/relay.sqlite", "UNSAFE_RESULT");
  if (result.status === "registration_ready") {
    requireValue(Number.isSafeInteger(result.sameNameCount) && result.sameNameCount >= 0 &&
      Number.isSafeInteger(result.schemaVersion) && result.schemaVersion > 0, "UNSAFE_RESULT");
  } else requireValue(/^[a-f0-9-]{36}$/.test(result.hostId), "UNSAFE_RESULT");
  if (result.status === "host_registered") {
    const envelope = result.envelope, metadata = envelope?.metadata;
    requireValue(typeof result.duplicate === "boolean" && typeof result.recovered === "boolean" && envelope &&
      Object.keys(envelope).sort().join() === "ciphertext,metadata,nonce,tag,wrappedKey" &&
      metadata?.scopeHash === scope.scopeHash && metadata.hostId === result.hostId &&
      metadata.operationId === scope.operationId && metadata.vmId === scope.vmId &&
      metadata.nonce === scope.nonce && metadata.recipientSha256 === scope.recipientSha256 &&
      metadata.expiresAt === scope.expiresAt &&
      ["nonce", "tag", "wrappedKey", "ciphertext"].every((k) => typeof envelope[k] === "string" &&
        envelope[k].length <= 2500 && /^[A-Za-z0-9+/]+={0,2}$/.test(envelope[k])), "UNSAFE_RESULT");
  }
  if (result.status === "handoff_cleaned") {
    const audit = result.logAudit;
    requireValue(result.handoffRemoved === true && result.hostRetained === true && audit &&
      Object.keys(audit).sort().join() === "bytes,complete,files,hostTokenMatches,privateKeyMatches,skipped" &&
      audit.complete === true && audit.hostTokenMatches === 0 && audit.privateKeyMatches === 0 &&
      audit.skipped === 0 && Number.isSafeInteger(audit.files) && Number.isSafeInteger(audit.bytes), "UNSAFE_RESULT");
  }
  return result;
}
async function readOperation(ctx, uri) {
  const url = new URL(uri);
  requireValue(url.origin === "https://management.azure.com" &&
    url.pathname.toLowerCase().startsWith(`/subscriptions/${ctx.scope.subscriptionId}/`.toLowerCase()), "ACTION_POLL_SCOPE");
  for (let attempt = 0; ; attempt++) {
    try { return await ctx.api.arm(url.pathname + url.search); }
    catch (error) {
      if (attempt || error.name !== "CredentialUnavailableError") throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}
async function finish(ctx, receipt, file, raw) {
  receipt.result = parseResult(raw, ctx.scope);
  const expected = { inspect: "registration_ready", register: "host_registered", finalize: "handoff_cleaned" };
  requireValue(receipt.result.status === "failed" || receipt.result.status === expected[receipt.action], "ACTION_RESULT_PHASE");
  receipt.state = "settled"; receipt.finishedAt = new Date().toISOString();
  await save(file, receipt);
  await unlink(path.join(ctx.directory, "action.inflight")).catch((e) => { if (e.code !== "ENOENT") throw e; });
  return receipt.result;
}
export async function runAction(ctx, action, acknowledgement) {
  await ctx.authorize(action);
  await ctx.verify();
  const operations = path.join(ctx.directory, "operations");
  await mkdir(operations, { recursive: true });
  const existing = (await readdir(operations)).filter((n) => n.endsWith(".json")).sort();
  requireValue(existing.length < ctx.scope.maxActions, "ACTION_BUDGET");
  if (existing.length) {
    const last = JSON.parse(await readFile(path.join(operations, existing.at(-1)), "utf8"));
    requireValue(["settled", "not-submitted"].includes(last.state), "PREVIOUS_ACTION_UNSETTLED");
  }
  const body = await ctx.render(action, acknowledgement);
  const requestBytes = Buffer.byteLength(JSON.stringify(body));
  requireValue(requestBytes <= MAX_BODY, "MEASURED_ACTION_LIMIT");
  const lease = path.join(ctx.directory, "action.inflight"), id = randomUUID();
  await writeFile(lease, id, { flag: "wx" });
  const receipt = { operationId: id, scopeHash: ctx.scope.scopeHash, vmId: ctx.scope.vmId, action,
    requestBytes, requestSha256: sha(JSON.stringify(body)), postCount: 0, state: "prepared",
    startedAt: new Date().toISOString() };
  const file = path.join(operations, `${String(existing.length + 1).padStart(2, "0")}-${action}-${id}.json`);
  await save(file, receipt);
  try {
    await ctx.authorize(action);
    receipt.state = "submitting"; receipt.postCount = 1; await save(file, receipt);
    let response = await ctx.api.arm(ctx.scope.vmId + "/runCommand?api-version=2024-07-01", { method: "POST", body });
    receipt.azureAsyncOperation = response.headers.get("azure-asyncoperation");
    receipt.resultLocation = response.headers.get("location");
    receipt.azureRequestId = response.headers.get("x-ms-request-id");
    receipt.state = "accepted"; await save(file, receipt);
    let raw = response.value;
    if (response.status === 202 || receipt.azureAsyncOperation || receipt.resultLocation) {
      requireValue(receipt.azureAsyncOperation || receipt.resultLocation, "MISSING_OPERATION_URI");
      const until = Date.now() + 240_000;
      while (true) {
        requireValue(Date.now() < until, "ACTION_POLL_TIMEOUT");
        await new Promise((resolve) => setTimeout(resolve, 5000));
        response = await readOperation(ctx, receipt.azureAsyncOperation || receipt.resultLocation);
        receipt.azureState = response.value.status ?? response.status; await save(file, receipt);
        requireValue(!["Failed", "Canceled"].includes(response.value.status), "AZURE_ACTION_FAILED");
        if (response.value.status === "Succeeded" || Array.isArray(response.value.value)) {
          raw = receipt.resultLocation ? (await readOperation(ctx, receipt.resultLocation)).value : response.value;
          break;
        }
      }
    }
    return await finish(ctx, receipt, file, raw);
  } catch (error) {
    receipt.state = receipt.postCount ? "uncertain" : "not-submitted";
    receipt.error = { code: /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "MANAGEMENT_OPERATION_FAILED",
      name: /^[A-Za-z0-9_]+$/.test(error.name) ? error.name : "Error" };
    await save(file, receipt);
    if (!receipt.postCount) await unlink(lease);
    throw new Error(receipt.postCount ? "ACTION_UNCERTAIN: use status; do not repeat POST" : "ACTION_NOT_SUBMITTED");
  }
}
export async function actionStatus(ctx) {
  const operations = path.join(ctx.directory, "operations");
  const names = (await readdir(operations)).filter((n) => n.endsWith(".json")).sort();
  requireValue(names.length, "NO_OPERATION");
  const file = path.join(operations, names.at(-1)), receipt = JSON.parse(await readFile(file, "utf8"));
  requireValue(receipt.scopeHash === ctx.scope.scopeHash && receipt.vmId === ctx.scope.vmId, "OPERATION_SCOPE");
  if (receipt.state === "settled") return receipt.result;
  requireValue(receipt.azureAsyncOperation || receipt.resultLocation, "UNKNOWN_SUBMISSION_REQUIRES_READONLY_INSPECTION");
  const state = await readOperation(ctx, receipt.azureAsyncOperation || receipt.resultLocation);
  if (state.value.status !== "Succeeded" && !Array.isArray(state.value.value))
    return { status: "not-settled", azureState: state.value.status ?? state.status };
  const raw = receipt.resultLocation ? (await readOperation(ctx, receipt.resultLocation)).value : state.value;
  return finish(ctx, receipt, file, raw);
}
