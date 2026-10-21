param([Parameter(Mandatory)][string]$Request)
$ErrorActionPreference = 'Stop'
if (!$IsWindows -or !([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The isolated command supervisor requires the authorized hosted control identity.'
}
$inputRequest = Get-Content -LiteralPath $Request -Raw | ConvertFrom-Json -AsHashtable
if ($inputRequest.version -ne 1 -or $inputRequest.timeoutMs -le 0 -or $inputRequest.timeoutMs -gt 86400000) {
    throw 'Invalid isolated command request.'
}
$identity = Get-Content -LiteralPath $inputRequest.identity -Raw | ConvertFrom-Json -AsHashtable
Add-Type -Path (Join-Path $PSScriptRoot 'isolated-command.cs')
$owner = [DevPocketIsolatedCommand]::new()
$receipt = @{ version = 1; id = $inputRequest.id; status = 'blocked'; started = $false; processTreeStopped = $false; exitCode = $null }
$code = 78
try {
    $environment = [string[]]@($inputRequest.environment.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
    $code = $owner.Run($identity.user, $identity.password, $identity.sid, $inputRequest.file,
        [string[]]$inputRequest.arguments, $environment, $inputRequest.cwd, $inputRequest.timeoutMs)
    $receipt.status = 'executed'
} finally {
    $receipt.started = $owner.Started
    $receipt.admission = $owner.Admission
    $receipt.interruption = $owner.Interruption
    $receipt.processTreeStopped = $owner.ProcessTreeStopped
    $receipt.exitCode = $owner.ExitCode
    $owner.Dispose()
    $bytes = [Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Compress) + "`n")
    $output = [IO.File]::Open("$Request.result.json", [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $output.Write($bytes); $output.Flush($true) } finally { $output.Dispose() }
}
exit $code
