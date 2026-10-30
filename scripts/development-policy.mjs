import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { classifyDevelopmentPath } from "./development-paths.mjs";
export { isVerificationPolicyPath } from "./development-paths.mjs";

// These inspections describe required decisions; they do not authenticate or grant permission.
const packageMetadata = new Set(["name", "version", "description", "author", "contributors", "license", "keywords",
  "homepage", "bugs", "repository", "funding"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
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

function changedPaths(value) {
  if (!Array.isArray(value) || value.length > 2000 || value.some((file) => typeof file !== "string" ||
      !file.length || file.length > 1000 || /[\\\x00-\x1f]|^[\/]|^[A-Za-z]:/.test(file) ||
      file.split("/").some((part) => ["", ".", "..", ".git", ".data"].includes(part.toLowerCase())))) {
    throw new TypeError("Development review requires the actual changed-path list.");
  }
  return [...new Set(value)].sort();
}

function packageExecution(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid package manifest.");
  return Object.fromEntries(Object.entries(value).filter(([key]) => !packageMetadata.has(key)));
}

export function developmentReviewRequirements(files, packageChanges = {}, policyPaths = []) {
  const retained = new Set(changedPaths(policyPaths));
  const grouped = new Map();
  for (const file of changedPaths([...new Set([...changedPaths(files), ...retained])])) {
    let code = classifyDevelopmentPath(file);
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
  for (const file of files.filter((name) => classifyDevelopmentPath(name))) {
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
