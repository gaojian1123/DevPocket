import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { developmentApprovalDetails, developmentApprovalRequest, developmentApprovalSatisfied, developmentReviewRequirements,
  formatDevelopmentApproval, isVerificationPolicyPath } from "../development-policy.mjs";
import { developmentTaskApprovalRequest, developmentTaskActionAllowed, developmentExecutionAuthorization } from "../development-policy.mjs";
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
    ["scripts/verification-transition.mjs", true, true], ["scripts/verification-refinement.mjs", true, true],
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

function approvalFixture() {
  const file = "scripts/verify.mjs";
  const scope = { sessionId: "fixture-session", runId: "fixture-run", base: "1".repeat(40),
    workspace: { root: path.resolve(".data", "approval-fixture"), branch: "refs/heads/task" },
    task: { goal: "Improve local verification", acceptance: ["Preserve required checks"] } };
  const policy = { ...developmentReviewRequirements([file]), contents: { [file]: "// policy fixture\n" }, inputs: [
    { path: file, kind: "file", mode: 0, sha256: "2".repeat(64) },
  ] };
  return { scope, policy, hooks: { directory: "fixture-hooks", fingerprint: "3".repeat(64) } };
}

test("workspace-local setup is included without expanding global or changed-policy authority", () => {
  const { scope, policy, hooks } = approvalFixture();
  const implementation = { version: 2, directory: "approved-tools",
    files: [{ name: "development-policy.mjs", sha256: "5".repeat(64) }] };
  const requests = [
    developmentApprovalRequest(scope, policy, "execution", hooks),
    developmentApprovalRequest({ ...scope, ci: { repository: "owner/repo", ref: scope.workspace.branch } },
      policy, "execution", hooks),
  ];
  for (const delivery of ["working-tree", "local-commit", "pull-request"]) {
    const taskScope = { ...scope, task: { ...scope.task, delivery },
      ...(delivery === "pull-request" ? { ci: { repository: "owner/repo", ref: scope.workspace.branch } } : {}) };
    const { request } = developmentTaskApprovalRequest(taskScope, hooks, implementation);
    requests.push(request);
    const receipt = { version: 1, requestId: request.id, origin: "original-client", decision: "approved" };
    assert.equal(developmentExecutionAuthorization(taskScope, policy, hooks, implementation, [receipt]).status, "needs_human");
    for (const action of ["local-install", "adopt-policy", "reload"]) {
      assert.equal(developmentTaskActionAllowed(taskScope, hooks, implementation, [receipt], action), false);
    }
  }
  for (const request of requests) {
    assert.match(request.effects.join(" "), /workspace-local dependency restoration and tool installation/);
    assert.match(request.effects.join(" "), /without a separate project approval/);
    assert.match(request.effects.join(" "), /manifest change or an actual missing-prerequisite failure/);
    assert.match(request.effects.join(" "), /lockfiles or pinned, integrity-verified releases/);
    assert.match(request.effects.join(" "), /command-scoped/);
    assert.match(request.exclusions.join(" "), /No global or user-profile installation, administrator privileges, persistent PATH changes/);
    assert.match(request.exclusions.join(" "), /extension installation\/reload/);
    assert.doesNotMatch(request.exclusions.join(" "), /No (?:new|local) tool installation/);
  }
});

