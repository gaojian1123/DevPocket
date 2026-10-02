import assert from "node:assert/strict";
import { test } from "node:test";
import { makePlan, requireApproval } from "../plan.mjs";
import { fixture } from "./fixture.mjs";
import { makeRecoveryPlan, verifyDnsEvidence, permittedChanges } from "../recovery-plan.mjs";
import { RecoveryOperations } from "../recovery-cloud.mjs";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareApplication } from "../application.mjs";

const base = makePlan(fixture, "a".repeat(64));
const config = {
  recoveryId: "001", basePlanHash: base.planHash,
  newPublicIpName: `${base.names.publicIp}-r001`, newDnsLabel: `${base.network.dnsLabel}-r001`,
  replacementUploadIpv4: "203.0.113.11",
};
const baseline = {
  oldPublicIp: { id: "old-pip", properties: { ipAddress: "198.51.100.50", dnsSettings: {
    domainNameLabel: base.network.dnsLabel, domainNameLabelScope: "ResourceGroupReuse", fqdn: "old.assigned.example",
  } } },
  nic: { id: "nic", properties: { ipConfigurations: [{ name: "relay", properties: {
    primary: true, privateIPAddress: "10.83.0.4", privateIPAllocationMethod: "Dynamic", publicIPAddress: { id: "old-pip" },
  } }] } },
  storage: { id: "storage", properties: { networkAcls: { ipRules: [{ value: fixture.DEVPOCKET_UPLOAD_IPV4, action: "Allow" }] } } },
};

