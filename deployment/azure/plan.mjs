import { createHash } from "node:crypto";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const PHASES = ["preview", "provision", "upload", "deploy", "start", "rollback", "backup"];
const required = (env, name, pattern) => {
  const value = env[name]?.trim();
  if (!value || (pattern && !pattern.test(value))) throw new Error(`Invalid or missing ${name}.`);
  return value;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const domainName = (value) => {
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(value) ||
      !value.includes(".") || value.split(".").some((part) => !part || part.length > 63 || part.startsWith("-") || part.endsWith("-")))
    throw new Error("Invalid public domain name; supply a DNS name, not a URL.");
  return value;
};

export function makePlan(env, sourceHash) {
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("A local source fingerprint is required.");
  const subscriptionId = required(env, "AZURE_SUBSCRIPTION_ID", uuid).toLowerCase();
  const tenantId = required(env, "AZURE_TENANT_ID", uuid).toLowerCase();
  const environment = required(env, "AZURE_ENV_NAME", /^devpocket-[a-z0-9][a-z0-9-]{0,28}$/);
  const resourceGroup = required(env, "AZURE_RESOURCE_GROUP", /^rg-devpocket-[a-z0-9][a-z0-9-]{0,38}$/);
  const location = required(env, "AZURE_LOCATION", /^[a-z][a-z0-9]{2,35}$/);
  const deploymentId = required(env, "DEVPOCKET_DEPLOYMENT_ID", uuid).toLowerCase();
  const principalId = required(env, "DEVPOCKET_DEPLOYER_OBJECT_ID", uuid).toLowerCase();
  const vmSize = required(env, "DEVPOCKET_VM_SIZE", /^Standard_[A-Za-z0-9_]{2,60}$/);
  const dnsLabel = required(env, "DEVPOCKET_DNS_LABEL", /^devpocket-[a-z0-9][a-z0-9-]{0,45}[a-z0-9]$/);
  const email = required(env, "DEVPOCKET_TLS_EMAIL", /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/);
  const uploadIpv4 = required(env, "DEVPOCKET_UPLOAD_IPV4", /^(?:\d{1,3}\.){3}\d{1,3}$/);
  if (uploadIpv4.split(".").some((part) => Number(part) > 255) || /^(0|10|127|169\.254|192\.168)\./.test(uploadIpv4) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(uploadIpv4)) throw new Error("DEVPOCKET_UPLOAD_IPV4 must be the explicitly approved public upload egress IPv4.");
  const sshKey = required(env, "DEVPOCKET_SSH_PUBLIC_KEY", /^ssh-rsa [A-Za-z0-9+/]{300,}={0,3}(?: [^\r\n]+)?$/);
  const dataDiskGiB = Number(env.DEVPOCKET_DATA_DISK_GIB ?? "32");
  if (![32, 64, 128, 256].includes(dataDiskGiB)) throw new Error("DEVPOCKET_DATA_DISK_GIB must be 32, 64, 128 or 256.");
  const customDomain = env.DEVPOCKET_DOMAIN?.trim() || "";
  if (customDomain) domainName(customDomain);
  const vmAutostart = env.DEVPOCKET_VM_AUTOSTART ?? "false";
  if (!["true", "false"].includes(vmAutostart)) throw new Error("DEVPOCKET_VM_AUTOSTART must be true or false.");
  const suffix = deploymentId.replaceAll("-", "").slice(0, 12);
  const names = {
    vm: `vm-devpocket-${suffix}`, network: `vnet-devpocket-${suffix}`, nsg: `nsg-devpocket-${suffix}`,
    nic: `nic-devpocket-${suffix}`, publicIp: `pip-devpocket-${suffix}`, dataDisk: `disk-devpocket-${suffix}`,
    storageAccount: `stdevpocket${suffix}`, container: "releases",
  };
  const plan = {
    schemaVersion: 1,
    target: { environment, subscriptionId, tenantId, resourceGroup, location, deploymentId, deployerObjectId: principalId },
    names,
    vm: { size: vmSize, adminUsername: "devpocketadmin", sshPublicKey: sshKey,
      image: "Canonical:ubuntu-24_04-lts:server:latest", osDiskGiB: 32, dataDiskGiB, diskSku: "StandardSSD_LRS", autostart: vmAutostart === "true" },
    network: { publicPorts: [80, 443], publicSsh: false, dnsLabel, customDomain,
      tlsEmail: email, uploadIpv4, management: "Azure ARM Run Command; no inbound management port" },
    storage: { sqliteLocation: "local-managed-disk", mount: "/srv/devpocket", publicBlobAccess: false,
      sharedKeys: false, artifactAccess: "OAuth + single approved public IPv4 + VM subnet service endpoint",
      diskDeleteLock: true, artifactRetentionDays: 14 },
    identity: { deploymentCredential: "AzureDeveloperCliCredential", explicitTenant: true,
      vmRole: "Storage Blob Data Reader (releases container only)",
      operatorRole: "Storage Blob Data Contributor (releases container only)" },
    sourceHash,
    mutationsAuthorized: false,
  };
  return { ...plan, planHash: digest(JSON.stringify(plan)) };
}

export function requireApproval(plan, approval, phase, now = Date.now()) {
  if (!approval || approval.schemaVersion !== 1) throw new Error(`Explicit local approval is required for ${phase}; no cloud operation was performed.`);
  if (approval.planHash !== plan.planHash) throw new Error("The target or source changed after approval; inspect and approve the new plan.");
  if (!Array.isArray(approval.phases) || !approval.phases.includes(phase)) throw new Error(`Approval does not permit phase ${phase}.`);
  const issued = Date.parse(approval.issuedAt), expires = Date.parse(approval.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || now < issued - 60_000 || now >= expires || expires - issued > 4 * 3600_000)
    throw new Error("Deployment approval is expired, invalid, or exceeds the four-hour maximum.");
}

export function bicepParameters(plan) {
  return {
    environmentName: plan.target.environment, location: plan.target.location, resourceGroupName: plan.target.resourceGroup,
    deploymentId: plan.target.deploymentId,
    deployerObjectId: plan.target.deployerObjectId, vmSize: plan.vm.size, sshPublicKey: plan.vm.sshPublicKey,
    dataDiskGiB: String(plan.vm.dataDiskGiB), dnsLabel: plan.network.dnsLabel, domain: plan.network.customDomain,
    tlsEmail: plan.network.tlsEmail, uploadIpv4: plan.network.uploadIpv4,
  };
}
