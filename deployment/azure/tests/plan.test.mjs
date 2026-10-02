import assert from "node:assert/strict";
import { test } from "node:test";
import { makePlan, requireApproval } from "../plan.mjs";
import { fixture } from "./fixture.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";

test("local plan has explicit isolation, single-VM persistence, and no guessed subscription", () => {
  const plan = makePlan(fixture, "a".repeat(64));
  assert.equal(plan.target.resourceGroup, "rg-devpocket-test");
  assert.equal(plan.target.subscriptionId, fixture.AZURE_SUBSCRIPTION_ID);
  assert.equal(plan.vm.size, "Standard_B2s");
  assert.deepEqual(plan.network.publicPorts, [80, 443]);
  assert.equal(plan.network.publicSsh, false);
  assert.equal(plan.storage.sqliteLocation, "local-managed-disk");
  assert.equal(plan.storage.publicBlobAccess, false);
  assert.equal(plan.mutationsAuthorized, false);
  assert.throws(() => makePlan({ ...fixture, AZURE_SUBSCRIPTION_ID: "" }, "a".repeat(64)), /AZURE_SUBSCRIPTION_ID/);
  assert.throws(() => makePlan({ ...fixture, AZURE_RESOURCE_GROUP: "rg-another-project" }, "a".repeat(64)), /AZURE_RESOURCE_GROUP/);
  assert.throws(() => makePlan({ ...fixture, DEVPOCKET_DOMAIN: "http://example.com/;bash" }, "a".repeat(64)), /domain/i);
});

test("cloud mutation is blocked without exact, unexpired, phase-specific local approval", () => {
  const plan = makePlan(fixture, "a".repeat(64));
  const now = Date.parse("2026-10-02T00:00:00Z");
  const approval = {
    schemaVersion: 1, planHash: plan.planHash, phases: ["provision"],
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
  };
  assert.throws(() => requireApproval(plan, undefined, "provision", now), /approval/i);
  requireApproval(plan, approval, "provision", now);
  assert.throws(() => requireApproval(plan, approval, "deploy", now), /deploy/);
  assert.throws(() => requireApproval(plan, { ...approval, expiresAt: new Date(now - 1).toISOString() }, "provision", now), /expired/i);
  const changed = makePlan({ ...fixture, DEVPOCKET_VM_SIZE: "Standard_D2s_v5" }, "a".repeat(64));
  assert.throws(() => requireApproval(changed, approval, "provision", now), /changed/i);
  assert.throws(() => requireApproval(makePlan(fixture, "b".repeat(64)), approval, "provision", now), /changed/i);
});

test("real hook entry point refuses unapproved operations before any Azure call, and down always fails closed", async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const parent = path.join(root, ".data", "azure-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "guard-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "input.local.json");
  await writeFile(config, JSON.stringify(fixture));
  const hook = path.join(root, "deployment", "azure", "cli.mjs");
  for (const phase of ["preprovision", "predeploy", "postdeploy", "start"]) {
    const result = spawnSync(process.execPath, [hook, phase, "--config", config], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Explicit local approval is required/);
    assert.ok(!result.stderr.includes("credential") && !result.stderr.includes("Logged in"));
  }
  const down = spawnSync(process.execPath, [hook, "predown"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(down.status, 1);
  assert.match(down.stderr, /intentionally disabled/);
});
