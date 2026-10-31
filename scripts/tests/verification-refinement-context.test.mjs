import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { executeVerification, verificationPlan } from "../verification.mjs";
import { digest, exec, fixture, nativeEvidence, nativeTest, planned, save, selected, view } from "./fixtures/apple-refinement.mjs";

nativeTest("Git environment changes remain explicit blockers even when source is unchanged", async (t) => {
  const f = await fixture(t), plan = await planned(f), native = await nativeEvidence(f, plan);
  await exec("git", ["config", "core.quotePath", "false"], { cwd: f.root });
  const next = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() });
  assert.equal(next.status, "full_required");
  assert.ok(next.reasons.includes("environment-changed"));
  await assert.rejects(f.invoke(native.request), { diagnosticCode: "environment-changed" });
});

nativeTest("native SDK, toolchain and loader environment drift requires the full gate", async (t) => {
  const f = await fixture(t);
  await planned(f);
  for (const name of ["SDKROOT", "TOOLCHAINS", "DYLD_TEST_NATIVE_BINDING"]) {
    const original = process.env[name];
    try {
      process.env[name] = "synthetic-changed-native-input";
      const result = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() });
      assert.equal(result.status, "full_required", name);
      assert.ok(result.reasons.includes("environment-changed"), name);
      assert.deepEqual(result.changedFiles, [view]);
    } finally {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  }
});

nativeTest("checkpoint creation cannot adopt drift after the accepted full run", async (t) => {
  const f = await fixture(t);
  await exec("git", ["config", "core.quotePath", "false"], { cwd: f.root });
  await assert.rejects(f.invoke(f.request), { diagnosticCode: "environment-changed" });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, ".data/verification/full/report.json"))), f.report);
});

nativeTest("old ordinary reports without a captured native context cannot seed refinement", async (t) => {
  const f = await fixture(t), plan = await verificationPlan(f.root, f.base);
  const report = await executeVerification(f.root, plan, { directory: path.join(f.root, ".data/verification/without-context") });
  assert.equal(report.status, "passed");
  await save(f.root, ".data/verification/without-context/report.json", report);
  await assert.rejects(f.invoke({ ...f.prepareRequest, verification: ".data/verification/without-context/report.json" }),
    { diagnosticCode: "environment-changed" });
});

nativeTest("ignored renderer, prepared-module and installed-dependency drift require the ordinary route", async (t) => {
  const f = await fixture(t);
  await planned(f);
  for (const file of ["apple/DevPocket/Renderer/component.js", "packages/components/dist/spec.js",
    "node_modules/fixture-dependency/index.js"]) {
    const original = await readFile(path.join(f.root, file), "utf8");
    await save(f.root, file, original + "\n// Changed ignored input\n");
    const result = await f.invoke({ action: "plan", checkpoint: ".data/verification/checkpoint.json", selection: selected() });
    assert.equal(result.status, "full_required");
    assert.ok(result.reasons.includes("environment-changed"));
    assert.deepEqual(result.changedFiles, [view]);
    await save(f.root, file, original);
  }
});

nativeTest("ignored native drift during a binding cannot be qualified", async (t) => {
  const f = await fixture(t);
  await planned(f);
  const before = await f.invoke({ action: "binding", plan: ".data/verification/plan.json" });
  await save(f.root, ".data/apple/before-drift.json", before);
  await save(f.root, "apple/DevPocket/Renderer/component.js", "Changed after observation\n");
  await assert.rejects(f.invoke({ action: "binding", plan: ".data/verification/plan.json", before: ".data/apple/before-drift.json" }),
    { diagnosticCode: "environment-changed" });
});

nativeTest("a self-consistent app seal does not replace the accepted prepared renderer", async (t) => {
  const f = await fixture(t), item = f.prepareRequest.acceptedProducts[0];
  const seal = JSON.parse(await readFile(path.join(f.root, item.artifact)));
  await save(f.root, item.bundle + "/Renderer/component.js", "Different packaged renderer\n");
  seal.files["Renderer/component.js"] = digest("Different packaged renderer\n");
  await save(f.root, item.artifact, seal);
  await assert.rejects(f.invoke(f.prepareRequest), { diagnosticCode: "artifact-changed" });
});

nativeTest("an old same-source review cannot accept a new environment or verification subject", async (t) => {
  const f = await fixture(t);
  await exec("git", ["config", "core.quotePath", "false"], { cwd: f.root });
  const report = await executeVerification(f.root, await verificationPlan(f.root, f.base),
    { directory: path.join(f.root, ".data/verification/new-context"), captureRefinementContext: true });
  assert.equal(report.complete, true);
  await save(f.root, ".data/verification/new-context/report.json", report);
  const subject = await f.invoke({ ...f.prepareRequest, verification: ".data/verification/new-context/report.json" });
  await save(f.root, ".data/verification/new-subject.json", subject);
  await assert.rejects(f.invoke({ ...f.request, subject: ".data/verification/new-subject.json" }),
    { diagnosticCode: "check-failed" });
});
