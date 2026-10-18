param(
    [Parameter(Mandatory)][string]$Base,
    [string]$Report,
    [string]$Resume,
    [string]$Promote,
    [string]$CandidateRequest,
    [ValidateSet('all', 'tooling', 'backend', 'android', 'device')][string]$Group = 'all',
    [string]$Jdk = $env:DEVPOCKET_JDK,
    [string]$Sdk = $env:DEVPOCKET_ANDROID_SDK,
    [string]$Image = $env:DEVPOCKET_ANDROID_IMAGE,
    [switch]$Plan,
    [switch]$All,
    [switch]$BackendDiagnostics
)
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'verify.mjs'), '--base', $Base, '--group', $Group)
if ($Report) { $arguments += @('--report', $Report) }
if ($Resume) { $arguments += @('--resume', $Resume) }
if ($Promote) { $arguments += @('--promote', $Promote) }
if ($CandidateRequest) { $arguments += @('--candidate-request', $CandidateRequest) }
if ($Jdk) { $arguments += @('--jdk', $Jdk) }
if ($Sdk) { $arguments += @('--sdk', $Sdk) }
if ($Image) { $arguments += @('--image', $Image) }
if ($Plan) { $arguments += '--plan' }
if ($All) { $arguments += '--all' }
if ($BackendDiagnostics) { $arguments += '--backend-diagnostics' }
& node @arguments
exit $LASTEXITCODE
