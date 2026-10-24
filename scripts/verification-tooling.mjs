import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { diagnosticError } from "./diagnostic-errors.mjs";
import { TOOLING_TEST_FILES, TOOLING_TEST_SHARDS } from "./test-tooling.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const runnerHash = createHash("sha256").update(await readFile(new URL("./test-tooling.mjs", import.meta.url))).digest("hex");

function catalogue() {
  return { version: 1, files: [...TOOLING_TEST_FILES], parts: structuredClone(TOOLING_TEST_SHARDS),
    fingerprint: digest(TOOLING_TEST_SHARDS) };
}

export async function toolingCatalogue(root, options) {
  if (options !== undefined) throw diagnosticError("configuration");
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw diagnosticError("configuration", error); }
  const scripts = manifest.scripts;
  if (scripts?.["test:tooling"] !== "node scripts/test-tooling.mjs" ||
      scripts["pretest:tooling"] || scripts["posttest:tooling"]) return null;
  const file = path.join(root, "scripts", "test-tooling.mjs"), info = await lstat(file);
  const physicalRoot = await realpath(root), physical = await realpath(file);
  const samePath = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 ||
      samePath(physical) !== samePath(path.join(physicalRoot, "scripts", "test-tooling.mjs")) ||
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
