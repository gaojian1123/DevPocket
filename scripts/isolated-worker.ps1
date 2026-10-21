param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][ValidateSet('tooling', 'backend', 'android', 'device')][string]$Group,
    [ValidateSet('worker', 'self-test')][string]$Mode = 'worker'
)
$ErrorActionPreference = 'Stop'
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Worker bootstrap requires the authorized disposable hosted Windows VM.'
}
$Control = (Resolve-Path -LiteralPath $Control).Path
$Candidate = (Resolve-Path -LiteralPath $Candidate).Path
Set-Location -LiteralPath $Control
$env:NoDefaultCurrentDirectoryInExePath = '1'
$workflow = if ($Mode -eq 'self-test') { '.github/workflows/ci.yml' } else { '.github/workflows/isolated-verification.yml' }
if (!$env:GITHUB_WORKFLOW_REF.Contains("/$workflow@")) { throw 'The selected workflow does not authorize this bootstrap.' }
$tools = @{}
foreach ($name in @('node', 'pwsh', 'git', 'python')) {
    $tools[$name] = (Get-Command $name -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
$head = & $tools.git -C $Control rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $head -ne $env:GITHUB_SHA) { throw 'Control checkout differs from the workflow revision.' }
if ($Mode -eq 'worker') {
    $event = Get-Content -LiteralPath $env:GITHUB_EVENT_PATH -Raw | ConvertFrom-Json
    if ($event.inputs.trusted_sha -ne $head) { throw 'The workflow revision is not the independently approved control.' }
}
$runner = [Security.Principal.WindowsIdentity]::GetCurrent()
if (!([Security.Principal.WindowsPrincipal]$runner).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The authorized hosted control identity is not administrative.'
}
Add-Type -Path (Join-Path $Control 'scripts\isolated-command.cs')
$assignEnabled = [DevPocketIsolatedCommand]::PrepareCreationPrivileges()
$capabilities = @{
    kind = 'isolated-creation-capabilities'; acceptance = $false
    assignPrimaryTokenEnabled = $assignEnabled; increaseQuotaEnabled = $true
    assignability = 'requires-atomic-creation-probe'
}
$capabilityDirectory = Join-Path $Control '.data\ci\isolated'
$null = New-Item -ItemType Directory -Path $capabilityDirectory -Force
$capabilityFile = Join-Path $capabilityDirectory 'bootstrap-capabilities.json'
if (Test-Path -LiteralPath $capabilityFile) { throw 'Creation capability evidence already exists.' }
[IO.File]::WriteAllText($capabilityFile, ($capabilities | ConvertTo-Json -Compress))
$capabilities | ConvertTo-Json -Compress
$name = 'dpw_' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$state = Join-Path ([IO.Path]::GetPathRoot($Control)) $name
if (Test-Path -LiteralPath $state) { throw 'Isolated worker state already exists.' }
$administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$none = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$deny = [Security.AccessControl.AccessControlType]::Deny
$mutation = [Security.AccessControl.FileSystemRights]'Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
$account = $null
$code = 78

function Set-ProtectedDirectory([string]$Path, [bool]$CandidateRead) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($runner.User)
    foreach ($identity in @($administrators, $system, $runner.User)) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inherit, $none, $allow))
    }
    if ($CandidateRead) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account.SID, 'ReadAndExecute', $inherit, $none, $allow))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Protect-Ancestors([string]$Path) {
    $current = [IO.DirectoryInfo]::new($Path).Parent
    while ($null -ne $current) {
        $acl = Get-Acl -LiteralPath $current.FullName
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account.SID, $mutation, $deny))
        Set-Acl -LiteralPath $current.FullName -AclObject $acl
        $current = $current.Parent
    }
}

function Protect-Existing([string]$Path, [bool]$Readable) {
    $acl = Get-Acl -LiteralPath $Path
    $rights = if ($Readable) { $mutation } else { [Security.AccessControl.FileSystemRights]::FullControl }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account.SID, $rights, $inherit, $none, $deny))
    if ($Readable) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account.SID, 'ReadAndExecute', $inherit, $none, $allow))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
    Protect-Ancestors $Path
}

function Copy-Checkout([string]$Source, [string]$Destination) {
    $null = New-Item -ItemType Directory -Path $Destination
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        if ($item.Name -in @('.data', '.tools', 'node_modules')) { continue }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Checkout root contains a reparse point.' }
        Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse
    }
    if (Get-ChildItem -LiteralPath $Destination -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
        throw 'The hosted Windows checkout contains a reparse point.'
    }
}

function Set-CandidateDirectory([string]$Path) {
    Set-ProtectedDirectory $Path $false
    $acl = Get-Acl -LiteralPath $Path
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account.SID, 'ReadAndExecute, Write', $allow))
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account.SID, 'Modify', $inherit,
        [Security.AccessControl.PropagationFlags]::InheritOnly, $allow))
    Set-Acl -LiteralPath $Path -AclObject $acl
    $metadata = Join-Path $Path '.git'
    if (!(Test-Path -LiteralPath $metadata)) { $null = New-Item -ItemType Directory -Path $metadata }
    Set-ProtectedDirectory $metadata $true
}

