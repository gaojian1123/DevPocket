import { z } from "zod";
import { canonical, requireValue, sha } from "./handoff.mjs";

export const MAX_SETUP_REQUEST = 36369;
const marker = "DEVPOCKET_HOST_RESULT=";
const id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const targetSchema = z.object({
  vmVerified: z.literal(true), ownerVerified: z.literal(true), releaseId: digest,
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), containerId: z.string().regex(/^[a-f0-9]{12,64}$/),
  databasePath: z.literal("/srv/devpocket/relay/relay.sqlite"),
}).strict();
const envelopeSchema = z.object({
  metadata: z.object({
    protocol: z.literal("DevPocketHostHandoff/1"), scopeHash: digest, vmId: z.string(),
    operationId: id, nonce: digest, recipientSha256: digest, expiresAt: z.number(),
    hostId: id, configSha256: digest,
  }).strict(),
  nonce: z.string().max(4096), tag: z.string().max(4096),
  wrappedKey: z.string().max(4096), ciphertext: z.string().max(4096),
}).strict();
const results = z.discriminatedUnion("status", [
  z.object({ status: z.literal("relay_discovered"), scopeHash: digest, target: targetSchema,
    relayUrl: z.string().url(), sameNameCount: z.number().int().nonnegative(), schemaVersion: z.number().int() }).strict(),
  z.object({ status: z.literal("host_registered"), scopeHash: digest, target: targetSchema,
    hostId: id, duplicate: z.boolean(), recovered: z.boolean(), envelope: envelopeSchema }).strict(),
  z.object({ status: z.literal("handoff_cleaned"), scopeHash: digest, target: targetSchema,
    hostId: id, handoffRemoved: z.literal(true), hostRetained: z.literal(true),
    logAudit: z.object({ files: z.number().int().positive(), bytes: z.number().int().nonnegative(),
      skipped: z.literal(0), hostTokenMatches: z.literal(0), privateKeyMatches: z.literal(0), complete: z.literal(true) }).strict() }).strict(),
  z.object({ status: z.literal("failed"), scopeHash: digest, code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/) }).strict(),
]);

export function parseSetupResult(raw, scope, action) {
  const text = (raw.value ?? []).map((item) => String(item.message ?? "")).join("\n");
  requireValue(!/dph_[A-Za-z0-9_-]{43}|-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(text), "SECRET_OUTPUT");
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith(marker));
  requireValue(lines.length === 1 && Buffer.byteLength(lines[0]) < 3800, "SETUP_RESULT_UNREADABLE");
  const result = results.parse(JSON.parse(lines[0].slice(marker.length)));
  requireValue(result.scopeHash === scope.scopeHash, "SETUP_RESULT_SCOPE_MISMATCH");
  if (result.status === "failed") throw new Error(`SETUP_GUEST_FAILED_${result.code}`);
  const expected = { discover: "relay_discovered", register: "host_registered", finalize: "handoff_cleaned" };
  requireValue(result.status === expected[action], "SETUP_RESULT_PHASE_MISMATCH");
  if (action !== "discover") {
    requireValue(result.target.releaseId === scope.releaseId && result.target.imageId === scope.imageId &&
      result.target.containerId === scope.containerId, "SETUP_RELAY_CHANGED");
  } else {
    const url = new URL(result.relayUrl);
    requireValue(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === "/" && url.origin === result.relayUrl, "SETUP_RELAY_URL_INVALID");
  }
  if (action === "register") {
    const metadata = result.envelope.metadata;
    requireValue(metadata.hostId === result.hostId && metadata.scopeHash === scope.scopeHash &&
      metadata.vmId === scope.vmId && metadata.operationId === scope.operationId && metadata.nonce === scope.nonce &&
      metadata.recipientSha256 === scope.recipientSha256 && metadata.expiresAt === scope.expiresAt, "HANDOFF_BINDING");
  }
  return result;
}

export function renderSetupAction(assets, scope, action, acknowledgement) {
  requireValue(["discover", "register", "finalize"].includes(action), "SETUP_ACTION_DENIED");
  const payload = { scope, action, publicKeyPem: scope.publicKeyPem, nodeBundle: assets.cloudHost, acknowledgement };
  requireValue(assets.guest.includes("__DEVPOCKET_HOST_PAYLOAD__"), "SETUP_GUEST_TEMPLATE_INVALID");
  const script = assets.guest.replace("__DEVPOCKET_HOST_PAYLOAD__", Buffer.from(JSON.stringify(payload)).toString("base64"));
  const body = { commandId: "RunShellScript", script: ["#!/bin/sh", "set -eu", "umask 077",
    "timeout --kill-after=10s 75s python3 - <<'DEVPOCKET_HOST_HELPER'", script, "DEVPOCKET_HOST_HELPER"] };
  requireValue(Buffer.byteLength(JSON.stringify(body)) <= MAX_SETUP_REQUEST, "SETUP_REQUEST_TOO_LARGE");
  return body;
}

export async function runSetupAction(context, action, scope, acknowledgement) {
  const { state, azure, save, assets, now = Date.now, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = context;
  const body = renderSetupAction(assets, scope, action, acknowledgement);
  const requestHash = sha(JSON.stringify(body));
  const readResult = (raw) => {
    const result = parseSetupResult(raw, scope, action);
    if (action === "finalize") requireValue(result.hostId === acknowledgement?.hostId, "HANDOFF_ACKNOWLEDGEMENT");
    return result;
  };
  let operation = state.operations[action];
  if (operation) {
    requireValue(operation.requestHash === requestHash && operation.scopeHash === scope.scopeHash &&
      sha(JSON.stringify(operation.body)) === requestHash, "SETUP_SAVED_REQUEST_CHANGED");
    if (operation.status === "settled")
      return readResult({ value: [{ message: marker + JSON.stringify(operation.result) }] });
    requireValue(operation.status !== "failed", `SETUP_ACTION_FAILED: ${action} requires operator inspection; no operation was repeated.`);
  } else {
    requireValue(now() < scope.expiresAt, "SETUP_APPROVAL_EXPIRED");
    operation = state.operations[action] = { status: "prepared", scopeHash: scope.scopeHash, requestHash, body };
    await save();
  }
  let response;
  if (operation.status === "prepared") {
    requireValue(now() < scope.expiresAt, "SETUP_APPROVAL_EXPIRED");
    await azure.verify(state.target);
    operation.status = "submitting";
    await save();
    try {
      response = await azure.arm(`${scope.vmId}/runCommand?api-version=2024-07-01`, { method: "POST", body: operation.body });
      operation.pollUrl = response.headers.get("azure-asyncoperation") || undefined;
      operation.resultUrl = response.headers.get("location") || undefined;
      operation.status = "accepted";
      operation.response = response.value;
      operation.httpStatus = response.status;
      await save();
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.message)
        ? error.message : "MANAGEMENT_OR_CHECKPOINT_FAILURE";
      throw new Error(`SETUP_ACTION_UNCERTAIN: ${action} may still be running (${code}). Rerun setup to read its saved Azure operation; no POST will be repeated.`);
    }
  }
  if (operation.pollUrl) azure.url(operation.pollUrl, state.target.subscriptionId);
  if (operation.resultUrl) azure.url(operation.resultUrl, state.target.subscriptionId);
  const finish = async (raw) => {
    let result;
    try { result = readResult(raw); }
    catch (error) {
      operation.status = "failed";
      operation.error = /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "SETUP_RESULT_INVALID";
      delete operation.response;
      await save();
      throw new Error(operation.error);
    }
    operation.status = "settled";
    operation.result = result;
    delete operation.response;
    await save();
    return result;
  };
  if (Array.isArray(operation.response?.value)) return finish(operation.response);
  const pollUrl = operation.pollUrl || operation.resultUrl;
  requireValue(pollUrl, `SETUP_ACTION_UNCERTAIN: ${action} has no saved result URL. Inspect Azure Run Command before any new enrollment; retain this setup directory.`);
  const deadline = now() + 240_000;
  while (now() < deadline) {
    await pause(5000);
    const current = await azure.arm(pollUrl);
    if (["Failed", "Canceled"].includes(current.value.status)) {
      operation.status = "failed";
      operation.error = `AZURE_OPERATION_${current.value.status.toUpperCase()}`;
      await save();
      throw new Error(operation.error);
    }
    if (Array.isArray(current.value.value)) return finish(current.value);
    if (current.value.status === "Succeeded") {
      requireValue(operation.resultUrl, "SETUP_RESULT_URL_REQUIRED");
      return finish((await azure.arm(operation.resultUrl)).value);
    }
  }
  throw new Error("SETUP_POLL_TIMEOUT: Rerun setup to read this same operation. No command was submitted again.");
}

export function scopeHash(scope) {
  const { scopeHash: _hash, ...value } = scope;
  return sha(canonical(value));
}
