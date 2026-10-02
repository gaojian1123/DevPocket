import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AzureOperations } from "./cloud.mjs";
import { assertNewIp, permittedChanges, switchParameters, verifyDnsEvidence, resourcePrefix } from "./recovery-plan.mjs";

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lower = (value) => String(value).toLowerCase();
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const net = (resource) => resource.properties;

export class RecoveryOperations extends AzureOperations {
  constructor(plan, baseline, directory) {
    super(plan);
    this.baseline = baseline;
    this.directory = directory;
  }

  parameters(phase) {
    if (phase === "switch-ingress") return switchParameters(this.plan, this.baseline);
    if (phase !== "create-ingress") throw new Error("Unsupported infrastructure recovery phase.");
    return { location: this.plan.target.location, publicIpName: this.plan.names.publicIp, dnsLabel: this.plan.network.dnsLabel,
      tags: { application: "DevPocket", "azd-env-name": this.plan.target.environment,
        "devpocket-deployment-id": this.plan.target.deploymentId, "devpocket-recovery-id": this.plan.recovery.id } };
  }

  async inspect() {
    await this.preflight();
    const read = async (uri) => (await this.arm(this.groupPath + uri)).value;
    const [old, nic, storage, vm] = await Promise.all([
      read(`/providers/Microsoft.Network/publicIPAddresses/${this.plan.recovery.oldPublicIpName}?api-version=2024-05-01`),
      read(`/providers/Microsoft.Network/networkInterfaces/${this.plan.names.nic}?api-version=2024-05-01`),
      read(`/providers/Microsoft.Storage/storageAccounts/${this.plan.names.storageAccount}?api-version=2023-05-01`),
      read(`/providers/Microsoft.Compute/virtualMachines/${this.plan.names.vm}?api-version=2024-07-01`),
    ]);
    if (net(old).ipAddress !== this.plan.recovery.oldIp || !equal(net(old).dnsSettings, this.plan.recovery.oldDnsSettings))
      throw new Error("Retained original Public IP address/scope/label changed. No recovery mutation may proceed.");
    if (vm.identity?.principalId !== this.baseline.vm.identity.principalId ||
        vm.properties.hardwareProfile.vmSize !== this.plan.vm.size ||
        !equal(vm.properties.storageProfile.osDisk, this.baseline.vm.properties.storageProfile.osDisk) ||
        !equal(vm.properties.storageProfile.dataDisks, this.baseline.vm.properties.storageProfile.dataDisks))
      throw new Error("VM identity/size/disks differ from the preserved baseline.");
    const rules = net(storage).networkAcls;
    if (net(storage).allowSharedKeyAccess !== false || net(storage).allowBlobPublicAccess !== false ||
        net(storage).supportsHttpsTrafficOnly !== true || net(storage).minimumTlsVersion !== "TLS1_2" ||
        rules.defaultAction !== "Deny" || rules.bypass !== "None" ||
        rules.ipRules.length !== 1 || (rules.resourceAccessRules?.length ?? 0) || (rules.ipv6Rules?.length ?? 0) ||
        ![this.plan.recovery.previousUploadIpv4, this.plan.network.uploadIpv4].includes(rules.ipRules[0].value))
      throw new Error("Storage firewall/authentication drifted from the original-or-recovery exact single-IP state.");
    const expectedSubnet = `${resourcePrefix(this.plan)}/Microsoft.Network/virtualNetworks/${this.plan.names.network}/subnets/relay`;
    if (rules.virtualNetworkRules.length !== 1 || lower(rules.virtualNetworkRules[0].id) !== lower(expectedSubnet))
      throw new Error("Storage subnet authorization changed.");
    const activeIp = net(nic).ipConfigurations?.[0]?.properties?.publicIPAddress?.id;
    const nextId = `${resourcePrefix(this.plan)}/Microsoft.Network/publicIPAddresses/${this.plan.names.publicIp}`;
    if (![lower(this.plan.recovery.oldPublicIpId), lower(nextId)].includes(lower(activeIp)))
      throw new Error("NIC is attached to an unexpected Public IP.");
    const actualParams = switchParameters(this.plan, { ...this.baseline, nic, storage });
    const expectedParams = switchParameters(this.plan, this.baseline);
    if (!equal(actualParams, expectedParams)) throw new Error("NIC or Storage properties changed beyond the permitted Public IP/rule substitution.");
    return { old, nic, storage, vm, switched: lower(activeIp) === lower(nextId), uploadRuleSwitched: rules.ipRules[0].value === this.plan.network.uploadIpv4 };
  }

  async newPublicIp({ missing = false } = {}) {
    const response = await this.arm(`${this.groupPath}/providers/Microsoft.Network/publicIPAddresses/${this.plan.names.publicIp}?api-version=2024-05-01`, { missing });
    if (!response) return undefined;
    const resource = response.value;
    if (resource.tags?.["devpocket-deployment-id"] !== this.plan.target.deploymentId ||
        resource.tags?.["devpocket-recovery-id"] !== this.plan.recovery.id)
      throw new Error("New Public IP name is occupied by a differently owned resource.");
    assertNewIp(this.plan, resource);
    return resource;
  }