test("recovery plan keeps ownership and old PIP and cannot inherit the original provisioning approval", () => {
  const plan = makeRecoveryPlan(base, config, baseline, "b".repeat(64));
  assert.deepEqual(plan.target, base.target);
  assert.deepEqual(plan.vm, base.vm);
  assert.equal(plan.recovery.oldPublicIpName, base.names.publicIp);
  assert.equal(plan.names.publicIp, config.newPublicIpName);
  assert.equal(plan.recovery.newDomainNameLabelScope, null);
  assert.equal(plan.network.uploadIpv4, "203.0.113.11");
  assert.deepEqual(plan.recovery.deleteResources, []);
  const approval = { schemaVersion: 1, planHash: base.planHash, phases: ["provision", "upload", "deploy", "start"],
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  assert.throws(() => requireApproval(plan, approval, "create-ingress"), /changed/);
  assert.throws(() => makeRecoveryPlan(base, { ...config, newPublicIpName: base.names.publicIp }, baseline, "b".repeat(64)), /new/i);
  assert.throws(() => makeRecoveryPlan(base, { ...config, replacementUploadIpv4: "203.0.113.0/24" }, baseline, "b".repeat(64)), /IPv4/i);
});

test("switch DNS gate only accepts recent observations of the exact Azure-returned ordinary name and new IP", () => {
  const plan = makeRecoveryPlan(base, config, baseline, "b".repeat(64));
  const current = { id: "new-pip", etag: "etag-1", properties: { provisioningState: "Succeeded", ipAddress: "198.51.100.51",
    dnsSettings: { domainNameLabel: config.newDnsLabel, fqdn: "real-label.eastus2.cloudapp.azure.com" } } };
  const now = Date.now();
  const evidence = { planHash: plan.planHash, at: new Date(now).toISOString(), resourceId: "new-pip", etag: "etag-1",
    host: current.properties.dnsSettings.fqdn, ip: "198.51.100.51",
    resolvers: [{ name: "Google", status: 0, addresses: ["198.51.100.51"] }, { name: "Cloudflare", status: 0, addresses: ["198.51.100.51"] }] };
  verifyDnsEvidence(plan, current, evidence, now);
  assert.throws(() => verifyDnsEvidence(plan, current, { ...evidence, host: "guessed.example.com" }, now), /exact/);
  assert.throws(() => verifyDnsEvidence(plan, current, { ...evidence, resolvers: [{ name: "Google", status: 3, addresses: [] }] }, now), /DNS/);
  assert.throws(() => verifyDnsEvidence(plan, current, evidence, now + 16 * 60000), /expired/);
  assert.throws(() => verifyDnsEvidence(plan, { ...current, properties: { ...current.properties,
    dnsSettings: { ...current.properties.dnsSettings, domainNameLabelScope: "ResourceGroupReuse" } } }, evidence, now), /scop/i);
});

test("phase previews never permit old-PIP, VM, disk or unrelated modification/deletion", () => {
  const plan = makeRecoveryPlan(base, config, baseline, "b".repeat(64));
  const prefix = `/subscriptions/${plan.target.subscriptionId}/resourceGroups/${plan.target.resourceGroup}/providers`;
  const ip = `${prefix}/Microsoft.Network/publicIPAddresses/${plan.names.publicIp}`;
  const nic = `${prefix}/Microsoft.Network/networkInterfaces/${plan.names.nic}`;
  const storage = `${prefix}/Microsoft.Storage/storageAccounts/${plan.names.storageAccount}`;
  permittedChanges(plan, "create-ingress", [{ resourceId: ip, changeType: "Create" }]);
  permittedChanges(plan, "switch-ingress", [{ resourceId: nic, changeType: "Modify" }, { resourceId: storage, changeType: "Modify" }]);
  assert.throws(() => permittedChanges(plan, "create-ingress", [{ resourceId: nic, changeType: "Modify" }]), /outside/);
  assert.throws(() => permittedChanges(plan, "switch-ingress", [{ resourceId: ip, changeType: "Delete" }]), /outside|Delete/);
  assert.throws(() => permittedChanges(plan, "switch-ingress", [{
    resourceId: nic, changeType: "Modify", delta: [{ path: "properties.enableIPForwarding", propertyChangeType: "Modify", before: false, after: true }],
  }]), /outside/);
  assert.throws(() => permittedChanges(plan, "switch-ingress", [{
    resourceId: storage, changeType: "Modify", delta: [{ path: "properties.allowSharedKeyAccess", propertyChangeType: "Modify", before: false, after: true }],
  }]), /outside/);
});

test("actual switch orchestration cannot submit ARM changes when the assigned hostname is NXDOMAIN", async (t) => {
  const group = `/subscriptions/${base.target.subscriptionId}/resourceGroups/${base.target.resourceGroup}`;
  const prefix = `${group}/providers`;
  const tags = { application: "DevPocket", "azd-env-name": base.target.environment, "devpocket-deployment-id": base.target.deploymentId };
  const state = structuredClone(baseline);
  state.oldPublicIp.id = `${prefix}/Microsoft.Network/publicIPAddresses/${base.names.publicIp}`;
  state.nic.kind = "Regular";
  state.nic.tags = tags;
  Object.assign(state.nic.properties, { allowPort25Out: false, enableAcceleratedNetworking: false, enableIPForwarding: false });
  Object.assign(state.nic.properties.ipConfigurations[0].properties, {
    publicIPAddress: { id: state.oldPublicIp.id }, subnet: { id: `${prefix}/Microsoft.Network/virtualNetworks/${base.names.network}/subnets/relay` },
  });
  state.storage.tags = tags;
  Object.assign(state.storage.properties, { allowSharedKeyAccess: false, allowBlobPublicAccess: false,
    supportsHttpsTrafficOnly: true, minimumTlsVersion: "TLS1_2", publicNetworkAccess: "Enabled" });
  Object.assign(state.storage.properties.networkAcls, { defaultAction: "Deny", bypass: "None",
    virtualNetworkRules: [{ action: "Allow", id: `${prefix}/Microsoft.Network/virtualNetworks/${base.names.network}/subnets/relay` }] });
  state.vm = { identity: { principalId: "fixture-vm" }, properties: { hardwareProfile: { vmSize: base.vm.size },
    storageProfile: { osDisk: { name: "retained-os" }, dataDisks: [{ name: base.names.dataDisk }] } } };
  const plan = makeRecoveryPlan(base, config, state, "b".repeat(64));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  await mkdir(path.join(root, ".data", "azure-tests"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".data", "azure-tests", "dns-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const operations = new RecoveryOperations(plan, state, directory);
  const jwt = Buffer.from(JSON.stringify({ tid: base.target.tenantId, oid: base.target.deployerObjectId })).toString("base64url");
  operations.credential = { getToken: async () => ({ token: `fixture.${jwt}.not-a-credential` }) };
  let mutationCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const parsed = new URL(url);
    if (parsed.host !== "management.azure.com") return new Response(JSON.stringify({ Status: 3, Answer: [] }));
    if (options.method !== "GET") { mutationCalls++; throw new Error("ARM mutation must not run"); }
    const name = parsed.pathname;
    let result;
    if (name === `/subscriptions/${base.target.subscriptionId}`) result = { state: "Enabled" };
    else if (name === group) result = { location: base.target.location, tags };
    else if (name.endsWith("/resources") || name.endsWith("/roleAssignments")) result = { value: [] };
    else if (name === `${prefix}/Microsoft.Network/publicIPAddresses/${plan.names.publicIp}`) result = {
      id: name, etag: "new-etag", tags: { ...tags, "devpocket-recovery-id": "001" }, sku: { name: "Standard" },
      properties: { provisioningState: "Succeeded", publicIPAllocationMethod: "Static", publicIPAddressVersion: "IPv4",
        ipAddress: "198.51.100.51", dnsSettings: { domainNameLabel: config.newDnsLabel, fqdn: "actual.eastus2.cloudapp.azure.com" } },
    };
    else if (name.includes("/publicIPAddresses/")) result = state.oldPublicIp;
    else if (name.includes("/networkInterfaces/")) result = state.nic;
    else if (name.includes("/storageAccounts/")) result = state.storage;
    else if (name.includes("/virtualMachines/")) result = state.vm;
    else result = { registrationState: "Registered" };
    return new Response(JSON.stringify(result));
  });
  await assert.rejects(operations.executePhase("switch-ingress", {}, async () => {}), /DNS/);
  assert.equal(mutationCalls, 0);
});

test("the recovery entry point refuses mutations without recovery-specific approval, despite original approval", async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const parent = path.join(root, ".data", "azure", "recovery-guard-fixture");
  await mkdir(parent, { recursive: true });
  const directory = path.join(parent, "recovery-001");
  await mkdir(directory);
  t.after(() => rm(parent, { recursive: true, force: true }));
  for (const [name, value] of [["base-plan.json", base], ["input.local.json", config], ["baseline.json", baseline],
    ["original-approval.evidence.json", { schemaVersion: 1, planHash: base.planHash, phases: ["provision", "upload", "deploy", "start"] }]]) {
    await writeFile(path.join(directory, name), JSON.stringify(value));
  }
  for (const phase of ["create-ingress", "switch-ingress", "prepare-deploy", "deploy", "start"]) {
    const result = spawnSync(process.execPath, [path.join(root, "deployment", "azure", "recovery.mjs"), phase, "--directory", directory],
      { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Explicit local approval is required/);
  }
});

test("application packaging and upload cannot start before the completed recovery/DNS gate", async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const parent = path.join(root, ".data", "azure-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "application-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plan = makeRecoveryPlan(base, config, baseline, "b".repeat(64));
  const operations = new RecoveryOperations(plan, baseline, directory);
  await assert.rejects(prepareApplication({ root, directory, plan }, operations, async () => {}),
    /completed recovery network-switch receipt/);
  await assert.rejects(stat(path.join(directory, "packages")), { code: "ENOENT" });
});
