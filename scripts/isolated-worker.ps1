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
$serviceCreated = $false
$serviceSid = $null
$ownerPipe = $null
$cngAccess = $null
$code = 78

function Set-ProtectedDirectory([string]$Path, [bool]$CandidateRead, [string]$ServiceRights = 'ReadAndExecute') {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($runner.User)
    foreach ($identity in @($administrators, $system, $runner.User)) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inherit, $none, $allow))
    }
    if ($serviceSid) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($serviceSid, $ServiceRights, $inherit, $none, $allow))
    }
    if ($CandidateRead) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account.SID, 'ReadAndExecute', $inherit, $none, $allow))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Protect-Existing([string]$Path, [bool]$Readable) {
    $acl = Get-Acl -LiteralPath $Path
    $rights = if ($Readable) { $mutation } else { [Security.AccessControl.FileSystemRights]::FullControl }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account.SID, $rights, $inherit, $none, $deny))
    if ($Readable) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account.SID, 'ReadAndExecute', $inherit, $none, $allow))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
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

function Start-IsolatedSupervisor {
    $binaryDirectory = Join-Path $state 'supervisor-bin'
    $null = New-Item -ItemType Directory -Path $binaryDirectory
    Set-ProtectedDirectory $binaryDirectory $true
    $supervisor = Join-Path $binaryDirectory 'supervisor.exe'
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $compiler /nologo /target:exe /reference:System.ServiceProcess.dll /reference:System.Web.Extensions.dll "/out:$supervisor" `
        (Join-Path $Control 'scripts\isolated-command.cs') (Join-Path $Control 'scripts\windows-supervisor.cs') | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'The fixed Windows supervisor did not compile.' }
    if ($Mode -eq 'self-test') {
        $accessText = & $supervisor --cng-access
        if ($LASTEXITCODE -ne 0) { throw 'The read-only CNG diagnostic failed.' }
        $script:cngAccess = ($accessText -join "`n") | ConvertFrom-Json -Depth 5
        if ($cngAccess.kind -ne 'DEBUG-cng-access' -or $cngAccess.acceptance -ne $false) {
            throw 'The read-only CNG diagnostic returned an unexpected shape.'
        }
    }
    $script:serviceName = 'dpws_' + [Guid]::NewGuid().ToString('N').Substring(0, 24)
    $script:supervisorConfiguration = Join-Path $private 'supervisor.json'
    $sc = Join-Path $env:SystemRoot 'System32\sc.exe'
    & $sc create $serviceName 'type=' own 'start=' demand 'obj=' 'NT AUTHORITY\LocalService' 'binPath=' "`"$supervisor`"" | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'The task-scoped LocalService registration failed.' }
    $script:serviceCreated = $true
    & $sc sidtype $serviceName unrestricted | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'The supervisor service SID could not be configured.' }
    & $sc privs $serviceName 'SeAssignPrimaryTokenPrivilege/SeIncreaseQuotaPrivilege' | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'The supervisor privilege list could not be restricted.' }
    & $sc sdset $serviceName "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;$($runner.User.Value))" | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'The supervisor control ACL could not be restricted.' }
    $script:serviceSid = ([Security.Principal.NTAccount]::new("NT SERVICE\$serviceName")).Translate([Security.Principal.SecurityIdentifier])
    Set-ProtectedDirectory $state $true
    Set-ProtectedDirectory $controlCopy $true
    Set-ProtectedDirectory $controlData $false
    Set-ProtectedDirectory $binaryDirectory $true
    Set-ProtectedDirectory $private $false 'Modify'
    foreach ($path in @($candidateCopy, $fixture, $candidateHome)) { Set-CandidateDirectory $path }
    $pipeId = [Guid]::NewGuid().ToString('N')
    $ownerPipeName = "devpocket-$pipeId-owner"
    $nonce = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    $executableRoots = @($controlCopy, $candidateCopy, $fixture, $candidateHome, $binaryDirectory) +
        @($tools.Values | ForEach-Object { Split-Path -Parent $_ })
    if ($env:JAVA_HOME) { $executableRoots += $env:JAVA_HOME }
    $serviceConfiguration = @{
        version = 1; service = $serviceName; serviceSid = $serviceSid.Value; runnerSid = $runner.User.Value; ownerPid = $PID
        ownerPipe = $ownerPipeName; commandPipe = "devpocket-$pipeId-command"; nonce = $nonce
        privateRoot = $private; identity = $identity; mode = 'worker'
        executableSha256 = (Get-FileHash -LiteralPath $supervisor -Algorithm SHA256).Hash.ToLowerInvariant()
        probeNode = $tools.node; probeNodeSha256 = (Get-FileHash -LiteralPath $tools.node -Algorithm SHA256).Hash.ToLowerInvariant()
        probeCwd = $controlCopy
        workingRoots = @($controlCopy, $candidateCopy, $fixture, $candidateHome)
        executableRoots = @($executableRoots | Sort-Object -Unique)
    }
    [IO.File]::WriteAllText($supervisorConfiguration, ($serviceConfiguration | ConvertTo-Json -Depth 8 -Compress))
    $supervisorHash = (Get-FileHash -LiteralPath $supervisorConfiguration -Algorithm SHA256).Hash.ToLowerInvariant()
    & $sc config $serviceName 'binPath=' "`"$supervisor`" --service `"$supervisorConfiguration`" $supervisorHash" | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'The immutable supervisor invocation could not be bound.' }
    $pipeSecurity = [IO.Pipes.PipeSecurity]::new()
    $pipeSecurity.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($runner.User, $serviceSid, $system)) {
        $pipeSecurity.AddAccessRule([IO.Pipes.PipeAccessRule]::new($sid, [IO.Pipes.PipeAccessRights]::FullControl, $allow))
    }
    $script:ownerPipe = [IO.Pipes.NamedPipeServerStreamAcl]::Create($ownerPipeName, [IO.Pipes.PipeDirection]::InOut, 1,
        [IO.Pipes.PipeTransmissionMode]::Byte, ([IO.Pipes.PipeOptions]::Asynchronous -bor [IO.Pipes.PipeOptions]::FirstPipeInstance),
        4096, 4096, $pipeSecurity, [IO.HandleInheritability]::None, [IO.Pipes.PipeAccessRights]::ChangePermissions)
    $connected = $ownerPipe.WaitForConnectionAsync()
    Start-Service -Name $serviceName
    if (!$connected.Wait(30000)) { throw 'The supervisor owner pipe did not become ready.' }
    $hello = [Text.Encoding]::UTF8.GetBytes($nonce + "`n")
    $ownerPipe.Write($hello, 0, $hello.Length)
    $ownerPipe.Flush()
    return @{ file = $supervisor; configuration = $supervisorConfiguration; sha256 = $supervisorHash }
}

