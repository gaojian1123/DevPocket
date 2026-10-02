import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import WebSocket from "ws";
import { startRelay } from "../src/relay.js";
import { provisionHost } from "../src/store.js";

export async function fixture(t: TestContext, now?: () => number) {
  await mkdir(".data/tests", { recursive: true });
  const dataDir = await mkdtemp(path.resolve(".data/tests/protocol-"));
  const relay = await startRelay({ dataDir, allowInsecureLoopback: true, port: 0, now });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = (route: string, token?: string, body?: unknown, method = body ? "POST" : "GET") =>
    fetch(relay.url + route, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  async function pair(hostToken: string, deviceToken?: string) {
    const pairing = await (await request("/v1/host/pairings", hostToken, {})).json() as { code: string };
    return await (await request("/v1/pair", deviceToken, { code: pairing.code, name: "Test Android" }))
      .json() as { token: string; deviceId: string; hostId: string };
  }
  function socket(route: string, token: string) {
    const ws = new WebSocket(relay.url.replace("http:", "ws:") + route, { headers: { Authorization: `Bearer ${token}` } });
    sockets.push(ws);
    return ws;
  }
  const host = (name = "Dev Box") => provisionHost(dataDir, name);
  return { ...relay, dataDir, request, pair, socket, host };
}

export function nextFrame(socket: WebSocket, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timeout waiting for ${kind}`)); }, 3000);
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onMessage = (bytes: WebSocket.RawData) => {
      const frame = JSON.parse(bytes.toString()) as Record<string, unknown>;
      if (frame.type === kind) { cleanup(); resolve(frame); }
    };
    const cleanup = () => { clearTimeout(timer); socket.off("error", onError); socket.off("message", onMessage); };
    socket.on("error", onError);
    socket.on("message", onMessage);
  });
}

export async function wireHost(socket: WebSocket, sessionId: string) {
  if (socket.readyState !== WebSocket.OPEN) await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve); socket.once("error", reject);
  });
  const hello = nextFrame(socket, "ready");
  socket.send(JSON.stringify({ type: "hello", protocol: 1, summary: {
    sessionId, projectId: "test-project", projectName: "Test project", title: "Existing CLI",
    cliVersion: "1.0.90-0", state: "idle", permissionMode: "manual", modelId: "test-model",
    reasoningEffort: "", capabilities: {
      messages: true, abort: true, permissions: true, questions: true, models: true, files: true, git: true,
    },
    warnings: [], registeredAt: Date.now(),
  } }));
  await hello;
}

export const sessionPath = (hostId: string, sessionId: string) =>
  `/v1/hosts/${hostId}/sessions/${sessionId}`;
export const newId = randomUUID;
