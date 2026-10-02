import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runSetup } from "../setup.mjs";
import { registerHost, finalizeHost } from "../cloud-host.mjs";
import { exists, protectDirectory } from "../setup-state.mjs";
import { parseSetupResult, renderSetupAction, MAX_SETUP_REQUEST } from "../setup-actions.mjs";
import { RelayStore } from "../../../backend/src/store.js";
import { startRelay } from "../../../backend/src/relay.js";

const repo = path.resolve(import.meta.dirname, "..", "..", "..");
const exec = promisify(execFile);
const tenantId = "11111111-1111-4111-8111-111111111111";
const subscriptionId = "22222222-2222-4222-8222-222222222222";
const vmId = `/subscriptions/${subscriptionId}/resourceGroups/rg-fixture/providers/Microsoft.Compute/virtualMachines/vm-fixture`;
const target = {
  tenantId, subscriptionId, vmId, principalId: "33333333-3333-4333-8333-333333333333",
  vmUniqueId: "44444444-4444-4444-8444-444444444444", deploymentId: "55555555-5555-4555-8555-555555555555",
  dataDiskId: `/subscriptions/${subscriptionId}/resourceGroups/rg-fixture/providers/Microsoft.Compute/disks/data`,
};
const relayTarget = { vmVerified: true, ownerVerified: true, releaseId: "a".repeat(64),
  imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(12), databasePath: "/srv/devpocket/relay/relay.sqlite" };
const rawResult = (result) => ({ value: [{ code: "ComponentStatus/StdOut/succeeded",
  message: "DEVPOCKET_HOST_RESULT=" + JSON.stringify(result) }] });
