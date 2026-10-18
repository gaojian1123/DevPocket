param(
    [Parameter(Mandatory)][string]$Archive,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$Sha256
)
$ErrorActionPreference = 'Stop'
$info = Get-Item -LiteralPath $Archive
if ($info -isnot [IO.FileInfo] -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $info.Length -gt 4194304) {
    throw 'CI evidence archive is not a bounded regular file.'
}
$source = [IO.File]::Open($Archive, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
$archiveBytes = [IO.MemoryStream]::new()
try {
    $chunk = [byte[]]::new(8192)
    while (($count = $source.Read($chunk, 0, $chunk.Length)) -gt 0) {
        if ($archiveBytes.Length + $count -gt 4194304) { throw 'CI evidence archive exceeds its budget.' }
        $archiveBytes.Write($chunk, 0, $count)
    }
    $bytes = $archiveBytes.ToArray()
} finally {
    $source.Dispose()
    $archiveBytes.Dispose()
}
$actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
if ($actual -ne $Sha256) { throw 'CI evidence archive does not match the authenticated artifact digest.' }
$memory = [IO.MemoryStream]::new($bytes, $false)
$archiveFile = [IO.Compression.ZipArchive]::new($memory, [IO.Compression.ZipArchiveMode]::Read)
try {
    $names = @($archiveFile.Entries | ForEach-Object { $_.FullName })
    if ($names.Count -ne 2 -or @($names | Select-Object -Unique).Count -ne 2 -or
        @($names | Where-Object { $_ -cnotin @('gate.json', 'ci-report.json') }).Count) {
        throw 'CI evidence archive has unexpected or duplicate entries.'
    }
    $entry = $archiveFile.GetEntry('ci-report.json')
    if ($entry.Length -gt 1048576) { throw 'CI evidence report exceeds its budget.' }
    $stream = $entry.Open()
    $content = [IO.MemoryStream]::new()
    try {
        $buffer = [byte[]]::new(8192)
        while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($content.Length + $count -gt 1048576) { throw 'CI evidence report exceeds its budget.' }
            $content.Write($buffer, 0, $count)
        }
        [Console]::Out.Write([Text.UTF8Encoding]::new($false, $true).GetString($content.ToArray()))
    } finally {
        $stream.Dispose()
        $content.Dispose()
    }
} finally {
    $archiveFile.Dispose()
    $memory.Dispose()
}
