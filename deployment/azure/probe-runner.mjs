import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AzureOperations } from "./cloud.mjs";
import { requireApproval } from "./plan.mjs";
import { sourceFingerprint } from "./package.mjs";
import { sha256, encryptFixture, PROBE_PROTOCOL } from "./probe-crypto.mjs";

export const PROBE_PHASES = ["probe-inspect", "probe-init", "probe-small", "probe-scale",
  "probe-negative", "probe-audit", "probe-cleanup"];
const json = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
const publicFixture = (item) => ({ archiveSha256: item.archiveSha256, archiveBytes: item.archiveBytes,
  contentSha256: item.contentSha256, contentBytes: item.contentBytes });

export function makeProbePlan(recovery, baseline, scope, fixtures, transferId, sourceHash, now = Date.now()) {
  const { planHash: recoveryHash, ...recoveryBody } = recovery;
  if (sha256(JSON.stringify(recoveryBody)) !== recoveryHash) throw new Error("Preserved recovery plan is not intact.");
  const expectedVm = `/subscriptions/${recovery.target.subscriptionId}/resourceGroups/${recovery.target.resourceGroup}/providers/Microsoft.Compute/virtualMachines/${recovery.names.vm}`;
  if (scope.recoveryPlanHash !== recovery.planHash || scope.allowedVmId !== expectedVm ||
      baseline.vm.id.toLowerCase() !== expectedVm.toLowerCase() || scope.deploymentId !== recovery.target.deploymentId)
    throw new Error("Probe target must match the explicitly approved, preserved recovery VM and owner.");
  if (!/^[a-f0-9-]{36}$/.test(transferId) || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("Invalid probe identity.");
  const plan = {
    schemaVersion: 1, kind: "synthetic-transport-probe", protocol: PROBE_PROTOCOL, probeId: "transport-probe-001",
    sourceHash, recoveryPlanHash: recovery.planHash, target: recovery.target, names: recovery.names, recovery: recovery.recovery,
    vm: recovery.vm, allowedVmId: expectedVm, expectedVmIdentity: baseline.vm.identity,
    expectedStorageProfile: baseline.vm.properties.storageProfile,
    transferId, createdAt: now, expiresAt: now + 2 * 3600_000,
    fixtures: { small: publicFixture(fixtures.small), scale: publicFixture(fixtures.scale) },
    policy: {
      syntheticOnly: true, realPackageInputs: false, installDependencies: false, infrastructureChanges: false,
      diskMountOrFormat: false, runtimeBuildOrStart: false, maxActions: 20, maxVmScriptSeconds: 30,
      maxActionInputBytes: 96 * 1024, maxArchiveBytes: 65536, maxStoredProbeBytes: 1024 * 1024,
      chunkBytes: 8192, maxOutputBytes: 3200, phases: PROBE_PHASES,
      privateDirectory: `/var/lib/devpocket-transport-probes/${transferId}`,
    },
  };
  return { ...plan, planHash: sha256(JSON.stringify(plan)) };
}

export function wirePlan(plan) {
  return { protocol: plan.protocol, planHash: plan.planHash, vmId: plan.allowedVmId,
    transferId: plan.transferId, expiresAt: plan.expiresAt, fixtures: plan.fixtures };
}

export function parseProbeResult(raw, forbidden = []) {
  const messages = (raw.value ?? []).map((entry) => String(entry.message ?? "")).join("\n");
  const privateMarker = /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(messages);
  if (privateMarker || forbidden.some((item) => item && messages.includes(item)))
    throw new Error("Probe ARM result contains a forbidden synthetic sentinel/key representation; raw output was not persisted.");
  const lines = messages.split(/\r?\n/).filter((line) => line.startsWith("DEVPOCKET_PROBE_RESULT="));
  if (lines.length !== 1) throw new Error("No unique bounded probe evidence in ARM result; raw output was not persisted.");
  const payload = lines[0].slice("DEVPOCKET_PROBE_RESULT=".length);
  if (Buffer.byteLength(payload) > 3200) throw new Error("Probe result exceeded its output budget.");
  const result = JSON.parse(payload);
  if (typeof result.status !== "string") throw new Error("Invalid probe result contract.");
  return result;
}

export class ProbeRunner {
  constructor(root, directory, plan) {
    this.root = root;
    this.directory = directory;
    this.plan = plan;
    this.api = new AzureOperations(plan);
    this.keys = [];
    this.forbidden = [];
    this.uncertain = false;
  }

  async authorized(phase) {
    if (await sourceFingerprint(this.root) !== this.plan.sourceHash) throw new Error("Probe source changed. Obtain a new probe approval before any next action.");
    const approval = JSON.parse(await readFile(path.join(this.directory, "probe-approval.local.json"), "utf8"));
    requireApproval(this.plan, approval, phase);
  }

  async verifyTarget() {
    await this.api.preflight();
    if (this.api.vmPath !== this.plan.allowedVmId) throw new Error("VM target mismatch.");
    const vm = (await this.api.arm(this.api.vmPath + "?api-version=2024-07-01")).value;
    if (vm.tags?.["devpocket-deployment-id"] !== this.plan.target.deploymentId ||
        JSON.stringify(vm.identity) !== JSON.stringify(this.plan.expectedVmIdentity) ||
        JSON.stringify(vm.properties.storageProfile) !== JSON.stringify(this.plan.expectedStorageProfile) ||
        vm.properties.hardwareProfile.vmSize !== this.plan.vm.size)
      throw new Error("Live VM owner, identity, size or disks differ from the fixed target.");
    return vm;
  }

  phase(action) {
    return action === "inspect" ? "probe-inspect" : action === "init" ? "probe-init" :
      action === "small" ? "probe-small" : ["begin-scale", "chunk", "finish-scale"].includes(action) ? "probe-scale" :
        action === "negative" ? "probe-negative" : action === "audit" ? "probe-audit" :
          action === "cleanup" ? "probe-cleanup" : "NOT_AUTHORIZED";
  }

  async action(action, details = {}) {
    if (this.uncertain) throw new Error("A previous action result is uncertain. Only status inspection is allowed; do not submit another VM command.");
    await this.authorized(this.phase(action));
    await this.verifyTarget();
    const operationsDir = path.join(this.directory, "operations");
    await mkdir(operationsDir, { recursive: true, mode: 0o700 });
    const previous = (await readdir(operationsDir)).filter((name) => name.endsWith(".json"));
    if (previous.length >= this.plan.policy.maxActions) throw new Error("Probe action budget exhausted. No further command submitted.");
    const id = randomUUID();
    const payload = { plan: wirePlan(this.plan), action, ...details };
    const receiver = await readFile(path.join(this.root, "deployment", "azure", "probe", "receiver.py"), "utf8");
    const source = receiver.replace("__DEVPOCKET_PROBE_PAYLOAD__", Buffer.from(JSON.stringify(payload)).toString("base64"));
    if (source === receiver || source.includes("__DEVPOCKET_PROBE_PAYLOAD__")) throw new Error("Invalid bounded receiver template.");
    const body = { commandId: "RunShellScript", script: [
      "#!/bin/sh", "set -eu", "umask 077", "timeout 45s python3 - <<'DEVPOCKET_SYNTHETIC_RECEIVER'", source, "DEVPOCKET_SYNTHETIC_RECEIVER",
    ] };
    const requestBytes = Buffer.byteLength(JSON.stringify(body));
    if (requestBytes > this.plan.policy.maxActionInputBytes) throw new Error("Probe request exceeds the reviewed fixed size budget.");
    const receipt = {
      operationId: id, action, fixtureId: details.envelope?.metadata.fixtureId ?? (action === "chunk" ? "scale" : null),
      index: details.index ?? null, vmId: this.plan.allowedVmId, planHash: this.plan.planHash,
      requestSha256: sha256(JSON.stringify(body)), requestBytes, startedAt: new Date().toISOString(),
      state: "submitting", postCount: 1, scriptSecondsLimit: 30, outerSecondsLimit: 45,
    };
    const receiptFile = path.join(operationsDir, `${String(previous.length + 1).padStart(2, "0")}-${action}-${id}.json`);
    await json(receiptFile, receipt);
    try {
      let response = await this.api.arm(this.api.vmPath + "/runCommand?api-version=2024-07-01", { method: "POST", body });
      const asyncUrl = response.headers.get("azure-asyncoperation");
      const resultUrl = response.headers.get("location");
      receipt.azureAsyncOperation = asyncUrl;
      receipt.resultLocation = resultUrl;
      receipt.azureRequestId = response.headers.get("x-ms-request-id");
      receipt.state = "accepted";
      await json(receiptFile, receipt);
      const get = async (url) => {
        const target = new URL(url);
        if (target.origin !== "https://management.azure.com" ||
            !target.pathname.toLowerCase().startsWith(`/subscriptions/${this.plan.target.subscriptionId}/`.toLowerCase()))
          throw new Error("Unexpected Action Run Command operation/result URL.");
        return this.api.arm(target.pathname + target.search);
      };
      let result = response.value;
      let azureSettled = response.status === 200 && Array.isArray(response.value.value);
      if (response.status === 202 || asyncUrl || resultUrl) {
        if (!asyncUrl && !resultUrl) throw new Error("Action accepted without an operation URL.");
        let finished = false;
        for (let count = 0; count < 120; count++) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          response = await get(asyncUrl || resultUrl);
          receipt.lastPollAt = new Date().toISOString();
          receipt.lastAzureState = response.value.status ?? response.status;
          await json(receiptFile, receipt);
          if (response.value.status === "Failed" || response.value.status === "Canceled") {
            receipt.state = "azure-failed";
            await json(receiptFile, receipt);
            throw new Error("Action Run Command failed. Inspect the recorded state; raw diagnostics are not exported.");
          }
          if (response.value.status === "Succeeded" || Array.isArray(response.value.value)) {
            result = resultUrl ? (await get(resultUrl)).value : response.value;
            azureSettled = true;
            finished = true;
            break;
          }
        }
        if (!finished) throw new Error("Action polling budget expired. No command will be resubmitted.");
      }
      if (azureSettled) {
        receipt.state = "settled-output-unverified";
        receipt.azureExecutionSettled = true;
        await json(receiptFile, receipt);
      }
      const parsed = parseProbeResult(result, this.forbidden);
      receipt.result = parsed;
      receipt.state = "settled";
      receipt.finishedAt = new Date().toISOString();
      receipt.armOutputSecretMatches = 0;
      await json(receiptFile, receipt);
      if (parsed.status === "failed") throw new Error(`Probe rejected: ${parsed.code}; cleanup status ${parsed.cleanup?.status ?? "unknown"}`);
      console.log(`[probe] ${action}: ${parsed.status} (request ${requestBytes} bytes)`);
      return parsed;
    } catch (error) {
      if (!["settled", "settled-output-unverified", "azure-failed"].includes(receipt.state)) {
        this.uncertain = true;
        receipt.state = "uncertain";
      }
      receipt.error = error.message;
      await json(receiptFile, receipt);
      throw error;
    }
  }

  async run() {
    await this.authorized("probe-inspect");
    const marker = path.join(this.directory, "run-started.json");
    await writeFile(marker, JSON.stringify({ planHash: this.plan.planHash, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    const report = { planHash: this.plan.planHash, sourceHash: this.plan.sourceHash, startedAt: new Date().toISOString(),
      fixtureResults: [], status: "running", realSourceReadOrSent: false, installationOrRuntimeStart: false };
    let initializationAttempted = false;
    const fixtureData = JSON.parse(await readFile(path.join(this.directory, "fixtures.local.json"), "utf8"));
    this.forbidden = Object.values(fixtureData).map((f) => f.sentinel);
    try {
      report.preflight = await this.action("inspect");
      if (report.preflight.status !== "ready") throw new Error("VM crypto dependencies are unavailable; no installation is authorized.");
      initializationAttempted = true;
      report.key = await this.action("init");
      if (!report.key.rootOnlyPermissions || report.key.rsaBits !== 3072) throw new Error("VM key contract failed.");
      const encrypted = {};
      for (const id of ["small", "scale"]) {
        if (JSON.stringify(publicFixture(fixtureData[id])) !== JSON.stringify(this.plan.fixtures[id]))
          throw new Error("Only the immutable synthetic fixture hashes in this approved probe may be read.");
        encrypted[id] = await encryptFixture(this.directory, fixtureData[id], report.key.publicKeyPem, {
          protocol: PROBE_PROTOCOL, probePlanHash: this.plan.planHash, vmId: this.plan.allowedVmId,
          transferId: this.plan.transferId, fixtureId: id, fixtureSha256: this.plan.fixtures[id].archiveSha256,
          expiresAt: this.plan.expiresAt,
        });
        this.keys.push(encrypted[id].key);
        this.forbidden.push(encrypted[id].key.toString("hex"), encrypted[id].key.toString("base64"));
        if (encrypted[id].envelope.metadata.publicKeySha256 !== report.key.publicKeySha256)
          throw new Error("VM public key fingerprint does not match the authenticated ARM receipt.");
      }
      const small = await this.action("small", { envelope: encrypted.small.envelope,
        chunks: encrypted.small.chunks.map((c) => c.toString("base64")) });
      if (small.sha256 !== this.plan.fixtures.small.archiveSha256) throw new Error("Small fixture digest mismatch.");
      report.fixtureResults.push(small);
      await this.action("begin-scale", { envelope: encrypted.scale.envelope });
      for (let i = 0; i < encrypted.scale.chunks.length; i++) {
        const chunk = await this.action("chunk", { index: i, data: encrypted.scale.chunks[i].toString("base64") });
        if (chunk.sha256 !== encrypted.scale.envelope.chunks[i].sha256) throw new Error("Chunk receipt integrity failed.");
      }
      report.duplicateChunk = await this.action("chunk", { index: 0, data: encrypted.scale.chunks[0].toString("base64") });
      if (report.duplicateChunk.status !== "duplicate_chunk") throw new Error("Idempotent duplicate chunk failed.");
      const scale = await this.action("finish-scale");
      if (scale.sha256 !== this.plan.fixtures.scale.archiveSha256) throw new Error("Same-scale fixture digest mismatch.");
      report.fixtureResults.push(scale);
      report.duplicateFinalize = await this.action("finish-scale");
      if (!report.duplicateFinalize.duplicateFinalize) throw new Error("Idempotent finalize failed.");
      report.negative = await this.action("negative");
      if (report.negative.status !== "negative_tests_passed") throw new Error("Negative crypto/scope tests did not pass.");
      report.logAudit = await this.action("audit");
      if (!report.logAudit.completeForVisibleScopes || Object.values(report.logAudit.matches).some((count) => count !== 0))
        throw new Error("Visible log audit is incomplete or found a prohibited value; no real transfer can be proposed as accepted.");
      report.status = "synthetic-probe-passed";
    } catch (error) {
      report.status = this.uncertain ? "uncertain-stop" : "failed";
      report.error = error.message;
    } finally {
      if (initializationAttempted && !this.uncertain) {
        try { report.cleanup = await this.action("cleanup"); }
        catch (error) { report.cleanup = { status: "not-confirmed", error: error.message }; report.status = "cleanup-blocked"; }
      } else report.cleanup = { status: initializationAttempted ? "deferred-until-operation-settles" : "no-key-initialization-attempted" };
      for (const key of this.keys) key.fill(0);
      this.keys.length = 0;
      if (!this.uncertain) {
        for (const name of ["small.synthetic.tar.gz", "scale.synthetic.tar.gz"])
          await rm(path.join(this.directory, "synthetic", name), { force: true });
        await rm(path.join(this.directory, "fixtures.local.json"), { force: true });
        report.localSyntheticPlaintextRemoved = true;
      }
      report.finishedAt = new Date().toISOString();
      await json(path.join(this.directory, "probe-result.json"), report);
    }
    if (report.status !== "synthetic-probe-passed" || report.cleanup?.directoryAbsent !== true)
      throw new Error(`Synthetic probe did not fully pass: ${report.status}. Inspect only the sanitized receipts before any further action.`);
    return report;
  }
}
