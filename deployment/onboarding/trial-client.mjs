import { randomUUID } from "node:crypto";
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { context, hostFetch, protectedConfig } from "./commission.mjs";
import { requireValue } from "./handoff.mjs";

const save = (file, value, exclusive = true) => writeFile(file, JSON.stringify(value, null, 2) + "\n",
  { flag: exclusive ? "wx" : "w", mode: 0o600 });
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
async function deviceRequest(config, token, route, { body, method = "GET", acceptFailure = false } = {}) {
  const response = await fetch(new URL(route, config.relayUrl), {
    method, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000),
  });
  if (acceptFailure) return response.status;
  requireValue(response.ok, "DEVICE_HTTPS_REJECTED_" + response.status);
  return response.json();
}
async function history(config, token, scoped) {
  const result = [];
  let cursor = 0;
  for (let page = 0; page < 20; page++) {
    const data = await deviceRequest(config, token, `${scoped}/events?after=${cursor}`);
    requireValue(Array.isArray(data.events) && Number.isSafeInteger(data.cursor), "HISTORY_PAGE");
    if (data.reset) result.length = 0;
    result.push(...data.events);
    if (!data.hasMore) return result;
    requireValue(data.cursor > cursor, "HISTORY_CURSOR");
    cursor = data.cursor;
  }
  throw new Error("HISTORY_BOUND");
}
async function until(readValue, accept, ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await readValue();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("TRIAL_OBSERVATION_TIMEOUT");
}
async function revoke(ctx, config, local) {
  const file = path.join(local.privateDirectory, "temporary-device.local.json");
  const device = await read(file);
  requireValue(device.scopeHash === ctx.scope.scopeHash && device.hostId === config.hostId, "TEMP_DEVICE_SCOPE");
  await hostFetch(config, `/v1/host/devices/${device.deviceId}`, { method: "DELETE" });
  const remaining = await hostFetch(config, "/v1/host/devices");
  requireValue(!remaining.devices.some(d => d.id === device.deviceId), "TEMP_DEVICE_NOT_REVOKED");
  const catalog = await deviceRequest(config, device.token, "/v1/catalog");
  requireValue(!catalog.hosts.some(h => h.id === config.hostId) &&
    !catalog.sessions.some(s => s.hostId === config.hostId), "REVOKED_DEVICE_STILL_AUTHORIZED");
  await unlink(file);
  const proof = { scopeHash: ctx.scope.scopeHash, deviceId: device.deviceId, deviceName: device.name,
    revokedHostGrant: true, noHostOrSessionAccess: true, temporaryCredentialFileRemoved: true,
    permanentHostRetained: true, at: new Date().toISOString() };
  await save(path.join(ctx.directory, "temporary-device-cleanup.json"), proof);
  return proof;
}
async function smoke(ctx) {
  const trial = await read(path.join(ctx.directory, "trial.json"));
  requireValue(trial.scopeHash === ctx.scope.scopeHash, "TRIAL_SCOPE");
  const { config, local } = await protectedConfig(ctx);
  const file = path.join(local.privateDirectory, "temporary-device.local.json");
  requireValue(!await lstat(file).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; }), "CLEAN_PREVIOUS_TEMP_DEVICE_FIRST");
  const pairing = await hostFetch(config, "/v1/host/pairings", { method: "POST" });
  const response = await fetch(config.relayUrl + "/v1/pair", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: pairing.code, name: "DevPocket temporary public proof" }),
    redirect: "error", signal: AbortSignal.timeout(20000),
  });
  requireValue(response.ok, "TEMP_PAIRING_FAILED");
  const issued = await response.json();
  requireValue(issued.hostId === config.hostId && /^dpd_[A-Za-z0-9_-]{43}$/.test(issued.token), "TEMP_DEVICE_RESPONSE");
  const device = { ...issued, scopeHash: ctx.scope.scopeHash, name: "DevPocket temporary public proof" };
  await save(file, device);
  const report = { scopeHash: ctx.scope.scopeHash, simulatedDevice: true, physicalAndroidTested: false,
    hostId: config.hostId, sessionId: trial.sessionId, startedAt: new Date().toISOString() };
  let socket;
  try {
    const catalog = await until(() => deviceRequest(config, device.token, "/v1/catalog"),
      value => value.sessions.some(s => s.sessionId === trial.sessionId && s.hostId === config.hostId && s.online));
    const session = catalog.sessions.find(s => s.sessionId === trial.sessionId && s.hostId === config.hostId);
    requireValue(catalog.hosts.some(h => h.id === config.hostId && h.online) &&
      session.cliVersion === "1.0.90-0" && session.permissionMode === "manual" && session.capabilities.messages, "ORIGINAL_CLI_CAPABILITY_OR_PERMISSION");
    report.session = { sessionId: session.sessionId, title: session.title, projectName: session.projectName,
      projectId: session.projectId, cliVersion: session.cliVersion, permissionMode: session.permissionMode,
      online: session.online, capabilities: session.capabilities, warnings: session.warnings };
    const registration = await read(path.join(config.dataDir, config.hostId, trial.sessionId, "registration.json"));
    requireValue(registration.sessionId === trial.sessionId && registration.recordedCliVersion === "1.0.90-0" &&
      Number.isSafeInteger(registration.parentPid) && registration.parentPid > 0, "ORIGINAL_PARENT_IDENTITY");
    report.runtime = registration;
    const scoped = `/v1/hosts/${config.hostId}/sessions/${trial.sessionId}`;
    const early = await until(() => history(config, device.token, scoped),
      events => events.some(e => e.kind === "assistant.message" && e.data.content.trim() === trial.marker + "_EARLY"));
    const initial = early.find(e => e.kind === "assistant.message" && e.data.content.trim() === trial.marker + "_EARLY");
    report.earlyHistory = { markerMatched: true, messageId: initial.data.messageId, at: initial.at };
    const frames = [];
    const url = new URL("/v1/events", config.relayUrl.replace(/^https:/, "wss:"));
    url.searchParams.set("hostId", config.hostId); url.searchParams.set("sessionId", trial.sessionId);
    url.searchParams.set("after", String(Math.max(0, ...early.map(e => e.cursor))));
    socket = new WebSocket(url, { headers: { Authorization: `Bearer ${device.token}` }, handshakeTimeout: 20000, maxPayload: 1024 * 1024 });
    let socketError;
    socket.on("error", () => { socketError = true; });
    socket.on("message", bytes => {
      try {
        const frame = JSON.parse(bytes.toString());
        if (frame.type === "events" && Array.isArray(frame.events)) frames.push(...frame.events);
      } catch { socketError = true; }
    });
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", () => reject(new Error("PUBLIC_WSS_CONNECT"))); });
    const commandId = randomUUID(), marker = "DP_PUBLIC_" + randomUUID().replaceAll("-", "");
    report.commandId = commandId;
    await save(path.join(ctx.directory, "roundtrip-intent.json"), { scopeHash: ctx.scope.scopeHash, commandId,
      hostId: config.hostId, sessionId: trial.sessionId, marker, at: new Date().toISOString() });
    const submitted = await deviceRequest(config, device.token, scoped + "/commands", { method: "POST",
      body: { commandId, action: { type: "message", attachmentIds: [],
        text: `Connectivity trial only. Do not use tools, inspect or modify files, or change settings. Reply with ${marker} followed by the initial DevPocket marker you remember (without the _EARLY suffix).` } } });
    report.initialDelivery = submitted.status;
    const receipt = await until(() => deviceRequest(config, device.token, scoped + "/commands/" + commandId),
      value => ["completed", "failed", "uncertain", "cancelled"].includes(value.status), 180000);
    requireValue(receipt.status === "completed", "PUBLIC_COMMAND_NOT_COMPLETED");
    const events = await history(config, device.token, scoped);
    const answers = events.filter(e => e.kind === "assistant.message" && e.data.content.includes(marker));
    requireValue(answers.length === 1 && answers[0].data.content.includes(trial.marker), "PUBLIC_RESPONSE_OR_EARLY_MEMORY");
    await until(async () => frames, value => value.some(e => e.kind === "assistant.message" && e.data.content.includes(marker)), 20000);
    requireValue(!socketError, "PUBLIC_WSS_ERROR");
    const afterRegistration = await read(path.join(config.dataDir, config.hostId, trial.sessionId, "registration.json"));
    requireValue(afterRegistration.parentPid === registration.parentPid &&
      afterRegistration.extensionPid === registration.extensionPid && afterRegistration.sessionId === registration.sessionId, "RUNTIME_WAS_REPLACED");
    report.roundtrip = { receiptStatus: receipt.status, originatingMessageId: receipt.result?.messageId,
      assistantMessageId: answers[0].data.messageId, responseCount: answers.length, rememberedEarlyMarker: true,
      receivedViaAuthenticatedWss: true, originalSessionAndPidsUnchanged: true };
    report.status = "passed";
  } catch (error) {
    report.status = "failed"; report.error = /^[A-Z0-9_]+$/.test(error.message) ? error.message : "TRIAL_FAILED";
  } finally {
    if (socket) { socket.close(); socket.terminate(); }
    try { report.cleanup = await revoke(ctx, config, local); }
    catch { report.cleanup = { status: "NOT_CONFIRMED_CREDENTIAL_RETAINED_FOR_RECOVERY" }; report.status = "failed"; }
    report.finishedAt = new Date().toISOString();
    await save(path.join(ctx.directory, "roundtrip-result.json"), report);
  }
  console.log(JSON.stringify(report, null, 2));
  requireValue(report.status === "passed", "PUBLIC_TRIAL_INCOMPLETE");
}
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { directory: { type: "string" } } });
  const ctx = await context(values.directory);
  if (positionals[0] === "prepare") {
    const trial = { scopeHash: ctx.scope.scopeHash, sessionId: randomUUID(),
      marker: "DP_ORIGINAL_" + randomUUID().replaceAll("-", ""), cliName: "DevPocket cloud trial",
      cwd: ctx.scope.projectPath, expectedVersion: "1.0.90-0" };
    await save(path.join(ctx.directory, "trial.json"), trial);
    console.log(JSON.stringify(trial));
  } else if (positionals[0] === "smoke") await smoke(ctx);
  else if (positionals[0] === "cleanup-device") {
    const { config, local } = await protectedConfig(ctx);
    console.log(JSON.stringify(await revoke(ctx, config, local)));
  } else throw new Error("TRIAL_COMMAND_DENIED");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : "TRIAL_CLIENT_FAILED"); process.exitCode = 1; });
