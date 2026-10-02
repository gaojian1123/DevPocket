import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { canonical, openHost, publicFingerprint, requireValue, sha, validConfig } from "./handoff.mjs";
import { actionStatus, renderAction, requireHostApproval, runAction } from "./action.mjs";
import { RealRunner } from "../azure/real-runner.mjs";
import { sourceFingerprint } from "../azure/package.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, value, exclusive = true) => writeFile(file, JSON.stringify(value, null, 2) + "\n",
  { flag: exclusive ? "wx" : "w", mode: 0o600 });
export async function helperFingerprint() {
  const names = [], base = path.join(root, "deployment", "onboarding");
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue;
      const file = path.join(directory, entry.name);
      requireValue(!entry.isSymbolicLink(), "HELPER_LINK");
      if (entry.isDirectory()) await walk(file);
      else if (/\.(mjs|py|ps1)$/.test(entry.name)) names.push(file);
    }
  }
  await walk(base);
  names.push(path.join(root, "package-lock.json"));
  const hashes = [];
  for (const file of names.sort()) hashes.push({ name: path.relative(root, file), sha256: sha(await readFile(file)) });
  return sha(canonical(hashes));
}
export function privateAcl(directory, create = false) {
  requireValue(process.platform === "win32", "WINDOWS_PRIVATE_STORAGE_REQUIRED");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    path.join(root, "deployment", "onboarding", "private-directory.ps1"), "-Directory", directory];
  if (!create) args.push("-CheckOnly");
  // Windows PowerShell must not inherit PowerShell 7's incompatible module search path.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  try { return JSON.parse(execFileSync("powershell.exe", args, { env, encoding: "utf8", windowsHide: true, stdio: "pipe", timeout: 20000 })); }
  catch { throw new Error("PRIVATE_DIRECTORY_ACL_FAILED"); }
}
function directoryPath(value) {
  const directory = path.resolve(value ?? "");
  requireValue(directory.startsWith(path.join(root, ".data", "onboarding") + path.sep) &&
    /^devbox-trial-\d{3}$/.test(path.basename(directory)), "ONBOARDING_DIRECTORY_SCOPE");
  return directory;
}
export async function context(directory, checkSource = true) {
  directory = directoryPath(directory);
  const scope = await load(path.join(directory, "scope.json"));
  const { scopeHash, ...data } = scope;
  requireValue(sha(canonical(data)) === scopeHash && scope.kind === "cloud-host-onboarding" &&
    scope.projectPath === root && scope.maxActions === 6, "SCOPE_IDENTITY");
  if (checkSource) requireValue(await helperFingerprint() === scope.sourceHash &&
    await sourceFingerprint(root) === scope.deploymentSourceHash, "COMMISSION_SOURCE_CHANGED");
  const basePlan = await load(path.join(scope.releaseDirectory, "plan.json"));
  const baseline = await load(path.join(scope.releaseDirectory, "..", "recovery-001", "baseline.json"));
  requireValue(basePlan.planHash === scope.releasePlanHash && basePlan.allowedVmId === scope.vmId &&
    basePlan.target.deploymentId === scope.deploymentId, "ORIGINAL_RESOURCE_IDENTITY");
  const verifier = new RealRunner(root, directory, basePlan, baseline, "NO_BUSINESS_PACKAGE_INPUT");
  return {
    directory, scope, api: verifier.api,
    authorize: async (action) => {
      requireValue(await helperFingerprint() === scope.sourceHash &&
        await sourceFingerprint(root) === scope.deploymentSourceHash, "COMMISSION_SOURCE_CHANGED");
      let approval;
      try { approval = await load(path.join(directory, "approval.local.json")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      requireHostApproval(scope, approval, action);
    },
    verify: () => verifier.verifyTarget(),
    render: (action, ack) => renderAction(root, scope, action, ack),
  };
}
export async function protectedConfig(ctx) {
  const local = await load(path.join(ctx.directory, "local-paths.json"));
  privateAcl(local.privateDirectory);
  const file = path.join(local.privateDirectory, "host.local.json");
  requireValue(!(await lstat(file)).isSymbolicLink(), "HOST_CONFIG_LINK");
  const config = validConfig(await load(file), ctx.scope);
  const registered = await load(path.join(ctx.directory, "register-success.json"));
  requireValue(config.hostId === registered.hostId, "HOST_CONFIG_IDENTITY");
  return { config, local, file };
}
export async function hostFetch(config, route, { method = "GET", body } = {}) {
  const response = await fetch(new URL(route, config.relayUrl), {
    method, headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(20000),
  });
  requireValue(response.ok, "HOST_HTTPS_REJECTED_" + response.status);
  return response.json();
}
async function init(directory, releaseDirectory, hostName) {
  requireValue(!await lstat(directory).then(() => true, (e) => { if (e.code === "ENOENT") return false; throw e; }), "ONBOARDING_ALREADY_EXISTS");
  releaseDirectory = path.resolve(releaseDirectory ?? "");
  requireValue(releaseDirectory.startsWith(path.join(root, ".data", "azure") + path.sep) &&
    path.basename(releaseDirectory) === "real-release-001", "COMPLETED_RELEASE_REQUIRED");
  const plan = await load(path.join(releaseDirectory, "plan.json"));
  const closed = await load(path.join(releaseDirectory, "closed.json"));
  const image = await load(path.join(releaseDirectory, "build-success.json"));
  requireValue(closed.planHash === plan.planHash && closed.activeRealApprovalRemoved &&
    image.planHash === plan.planHash && image.result.status === "image_built", "DEPLOYED_RELEASE_EVIDENCE");
  requireValue(typeof hostName === "string" && hostName.trim() === hostName && hostName.length > 0 && hostName.length <= 80, "HOST_NAME");
  requireValue(await sourceFingerprint(root) === plan.sourceHash, "FROZEN_DEPLOYMENT_SOURCE_CHANGED");
  const operationId = randomUUID(), privateDirectory = path.join(process.env.LOCALAPPDATA, "DevPocket", "trial-" + operationId);
  const acl = privateAcl(privateDirectory, true);
  const keys = generateKeyPairSync("rsa", { modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  await writeFile(path.join(privateDirectory, "receiver.private.pem"), keys.privateKey, { flag: "wx", mode: 0o600 });
  const data = {
    schemaVersion: 1, kind: "cloud-host-onboarding", operationId, nonce: randomBytes(32).toString("hex"),
    sourceHash: await helperFingerprint(), deploymentSourceHash: plan.sourceHash, releaseDirectory,
    releasePlanHash: plan.planHash, vmId: plan.allowedVmId, subscriptionId: plan.target.subscriptionId,
    deploymentId: plan.target.deploymentId, imageId: image.result.imageId, releaseId: plan.business.archiveSha256,
    projectPath: root, relayUrl: "https://" + plan.business.binding.host, hostName,
    bridgeDataDir: path.join(privateDirectory, "bridge"), publicKeyPem: keys.publicKey,
    recipientSha256: publicFingerprint(keys.publicKey), expiresAt: Date.now() + 4 * 3600_000,
    maxActions: 6, maxRequestBytes: 36369, phases: ["host-inspect", "host-register", "host-finalize"],
    noInfrastructureChanges: true, noBusinessOrDatabaseSchemaChanges: true,
  };
  const scope = { ...data, scopeHash: sha(canonical(data)) };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await save(path.join(directory, "scope.json"), scope);
  await save(path.join(directory, "local-paths.json"), { privateDirectory,
    hostConfigPath: path.join(privateDirectory, "host.local.json"),
    pluginDirectory: path.join(directory, "plugin"), acl });
  const sizes = [];
  for (const action of ["inspect", "register", "finalize"])
    sizes.push({ action, bytes: Buffer.byteLength(JSON.stringify(await renderAction(root, scope, action,
      action === "finalize" ? { hostId: randomUUID(), envelopeSha256: "a".repeat(64) } : undefined))) });
  await save(path.join(directory, "request-sizes.json"), { scopeHash: scope.scopeHash, maxBytes: Math.max(...sizes.map(s => s.bytes)), sizes });
  console.log(JSON.stringify({ scopeHash: scope.scopeHash, sourceHash: scope.sourceHash, privateDirectory,
    recipientSha256: scope.recipientSha256, maxRequestBytes: Math.max(...sizes.map(s => s.bytes)), authorized: false }));
}
async function adopt(ctx) {
  const registered = await load(path.join(ctx.directory, "register-success.json"));
  requireValue(registered.status === "host_registered", "HOST_REGISTRATION_REQUIRED");
  const local = await load(path.join(ctx.directory, "local-paths.json"));
  privateAcl(local.privateDirectory);
  const keyFile = path.join(local.privateDirectory, "receiver.private.pem");
  const key = await readFile(keyFile);
  let config;
  try { config = openHost(registered.envelope, ctx.scope, key); }
  finally { key.fill(0); }
  const file = path.join(local.privateDirectory, "host.local.json");
  try { await save(file, config); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    requireValue(canonical(await load(file)) === canonical(config), "EXISTING_LOCAL_HOST_CONFIG_DIFFERS");
  }
  const result = await hostFetch(config, "/v1/host/devices");
  requireValue(Array.isArray(result.devices), "HOST_AUTH_RESPONSE");
  await save(path.join(ctx.directory, "local-host-authenticated.json"), {
    scopeHash: ctx.scope.scopeHash, hostId: config.hostId, httpsAuthenticated: true, deviceCount: result.devices.length,
    configPath: file, envelopeSha256: sha(JSON.stringify(registered.envelope)), at: new Date().toISOString(),
  });
  await unlink(keyFile);
  await save(path.join(ctx.directory, "local-key-cleanup.json"), {
    scopeHash: ctx.scope.scopeHash, recipientPrivateKeyAbsent: true, plaintextTemporaryFilesCreated: false,
  });
  console.log(JSON.stringify({ hostId: config.hostId, configPath: file, authenticated: true, receiverPrivateKeyRemoved: true }));
}
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    directory: { type: "string" }, "release-directory": { type: "string" }, name: { type: "string" },
    confirm: { type: "string" },
  } });
  const directory = directoryPath(values.directory), command = positionals[0];
  if (command === "init") return init(directory, values["release-directory"], values.name);
  const ctx = await context(directory, command !== "status");
  if (command === "approve") {
    requireValue(values.confirm === ctx.scope.scopeHash, "EXACT_ONBOARDING_CONFIRMATION_REQUIRED");
    await save(path.join(directory, "approval.local.json"), { scopeHash: ctx.scope.scopeHash,
      phases: ctx.scope.phases, issuedAt: Date.now(), expiresAt: ctx.scope.expiresAt });
    console.log("Recorded independent host-only approval; sealed deployment approval was not reopened.");
    return;
  }
  if (command === "adopt") return adopt(ctx);
  if (command === "host-check") {
    const { config, file } = await protectedConfig(ctx);
    const response = await hostFetch(config, "/v1/host/devices");
    console.log(JSON.stringify({ hostId: config.hostId, configPath: file, authenticated: true,
      devices: response.devices.map(d => ({ id: d.id, name: d.name })) }));
    return;
  }
  if (command === "install") {
    const { local, file } = await protectedConfig(ctx);
    const output = execFileSync(process.execPath, [path.join(root, "dist", "cli.js"), "install",
      "--config", file, "--plugin-dir", local.pluginDirectory, "--confirm-install"],
      { cwd: root, encoding: "utf8", windowsHide: true, timeout: 20000, stdio: "pipe" });
    requireValue(!/dph_[A-Za-z0-9_-]{43}/.test(output), "INSTALLER_SECRET_OUTPUT");
    console.log(output.trim());
    return;
  }
  requireValue(["inspect", "register", "finalize", "status"].includes(command), "COMMISSION_COMMAND_DENIED");
  let acknowledgement;
  if (command === "register") {
    const ready = await load(path.join(directory, "inspect-success.json"));
    requireValue(ready.status === "registration_ready" && ready.sameNameCount === 0 &&
      ready.scopeHash === ctx.scope.scopeHash, "EXACT_GUEST_PREFLIGHT_REQUIRED");
  }
  if (command === "finalize") {
    const accepted = await load(path.join(directory, "local-host-authenticated.json"));
    requireValue(accepted.scopeHash === ctx.scope.scopeHash && accepted.httpsAuthenticated, "LOCAL_HOST_AUTH_REQUIRED");
    acknowledgement = { hostId: accepted.hostId, envelopeSha256: accepted.envelopeSha256 };
  }
  const result = command === "status" ? await actionStatus(ctx) : await runAction(ctx, command, acknowledgement);
  if (result.status === "failed") throw new Error("GUEST_PHASE_FAILED_" + result.code);
  if (command !== "status") await save(path.join(directory, command + "-success.json"), result);
  console.log(JSON.stringify({ status: result.status, hostId: result.hostId, sameNameCount: result.sameNameCount,
    target: result.target, handoffRemoved: result.handoffRemoved, logAudit: result.logAudit }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(/^[A-Z][A-Z0-9_ :;-]{0,150}$/.test(error.message) ? error.message : "COMMISSION_FAILED: inspect sanitized phase receipts; no secret output.");
    process.exitCode = 1;
  });