const options = { tenantId, vmId, name: "New Dev Box" };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "devpocket-setup-"));
  const directory = path.join(root, "private", "setup");
  const home = path.join(root, "copilot");
  const previousHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  const relay = await startRelay({ dataDir: path.join(root, "relay"), allowInsecureLoopback: true, port: 0 });
  const store = new RelayStore(path.join(root, "relay"));
  t.after(async () => {
    if (previousHome === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previousHome;
    await relay.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const posts = [], reads = [], logs = [], confirmations = [], results = new Map();
  const controls = { confirm: true, loseResponse: undefined, asyncRegister: false, pollFailure: false, authFailure: false,
    changeTarget: false, installFailure: false };
  const azure = {
    selectTenant: async (tenant, principal) => {
      assert.equal(tenant, tenantId);
      if (principal) assert.equal(principal, target.principalId);
      return { tenantId, principalId: target.principalId };
    },
    target: async (id) => { assert.equal(id, vmId); return structuredClone(target); },
    verify: async (value) => {
      assert.deepEqual(value, target);
      if (controls.changeTarget) throw new Error("SETUP_AZURE_TARGET_CHANGED");
    },
    url: (value) => {
      assert.ok(value.startsWith(`https://management.azure.com/subscriptions/${subscriptionId}/`));
      return new URL(value);
    },
    async arm(url, request = {}) {
      if (request.method !== "POST") {
        reads.push(url);
        if (controls.pollFailure) throw new Error("SIMULATED_POLL_FAILURE");
        return { value: url.includes("/poll") ? { status: "Succeeded" } : results.get(url), status: 200, headers: new Headers() };
      }
      assert.equal(url, `${vmId}/runCommand?api-version=2024-07-01`);
      const encoded = request.body.script[4].match(/main\(json\.loads\(base64\.b64decode\("([A-Za-z0-9+/=]+)"\)\)\)/)?.[1];
      assert.ok(encoded);
      const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      const { scope, action } = payload;
      posts.push({ action, scope, body: request.body });
      assert.ok(Buffer.byteLength(JSON.stringify(request.body)) <= MAX_SETUP_REQUEST);
      let result;
      const journal = path.join(root, "handoff", scope.operationId);
      if (action === "discover") result = {
        status: "relay_discovered", sameNameCount: store.db.prepare("SELECT COUNT(*) AS n FROM hosts WHERE name=?").get(scope.hostName).n,
        schemaVersion: 1, relayUrl: "https://relay.example.test",
      };
      else if (action === "register") result = await registerHost(scope, payload.publicKeyPem, store, journal);
      else {
        assert.equal(action, "finalize");
        result = await finalizeHost(scope, store, journal, payload.acknowledgement);
        result.logAudit = { files: 1, bytes: 0, skipped: 0, hostTokenMatches: 0, privateKeyMatches: 0, complete: true };
      }
      result = { ...result, scopeHash: scope.scopeHash, target: relayTarget };
      const value = rawResult(result);
      if (controls.loseResponse === action) throw new Error("SIMULATED_LOST_RESPONSE");
      if (action === "register" && controls.asyncRegister) {
        const base = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Compute/locations/test/operations/${randomUUID()}`;
        results.set(`${base}/result`, value);
        return { value: {}, status: 202, headers: new Headers({
          "azure-asyncoperation": `${base}/poll`, location: `${base}/result`,
        }) };
      }
      return { value, status: 200, headers: new Headers() };
    },
  };
  const adapters = {
    directory, bundleDirectory: path.join(repo, "dist"), assetDirectory: path.join(repo, "dist", "setup-assets"), azure,
    ui: {
      log: (message) => logs.push(message),
      ask: async () => { throw new Error("Unexpected prompt"); },
      choose: async () => { throw new Error("Unexpected discovery"); },
      confirm: async (message) => { confirmations.push(message); return controls.confirm; },
      close: () => {},
    },
    actionTiming: { pause: async () => {} },
    authenticate: async (config) => {
      if (controls.authFailure) throw new Error("HOST_HTTPS_REJECTED_503");
      const response = await fetch(`${relay.url}/v1/host/devices`, { headers: { Authorization: `Bearer ${config.token}` } });
      assert.equal(response.status, 200);
      assert.ok(Array.isArray((await response.json()).devices));
    },
  };
  if (process.platform !== "win32") adapters.protect = async (create) => {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  };
  return { root, directory, home, store, controls, posts, reads, logs, confirmations, adapters,
    state: () => readFile(path.join(directory, "state.json"), "utf8").then(JSON.parse) };
}

test("setup registers through encrypted handoff, authenticates and installs once without old deployment files", async (t) => {
  const f = await fixture(t);
  const result = await runSetup(options, f.adapters);
  assert.deepEqual(f.posts.map((item) => item.action), ["discover", "register", "finalize"]);
  assert.equal(f.confirmations.length, 1);
  assert.match(f.confirmations[0], /All sessions/);
  assert.match(f.confirmations[0], /No relay deployment\/restart/);
  const config = JSON.parse(await readFile(result.configPath, "utf8"));
  assert.equal(f.store.host(config.token).id, result.hostId);
  const installed = path.join(f.home, "extensions", "devpocket");
  assert.deepEqual(JSON.parse(await readFile(path.join(installed, "connection.local.json"), "utf8")),
    { hostConfigPath: result.configPath });
  assert.equal((await f.state()).complete, true);
  assert.equal(await exists(path.join(f.directory, "receiver.private.pem")), undefined);
  assert.deepEqual(await readdir(path.join(f.root, "handoff", (await f.state()).scope.operationId)), ["closed.json"]);
  assert.ok(!JSON.stringify(f.posts).includes(config.token));
  assert.ok(!JSON.stringify(f.logs).includes(config.token));
  assert.ok(!(await readFile(path.join(f.directory, "state.json"), "utf8")).includes(config.token));
  assert.ok(f.logs.some((line) => line.includes("pair --config")));
  if (process.platform === "win32")
    await protectDirectory(f.directory, path.join(f.adapters.assetDirectory, "private-directory.ps1"), false);
  const repeated = await runSetup({}, f.adapters);
  assert.equal(repeated.hostId, result.hostId);
  assert.equal(f.posts.length, 3);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM hosts").get().n, 1);
});

test("the extracted standalone ZIP runs setup outside the source checkout", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const output = path.join(f.root, "packages"), extracted = path.join(f.root, "extracted package");
  await exec("pwsh", ["-NoProfile", "-File", path.join(repo, "scripts", "package-extension.ps1"), "-OutputDirectory", output],
    { cwd: f.root, timeout: 15_000 });
  const version = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")).version;
  await exec("pwsh", ["-NoProfile", "-Command",
    "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:SETUP_TEST_ZIP -DestinationPath $env:SETUP_TEST_OUTPUT"], {
    cwd: f.root, timeout: 15_000, env: { ...process.env,
      SETUP_TEST_ZIP: path.join(output, `DevPocket-extension-${version}.zip`), SETUP_TEST_OUTPUT: extracted },
  });
  const packaged = await import(pathToFileURL(path.join(extracted, "setup.mjs")).href);
  const result = await packaged.runSetup(options, {
    ...f.adapters, bundleDirectory: extracted, assetDirectory: path.join(extracted, "setup-assets"),
  });
  assert.equal(result.hostId, f.store.db.prepare("SELECT id FROM hosts").get().id);
  assert.equal(await exists(path.join(extracted, "node_modules")), undefined);
  assert.equal(await exists(path.join(extracted, ".data")), undefined);
  await rm(extracted, { recursive: true });
  assert.ok(await exists(path.join(f.home, "extensions", "devpocket", "bridge.mjs")));
  assert.ok(await exists(result.configPath));
});

test("declining the single scope confirmation creates no host, private directory or user extension", async (t) => {
  const f = await fixture(t);
  f.controls.confirm = false;
  await assert.rejects(runSetup(options, f.adapters), /SETUP_CANCELLED/);
  assert.equal(f.posts.length, 0);
  assert.equal(await exists(f.directory), undefined);
  assert.equal(await exists(f.home), undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM hosts").get().n, 0);
});

test("missing bundles and unmanaged user extensions fail before any enrollment", async (t) => {
  const f = await fixture(t);
  await assert.rejects(runSetup(options, { ...f.adapters, bundleDirectory: path.join(f.root, "missing") }),
    /SETUP_EXTENSION_BUNDLE_REQUIRED/);
  const userExtension = path.join(f.home, "extensions", "devpocket");
  await mkdir(userExtension, { recursive: true });
  await writeFile(path.join(userExtension, "extension.mjs"), "user-owned extension");
  await assert.rejects(runSetup(options, f.adapters), /unmanaged/);
  assert.equal(f.posts.length, 0);
  assert.equal(await exists(f.directory), undefined);
});

test("completion is not reported after installed files or saved credentials change", async (t) => {
  const f = await fixture(t);
  await runSetup(options, f.adapters);
  const installed = path.join(f.home, "extensions", "devpocket", "bridge.mjs");
  const original = await readFile(installed);
  await writeFile(installed, "changed");
  await assert.rejects(runSetup({}, f.adapters), /SETUP_INSTALLATION_CHANGED/);
  await writeFile(installed, original);
  const configPath = path.join(f.directory, "host.local.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.hostId = randomUUID();
  await writeFile(configPath, JSON.stringify(config));
  await assert.rejects(runSetup({}, f.adapters), /EXISTING_HOST_CONFIG_DIFFERS/);
  assert.equal(f.posts.length, 3);
});

test("an execution followed by a lost ARM response stays uncertain and is never resubmitted", async (t) => {
  const f = await fixture(t);
  f.controls.loseResponse = "register";
  await assert.rejects(runSetup(options, f.adapters), /SETUP_ACTION_UNCERTAIN/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM hosts").get().n, 1);
  assert.equal((await f.state()).operations.register.status, "submitting");
  f.controls.loseResponse = undefined;
  await assert.rejects(runSetup({}, f.adapters), /no saved result URL/);
  assert.deepEqual(f.posts.map((item) => item.action), ["discover", "register"]);
  assert.ok(await exists(path.join(f.directory, "receiver.private.pem")));
  assert.equal(await exists(path.join(f.home, "extensions", "devpocket")), undefined);
});

test("saved asynchronous registration resumes with GET only after interruption", async (t) => {
  const f = await fixture(t);
  f.controls.asyncRegister = true;
  f.controls.pollFailure = true;
  await assert.rejects(runSetup(options, f.adapters), /SIMULATED_POLL_FAILURE/);
  assert.equal((await f.state()).operations.register.status, "accepted");
  f.controls.pollFailure = false;
  const result = await runSetup({}, f.adapters);
  assert.ok(result.hostId);
  assert.deepEqual(f.posts.map((item) => item.action), ["discover", "register", "finalize"]);
  assert.ok(f.reads.some((url) => url.endsWith("/result")));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM hosts").get().n, 1);
});

test("saved request changes and expired authority cannot replay a registration", async (t) => {
  await t.test("request body changed", async (t) => {
    const f = await fixture(t);
    f.controls.asyncRegister = true;
    f.controls.pollFailure = true;
    await assert.rejects(runSetup(options, f.adapters), /SIMULATED_POLL_FAILURE/);
    const state = await f.state();
    state.operations.register.body.script[1] = "unexpected script";
    await writeFile(path.join(f.directory, "state.json"), JSON.stringify(state));
    f.controls.pollFailure = false;
    await assert.rejects(runSetup({}, f.adapters), /SETUP_SAVED_REQUEST_CHANGED/);
    assert.equal(f.posts.length, 2);
  });
  await t.test("expired registration scope", async (t) => {
    const f = await fixture(t);
    f.controls.authFailure = true;
    await assert.rejects(runSetup(options, f.adapters), /HOST_HTTPS_REJECTED/);
    const expiredAt = (await f.state()).scope.expiresAt + 1;
    t.mock.method(Date, "now", () => expiredAt);
    f.controls.authFailure = false;
    await assert.rejects(runSetup({}, f.adapters), /SETUP_APPROVAL_EXPIRED/);
    assert.equal(f.posts.length, 2);
  });
});

test("local authentication failure retains recoverable config and never issues another host identity", async (t) => {
  const f = await fixture(t);
  f.controls.authFailure = true;
  await assert.rejects(runSetup(options, f.adapters), /HOST_HTTPS_REJECTED/);
  const previous = await readFile(path.join(f.directory, "host.local.json"), "utf8");
  assert.ok(await exists(path.join(f.directory, "receiver.private.pem")));
  f.controls.authFailure = false;
  await runSetup({}, f.adapters);
  assert.equal(await readFile(path.join(f.directory, "host.local.json"), "utf8"), previous);
  assert.deepEqual(f.posts.map((item) => item.action), ["discover", "register", "finalize"]);
});

test("an installer failure can be retried after handoff finalization without repeating cloud actions", async (t) => {
  const f = await fixture(t);
  await assert.rejects(runSetup(options, { ...f.adapters, install: async () => { throw new Error("SIMULATED_INSTALL_FAILURE"); } }),
    /SIMULATED_INSTALL_FAILURE/);
  assert.equal((await f.state()).operations.finalize.status, "settled");
  assert.equal(await exists(path.join(f.directory, "receiver.private.pem")), undefined);
  await runSetup({}, f.adapters);
  assert.equal(f.posts.length, 3);
});

test("host collisions, changed packages and changed Azure targets stop before a new registration", async (t) => {
  await t.test("name collision", async (t) => {
    const f = await fixture(t);
    f.store.createHost(options.name);
    await assert.rejects(runSetup(options, f.adapters), /HOST_NAME_COLLISION/);
    assert.deepEqual(f.posts.map((item) => item.action), ["discover"]);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM hosts").get().n, 1);
  });
  await t.test("saved scope and helper identity", async (t) => {
    const f = await fixture(t);
    f.controls.authFailure = true;
    await assert.rejects(runSetup(options, f.adapters), /HOST_HTTPS_REJECTED/);
    await assert.rejects(runSetup({ name: "different host" }, f.adapters), /SETUP_ALREADY_BOUND_TO_HOST/);
    const changed = path.join(f.root, "changed-assets");
    await cp(f.adapters.assetDirectory, changed, { recursive: true });
    await writeFile(path.join(changed, "guest.py"), "# Changed helper");
    await assert.rejects(runSetup({}, { ...f.adapters, assetDirectory: changed }), /SETUP_PACKAGE_CHANGED/);
    f.controls.changeTarget = true;
    await assert.rejects(runSetup({}, f.adapters), /SETUP_AZURE_TARGET_CHANGED/);
    assert.equal(f.posts.length, 2);
  });
});

test("setup rejects unbound, unsafe and changed result envelopes", async (t) => {
  const f = await fixture(t);
  await runSetup(options, f.adapters);
  const state = await f.state(), scope = state.scope, result = state.operations.register.result;
  assert.throws(() => parseSetupResult(rawResult({ ...result, scopeHash: "0".repeat(64) }), scope, "register"), /SCOPE_MISMATCH/);
  assert.throws(() => parseSetupResult(rawResult({ ...result, target: { ...relayTarget, imageId: `sha256:${"1".repeat(64)}` } }),
    scope, "register"), /RELAY_CHANGED/);
  assert.throws(() => parseSetupResult(rawResult({ ...result, unexpected: "raw output" }), scope, "register"));
  assert.throws(() => parseSetupResult({ value: [{ message: "dph_" + "a".repeat(43) }] }, scope, "register"), /SECRET_OUTPUT/);
  assert.throws(() => renderSetupAction({ guest: "__DEVPOCKET_HOST_PAYLOAD__", cloudHost: "x".repeat(40_000) }, scope, "register"),
    /REQUEST_TOO_LARGE/);
});
