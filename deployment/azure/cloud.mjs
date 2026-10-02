import { AzureDeveloperCliCredential } from "@azure/identity";
import { ComputeManagementClient } from "@azure/arm-compute";
import { BlobServiceClient } from "@azure/storage-blob";
import { readFile } from "node:fs/promises";
import { domainName, digest, bicepParameters } from "./plan.mjs";

export class AzureFailure extends Error {
  constructor(status, code = "AzureRequestFailed") {
    super(`Azure operation failed (${status}; ${String(code).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 100)}). No credential or response body is logged.`);
    this.status = status;
  }
}

export function assertOwnedGroup(group, plan) {
  if (group.tags?.application !== "DevPocket" ||
      group.tags?.["devpocket-deployment-id"] !== plan.target.deploymentId ||
      group.tags?.["azd-env-name"] !== plan.target.environment)
    throw new Error("Resource group already exists with different ownership; DevPocket will not adopt or overwrite it.");
  if (group.location?.toLowerCase() !== plan.target.location) throw new Error("Existing resource group location differs from the plan.");
}

export function assertRunResult(result, phase) {
  const output = (result.value ?? []).map((entry) => entry.message ?? "").join("\n");
  const expected = {
    bootstrap: "bootstrap_complete", deploy: "release_prepared", start: "internal_health_passed",
    rollback: "internal_health_passed", backup: "backup_complete",
  }[phase];
  if (!expected || output.includes("DEVPOCKET_PHASE=failed") || !output.includes(`DEVPOCKET_PHASE=${expected}`))
    throw new Error(`VM phase ${phase} did not return its completion evidence. Inspect /var/log/devpocket-operations.log on the VM; HTTP acceptance is not execution success.`);
  return expected;
}

export async function uploadImmutable(blob, artifact, { maxAttempts = 12, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 12) throw new Error("Invalid bounded upload policy.");
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await blob.uploadFile(artifact.file, {
        conditions: { ifNoneMatch: "*" }, metadata: { sha256: artifact.sha256 },
        blobHTTPHeaders: { blobContentType: "application/gzip" },
        abortSignal: AbortSignal.timeout(120_000),
      });
      return blob.url;
    } catch (error) {
      if (error.statusCode === 412 || error.statusCode === 409) {
        const existing = await blob.getProperties({ abortSignal: AbortSignal.timeout(30_000) });
        if (existing.metadata?.sha256 !== artifact.sha256 || existing.contentLength !== artifact.size)
          throw new Error("An immutable artifact already exists with different metadata or size; refusing overwrite.");
        return blob.url;
      }
      if ([403, 408, 429, 500, 502, 503, 504].includes(error.statusCode) && attempt + 1 < maxAttempts) {
        await pause(10_000);
        continue;
      }
      throw new AzureFailure(error.statusCode ?? "network", error.code);
    }
  }
  throw new Error("Bounded private upload attempts exhausted; no IP or identity expansion was attempted.");
}

export class AzureOperations {
  constructor(plan) {
    this.plan = plan;
    this.credential = new AzureDeveloperCliCredential({ tenantId: plan.target.tenantId, processTimeoutInMs: 30_000 });
    this.subscriptionPath = `/subscriptions/${plan.target.subscriptionId}`;
    this.groupPath = `${this.subscriptionPath}/resourceGroups/${plan.target.resourceGroup}`;
    this.vmPath = `${this.groupPath}/providers/Microsoft.Compute/virtualMachines/${plan.names.vm}`;
  }

  async arm(path, { method = "GET", body, missing = false } = {}) {
    const requestPath = new URL(path, "https://management.azure.com").pathname;
    if (!requestPath.startsWith(this.subscriptionPath + "/") && requestPath !== this.subscriptionPath)
      throw new Error("ARM request must remain inside the explicitly selected subscription.");
    const token = await this.credential.getToken("https://management.azure.com/.default");
    const claims = JSON.parse(Buffer.from(token.token.split(".")[1], "base64url").toString());
    if (claims.tid?.toLowerCase() !== this.plan.target.tenantId || claims.oid?.toLowerCase() !== this.plan.target.deployerObjectId)
      throw new Error("The explicitly tenant-scoped azd identity differs from the approved deployment principal. No account was switched.");
    const response = await fetch("https://management.azure.com" + path, {
      method, body: body ? JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(45_000),
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    });
    if (missing && response.status === 404) return undefined;
    const bodyText = await response.text();
    let value = {};
    if (bodyText.trim()) {
      try { value = JSON.parse(bodyText); }
      catch { throw new AzureFailure(response.status, "NonJsonArmResponse"); }
    } else if (![202, 204].includes(response.status) && response.ok) {
      throw new AzureFailure(response.status, "EmptyArmResponse");
    }
    if (!response.ok) throw new AzureFailure(response.status, value.error?.code);
    return { value, headers: response.headers, status: response.status };
  }

