param(
    [Parameter(Mandatory)][string]$RunDirectory,
    [Parameter(Mandatory)][string]$CliPath,
    [switch]$ConfirmLaunch
)
$ErrorActionPreference = 'Stop'
if (-not $ConfirmLaunch) { throw 'Use -ConfirmLaunch only after authorizing this exact disposable CLI proof.' }
$root = Split-Path -Parent $PSScriptRoot
if (-not [IO.Path]::IsPathFullyQualified($CliPath)) { throw '-CliPath must explicitly select an already-installed CLI by absolute path.' }
$cli = Get-Item -LiteralPath $CliPath
if ($cli.PSIsContainer -or $cli.Extension -notin @('.exe', '.cmd', '.ps1')) {
    throw 'Select an installed .exe, .cmd or .ps1 CLI. No downloads or version selection are performed.'
}
$names = @('COPILOT_TRAMPOLINE_IDENTIFIER', 'COPILOT_TRAMPOLINE_PORT', 'COPILOT_TRAMPOLINE_TOKEN',
    'COPILOT_AGENT_SESSION_ID', 'AGENCY_SESSION_SUBPROCESS', 'WT_SESSION', 'WT_PROFILE_ID')
$saved = @{}
foreach ($name in ($names + @('COPILOT_AUTO_UPDATE', 'COPILOT_ALLOW_ALL'))) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
Push-Location
try {
    Set-Location -LiteralPath $root
    $json = & node --import tsx (Join-Path $root 'backend\integration\canvas-proof.ts') inspect --directory $RunDirectory
    if ($LASTEXITCODE -ne 0) { throw 'The exact proof is unavailable; start a new proof directory, not a replacement runtime.' }
    $proof = $json | ConvertFrom-Json
    $record = @{
        runId = $proof.runId; sessionId = $proof.sessionId; cliPath = $cli.FullName
        cliSha256 = (Get-FileHash -LiteralPath $cli.FullName -Algorithm SHA256).Hash
        launchedAt = [DateTime]::UtcNow.ToString('O'); launcherPid = $PID
    } | ConvertTo-Json
    $file = [IO.File]::Open((Join-Path $proof.root 'launch.json'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($record)
        $file.Write($bytes, 0, $bytes.Length)
    } finally { $file.Dispose() }
    foreach ($name in $names) { Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue }
    $env:COPILOT_AUTO_UPDATE = 'false'
    $env:COPILOT_ALLOW_ALL = 'false'
    Set-Location -LiteralPath $proof.workspace
    $arguments = @('--experimental', '--no-remote', '--no-remote-export', '--disable-builtin-mcps',
        '--disable-mcp-server', 'workiq', '--disable-mcp-server', 'devui', '--mode', 'interactive',
        '--name', 'DevPocket isolated integration', '--session-id', $proof.sessionId,
        '--plugin-dir', $proof.plugin, '--log-dir', (Join-Path $proof.root 'cli-logs'),
        '-C', $proof.workspace, '-i', "Do not use tools or inspect files. Remember $($proof.marker). Reply only $($proof.marker)_READY.")
    & $cli.FullName @arguments
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
exit $code
