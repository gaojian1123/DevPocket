$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$proof = Get-Content -LiteralPath (Join-Path $root '.data\active-proof.local.json') -Raw | ConvertFrom-Json
if (-not $proof.sessionId -or -not $proof.workspace) { throw 'Start backend\integration\canvas-proof.ts first.' }
[guid]::Parse($proof.sessionId) | Out-Null
$allowed = (Join-Path $root '.data') + [IO.Path]::DirectorySeparatorChar
foreach ($target in @($proof.root, $proof.workspace, $proof.plugin)) {
    if (-not [IO.Path]::GetFullPath($target).StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The proof must stay in this DevPocket folder .data directory.'
    }
}
$names = @('COPILOT_TRAMPOLINE_IDENTIFIER', 'COPILOT_TRAMPOLINE_PORT', 'COPILOT_TRAMPOLINE_TOKEN',
    'COPILOT_AGENT_SESSION_ID', 'AGENCY_SESSION_SUBPROCESS', 'WT_SESSION', 'WT_PROFILE_ID')
$saved = @{}
foreach ($name in ($names + @('COPILOT_AUTO_UPDATE', 'COPILOT_ALLOW_ALL'))) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
Push-Location
try {
    foreach ($name in $names) { Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue }
    $env:COPILOT_AUTO_UPDATE = 'false'
    $env:COPILOT_ALLOW_ALL = 'false'
    Set-Location -LiteralPath $proof.workspace
    copilot --prefer-version 1.0.90-0 --experimental --no-remote --no-remote-export --disable-builtin-mcps `
        --disable-mcp-server workiq --disable-mcp-server devui --mode interactive --name 'DevPocket isolated integration' `
        --session-id $proof.sessionId --plugin-dir $proof.plugin --log-dir (Join-Path $proof.root 'cli-logs') `
        -C $proof.workspace -i "Do not use tools or inspect files. Remember $($proof.marker). Reply only $($proof.marker)_READY."
} finally {
    Pop-Location
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
