import { digest, domainName } from "./plan.mjs";

export const RECOVERY_PHASES = ["preview", "create-ingress", "switch-ingress", "upload", "deploy", "start"];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const normalizedId = (id) => String(id).toLowerCase();
export const resourcePrefix = (plan) =>
  `/subscriptions/${plan.target.subscriptionId}/resourceGroups/${plan.target.resourceGroup}/providers`;

export function makeRecoveryPlan(base, input, baseline, sourceHash) {
  const { planHash: baseHash, ...original } = base;
  if (digest(JSON.stringify(original)) !== baseHash || input.basePlanHash !== baseHash)
    throw new Error("Original plan snapshot does not match its preserved hash.");
  if (!/^\d{3}$/.test(input.recoveryId ?? "") || !/^[a-f0-9]{64}$/.test(sourceHash))
    throw new Error("Recovery requires a numbered directory and a source fingerprint.");
  if (Object.keys(input).some((key) => !["recoveryId", "basePlanHash", "newPublicIpName", "newDnsLabel", "replacementUploadIpv4"].includes(key)))
    throw new Error("Recovery cannot change other parameters, ownership, VM or permissions.");
  const newName = `${base.names.publicIp}-r${input.recoveryId}`;
  if (input.newPublicIpName !== newName || input.newPublicIpName === base.names.publicIp)
    throw new Error("Recovery must use the expected new Public IP resource name; never edit the old scope.");
  if (!/^devpocket-[a-z0-9][a-z0-9-]{0,45}[a-z0-9]$/.test(input.newDnsLabel ?? "") ||
      input.newDnsLabel === base.network.dnsLabel) throw new Error("Choose a new independent DNS label.");
  const ip = input.replacementUploadIpv4;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip ?? "") || ip.split(".").some((part) => Number(part) > 255) ||
      /^(0|10|127|169\.254|192\.168)\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip))
    throw new Error("Replacement must be exactly one approved public IPv4, not a range.");
  if (baseline.oldPublicIp.properties.dnsSettings.domainNameLabelScope !== "ResourceGroupReuse" ||
      baseline.oldPublicIp.properties.dnsSettings.domainNameLabel !== base.network.dnsLabel ||
      baseline.storage.properties.networkAcls.ipRules.length !== 1 ||
      baseline.storage.properties.networkAcls.ipRules[0].value !== base.network.uploadIpv4)
    throw new Error("Preserved baseline differs from the original scoped-IP/single-upload-IP plan.");
  const plan = {
    ...original,
    names: { ...base.names, publicIp: newName },
    network: { ...base.network, dnsLabel: input.newDnsLabel, uploadIpv4: ip, customDomain: "" },
    sourceHash,
    recovery: {
      id: input.recoveryId, basePlanHash: baseHash, originalSourceHash: base.sourceHash,
      baselineHash: digest(JSON.stringify(baseline)),
      oldPublicIpName: base.names.publicIp, oldPublicIpId: baseline.oldPublicIp.id,
      oldIp: baseline.oldPublicIp.properties.ipAddress, oldDnsSettings: baseline.oldPublicIp.properties.dnsSettings,
      previousUploadIpv4: base.network.uploadIpv4,
      newDomainNameLabelScope: null, deleteResources: [],
      phases: ["create-ingress", "check-dns", "switch-ingress", "upload", "deploy", "start", "public-check"],
      dnsEvidenceMaxAgeMinutes: 15, uploadMaxAttempts: 2,
      note: "New and retained old Standard IPv4 coexist and both are charged; no old-IP deletion or data migration is authorized.",
    },
    mutationsAuthorized: false,
  };
  return { ...plan, planHash: digest(JSON.stringify(plan)) };
}

export function assertNewIp(plan, ip) {
  const expected = `${resourcePrefix(plan)}/Microsoft.Network/publicIPAddresses/${plan.names.publicIp}`;
  if (normalizedId(ip.id) !== normalizedId(expected)) throw new Error("New Public IP resource identity is not exact.");
  if (ip.properties?.dnsSettings?.domainNameLabelScope) throw new Error("New ordinary Public IP must not have a scope.");
  if (ip.properties?.dnsSettings?.domainNameLabel !== plan.network.dnsLabel ||
      ip.properties.publicIPAllocationMethod !== "Static" || ip.properties.publicIPAddressVersion !== "IPv4" ||
      ip.sku?.name !== "Standard" || ip.properties.provisioningState !== "Succeeded")
    throw new Error("New Public IP is not in the exact approved completed state.");
  const host = domainName(ip.properties.dnsSettings.fqdn);
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip.properties.ipAddress ?? "")) throw new Error("New IP address is not allocated.");
  return { host, ip: ip.properties.ipAddress };
}

export function verifyDnsEvidence(plan, current, evidence, now = Date.now()) {
  if (current.properties?.dnsSettings?.domainNameLabelScope) throw new Error("Scoped IP cannot pass the ordinary-IP gate.");
  const at = Date.parse(evidence?.at);
  if (!Number.isFinite(at) || at > now + 30000 || now - at > 15 * 60000) throw new Error("DNS evidence is missing or expired.");
  if (evidence.planHash !== plan.planHash || normalizedId(evidence.resourceId) !== normalizedId(current.id) ||
      evidence.etag !== current.etag || evidence.host !== current.properties.dnsSettings.fqdn || evidence.ip !== current.properties.ipAddress)
    throw new Error("DNS evidence must identify the exact current Azure-returned resource, FQDN, address and plan.");
  const resolvers = evidence.resolvers ?? [];
  if (resolvers.length !== 2 || new Set(resolvers.map((r) => r.name)).size !== 2 ||
      resolvers.some((r) => r.status !== 0 || !equal([...new Set(r.addresses)].sort(), [evidence.ip])))
    throw new Error("Both independent public DNS resolvers must return only the exact new A address.");
}

