import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSyntheticFixture, validateProbeArguments, sha256 } from "./probe-crypto.mjs";
import { makeProbePlan, ProbeRunner, PROBE_PHASES } from "./probe-runner.mjs";
import { sourceFingerprint } from "./package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { positionals, values } = validateProbeArguments(process.argv.slice(2));
const command = positionals[0] ?? "help";
const json = (file, data, exclusive = false) => writeFile(file, JSON.stringify(data, null, 2) + "\n",
  { flag: exclusive ? "wx" : "w", mode: 0o600 });

async function location() {
  const directory = path.resolve(values.directory ?? "");
  if (!directory.startsWith(path.join(root, ".data", "azure") + path.sep) ||
      path.basename(directory) !== "transport-probe-001") throw new Error("Only a transport-probe-001 directory in this project's private Azure tree is accepted.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Private probe directory must not be a link.");
  return directory;
}

async function planAt(directory, checkSource = true) {
  const plan = JSON.parse(await readFile(path.join(directory, "plan.json"), "utf8"));
  const { planHash, ...body } = plan;
  if (sha256(JSON.stringify(body)) !== planHash || plan.kind !== "synthetic-transport-probe" ||
      (checkSource && await sourceFingerprint(root) !== plan.sourceHash)) throw new Error("Probe plan/source changed; no management action is authorized.");
  return plan;
}

async function main() {
  if (command === "help") {
    console.log(`Synthetic-only transport probe; no real archive or arbitrary VM argument is supported.
init-plan --directory <private transport-probe-001>
approve --directory <same> --confirm <exact probe planHash> (separate user authorization required)
run --directory <same> (bounded synthetic actions, private key and cleanup only)
status --directory <same> (read-only operation status; never retries a POST)
cleanup --directory <same> (only after prior operation settled and exact probe cleanup approval)
No upload/deploy/start, dependency install, disk mount/format or infrastructure phase exists.`);
    return;
  }
  const directory = await location();
  if (command === "init-plan") {
    try { await lstat(path.join(directory, "plan.json")); throw new Error("Probe already planned. Do not overwrite its fixtures/approval/history."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const [recovery, baseline, scope] = await Promise.all([
      path.join(directory, "..", "recovery-001", "plan.json"),
      path.join(directory, "..", "recovery-001", "baseline.json"),
      path.join(directory, "scope.local.json"),
    ].map(async (file) => JSON.parse(await readFile(file, "utf8"))));
    const fixtureData = {
      small: await createSyntheticFixture(directory, "small", 512),
      scale: await createSyntheticFixture(directory, "scale", 44993),
    };
    const plan = makeProbePlan(recovery, baseline, scope, fixtureData, randomUUID(), await sourceFingerprint(root));
    await json(path.join(directory, "fixtures.local.json"), fixtureData, true);
    await json(path.join(directory, "plan.json"), plan, true);
    console.log(JSON.stringify({ planHash: plan.planHash, sourceHash: plan.sourceHash, vmId: plan.allowedVmId,
      transferId: plan.transferId, fixtures: plan.fixtures, policy: plan.policy, expiresAt: new Date(plan.expiresAt).toISOString() }, null, 2));
    return;
  }
  const plan = await planAt(directory, command !== "status");
  if (command === "approve") {
    if (values.confirm !== plan.planHash) throw new Error("Exact probe-only confirmation is required.");
    await json(path.join(directory, "probe-approval.local.json"), {
      schemaVersion: 1, planHash: plan.planHash, phases: PROBE_PHASES,
      issuedAt: new Date().toISOString(), expiresAt: new Date(plan.expiresAt).toISOString(),
    });
    console.log("Probe-only approval recorded. Real source/upload/deploy/start/CA and dependency installation are not authorized.");
    return;
  }
  const runner = new ProbeRunner(root, directory, plan);
  if (command === "run") {
    const result = await runner.run();
    console.log(JSON.stringify({ status: result.status, fixtureResults: result.fixtureResults,
      logAudit: result.logAudit, cleanup: result.cleanup }, null, 2));
    return;
  }
  if (command === "status") {
    const { readdir } = await import("node:fs/promises");
    const operationsDir = path.join(directory, "operations");
    const names = (await readdir(operationsDir)).filter((name) => name.endsWith(".json")).sort();
    if (!names.length) throw new Error("No operation has been submitted.");
    const last = JSON.parse(await readFile(path.join(operationsDir, names.at(-1)), "utf8"));
    const uri = last.azureAsyncOperation ?? last.resultLocation;
    if (!uri) {
      console.log(JSON.stringify({ operationId: last.operationId, state: last.state, azureOperationKnown: false,
        instruction: "Inspect the exact VM instance-view/action state; do not replay a POST with unknown outcome." }));
      return;
    }
    const url = new URL(uri);
    if (url.origin !== "https://management.azure.com") throw new Error("Unexpected operation host.");
    const response = await runner.api.arm(url.pathname + url.search);
    const status = { at: new Date().toISOString(), operationId: last.operationId, state: response.value.status ?? response.status,
      postResubmitted: false };
    if (["Succeeded", "Failed", "Canceled"].includes(response.value.status)) {
      last.azureExecutionSettled = true;
      last.state = "settled-output-unverified";
      last.lastAzureState = response.value.status;
      await json(path.join(operationsDir, names.at(-1)), last);
    }
    await json(path.join(directory, "last-readonly-status.json"), status);
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  if (command === "cleanup") {
    const { readdir } = await import("node:fs/promises");
    const operations = path.join(directory, "operations");
    const names = (await readdir(operations)).filter((name) => name.endsWith(".json")).sort();
    const last = names.length ? JSON.parse(await readFile(path.join(operations, names.at(-1)), "utf8")) : null;
    if (last && !["settled", "settled-output-unverified", "azure-failed"].includes(last.state)) throw new Error("Last action is not confirmed settled. Read status before cleanup; do not create concurrent actions.");
    console.log(JSON.stringify(await runner.action("cleanup")));
    return;
  }
  throw new Error("Only synthetic probe commands are allowed.");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