test("scoped approval identity follows authority inputs, not unrelated source revisions", () => {
  const { scope, policy, hooks } = approvalFixture();
  const request = developmentApprovalRequest(scope, policy, "execution", hooks);
  const unrelated = { ...policy, source: { head: "4".repeat(40), fingerprint: "5".repeat(64) } };
  assert.equal(developmentApprovalRequest(scope, unrelated, "execution", hooks).id, request.id);
  for (const next of [
    developmentApprovalRequest({ ...scope, runId: "another-task" }, policy, "execution", hooks),
    developmentApprovalRequest({ ...scope, sessionId: "another-session" }, policy, "execution", hooks),
    developmentApprovalRequest({ ...scope, workspace: { ...scope.workspace, branch: "refs/heads/other" } }, policy, "execution", hooks),
    developmentApprovalRequest(scope, { ...policy, inputs: [{ ...policy.inputs[0], sha256: "6".repeat(64) }] }, "execution", hooks),
    developmentApprovalRequest(scope, { ...policy, contents: { "scripts/verify.mjs": "Substituted presentation" } }, "execution", hooks),
    developmentApprovalRequest(scope, policy, "execution", { ...hooks, fingerprint: "7".repeat(64) }),
  ]) assert.notEqual(next.id, request.id);
  const snapshot = developmentApprovalDetails(scope.base, policy, policy.protectedPaths);
  const message = formatDevelopmentApproval(request, "actual-changes.txt",
    "Adjust verification output without changing required checks.", snapshot);
  for (const label of ["Approval requested:", "Why now:", "Target:", "Changes:", "After approval:", "Not included:", "Valid for:"]) {
    assert.ok(message.includes(label), label);
  }
  assert.ok(message.includes(scope.workspace.root));
  assert.ok(message.includes("scripts/verify.mjs"));
  assert.ok(message.includes("actual-changes.txt"));
  assert.ok(message.includes(request.detailsSha256));
  assert.ok(message.includes(request.id));
  assert.equal(message.includes(snapshot), false);
  assert.match(message, /Full diff\/contents: available on request/);
  assert.throws(() => formatDevelopmentApproval(request, "actual-changes.txt"), /immutable approval snapshot/);
  assert.throws(() => formatDevelopmentApproval(request, "actual-changes.txt", undefined, "Substituted"), /immutable approval snapshot/);
  assert.equal(developmentApprovalSatisfied(request, [{ requestId: request.id, approved: true }]), false);
  assert.throws(() => developmentApprovalRequest(scope, { ...policy, inputs: [] }, "execution", hooks), /every requested path/);
});

test("summary approval size does not grow with full contents", () => {
  const { scope, policy, hooks } = approvalFixture();
  const summary = "Adjust verification output; required checks and authorization remain unchanged.";
  const messages = [];
  for (const size of [1, 10000]) {
    policy.contents["scripts/verify.mjs"] = "private fixture contents\n".repeat(size);
    const request = developmentApprovalRequest(scope, policy, "execution", hooks);
    const snapshot = developmentApprovalDetails(scope.base, policy, policy.protectedPaths);
    const message = formatDevelopmentApproval(request, "reference-only.txt", summary, snapshot);
    assert.ok(message.includes(summary));
    assert.doesNotMatch(message, /private fixture contents|Contents to approve/);
    messages.push(message);
  }
  assert.equal(messages[0].length, messages[1].length);
});

test("summary-only approvals require a nonblank behavior description", () => {
  const { scope, policy, hooks } = approvalFixture();
  const subjects = [
    { request: developmentApprovalRequest(scope, policy, "execution", hooks),
      snapshot: developmentApprovalDetails(scope.base, policy, policy.protectedPaths) },
    developmentTaskApprovalRequest({ ...scope, task: { ...scope.task, delivery: "working-tree" } }, hooks,
      { version: 2, directory: "approved-tools", files: [{ name: "development-policy.mjs", sha256: "5".repeat(64) }] }),
  ];
  for (const { request, snapshot } of subjects) {
    for (const summary of [undefined, null, "", " \t\r\n", 42]) {
      assert.throws(() => formatDevelopmentApproval(request, "reference-only.txt", summary, snapshot),
        /nonblank behavior summary/);
    }
    for (const summary of [undefined, null, "", " \t\r\n"]) {
      assert.ok(formatDevelopmentApproval(request, "reference-only.txt", summary, snapshot, true).includes(snapshot));
    }
  }
});

test("on-demand approval snapshots cannot escape their native-question code block", () => {
  const { scope, policy, hooks } = approvalFixture();
  policy.contents["scripts/verify.mjs"] = "```text\nuntrusted contents\n```\n";
  const request = developmentApprovalRequest(scope, policy, "execution", hooks);
  const snapshot = developmentApprovalDetails(scope.base, policy, policy.protectedPaths);
  const message = formatDevelopmentApproval(request, "reference-only.txt", undefined, snapshot, true);
  assert.ok(message.includes(`\n\`\`\`\`text\n${snapshot}\n\`\`\`\``));
  assert.ok(message.includes(request.id));
  assert.ok(message.includes(request.detailsSha256));
  assert.throws(() => formatDevelopmentApproval(request, "reference-only.txt", undefined, "Substituted", true),
    /immutable approval snapshot/);
});

