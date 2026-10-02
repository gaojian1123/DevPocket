$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$directory = Join-Path $root '.tools\bicep'
$version = 'v0.47.16'
$target = Join-Path $directory 'bicep.exe'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/Azure/bicep/releases/tags/$version" `
    -Headers @{ Accept = 'application/vnd.github+json' } -TimeoutSec 60
$asset = @($release.assets | Where-Object { $_.name -eq 'bicep-win-x64.exe' })[0]
if (-not $asset -or $asset.digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'No official SHA-256 digest found; refusing an unverified compiler.' }
if (-not (Test-Path -LiteralPath $target)) {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $target -TimeoutSec 300
}
if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.digest.Substring(7)) {
    throw "Bicep checksum mismatch. Inspect/remove only $target before retrying."
}
& $target --version
if ($LASTEXITCODE -ne 0) { throw 'Local Bicep compiler could not run.' }
$schema = Join-Path $directory 'azd-1.25.5.schema.json'
Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/Azure/azure-dev/5516392dfb9e3e07567ae23e3109f81c33d78606/schemas/v1.0/azure.yaml.json' `
    -OutFile $schema -TimeoutSec 60
Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/Azure/azure-dev/5516392dfb9e3e07567ae23e3109f81c33d78606/cli/azd/extensions/azure.ai.agents/schemas/azure.ai.agent.json' `
    -OutFile (Join-Path $directory 'azd-1.25.5.agent.schema.json') -TimeoutSec 60
Write-Output 'Prepared a verified local compiler only; no global az/azd update, login, subscription change or Azure operation.'
