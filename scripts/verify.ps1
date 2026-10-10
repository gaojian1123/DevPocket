param(
    [Parameter(Mandatory)][string]$Base,
    [string]$Report,
    [ValidateSet('all', 'backend', 'android', 'device')][string]$Group = 'all',
    [string]$Jdk = $env:DEVPOCKET_JDK,
    [string]$Sdk = $env:DEVPOCKET_ANDROID_SDK,
    [string]$Image = $env:DEVPOCKET_ANDROID_IMAGE,
    [switch]$Plan,
    [switch]$All
)
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'verify.mjs'), '--base', $Base, '--group', $Group)
if ($Report) { $arguments += @('--report', $Report) }
if ($Jdk) { $arguments += @('--jdk', $Jdk) }
if ($Sdk) { $arguments += @('--sdk', $Sdk) }
if ($Image) { $arguments += @('--image', $Image) }
if ($Plan) { $arguments += '--plan' }
if ($All) { $arguments += '--all' }
& node @arguments
exit $LASTEXITCODE
