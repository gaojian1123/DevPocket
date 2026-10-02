import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createPublicKey } from "node:crypto";
import { sha, REAL_MAX_REQUEST_BYTES, REAL_PROTOCOL } from "./real-archive.mjs";
import { REAL_ACTIONS, realWire } from "./real-plan.mjs";

const save = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
export async function renderRealAction(root, plan, expiresAt, action, details = {}) {
  const spec = REAL_ACTIONS[action];
  const allowed = action === "begin" ? ["envelope"] : action === "chunk" ? ["index", "data"] : [];
  if (!spec || Object.keys(details).some((key) => !allowed.includes(key)) ||
      allowed.some((key) => !(key in details))) throw new Error("REAL_ACTION_DENIED");
  if (action === "chunk" && (!Number.isInteger(details.index) || details.index < 0 ||
      details.index >= Math.ceil(plan.business.archiveBytes / 4096) || typeof details.data !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(details.data) ||
      Buffer.from(details.data, "base64").length !== Math.min(4096, plan.business.archiveBytes - details.index * 4096)))
    throw new Error("REAL_CHUNK_SCOPE");
  if (action === "begin") {
    const envelope = details.envelope, metadata = envelope?.metadata;
    const expected = { protocol: REAL_PROTOCOL, planHash: plan.planHash, vmId: plan.allowedVmId, transferId: plan.transferId,
      packageSha256: plan.business.archiveSha256, manifestSha256: plan.business.manifestSha256,
      expiresAt, transportSourceHash: plan.sourceHash, archiveBytes: plan.business.archiveBytes,
      algorithm: "RSA-OAEP-SHA256+A256GCM", chunkBytes: 4096 };
    if (!metadata || Object.keys(metadata).length !== Object.keys(expected).length + 1 ||
        Object.entries(expected).some(([key, value]) => metadata[key] !== value) ||
        !/^[a-f0-9]{64}$/.test(metadata.publicKeySha256) ||
        Object.keys(envelope).sort().join(",") !== "chunks,ciphertextSha256,metadata,nonce,tag,wrappedKey" ||
        !Array.isArray(envelope.chunks) || envelope.chunks.length !== Math.ceil(plan.business.archiveBytes / 4096) ||
        !/^[a-f0-9]{64}$/.test(envelope.ciphertextSha256) ||
        Buffer.from(envelope.nonce, "base64").length !== 12 || Buffer.from(envelope.tag, "base64").length !== 16 ||
        Buffer.from(envelope.wrappedKey, "base64").length !== 384 ||
        envelope.chunks.some((item, index) => item.bytes !== Math.min(4096, plan.business.archiveBytes - index * 4096) ||
          !/^[a-f0-9]{64}$/.test(item.sha256) || Object.keys(item).sort().join(",") !== "bytes,sha256"))
      throw new Error("REAL_ENVELOPE_SCOPE");
  }
  const payload = { plan: realWire(plan, expiresAt), action, ...details };
  const template = await readFile(path.join(root, "deployment", "azure", "real", spec.script), "utf8");
  const script = template.replace("__DEVPOCKET_REAL_PAYLOAD__", Buffer.from(JSON.stringify(payload)).toString("base64"));
  if (script === template || script.includes("__DEVPOCKET_REAL_PAYLOAD__")) throw new Error("REAL_TEMPLATE");
  const body = { commandId: "RunShellScript", script: ["#!/bin/sh", "set -eu", "umask 077",
    `timeout --kill-after=10s ${spec.seconds + 15}s python3 - <<'DEVPOCKET_REAL_RECEIVER'`, script, "DEVPOCKET_REAL_RECEIVER"] };
  const bytes = Buffer.byteLength(JSON.stringify(body));
  if (bytes > REAL_MAX_REQUEST_BYTES) throw new Error(`MEASURED_INPUT_LIMIT: ${bytes} exceeds ${REAL_MAX_REQUEST_BYTES}. A new non-sensitive capacity review is required.`);
  return { body, bytes, spec };
}

