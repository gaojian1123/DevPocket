[CmdletBinding()]
param([string]$OutputDirectory)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') {
    throw 'The package version is not suitable for a versioned extension archive.'
}
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'dist\packages' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
$archive = Join-Path $output "DevPocket-extension-$version.zip"
$checksum = "$archive.sha256"
if ((Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath $checksum)) {
    throw "A package already exists for this version in $output. Choose a new output directory or preserve the existing package before rebuilding."
}
$sources = [ordered]@{
    'devpocket.mjs' = 'dist\devpocket.mjs'
    'extension\extension.mjs' = 'dist\extension\extension.mjs'
    'extension\bridge.mjs' = 'dist\extension\bridge.mjs'
    'README.md' = 'extension\README.md'
}
foreach ($name in @($sources.Values) + @('node_modules\ws\LICENSE', 'node_modules\zod\LICENSE')) {
    $item = Get-Item -LiteralPath (Join-Path $root $name)
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Packaging requires a regular file: $name"
    }
}
New-Item -ItemType Directory -Path $output -Force | Out-Null
$stage = Join-Path $output ('.extension-package-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    foreach ($entry in $sources.GetEnumerator()) {
        $destination = Join-Path $stage $entry.Key
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $root $entry.Value) -Destination $destination
    }
    $notices = "Bundled third-party licenses for DevPocket $version.`nNode.js and the Copilot CLI/SDK are not redistributed.`n"
    foreach ($dependency in @('ws', 'zod')) {
        $license = Get-Content -LiteralPath (Join-Path $root "node_modules\$dependency\LICENSE") -Raw
        $notices += "`n--- $dependency ---`n$license`n"
    }
    Set-Content -LiteralPath (Join-Path $stage 'THIRD-PARTY-NOTICES.txt') -Value $notices -Encoding utf8NoBOM
    $files = foreach ($name in @($sources.Keys) + @('THIRD-PARTY-NOTICES.txt')) {
        $file = Get-Item -LiteralPath (Join-Path $stage $name)
        [ordered]@{
            path = $name.Replace('\', '/')
            bytes = $file.Length
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $manifest = [ordered]@{
        schemaVersion = 1
        name = 'devpocket-extension'
        version = $version
        node = '24.x'
        files = @($files)
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stage 'manifest.json') -Encoding utf8NoBOM
    $temporaryArchive = Join-Path $stage 'package.zip'
    $items = @('devpocket.mjs', 'extension', 'README.md', 'THIRD-PARTY-NOTICES.txt', 'manifest.json') |
        ForEach-Object { Join-Path $stage $_ }
    Compress-Archive -LiteralPath $items -DestinationPath $temporaryArchive -CompressionLevel Optimal
    $digest = (Get-FileHash -LiteralPath $temporaryArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    $temporaryChecksum = Join-Path $stage 'package.sha256'
    Set-Content -LiteralPath $temporaryChecksum -Value "$digest  $([IO.Path]::GetFileName($archive))" -Encoding ascii
    Move-Item -LiteralPath $temporaryArchive -Destination $archive
    Move-Item -LiteralPath $temporaryChecksum -Destination $checksum
    Write-Output "Extension package: $archive"
    Write-Output "SHA-256 file: $checksum"
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force
}
