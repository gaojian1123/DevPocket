import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { diagnosticDirectory } from "./diagnostic-publication.mjs";
import { diagnosticError } from "./diagnostic-errors.mjs";
import { CHECKS, CHECK_GROUPS } from "./verification-policy.mjs";
import { requireCheckPolicy, requireCompletedVerificationGroup, requireToolingShardReport, requireVerificationOutputDirectory,
  verificationFault, verificationStorageLocation } from "./verification.mjs";
export { verificationStorageLocation } from "./verification.mjs";

const version = 2;
const limit = 512 * 1024;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tipPath = (root, id) => path.join(root, ".data", "verification", "local", `${id}.json`);
const pathKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;

function binding(plan, group, policy, options) {
  if (options.trustedToolingRunner !== undefined || options.trustedTooling === true) throw diagnosticError("configuration");
  return { base: plan.base, source: plan.source, version: plan.version,
    requiredChecks: plan.requiredChecks, requiredGroups: plan.requiredGroups, layouts: plan.layouts, ciMacos: plan.ciMacos ?? false,
    trustedDeviceClasses: plan.trustedDeviceClasses ?? [], group, policy,
    backendDiagnostics: Boolean(options.backendDiagnostics), toolingShard: options.toolingShard ?? null };
}

async function safeDirectory(root, directory, create = false) {
  const relative = path.relative(root, directory);
  if (!["verification", "ci", "development"].some((name) => {
    const allowed = path.join(".data", name);
    return relative === allowed || relative.startsWith(allowed + path.sep);
  })) {
    throw diagnosticError("ownership-mismatch");
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (create) {
      try { await mkdir(current); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(current), current)) {
      throw diagnosticError("ownership-mismatch");
    }
  }
}

async function readOwned(root, file, maximum = limit) {
  await safeDirectory(root, path.dirname(file));
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) {
    throw diagnosticError("run-invalid");
  }
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size ||
        info.mode !== before.mode || info.mtimeMs !== before.mtimeMs || info.size > maximum || info.nlink !== 1) {
      throw diagnosticError("run-invalid");
    }
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw diagnosticError("run-invalid");
      offset += result.bytesRead;
    }
    // Windows can flush close-time ctime on open; compare the opened identity across the read.
    for (const after of [await handle.stat(), await lstat(file)]) {
      if (["dev", "ino", "size", "mode", "nlink", "mtimeMs", "ctimeMs"].some((key) => after[key] !== info[key])) {
        throw diagnosticError("run-invalid");
      }
    }
    return bytes;
  } finally { await handle.close(); }
}