  async checkDns() {
    const resource = await this.newPublicIp();
    const { host, ip } = assertNewIp(this.plan, resource);
    const resolvers = await Promise.all([
      ["Google", "https://dns.google/resolve"],
      ["Cloudflare", "https://cloudflare-dns.com/dns-query"],
    ].map(async ([name, endpoint]) => {
      const response = await fetch(`${endpoint}?name=${encodeURIComponent(host)}&type=A`,
        { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(20_000), redirect: "error" });
      if (!response.ok) throw new Error("Public DNS check failed; no fallback guessed hostname is allowed.");
      const answer = await response.json();
      return { name, status: answer.Status, addresses: (answer.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data) };
    }));
    const evidence = { planHash: this.plan.planHash, at: new Date().toISOString(), resourceId: resource.id,
      etag: resource.etag, host, ip, resolvers };
    await json(path.join(this.directory, "dns-evidence.json"), evidence);
    verifyDnsEvidence(this.plan, resource, evidence);
    return evidence;
  }

  async previewPhase(phase, template) {
    await this.inspect();
    if (phase === "create-ingress") await this.newPublicIp({ missing: true });
    const parameters = Object.fromEntries(Object.entries(this.parameters(phase)).map(([key, value]) => [key, { value }]));
    let response = await this.arm(`${this.groupPath}/providers/Microsoft.Resources/deployments/devpocket-r${this.plan.recovery.id}-${phase}/whatIf?api-version=2022-09-01`, {
      method: "POST", body: { properties: { mode: "Incremental", template, parameters,
        whatIfSettings: { resultFormat: "FullResourcePayloads" } } },
    });
    const location = response.headers.get("location");
    for (let count = 0; response.status === 202 || ["Running", "Accepted"].includes(response.value.status); count++) {
      if (!location || count >= 120) throw new Error("Recovery what-if timed out; no resource change was performed.");
      const url = new URL(location);
      if (url.origin !== "https://management.azure.com") throw new Error("Unexpected ARM polling origin.");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      response = await this.arm(url.pathname + url.search);
    }
    if (response.value.status !== "Succeeded" || !Array.isArray(response.value.properties?.changes))
      throw new Error("Recovery what-if did not succeed; no mutation is permitted.");
    const changes = response.value.properties.changes;
    permittedChanges(this.plan, phase, changes);
    const receipt = { phase, at: new Date().toISOString(), planHash: this.plan.planHash, sourceFingerprint: this.plan.sourceHash,
      changes, dnsGatePassed: false, executionAuthorized: false, template, parameters };
    await json(path.join(this.directory, `what-if-${phase}-${Date.now()}.json`), receipt);
    await json(path.join(this.directory, `what-if-${phase}.json`), receipt);
    return receipt;
  }

  async executePhase(phase, template, authorize) {
    await authorize([phase]);
    await this.inspect();
    const dns = phase === "switch-ingress" ? await this.checkDns() : undefined;
    const preview = await this.previewPhase(phase, template);
    await authorize([phase]);
    if (dns) verifyDnsEvidence(this.plan, await this.newPublicIp(), dns);
    const uri = `${this.groupPath}/providers/Microsoft.Resources/deployments/devpocket-r${this.plan.recovery.id}-${phase}?api-version=2022-09-01`;
    const receipt = { phase, planHash: this.plan.planHash, startedAt: new Date().toISOString(), status: "submitting",
      dns: dns ?? null, deploymentUri: uri };
    await json(path.join(this.directory, `${phase}-execution.json`), receipt);
    try {
      await this.arm(uri, { method: "PUT", body: { properties: { mode: "Incremental", template, parameters: preview.parameters } } });
      for (let count = 0; count < 180; count++) {
        const result = (await this.arm(uri)).value;
        const state = result.properties.provisioningState;
        if (state === "Succeeded") {
          receipt.status = "succeeded";
          receipt.finishedAt = new Date().toISOString();
          await json(path.join(this.directory, `${phase}-execution.json`), receipt);
          if (phase === "create-ingress") await this.newPublicIp();
          else {
            const actual = await this.inspect();
            if (!actual.switched || !actual.uploadRuleSwitched) throw new Error("Successful ARM operation did not establish the expected exact NIC/rule state.");
          }
          return receipt;
        }
        if (["Failed", "Canceled"].includes(state)) throw new Error(`ARM phase ${phase} ended ${state}. Resources were retained; inspect the recorded deployment.`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      throw new Error("ARM recovery wait limit reached. Execution may continue; inspect the recorded deployment before retrying.");
    } catch (error) {
      receipt.status = "failed-or-uncertain";
      receipt.error = error.message;
      await json(path.join(this.directory, `${phase}-execution.json`), receipt);
      throw error;
    }
  }

  async vmContext() {
    let receipt;
    try { receipt = JSON.parse(await readFile(path.join(this.directory, "switch-ingress-execution.json"), "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw new Error("Application packaging/upload/start requires a completed recovery network-switch receipt.");
    }
    if (receipt.planHash !== this.plan.planHash || receipt.status !== "succeeded")
      throw new Error("Application packaging/upload/activation requires this plan's completed network-switch receipt.");
    const actual = await this.inspect();
    if (!actual.switched || !actual.uploadRuleSwitched) throw new Error("NIC and exact upload rule have not switched; application phases are blocked.");
    const dns = await this.checkDns();
    const context = await super.vmContext();
    if (context.host !== dns.host || context.publicIp !== dns.ip) throw new Error("Application endpoint differs from the verified Azure DNS evidence.");
    return context;
  }

  async upload(artifact) {
    await this.vmContext();
    return super.upload(artifact);
  }

  async runVm(phase, config, source) {
    await this.vmContext();
    return super.runVm(phase, config, source);
  }
}
