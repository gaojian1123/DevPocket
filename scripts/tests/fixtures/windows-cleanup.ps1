param(
    [Parameter(Mandatory)][string]$Bootstrap,
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][ValidateSet('none', 'pipe', 'service')][string]$Fault
)
$ErrorActionPreference = 'Stop'
$script:events = [Collections.Generic.List[string]]::new()
$ownerPipe = [pscustomobject]@{ Fault = $Fault }
$ownerPipe | Add-Member ScriptMethod Dispose {
    $script:events.Add('pipe')
    if ($this.Fault -eq 'pipe') { throw [IO.IOException]::new('Synthetic pipe disposal failure.') }
}
$serviceCreated = $true
$serviceName = 'synthetic-not-a-real-service'
$account = @{ SID = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-1001') }
$Control = Join-Path $Root 'controller'
$controlCopy = Join-Path $Root 'copy'
$state = Join-Path $Root 'state'
$source = Join-Path $controlCopy '.data\ci\isolated'
$null = New-Item -ItemType Directory -Path $Control, $source, (Join-Path $state 'launch-private') -Force
[IO.File]::WriteAllText((Join-Path $source 'atomic-launch-capability.json'), '{"acceptance":false}')
[IO.File]::WriteAllText((Join-Path $source 'report.json'), '{"status":"passed","complete":true}')
[IO.File]::WriteAllText((Join-Path $state 'launch-private\service-failure.json'), '{"acceptance":false,"status":"blocked"}')
$identity = Join-Path $Root 'identity.json'
$file = Join-Path $Root 'configuration.json'
$supervisorConfiguration = Join-Path $Root 'supervisor.json'
foreach ($item in @($identity, $file, $supervisorConfiguration)) { [IO.File]::WriteAllText($item, 'synthetic') }
$Group = 'tooling'
$Mode = 'self-test'
$code = 78
function Get-Service {
    [CmdletBinding()]param([string]$Name)
    $script:events.Add('service-read')
    $result = [pscustomobject]@{ Status = [ServiceProcess.ServiceControllerStatus]::Running }
    $result | Add-Member ScriptMethod WaitForStatus { param($Status, $Timeout) $script:events.Add('service-stopped') }
    $result | Add-Member ScriptMethod Dispose { $script:events.Add('service-handle') }
    return $result
}
function Stop-Service {
    [CmdletBinding()]param([string]$Name)
    $script:events.Add('service-stop')
    if ($Fault -eq 'service') { throw [InvalidOperationException]::new('Synthetic service stop failure.') }
}
function Invoke-FakeServiceDelete { $script:events.Add('service-delete'); $global:LASTEXITCODE = 0 }
function Get-CimInstance { param([string]$ClassName, [string]$Filter) return @() }
function Invoke-CimMethod { throw 'The empty fixture process inventory must not invoke a native method.' }
function Remove-LocalUser {
    [CmdletBinding()]param($SID)
    $script:events.Add('account-delete')
}
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Bootstrap, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Bootstrap syntax failed.' }
$main = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
if ($main.Count -ne 1) { throw 'The production cleanup block was not found.' }
$body = $main[0].Finally.Extent.Text
$nativeDelete = '& (Join-Path $env:SystemRoot ''System32\sc.exe'') delete $serviceName'
if (!$body.Contains($nativeDelete)) { throw 'The exact service-deletion call was not found.' }
$body = $body.Replace($nativeDelete, 'Invoke-FakeServiceDelete')
$body = $body.Substring(1, $body.Length - 2)
$failed = $false
try { . ([scriptblock]::Create($body)) } catch { $failed = $true }
$directory = Join-Path $Control '.data\ci\isolated'
$report = Get-Content -LiteralPath (Join-Path $directory 'bootstrap-cleanup.json') -Raw | ConvertFrom-Json
@{
    failed = $failed; events = @($script:events.ToArray()); report = $report
    capabilityCopied = Test-Path -LiteralPath (Join-Path $directory 'atomic-launch-capability.json')
    diagnosticCopied = Test-Path -LiteralPath (Join-Path $directory 'service-failure.json')
    reportCopied = Test-Path -LiteralPath (Join-Path $directory 'report.json')
    credentialsRetained = Test-Path -LiteralPath $identity
} | ConvertTo-Json -Depth 8 -Compress
