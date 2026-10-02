import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { requireHostApproval, parseResult, renderAction, runAction } from "../action.mjs";

test("host-only authority and safe result contracts cannot inherit deployment approvals or print credentials", () => {
  const scope = { scopeHash: "a".repeat(64), expiresAt: Date.now() + 60000 };
  const approval = { scopeHash: scope.scopeHash, phases: ["real-key", "upload"], expiresAt: scope.expiresAt };
  assert.throws(() => requireHostApproval(scope, approval, "register"), /HOST_PHASE_DENIED/);
  assert.throws(() => requireHostApproval(scope, undefined, "inspect"), /HOST_APPROVAL_REQUIRED/);
  const raw = (result) => ({ value: [{ message: "DEVPOCKET_HOST_RESULT=" + JSON.stringify(result) }] });
  assert.throws(() => parseResult(raw({ scopeHash: scope.scopeHash, status: "failed", code: "some secret text" }), scope), /UNSAFE_RESULT/);
  assert.throws(() => parseResult(raw({ scopeHash: scope.scopeHash, status: "failed", code: "dph_" + "A".repeat(43) }), scope), /SECRET_OUTPUT/);
});

test("an ambiguous Action is not posted again and blocks registration or cleanup until read-only reconciliation", async (t) => {
  const parent = path.resolve(".data", "onboarding-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "unknown-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let posts = 0;
  const ctx = { directory, scope: { scopeHash: "a".repeat(64), vmId: "/subscriptions/test/vm/fixed", maxActions: 6 },
    authorize: async () => {}, verify: async () => {},
    render: async () => ({ commandId: "RunShellScript", script: ["exit 0"] }),
    api: { arm: async () => { posts++; throw new Error("SIMULATED_LOST_RESPONSE"); } } };
  await assert.rejects(runAction(ctx, "inspect"), /ACTION_UNCERTAIN/);
  await assert.rejects(runAction(ctx, "register"), /PREVIOUS_ACTION_UNSETTLED/);
  await assert.rejects(runAction(ctx, "finalize"), /PREVIOUS_ACTION_UNSETTLED/);
  assert.equal(posts, 1);
  assert.ok(await stat(path.join(directory, "action.inflight")));
});

test("the actual generic guest bundle stays within measured Action capacity and exposes its callable entry point", async () => {
  const publicKey = generateKeyPairSync("rsa", { modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" } }).publicKey;
  const scope = { scopeHash: "a".repeat(64), operationId: "11111111-1111-4111-8111-111111111111",
    vmId: "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-fixture/providers/Microsoft.Compute/virtualMachines/vm-fixture",
    imageId: "sha256:" + "b".repeat(64), releaseId: "c".repeat(64), nonce: "d".repeat(64),
    publicKeyPem: publicKey, relayUrl: "https://fixture.example", bridgeDataDir: "C:\\PrivateFixture\\bridge",
    expiresAt: Date.now() + 60000 };
  for (const action of ["inspect", "register", "finalize"]) {
    const body = await renderAction(process.cwd(), scope, action,
      action === "finalize" ? { hostId: "22222222-2222-4222-8222-222222222222", envelopeSha256: "e".repeat(64) } : undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 36369);
    assert.ok(!JSON.stringify(body).includes("BEGIN PRIVATE KEY"));
    const match = body.script[4].match(/main\(json\.loads\(base64\.b64decode\("([A-Za-z0-9+/=]+)"\)\)\)/);
    assert.ok(match);
    const payload = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    const processResult = spawnSync(process.execPath, ["--input-type=module", "-"], {
      input: payload.nodeBundle + "\nif (typeof guestMain !== 'function') process.exit(2);",
      encoding: "utf8", timeout: 10000,
    });
    assert.equal(processResult.status, 0, "The rendered bundle must provide its actual guestMain binding.");
  }
});
