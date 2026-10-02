param location string
param tags object
param suffix string
param deployerObjectId string
param vmSize string
param sshPublicKey string
param adminUsername string
param dataDiskGiB int
param dnsLabel string
param uploadIpv4 string

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-devpocket-${suffix}'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'allow-public-http-https'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRanges: ['80', '443']
        }
      }
      {
        name: 'deny-all-other-inbound'
        properties: {
          priority: 200
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-devpocket-${suffix}'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.83.0.0/24'] }
    subnets: [
      {
        name: 'relay'
        properties: {
          addressPrefix: '10.83.0.0/27'
          networkSecurityGroup: { id: nsg.id }
          defaultOutboundAccess: false
          serviceEndpoints: [{ service: 'Microsoft.Storage', locations: [location] }]
        }
      }
    ]
  }
}

resource ip 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: 'pip-devpocket-${suffix}'
  location: location
  tags: tags
  sku: { name: 'Standard', tier: 'Regional' }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    dnsSettings: {
      domainNameLabel: dnsLabel
      domainNameLabelScope: 'ResourceGroupReuse'
    }
    idleTimeoutInMinutes: 4
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: 'nic-devpocket-${suffix}'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [{
      name: 'relay'
      properties: {
        primary: true
        privateIPAllocationMethod: 'Dynamic'
        publicIPAddress: { id: ip.id }
        subnet: { id: '${vnet.id}/subnets/relay' }
      }
    }]
    enableAcceleratedNetworking: false
  }
}

resource dataDisk 'Microsoft.Compute/disks@2024-03-02' = {
  name: 'disk-devpocket-${suffix}'
  location: location
  tags: tags
  sku: { name: 'StandardSSD_LRS' }
  properties: {
    creationData: { createOption: 'Empty' }
    diskSizeGB: dataDiskGiB
    networkAccessPolicy: 'DenyAll'
    publicNetworkAccess: 'Disabled'
  }
}

resource dataLock 'Microsoft.Authorization/locks@2020-05-01' = {
  name: 'devpocket-data-protection'
  scope: dataDisk
  properties: {
    level: 'CanNotDelete'
    notes: 'Contains local SQLite, attachments and Caddy certificates. Back up and explicitly approve removal; azd down is not an authorized cleanup workflow.'
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'vm-devpocket-${suffix}'
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: { vmSize: vmSize }
    osProfile: {
      computerName: 'devpocket-relay'
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        ssh: { publicKeys: [{ path: '/home/${adminUsername}/.ssh/authorized_keys', keyData: sshPublicKey }] }
      }
    }
    storageProfile: {
      imageReference: { publisher: 'Canonical', offer: 'ubuntu-24_04-lts', sku: 'server', version: 'latest' }
      osDisk: {
        name: 'os-devpocket-${suffix}'
        createOption: 'FromImage'
        diskSizeGB: 32
        caching: 'ReadWrite'
        deleteOption: 'Detach'
        managedDisk: { storageAccountType: 'StandardSSD_LRS' }
      }
      dataDisks: [{
        lun: 0
        name: dataDisk.name
        createOption: 'Attach'
        caching: 'None'
        deleteOption: 'Detach'
        managedDisk: { id: dataDisk.id }
      }]
    }
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: { secureBootEnabled: true, vTpmEnabled: true }
    }
    networkProfile: { networkInterfaces: [{ id: nic.id, properties: { primary: true, deleteOption: 'Detach' } }] }
    diagnosticsProfile: { bootDiagnostics: { enabled: true } }
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stdevpocket${suffix}'
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      ipRules: [{ action: 'Allow', value: uploadIpv4 }]
      virtualNetworkRules: [{ action: 'Allow', id: '${vnet.id}/subnets/relay' }]
    }
  }
}

resource blob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  name: 'default'
  parent: storage
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
  }
}

resource releases 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  name: 'releases'
  parent: blob
  properties: { publicAccess: 'None' }
}

resource vmRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(releases.id, vm.id, 'blob-reader')
  scope: releases
  properties: {
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
  }
}

resource operatorUpload 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(releases.id, deployerObjectId, 'blob-contributor')
  scope: releases
  properties: {
    principalId: deployerObjectId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}

resource retention 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  name: 'default'
  parent: storage
  properties: {
    policy: {
      rules: [{
        name: 'remove-expired-release-uploads'
        enabled: true
        type: 'Lifecycle'
        definition: {
          filters: { blobTypes: ['blockBlob'], prefixMatch: ['releases/packages/'] }
          actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 14 } } }
        }
      }]
    }
  }
}

output vmId string = vm.id
output storageAccountName string = storage.name
output blobEndpoint string = storage.properties.primaryEndpoints.blob
output publicIp string = ip.properties.ipAddress
output fqdn string = ip.properties.dnsSettings.fqdn
