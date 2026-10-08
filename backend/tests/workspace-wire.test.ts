import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { startBridge } from "../src/bridge.js";
import { HostFrame, RelayReady, SessionSummary, Workspace } from "../src/protocol.js";
import type { JoinedSession } from "../src/runtime.js";
import { secret } from "../src/security.js";
import { RelayStore } from "../src/store.js";
import { gitFixture } from "./git-fixture.js";
import { fixture, newId, nextFrame, wireHost } from "./harness.js";

function workspacePeer(root: string, sessionId = newId()): JoinedSession {
  return {
    sessionId, getEvents: async () => [], on: () => () => {},
    rpc: {
      permissions: { paths: { list: async () => ({ primary: root }) } },
      contentExclusion: { checkPaths: async ({ paths }) => ({
        available: true, checks: paths.map((file) => ({ path: file, excluded: false })),
      }) },
    },
  };
}

test("workspace wire fields are optional for legacy records and strictly bounded when present", () => {
  assert.deepEqual(Workspace.parse({ name: "task-worktree", branch: "" }), { name: "task-worktree", branch: "" });
  for (const workspace of [
    { name: "", branch: "main" }, { name: "a".repeat(121), branch: "main" },
    { name: "task", branch: "a".repeat(201) }, { name: "task" },
    { name: "task", branch: "main", path: "private-path" },
  ]) assert.equal(Workspace.safeParse(workspace).success, false);
  const ready = { type: "ready", protocol: 1, hostId: newId(), sessionId: newId() };
  assert.deepEqual(RelayReady.parse(ready), ready);
  assert.deepEqual(RelayReady.parse({ ...ready, workspaceMetadata: true }), { ...ready, workspaceMetadata: true });
  assert.equal(RelayReady.safeParse({ ...ready, workspaceMetadata: "true" }).success, false);
});

test("a new relay preserves strict legacy ready frames and persisted session records", async (t) => {
  const f = await fixture(t), host = f.host(), phone = await f.pair(host.token), sid = newId();
  const socket = f.socket(`/v1/host/stream?sessionId=${sid}`, host.token);
  const ready = nextFrame(socket, "ready");
  await wireHost(socket, sid);
  RelayReady.omit({ workspaceMetadata: true }).parse(await ready);
  const catalog = await (await f.request("/v1/catalog", phone.token)).json();
  const legacy = SessionSummary.strip().parse(catalog.sessions[0]);
  assert.equal(legacy.workspace, undefined);

  const store = new RelayStore(f.dataDir);
  try {
    store.metadata(host.hostId, sid, { title: "Mobile title", pinned: true, archived: true });
    store.touch(host.hostId, { ...legacy, projectId: "repository-identity", projectName: "Project",
      workspace: { name: "task", branch: "feature/grouping" } });
    const current = store.session(host.hostId, sid);
    assert.equal(current.sessionId, sid);
    assert.equal(current.title, "Mobile title");
    assert.equal(current.pinned, true);
    assert.equal(current.archived, true);
    assert.deepEqual(current.workspace, { name: "task", branch: "feature/grouping" });
    store.touch(host.hostId, legacy);
    assert.equal(store.session(host.hostId, sid).workspace, undefined);
    assert.equal(store.session(host.hostId, sid).pinned, true);
  } finally { store.close(); }
});

test("a new bridge and relay publish negotiated workspace metadata through the authorized catalog", async (t) => {
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  t.after(async () => { await bridge?.close(); });
  const f = await fixture(t), git = await gitFixture(t), host = f.host(), phone = await f.pair(host.token);
  const peer = workspacePeer(git.worktree);
  bridge = await startBridge(peer, {
    hostId: host.hostId, token: host.token, relayUrl: f.url,
    dataDir: path.join(f.dataDir, "bridge"), allowInsecureLoopback: true,
  });
  let summary: SessionSummary | undefined;
  for (let i = 0; i < 100; i++) {
    const catalog = await (await f.request("/v1/catalog", phone.token)).json();
    summary = SessionSummary.strip().parse(catalog.sessions[0]);
    if (summary.workspace) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(summary?.sessionId, peer.sessionId);
  assert.deepEqual(summary?.workspace, { name: "task-worktree", branch: "feature/worktree-grouping" });
  assert.equal(summary?.projectName, "project");
  assert.equal(summary?.projectId, bridge.runtime.summary.projectId);
  assert.equal((await f.request("/v1/catalog")).status, 401);
});

test("workspace negotiation resets on reconnect and a legacy relay never receives new summary fields", async (t) => {
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const listening = once(server, "listening");
  t.after(async () => {
    await bridge?.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const git = await gitFixture(t), peer = workspacePeer(git.worktree), hostId = newId();
  await listening;
  let connections = 0, hellos = 0, first: SessionSummary | undefined;
  const legacySummary = SessionSummary.omit({ workspace: true });
  const received = new Promise<SessionSummary>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the legacy reconnect")), 10_000);
    t.after(() => clearTimeout(timer));
    server.on("connection", (socket, request) => {
      const supportsWorkspace = ++connections === 1;
      assert.equal(new URL(request.url!, "http://localhost").searchParams.get("workspaceMetadata"), "1");
      socket.on("message", (bytes) => {
        try {
          const frame = HostFrame.parse(JSON.parse(bytes.toString()));
          if (frame.type === "hello") {
            legacySummary.parse(frame.summary);
            hellos++;
            socket.send(JSON.stringify({
              type: "ready", protocol: 1, hostId, sessionId: peer.sessionId,
              ...(supportsWorkspace ? { workspaceMetadata: true } : {}),
            }));
          } else if (frame.type === "summary") {
            if (supportsWorkspace) {
              first = frame.summary;
              socket.close(1001, "Simulated legacy relay");
            } else resolve(legacySummary.parse(frame.summary));
          } else if (frame.type === "events") {
            socket.send(JSON.stringify({ type: "eventsAck", ids: frame.items.map((item) => item.id) }));
          }
        } catch (error) { reject(error); socket.terminate(); }
      });
    });
  });
  bridge = await startBridge(peer, {
    hostId, token: secret("dph"), relayUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    dataDir: path.join(git.directory, "bridge"), allowInsecureLoopback: true,
  });
  const legacy = await received;
  assert.equal(hellos, 2);
  assert.deepEqual(first?.workspace, { name: "task-worktree", branch: "feature/worktree-grouping" });
  assert.equal(legacy.projectId, first?.projectId);
  assert.equal(legacy.sessionId, peer.sessionId);
  assert.ok(!("workspace" in legacy));
  assert.ok(legacy.warnings.some((warning) => /relay does not support workspace labels/.test(warning)));
});
