import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

// Local authorization is independent of CI impact and never overrides native tool permissions.
const executionScripts = new Set([
  "development-policy", "candidate-commit", "native-candidate",
  "git-state", "verification", "verification-policy", "verify", "verification-executor", "test-workflow",
  "verification-backend", "verification-android", "process", "owned-command", "owned-command-windows",
  "verification-preflight", "verification-run", "verification-transition",
  "verification-tooling", "verification-admission", "verification-ci", "verification-ci-artifact",
  "owned-command-linux", "owned-command-darwin", "local-ipc", "device-run", "worker-diagnostics", "device-diagnostics", "diagnostic-errors",
  "bounded-worker-log", "diagnostic-publication", "native-lifecycle", "backend-diagnostics",
  "verification-diagnostics", "android-diagnostics", "platform-diagnostics",
  "bundle-extension", "package-extension", "launch-cli-proof", "export-schema",
  "build-android", "prepare-android", "test-android", "android-runner", "android-emulator", "android-home", "android-platform",
  "emulator-resources", "linux-emulator", "linux-runtime", "manual-emulator", "native-startup",
  "start-test-emulator", "stop-test-emulator", "test-native-layouts", "save-debug-artifact",
]);
const sensitiveBackend = new Set(["security", "runtime", "files", "protocol", "store", "relay", "bridge", "host-record", "push"]);
const packageMetadata = new Set(["name", "version", "description", "author", "contributors", "license", "keywords",
  "homepage", "bugs", "repository", "funding"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const identity = (value) => hash(canonical(value));
const sameFile = (left, right) => ["dev", "ino", "mode", "size", "mtimeMs"].every((key) => left[key] === right[key]);
const reasons = {
  execution: { stage: "execution", title: "Execution and acceptance policy",
    why: "These inputs can change commands, process ownership, acceptance decisions or native commit protection." },
  instructions: { stage: "execution", title: "Agent execution instructions",
    why: "Adopting these instructions changes how this task is executed or reviewed." },
  dependency: { stage: "execution", title: "Dependency or build configuration",
    why: "These changes can select executable dependencies, package sources, lifecycle hooks or build commands." },
  sensitive: { stage: "independent", title: "Sensitive product changes",
    why: "Independent review must inspect authorization, data exposure, persistence and compatibility; a path alone does not require human approval." },
  unknown: { stage: "independent", title: "Unclassified changes",
    why: "Independent review must classify actual effects. Unresolved execution scope remains blocked, not implicitly authorized." },
};

const workspaceSetupGuidance =
  "Required workspace-local dependency restoration and tool installation are included without a separate project approval. " +
  "After a relevant manifest change or an actual missing-prerequisite failure, use lockfiles or pinned, integrity-verified releases and install into this worktree. " +
  "Inspect installer/lifecycle effects and keep environment changes command-scoped; global or user-profile installation, administrator privileges and persistent system configuration remain outside this scope.";

function changedPaths(value) {
  if (!Array.isArray(value) || value.length > 2000 || value.some((file) => typeof file !== "string" ||
      !file.length || file.length > 1000 || /[\\\x00-\x1f]|^[\/]|^[A-Za-z]:/.test(file) ||
      file.split("/").some((part) => ["", ".", "..", ".git", ".data"].includes(part.toLowerCase())))) {
    throw new TypeError("Development review requires the actual changed-path list.");
  }
  return [...new Set(value)].sort();
}

function classification(file) {
  const lower = file.toLowerCase();
  if (/(?:^|\/)(?:agents|claude)\.md$/.test(lower) ||
      lower === ".github/copilot-instructions.md" || /^\.github\/instructions\/.*\.instructions\.md$/.test(lower) ||
      /^\.github\/(?:agents|skills)\//.test(lower)) return "instructions";
  if (/^\.github\/(?:workflows|actions|extensions)\//.test(lower) || lower === ".github/codeowners" ||
      /^scripts\/([^/]+)\.(?:mjs|ps1|cs|py|ts)$/.test(lower) && executionScripts.has(lower.slice(8).replace(/\.[^.]+$/, ""))) {
    return "execution";
  }
  if (/(?:^|\/)(?:\.npmrc|package(?:-lock)?\.json|npm-shrinkwrap\.json|tsconfig(?:\.[^/]+)?\.json|requirements[^/]*\.txt)$/.test(lower) ||
      /^(?:android\/gradle\/|android\/gradlew(?:\.bat)?$)/.test(lower) ||
      /^android\/.*(?:\.gradle(?:\.kts)?|gradle\.properties)$/.test(lower)) return "dependency";
  if (/^backend\/src\/([^/]+)\.ts$/.test(lower) && sensitiveBackend.has(lower.slice(12, -3)) ||
      /\/(?:vault|wire|localstore|relayapi)\.kt$/.test(lower) || /(?:^|\/)androidmanifest\.xml$/.test(lower) ||
      lower.startsWith("extension/") || lower === "protocol.schema.json") return "sensitive";
  if (["readme.md", "validation.md", ".gitignore"].includes(lower) ||
      /^(?:docs|backend|android|scripts|test-fixtures)\//.test(lower) ||
      /^\.github\/(?:issue_template\/|pull_request_template(?:\/|\.md$))/.test(lower) ||
      /^\.github\/[^/]+\.md$/.test(lower) ||
      /^(?:deployment|infra)\//.test(lower) || lower === "azure.yaml") return null;
  return "unknown";
}

export const isVerificationPolicyPath = (file) => ["execution", "instructions", "dependency"].includes(classification(file));

function packageExecution(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid package manifest.");
  return Object.fromEntries(Object.entries(value).filter(([key]) => !packageMetadata.has(key)));
}

export function developmentReviewRequirements(files, packageChanges = {}, policyPaths = []) {
  const retained = new Set(changedPaths(policyPaths));
  const grouped = new Map();
  for (const file of changedPaths([...new Set([...changedPaths(files), ...retained])])) {
    let code = classification(file);
    const change = Object.hasOwn(packageChanges, file) ? packageChanges[file] : null;
    if (!retained.has(file) && /(?:^|\/)package\.json$/i.test(file) &&
        change?.before !== undefined && change?.after !== undefined) {
      try {
        if (canonical(packageExecution(change.before)) === canonical(packageExecution(change.after))) code = null;
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
        // An incomplete or invalid manifest is still a dependency-policy decision, not a metadata exemption.
      }
    }
    if (code) {
      if (!grouped.has(code)) grouped.set(code, []);
      grouped.get(code).push(file);
    }
  }
  const decisions = Object.entries(reasons).filter(([code]) => grouped.has(code))
    .map(([code, detail]) => ({ code, ...detail, paths: grouped.get(code) }));
  return {
    requiresHumanReview: decisions.some((item) => item.stage === "execution"),
    protectedPaths: decisions.filter((item) => item.stage === "execution").flatMap((item) => item.paths).sort(),
    reviewPaths: decisions.filter((item) => item.stage === "independent").flatMap((item) => item.paths).sort(),
    reasons: decisions,
  };
}

export async function inspectDevelopmentPolicy(root, base, files, git, policyPaths = []) {
  policyPaths = changedPaths(policyPaths);
  files = changedPaths([...new Set([...changedPaths(files), ...policyPaths])]);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) throw new TypeError("An explicit task base is required.");
  const physicalRoot = await realpath(root), inputs = [];
  const contents = Object.create(null), beforeContents = Object.create(null), packageChanges = Object.create(null);
  for (const file of files.filter((name) => classification(name))) {
    const entry = await git(root, ["--literal-pathspecs", "ls-tree", "-z", base, "--", file]);
    if (/^100(?:644|755) blob [a-f0-9]+\t/.test(entry)) {
      beforeContents[file] = await git(root, ["show", `${base}:${file}`]);
      if (Buffer.byteLength(beforeContents[file]) > 1024 * 1024) throw new Error(`Policy base needs direct inspection: ${file}`);
    } else if (entry) throw new Error(`Policy base has an unsupported file type: ${file}`);
    const absolute = path.join(root, file);
    let info;
    try { info = await lstat(absolute); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      inputs.push({ path: file, kind: "deleted" });
      continue;
    }
    const resolved = await realpath(absolute), relative = path.relative(physicalRoot, resolved);
    if (!info.isFile() || info.isSymbolicLink() || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) ||
        info.size > 1024 * 1024) throw new Error(`Policy input needs direct inspection: ${file}`);
    const handle = await open(absolute, "r");
    let bytes;
    try {
      // Opening some Windows files updates ctime; bind the read to the opened file before checking stability.
      const opened = await handle.stat();
      if (!sameFile(info, opened)) throw new Error(`Policy input changed before reading: ${file}`);
      bytes = await handle.readFile();
      const after = await handle.stat(), current = await lstat(absolute);
      if (bytes.length !== opened.size || !sameFile(opened, after) || opened.ctimeMs !== after.ctimeMs ||
          !sameFile(after, current) || after.ctimeMs !== current.ctimeMs || await realpath(absolute) !== resolved) {
        throw new Error(`Policy input changed during inspection: ${file}`);
      }
    } finally {
      await handle.close();
    }
    contents[file] = bytes.toString("utf8");
    inputs.push({ path: file, kind: "file", mode: info.mode & 0o111, sha256: hash(bytes) });
    if (/(?:^|\/)package\.json$/i.test(file)) {
      if (Object.hasOwn(beforeContents, file)) {
        packageChanges[file] = { before: beforeContents[file], after: contents[file] };
      }
    }
  }
  const requirements = developmentReviewRequirements(files, packageChanges, policyPaths);
  const required = new Set([...requirements.protectedPaths, ...requirements.reviewPaths]);
  const project = (values) => Object.assign(Object.create(null),
    Object.fromEntries(Object.entries(values).filter(([file]) => required.has(file))));
  return { ...requirements, inputs: inputs.filter((input) => required.has(input.path)),
    beforeContents: project(beforeContents), contents: project(contents) };
}

export function developmentApprovalDetails(base, policy, files) {
  const text = (values, file, missing) => {
    if (!values || !Object.hasOwn(values, file)) return missing;
    if (typeof values[file] !== "string") throw new TypeError("Approval details require captured text contents.");
    return values[file];
  };
  return `Original task base: ${base}\n` + [...files].sort().map((file) =>
    `\n=== ${file} ===\n--- Original ---\n${text(policy.beforeContents, file, "(absent)")}\n` +
    `--- Proposed ---\n${text(policy.contents, file, "(deleted)")}\n`).join("");
}

function requireCiTarget(ci, branch) {
  if (!ci || typeof ci.repository !== "string" ||
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(ci.repository) ||
      ci.repository.split("/").some((part) => part === "." || part === "..") ||
      ci.ref !== branch || !/^refs\/heads\/[^\x00-\x20]+$/.test(ci.ref) ||
      Object.keys(ci).some((key) => !["repository", "ref"].includes(key))) {
    throw new TypeError("CI execution needs this task's exact repository and branch.");
  }
}

export function developmentApprovalRequest(scope, policy, stage, hooks) {
  if (!scope || !scope.sessionId || !scope.runId || !scope.base || !scope.workspace || !scope.task ||
      !["execution", "review"].includes(stage)) throw new TypeError("A task-scoped approval subject is required.");
  if (scope.ci !== undefined) requireCiTarget(scope.ci, scope.workspace.branch);
  const selected = policy.reasons.filter((item) => item.stage === stage);
  const paths = selected.flatMap((item) => item.paths).sort();
  if (!paths.length) return null;
  const details = developmentApprovalDetails(scope.base, policy, paths);
  const request = {
    version: 1, scope, stage,
    action: stage === "execution" ? "Use the listed execution policy for this task" : "Accept the listed sensitive code changes",
    reasons: selected,
    inputs: policy.inputs.filter((input) => paths.includes(input.path)),
    detailsSha256: hash(details), detailsBytes: Buffer.byteLength(details),
    hooks,
    effects: stage === "execution"
      ? ["Use these exact policy inputs for local checks and task-scoped candidate commits.",
        workspaceSetupGuidance,
        ...(scope.ci ? [`Run the reviewed .github/workflows/ci.yml hosted-runner setup and checks for candidates on ${scope.ci.repository} ${scope.ci.ref}, including their pull-request merge ref.`] : []),
        "Record human review of these policy changes; still require source-bound verification and independent review."]
      : ["Satisfy the local human-review requirement for these exact changes after verification and independent review."],
    exclusions: ["No push, PR creation, merge, deployment, extension installation/reload or live runtime control.",
      "No global or user-profile installation, administrator privileges, persistent PATH changes, device enrollment, shared-machine configuration or bypass of native permissions.",
      ...(scope.ci ? ["No new infrastructure."] : [])],
    validity: "Only this task, workspace and listed input versions. Ordinary source repairs do not expand this grant. Changed inputs or targets require a new decision.",
  };
  if (request.inputs.length !== paths.length) throw new Error("Approval inputs do not cover every requested path.");
  return { ...request, id: identity(request) };
}

export function developmentTaskApprovalRequest(scope, hooks, implementation) {
  if (!scope?.sessionId || !scope.runId || !scope.workspace?.root || !scope.workspace.branch ||
      !scope.task?.goal || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(scope.base ?? "") ||
      !hooks?.fingerprint || !implementation?.files?.length) {
    throw new TypeError("Task authorization requires the original session, task, workspace, hooks and trusted implementation.");
  }
  if (scope.task.execution !== undefined) {
    throw new TypeError("The former isolated execution scope is retired. Ordinary CI needs its own repository/branch-bound task scope.");
  }
  const delivery = scope.task.delivery ?? "local-commit";
  if (!["working-tree", "local-commit", "pull-request"].includes(delivery)) throw new TypeError("Unknown delivery target.");
  const publication = delivery === "pull-request";
  const ci = scope.ci;
  if (publication || scope.ci !== undefined) requireCiTarget(ci, scope.workspace.branch);
  const actions = ["edit", "check", "independent-review", "repair",
    ...(delivery !== "working-tree" ? ["commit"] : []),
    ...(publication ? ["push"] : []),
    ...(delivery === "pull-request" ? ["create-draft-pr", "mark-pr-ready"] : []),
    ...(publication ? ["ordinary-ci"] : [])];
  const effects = [
    `Allow ${actions.join(", ")} for this task and ${scope.workspace.branch}; reuse this scope across ordinary source repairs.`,
    `Use existing local checks ${publication ? "when their local execution is authorized" : "only"}. Changed executable inputs still need their exact local execution approval.`,
    workspaceSetupGuidance,
    ...(publication ? [`Authorize automatic repository CI for ${ci.repository} ${ci.ref}, including existing-PR synchronization and PR creation. Candidate dependencies, install scripts and changed tools run as the ordinary disposable runner identity without per-revision project approval. Public network access is permitted. This is ordinary CI, not an adversarial sandbox or permission to adopt new local control.`] : []),
    "Retain required checks, independent review and source-bound results. Keep approved local tooling unchanged until separately authorized adoption.",
  ];
  const exclusions = [
    "No merge, deployment, release, production secrets, cloud administration, device enrollment, live runtime control, extension installation/reload or Git hook changes.",
    "No global or user-profile installation, administrator privileges, persistent PATH changes or shared-machine configuration.",
    "No automatic local tool/instruction/hook adoption, native permission bypass, new targets or increased user-selected limits.",
    ...(delivery === "working-tree" ? ["No commit, push or PR creation."] : []),
  ];
  const snapshot = canonical({ scope, hooks, implementation, actions, effects, exclusions });
  const request = {
    version: 1, scope, stage: "task", action: "Authorize this task's unattended development and delivery scope",
    reasons: [{ code: "task", title: "Task-scoped authority",
      why: "Establish the actual actions and execution target once, before implementation, rather than asking at each phase.", paths: [] }],
    inputs: [], hooks, implementation, actions, effects, exclusions,
    detailsSha256: hash(snapshot), detailsBytes: Buffer.byteLength(snapshot),
    validity: "Only this original session/run, task, workspace, baseline, hooks and trusted implementation. Ordinary candidate edits do not change the grant. A different target, authority or trusted version requires a new decision.",
  };
  return { request: { ...request, id: identity(request) }, snapshot };
}

export function developmentTaskActionAllowed(scope, hooks, implementation, receipts, action) {
  const { request } = developmentTaskApprovalRequest(scope, hooks, implementation);
  return request.actions.includes(action) && developmentApprovalSatisfied(request, receipts);
}

export function developmentExecutionAuthorization(scope, policy, hooks, implementation, receipts, target = "local") {
  if (scope.task.execution !== undefined) throw new TypeError("The former isolated execution scope is retired.");
  if (!["local", "ci"].includes(target)) throw new TypeError("Choose local execution or ordinary CI explicitly.");
  if (target === "ci") {
    if (scope.task.delivery !== "pull-request") {
      return { status: "needs_human", route: "github-hosted",
        reason: "Ordinary CI-first execution needs explicit PR delivery scope; no publication was authorized." };
    }
    return developmentTaskActionAllowed(scope, hooks, implementation, receipts, "ordinary-ci")
      ? { status: "allowed", route: "github-hosted", subjectPaths: [...policy.protectedPaths], adoption: "not-authorized" }
      : { status: "needs_human", route: "github-hosted",
        request: developmentTaskApprovalRequest(scope, hooks, implementation).request };
  }
  if (!policy.protectedPaths.length) return { status: "allowed", route: "local" };
  const request = developmentApprovalRequest(scope, policy, "execution", hooks);
  return developmentApprovalSatisfied(request, receipts)
    ? { status: "allowed", route: "local" }
    : { status: "needs_human", route: "local", request };
}

export function formatDevelopmentApproval(request, details, summary, snapshot, showDetails = false) {
  if (typeof snapshot !== "string" || Buffer.byteLength(snapshot) !== request.detailsBytes ||
      hash(snapshot) !== request.detailsSha256) throw new TypeError("An exact immutable approval snapshot is required.");
  if (!showDetails && (typeof summary !== "string" || !summary.trim())) {
    throw new TypeError("A nonblank behavior summary is required when full details are hidden.");
  }
  let contents = "Full diff/contents: available on request; viewing them does not approve this request.";
  if (showDetails) {
    let fence = "```";
    for (const match of snapshot.matchAll(/`+/g)) {
      if (match[0].length >= fence.length) fence = "`".repeat(match[0].length + 1);
    }
    contents = `Contents to approve (immutable native-question snapshot):\n${fence}text\n${snapshot}\n${fence}`;
  }
  return [
    `Approval requested: ${request.action}`,
    `Why now: ${request.reasons.map((item) => item.why).join(" ")}`,
    `Target: ${request.scope.workspace.root} (${request.scope.workspace.branch}); task ${request.scope.runId}.`,
    ...(request.scope.ci ? [`CI target: ${request.scope.ci.repository} at ${request.scope.ci.ref}; ${request.stage === "task" ? "automatic repository checks" : ".github/workflows/ci.yml only"}.`] : []),
    `Task goal (context, not authority): ${JSON.stringify(request.scope.task.goal)}`,
    ...(summary ? [`Behavior change (implementation description; check against the actual details): ${JSON.stringify(summary)}`] : []),
    request.stage === "task" ? `Requested actions: ${request.actions.join(", ")}`
      : `Changes: ${request.inputs.map((input) => `${input.path} [${input.kind}]`).join(", ")}`,
    `After approval: ${request.effects.join(" ")}`,
    `Not included: ${request.exclusions.join(" ")}`,
    `Valid for: ${request.validity}`,
    `Local detail copy (not authoritative): ${details}`,
    `Details SHA256: ${request.detailsSha256}`,
    `Request identity: ${request.id}`,
    contents,
  ].join("\n\n");
}

export function developmentApprovalSatisfied(request, receipts) {
  return request === null || Array.isArray(receipts) && receipts.some((receipt) => receipt?.version === 1 &&
    receipt.requestId === request.id && receipt.origin === "original-client" && receipt.decision === "approved" &&
    Object.keys(receipt).every((key) => ["version", "requestId", "origin", "decision"].includes(key)));
}
