import assert from "node:assert/strict";
import { test } from "node:test";
import { azdToken, AzureRequestNotAdmittedError, AzureSetupClient, vmParts } from "../setup-azure.mjs";

const tenantId = "11111111-1111-4111-8111-111111111111";
const principalId = "22222222-2222-4222-8222-222222222222";
const subscriptionId = "33333333-3333-4333-8333-333333333333";
const deploymentId = "44444444-4444-4444-8444-444444444444";
const groupId = `/subscriptions/${subscriptionId}/resourceGroups/rg-fixture`;
const vmId = `${groupId}/providers/Microsoft.Compute/virtualMachines/relay`;
const tags = { application: "DevPocket", "devpocket-deployment-id": deploymentId, "azd-env-name": "fixture" };
const vm = { id: vmId, tags, properties: { vmId: "55555555-5555-4555-8555-555555555555",
  storageProfile: { osDisk: { osType: "Linux" }, dataDisks: [{ lun: 0, managedDisk: { id: groupId + "/providers/Microsoft.Compute/disks/data" } }] },
  instanceView: { statuses: [{ code: "PowerState/running" }] },
} };

test("azd token acquisition explicitly requests JSON for default and selected tenants", async () => {
  const claims = Buffer.from(JSON.stringify({ tid: tenantId, oid: principalId, exp: Math.floor(Date.now() / 1000) + 600 }))
    .toString("base64url");
  const token = `fixture.${claims}.signature`;
  for (const tenant of [undefined, tenantId]) {
    const calls = [];
    const result = await azdToken(tenant, async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: args.includes("--output") && args[args.indexOf("--output") + 1] === "json"
        ? JSON.stringify({ token }) : token };
    });
    assert.deepEqual(result, { token, tenantId, principalId });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, process.platform === "win32" ? "azd.exe" : "azd");
    assert.deepEqual(calls[0].args, ["auth", "token", "--scope", "https://management.azure.com/.default",
      "--output", "json", "--no-prompt", ...(tenant ? ["--tenant-id", tenant] : [])]);
    assert.equal(calls[0].options.timeout, 30_000);
  }
});

function fixture() {
  const calls = [], tokenRequests = [];
  const state = { token: { token: "PRIVATE_ARM_TOKEN", tenantId, principalId }, vm: structuredClone(vm),
    group: { tags }, subscription: { state: "Enabled", tenantId }, tenants: { value: [{ tenantId, displayName: "Directory" }] } };
  const client = new AzureSetupClient({
    getToken: async (tenant) => {
      tokenRequests.push(tenant);
      if (state.tokenFailure) throw new Error(state.tokenFailure);
      return state.token;
    },
    fetcher: async (url, options) => {
      calls.push({ url: String(url), options });
      const target = new URL(url);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, `Bearer ${state.token.token}`);
      if (options.method === "POST" && state.postStatus)
        return new Response("", { status: state.postStatus });
      const value = target.pathname === "/tenants" ? state.tenants :
        target.pathname === "/subscriptions" ? { value: [{ subscriptionId, displayName: "Subscription", state: "Enabled" }] } :
        target.pathname === `/subscriptions/${subscriptionId}` ? state.subscription :
        target.pathname === groupId ? state.group : target.pathname === vmId ? state.vm :
        target.pathname.endsWith("/virtualMachines") ? { value: [{ ...state.vm, name: "relay" }, { id: vmId + "-unrelated", tags: {} }] } :
        { value: [] };
      return new Response(JSON.stringify(value), { status: 200 });
    },
  });
  return { client, state, calls, tokenRequests };
}

test("pre-dispatch POST failures have explicit non-admission evidence and never reach fetch", async () => {
  for (const failure of ["login", "principal", "serialization"]) {
    const f = fixture();
    await f.client.selectTenant(tenantId);
    await f.client.target(vmId);
    const before = f.calls.length;
    const body = { commandId: "RunShellScript", script: [] };
    if (failure === "login") f.state.tokenFailure = "AZURE_LOGIN_REQUIRED: private diagnostic details must not escape";
    else if (failure === "principal") f.state.token.principalId = "88888888-8888-4888-8888-888888888888";
    else body.circular = body;
    await assert.rejects(f.client.arm(`${vmId}/runCommand?api-version=2024-07-01`, { method: "POST", body }),
      (error) => error instanceof AzureRequestNotAdmittedError &&
        /^[A-Z][A-Z0-9_]+$/.test(error.message) && !error.message.includes("private"));
    assert.equal(f.calls.length, before);
  }
});

