param(
    [Parameter(Mandatory)][string]$Base,
    [string]$Report,
    [string]$Resume,
    [string]$Refinement,
    [string]$AppleRequest,
    [string]$AppleEvidence,
    [switch]$CaptureRefinementContext,
    [string]$Promote,
    [string]$CandidateRequest,
    [string]$ToolingShard,
    [ValidateSet('mac', 'iphone', 'ipad', 'duo')][string]$AppleRole,
    [ValidateSet('all', 'tooling', 'backend', 'android', 'device', 'apple')][string]$Group = 'all',
    [string]$Jdk = $env:DEVPOCKET_JDK,
    [string]$Sdk = $env:DEVPOCKET_ANDROID_SDK,
    [string]$Image = $env:DEVPOCKET_ANDROID_IMAGE,
    [switch]$Plan,
    [switch]$All,
    [switch]$BackendDiagnostics
)
$ErrorActionPreference = 'Stop'
if (($Refinement -or $AppleRequest) -and ($PSBoundParameters.ContainsKey('Jdk') -or $PSBoundParameters.ContainsKey('Sdk') -or $PSBoundParameters.ContainsKey('Image'))) {
    throw 'Local Apple evidence collection does not accept Android toolchain options.'
}
$arguments = @((Join-Path $PSScriptRoot 'verify.mjs'), '--base', $Base, '--group', $Group)
if ($Report) { $arguments += @('--report', $Report) }
if ($Resume) { $arguments += @('--resume', $Resume) }
if ($Refinement) { $arguments += @('--refinement', $Refinement) }
if ($AppleRequest) { $arguments += @('--apple-request', $AppleRequest) }
if ($AppleEvidence) { $arguments += @('--apple-evidence', $AppleEvidence) }
if ($CaptureRefinementContext) { $arguments += '--capture-refinement-context' }
if ($Promote) { $arguments += @('--promote', $Promote) }
if ($CandidateRequest) { $arguments += @('--candidate-request', $CandidateRequest) }
if ($ToolingShard) { $arguments += @('--tooling-shard', $ToolingShard) }
if ($PSBoundParameters.ContainsKey('AppleRole')) { $arguments += @('--apple-role', $AppleRole) }
if ($Jdk -and -not ($Refinement -or $AppleRequest)) { $arguments += @('--jdk', $Jdk) }
if ($Sdk -and -not ($Refinement -or $AppleRequest)) { $arguments += @('--sdk', $Sdk) }
if ($Image -and -not ($Refinement -or $AppleRequest)) { $arguments += @('--image', $Image) }
if ($Plan) { $arguments += '--plan' }
if ($All) { $arguments += '--all' }
if ($BackendDiagnostics) { $arguments += '--backend-diagnostics' }
& node @arguments
exit $LASTEXITCODE
