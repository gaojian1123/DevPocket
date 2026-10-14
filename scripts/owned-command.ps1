$ErrorActionPreference = 'Stop'
$inputStream = [Console]::OpenStandardInput()
$line = [Collections.Generic.List[byte]]::new()
while ($line.Count -le 1048576) {
    $value = $inputStream.ReadByte()
    if ($value -lt 0) { throw 'Owned-command input closed before its request.' }
    if ($value -eq 10) { break }
    $line.Add([byte]$value)
}
if ($line.Count -gt 1048576) { throw 'Owned-command request exceeded its bound.' }
$request = [Text.Encoding]::UTF8.GetString($line.ToArray()) | ConvertFrom-Json
if (-not $request.file -or $request.timeoutMs -le 0 -or $request.timeoutMs -gt 86400000 -or
    $request.graceMs -lt 0 -or $request.graceMs -gt 60000 -or $request.ownerPid -le 0 -or
    $request.deadlineUnixMs -le 0 -or $request.receiptId -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid owned-command request.' }
$deadline = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$request.deadlineUnixMs).UtcDateTime
$buffer = [byte[]]::new(4096)
$pending = $inputStream.ReadAsync($buffer, 0, $buffer.Length)
$owner = [Diagnostics.Process]::GetProcessById([int]$request.ownerPid)
$null = $owner.Handle
$exitCode = 124
$owned = $null
$mutex = $null
$locked = $false
$temporary = $null
$confirmed = $false
function Write-Control([string]$phase) {
    [Console]::Error.Write("$([char]30)DEVPOCKET:$($request.receiptId):$phase$([char]31)")
}
function Test-StartupStopped {
    $cancelLine = $false
    if ($pending.IsCompleted -and $pending.GetAwaiter().GetResult() -gt 0) {
        $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $pending.Result)
        $completeLines = $text.Split("`n")
        for ($index = 0; $index -lt $completeLines.Length - 1; $index++) {
            if ($completeLines[$index].Trim() -eq 'cancel') { $cancelLine = $true; break }
        }
    }
    if ($request.cancelled -or ($pending.IsCompleted -and
        ($pending.GetAwaiter().GetResult() -eq 0 -or $cancelLine))) {
        Write-Control 'cancel-accepted'
        $script:exitCode = 130
        return $true
    }
    if ($owner.HasExited) { $script:exitCode = 125; return $true }
    if ([DateTime]::UtcNow -ge $deadline) {
        Write-Control 'deadline-expired'
        return $true
    }
    return $false
}
function Get-Digest([byte[]]$bytes) {
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Assert-OrdinaryPath([string]$path, [bool]$directory) {
    $item = Get-Item -LiteralPath $path -Force
    if ([bool]$item.PSIsContainer -ne $directory -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked or invalid ownership helper path.' }
}
try {
    if (Test-StartupStopped) { $confirmed = $true; exit $exitCode }
    $sourcePath = Join-Path $PSScriptRoot 'owned-command.cs'
    Assert-OrdinaryPath $sourcePath $false
    $source = [IO.File]::ReadAllBytes($sourcePath)
    if ($source.Length -gt 131072) { throw 'Ownership helper source exceeded its bound.' }
    $sourceHash = Get-Digest $source
    $toolchain = @($PSHOME, $PSVersionTable.PSVersion.ToString(),
        [Runtime.InteropServices.RuntimeInformation]::FrameworkDescription,
        [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString(),
        [object].Assembly.ManifestModule.ModuleVersionId.ToString(),
        [System.Management.Automation.PSObject].Assembly.ManifestModule.ModuleVersionId.ToString()) -join "`n"
    $toolchainHash = Get-Digest ([Text.Encoding]::UTF8.GetBytes($toolchain))
    $key = Get-Digest ([Text.Encoding]::UTF8.GetBytes("$sourceHash`n$toolchainHash"))
    $tools = Join-Path (Split-Path -Parent $PSScriptRoot) '.tools'
    $cache = Join-Path $tools 'command-owner-v1'
    foreach ($directory in @($tools, $cache)) {
        $null = [IO.Directory]::CreateDirectory($directory)
        Assert-OrdinaryPath $directory $true
    }
    $destination = Join-Path $cache $key
    $mutexKey = Get-Digest ([Text.Encoding]::UTF8.GetBytes($destination.ToLowerInvariant()))
    $mutex = [Threading.Mutex]::new($false, "Local\DevPocketCommandOwner_$mutexKey")
    $reportedWaiting = $false
    while (-not $locked) {
        if (Test-StartupStopped) { $confirmed = $true; exit $exitCode }
        try { $locked = $mutex.WaitOne(20) }
        catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked -and -not $reportedWaiting) {
            Write-Control 'preparation-wait'
            $reportedWaiting = $true
        }
    }
    if (-not (Test-Path -LiteralPath $destination)) {
        $temporary = Join-Path $cache ("prepare-" + [Guid]::NewGuid().ToString('N'))
        $null = [IO.Directory]::CreateDirectory($temporary)
        $assemblyPath = Join-Path $temporary 'owner.dll'
        Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString($source)) -OutputAssembly $assemblyPath
        if (Test-StartupStopped) { $confirmed = $true; exit $exitCode }
        if ((Get-Digest ([IO.File]::ReadAllBytes($sourcePath))) -ne $sourceHash) { throw 'Ownership helper source changed during preparation.' }
        $assembly = [IO.File]::ReadAllBytes($assemblyPath)
        $manifest = @{ version = 1; source = $sourceHash; toolchain = $toolchainHash; assembly = (Get-Digest $assembly) }
        [IO.File]::WriteAllText((Join-Path $temporary 'manifest.json'), ($manifest | ConvertTo-Json -Compress))
        [IO.Directory]::Move($temporary, $destination)
        $temporary = $null
    }
    Assert-OrdinaryPath $destination $true
    $manifestPath = Join-Path $destination 'manifest.json'
    $assemblyPath = Join-Path $destination 'owner.dll'
    Assert-OrdinaryPath $manifestPath $false
    Assert-OrdinaryPath $assemblyPath $false
    if ((Get-Item -LiteralPath $manifestPath).Length -gt 4096 -or
        (Get-Item -LiteralPath $assemblyPath).Length -gt 2097152) { throw 'Ownership helper artifact exceeded its bound.' }
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    $assembly = [IO.File]::ReadAllBytes($assemblyPath)
    if ($manifest.version -ne 1 -or $manifest.source -ne $sourceHash -or
        $manifest.toolchain -ne $toolchainHash -or $manifest.assembly -ne (Get-Digest $assembly)) {
        throw 'Ownership helper artifact does not match its source and toolchain.'
    }
    $mutex.ReleaseMutex()
    $locked = $false
    if (Test-StartupStopped) { $confirmed = $true; exit $exitCode }
    Assert-OrdinaryPath $sourcePath $false
    if ((Get-Digest ([IO.File]::ReadAllBytes($sourcePath))) -ne $sourceHash) { throw 'Ownership helper source changed before loading.' }
    $null = [Reflection.Assembly]::Load($assembly)
    $control = [DevPocketCommandInput]::new($inputStream, $buffer, $pending, [bool]$request.cancelled)
    $owned = [DevPocketOwnedCommand]::new($owner, $control, $deadline, [string]$request.receiptId)
    $executable = (Get-Command -Name $request.file -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    if ($owned.Start($executable, [string[]]$request.arguments, (Get-Location).Path)) {
        $exitCode = $owned.Monitor([bool]$request.persistent, [int]$request.graceMs)
    } else { $exitCode = $owned.Interruption }
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
    if ($temporary) {
        foreach ($name in @('owner.dll', 'manifest.json')) {
            $file = Join-Path $temporary $name
            if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
        }
        [IO.Directory]::Delete($temporary)
    }
    try {
        if ($owned) { $owned.StopAndConfirm(); $confirmed = $true }
        if ($confirmed) {
            Write-Control 'tree-stopped'
        }
    } finally {
        if ($owned) { $owned.Dispose() }
        $owner.Dispose()
    }
}
exit $exitCode
