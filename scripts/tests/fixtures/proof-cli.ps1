[IO.File]::WriteAllText($env:DP_FAKE_CLI_SNAPSHOT, (@{
    arguments = @($args)
    directory = (Get-Location).Path
    routing = $env:COPILOT_TRAMPOLINE_IDENTIFIER
    terminal = $env:WT_SESSION
    autoUpdate = $env:COPILOT_AUTO_UPDATE
    allowAll = $env:COPILOT_ALLOW_ALL
} | ConvertTo-Json -Depth 4))
$env:WT_SESSION = 'changed-by-fake'
exit ([int]$env:DP_FAKE_CLI_EXIT)
