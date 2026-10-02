import assert from "node:assert/strict";
import { test } from "node:test";
import { assertOwnedGroup, assertRunResult, AzureOperations } from "../cloud.mjs";
import { makePlan } from "../plan.mjs";
import { fixture } from "./fixture.mjs";

test("resource collisions and superficially successful Run Command responses never count as deployment", () => {
  const plan = makePlan(fixture, "a".repeat(64));
  assert.throws(() => assertOwnedGroup({ location: "eastus2", tags: { application: "Unrelated" } }, plan), /ownership/);
  assertOwnedGroup({ location: "eastus2", tags: {
    application: "DevPocket", "azd-env-name": plan.target.environment, "devpocket-deployment-id": plan.target.deploymentId,
  } }, plan);
  assert.throws(() => assertRunResult({ value: [{ code: "ProvisioningState/succeeded", message: "Accepted" }] }, "start"), /evidence/);
  assert.throws(() => assertRunResult({ value: [{ message: "DEVPOCKET_PHASE=failed\nDEVPOCKET_PHASE=internal_health_passed" }] }, "start"), /evidence/);
  assert.equal(assertRunResult({ value: [{ message: "DEVPOCKET_PHASE=internal_health_passed" }] }, "start"), "internal_health_passed");
});

test("ARM helper uses the exact tenant/principal and refuses subscription escape before a network call", async (t) => {
  const plan = makePlan(fixture, "a".repeat(64));
  const operations = new AzureOperations(plan);
  const token = (claims) => `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.not-a-credential`;
  operations.credential = { getToken: async () => ({ token: token({ tid: plan.target.tenantId, oid: plan.target.deployerObjectId }) }) };
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests++;
    assert.equal(url, `https://management.azure.com/subscriptions/${plan.target.subscriptionId}?api-version=2022-12-01`);
    assert.equal(options.method, "GET");
    return new Response(JSON.stringify({ state: "Enabled" }), { status: 200 });
  });
  await operations.arm(`/subscriptions/${plan.target.subscriptionId}?api-version=2022-12-01`);
  await assert.rejects(operations.arm("/subscriptions/not-this-subscription/resources"), /explicitly selected/);
  assert.equal(requests, 1);
  operations.credential = { getToken: async () => ({ token: token({ tid: "another-tenant", oid: plan.target.deployerObjectId }) }) };
  await assert.rejects(operations.arm(`/subscriptions/${plan.target.subscriptionId}?api-version=2022-12-01`), /differs from the approved/);
  assert.equal(requests, 1);
});

test("official ARM asynchronous what-if accepts an empty 202 body and retains its polling URL", async (t) => {
  const plan = makePlan(fixture, "a".repeat(64));
  const operations = new AzureOperations(plan);
  const claims = Buffer.from(JSON.stringify({ tid: plan.target.tenantId, oid: plan.target.deployerObjectId })).toString("base64url");
  operations.credential = { getToken: async () => ({ token: `fixture.${claims}.not-a-credential` }) };
  const location = `https://management.azure.com/subscriptions/${plan.target.subscriptionId}/operations/fixture?api-version=2022-09-01`;
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 202, headers: { Location: location } }));
  const response = await operations.arm(`/subscriptions/${plan.target.subscriptionId}/providers/Microsoft.Resources/deployments/preview/whatIf?api-version=2022-09-01`,
    { method: "POST", body: { properties: {} } });
  assert.equal(response.status, 202);
  assert.deepEqual(response.value, {});
  assert.equal(response.headers.get("location"), location);
});
