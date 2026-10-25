param(
    [Parameter(Mandatory)][string]$Base,
    [string]$Report,
    [string]$Resume,
    [string]$Refinement,
    [string]$Promote,
    [string]$CandidateRequest,
    [string]$ToolingShard,
    [ValidateSet('all', 'tooling', 'backend', 'android', 'device')][string]$Group = 'all',
    [string]$Jdk = $env:DEVPOCKET_JDK,
    [string]$Sdk = $env:DEVPOCKET_ANDROID_SDK,
    [string]$Image = $env:DEVPOCKET_ANDROID_IMAGE,
    [switch]$Plan,
    [switch]$All,
    [switch]$BackendDiagnostics
)
$ErrorActionPreference = 'Stop'
if ($Refinement -and ($PSBoundParameters.ContainsKey('Jdk') -or $PSBoundParameters.ContainsKey('Sdk') -or $PSBoundParameters.ContainsKey('Image'))) {
    throw 'Local Apple refinement does not accept Android toolchain options.'
}
$arguments = @((Join-Path $PSScriptRoot 'verify.mjs'), '--base', $Base, '--group', $Group)
if ($Report) { $arguments += @('--report', $Report) }
if ($Resume) { $arguments += @('--resume', $Resume) }
if ($Refinement) { $arguments += @('--refinement', $Refinement) }
if ($Promote) { $arguments += @('--promote', $Promote) }
if ($CandidateRequest) { $arguments += @('--candidate-request', $CandidateRequest) }
if ($ToolingShard) { $arguments += @('--tooling-shard', $ToolingShard) }
if ($Jdk -and -not $Refinement) { $arguments += @('--jdk', $Jdk) }
if ($Sdk -and -not $Refinement) { $arguments += @('--sdk', $Sdk) }
if ($Image -and -not $Refinement) { $arguments += @('--image', $Image) }
if ($Plan) { $arguments += '--plan' }
if ($All) { $arguments += '--all' }
if ($BackendDiagnostics) { $arguments += '--backend-diagnostics' }
& node @arguments
exit $LASTEXITCODE