test("approval records require the exact original-client decision and subject", () => {
  const { scope, policy, hooks } = approvalFixture();
  const request = developmentApprovalRequest(scope, policy, "execution", hooks);
  const approved = { version: 1, requestId: request.id, origin: "original-client", decision: "approved" };
  assert.equal(developmentApprovalSatisfied(request, [approved]), true);
  for (const change of [
    { version: 2 }, { requestId: "another-request" }, { origin: "agent" },
    { decision: "rejected" }, { decision: "cancelled" }, { decision: "invalid" }, { decision: "view-details" }, { approved: true },
  ]) assert.equal(developmentApprovalSatisfied(request, [{ ...approved, ...change }]), false);
  const changed = developmentApprovalRequest(scope, {
    ...policy, inputs: [{ ...policy.inputs[0], sha256: "9".repeat(64) }],
  }, "execution", hooks);
  assert.equal(developmentApprovalSatisfied(changed, [approved]), false);
});

test("CI execution consent binds the repository and branch without inheriting local-only consent", () => {
  const { scope, policy, hooks } = approvalFixture();
  const local = developmentApprovalRequest(scope, policy, "execution", hooks);
  const target = { repository: "fixture/verification", ref: scope.workspace.branch };
  const request = developmentApprovalRequest({ ...scope, ci: target }, policy, "execution", hooks);
  assert.notEqual(request.id, local.id);
  assert.equal(developmentApprovalSatisfied(request, [{ version: 1, requestId: local.id,
    origin: "original-client", decision: "approved" }]), false);
  const snapshot = developmentApprovalDetails(scope.base, policy, policy.protectedPaths);
  const message = formatDevelopmentApproval(request, "reference-only.txt", "CI-first task", snapshot);
  assert.match(message, /CI target: fixture\/verification/);
  assert.match(message, /No push, PR creation, merge/);
  assert.ok(request.effects.some((effect) => effect.includes("hosted-runner setup")));
  for (const ci of [
    { ...target, ref: "refs/heads/other" }, { ...target, repository: "../verification" },
    { ...target, workflow: "different.yml" },
  ]) assert.throws(() => developmentApprovalRequest({ ...scope, ci }, policy, "execution", hooks), /exact repository and branch/);
});

test("task grants allow ordinary CI repairs without approving changed local tools", () => {
  const { scope, policy, hooks } = approvalFixture();
  scope.task = { ...scope.task, delivery: "pull-request" };
  scope.ci = { repository: "owner/repo", ref: scope.workspace.branch };
  const implementation = { version: 2, directory: "approved-tools",
    files: [{ name: "development-policy.mjs", sha256: "5".repeat(64) }] };
  const { request, snapshot } = developmentTaskApprovalRequest(scope, hooks, implementation);
  const receipt = { version: 1, requestId: request.id, origin: "original-client", decision: "approved" };
  assert.match(snapshot, /ordinary disposable runner identity without per-revision project approval/);
  assert.match(snapshot, /ordinary CI, not an adversarial sandbox/);
  for (const action of ["commit", "push", "create-draft-pr", "mark-pr-ready", "ordinary-ci"]) {
    assert.equal(developmentTaskActionAllowed(scope, hooks, implementation, [], action), false);
    assert.equal(developmentTaskActionAllowed(scope, hooks, implementation, [receipt], action), true);
  }
  for (const action of ["merge", "deploy", "local-install", "adopt-policy", "reload", "isolated-execution"]) {
    assert.equal(developmentTaskActionAllowed(scope, hooks, implementation, [receipt], action), false);
  }
  assert.equal(developmentExecutionAuthorization(scope, policy, hooks, implementation, [receipt]).status, "needs_human");
  assert.equal(developmentExecutionAuthorization(scope, policy, hooks, implementation, [], "ci").status, "needs_human");
  const allowed = developmentExecutionAuthorization(scope, policy, hooks, implementation, [receipt], "ci");
  assert.equal(allowed.route, "github-hosted");
  assert.equal(allowed.adoption, "not-authorized");
  const repaired = { ...policy, inputs: policy.inputs.map((input) => ({ ...input, sha256: "6".repeat(64) })) };
  assert.equal(developmentExecutionAuthorization(scope, repaired, hooks, implementation, [receipt], "ci").status, "allowed");
  for (const mutate of [
    (value) => { value.base = "7".repeat(40); },
    (value) => { value.runId = "another-task"; },
    (value) => { value.ci.repository = "owner/another"; },
    (value) => { value.workspace.branch = value.ci.ref = "refs/heads/another"; },
  ]) {
    const changed = structuredClone(scope);
    mutate(changed);
    assert.equal(developmentTaskActionAllowed(changed, hooks, implementation, [receipt], "ordinary-ci"), false);
  }
  const legacy = { ...scope, task: { ...scope.task, execution: { kind: "github-hosted",
    repository: "owner/repo", trustedRef: "refs/heads/main", trustedSha: "4".repeat(40) } } };
  assert.throws(() => developmentTaskApprovalRequest(legacy, hooks, implementation), /retired/);
  assert.throws(() => developmentExecutionAuthorization(scope, policy, hooks, implementation, [receipt], "unknown"),
    /Choose local execution or ordinary CI explicitly/);
  const localOnly = { ...scope, task: { ...scope.task, delivery: "local-commit" } };
  assert.match(developmentExecutionAuthorization(localOnly, policy, hooks, implementation, [receipt], "ci").reason,
    /explicit PR delivery scope/);
});

