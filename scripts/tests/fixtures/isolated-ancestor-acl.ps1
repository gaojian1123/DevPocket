param([Parameter(Mandatory)][string]$Bootstrap)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
public static class DevPocketIsolatedCommand {
    public static readonly List<string> Paths = new List<string>();
    public static void ProtectAncestor(string path, SecurityIdentifier candidate, FileSystemRights mutation) {
        var expected = FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles |
            FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        if (candidate.Value != "S-1-5-21-1-2-3-1001" || mutation != expected)
            throw new Exception("The candidate ancestor deny must retain every mutation right.");
        Paths.Add(path);
    }
}
'@
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Bootstrap, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Bootstrap syntax failed.' }
$definition = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Protect-Ancestors'
}, $true))
if ($definition.Count -ne 1) { throw 'The production ancestor helper was not found.' }
. ([scriptblock]::Create($definition[0].Extent.Text))
function Get-Acl { throw 'Ancestor DACL reads must use the validated directory handle.' }
function Set-Acl { throw 'Ancestor DACL updates must not invoke propagating Set-Acl.' }
$account = @{ SID = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-1001') }
$mutation = [Security.AccessControl.FileSystemRights]'Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
$deny = [Security.AccessControl.AccessControlType]::Deny
Protect-Ancestors 'C:\fixture\candidate'
ConvertTo-Json -InputObject @([DevPocketIsolatedCommand]::Paths) -Compress
