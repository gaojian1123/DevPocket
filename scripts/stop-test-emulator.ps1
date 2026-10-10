[CmdletBinding()]
param([Parameter(Mandatory)][string]$RunDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& node (Join-Path $PSScriptRoot 'manual-emulator.mjs') stop --repo $root --directory $RunDirectory
exit $LASTEXITCODE
