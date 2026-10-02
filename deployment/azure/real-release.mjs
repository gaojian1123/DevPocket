import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { inspectFrozenArchive, validateRealArguments, sha, REAL_PROTOCOL, REAL_CHUNK_BYTES } from "./real-archive.mjs";
import { makeRealPlan, REAL_ACTIONS, REAL_PHASES } from "./real-plan.mjs";
import { renderRealAction } from "./real-actions.mjs";
import { RealRunner } from "./real-runner.mjs";
import { sourceFingerprint } from "./package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { positionals, values } = validateRealArguments(process.argv.slice(2));
const command = positionals[0] ?? "help";
const save = (file, value, exclusive = false) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: exclusive ? "wx" : "w", mode: 0o600 });
async function location() {
  const directory = path.resolve(values.directory ?? "");
  if (!directory.startsWith(path.join(root, ".data", "azure") + path.sep) || path.basename(directory) !== "real-release-001")
    throw new Error("Use only a private real-release-001 directory in this project.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("REAL_DIRECTORY_LINK");
  return directory;
}
async function loadContext(directory, checkSource = true) {
  const plan = JSON.parse(await readFile(path.join(directory, "plan.json"), "utf8"));
  const { planHash, ...data } = plan;
  if (sha(JSON.stringify(data)) !== planHash || plan.kind !== "frozen-real-release" ||
      (checkSource && await sourceFingerprint(root) !== plan.sourceHash)) throw new Error("REAL_PLAN_OR_SOURCE_CHANGED");
  const baseline = JSON.parse(await readFile(path.join(directory, "..", "recovery-001", "baseline.json"), "utf8"));
  const archivePath = path.join(directory, "..", "recovery-001", "packages", plan.business.archiveSha256 + ".tar.gz");
  return { root, directory, plan, baseline, archivePath };
}
export async function sizes(ctx) {
  const p = ctx.plan;
  const expiresAt = 9999999999999;
  const metadata = { protocol: REAL_PROTOCOL, planHash: p.planHash, vmId: p.allowedVmId, transferId: p.transferId,
    packageSha256: p.business.archiveSha256, manifestSha256: p.business.manifestSha256,
    expiresAt, transportSourceHash: p.sourceHash, archiveBytes: p.business.archiveBytes,
    publicKeySha256: "f".repeat(64), algorithm: "RSA-OAEP-SHA256+A256GCM", chunkBytes: REAL_CHUNK_BYTES };
  const count = Math.ceil(p.business.archiveBytes / REAL_CHUNK_BYTES);
  const envelope = { metadata, nonce: Buffer.alloc(12).toString("base64"), tag: Buffer.alloc(16).toString("base64"),
    wrappedKey: Buffer.alloc(384).toString("base64"), ciphertextSha256: "f".repeat(64),
    chunks: Array.from({ length: count }, (_, index) => ({ bytes: Math.min(REAL_CHUNK_BYTES, p.business.archiveBytes - index * REAL_CHUNK_BYTES), sha256: "f".repeat(64) })) };
  const measurements = [];
  for (const action of Object.keys(REAL_ACTIONS)) {
    const details = action === "begin" ? { envelope } : action === "chunk" ? { index: 0, data: Buffer.alloc(REAL_CHUNK_BYTES).toString("base64") } : {};
    const result = await renderRealAction(root, p, expiresAt, action, details);
    measurements.push({ action, requestBytes: result.bytes, seconds: result.spec.seconds });
  }
  const report = { planHash: p.planHash, localSyntheticEncodingOnly: true, noRealPackageEncrypted: true,
    hardLimit: 36369, maxRequestBytes: Math.max(...measurements.map((m) => m.requestBytes)),
    chunks: count, expectedActions: 11 + count, measurements };
  await save(path.join(ctx.directory, "request-size-proof.json"), report);
  return report;
}
async function main() {
  if (command === "help") {
    console.log(`Independent frozen real release path. Local: init-plan, sizes. No cloud phase is authorized by preparing a plan.
approve --phases <explicit real-* list> --confirm <reviewed plan hash>
Future execution: predeploy, run, status (read-only), cleanup-transfer, public-check.
No archive-path, arbitrary VM, script or Blob upload option exists; do not reuse probe/recovery approvals.`);
    return;
  }
  const directory = await location();
  if (command === "init-plan") {
    try { await lstat(path.join(directory, "plan.json")); throw new Error("Real plan already exists; preserve its evidence."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const [recovery, baseline, scope, accepted, origin] = await Promise.all([
      path.join(directory, "..", "recovery-001", "plan.json"), path.join(directory, "..", "recovery-001", "baseline.json"),
      path.join(directory, "scope.local.json"), path.join(directory, "..", "transport-probe-001", "acceptance.json"),
      path.join(directory, "..", "recovery-001", "execution-status.json"),
    ].map(async (name) => JSON.parse(await readFile(name, "utf8"))));
    if (scope.archiveSha256 !== origin.application.packageSha256 || scope.archiveBytes !== origin.application.packageBytes ||
        scope.originSourceHash !== origin.sourceFingerprint || scope.recoveryPlanHash !== origin.planHash)
      throw new Error("ONLY_RECORDED_FROZEN_BUSINESS_PACKAGE_ALLOWED");
    const file = path.join(directory, "..", "recovery-001", "packages", scope.archiveSha256 + ".tar.gz");
    const business = await inspectFrozenArchive(file, { sha256: scope.archiveSha256, bytes: scope.archiveBytes });
    const plan = makeRealPlan(recovery, baseline, scope, business, accepted, await sourceFingerprint(root), randomUUID());
    await save(path.join(directory, "business-provenance.json"), { ...business, originSourceHash: scope.originSourceHash,
      originRecoveryPlanHash: scope.recoveryPlanHash, originalArchiveRewritten: false, archiveExecuted: false }, true);
    await save(path.join(directory, "plan.json"), plan, true);
    console.log(JSON.stringify({ planHash: plan.planHash, transportSourceHash: plan.sourceHash, business: plan.business,
      vmId: plan.allowedVmId, transferId: plan.transferId, phases: REAL_PHASES, authorized: false }, null, 2));
    await sizes({ root, directory, plan });
    return;
  }
  const ctx = await loadContext(directory, command !== "status");
  if (command === "sizes") { console.log(JSON.stringify(await sizes(ctx), null, 2)); return; }
  if (command === "approve") {
    const phases = (values.phases ?? "").split(",");
    if (values.confirm !== ctx.plan.planHash || phases.some((phase) => !REAL_PHASES.includes(phase)))
      throw new Error("Exact new real plan and explicitly permitted real-* phases are required.");
    await save(path.join(directory, "approval.local.json"), { schemaVersion: 1, planHash: ctx.plan.planHash, phases,
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString() });
    console.log("New real-phase approval recorded; no execution implied. Do not run this command before explicit user approval.");
    return;
  }
  const runner = new RealRunner(root, directory, ctx.plan, ctx.baseline, ctx.archivePath);
  if (command === "status") { console.log(JSON.stringify(await runner.status())); return; }
  if (command === "public-check") return runner.publicCheck();
  if (command === "predeploy") {
    await runner.authorize(REAL_PHASES);
    await runner.verifyTarget();
    console.log("Exact real-release authorization and target checks passed; no source sent.");
    return;
  }
  if (command === "run") { await runner.run(); return; }
  if (command === "cleanup-transfer") { console.log(JSON.stringify(await runner.action("cleanup-transfer"))); return; }
  throw new Error("REAL_COMMAND_DENIED");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