  async preflight({ allowMissing = false } = {}) {
    const subscription = (await this.arm(this.subscriptionPath + "?api-version=2022-12-01")).value;
    this.preflightInfo = {
      at: new Date().toISOString(), subscriptionState: subscription.state, subscriptionName: subscription.displayName,
      identity: "explicit tenant and principal matched", providers: {}, resourceGroup: "not-checked", warnings: [],
    };
    if (subscription.state !== "Enabled") throw new Error("The selected subscription is not enabled.");
    for (const provider of ["Microsoft.Compute", "Microsoft.Network", "Microsoft.Storage"]) {
      const result = await this.arm(`${this.subscriptionPath}/providers/${provider}?api-version=2021-04-01`);
      this.preflightInfo.providers[provider] = result.value.registrationState;
    }
    try {
      const roles = await this.arm(`${this.subscriptionPath}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=${encodeURIComponent(`principalId eq '${this.plan.target.deployerObjectId}'`)}`);
      this.preflightInfo.directSubscriptionRoles = (roles.value.value ?? [])
        .filter((role) => role.properties?.scope?.toLowerCase() === this.subscriptionPath.toLowerCase())
        .map((role) => ({ roleDefinitionId: role.properties.roleDefinitionId, condition: role.properties.condition ?? null }));
      this.preflightInfo.warnings.push("Direct role assignments are informational, not a complete effective-permission proof; group membership, conditions and policy still apply. ARM what-if authorizes the actual template.");
    } catch (error) {
      if (!(error instanceof AzureFailure) || error.status !== 403) throw error;
      this.preflightInfo.warnings.push("Direct role-assignment discovery was forbidden. No rights are assumed; ARM what-if/provisioning must independently authorize the template.");
    }
    const group = await this.arm(this.groupPath + "?api-version=2022-09-01", { missing: true });
    this.preflightInfo.resourceGroup = group ? "exists" : "not-found";
    const unavailable = Object.entries(this.preflightInfo.providers).filter(([, state]) => state !== "Registered").map(([name]) => name);
    if (unavailable.length) throw new Error(`${unavailable.join(", ")} not registered. This read-only check did not register any provider; ask the subscription owner.`);
    if (!group) {
      if (!allowMissing) throw new Error("Provision the approved isolated infrastructure first; the resource group does not exist.");
      return { existing: false, subscription: subscription.displayName };
    }
    assertOwnedGroup(group.value, this.plan);
    this.preflightInfo.resourceGroup = "owned-by-this-deployment";
    const resources = (await this.arm(this.groupPath + "/resources?api-version=2021-04-01")).value;
    if (resources.nextLink) throw new Error("Unexpectedly large resource group; manual ownership inspection is required.");
    const allowed = new Set([
      this.plan.names.vm, `os-devpocket-${this.plan.names.vm.slice("vm-devpocket-".length)}`,
      this.plan.names.dataDisk, this.plan.names.nic, this.plan.names.network, this.plan.names.nsg,
      this.plan.names.publicIp, this.plan.names.storageAccount,
      ...(this.plan.recovery ? [this.plan.recovery.oldPublicIpName] : []),
    ]);
    for (const resource of resources.value ?? []) {
      if (resource.type?.toLowerCase() === "microsoft.compute/virtualmachines/extensions" &&
          resource.name === `${this.plan.names.vm}/RunCommandLinux`) continue;
      if (resource.type?.toLowerCase() === "microsoft.compute/disks" &&
          resource.name === `os-devpocket-${this.plan.names.vm.slice("vm-devpocket-".length)}` &&
          !resource.tags?.["devpocket-deployment-id"]) {
        const vm = (await this.arm(this.vmPath + "?api-version=2024-07-01")).value;
        if (vm.tags?.["devpocket-deployment-id"] === this.plan.target.deploymentId &&
            vm.properties?.storageProfile?.osDisk?.managedDisk?.id?.toLowerCase() === resource.id?.toLowerCase()) continue;
      }
      if (!allowed.has(resource.name) || resource.tags?.["devpocket-deployment-id"] !== this.plan.target.deploymentId)
        throw new Error("Existing resource group contains unexpected or differently owned resources. No automatic adoption is allowed.");
    }
    return { existing: true, subscription: subscription.displayName };
  }

