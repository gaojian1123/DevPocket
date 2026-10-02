param([Parameter(Mandatory = $true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scope = Get-Content -LiteralPath (Join-Path $Directory 'scope.json') -Raw | ConvertFrom-Json
$trial = Get-Content -LiteralPath (Join-Path $Directory 'trial.json') -Raw | ConvertFrom-Json
$paths = Get-Content -LiteralPath (Join-Path $Directory 'local-paths.json') -Raw | ConvertFrom-Json
if ($scope.projectPath -ne $root -or $trial.scopeHash -ne $scope.scopeHash) { throw 'TRIAL_SCOPE' }
[guid]::Parse($trial.sessionId) | Out-Null
if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE ".copilot\session-state\$($trial.sessionId)")) {
    throw 'REFUSING_TO_RESUME_AN_EXISTING_RUNTIME'
}
if (-not (Test-Path -LiteralPath (Join-Path $paths.pluginDirectory 'plugin.json'))) { throw 'OPT_IN_PLUGIN_MISSING' }
$clear = @('COPILOT_TRAMPOLINE_IDENTIFIER', 'COPILOT_TRAMPOLINE_PORT', 'COPILOT_TRAMPOLINE_TOKEN',
    'COPILOT_AGENT_SESSION_ID', 'AGENCY_SESSION_SUBPROCESS', 'WT_SESSION', 'WT_PROFILE_ID')
$saved = @{}
foreach ($name in ($clear + @('COPILOT_AUTO_UPDATE', 'COPILOT_ALLOW_ALL'))) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$terminalSettings = Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json'
$before = if (Test-Path -LiteralPath $terminalSettings) { (Get-FileHash -LiteralPath $terminalSettings -Algorithm SHA256).Hash } else { $null }
$evidence = @{
    scopeHash = $scope.scopeHash; sessionId = $trial.sessionId; launcherPid = $PID
    startedAt = [DateTime]::UtcNow.ToString('o'); cwd = $root; pluginDirectory = $paths.pluginDirectory
    windowsTerminalSettingsSha256 = $before; processOnlyEnvironmentCleared = $clear
    allowAll = $false; cliVersionRequested = '1.0.90-0'; oldSessionResumed = $false
}
$evidence | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Directory 'launch-evidence.json') -Encoding utf8
Push-Location
try {
    foreach ($name in $clear) { Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue }
    $env:COPILOT_AUTO_UPDATE = 'false'
    $env:COPILOT_ALLOW_ALL = 'false'
    Set-Location -LiteralPath $root
    copilot --prefer-version 1.0.90-0 --experimental --no-remote --no-remote-export --disable-builtin-mcps `
        --disable-mcp-server workiq --disable-mcp-server devui --mode interactive --name 'DevPocket cloud trial' `
        --session-id $trial.sessionId --plugin-dir $paths.pluginDirectory --log-dir (Join-Path $Directory 'cli-logs') `
        -C $root -i "This is a dedicated DevPocket connectivity trial. Do not use tools, inspect files, modify this project, or change settings. Remember the initial marker $($trial.marker). Reply only $($trial.marker)_EARLY."
} finally {
    Pop-Location
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
