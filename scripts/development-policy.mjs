import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

// Local authorization is independent of CI impact and never overrides native tool permissions.
const executionScripts = new Set([
  "development-policy", "development-workflow", "workflow-extension", "candidate-commit", "native-candidate",
  "git-state", "verification", "verification-policy", "verify", "verification-executor", "test-workflow",
  "verification-backend", "verification-android", "process", "owned-command", "owned-command-windows",
  "verification-preflight", "verification-run", "verification-transition",
  "owned-command-linux", "device-run", "worker-diagnostics", "device-diagnostics", "diagnostic-errors",
  "bounded-worker-log", "diagnostic-publication", "native-lifecycle", "backend-diagnostics",
  "verification-diagnostics", "android-diagnostics", "platform-diagnostics",
  "bundle-extension", "package-extension", "launch-cli-proof", "export-schema",
  "build-android", "prepare-android", "test-android", "android-runner", "android-emulator", "android-home",
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
  sensitive: { stage: "review", title: "Sensitive product changes",
    why: "Review the authorization, data exposure, persistence or compatibility consequences of these changes." },
  unknown: { stage: "review", title: "Unclassified changes",
    why: "The local policy cannot establish the role of these paths; inspect their actual effects before delivery." },
};

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
    requiresHumanReview: decisions.length > 0,
    protectedPaths: decisions.filter((item) => item.stage === "execution").flatMap((item) => item.paths).sort(),
    reviewPaths: decisions.filter((item) => item.stage === "review").flatMap((item) => item.paths).sort(),
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

export function developmentApprovalRequest(scope, policy, stage, hooks) {
  if (!scope || !scope.sessionId || !scope.runId || !scope.base || !scope.workspace || !scope.task ||
      !["execution", "review"].includes(stage)) throw new TypeError("A task-scoped approval subject is required.");
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
        "Record human review of these policy changes; still require source-bound verification and independent review."]
      : ["Satisfy the local human-review requirement for these exact changes after verification and independent review."],
    exclusions: ["No push, PR creation, merge, deployment, extension installation/reload or live runtime control.",
      "No new tool installation, device enrollment, shared-machine configuration or bypass of native permissions."],
    validity: "Only this task, workspace and listed input versions. Ordinary source repairs do not expand this grant. Changed inputs or targets require a new decision.",
  };
  if (request.inputs.length !== paths.length) throw new Error("Approval inputs do not cover every requested path.");
  return { ...request, id: identity(request) };
}

export function formatDevelopmentApproval(request, details, summary, snapshot) {
  if (typeof snapshot !== "string" || Buffer.byteLength(snapshot) !== request.detailsBytes ||
      hash(snapshot) !== request.detailsSha256) throw new TypeError("An exact immutable approval snapshot is required.");
  let fence = "```";
  for (const match of snapshot.matchAll(/`+/g)) {
    if (match[0].length >= fence.length) fence = "`".repeat(match[0].length + 1);
  }
  return [
    `Approval requested: ${request.action}`,
    `Why now: ${request.reasons.map((item) => item.why).join(" ")}`,
    `Target: ${request.scope.workspace.root} (${request.scope.workspace.branch}); task ${request.scope.runId}.`,
    `Task goal (context, not authority): ${JSON.stringify(request.scope.task.goal)}`,
    ...(summary ? [`Behavior change (implementation description; check against the actual details): ${JSON.stringify(summary)}`] : []),
    `Changes: ${request.inputs.map((input) => `${input.path} [${input.kind}]`).join(", ")}`,
    `After approval: ${request.effects.join(" ")}`,
    `Not included: ${request.exclusions.join(" ")}`,
    `Valid for: ${request.validity}`,
    `Local detail copy (not authoritative): ${details}`,
    `Details SHA256: ${request.detailsSha256}`,
    `Request identity: ${request.id}`,
    `Contents to approve (immutable native-question snapshot):\n${fence}text\n${snapshot}\n${fence}`,
  ].join("\n\n");
}

export async function readDevelopmentApprovalDetails(request, file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== request.detailsBytes) return null;
    const bytes = await readFile(file);
    if (bytes.length !== request.detailsBytes || hash(bytes) !== request.detailsSha256) return null;
    return bytes.toString("utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  }
}

export async function obtainDevelopmentApproval(ctx, request, details, summary) {
  if (!request) return null;
  const snapshot = await readDevelopmentApprovalDetails(request, details);
  const changedDetails = () => ({ status: "blocked",
    reason: "Approval details changed or are unavailable. No decision based on substituted contents may authorize execution.",
    approval: request });
  if (snapshot === null) return changedDetails();
  const message = formatDevelopmentApproval(request, details, summary, snapshot);
  if (ctx.session?.capabilities?.ui?.elicitation !== true || typeof ctx.session.ui?.elicitation !== "function") {
    return { status: "needs_human", reason: "The original client's interactive approval UI is unavailable. Review this request there; no approval or execution was assumed.",
      approval: { ...request, message } };
  }
  if (typeof ctx.step !== "function") throw new Error("Approval requires the original workflow journal.");
  const decision = await ctx.step(`devpocket-approval-v1:${request.id}`, async () => {
    const response = await ctx.session.ui.elicitation({
      message,
      requestedSchema: { type: "object", properties: { decision: { type: "string",
        title: request.action, enum: ["approve", "reject"],
        enumNames: [request.stage === "execution" ? "Approve this policy for local checks" : "Accept this sensitive change review",
          "Reject this request"] } },
      required: ["decision"] },
    });
    const valid = response && ["accept", "decline", "cancel"].includes(response.action) &&
      Object.keys(response).every((key) => ["action", "content"].includes(key)) &&
      (response.action !== "accept" || response.content && Object.keys(response.content).length === 1 &&
        ["approve", "reject"].includes(response.content.decision));
    const approved = valid && response.action === "accept" && response.content.decision === "approve";
    const detailsMatch = !approved || await readDevelopmentApprovalDetails(request, details) !== null;
    return { version: 1, requestId: request.id, origin: "original-client",
      decision: !valid || !detailsMatch ? "invalid" : response.action === "cancel" ? "cancelled" :
        approved ? "approved" : "rejected" };
  });
  if (!developmentApprovalSatisfied(request, [decision])) return {
    status: decision?.decision === "invalid" ? "blocked" : "needs_human",
    reason: "This approval was rejected, cancelled or not established. No automatic retry or broader permission is inferred.",
    approval: { ...request, message }, decision,
  };
  if (await readDevelopmentApprovalDetails(request, details) === null) return changedDetails();
  return { receipt: decision };
}

export function developmentApprovalSatisfied(request, receipts) {
  return request === null || Array.isArray(receipts) && receipts.some((receipt) => receipt?.version === 1 &&
    receipt.requestId === request.id && receipt.origin === "original-client" && receipt.decision === "approved" &&
    Object.keys(receipt).every((key) => ["version", "requestId", "origin", "decision"].includes(key)));
}
