param([string]$Jdk, [string]$Sdk, [switch]$Lint, [switch]$Instrumentation)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Jdk) { $Jdk = Join-Path $root '.tools\jdk-21' }
if (-not $Sdk) { $Sdk = Join-Path $root '.tools\android-sdk' }
if (-not (Test-Path -LiteralPath (Join-Path $Jdk 'bin\java.exe'))) {
    [Console]::Error.WriteLine('JDK 17 or 21 is required. Pass -Jdk or run prepare-android.ps1 -DownloadJdk.')
    exit 78
}
if (-not (Test-Path -LiteralPath (Join-Path $Sdk 'platforms\android-35\android.jar'))) {
    [Console]::Error.WriteLine('Android SDK platform 35 is missing. Pass -Sdk or run prepare-android.ps1.')
    exit 78
}
$Jdk = (Resolve-Path -LiteralPath $Jdk).ProviderPath
$Sdk = (Resolve-Path -LiteralPath $Sdk).ProviderPath
$env:JAVA_HOME = $Jdk
$env:ANDROID_HOME = $Sdk
$env:GRADLE_USER_HOME = Join-Path $root '.tools\gradle-cache'
Push-Location (Join-Path $root 'android')
try {
    $tasks = @(':app:assembleDebug', ':app:testDebugUnitTest')
    if ($Lint) { $tasks += ':app:lintDebug' }
    if ($Instrumentation) { $tasks += ':app:assembleDebugAndroidTest' }
    & .\gradlew.bat --no-daemon --console=plain @tasks
    if ($LASTEXITCODE -ne 0) { throw "Android build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }
