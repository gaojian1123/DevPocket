import { readFile, writeFile, mkdir, readdir, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import { requireApproval } from "./plan.mjs";
import { sourceFingerprint } from "./package.mjs";
import { RecoveryOperations } from "./recovery-cloud.mjs";
import { actionOnce, realResult } from "./real-actions.mjs";
import { REAL_ACTIONS } from "./real-plan.mjs";
import { inspectFrozenArchive, sealFrozenBytes } from "./real-archive.mjs";
import { publicCheck } from "./application.mjs";

const save = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
export class RealRunner {
  constructor(root, directory, plan, baseline, archivePath) {
    this.root = root; this.directory = directory; this.plan = plan; this.baseline = baseline;
    this.archivePath = archivePath;
    this.api = new RecoveryOperations(plan, baseline, directory);
    this.api.upload = async () => { throw new Error("BLOB_CALL_FORBIDDEN"); };
    this.api.runVm = async () => { throw new Error("UNSCOPED_VM_SCRIPT_FORBIDDEN"); };
    this.forbidden = [];
    this.expiresAt = 0;
    this.activeKey = null;
  }

  async authorize(phases) {
    if (await sourceFingerprint(this.root) !== this.plan.sourceHash) throw new Error("REAL_SOURCE_CHANGED");
    let approval;
    try { approval = JSON.parse(await readFile(path.join(this.directory, "approval.local.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const phase of phases) requireApproval(this.plan, approval, phase);
    const expiry = Date.parse(approval.expiresAt);
    const binding = path.join(this.directory, "runtime-binding.local.json");
    let prior;
    try { prior = JSON.parse(await readFile(binding, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (prior) {
      if (prior.planHash !== this.plan.planHash || (prior.expiresAt !== expiry && phases.some((phase) => phase !== "real-cleanup")))
        throw new Error("REAL_APPROVAL_WINDOW_CHANGED: do not reinterpret an existing transfer with another expiry.");
    } else await save(binding, { planHash: this.plan.planHash, expiresAt: expiry });
    this.expiresAt = prior?.expiresAt ?? expiry;
  }

  async verifyTarget() {
    const actual = await this.api.inspect();
    if (actual.vm.id.toLowerCase() !== this.plan.allowedVmId.toLowerCase() ||
        JSON.stringify(actual.vm.identity) !== JSON.stringify(this.plan.expectedVmIdentity) ||
        JSON.stringify(actual.vm.properties.storageProfile) !== JSON.stringify(this.plan.expectedStorageProfile) ||
        !actual.switched || !actual.uploadRuleSwitched) throw new Error("FIXED_TARGET_CHANGED");
    const dns = await this.api.checkDns();
    if (dns.host !== this.plan.business.binding.host || dns.ip !== this.plan.expectedPublicIp)
      throw new Error("APPROVED_PUBLIC_ENDPOINT_CHANGED");
  }

  async action(action, data = {}) {
    if (["build", "activate", "control-audit"].includes(action)) {
      const receipt = JSON.parse(await readFile(path.join(this.directory, "import-success.json"), "utf8")
        .catch(() => { throw new Error("SUCCESSFUL_IMPORT_REQUIRED_BEFORE_BUILD_OR_START"); }));
      if (receipt.planHash !== this.plan.planHash || receipt.result.status !== "release_imported")
        throw new Error("IMPORT_RECEIPT_MISMATCH");
    }
    if (action === "activate") {
      const receipt = JSON.parse(await readFile(path.join(this.directory, "build-success.json"), "utf8")
        .catch(() => { throw new Error("SUCCESSFUL_BUILD_REQUIRED_BEFORE_START"); }));
      if (receipt.planHash !== this.plan.planHash || receipt.result.status !== "image_built") throw new Error("BUILD_RECEIPT_MISMATCH");
    }
    const result = await actionOnce(this, action, data);
    if (action === "inspect" && (!result.targetVerified || result.dependenciesInstalled !== false)) throw new Error("INSPECT_EVIDENCE");
    if (action === "bootstrap" && (!result.ownerVerified || result.dataDiskGiB !== this.plan.vm.dataDiskGiB)) throw new Error("BOOTSTRAP_EVIDENCE");
    if (action === "import" && (result.packageSha256 !== this.plan.business.archiveSha256 ||
        !result.authenticatedLocalArchive || result.blobUsed !== false)) throw new Error("IMPORT_EVIDENCE");
    if (action === "build" && result.blobUsed !== false) throw new Error("BUILD_EVIDENCE");
    if (action === "activate" && (!result.internalHealth || result.autostart !== this.plan.business.binding.autostart))
      throw new Error("ACTIVATION_EVIDENCE");
    await save(path.join(this.directory, `${action}-success.json`), { planHash: this.plan.planHash,
      at: new Date().toISOString(), result });
    return result;
  }

  async run() {
    await this.authorize([...new Set(Object.values(REAL_ACTIONS).map((item) => item.phase))]);
    await writeFile(path.join(this.directory, "run-started.json"), JSON.stringify({ planHash: this.plan.planHash, at: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 });
    const report = { planHash: this.plan.planHash, transportSourceHash: this.plan.sourceHash,
      businessPackageSha256: this.plan.business.archiveSha256, originSourceHash: this.plan.business.originSourceHash,
      status: "running", blobUsed: false, startedAt: new Date().toISOString() };
    let keyAttempted = false, cleaned = false;
    try {
      await this.verifyTarget();
      const checked = await inspectFrozenArchive(this.archivePath, {
        sha256: this.plan.business.archiveSha256, bytes: this.plan.business.archiveBytes,
      });
      if (checked.manifestSha256 !== this.plan.business.manifestSha256) throw new Error("FROZEN_MANIFEST_CHANGED");
      await this.action("inspect");
      keyAttempted = true;
      const pub = await this.action("init");
      if (pub.status !== "recipient_ready" || pub.rsaBits !== 3072 || !pub.rootOnly) throw new Error("RECIPIENT_ATTESTATION");
      const bytes = await readFile(this.archivePath);
      const sealed = sealFrozenBytes(bytes, this.plan.business, pub.publicKeyPem, {
        planHash: this.plan.planHash, vmId: this.plan.allowedVmId, transferId: this.plan.transferId,
        packageSha256: this.plan.business.archiveSha256, manifestSha256: this.plan.business.manifestSha256,
        expiresAt: this.expiresAt, transportSourceHash: this.plan.sourceHash,
      });
      this.activeKey = sealed.key;
      this.forbidden = [sealed.key.toString("base64"), sealed.key.toString("hex"), bytes.toString("base64")];
      if (sealed.envelope.metadata.publicKeySha256 !== pub.publicKeySha256) throw new Error("RECIPIENT_FINGERPRINT");
      await this.action("begin", { envelope: sealed.envelope });
      for (let index = 0; index < sealed.chunks.length; index++)
        await this.action("chunk", { index, data: sealed.chunks[index].toString("base64") });
      const verified = await this.action("authenticate");
      if (verified.sha256 !== this.plan.business.archiveSha256) throw new Error("AUTHENTICATED_PACKAGE_MISMATCH");
      report.authentication = verified;
      report.bootstrap = await this.action("bootstrap");
      report.import = await this.action("import");
      report.transferAudit = await this.action("transfer-audit");
      if (!report.transferAudit.completeForVisibleScope || Object.values(report.transferAudit.matches).some((n) => n !== 0))
        throw new Error("TRANSFER_LOG_AUDIT_FAILED");
      report.transferCleanup = await this.action("cleanup-transfer");
      if (!report.transferCleanup.directoryAbsent) throw new Error("TRANSFER_CLEANUP_NOT_CONFIRMED");
      cleaned = true;
      this.activeKey.fill(0); this.activeKey = null;
      report.build = await this.action("build");
      report.activation = await this.action("activate");
      report.controlAudit = await this.action("control-audit");
      if (!report.controlAudit.completeForVisibleScope || report.controlAudit.skipped || report.controlAudit.sourceFragmentMatches !== 0)
        throw new Error("CONTROL_LOG_AUDIT_FAILED");
      await save(path.join(this.directory, "activation.local.json"), {
        planHash: this.plan.planHash, phase: "real-activate", releaseId: this.plan.business.archiveSha256,
        url: `https://${this.plan.business.binding.host}`, internalHealth: "passed",
        at: new Date().toISOString(), transport: "authenticated-local-archive", blobUsed: false,
      });
      report.status = "internally-active-public-check-required";
    } catch (error) {
      report.status = "failed-or-uncertain";
      report.error = error.message;
    } finally {
      if (this.activeKey) { this.activeKey.fill(0); this.activeKey = null; }
      if (keyAttempted && !cleaned) {
        try {
          await lstat(path.join(this.directory, "action.inflight"));
          report.cleanup = { status: "deferred-until-action-settles" };
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          try { report.cleanup = await this.action("cleanup-transfer"); }
          catch (cleanupError) { report.cleanup = { status: "not-confirmed", error: cleanupError.message }; }
        }
      }
      report.finishedAt = new Date().toISOString();
      await save(path.join(this.directory, "result.json"), report);
    }
    if (report.status !== "internally-active-public-check-required")
      throw new Error("Real release did not complete. Inspect sanitized receipts and actual VM state; do not replay the run.");
    return report;
  }

  async status() {
    const operations = path.join(this.directory, "operations");
    const names = (await readdir(operations)).filter((n) => n.endsWith(".json")).sort();
    if (!names.length) throw new Error("No submitted operation.");
    const file = path.join(operations, names.at(-1));
    const receipt = JSON.parse(await readFile(file, "utf8"));
    if (receipt.vmId !== this.plan.allowedVmId || receipt.planHash !== this.plan.planHash) throw new Error("OPERATION_IDENTITY_MISMATCH");
    const uri = receipt.azureAsyncOperation ?? receipt.resultLocation;
    if (!uri) return { state: receipt.state, operationId: receipt.operationId, postReplayed: false, resultUnknown: true };
    const url = new URL(uri);
    if (url.origin !== "https://management.azure.com") throw new Error("OPERATION_SCOPE");
    const response = await this.api.arm(url.pathname + url.search);
    const state = response.value.status ?? response.status;
    if (state === "Succeeded" && receipt.resultLocation) {
      const resultUrl = new URL(receipt.resultLocation);
      if (resultUrl.origin !== "https://management.azure.com") throw new Error("RESULT_SCOPE");
      const raw = (await this.api.arm(resultUrl.pathname + resultUrl.search)).value;
      try {
        receipt.result = realResult(raw);
        receipt.state = "settled";
        receipt.lastAzureState = state;
        receipt.finishedAt = new Date().toISOString();
        await save(file, receipt);
        await unlink(path.join(this.directory, "action.inflight")).catch((error) => { if (error.code !== "ENOENT") throw error; });
      } catch {
        receipt.lastAzureState = state;
        receipt.state = "uncertain";
        await save(file, receipt);
      }
    }
    const result = { operationId: receipt.operationId, state, executionEvidence: receipt.state, postReplayed: false,
      furtherActionsBlocked: receipt.state !== "settled" };
    await save(path.join(this.directory, "status-read.json"), result);
    return result;
  }

  async publicCheck() { return publicCheck(this); }
}
