targetScope = 'subscription'

@description('Project-local azd environment name. Must begin with devpocket-.')
param environmentName string

@description('Explicitly approved Azure region; never inferred by a script.')
param location string

@description('New isolated resource group, beginning rg-devpocket-.')
param resourceGroupName string

@description('Independent owner UUID. Existing groups with different ownership are refused by the preprovision hook.')
param deploymentId string

@description('Object ID in the explicitly selected tenant, not the email address.')
param deployerObjectId string

@description('Explicitly selected x64 VM size. Standard_B2s is a starting suggestion, not a cost quote.')
param vmSize string

@description('Public RSA SSH key required for VM creation. Port 22 remains closed, management uses ARM Run Command.')
param sshPublicKey string

@description('Non-root VM administrator. SSH remains blocked by the NSG.')
param adminUsername string = 'devpocketadmin'

@allowed(['32', '64', '128', '256'])
param dataDiskGiB string = '32'

@description('Unique independent Azure Public IP DNS label, beginning devpocket-.')
param dnsLabel string

@description('Optional owned DNS name. Empty uses the actual Azure Public IP FQDN output, not a guessed regional suffix.')
param domain string = ''

@description('Public ACME contact email. Not a credential.')
param tlsEmail string

@description('Approved public egress IPv4 for the operator uploading private release artifacts.')
param uploadIpv4 string

var tags = {
  application: 'DevPocket'
  'azd-env-name': environmentName
  'devpocket-deployment-id': deploymentId
}
var nameSuffix = take(replace(deploymentId, '-', ''), 12)

resource group 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module relay './modules/relay.bicep' = {
  name: 'devpocket-infrastructure'
  scope: group
  params: {
    location: location
    tags: tags
    suffix: nameSuffix
    deployerObjectId: deployerObjectId
    vmSize: vmSize
    sshPublicKey: sshPublicKey
    adminUsername: adminUsername
    dataDiskGiB: int(dataDiskGiB)
    dnsLabel: dnsLabel
    uploadIpv4: uploadIpv4
  }
}

output AZURE_RESOURCE_GROUP string = group.name
output DEVPOCKET_VM_ID string = relay.outputs.vmId
output DEVPOCKET_STORAGE_ACCOUNT string = relay.outputs.storageAccountName
output DEVPOCKET_BLOB_ENDPOINT string = relay.outputs.blobEndpoint
output DEVPOCKET_PUBLIC_IP string = relay.outputs.publicIp
output DEVPOCKET_AZURE_FQDN string = relay.outputs.fqdn
output DEVPOCKET_PUBLIC_HOST string = empty(domain) ? relay.outputs.fqdn : domain
output DEVPOCKET_PUBLIC_URL string = 'https://${empty(domain) ? relay.outputs.fqdn : domain}'
output DEVPOCKET_TLS_CONTACT string = tlsEmail
