import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { utf16String } from "@devpocket/components";
import { HostConfig } from "../../backend/src/bridge.ts";
import { inspectUserExtension, installUserExtension, userExtensionDirectory } from "../../backend/src/install-user.ts";
import { canonical, openHost, publicFingerprint, requireValue, sha, validConfig } from "./handoff.mjs";
import { AzureSetupClient, vmParts } from "./setup-azure.mjs";
import { renderSetupAction, runSetupAction, scopeHash } from "./setup-actions.mjs";
import { exists, lockDirectory, protectDirectory, readJson, saveJson, savePrivate } from "./setup-state.mjs";

const uuid = z.guid();
const nameSchema = utf16String(80, z.string().trim()).min(1).regex(/^[^\x00-\x1f\x7f-\x9f]+$/);
const optionsSchema = z.object({ tenantId: uuid.optional(), vmId: z.string().optional(), name: nameSchema.optional() }).strict();
const stateSchema = z.object({
  schemaVersion: z.literal(1), assetHash: z.string().regex(/^[a-f0-9]{64}$/),
  target: z.object({ tenantId: uuid, principalId: uuid, vmId: z.string(), vmUniqueId: uuid,
    deploymentId: uuid, dataDiskId: z.string(), subscriptionId: uuid }).strict(),
  copilotHome: z.string(), discoveryScope: z.record(z.string(), z.unknown()), scope: z.record(z.string(), z.unknown()).optional(),
  operations: z.record(z.string(), z.unknown()), authenticated: z.boolean().optional(),
  installed: z.boolean().optional(), complete: z.boolean().optional(),
}).strict();

export function terminalUi() {
  requireValue(process.stdin.isTTY && process.stdout.isTTY, "SETUP_INTERACTIVE_REQUIRED: Run setup in an interactive terminal; it never assumes approval.");
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  const display = (value) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  return {
    log: (text) => console.log(text),
    ask: (text) => reader.question(text),
    async choose(label, items) {
      requireValue(items.length, `SETUP_NO_${label.toUpperCase().replace(/\W+/g, "_")}`);
      if (items.length === 1) { console.log(`${label}: ${display(items[0].name)} [${display(items[0].id)}]`); return items[0].id; }
      console.log(label);
      items.forEach((item, index) => console.log(`${index + 1}. ${display(item.name)} [${display(item.id)}]`));
      const answer = await reader.question("Select a number: ");
      requireValue(/^[1-9][0-9]*$/.test(answer) && Number(answer) <= items.length, "SETUP_SELECTION_INVALID");
      return items[Number(answer) - 1].id;
    },
    async confirm(text) { return (await reader.question(`${text}\nType yes to continue: `)).trim().toLowerCase() === "yes"; },
    close: () => reader.close(),
  };
}

async function assetsAt(directory) {
  const [guest, cloudHost, acl] = await Promise.all([
    readFile(path.join(directory, "guest.py"), "utf8"),
    readFile(path.join(directory, "cloud-host.mjs"), "utf8"),
    readFile(path.join(directory, "private-directory.ps1"), "utf8"),
  ]);
  return { guest, cloudHost, hash: sha(canonical({ guest, cloudHost, acl })) };
}