try {
    $password = 'aA1!' + [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $account = New-LocalUser -Name $name -Password (ConvertTo-SecureString -String $password -AsPlainText -Force) -UserMayNotChangePassword
    Add-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')) -Member $account
    $null = New-Item -ItemType Directory -Path $state
    Set-ProtectedDirectory $state $true
    Protect-Ancestors $state
    $private = Join-Path $state 'private'
    $null = New-Item -ItemType Directory -Path $private
    Set-ProtectedDirectory $private $false
    $controlCopy = Join-Path $state 'control'
    $candidateCopy = Join-Path $state 'candidate'
    Copy-Checkout $Control $controlCopy
    Set-ProtectedDirectory $controlCopy $true
    Copy-Checkout $Candidate $candidateCopy
    Set-CandidateDirectory $candidateCopy
    $fixture = Join-Path $state 'fixture'
    $null = New-Item -ItemType Directory -Path $fixture
    Set-CandidateDirectory $fixture
    $home = Join-Path $state 'home'
    $null = New-Item -ItemType Directory -Path $home
    Set-CandidateDirectory $home
    $temporary = Join-Path $home 'tmp'
    $null = New-Item -ItemType Directory -Path $temporary
    foreach ($path in @($env:USERPROFILE, $env:RUNNER_TEMP, $env:GITHUB_WORKSPACE) | Select-Object -Unique) {
        Protect-Existing $path $false
    }
    foreach ($tool in $tools.Values) {
        Protect-Existing ([IO.Path]::GetDirectoryName($tool)) $true
    }
    if ($env:JAVA_HOME) { Protect-Existing $env:JAVA_HOME $true }
    if ($Group -eq 'android') {
        $sdk = Join-Path $controlCopy '.tools\android-sdk'
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $sdk)
        Move-Item -LiteralPath (Join-Path $Control '.tools\android-sdk') -Destination $sdk
        Protect-Existing $sdk $true
        $env:ANDROID_HOME = $sdk
        $env:ANDROID_SDK_ROOT = $sdk
    }
    $identity = Join-Path $private 'identity.json'
    [IO.File]::WriteAllText($identity, (@{ user = $name; password = $password; sid = $account.SID.Value } | ConvertTo-Json -Compress))
    $password = $null
    $configuration = @{
        version = 1; platform = 'win32'; control = $controlCopy; candidate = $candidateCopy; fixture = $fixture
        private = $private; home = $home; temporary = $temporary; identity = $identity; sid = $account.SID.Value
        tools = $tools; group = $Group; mode = $Mode
        protectedPaths = @($controlCopy, $private, $state, $env:USERPROFILE, $env:RUNNER_TEMP)
    }
    $file = Join-Path $private 'configuration.json'
    [IO.File]::WriteAllText($file, ($configuration | ConvertTo-Json -Depth 8 -Compress))
    $env:NODE_OPTIONS = $null
    $env:NODE_PATH = $null
    $env:NoDefaultCurrentDirectoryInExePath = '1'
    $ownerTemp = Join-Path $private 'owner-temp'
    $null = New-Item -ItemType Directory -Path $ownerTemp
    $env:TEMP = $ownerTemp
    $env:TMP = $ownerTemp
    Push-Location $controlCopy
    try {
        & $tools.node --disable-sigusr1 (Join-Path $controlCopy 'scripts\isolated-worker.mjs') --configuration $file
        $code = $LASTEXITCODE
    } finally { Pop-Location }
} finally {
    if ($account) {
        foreach ($process in Get-CimInstance Win32_Process) {
            $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
            if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $account.SID.Value) {
                throw 'Candidate processes remain; isolated worker cleanup is unconfirmed.'
            }
        }
        Remove-LocalUser -SID $account.SID
    }
    if ($controlCopy) {
        $source = Join-Path $controlCopy '.data\ci\isolated'
        $destination = Join-Path $Control '.data\ci\isolated'
        if (Test-Path -LiteralPath $source) {
            $null = New-Item -ItemType Directory -Path $destination -Force
            foreach ($name in @('report.json', 'isolation-proof.json', 'isolation-negative-report.json', 'bootstrap-failure.json')) {
                $inputFile = Join-Path $source $name
                if (Test-Path -LiteralPath $inputFile) {
                    $item = Get-Item -LiteralPath $inputFile
                    if ($item.Length -gt 1MB -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                        throw 'Invalid isolated worker output.'
                    }
                    $output = [IO.File]::Open((Join-Path $destination $name), [IO.FileMode]::CreateNew)
                    try { $output.Write([IO.File]::ReadAllBytes($inputFile)); $output.Flush($true) } finally { $output.Dispose() }
                }
            }
            if ($code -eq 0 -and $Group -in @('android', 'device') -and $Mode -eq 'worker') {
                $artifacts = Join-Path $destination 'artifacts'
                $null = New-Item -ItemType Directory -Path $artifacts
                foreach ($name in @('app-debug.apk', 'app-debug-androidTest.apk')) {
                    $inputFile = Join-Path $source "artifacts\$name"
                    $item = Get-Item -LiteralPath $inputFile
                    if ($item.Length -gt 256MB -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                        throw 'Invalid isolated build artifact.'
                    }
                    $output = [IO.File]::Open((Join-Path $artifacts $name), [IO.FileMode]::CreateNew)
                    $inputStream = [IO.File]::OpenRead($inputFile)
                    try { $inputStream.CopyTo($output); $output.Flush($true) }
                    finally { $inputStream.Dispose(); $output.Dispose() }
                }
            }
        }
    }
    if ($identity -and (Test-Path -LiteralPath $identity)) { Remove-Item -LiteralPath $identity }
    if ($file -and (Test-Path -LiteralPath $file)) { Remove-Item -LiteralPath $file }
}
exit $code
