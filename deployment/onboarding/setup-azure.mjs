import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { canonical, requireValue } from "./handoff.mjs";

const exec = promisify(execFile);
const uuid = z.guid();
const armOrigin = "https://management.azure.com";
const vmPattern = /^\/subscriptions\/([a-f0-9-]{36})\/resourceGroups\/([A-Za-z0-9_.()-]+)\/providers\/Microsoft\.Compute\/virtualMachines\/([A-Za-z0-9_.-]+)$/i;

export class AzureRequestNotAdmittedError extends Error {
  constructor(code) {
    super(code);
    this.name = "AzureRequestNotAdmittedError";
  }
}

export function vmParts(id) {
  const match = vmPattern.exec(id);
  requireValue(match && uuid.safeParse(match[1]).success, "INVALID_AZURE_VM_ID");
  return { subscriptionId: match[1].toLowerCase(), resourceGroup: match[2], name: match[3],
    groupId: id.slice(0, id.toLowerCase().indexOf("/providers/")) };
}

export async function azdToken(tenantId, run = exec) {
  if (tenantId) uuid.parse(tenantId);
  let result;
  try {
    result = await run(process.platform === "win32" ? "azd.exe" : "azd",
      ["auth", "token", "--scope", `${armOrigin}/.default`, "--output", "json", "--no-prompt",
        ...(tenantId ? ["--tenant-id", tenantId] : [])],
      { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error("AZURE_LOGIN_REQUIRED: Install Azure Developer CLI and run azd auth login for the intended tenant, then rerun setup. No login or account switch was attempted.");
  }
  let token, claims;
  try {
    token = z.object({ token: z.string().min(20) }).parse(JSON.parse(result.stdout)).token;
    claims = z.object({ tid: uuid, oid: uuid, exp: z.number() })
      .parse(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")));
  } catch {
    throw new Error("AZURE_IDENTITY_UNAVAILABLE: azd did not return a usable tenant-scoped ARM token.");
  }
  requireValue(!tenantId || claims.tid.toLowerCase() === tenantId.toLowerCase(), "AZURE_TENANT_MISMATCH");
  requireValue(claims.exp * 1000 > Date.now(), "AZURE_TOKEN_EXPIRED");
  return { token, tenantId: claims.tid.toLowerCase(), principalId: claims.oid.toLowerCase() };
}

export class AzureSetupClient {
  constructor({ getToken = azdToken, fetcher = fetch } = {}) {
    this.getToken = getToken;
    this.fetcher = fetcher;
    this.identity = undefined;
    this.subscriptionId = undefined;
    this.vmId = undefined;
  }

  async selectTenant(tenantId, expectedPrincipal) {
    const token = await this.getToken(tenantId);
    requireValue(!expectedPrincipal || token.principalId === expectedPrincipal, "AZURE_PRINCIPAL_CHANGED");
    this.identity = { tenantId: token.tenantId, principalId: token.principalId };
    return this.identity;
  }

  url(input, subscriptionId = this.subscriptionId) {
    const url = new URL(input, armOrigin);
    requireValue(url.origin === armOrigin && !url.username && !url.password && !url.hash, "ARM_ORIGIN_REJECTED");
    if (subscriptionId) {
      const prefix = `/subscriptions/${subscriptionId}`.toLowerCase(), name = url.pathname.toLowerCase();
      requireValue(name === prefix || name.startsWith(prefix + "/"), "ARM_SUBSCRIPTION_REJECTED");
    } else {
      requireValue(["/tenants", "/subscriptions"].includes(url.pathname.toLowerCase()), "ARM_DISCOVERY_SCOPE");
    }
    return url;
  }

  async arm(input, { method = "GET", body } = {}) {
    let url, request;
    try {
      url = this.url(input);
      requireValue(method === "GET" || (method === "POST" && this.vmId &&
        url.pathname.toLowerCase() === `${this.vmId}/runCommand`.toLowerCase()), "ARM_METHOD_REJECTED");
      const identity = await this.getToken(this.identity?.tenantId);
      if (this.identity) requireValue(identity.tenantId === this.identity.tenantId &&
        identity.principalId === this.identity.principalId, "AZURE_PRINCIPAL_CHANGED");
      request = {
        method, ...(body ? { body: JSON.stringify(body) } : {}),
        headers: { Authorization: `Bearer ${identity.token}`, "Content-Type": "application/json" },
        redirect: "error", signal: AbortSignal.timeout(45_000),
      };
    } catch (error) {
      if (method !== "POST") throw error;
      const code = error instanceof Error ? error.message.match(/^([A-Z][A-Z0-9_]{0,99})(?::|$)/)?.[1] : undefined;
      throw new AzureRequestNotAdmittedError(code ?? "AZURE_REQUEST_PREPARATION_FAILED");
    }
    // Transport and response-reading failures may occur after Azure has admitted the request.
    const response = await this.fetcher(url, request);
    if (method === "POST" && [401, 403].includes(response.status))
      throw new AzureRequestNotAdmittedError(`AZURE_REQUEST_REJECTED_${response.status}`);
    requireValue(response.ok, `AZURE_REQUEST_REJECTED_${response.status}`);
    let value;
    try {
      const text = await response.text();
      requireValue(Buffer.byteLength(text) <= 8 * 1024 * 1024, "ARM_RESPONSE_TOO_LARGE");
      value = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new Error("AZURE_RESPONSE_UNREADABLE");
    }
    return { value, status: response.status, headers: response.headers };
  }

  async list(input) {
    const items = [];
    let next = input;
    for (let page = 0; next && page < 100; page++) {
      const { value } = await this.arm(next);
      requireValue(Array.isArray(value.value), "AZURE_LIST_UNREADABLE");
      items.push(...value.value);
      requireValue(items.length <= 10_000, "AZURE_DISCOVERY_TOO_LARGE");
      next = value.nextLink;
      if (next) this.url(next);
    }
    requireValue(!next, "AZURE_DISCOVERY_TOO_LARGE");
    return items;
  }

  async tenants() {
    await this.selectTenant();
    return (await this.list("/tenants?api-version=2020-01-01"))
      .map((item) => ({ id: uuid.parse(item.tenantId), name: item.displayName || item.tenantId }));
  }

  async subscriptions() {
    requireValue(this.identity, "AZURE_TENANT_REQUIRED");
    return (await this.list("/subscriptions?api-version=2022-12-01"))
      .filter((item) => item.state === "Enabled")
      .map((item) => ({ id: uuid.parse(item.subscriptionId), name: item.displayName || item.subscriptionId }));
  }

  async machines(subscriptionId) {
    this.subscriptionId = uuid.parse(subscriptionId).toLowerCase();
    return (await this.list(`/subscriptions/${this.subscriptionId}/providers/Microsoft.Compute/virtualMachines?api-version=2024-07-01`))
      .filter((item) => item.tags?.application === "DevPocket")
      .map((item) => ({ id: item.id, name: `${item.name} (${vmParts(item.id).resourceGroup})` }));
  }

  async target(vmId) {
    const parts = vmParts(vmId);
    this.subscriptionId = parts.subscriptionId;
    requireValue(this.identity, "AZURE_TENANT_REQUIRED");
    const [vm, group, subscription] = await Promise.all([
      this.arm(`${vmId}?api-version=2024-07-01&$expand=instanceView`),
      this.arm(`${parts.groupId}?api-version=2022-09-01`),
      this.arm(`/subscriptions/${parts.subscriptionId}?api-version=2022-12-01`),
    ]);
    const value = vm.value, tags = value.tags ?? {};
    requireValue(value.id?.toLowerCase() === vmId.toLowerCase() && tags.application === "DevPocket" &&
      uuid.safeParse(tags["devpocket-deployment-id"]).success, "DEVPOCKET_VM_OWNERSHIP_REQUIRED");
    requireValue(group.value.tags?.application === "DevPocket" &&
      group.value.tags?.["devpocket-deployment-id"] === tags["devpocket-deployment-id"] &&
      group.value.tags?.["azd-env-name"] === tags["azd-env-name"], "DEVPOCKET_GROUP_OWNERSHIP_REQUIRED");
    requireValue(subscription.value.state === "Enabled" &&
      subscription.value.tenantId?.toLowerCase() === this.identity.tenantId, "AZURE_SUBSCRIPTION_TENANT_MISMATCH");
    const properties = value.properties;
    requireValue(properties?.storageProfile?.osDisk?.osType === "Linux" &&
      properties.instanceView?.statuses?.some((status) => status.code === "PowerState/running"), "RUNNING_LINUX_RELAY_REQUIRED");
    const disks = properties.storageProfile.dataDisks?.filter((disk) => disk.lun === 0) ?? [];
    requireValue(disks.length === 1 && typeof disks[0].managedDisk?.id === "string", "RELAY_DATA_DISK_REQUIRED");
    this.vmId = value.id;
    return { ...this.identity, vmId: value.id, vmUniqueId: uuid.parse(properties.vmId),
      deploymentId: tags["devpocket-deployment-id"], dataDiskId: disks[0].managedDisk.id,
      subscriptionId: parts.subscriptionId };
  }

  async verify(target) {
    requireValue(canonical(await this.target(target.vmId)) === canonical(target), "SETUP_AZURE_TARGET_CHANGED");
  }
}
