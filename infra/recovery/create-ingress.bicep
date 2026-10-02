targetScope = 'resourceGroup'

param location string
param tags object
param publicIpName string
param dnsLabel string

resource ingress 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: publicIpName
  location: location
  tags: tags
  sku: { name: 'Standard', tier: 'Regional' }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    idleTimeoutInMinutes: 4
    dnsSettings: { domainNameLabel: dnsLabel }
  }
}

output newPublicIpId string = ingress.id
output newPublicIp string = ingress.properties.ipAddress
output newFqdn string = ingress.properties.dnsSettings.fqdn