test("local-verification PR grants bind ordinary CI authority to the repository and branch", () => {
  const { scope, hooks } = approvalFixture();
  scope.task.delivery = "pull-request";
  scope.ci = { repository: "owner/repo", ref: scope.workspace.branch };
  const implementation = { version: 2, directory: "trusted-tools",
    files: [{ name: "development-policy.mjs", sha256: "5".repeat(64) }] };
  const { request, snapshot } = developmentTaskApprovalRequest(scope, hooks, implementation);
  const receipt = { version: 1, requestId: request.id, origin: "original-client", decision: "approved" };
  assert.deepEqual(request.actions, ["edit", "check", "independent-review", "repair", "commit",
    "push", "create-draft-pr", "mark-pr-ready", "ordinary-ci"]);
  assert.match(snapshot, /automatic repository CI for owner\/repo refs\/heads\/task/);
  assert.doesNotMatch(snapshot, /Use existing local checks only/);
  const question = formatDevelopmentApproval(request, "diagnostic-copy.txt",
    "Authorize task-scoped CI and delivery without merging.", snapshot);
  assert.match(question, /CI target: owner\/repo at refs\/heads\/task/);
  assert.doesNotMatch(question, /ci\.yml only/);
  assert.equal(question.includes(snapshot), false);
  assert.ok(formatDevelopmentApproval(request, "diagnostic-copy.txt", "", snapshot, true).includes(snapshot));
  for (const action of ["push", "create-draft-pr", "mark-pr-ready", "ordinary-ci"]) {
    assert.equal(developmentTaskActionAllowed(scope, hooks, implementation, [receipt], action), true);
    assert.equal(developmentTaskActionAllowed(scope, hooks, implementation, [], action), false);
    for (const target of [{ repository: "owner/another", ref: "refs/heads/task" },
      { repository: "owner/repo", ref: "refs/heads/another" }]) {
      const changed = { ...scope, ci: target, workspace: { ...scope.workspace, branch: target.ref } };
      assert.equal(developmentTaskActionAllowed(changed, hooks, implementation, [receipt], action), false);
    }
  }
  for (const ci of [undefined, null, { repository: "owner/repo", ref: "refs/heads/another" },
    { repository: "../repo", ref: scope.workspace.branch }]) {
    assert.throws(() => developmentTaskApprovalRequest({ ...scope, ci }, hooks, implementation), /CI.*repository and branch/);
  }
  for (const delivery of ["working-tree", "local-commit"]) {
    const local = { ...scope, ci: undefined, task: { ...scope.task, delivery } };
    const localRequest = developmentTaskApprovalRequest(local, hooks, implementation).request;
    assert.deepEqual(localRequest.actions, ["edit", "check", "independent-review", "repair",
      ...(delivery === "local-commit" ? ["commit"] : [])]);
    assert.match(localRequest.effects.join(" "), /Use existing local checks only/);
  }
});