export function realResult(raw, forbidden = []) {
  const messages = (raw.value ?? []).map((item) => String(item.message ?? "")).join("\n");
  if (/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(messages) || forbidden.some((value) => value && messages.includes(value)))
    throw new Error("PROHIBITED_OUTPUT: raw ARM result was not persisted.");
  const lines = messages.split(/\r?\n/).filter((line) => line.startsWith("DEVPOCKET_REAL_RESULT="));
  if (lines.length !== 1) throw new Error("NO_UNIQUE_REAL_RESULT: inspect the settled operation, do not resubmit.");
  const value = lines[0].slice("DEVPOCKET_REAL_RESULT=".length);
  if (Buffer.byteLength(value) > 3200) throw new Error("RESULT_BUDGET");
  let result;
  try { result = JSON.parse(value); } catch { throw new Error("INVALID_REAL_RESULT"); }
  const fields = {
    ready: ["targetVerified", "dependenciesInstalled"],
    recipient_ready: ["publicKeyPem", "publicKeySha256", "rsaBits", "rootOnly"],
    duplicate_envelope: [], envelope_accepted: ["chunkCount"],
    duplicate_chunk: ["index", "sha256"], chunk_accepted: ["index", "sha256"],
    archive_authenticated: ["sha256", "fileCount", "duplicate"],
    transfer_log_audit: ["files", "bytes", "skipped", "matches", "scopeFiles", "completeForVisibleScope", "boundary"],
    transfer_cleaned: ["directoryAbsent"],
    bootstrap_verified: ["dataDiskGiB", "ownerVerified"],
    release_imported: ["packageSha256", "authenticatedLocalArchive", "blobUsed"],
    image_built: ["imageId", "caddyImage", "blobUsed"],
    service_activated: ["internalHealth", "autostart", "publicTlsVerified", "phonePairingVerified"],
    control_log_audit: ["files", "bytes", "sourceFragmentMatches", "skipped", "scopeFiles", "completeForVisibleScope", "protectedBuildLogsExported", "boundary"],
    failed: ["code", "cleanup", "databaseRolledBack", "unrelatedResourcesRemoved"],
  }[result.status];
  if (!fields || Object.keys(result).some((key) => key !== "status" && !fields.includes(key))) throw new Error("RESULT_SCHEMA");
  const optional = result.status === "archive_authenticated" ? ["fileCount"] :
    result.status === "failed" ? ["cleanup", "databaseRolledBack", "unrelatedResourcesRemoved"] : [];
  if (fields.some((key) => !optional.includes(key) && !(key in result))) throw new Error("RESULT_SCHEMA");
  for (const [key, item] of Object.entries(result)) {
    if (key === "status") continue;
    if (key === "publicKeyPem") {
      const pub = createPublicKey(item);
      if (pub.asymmetricKeyType !== "rsa" || pub.asymmetricKeyDetails.modulusLength !== 3072 ||
          pub.export({ type: "spki", format: "pem" }).trim() !== item.trim()) throw new Error("RESULT_PUBLIC_KEY");
    } else if (["sha256", "publicKeySha256", "packageSha256"].includes(key)) {
      if (!/^[a-f0-9]{64}$/.test(item)) throw new Error("RESULT_HASH");
    } else if (["imageId", "caddyImage"].includes(key)) {
      if (!/^[a-z0-9/.:@_-]{1,180}$/.test(item) || !item.includes("sha256:")) throw new Error("RESULT_IMAGE_ID");
    } else if (key === "boundary") {
      if (!["Selected guest handler/script/stdout/stderr; no guarantee for Azure backend, admins or all encodings",
        "Selected handler/stdout/stderr only; not all Azure/backend/future logs or administrator secrecy"].includes(item))
        throw new Error("RESULT_BOUNDARY");
    } else if (key === "code") {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(item)) throw new Error("RESULT_ERROR_CODE");
    } else if (key === "matches") {
      if (!item || Object.entries(item).some(([name, count]) => !["privateKey", "contentKey", "archive", "sourceFragments"].includes(name) ||
          !Number.isSafeInteger(count) || count < 0)) throw new Error("RESULT_MATCH_COUNTS");
    } else if (key === "scopeFiles") {
      if (!item || Object.entries(item).some(([name, count]) => !["handler", "scripts", "output"].includes(name) ||
          !Number.isSafeInteger(count) || count < 0)) throw new Error("RESULT_LOG_SCOPES");
    } else if (key === "cleanup") {
      if (!item || !["transfer_cleaned", "requires-settled-explicit-cleanup"].includes(item.status) ||
          Object.keys(item).some((name) => !["status", "directoryAbsent"].includes(name))) throw new Error("RESULT_CLEANUP");
    } else if (typeof item !== "boolean" && (!Number.isSafeInteger(item) || item < 0 || item > 20 * 1024 * 1024)) {
      throw new Error("RESULT_PUBLIC_SCALAR");
    }
  }
  return result;
}

