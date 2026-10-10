param(
    [string]$Jdk = $env:DEVPOCKET_JDK,
    [string]$Sdk = $env:DEVPOCKET_ANDROID_SDK,
    [string]$Image = $env:DEVPOCKET_ANDROID_IMAGE,
    [string]$EmulatorSdk = $env:DEVPOCKET_EMULATOR_SDK,
    [string]$RunDirectory,
    [string]$Owner,
    [ValidateRange(1, 86400)][int]$QueueTimeoutSeconds = 900,
    [switch]$Layouts
)
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'android-runner.mjs'))
if ($Jdk) { $arguments += @('--jdk', $Jdk) }
if ($Sdk) { $arguments += @('--sdk', $Sdk) }
if ($Image) { $arguments += @('--image', $Image) }
if ($EmulatorSdk) { $arguments += @('--emulator-sdk', $EmulatorSdk) }
if ($RunDirectory) { $arguments += @('--directory', $RunDirectory) }
if ($Owner) { $arguments += @('--owner', $Owner) }
$arguments += @('--queue-timeout', "$QueueTimeoutSeconds")
if ($Layouts) { $arguments += '--layouts' }
& node @arguments
exit $LASTEXITCODE
