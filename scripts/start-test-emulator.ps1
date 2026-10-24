[CmdletBinding()]
param(
    [string]$Sdk = $env:DEVPOCKET_ANDROID_SDK,
    [string]$EmulatorSdk = $env:DEVPOCKET_EMULATOR_SDK,
    [string]$Jdk = $env:DEVPOCKET_JDK,
    [string]$Image = $env:DEVPOCKET_ANDROID_IMAGE,
    [string]$RunDirectory,
    [switch]$Visible,
    [ValidateRange(1, 86400)][int]$QueueTimeoutSeconds = 900
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$arguments = @((Join-Path $PSScriptRoot 'manual-emulator.mjs'), 'start', '--repo', $root,
    '--queue-timeout', "$QueueTimeoutSeconds")
if ($Sdk) { $arguments += @('--sdk', $Sdk) }
if ($EmulatorSdk) { $arguments += @('--emulator-sdk', $EmulatorSdk) }
if ($Jdk) { $arguments += @('--jdk', $Jdk) }
if ($Image) { $arguments += @('--image', $Image) }
if ($RunDirectory) { $arguments += @('--directory', $RunDirectory) }
if ($Visible) { $arguments += '--visible' }
& node @arguments
exit $LASTEXITCODE
