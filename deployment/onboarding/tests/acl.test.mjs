import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { privateAcl } from "../commission.mjs";

test("Windows recipient storage grants only the current user and SYSTEM when launched from Node", {
  skip: process.platform !== "win32",
}, async (t) => {
  const directory = path.resolve(".data", "onboarding-tests", "acl-" + randomUUID());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const created = privateAcl(directory, true);
  const checked = privateAcl(directory);
  assert.equal(created.protected, true);
  assert.equal(checked.protected, true);
  assert.deepEqual(new Set(checked.allowedSids), new Set([checked.ownerSid, "S-1-5-18"]));
  assert.throws(() => privateAcl(directory, true), /PRIVATE_DIRECTORY_ACL_FAILED/);
});