export async function actionOnce(ctx, action, details = {}) {
  const spec = REAL_ACTIONS[action];
  if (!spec) throw new Error("REAL_ACTION_DENIED");
  await ctx.authorize([spec.phase]);
  await ctx.verifyTarget();
  const rendered = await renderRealAction(ctx.root, ctx.plan, ctx.expiresAt, action, details);
  const operations = path.join(ctx.directory, "operations");
  await mkdir(operations, { recursive: true, mode: 0o700 });
  const existing = (await readdir(operations)).filter((name) => name.endsWith(".json")).sort();
  if (existing.length >= ctx.plan.policy.maxActions) throw new Error("REAL_ACTION_BUDGET");
  if (existing.length) {
    const previous = JSON.parse(await readFile(path.join(operations, existing.at(-1)), "utf8"));
    if (!["settled", "not-submitted"].includes(previous.state))
      throw new Error("PREVIOUS_ACTION_UNSETTLED: only read-only status is allowed.");
  }
  const lease = path.join(ctx.directory, "action.inflight");
  const id = randomUUID();
  await writeFile(lease, id, { flag: "wx", mode: 0o600 });
  const receipt = { operationId: id, action, vmId: ctx.plan.allowedVmId, planHash: ctx.plan.planHash,
    requestSha256: sha(JSON.stringify(rendered.body)), requestBytes: rendered.bytes, postCount: 0,
    startedAt: new Date().toISOString(), scriptSeconds: spec.seconds, state: "prepared-not-submitted" };
  const file = path.join(operations, `${String(existing.length + 1).padStart(2, "0")}-${action}-${id}.json`);
  await save(file, receipt);
  try {
    await ctx.authorize([spec.phase]);
    receipt.postCount = 1;
    receipt.state = "submitting";
    await save(file, receipt);
    let response = await ctx.api.arm(ctx.plan.allowedVmId + "/runCommand?api-version=2024-07-01", { method: "POST", body: rendered.body });
    receipt.azureAsyncOperation = response.headers.get("azure-asyncoperation");
    receipt.resultLocation = response.headers.get("location");
    receipt.azureRequestId = response.headers.get("x-ms-request-id");
    receipt.state = "accepted";
    await save(file, receipt);
    const get = async (uri) => {
      const url = new URL(uri);
      if (url.origin !== "https://management.azure.com" ||
          !url.pathname.toLowerCase().startsWith(`/subscriptions/${ctx.plan.target.subscriptionId}/`.toLowerCase())) throw new Error("ACTION_POLL_SCOPE");
      return ctx.api.arm(url.pathname + url.search);
    };
    let raw = response.value;
    if (response.status === 202 || receipt.azureAsyncOperation || receipt.resultLocation) {
      if (!receipt.azureAsyncOperation && !receipt.resultLocation) throw new Error("MISSING_ACTION_OPERATION_ID");
      const deadline = Date.now() + (spec.seconds + 600) * 1000;
      let finished = false;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        response = await get(receipt.azureAsyncOperation || receipt.resultLocation);
        receipt.lastAzureState = response.value.status ?? response.status;
        await save(file, receipt);
        if (["Failed", "Canceled"].includes(response.value.status)) {
          receipt.state = "azure-failed";
          throw new Error("AZURE_ACTION_FAILED: no automatic retry or state rollback.");
        }
        if (response.value.status === "Succeeded" || Array.isArray(response.value.value)) {
          raw = receipt.resultLocation ? (await get(receipt.resultLocation)).value : response.value;
          finished = true;
          break;
        }
      }
      if (!finished) throw new Error("ACTION_RESULT_UNCERTAIN: read the recorded operation status; never retry a long POST.");
    }
    receipt.state = "settled-output-unverified";
    receipt.azureExecutionSettled = true;
    await save(file, receipt);
    receipt.result = realResult(raw, ctx.forbidden);
    const expected = {
      inspect: ["ready"], init: ["recipient_ready"], begin: ["envelope_accepted", "duplicate_envelope"],
      chunk: ["chunk_accepted", "duplicate_chunk"], authenticate: ["archive_authenticated"],
      "transfer-audit": ["transfer_log_audit"], "cleanup-transfer": ["transfer_cleaned"],
      bootstrap: ["bootstrap_verified"], import: ["release_imported"], build: ["image_built"],
      activate: ["service_activated"], "control-audit": ["control_log_audit"],
    }[action];
    if (receipt.result.status !== "failed" && !expected.includes(receipt.result.status)) throw new Error("PHASE_RESULT_MISMATCH");
    receipt.state = "settled";
    receipt.finishedAt = new Date().toISOString();
    receipt.outputForbiddenMatches = 0;
    await save(file, receipt);
    if (receipt.result.status === "failed") throw new Error(`REAL_PHASE_FAILED:${receipt.result.code}. Inspect safe state; do not repeat automatically.`);
    return receipt.result;
  } catch (error) {
    if (receipt.postCount === 0) receipt.state = "not-submitted";
    else if (receipt.state !== "settled") receipt.state = "uncertain";
    receipt.error = { name: /^[A-Za-z0-9_]{1,80}$/.test(error.name) ? error.name : "OperationError",
      code: /^[A-Z][A-Z0-9_]+(?::|$)/.test(error.message) ? error.message.split(":")[0] : "MANAGEMENT_OPERATION_FAILED",
      httpStatus: error.status ?? error.statusCode ?? null };
    await save(file, receipt);
    throw new Error(`${receipt.error.code}: inspect sanitized phase/operation state, not raw request output.`);
  } finally {
    if (["settled", "not-submitted"].includes(receipt.state)) await unlink(lease);
  }
}
