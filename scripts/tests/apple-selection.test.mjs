import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { APPLE_REQUIREMENTS } from "../apple-evidence.mjs";
import { CHECKS, verificationImpact, projectVerificationSelection } from "../verification-policy.mjs";
import { verificationPlan } from "../verification.mjs";

const exec = promisify(execFile);
const existing = CHECKS.filter((check) => check.group !== "apple").map((check) => check.id);

test("ordinary Apple features select native Apple checks without backend or Android product checks", () => {
  for (const file of [
    "apple/DevPocket/DevPocket/ContentView.swift",
    "apple/DevPocket/DevPocket/FixtureState.swift",
    "apple/DevPocket/DevPocket/AnotherFeature.swift",
    "apple/DevPocket/DevPocket/Assets.xcassets/AccentColor.colorset/Contents.json",
    "apple/DevPocket/DevPocketTests/DevPocketTests.swift",
    "apple/Fixtures/components.json",
  ]) {
    const plan = verificationImpact([file]);
    assert.deepEqual(plan.requiredChecks, ["apple-native"], file);
    assert.deepEqual(plan.requiredGroups, ["apple"], file);
    assert.deepEqual(plan.apple, APPLE_REQUIREMENTS);
    assert.equal(plan.layouts, false);
    assert.equal(plan.ciMacos, false);
  }
});

test("Apple execution inputs add tooling rather than unrelated product suites", () => {
  for (const file of [
    "apple/prepare-components.mjs",
    "apple/DevPocket/DevPocket.xcodeproj/project.pbxproj",
    "apple/DevPocket/DevPocket.xcodeproj/xcshareddata/xcschemes/DevPocket.xcscheme",
    "apple/Package.swift",
    "apple/package.json",
    "apple/AGENTS.md",
  ]) {
    const plan = verificationImpact([file]);
    assert.deepEqual(plan.requiredChecks, ["tooling-tests", "apple-native"], file);
    assert.deepEqual(plan.requiredGroups, ["tooling", "apple"], file);
    assert.equal(plan.ciMacos, true);
  }
  assert.deepEqual(verificationImpact(["apple/README.md"]).requiredChecks, []);
});

test("shared and mixed changes retain every affected platform", () => {
  const both = verificationImpact(["apple/DevPocket/DevPocket/ContentView.swift", "backend/src/protocol.ts"]);
  assert.ok(both.requiredChecks.includes("apple-native"));
  assert.ok(both.requiredChecks.includes("android-device"));
  assert.ok(both.requiredChecks.includes("backend-tests"));
  for (const file of ["packages/components/src/renderer.ts", "package-lock.json", ".github/workflows/ci.yml"]) {
    assert.deepEqual(verificationImpact([file], false, true).requiredChecks, CHECKS.map((check) => check.id), file);
  }
  assert.ok(verificationImpact(["protocol.schema.json"], false, true).requiredChecks.includes("apple-native"));
  assert.deepEqual(verificationImpact(["android/app/src/main/java/Feature.kt"], false, true).requiredChecks,
    ["android-build", "android-device"]);
});

test("repositories without an Apple project retain their existing full check set", () => {
  for (const file of ["unknown.file", ".github/workflows/ci.yml", "scripts/verification-executor.mjs"]) {
    const plan = verificationImpact([file]);
    assert.deepEqual(plan.requiredChecks, existing);
    assert.equal(plan.apple, null);
    assert.ok(plan.selectionReasons.every((reason) => !reason.checks.includes("apple-native")));
    const projected = projectVerificationSelection({ version: 6, ...plan }, new Set([file]));
    assert.ok(projected.selectionReasons.every((reason) => !reason.checks.includes("apple-native")));
  }
  assert.deepEqual(verificationImpact([], true).requiredChecks, existing);
  assert.deepEqual(verificationImpact([], true, true).requiredChecks, CHECKS.map((check) => check.id));
});

test("Apple availability is discovered from source, including tracked deletion", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/apple-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = `${APPLE_REQUIREMENTS.project}/project.pbxproj`;
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), "Synthetic project identity only; never built.\n");
  await writeFile(path.join(root, "README.md"), "Fixture\n");
  await exec("git", ["init", "--quiet", root]);
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "Fixture"], { cwd: root });
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await writeFile(path.join(root, "unknown.file"), "Shared unknown fixture\n");
  assert.ok((await verificationPlan(root, base)).requiredChecks.includes("apple-native"));
  await rm(path.join(root, "unknown.file"));
  await rm(path.join(root, file));
  const removed = await verificationPlan(root, base);
  assert.ok(removed.requiredChecks.includes("apple-native"));
  assert.deepEqual(removed.requiredGroups, ["tooling", "apple"]);
});
