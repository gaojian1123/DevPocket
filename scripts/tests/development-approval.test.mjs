import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentReviewRequirements, isVerificationPolicyPath } from "../development-policy.mjs";
import { classifyDevelopmentPath, isVerificationPolicyPath as classifyPolicyPath } from "../development-paths.mjs";

test("local review requirements preserve trust boundaries independently of impact rules", () => {
  assert.equal(isVerificationPolicyPath, classifyPolicyPath, "Keep the original import contract without duplicating rules.");
  for (const [file, requiresReview, protectedPath] of [
    ["README.md", false, false], ["VALIDATION.md", false, false], ["docs/policy.md", false, false],
    ["AGENTS.md", true, true], ["scripts/git-state.mjs", true, true],
    ["scripts/development-policy.mjs", true, true], ["scripts/development-paths.mjs", true, true],
    ["scripts/candidate-commit.mjs", true, true],
    ["scripts/tests/development-tools.test.mjs", false, false], ["scripts/tests/development-approval.test.mjs", false, false],
    ["scripts/test-tooling.mjs", true, true], ["scripts/tests/tooling-runner.test.mjs", false, false],
    ["scripts/build-android.ps1", true, true], ["scripts/test-android.ps1", true, true],
    ["scripts/android-runner.mjs", true, true], ["scripts/package-extension.ps1", true, true],
    ["scripts/bundle-extension.mjs", true, true], ["scripts/export-schema.ts", true, true],
    [".github/agents/devpocket-reviewer.agent.md", true, true],
    [".github/skills/devpocket-development/SKILL.md", true, true],
    [".github/copilot-instructions.md", true, true],
    [".github/instructions/backend.instructions.md", true, true],
    [".github/instructions/nested/checks.instructions.md", true, true],
    [".github/README.md", false, false],
    ["scripts/verification.mjs", true, true], ["scripts/verification-policy.mjs", true, true],
    ["scripts/verification-preflight.mjs", true, true], ["scripts/verification-run.mjs", true, true],
    ["scripts/verification-tooling.mjs", true, true], ["scripts/verification-admission.mjs", true, true],
    ["scripts/verification-ci.mjs", true, true], ["scripts/verification-ci-artifact.ps1", true, true],
    ["scripts/verify.mjs", true, true], [".github/workflows/ci.yml", true, true],
    ["package-lock.json", true, true], [".NPMRC", true, true], ["backend/tsconfig.json", true, true],
    ["deployment/azure/probe/requirements-test.txt", true, true],
    ["android/gradlew.bat", true, true], ["android/app/build.gradle.kts", true, true],
    ["android/app/src/main/java/dev/devpocket/app/ui/Screen.kt", false, false],
    ["android/app/src/main/java/dev/devpocket/app/data/Store.kt", false, false],
    ["android/app/src/main/java/dev/devpocket/app/data/Vault.kt", true, false],
    ["android/app/src/main/AndroidManifest.xml", true, false],
    ["backend/tests/fixture.test.ts", false, false], ["backend/integration/fixture.ts", false, false],
    ["backend/src/runtime.ts", true, false], ["backend/src/push.ts", true, false],
    ["backend/src/cli.ts", false, false], ["extension/entry.mjs", true, false],
    ["deployment/setup.ps1", false, false], ["infra/main.bicep", false, false], ["azure.yaml", false, false],
    [".github/ISSUE_TEMPLATE/ai-task.yml", false, false], [".github/CODEOWNERS", true, true],
    ["protocol.schema.json", true, false], ["test-fixtures/fixture.json", false, false],
    ["unclassified.txt", true, false],
  ]) {
    const result = developmentReviewRequirements([file]);
    assert.equal(result.requiresHumanReview, protectedPath, file);
    assert.deepEqual(result.protectedPaths, protectedPath ? [file] : [], file);
    assert.deepEqual(result.reviewPaths, requiresReview && !protectedPath ? [file] : [], file);
    assert.ok(result.reasons.every((reason) => reason.title && reason.why && reason.paths.includes(file)));
    assert.equal(classifyPolicyPath(file), protectedPath, file);
    assert.equal(classifyDevelopmentPath(file.toUpperCase()), classifyDevelopmentPath(file), file);
  }
  assert.deepEqual(developmentReviewRequirements([]), { requiresHumanReview: false, protectedPaths: [], reviewPaths: [], reasons: [] });
  assert.deepEqual(developmentReviewRequirements(["README.md", "scripts/candidate-commit.mjs", "AGENTS.md", "AGENTS.md"]).protectedPaths,
    ["AGENTS.md", "scripts/candidate-commit.mjs"]);
  for (const invalid of [undefined, null, {}, "README.md", [null], [""], ["../package.json"], [".git/config"], ["C:/outside"]]) {
    assert.throws(() => developmentReviewRequirements(invalid), /actual changed-path list/);
  }
});