test("only definitive POST authentication rejections are classified as not admitted", async () => {
  for (const status of [401, 403, 500, 503]) {
    const f = fixture();
    await f.client.selectTenant(tenantId);
    await f.client.target(vmId);
    const before = f.calls.length;
    f.state.postStatus = status;
    await assert.rejects(f.client.arm(`${vmId}/runCommand?api-version=2024-07-01`,
      { method: "POST", body: { commandId: "RunShellScript", script: [] } }),
    (error) => error.message === `AZURE_REQUEST_REJECTED_${status}` &&
      (error instanceof AzureRequestNotAdmittedError) === [401, 403].includes(status));
    assert.equal(f.calls.length, before + 1);
  }
});

test("setup discovers enabled subscriptions and tagged VMs with an explicitly bound Azure identity", async () => {
  const f = fixture();
  assert.deepEqual(await f.client.tenants(), [{ id: tenantId, name: "Directory" }]);
  await f.client.selectTenant(tenantId);
  assert.deepEqual(await f.client.subscriptions(), [{ id: subscriptionId, name: "Subscription" }]);
  assert.deepEqual(await f.client.machines(subscriptionId), [{ id: vmId, name: "relay (rg-fixture)" }]);
  const target = await f.client.target(vmId);
  assert.equal(target.vmUniqueId, vm.properties.vmId);
  assert.equal(target.deploymentId, deploymentId);
  assert.equal(target.principalId, principalId);
  await f.client.verify(target);
  f.state.vm.properties.vmId = "66666666-6666-4666-8666-666666666666";
  await assert.rejects(f.client.verify(target), /SETUP_AZURE_TARGET_CHANGED/);
  assert.ok(f.calls.every((call) => call.options.method === "GET"));
  assert.ok(f.tokenRequests.slice(1).every((tenant) => tenant === tenantId));
});

test("ARM requests and polling cannot escape the selected VM/subscription or transmit tokens off-origin", async () => {
  const f = fixture();
  await f.client.selectTenant(tenantId);
  await f.client.target(vmId);
  const before = f.calls.length;
  for (const url of [
    "https://attacker.example/collect",
    `https://management.azure.com@attacker.example/subscriptions/${subscriptionId}`,
    `https://management.azure.com/subscriptions/${"7".repeat(36)}/operations/id`,
  ]) await assert.rejects(f.client.arm(url), /ARM_/);
  await assert.rejects(f.client.arm(`${vmId}-other/runCommand?api-version=2024-07-01`, { method: "POST", body: {} }), /ARM_METHOD/);
  await assert.rejects(f.client.arm(`${vmId}?api-version=2024-07-01`, { method: "DELETE" }), /ARM_METHOD/);
  assert.equal(f.calls.length, before);
  await f.client.arm(`${vmId}/runCommand?api-version=2024-07-01`, { method: "POST", body: { commandId: "RunShellScript", script: [] } });
  assert.equal(f.calls.length, before + 1);
  f.state.token = { ...f.state.token, principalId: "88888888-8888-4888-8888-888888888888" };
  await assert.rejects(f.client.arm(`${vmId}?api-version=2024-07-01`), /AZURE_PRINCIPAL_CHANGED/);
  assert.equal(f.calls.length, before + 1);
});

test("ownership, powered-off machines and cross-tenant subscriptions are rejected before Run Command", async () => {
  for (const mutate of [
    (s) => { s.vm.tags = { ...tags, application: "Different app" }; },
    (s) => { s.group = { tags: { ...tags, "devpocket-deployment-id": "99999999-9999-4999-8999-999999999999" } }; },
    (s) => { s.vm.properties.instanceView.statuses = [{ code: "PowerState/deallocated" }]; },
    (s) => { s.subscription.tenantId = "99999999-9999-4999-8999-999999999999"; },
    (s) => { s.vm.properties.storageProfile.dataDisks = []; },
  ]) {
    const f = fixture();
    await f.client.selectTenant(tenantId);
    mutate(f.state);
    await assert.rejects(f.client.target(vmId));
    assert.ok(f.calls.every((call) => call.options.method === "GET"));
  }
  assert.throws(() => vmParts("https://example.test/not-a-vm"), /INVALID_AZURE_VM_ID/);
});

test("discovery rejects untrusted pagination URLs without making a second request", async () => {
  const f = fixture();
  f.state.tenants.nextLink = "https://attacker.example/next";
  await assert.rejects(f.client.tenants(), /ARM_ORIGIN/);
  assert.equal(f.calls.length, 1);
});