export function permittedChanges(plan, phase, changes) {
  const prefix = resourcePrefix(plan);
  const allowed = phase === "create-ingress"
    ? new Map([[normalizedId(`${prefix}/Microsoft.Network/publicIPAddresses/${plan.names.publicIp}`), ["Create", "NoChange"]]])
    : phase === "switch-ingress" ? new Map([
      [normalizedId(`${prefix}/Microsoft.Network/networkInterfaces/${plan.names.nic}`), ["Modify", "NoChange"]],
      [normalizedId(`${prefix}/Microsoft.Storage/storageAccounts/${plan.names.storageAccount}`), ["Modify", "NoChange"]],
    ]) : new Map();
  for (const change of changes) {
    if (change.changeType === "Ignore") continue;
    if (!allowed.get(normalizedId(change.resourceId))?.includes(change.changeType))
      throw new Error(`What-if ${change.changeType} is outside phase ${phase}; no mutation is permitted.`);
    if (phase === "switch-ingress" && change.changeType === "Modify" && change.delta) {
      const isNic = normalizedId(change.resourceId).endsWith(`/networkinterfaces/${plan.names.nic}`.toLowerCase());
      const permittedPath = isNic ? "properties.ipConfigurations[0].properties.publicIPAddress.id" : "properties.networkAcls.ipRules[0].value";
      const previous = isNic ? plan.recovery.oldPublicIpId : plan.recovery.previousUploadIpv4;
      const next = isNic ? `${prefix}/Microsoft.Network/publicIPAddresses/${plan.names.publicIp}` : plan.network.uploadIpv4;
      const visit = (entry, parent = "") => {
        const current = /^\d+$/.test(entry.path) ? `${parent}[${entry.path}]` : parent ? `${parent}.${entry.path}` : entry.path;
        if (entry.children?.length) { for (const child of entry.children) visit(child, current); return; }
        if (entry.propertyChangeType === "NoEffect") return;
        if (current !== permittedPath || entry.propertyChangeType !== "Modify" ||
            (isNic ? lowerId(entry.before) !== lowerId(previous) || lowerId(entry.after) !== lowerId(next) : entry.before !== previous || entry.after !== next))
          throw new Error(`What-if property change ${current} is outside the exact approved NIC/single-IP replacement.`);
      };
      const lowerId = (id) => String(id).toLowerCase();
      for (const entry of change.delta) visit(entry);
    }
  }
}

export function switchParameters(plan, baseline) {
  const prefix = resourcePrefix(plan);
  const original = baseline.nic.properties;
  if (original.ipConfigurations.length !== 1 || original.ipConfigurations[0].name !== "relay")
    throw new Error("Unexpected NIC shape; refusing to replace multiple configurations.");
  if (baseline.nic.kind !== "Regular" || original.allowPort25Out !== false)
    throw new Error("Unexpected provider-returned NIC kind/SMTP flag; preserve the exact reviewed baseline instead of guessing.");
  const prior = original.ipConfigurations[0].properties;
  const nicProperties = {
    enableAcceleratedNetworking: original.enableAcceleratedNetworking,
    enableIPForwarding: original.enableIPForwarding ?? false,
    disableTcpStateTracking: original.disableTcpStateTracking ?? false,
    auxiliaryMode: original.auxiliaryMode ?? "None",
    auxiliarySku: original.auxiliarySku ?? "None",
    nicType: original.nicType ?? "Standard",
    allowPort25Out: original.allowPort25Out,
    dnsSettings: { dnsServers: original.dnsSettings?.dnsServers ?? [] },
    ipConfigurations: [{
      name: "relay",
      properties: {
        primary: true, privateIPAddress: prior.privateIPAddress, privateIPAddressVersion: prior.privateIPAddressVersion ?? "IPv4",
        privateIPAllocationMethod: prior.privateIPAllocationMethod,
        subnet: { id: prior.subnet?.id ?? `${prefix}/Microsoft.Network/virtualNetworks/${plan.names.network}/subnets/relay` },
        publicIPAddress: { id: `${prefix}/Microsoft.Network/publicIPAddresses/${plan.names.publicIp}` },
      },
    }],
  };
  const properties = baseline.storage.properties;
  const storageProperties = Object.fromEntries([
    "supportsHttpsTrafficOnly", "minimumTlsVersion", "allowBlobPublicAccess", "allowSharedKeyAccess",
    "defaultToOAuthAuthentication", "publicNetworkAccess", "accessTier", "allowCrossTenantReplication",
  ].filter((key) => properties[key] !== undefined).map((key) => [key, properties[key]]));
  storageProperties.networkAcls = {
    bypass: "None", defaultAction: "Deny", ipRules: [{ action: "Allow", value: plan.network.uploadIpv4 }],
    virtualNetworkRules: properties.networkAcls.virtualNetworkRules.map(({ id, action }) => ({ id, action })),
  };
  return {
    location: plan.target.location, nicName: plan.names.nic, nicKind: baseline.nic.kind, nicTags: baseline.nic.tags, nicProperties,
    storageAccountName: plan.names.storageAccount, storageTags: baseline.storage.tags, storageProperties,
  };
}
