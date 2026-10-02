param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$user = $identity.User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if (-not $CheckOnly) {
    if (Test-Path -LiteralPath $Directory) { throw 'PRIVATE_DIRECTORY_ALREADY_EXISTS' }
    New-Item -ItemType Directory -Path $Directory -ErrorAction Stop | Out-Null
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($user, $system)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid, [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Directory -AclObject $acl
}
$item = Get-Item -LiteralPath $Directory
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'PRIVATE_DIRECTORY_LINK' }
$actual = Get-Acl -LiteralPath $Directory
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value -or $rules.Count -ne 2) {
    throw 'PRIVATE_DIRECTORY_ACL'
}
foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -notin @($user.Value, $system.Value) -or
        $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $rule.IsInherited) { throw 'PRIVATE_DIRECTORY_ACL' }
}
@{ protected = $true; ownerSid = $user.Value; allowedSids = @($user.Value, $system.Value) } | ConvertTo-Json -Compress