  async vmContext() {
    await this.preflight();
    const vm = (await this.arm(this.vmPath + "?api-version=2024-07-01")).value;
    const expectedDisk = `${this.groupPath}/providers/Microsoft.Compute/disks/${this.plan.names.dataDisk}`;
    if (vm.identity?.type !== "SystemAssigned" || vm.tags?.["devpocket-deployment-id"] !== this.plan.target.deploymentId ||
        vm.properties?.storageProfile?.dataDisks?.find((disk) => disk.lun === 0)?.managedDisk?.id?.toLowerCase() !== expectedDisk.toLowerCase())
      throw new Error("VM identity, ownership, or persistent data disk does not match the approved plan.");
    const ip = (await this.arm(`${this.groupPath}/providers/Microsoft.Network/publicIPAddresses/${this.plan.names.publicIp}?api-version=2024-05-01`)).value;
    const fqdn = domainName(ip.properties?.dnsSettings?.fqdn ?? "");
    return {
      deploymentId: this.plan.target.deploymentId, host: this.plan.network.customDomain || fqdn,
      azureFqdn: fqdn, publicIp: ip.properties.ipAddress,
      tlsEmail: this.plan.network.tlsEmail, dataDiskGiB: this.plan.vm.dataDiskGiB,
      storageAccount: this.plan.names.storageAccount, autostart: this.plan.vm.autostart,
    };
  }

  async preview(template) {
    await this.preflight({ allowMissing: true });
    const name = "devpocket-preview-" + this.plan.names.vm.slice("vm-devpocket-".length);
    const parameters = Object.fromEntries(Object.entries(bicepParameters(this.plan)).map(([key, value]) => [key, { value }]));
    let response = await this.arm(`${this.subscriptionPath}/providers/Microsoft.Resources/deployments/${name}/whatIf?api-version=2022-09-01`, {
      method: "POST", body: { location: this.plan.target.location, properties: {
        mode: "Incremental", template, parameters, whatIfSettings: { resultFormat: "ResourceIdOnly" },
      } },
    });
    const location = response.headers.get("location");
    for (let attempt = 0; response.status === 202 || ["Running", "Accepted"].includes(response.value.status); attempt++) {
      if (!location || attempt >= 120) throw new Error("ARM what-if timed out or returned no polling URL. No provisioning was performed.");
      const url = new URL(location);
      if (url.origin !== "https://management.azure.com") throw new Error("Unexpected ARM polling origin.");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      response = await this.arm(url.pathname + url.search);
    }
    if (response.value.status !== "Succeeded" || !Array.isArray(response.value.properties?.changes))
      throw new Error("ARM what-if did not complete successfully. No provisioning was performed.");
    return response.value.properties.changes.map(({ resourceId, changeType }) => ({ resourceId, changeType }));
  }

  async upload(artifact) {
    await this.preflight();
    if (digest(await readFile(artifact.file)) !== artifact.sha256) throw new Error("Local package changed after its hash was approved.");
    const service = new BlobServiceClient(`https://${this.plan.names.storageAccount}.blob.core.windows.net`, this.credential,
      { retryOptions: { maxTries: this.plan.recovery ? 1 : 3, tryTimeoutInMs: 60_000 } });
    const blob = service.getContainerClient("releases").getBlockBlobClient(`packages/${artifact.sha256}.tar.gz`);
    return uploadImmutable(blob, artifact, { maxAttempts: this.plan.recovery ? 2 : 12 });
  }

  async runVm(phase, config, source) {
    const encoded = Buffer.from(JSON.stringify({ ...config, phase })).toString("base64");
    const body = source.replace("__DEVPOCKET_PAYLOAD__", encoded);
    if (body.includes("__DEVPOCKET_PAYLOAD__") || !source.includes("__DEVPOCKET_PAYLOAD__"))
      throw new Error("Invalid VM operation template.");
    const compute = new ComputeManagementClient(this.credential, this.plan.target.subscriptionId, {
      retryOptions: { maxRetries: 0 },
    });
    let result;
    try {
      result = await compute.virtualMachines.beginRunCommandAndWait(this.plan.target.resourceGroup, this.plan.names.vm,
        { commandId: "RunShellScript", script: ["#!/bin/sh", "set -eu", "umask 077", "python3 - <<'DEVPOCKET_PYTHON'", body, "DEVPOCKET_PYTHON"] },
        { abortSignal: AbortSignal.timeout(40 * 60_000), updateIntervalInMs: 5000 });
    } catch (error) {
      throw new Error(`VM ${phase} response failed or timed out (${String(error.code ?? error.name).replace(/[^A-Za-z0-9_.-]/g, "")}). Execution may still be running; inspect it before retrying. No automatic Run Command resubmission.`);
    }
    return assertRunResult(result, phase);
  }
}
