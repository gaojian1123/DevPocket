import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { startRelay } from "../../dist/relay.js";
import { provisionHost } from "../../dist/store.js";

const run = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const repo = path.resolve(import.meta.dirname, "..", "..");

test("standalone archive installs without a checkout and connects all projects through their original SDK sessions", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "devpocket-package-"));
  const children = [];
  let relay;
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise((resolve) => { child.once("exit", resolve); child.kill(); });
    }
    await relay?.close();
    await rm(root, { recursive: true, force: true });
  });
  const version = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")).version;
  const output = path.join(root, "packages"), extracted = path.join(root, "distribution with spaces");
  const archive = path.join(output, `DevPocket-extension-${version}.zip`);
  const packageArgs = ["-NoProfile", "-File", path.join(repo, "scripts", "package-extension.ps1"), "-OutputDirectory", output];
  await run("pwsh", packageArgs, { cwd: root, timeout: 30_000 });
  const bytes = await readFile(archive);
  assert.equal((await readFile(`${archive}.sha256`, "utf8")).trim(), `${sha256(bytes)}  ${path.basename(archive)}`);
  await assert.rejects(run("pwsh", packageArgs, { cwd: root, timeout: 30_000 }), /already exists/);
  assert.deepEqual(await readFile(archive), bytes);
  await run("pwsh", ["-NoProfile", "-Command",
    "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:DP_TEST_ARCHIVE -DestinationPath $env:DP_TEST_EXTRACTED"], {
    cwd: root, timeout: 30_000, env: { ...process.env, DP_TEST_ARCHIVE: archive, DP_TEST_EXTRACTED: extracted },
  });
  const manifest = JSON.parse(await readFile(path.join(extracted, "manifest.json"), "utf8"));
  assert.equal(manifest.version, version);
  assert.equal(manifest.node, "24.x");
  const expected = ["README.md", "THIRD-PARTY-NOTICES.txt", "devpocket.mjs", "extension/bridge.mjs", "extension/extension.mjs",
    "setup-assets/cloud-host.mjs", "setup-assets/guest.py", "setup-assets/private-directory.ps1", "setup.mjs"];
  assert.deepEqual(manifest.files.map((file) => file.path).sort(), expected);
  for (const file of manifest.files) {
    const content = await readFile(path.join(extracted, ...file.path.split("/")));
    assert.equal(content.length, file.bytes);
    assert.equal(sha256(content), file.sha256);
  }
  assert.deepEqual((await readdir(extracted)).sort(),
    ["README.md", "THIRD-PARTY-NOTICES.txt", "devpocket.mjs", "extension", "manifest.json", "setup-assets", "setup.mjs"]);
  assert.deepEqual((await readdir(path.join(extracted, "extension"))).sort(), ["bridge.mjs", "extension.mjs"]);
  assert.match(await readFile(path.join(extracted, "THIRD-PARTY-NOTICES.txt"), "utf8"), /MIT/);
  const home = path.join(root, "copilot home"), configPath = path.join(root, "host.local.json");
  const env = { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", COPILOT_HOME: home };
  const cli = (...args) => run(process.execPath, [path.join(extracted, "devpocket.mjs"), ...args],
    { cwd: root, env, timeout: 15_000 });
  const help = (await cli("--help")).stdout;
  assert.match(help, /install --user/);
  assert.match(help, /GitHub Copilot sessions/);
  assert.match((await cli("setup", "--help")).stdout, /setup \[--tenant-id/);
  await assert.rejects(cli("setup"), /SETUP_INTERACTIVE_REQUIRED/);
  await assert.rejects(cli("install", "--user", "--config", configPath), /OPT_IN_REQUIRED/);
  await assert.rejects(cli("install", "--user", "--project", root, "--config", configPath, "--confirm-install"), /TARGET_REQUIRED/);
  await assert.rejects(access(home), { code: "ENOENT" });

  const relayData = path.join(root, "relay"), bridgeData = path.join(root, "private-bridge");
  relay = await startRelay({ dataDir: relayData, allowInsecureLoopback: true, port: 0 });
  const host = provisionHost(relayData, "Isolated package test");
  const config = { hostId: host.hostId, token: host.token, relayUrl: relay.url, dataDir: bridgeData, allowInsecureLoopback: true };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const installation = (await cli("install", "--user", "--config", configPath, "--confirm-install")).stdout;
  assert.match(installation, /Installed user extension/);
  assert.match(installation, /GitHub Copilot CLI and desktop app sessions/);
  assert.match((await cli("install", "--user", "--config", configPath, "--confirm-install")).stdout, /Updated user extension/);
  const installed = path.join(home, "extensions", "devpocket");
  assert.deepEqual(JSON.parse(await readFile(path.join(installed, "connection.local.json"), "utf8")),
    { hostConfigPath: configPath });
  assert.equal(await readFile(path.join(installed, "extension.mjs"), "utf8"),
    await readFile(path.join(extracted, "extension", "extension.mjs"), "utf8"));
  assert.equal(await readFile(configPath, "utf8"), JSON.stringify(config));

  const legacy = path.join(root, "legacy-project"), plugin = path.join(root, "legacy-plugin");
  await mkdir(legacy);
  await writeFile(path.join(legacy, ".git"), "gitdir: isolated-worktree-fixture");
  await cli("install", "--project", legacy, "--config", configPath, "--confirm-install");
  await access(path.join(legacy, ".github", "extensions", "devpocket", "extension.mjs"));
  await cli("install", "--plugin-dir", plugin, "--config", configPath, "--confirm-install");
  const pluginMetadata = JSON.parse(await readFile(path.join(plugin, "plugin.json"), "utf8"));
  assert.equal(pluginMetadata.name, "devpocket");
  assert.equal(pluginMetadata.description, "Opt-in access to the original GitHub Copilot session");
  const pairing = JSON.parse((await cli("pair", "--config", configPath)).stdout);
  const paired = await fetch(`${relay.url}/v1/pair`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairing.code, name: "Package test phone" }),
  });
  assert.equal(paired.status, 201);
  const phone = await paired.json();
  const request = (route, body) => fetch(relay.url + route, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${phone.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (response) => { assert.ok(response.ok, `Relay status ${response.status}`); return response.json(); });
  await rm(extracted, { recursive: true });

  // Only the SDK boundary is simulated. The installed bridge, relay and wire protocol are real.
  const loader = path.join(root, "sdk-loader.mjs");
  await writeFile(loader, `
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === "@github/copilot-sdk/extension"
    ? { url: new URL("./sdk.mjs", import.meta.url).href, shortCircuit: true }
    : nextResolve(specifier, context);
} });
`);
  await writeFile(path.join(root, "sdk.mjs"), `
import { randomUUID } from "node:crypto";
import path from "node:path";
export async function joinSession(options) {
  if ((await options.onPermissionRequest()).kind !== "no-result") throw new Error("Permission policy changed.");
  const event = (type, data) => ({ id: randomUUID(), type, timestamp: new Date().toISOString(), data });
  let emit = () => {};
  return {
    sessionId: process.env.DP_TEST_SESSION_ID,
    getEvents: async () => [
      event("session.start", { copilotVersion: "future-runtime-build", context: { cwd: process.cwd() } }),
      event("assistant.message", { messageId: randomUUID(), content: "Earlier history in " + path.basename(process.cwd()) }),
    ],
    on: (listener) => { emit = listener; return () => { emit = () => {}; }; },
    send: async (options) => {
      if (options.source !== "user" || options.mode !== "enqueue") throw new Error("Input provenance changed.");
      const id = randomUUID();
      emit(event("user.message", { messageId: id, content: options.prompt }));
      emit(event("assistant.message", { messageId: randomUUID(), originatingMessageId: id, content: "Reply from " + path.basename(process.cwd()) }));
      emit(event("session.idle", {}));
      return id;
    },
    abort: async () => {},
    rpc: {
      permissions: { paths: { list: async () => ({ primary: process.cwd() }) },
        getMode: async () => ({ mode: "manual" }), pendingRequests: async () => ({ items: [] }) },
      metadata: { activity: async () => ({ hasActiveWork: false, abortable: false }) },
    },
  };
}
`);
  const sessionIds = [randomUUID(), randomUUID()];
  let logs = "";
  for (const [index, sessionId] of sessionIds.entries()) {
    const project = path.join(root, `project-${index}`);
    await mkdir(project);
    const child = spawn(process.execPath, ["--import", pathToFileURL(loader).href, path.join(installed, "extension.mjs")], {
      cwd: project, env: { ...env, DP_TEST_SESSION_ID: sessionId }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout.on("data", (data) => { logs += data.toString(); });
    child.stderr.on("data", (data) => { logs += data.toString(); });
    await assert.rejects(access(path.join(project, ".github")), { code: "ENOENT" });
  }
  async function until(predicate) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await predicate()) return;
      if (children.some((child) => child.exitCode !== null || child.signalCode !== null)) break;
      await pause(25);
    }
    assert.fail(`Packaged bridge did not reach the expected state:\n${logs}`);
  }
  await until(async () => (await request("/v1/catalog")).sessions.filter((session) => session.online).length === 2);
  const catalog = await request("/v1/catalog");
  assert.deepEqual(catalog.sessions.map((session) => session.sessionId).sort(), [...sessionIds].sort());
  assert.deepEqual(catalog.sessions.map((session) => session.projectName).sort(), ["project-0", "project-1"]);
  assert.ok(catalog.sessions.every((session) => session.permissionMode === "manual"));
  assert.ok(catalog.sessions.every((session) => session.title === "GitHub Copilot"));
  assert.ok(catalog.sessions.every((session) => session.cliVersion === "future-runtime-build" && session.capabilities.messages));
  const route = `/v1/hosts/${host.hostId}/sessions/${sessionIds[0]}`;
  await until(async () => (await request(`${route}/events`)).events.some((event) => event.data.content === "Earlier history in project-0"));
  const command = { commandId: randomUUID(), action: { type: "message", text: "Only project zero", attachmentIds: [] } };
  await request(`${route}/commands`, command);
  await until(async () => (await request(`${route}/commands/${command.commandId}`)).status === "completed");
  await until(async () => (await request(`${route}/events`)).events.some((event) => event.data.content === "Reply from project-0"));
  const events = (await request(`${route}/events`)).events;
  assert.ok(events.some((event) => event.data.content === "Reply from project-0"));
  const other = (await request(`/v1/hosts/${host.hostId}/sessions/${sessionIds[1]}/events`)).events;
  assert.ok(!other.some((event) => event.data.content === "Only project zero"));
  assert.ok(!logs.includes(config.token));
});