async function authenticateHost(config) {
  const response = await fetch(new URL("/v1/host/devices", config.relayUrl), {
    headers: { Authorization: `Bearer ${config.token}` }, redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  requireValue(response.ok, `HOST_HTTPS_REJECTED_${response.status}`);
  z.object({ devices: z.array(z.object({ id: uuid, name: z.string() })) }).parse(await response.json());
}

function verifySavedConfig(config, scope, registered) {
  validConfig(config, scope);
  requireValue(config.hostId === registered.hostId &&
    sha(JSON.stringify(config)) === registered.envelope.metadata.configSha256, "EXISTING_HOST_CONFIG_DIFFERS");
}

function instructions(ui, configPath, config, bundle) {
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  ui.log(`Setup complete. Private host configuration: ${configPath}`);
  ui.log(`Relay: ${config.relayUrl}`);
  ui.log("All projects' GitHub Copilot sessions that load the user extension connect automatically, subject to the original client's normal trust and permission prompts.");
  ui.log("Existing GitHub Copilot sessions were not restarted or reloaded. Explicitly invoke extensions_reload in each existing session's original client (CLI or desktop app) to attach it.");
  ui.log("Project extensions named devpocket still take precedence. No project files or GitHub Copilot permission settings were changed.");
  ui.log(`When Android is ready, generate its one-use pairing code:\nnode ${quote(path.join(bundle, "devpocket.mjs"))} pair --config ${quote(configPath)}`);
}

export async function runSetup(input = {}, adapters = {}) {
  const options = optionsSchema.parse(input);
  const ui = adapters.ui ?? terminalUi();
  let unlock;
  try {
    const base = path.dirname(fileURLToPath(import.meta.url));
    const assetDirectory = adapters.assetDirectory ?? path.join(base, "setup-assets");
    const assets = await assetsAt(assetDirectory);
    const directory = adapters.directory ?? (() => {
      requireValue(process.platform === "win32" && process.env.LOCALAPPDATA &&
        path.isAbsolute(process.env.LOCALAPPDATA), "WINDOWS_SETUP_REQUIRED");
      return path.join(process.env.LOCALAPPDATA, "DevPocket", "setup");
    })();
    requireValue(path.isAbsolute(directory), "SETUP_DIRECTORY_MUST_BE_ABSOLUTE");
    const protect = adapters.protect ?? ((create) =>
      protectDirectory(directory, path.join(assetDirectory, "private-directory.ps1"), create));
    const azure = adapters.azure ?? new AzureSetupClient();
    const authenticate = adapters.authenticate ?? authenticateHost;
    const install = adapters.install ?? installUserExtension;
    const bundle = path.resolve(adapters.bundleDirectory ?? base);
    for (const name of ["extension.mjs", "bridge.mjs"]) {
      const file = path.join(bundle, "extension", name), info = await exists(file);
      requireValue(info?.isFile() && !info.isSymbolicLink(), "SETUP_EXTENSION_BUNDLE_REQUIRED");
    }
    await inspectUserExtension();
    const configPath = path.join(directory, "host.local.json"), statePath = path.join(directory, "state.json");
    const keyPath = path.join(directory, "receiver.private.pem");
    let state;
    const resuming = !!await exists(directory);
    if (resuming) {
      await protect(false);
      unlock = await lockDirectory(directory);
      requireValue(await exists(statePath), "SETUP_STATE_MISSING: Retain this directory and inspect the interrupted local setup before retrying.");
      state = stateSchema.parse(await readJson(statePath));
      requireValue(state.assetHash === assets.hash, "SETUP_PACKAGE_CHANGED: Resume with the original setup package; do not create another host.");
      requireValue(state.discoveryScope.scopeHash === scopeHash(state.discoveryScope), "SETUP_SCOPE_CHANGED");
      if (state.scope) requireValue(state.scope.scopeHash === scopeHash(state.scope), "SETUP_SCOPE_CHANGED");
      requireValue(state.discoveryScope.bridgeDataDir === path.join(directory, "bridge") &&
        state.discoveryScope.vmId === state.target.vmId && state.discoveryScope.vmUniqueId === state.target.vmUniqueId &&
        state.discoveryScope.deploymentId === state.target.deploymentId, "SETUP_STATE_TARGET_CHANGED");
      requireValue(!options.tenantId || options.tenantId.toLowerCase() === state.target.tenantId, "SETUP_ALREADY_BOUND_TO_TENANT");
      requireValue(!options.vmId || options.vmId.toLowerCase() === state.target.vmId.toLowerCase(), "SETUP_ALREADY_BOUND_TO_VM");
      requireValue(!options.name || options.name === state.discoveryScope.hostName, "SETUP_ALREADY_BOUND_TO_HOST");
      requireValue(userExtensionDirectory() === userExtensionDirectory(state.copilotHome), "SETUP_COPILOT_HOME_CHANGED");
      if (state.complete) {
        const config = HostConfig.parse(await readJson(configPath));
        requireValue(state.authenticated && state.installed && state.operations.register?.status === "settled" &&
          state.operations.finalize?.status === "settled", "SETUP_COMPLETION_EVIDENCE_MISSING");
        verifySavedConfig(config, state.scope, state.operations.register.result);
        const installed = userExtensionDirectory(state.copilotHome);
        const pointer = await readJson(path.join(installed, "connection.local.json"));
        requireValue(pointer.hostConfigPath === configPath, "SETUP_INSTALLATION_CHANGED: Use install --user with the saved host configuration to restore it.");
        for (const name of ["extension.mjs", "bridge.mjs"]) {
          requireValue(sha(await readFile(path.join(installed, name))) === sha(await readFile(path.join(bundle, "extension", name))),
            "SETUP_INSTALLATION_CHANGED: The host is already registered. Use install --user to update the extension; no new registration is needed.");
        }
        instructions(ui, configPath, config, bundle);
        return { configPath, hostId: config.hostId, resumed: true };
      }
      await azure.selectTenant(state.target.tenantId, state.target.principalId);
      await azure.verify(state.target);
    } else {
      const tenant = options.tenantId ?? await ui.choose("Azure directory", await azure.tenants());
      await azure.selectTenant(tenant);
      let vmId = options.vmId;
      if (!vmId) {
        const subscription = await ui.choose("Azure subscription", await azure.subscriptions());
        vmId = await ui.choose("DevPocket relay VM", await azure.machines(subscription));
      }
      vmParts(vmId);
      const target = await azure.target(vmId);
      const name = nameSchema.parse(options.name ?? ((await ui.ask(`Dev Box name [${hostname()}]: `)).trim() || hostname()));
      state = { schemaVersion: 1, assetHash: assets.hash, target,
        copilotHome: path.dirname(path.dirname(userExtensionDirectory())),
        discoveryScope: { hostName: name }, operations: {} };
    }
    const confirmation = [
      `Relay VM: ${state.target.vmId}`,
      `Azure directory: ${state.target.tenantId}; principal: ${state.target.principalId}`,
      `Dev Box: ${state.discoveryScope.hostName}`,
      `Private storage: ${directory}`,
      `User extension: ${userExtensionDirectory(state.copilotHome)}`,
      "Authorize read-only relay discovery through Azure Run Command, one host registration and encrypted handoff cleanup, and user-wide extension installation.",
      "All sessions that load the extension will publish visible history to this relay and become accessible to its paired phones.",
      "No relay deployment/restart, infrastructure or permission changes, or existing GitHub Copilot session reload will occur.",
    ].join("\n");
    requireValue(await ui.confirm(confirmation), "SETUP_CANCELLED: No new cloud operation or installation was performed.");
    if (!resuming) {
      await protect(true);
      unlock = await lockDirectory(directory);
      const keys = generateKeyPairSync("rsa", { modulusLength: 3072,
        publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
      await savePrivate(keyPath, keys.privateKey);
      state.discoveryScope = {
        ...state.discoveryScope, operationId: randomUUID(), nonce: randomBytes(32).toString("hex"),
        vmId: state.target.vmId, vmUniqueId: state.target.vmUniqueId, deploymentId: state.target.deploymentId,
        expiresAt: Date.now() + 4 * 3600_000, publicKeyPem: keys.publicKey,
        recipientSha256: publicFingerprint(keys.publicKey), bridgeDataDir: path.join(directory, "bridge"),
      };
      state.discoveryScope.scopeHash = scopeHash(state.discoveryScope);
      await saveJson(statePath, state);
    }
    const save = () => saveJson(statePath, state);
    const context = { state, azure, assets, save, ...(adapters.actionTiming ?? {}) };
    ui.log("Inspecting the selected relay; any interrupted operation is reconciled without submitting it again.");
    const discovered = await runSetupAction(context, "discover", state.discoveryScope);
    requireValue(discovered.sameNameCount === 0, "HOST_NAME_COLLISION: A host with that name already exists. No identity was overwritten.");
    if (!state.scope) {
      state.scope = { ...state.discoveryScope, relayUrl: discovered.relayUrl,
        releaseId: discovered.target.releaseId, imageId: discovered.target.imageId, containerId: discovered.target.containerId };
      state.scope.scopeHash = scopeHash(state.scope);
      await save();
    }
    requireValue(state.scope.relayUrl === discovered.relayUrl &&
      state.scope.releaseId === discovered.target.releaseId && state.scope.imageId === discovered.target.imageId &&
      state.scope.containerId === discovered.target.containerId, "SETUP_DISCOVERY_CHANGED");
    // Preflight the complete immutable payload before the first registration request.
    renderSetupAction(assets, state.scope, "finalize", { hostId: randomUUID(), envelopeSha256: "a".repeat(64) });
    ui.log(`Registering ${state.scope.hostName} with the verified relay at ${state.scope.relayUrl}.`);
    const registered = await runSetupAction(context, "register", state.scope);
    let config;
    if (await exists(configPath)) {
      config = HostConfig.parse(await readJson(configPath));
      verifySavedConfig(config, state.scope, registered);
    } else {
      const keyInfo = await exists(keyPath);
      requireValue(keyInfo?.isFile() && !keyInfo.isSymbolicLink(), "SETUP_RECIPIENT_KEY_REQUIRED");
      const key = await readFile(keyPath);
      try { config = openHost(registered.envelope, state.scope, key); }
      finally { key.fill(0); }
      await saveJson(configPath, config, { exclusive: true });
    }
    await authenticate(config);
    state.authenticated = true;
    await save();
    if (await exists(keyPath)) await unlink(keyPath);
    await runSetupAction(context, "finalize", state.scope, {
      hostId: config.hostId, envelopeSha256: sha(JSON.stringify(registered.envelope)),
    });
    await install(path.join(bundle, "extension"), configPath, state.copilotHome);
    state.installed = true;
    state.complete = true;
    await save();
    instructions(ui, configPath, config, bundle);
    return { configPath, hostId: config.hostId, resumed: false };
  } finally {
    try { if (unlock) await unlock(); }
    finally { ui.close(); }
  }
}
