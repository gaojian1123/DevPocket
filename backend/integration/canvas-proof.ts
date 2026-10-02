import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { startRelay } from "../src/relay.js";
import { provisionHost } from "../src/store.js";
import { HostConfig } from "../src/bridge.js";
import { Action, type WireEvent } from "../src/protocol.js";
import { readHistory } from "./history.js";

const pointer = path.resolve(".data", "active-proof.local.json");
const command = process.argv[2] ?? "start";
const metadata = z.object({
  root: z.string(), workspace: z.string(), plugin: z.string(), sessionId: z.string(), hostId: z.string(),
  deviceToken: z.string(), relayUrl: z.string(), hostConfigPath: z.string(), marker: z.string(), startedAt: z.number(),
});
if (command === "start") {
  const root = path.resolve(".data", `canvas-proof-${Date.now()}`);
  const workspace = path.join(root, "workspace"), plugin = path.join(root, "plugin");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(plugin, "extensions"), { recursive: true });
  await writeFile(path.join(plugin, "plugin.json"), JSON.stringify({
    name: "devpocket-canvas-proof", version: "0.1.0", extensions: "./extensions",
  }, null, 2));
  const relay = await startRelay({ dataDir: path.join(root, "relay"), allowInsecureLoopback: true, port: 18879 });
  const host = provisionHost(path.join(root, "relay"), "DevPocket isolated CLI");
  const hostConfigPath = path.join(root, "host.local.json");
  await writeFile(hostConfigPath, JSON.stringify(HostConfig.parse({
    hostId: host.hostId, token: host.token, relayUrl: relay.url, dataDir: path.join(root, "bridge"), allowInsecureLoopback: true,
  })), { mode: 0o600 });
  const pair = await (await fetch(relay.url + "/v1/host/pairings", { method: "POST", headers: { Authorization: `Bearer ${host.token}` } })).json() as { code: string };
  const device = await (await fetch(relay.url + "/v1/pair", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pair.code, name: "Local proof controller" }),
  })).json() as { token: string };
  const proof = { root, workspace, plugin, sessionId: randomUUID(), hostId: host.hostId,
    deviceToken: device.token, relayUrl: relay.url, hostConfigPath, marker: `DP_ORIGINAL_${Date.now()}`, startedAt: Date.now() };
  await writeFile(pointer, JSON.stringify(proof, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ root, workspace, plugin, sessionId: proof.sessionId, marker: proof.marker, relayUrl: relay.url }));
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await relay.close();
    await writeFile(hostConfigPath, "{}");
    await writeFile(pointer, "{}");
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
} else {
  const proof = metadata.parse(JSON.parse(await readFile(pointer, "utf8")));
  const request = async (route: string, body?: unknown, token = proof.deviceToken) => {
    const response = await fetch(proof.relayUrl + route, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
    });
    const result: unknown = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
    return result;
  };
  const scoped = `/v1/hosts/${proof.hostId}/sessions/${proof.sessionId}`;
  if (command === "install") {
    const target = path.join(proof.plugin, "extensions", "devpocket");
    await mkdir(target);
    for (const file of ["extension.mjs", "bridge.mjs"]) await copyFile(path.resolve("dist", "extension", file), path.join(target, file));
    await writeFile(path.join(target, "connection.local.json"), JSON.stringify({ hostConfigPath: proof.hostConfigPath }), { mode: 0o600 });
    await writeFile(path.join(proof.root, "attachment-time.json"), JSON.stringify({ attachedFilesAt: Date.now() }));
    console.log("Own extension files installed into the disposable plugin only. Explicitly hot-load them in the EXISTING terminal.");
  } else if (command === "catalog") {
    console.log(JSON.stringify(await request("/v1/catalog"), null, 2));
  } else if (command === "events") {
    const result = { events: await readHistory(request, scoped) };
    await writeFile(path.join(proof.root, "visible-events.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result.events.slice(-Number(process.argv[3] ?? 16)), null, 2));
  } else if (command === "send") {
    const action = Action.parse(JSON.parse(process.argv[3] ?? "{}"));
    const commandId = randomUUID();
    console.log(JSON.stringify(await request(scoped + "/commands", { commandId, action }), null, 2));
  } else if (command === "receipt") {
    console.log(JSON.stringify(await request(scoped + "/commands/" + process.argv[3]), null, 2));
  } else if (command === "state") {
    const result = { events: await readHistory(request, scoped) };
    console.log(JSON.stringify(result.events.filter((event) => event.kind === "runtime.state" || event.kind === "requests").slice(-5), null, 2));
  } else if (command === "android") {
    const host = HostConfig.parse(JSON.parse(await readFile(proof.hostConfigPath, "utf8")));
    const pairing = await request("/v1/host/pairings", {}, host.token) as { code: string };
    await writeFile(path.resolve(".data", "android-proof.local.json"), JSON.stringify({
      relayUrl: "http://10.0.2.2:18879", pairingCode: pairing.code, sessionId: proof.sessionId,
      marker: `DP_NATIVE_ANDROID_${Date.now()}`,
    }), { mode: 0o600 });
    console.log("Five-minute native proof pairing written to ignored .data\\android-proof.local.json (not printed).");
  } else throw new Error("Unknown proof command.");
}
