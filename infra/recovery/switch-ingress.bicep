targetScope = 'resourceGroup'

@description('Only execute this phase after fresh exact-FQDN DNS evidence passes. This template does not create or modify a Public IP.')
param location string
param nicName string
@allowed(['Regular'])
@description('Preserve the provider-returned NIC kind. The published type omits this live field; do not suppress its schema warning.')
param nicKind string
param nicTags object
param nicProperties object
param storageAccountName string
param storageTags object
param storageProperties object

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: nicName
  location: location
  kind: nicKind
  tags: nicTags
  properties: nicProperties
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: storageTags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: storageProperties
}
