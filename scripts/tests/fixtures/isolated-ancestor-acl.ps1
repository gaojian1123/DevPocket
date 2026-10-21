param(
    [Parameter(Mandatory)][string]$Bootstrap,
    [Parameter(Mandatory)][string]$NativeSource,
    [Parameter(Mandatory)][string]$WorkingDirectory
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
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
public static class DirectorySharingProbe {
    [StructLayout(LayoutKind.Sequential)]
    struct Attributes { public uint attributes, tag; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandleEx(IntPtr file, int kind, out Attributes information, uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static int Open(string path, uint access, uint share, uint flags) {
        var handle=CreateFileW(path,access,share,IntPtr.Zero,3,flags,IntPtr.Zero);
        if(handle==new IntPtr(-1))return Marshal.GetLastWin32Error();
        try {
            Attributes information;
            if(!GetFileInformationByHandleEx(handle,9,out information,8))return Marshal.GetLastWin32Error();
            if((information.attributes & 0x410)!=0x10)throw new Exception("The opened fixture is not a regular directory.");
            return 0;
        } finally { CloseHandle(handle); }
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
# Exercise the production open flags without performing any local ACL write.
$source = Get-Content -LiteralPath $NativeSource -Raw
$calls = [regex]::Matches($source, 'CreateFileW\(path, (0x[0-9a-fA-F]+), ([0-9]+), ref security, 3, (0x[0-9a-fA-F]+), IntPtr\.Zero\)')
if ($calls.Count -ne 1) { throw 'The production ancestor-open parameters were not found.' }
$access = [Convert]::ToUInt32($calls[0].Groups[1].Value.Substring(2), 16)
$share = [uint32]$calls[0].Groups[2].Value
$flags = [Convert]::ToUInt32($calls[0].Groups[3].Value.Substring(2), 16)
$previousDirectory = [Environment]::CurrentDirectory
try {
    [Environment]::CurrentDirectory = $WorkingDirectory
    $errorCode = [DirectorySharingProbe]::Open($WorkingDirectory, $access, $share, $flags)
    if ($errorCode -ne 0) { throw "The production ancestor open conflicts with a working-directory handle: native error $errorCode." }
} finally {
    [Environment]::CurrentDirectory = $previousDirectory
}
ConvertTo-Json -InputObject @([DevPocketIsolatedCommand]::Paths) -Compress