async function writeNew(root, file, bytes) {
  await safeDirectory(root, path.dirname(file));
  if (bytes.length > limit) throw diagnosticError("output-limit");
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function localKey(root, resume) {
  const directory = await diagnosticDirectory(root, path.join(".data", "verification", "local"));
  const file = path.join(directory, "receipt.key");
  if (!resume) {
    try { await writeNew(root, file, randomBytes(32)); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  let bytes;
  try { bytes = await readOwned(root, file, 32); }
  catch (error) { throw diagnosticError("run-untrusted", error); }
  if (bytes.length !== 32) throw diagnosticError("run-untrusted");
  return bytes;
}

function codec(key) {
  const signature = (record) => createHmac("sha256", key).update(JSON.stringify(record)).digest();
  return {
    encode: (record) => Buffer.from(JSON.stringify({ record, signature: signature(record).toString("hex") }) + "\n"),
    decode(bytes) {
      let envelope;
      try { envelope = JSON.parse(bytes); }
      catch (error) { throw diagnosticError("run-invalid", error); }
      if (!envelope || !envelope.record || !/^[a-f0-9]{64}$/.test(envelope.signature ?? "") ||
          !timingSafeEqual(signature(envelope.record), Buffer.from(envelope.signature, "hex"))) {
        throw diagnosticError("run-untrusted");
      }
      return envelope.record;
    },
  };
}

// A file lock is deliberately not reclaimed from a PID: an interrupted descendant may still own outputs.
export async function acquireVerificationLock(root) {
  root = await realpath(path.resolve(root));
  const directory = await diagnosticDirectory(root, path.join(".data", "verification", "local"));
  const file = path.join(directory, "execution.lock");
  const bytes = Buffer.from(JSON.stringify({ version, pid: process.pid, owner: randomUUID() }) + "\n");
  let handle;
  try { handle = await open(file, "wx", 0o600); }
  catch (error) { throw diagnosticError(error.code === "EEXIST" ? "run-locked" : "report-write", error); }
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { await handle.close(); throw error; }
  return async (safe) => {
    await handle.close();
    if (!safe) return;
    if (!(await readOwned(root, file)).equals(bytes)) throw diagnosticError("ownership-mismatch");
    await unlink(file);
  };
}

async function history(root, directory, manifest, signing) {
  const plan = manifest.plan, group = manifest.binding.group;
  const selectedGroups = plan.requiredGroups.filter((name) => group === "all" || group === name);
  const read = async (name) => signing.decode(await readOwned(root, path.join(directory, name)));
  const names = (await readdir(directory)).sort();
  if (names.some((name) => name !== "run.json" && !/^\d{4}-(?:start|finish|tooling|backend|android|device)\.json$/.test(name))) {
    throw diagnosticError("run-invalid");
  }
  const starts = names.filter((name) => name.endsWith("-start.json"));
  const tip = signing.decode(await readOwned(root, tipPath(root, manifest.id)));
  if (tip.version !== version || tip.run !== manifest.id || tip.phase !== "finished" ||
      tip.attempt !== String(starts.length).padStart(4, "0")) throw diagnosticError("run-incomplete");
  let previous = null, report;
  const latest = new Map(), outputs = new Set(), accounted = new Set(["run.json"]);
  for (let index = 0; index < starts.length; index++) {
    const id = String(index + 1).padStart(4, "0");
    if (starts[index] !== `${id}-start.json` || !names.includes(`${id}-finish.json`)) throw diagnosticError("run-incomplete");
    const start = await read(`${id}-start.json`), finish = await read(`${id}-finish.json`);
    accounted.add(`${id}-start.json`); accounted.add(`${id}-finish.json`);
    if (start.version !== version || finish.version !== version ||
        start.run !== manifest.id || start.attempt !== id || start.previous !== previous ||
        finish.run !== manifest.id || finish.attempt !== id || finish.safeToResume !== true ||
        !Array.isArray(finish.groups) || !Array.isArray(finish.report?.checks) ||
        !["passed", "partial", "blocked", "failed"].includes(finish.report.status)) throw diagnosticError("run-incomplete");
    requireQualifiedGroups(plan, finish.report, finish.qualifiedGroups, selectedGroups);
    const output = path.resolve(root, start.output ?? "");
    await safeDirectory(root, output);
    if (outputs.has(pathKey(output))) throw diagnosticError("run-invalid");
    outputs.add(pathKey(output));
    const seen = new Set();
    for (const selected of finish.groups) {
      if (!CHECK_GROUPS.includes(selected) || seen.has(selected) ||
          !plan.requiredGroups.includes(selected) || group !== "all" && group !== selected) throw diagnosticError("run-invalid");
      seen.add(selected);
      const name = `${id}-${selected}.json`;
      const receipt = await read(name);
      accounted.add(name);
      if (receipt.version !== version || receipt.run !== manifest.id || receipt.attempt !== id || receipt.report?.group !== selected ||
          !equal(receipt.report?.source, plan.source) || receipt.report?.base !== plan.base ||
          !equal(receipt.report?.requiredChecks, plan.requiredChecks) ||
          !equal(receipt.report?.requiredGroups, plan.requiredGroups)) throw diagnosticError("run-invalid");
      latest.set(selected, receipt);
    }
    for (const selected of selectedGroups) {
      const receipt = latest.get(selected);
      const preflight = finish.report.preflight?.groups?.find((item) => item.group === selected);
      const environmentChanged = preflight?.status === "passed" && preflight.fingerprint !== receipt?.environment;
      if (!finish.qualifiedGroups.includes(selected) && latest.has(selected) &&
          (preflight && preflight.status !== "passed" || environmentChanged ||
            finish.report.checks.some((check) => check.status === "passed" &&
              CHECKS.some((definition) => definition.id === check.id && definition.group === selected)))) {
        latest.set(selected, { ...receipt, invalidated: environmentChanged ? "environment-changed" :
          ["environment-changed", "artifact-changed"].includes(finish.report.failure?.reason)
            ? finish.report.failure.reason : "environment-unconfirmed" });
      }
    }
    previous = id;
    report = finish.report;
  }
  if (names.some((name) => !accounted.has(name))) throw diagnosticError("run-incomplete");
  return { latest, outputs, previous, count: starts.length, report };
}

function requireQualifiedGroups(plan, report, qualifiedGroups, selectedGroups) {
  if (!Array.isArray(report?.checks) || !Array.isArray(qualifiedGroups) ||
      new Set(qualifiedGroups).size !== qualifiedGroups.length ||
      report.complete === true && selectedGroups.some((group) => !qualifiedGroups.includes(group)) ||
      qualifiedGroups.some((group) => !selectedGroups.includes(group) ||
        CHECKS.filter((check) => check.group === group && plan.requiredChecks.includes(check.id))
          .some(({ id }) => report.checks.filter((check) => check.id === id && check.status === "passed").length !== 1))) {
    throw diagnosticError("run-invalid");
  }
}

export async function readVerificationRun(root, file) {
  ({ root, file } = await verificationStorageLocation(root, file));
  if (path.basename(file) !== "run.json") throw diagnosticError("run-invalid");
  const directory = path.dirname(file), signing = codec(await localKey(root, true));
  const manifest = signing.decode(await readOwned(root, file));
  if (manifest.version !== version || manifest.kind !== "verification-run" || manifest.transition != null || !uuid.test(manifest.id ?? "") ||
      !samePath(manifest.root ?? "", await realpath(root)) || !manifest.plan) throw diagnosticError("run-invalid");
  requireCheckPolicy(manifest.plan);
  const persistedTooling = manifest.binding?.trustedTooling;
  if (persistedTooling !== undefined && persistedTooling !== false) throw diagnosticError("run-invalid");
  const expected = binding(manifest.plan, manifest.binding?.group, manifest.binding?.policy, manifest.binding);
  if (Object.hasOwn(manifest.binding, "trustedTooling")) expected.trustedTooling = false;
  if (!equal(manifest.binding, expected) ||
      !["all", ...CHECK_GROUPS].includes(manifest.binding.group) ||
      !/^[a-f0-9]{64}$/.test(manifest.binding.policy ?? "")) throw diagnosticError("run-invalid");
  return { manifest, directory, ...await history(root, directory, manifest, signing) };
}

export async function openVerificationRun(root, plan, options, policy) {
  if (arguments.length > 4 || ["promote", "candidateRequest", "candidateEvidence", "transition"]
    .some((key) => Object.hasOwn(options, key))) throw diagnosticError("configuration");
  const location = await requireVerificationOutputDirectory(root, options.directory, [options.resume]);
  const resume = options.resume ? (await verificationStorageLocation(root, options.resume)).file : undefined;
  root = location.root;
  options = { ...options, directory: location.file, resume };
  const group = options.group ?? "all", expected = binding(plan, group, policy, options);
  const signing = codec(await localKey(root, Boolean(options.resume)));
  let directory, manifest, previous = null, count = 0, latest = new Map(), outputs = new Set();
  if (options.resume) {
    const loaded = await readVerificationRun(root, options.resume);
    ({ manifest, directory, previous, count, latest, outputs } = loaded);
    if (manifest.binding.base !== plan.base || !equal(manifest.binding.source, plan.source)) {
      throw verificationFault("source-mismatch", { phase: "source-validation" });
    }
    if (!equal(manifest.binding, expected)) {
      throw verificationFault("policy-mismatch", { phase: "preflight" });
    }
  } else {
    directory = path.join(options.directory, "run");
    await safeDirectory(root, path.resolve(options.directory), true);
    await mkdir(directory);
    manifest = { version, kind: "verification-run", id: randomUUID(), root: await realpath(root), binding: expected,
      plan, createdAt: new Date().toISOString() };
    await writeNew(root, path.join(directory, "run.json"), signing.encode(manifest));
  }
  if (count >= 128) throw diagnosticError("run-limit");
  const write = async (name, record) => writeNew(root, path.join(directory, name), signing.encode(record));
  const output = path.resolve(options.directory);
  if (outputs.has(pathKey(output))) throw diagnosticError("run-output-reused");
  await safeDirectory(root, output, true);
  const attempt = String(count + 1).padStart(4, "0"), groups = [];
  await write(`${attempt}-start.json`, { version, run: manifest.id, attempt, previous,
    output: path.relative(root, output), pid: process.pid, startedAt: new Date().toISOString() });
  const tip = tipPath(root, manifest.id);
  const updateTip = async (phase) => {
    const value = { version, run: manifest.id, attempt, phase };
    if (!previous && phase === "started") {
      await writeNew(root, tip, signing.encode(value));
      return;
    }
    const expected = { version, run: manifest.id, attempt: phase === "started" ? previous : attempt,
      phase: phase === "started" ? "finished" : "started" };
    if (!equal(signing.decode(await readOwned(root, tip)), expected)) throw diagnosticError("run-incomplete");
    const next = `${tip}.${randomUUID()}.next`;
    await writeNew(root, next, signing.encode(value));
    await rename(next, tip);
  };
  await updateTip("started");
  return {
    reference: { version, id: manifest.id, manifest: path.relative(root, path.join(directory, "run.json")), attempt },
    async reusable(group, fingerprint, artifacts, reusable = false) {
      const receipt = latest.get(group);
      if (receipt?.invalidated) return { status: "invalidated", reason: receipt.invalidated };
      if (!receipt || !["passed", "partial"].includes(receipt.report.status)) return { status: "pending" };
      if (receipt.environment !== fingerprint) return { status: "invalidated", reason: "environment-changed" };
      if (!reusable || receipt.reusable !== true) return { status: "invalidated", reason: "environment-unbound" };
      if (artifacts.available !== true || !equal(receipt.artifacts, artifacts)) return { status: "invalidated", reason: "artifact-changed" };
      requireCompletedVerificationGroup(plan, receipt.report, group);
      return { status: "reused", attempt: receipt.attempt, report: receipt.report };
    },
    async record(report, environment, artifacts, reusable = false) {
      if (!CHECK_GROUPS.includes(report.group) || groups.includes(report.group)) throw diagnosticError("run-invalid");
      if (["passed", "partial"].includes(report.status)) {
        if (report.checks.some((check) => check.toolingShard)) {
          requireToolingShardReport(plan, report);
          reusable = false;
        } else requireCompletedVerificationGroup(plan, report, report.group);
      }
      await write(`${attempt}-${report.group}.json`, { version, run: manifest.id, attempt, report, environment, artifacts, reusable });
      groups.push(report.group);
    },
    async finish(report, safeToResume, qualifiedGroups = []) {
      requireQualifiedGroups(plan, report, qualifiedGroups, plan.requiredGroups.filter((name) => group === "all" || group === name));
      await write(`${attempt}-finish.json`, { version, run: manifest.id, attempt, groups, report, safeToResume, qualifiedGroups,
        completedAt: new Date().toISOString() });
      await updateTip("finished");
    },
  };
}
