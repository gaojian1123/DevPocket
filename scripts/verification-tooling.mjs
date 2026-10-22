import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { diagnosticError } from "./diagnostic-errors.mjs";
import { WORKFLOW_TEST_FILES, WORKFLOW_TEST_SHARDS } from "./test-workflow.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const runnerHash = createHash("sha256").update(await readFile(new URL("./test-workflow.mjs", import.meta.url))).digest("hex");

function catalogue() {
  return { version: 1, files: [...WORKFLOW_TEST_FILES], parts: structuredClone(WORKFLOW_TEST_SHARDS),
    fingerprint: digest(WORKFLOW_TEST_SHARDS) };
}

export async function toolingCatalogue(root, options) {
  if (options !== undefined) throw diagnosticError("configuration");
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw diagnosticError("configuration", error); }
  const scripts = manifest.scripts;
  if (scripts?.["test:workflow"] !== "node scripts/test-workflow.mjs" ||
      scripts["pretest:workflow"] || scripts["posttest:workflow"]) return null;
  const file = path.join(root, "scripts", "test-workflow.mjs"), info = await lstat(file);
  const physicalRoot = await realpath(root), physical = await realpath(file);
  const samePath = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 ||
      samePath(physical) !== samePath(path.join(physicalRoot, "scripts", "test-workflow.mjs")) ||
      createHash("sha256").update(await readFile(file)).digest("hex") !== runnerHash) {
    throw diagnosticError("policy-mismatch");
  }
  return catalogue();
}

export function requireToolingCatalogue(value) {
  if (!equal(value, catalogue())) {
    throw diagnosticError("policy-mismatch");
  }
  return value;
}

export function toolingShardDescriptor(plan, id) {
  const catalogue = requireToolingCatalogue(plan.toolingShards);
  if (!catalogue.parts.some((part) => part.id === id)) throw diagnosticError("configuration");
  return { version: 1, id, catalogue: catalogue.fingerprint };
}

export function requireToolingShard(plan, descriptor) {
  if (!descriptor || !equal(descriptor, toolingShardDescriptor(plan, descriptor.id))) {
    throw diagnosticError("policy-mismatch");
  }
  return descriptor;
}
