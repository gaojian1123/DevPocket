import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInterruption } from "./fixtures/linux-process.mjs";

assert.equal(process.platform, "linux", "Privileged process preparation requires the hosted Ubuntu job.");

test("trusted Linux preparation terminates and reaps privileged process families", async (t) => {
  for (const cancelled of [false, true]) {
    await t.test(cancelled ? "privileged cancellation" : "privileged timeout", (t) => checkInterruption(t, cancelled, true));
  }
});