try {
    $password = 'aA1!' + [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $account = New-LocalUser -Name $name -Password (ConvertTo-SecureString -String $password -AsPlainText -Force) -UserMayNotChangePassword
    Add-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')) -Member $account
    $null = New-Item -ItemType Directory -Path $state
    Set-ProtectedDirectory $state $true
    $private = Join-Path $state 'launch-private'
    $null = New-Item -ItemType Directory -Path $private
    Set-ProtectedDirectory $private $false
    $controlCopy = Join-Path $state 'control'
    $candidateCopy = Join-Path $state 'candidate'
    Copy-Checkout $Control $controlCopy
    Set-ProtectedDirectory $controlCopy $true
    $controlData = Join-Path $controlCopy '.data'
    $null = New-Item -ItemType Directory -Path $controlData
    Set-ProtectedDirectory $controlData $false
    Copy-Checkout $Candidate $candidateCopy
    Set-CandidateDirectory $candidateCopy
    $fixture = Join-Path $state 'fixture'
    $null = New-Item -ItemType Directory -Path $fixture
    Set-CandidateDirectory $fixture
    $candidateHome = Join-Path $state 'home'
    $null = New-Item -ItemType Directory -Path $candidateHome
    Set-CandidateDirectory $candidateHome
    $temporary = Join-Path $candidateHome 'tmp'
    $null = New-Item -ItemType Directory -Path $temporary
    $broadParent = Join-Path $state 'broad-write-probe'
    $null = New-Item -ItemType Directory -Path $broadParent
    Set-ProtectedDirectory $broadParent $true
    $acl = Get-Acl -LiteralPath $broadParent
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'FullControl', $allow))
    Set-Acl -LiteralPath $broadParent -AclObject $acl
    $broadChild = Join-Path $broadParent 'protected-child'
    $null = New-Item -ItemType Directory -Path $broadChild
    Set-ProtectedDirectory $broadChild $true
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
    $broker = Start-IsolatedSupervisor
    $configuration = @{
        version = 1; platform = 'win32'; control = $controlCopy; candidate = $candidateCopy; fixture = $fixture
        private = $private; home = $candidateHome; temporary = $temporary; identity = $identity; sid = $account.SID.Value
        tools = $tools; group = $Group; mode = $Mode; broker = $broker; desktopProbe = $broker.file
        protectedPaths = @($controlCopy, $controlData, $private, $state, $env:USERPROFILE, $env:RUNNER_TEMP, $broadParent, $broadChild)
        permissionOnlyPaths = @($broadParent, $broadChild)
        protectedReadFiles = @(@('GITHUB_EVENT_PATH', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH', 'GITHUB_STEP_SUMMARY') |
            ForEach-Object { [Environment]::GetEnvironmentVariable($_) } |
            Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Sort-Object -Unique)
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
    $cleanupIssues = [Collections.Generic.List[object]]::new()
    $pipeClosed = !$ownerPipe
    $serviceRemoved = !$serviceCreated
    $accountRemoved = !$account
    try {
        if ($ownerPipe) { $ownerPipe.Dispose() }
        $pipeClosed = $true
    } catch { $cleanupIssues.Add(@{ stage = 'owner-pipe'; error = $_.Exception.GetType().Name }) }
    if ($serviceCreated) {
        try {
            $service = Get-Service -Name $serviceName -ErrorAction Stop
            try {
                if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) { Stop-Service -Name $serviceName -ErrorAction Stop }
                $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(40))
            } finally { $service.Dispose() }
            & (Join-Path $env:SystemRoot 'System32\sc.exe') delete $serviceName
            if ($LASTEXITCODE -ne 0) { throw 'The temporary supervisor service was not deleted.' }
            $deletionDeadline = [DateTime]::UtcNow.AddSeconds(10)
            do {
                $remainingService = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
                if (!$remainingService) { break }
                Start-Sleep -Milliseconds 100
            } while ([DateTime]::UtcNow -lt $deletionDeadline)
            if ($remainingService) { throw 'The temporary supervisor service still exists.' }
            $serviceRemoved = $true
        } catch { $cleanupIssues.Add(@{ stage = 'service'; error = $_.Exception.GetType().Name }) }
    }
    if ($serviceRemoved) {
        try {
            if ($account) {
                foreach ($process in Get-CimInstance Win32_Process) {
                    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
                    if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $account.SID.Value) {
                        throw 'Candidate processes remain; isolated worker cleanup is unconfirmed.'
                    }
                }
                Remove-LocalUser -SID $account.SID
            }
            $accountRemoved = $true
        } catch { $cleanupIssues.Add(@{ stage = 'candidate-account'; error = $_.Exception.GetType().Name }) }
    } elseif ($account) {
        $cleanupIssues.Add(@{ stage = 'candidate-account'; error = 'ServiceCleanupUnconfirmed' })
    }
    try {
        if ($controlCopy) {
            $source = Join-Path $controlCopy '.data\ci\isolated'
            $destination = Join-Path $Control '.data\ci\isolated'
            $null = New-Item -ItemType Directory -Path $destination -Force
            if (Test-Path -LiteralPath $source) {
                foreach ($name in @('report.json', 'isolation-proof.json', 'isolation-negative-report.json',
                    'bootstrap-failure.json', 'atomic-launch-capability.json')) {
                    if ($cleanupIssues.Count -and $name -in @('report.json', 'isolation-proof.json')) { continue }
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
                if (!$cleanupIssues.Count -and $code -eq 0 -and $Group -in @('android', 'device') -and $Mode -eq 'worker') {
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
            foreach ($diagnosticName in @('service-capabilities.json', 'service-failure.json')) {
                $inputFile = Join-Path (Join-Path $state 'launch-private') $diagnosticName
                if (Test-Path -LiteralPath $inputFile) {
                    $item = Get-Item -LiteralPath $inputFile
                    if ($item.Length -gt 64KB -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid supervisor diagnostic.' }
                    $output = [IO.File]::Open((Join-Path $destination $diagnosticName), [IO.FileMode]::CreateNew)
                    try { $output.Write([IO.File]::ReadAllBytes($inputFile)); $output.Flush($true) } finally { $output.Dispose() }
                }
            }
        }
    } catch { $cleanupIssues.Add(@{ stage = 'diagnostic-publication'; error = $_.Exception.GetType().Name }) }
    if ($serviceRemoved -and $accountRemoved) {
        try {
            if ($identity -and (Test-Path -LiteralPath $identity)) { Remove-Item -LiteralPath $identity }
            if ($file -and (Test-Path -LiteralPath $file)) { Remove-Item -LiteralPath $file }
            if ($supervisorConfiguration -and (Test-Path -LiteralPath $supervisorConfiguration)) { Remove-Item -LiteralPath $supervisorConfiguration }
        } catch { $cleanupIssues.Add(@{ stage = 'private-config'; error = $_.Exception.GetType().Name }) }
    }
    $cleanupDirectory = Join-Path $Control '.data\ci\isolated'
    $null = New-Item -ItemType Directory -Path $cleanupDirectory -Force
    $cleanupReport = @{
        version = 1; kind = 'windows-supervisor-cleanup'; acceptance = $false
        status = $(if ($cleanupIssues.Count) { 'blocked' } else { 'completed' })
        ownerPipeClosed = $pipeClosed; serviceRemoved = $serviceRemoved; candidateAccountRemoved = $accountRemoved
        issues = @($cleanupIssues.ToArray())
    }
    if ($cngAccess) { $cleanupReport.cngAccess = $cngAccess }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($cleanupReport | ConvertTo-Json -Depth 5 -Compress) + "`n")
    $output = [IO.File]::Open((Join-Path $cleanupDirectory 'bootstrap-cleanup.json'), [IO.FileMode]::CreateNew)
    try { $output.Write($bytes); $output.Flush($true) } finally { $output.Dispose() }
    if ($cleanupIssues.Count) { throw 'Hosted cleanup remains blocked; inspect bootstrap-cleanup.json.' }
}
exit $code
