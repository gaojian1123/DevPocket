param([string]$Jdk, [string]$Sdk, [switch]$Lint)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Jdk) { $Jdk = Join-Path $root '.tools\jdk-21' }
if (-not $Sdk) { $Sdk = Join-Path $root '.tools\android-sdk' }
if (-not (Test-Path -LiteralPath (Join-Path $Jdk 'bin\java.exe'))) {
    throw 'JDK 17 or 21 is required. Pass -Jdk or run prepare-android.ps1 -DownloadJdk.'
}
if (-not (Test-Path -LiteralPath (Join-Path $Sdk 'platforms\android-35\android.jar'))) {
    throw 'Android SDK platform 35 is missing. Pass -Sdk or run prepare-android.ps1.'
}
$env:JAVA_HOME = $Jdk
$env:ANDROID_HOME = $Sdk
$env:GRADLE_USER_HOME = Join-Path $root '.tools\gradle-cache'
Push-Location (Join-Path $root 'android')
try {
    $tasks = @(':app:assembleDebug', ':app:testDebugUnitTest')
    if ($Lint) { $tasks += ':app:lintDebug' }
    & .\gradlew.bat --no-daemon --console=plain @tasks
    if ($LASTEXITCODE -ne 0) { throw "Android build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }
