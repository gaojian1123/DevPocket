import { sha, REAL_PROTOCOL, REAL_MAX_REQUEST_BYTES, REAL_CHUNK_BYTES } from "./real-archive.mjs";

export const REAL_PHASES = ["real-inspect", "real-key", "real-transfer", "real-authenticate",
  "real-bootstrap", "real-import", "real-build", "real-activate", "real-audit", "real-cleanup"];
export const REAL_ACTIONS = {
  inspect: { phase: "real-inspect", seconds: 30, script: "receiver.py" },
  init: { phase: "real-key", seconds: 30, script: "receiver.py" },
  begin: { phase: "real-transfer", seconds: 30, script: "receiver.py" },
  chunk: { phase: "real-transfer", seconds: 30, script: "receiver.py" },
  authenticate: { phase: "real-authenticate", seconds: 30, script: "receiver.py" },
  "transfer-audit": { phase: "real-audit", seconds: 30, script: "receiver.py" },
  "cleanup-transfer": { phase: "real-cleanup", seconds: 30, script: "receiver.py" },
  bootstrap: { phase: "real-bootstrap", seconds: 1200, script: "control.py" },
  import: { phase: "real-import", seconds: 30, script: "control.py" },
  build: { phase: "real-build", seconds: 1800, script: "control.py" },
  activate: { phase: "real-activate", seconds: 300, script: "control.py" },
  "control-audit": { phase: "real-audit", seconds: 30, script: "control.py" },
};

export function makeRealPlan(recovery, baseline, scope, business, probeAcceptance, sourceHash, transferId) {
  const { planHash, ...original } = recovery;
  if (sha(JSON.stringify(original)) !== planHash || scope.recoveryPlanHash !== planHash)
    throw new Error("RECOVERY_PROVENANCE");
  const vmId = `/subscriptions/${recovery.target.subscriptionId}/resourceGroups/${recovery.target.resourceGroup}/providers/Microsoft.Compute/virtualMachines/${recovery.names.vm}`;
  if (scope.allowedVmId !== vmId || baseline.vm.id.toLowerCase() !== vmId.toLowerCase() ||
      scope.deploymentId !== recovery.target.deploymentId) throw new Error("FIXED_VM_SCOPE");
  if (scope.archiveSha256 !== business.archiveSha256 || scope.archiveBytes !== business.archiveBytes ||
      scope.originSourceHash !== recovery.sourceHash || business.version !== "0.1.0")
    throw new Error("BUSINESS_PROVENANCE");
  if (business.binding.deploymentId !== recovery.target.deploymentId ||
      business.binding.host !== scope.expectedHost || business.binding.tlsEmail !== recovery.network.tlsEmail ||
      business.binding.autostart !== true || recovery.vm.dataDiskGiB !== 32)
    throw new Error("FROZEN_SERVICE_BINDING");
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(scope.expectedPublicIp ?? "")) throw new Error("FIXED_PUBLIC_IP");
  if (probeAcceptance.maxVerifiedRequestBytes !== REAL_MAX_REQUEST_BYTES || !probeAcceptance.guestDirectoryAbsent ||
      Object.values(probeAcceptance.logAudit.matches).some((value) => value !== 0)) throw new Error("ACCEPTED_PROBE_REQUIRED");
  if (!/^[a-f0-9]{64}$/.test(sourceHash) || !/^[a-f0-9-]{36}$/.test(transferId)) throw new Error("REAL_PLAN_FORMAT");
  const plan = {
    schemaVersion: 1, kind: "frozen-real-release", protocol: REAL_PROTOCOL, releaseOperationId: "real-release-001",
    target: recovery.target, names: recovery.names, recovery: recovery.recovery, vm: recovery.vm,
    network: recovery.network, storage: recovery.storage, identity: recovery.identity,
    allowedVmId: vmId, expectedVmIdentity: baseline.vm.identity, expectedStorageProfile: baseline.vm.properties.storageProfile,
    expectedPublicIp: scope.expectedPublicIp,
    transferId, sourceHash,
    business: { ...business, originSourceHash: scope.originSourceHash, originRecoveryPlanHash: recovery.planHash },
    sourceSeparation: "Frozen business archive/origin remain unchanged. sourceHash identifies only the current transport/control implementation and its inputs.",
    probeEvidence: { planHash: probeAcceptance.planHash, sourceHash: probeAcceptance.sourceHash,
      maxMeasuredRequestBytes: probeAcceptance.maxVerifiedRequestBytes, measuredArchiveBytes: probeAcceptance.fixtureResults[1].archiveBytes },
    policy: { maxActionInputBytes: REAL_MAX_REQUEST_BYTES, chunkBytes: REAL_CHUNK_BYTES, maxActions: 24,
      maxOutputBytes: 3200, maxApprovalMinutes: 240, maxArchiveBytes: 65536, phases: REAL_PHASES,
      blobCallsAllowed: false, infrastructureChangesAllowed: false, arbitraryPackageOrVmInputs: false,
      temporaryDirectory: `/var/lib/devpocket-real-transfers/${transferId}`,
      immutableReleaseDirectory: `/srv/devpocket/releases/${business.archiveSha256}`,
      diskBootstrap: "Only explicit real-bootstrap phase: original empty/owned LUN0 32GiB checks, ext4 mount, Docker apt install",
      activation: "Only explicit real-activate phase: original backup/rollback, auto-start, Caddy ACME for frozen hostname",
      phonePairing: "not included", fcm: "not included", oldPublicIpDeletion: "not included" },
    createdAt: new Date().toISOString(), mutationsAuthorized: false,
  };
  return { ...plan, planHash: sha(JSON.stringify(plan)) };
}

export function realWire(plan, expiresAt) {
  return {
    protocol: REAL_PROTOCOL, planHash: plan.planHash, vmId: plan.allowedVmId, transferId: plan.transferId,
    expiresAt, transportSourceHash: plan.sourceHash, dataDiskGiB: plan.vm.dataDiskGiB,
    business: {
      archiveSha256: plan.business.archiveSha256, archiveBytes: plan.business.archiveBytes,
      manifestSha256: plan.business.manifestSha256, controlSha256: plan.business.controlSha256,
      fileCount: plan.business.fileCount, originSourceHash: plan.business.originSourceHash,
    },
    serviceBinding: {
      deploymentId: plan.business.binding.deploymentId, host: plan.business.binding.host,
      tlsEmail: plan.business.binding.tlsEmail, autostart: plan.business.binding.autostart,
    },
  };
}
