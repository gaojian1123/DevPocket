import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadImmutable } from "../cloud.mjs";

test("recovery upload makes at most one retry with the same exact blob and then stops on persistent 403", async () => {
  let attempts = 0, delays = 0;
  const target = {
    url: "https://fixture.blob.core.windows.net/releases/packages/immutable.tar.gz",
    uploadFile: async (file, options) => {
      attempts++;
      assert.equal(file, "same-local-package");
      assert.equal(options.conditions.ifNoneMatch, "*");
      assert.equal(options.metadata.sha256, "a".repeat(64));
      throw { statusCode: 403, code: "AuthorizationFailure" };
    },
  };
  await assert.rejects(uploadImmutable(target, { file: "same-local-package", sha256: "a".repeat(64), size: 42 },
    { maxAttempts: 2, pause: async () => { delays++; } }), /403/);
  assert.equal(attempts, 2);
  assert.equal(delays, 1);
});

test("an existing immutable upload is accepted only if its exact digest and size match", async () => {
  const blob = {
    url: "https://fixture.blob.core.windows.net/releases/packages/immutable.tar.gz",
    uploadFile: async () => { throw { statusCode: 412 }; },
    getProperties: async () => ({ metadata: { sha256: "b".repeat(64) }, contentLength: 42 }),
  };
  await assert.rejects(uploadImmutable(blob, { file: "unused", sha256: "a".repeat(64), size: 42 },
    { maxAttempts: 2 }), /different/);
});
