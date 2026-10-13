param(
    [string]$Jdk = $env:DEVPOCKET_JDK,
    [string]$Sdk = $env:DEVPOCKET_ANDROID_SDK,
    [string]$Image = $env:DEVPOCKET_ANDROID_IMAGE,
    [string]$EmulatorSdk = $env:DEVPOCKET_EMULATOR_SDK,
    [string]$RunDirectory,
    [string]$Owner,
    [ValidateRange(1, 86400)][int]$QueueTimeoutSeconds = 900,
    [switch]$Layouts,
    [switch]$StartupDiagnostic,
    [string]$Base,
    [ValidateSet('same-build', 'without-build')][string]$Variant = 'same-build'
)
$ErrorActionPreference = 'Stop'
if ($StartupDiagnostic) {
    if (-not $Base -or $Layouts) { throw 'Startup diagnostics require an explicit base and do not run layout acceptance.' }
    $arguments = @((Join-Path $PSScriptRoot 'native-startup.mjs'), '--execute', '--base', $Base, '--variant', $Variant)
} else {
    $arguments = @((Join-Path $PSScriptRoot 'android-runner.mjs'))
}
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
