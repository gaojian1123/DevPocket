param([string]$Jdk, [string]$Sdk, [switch]$Lint, [switch]$Instrumentation, [string]$GradleUserHome)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Jdk) { $Jdk = [IO.Path]::Combine($root, '.tools', 'jdk-21') }
if (-not $Sdk) { $Sdk = [IO.Path]::Combine($root, '.tools', 'android-sdk') }
$javaName = if ($IsWindows) { 'java.exe' } else { 'java' }
if (-not (Test-Path -LiteralPath ([IO.Path]::Combine($Jdk, 'bin', $javaName)))) {
    [Console]::Error.WriteLine('JDK 21 or 25 is required. Pass -Jdk or run prepare-android.ps1 -DownloadJdk.')
    exit 78
}
if (-not (Test-Path -LiteralPath ([IO.Path]::Combine($Sdk, 'platforms', 'android-37.2', 'android.jar')))) {
    [Console]::Error.WriteLine('Android SDK platform 37.2 is missing. Pass -Sdk or run prepare-android.ps1.')
    exit 78
}
$Jdk = (Resolve-Path -LiteralPath $Jdk).ProviderPath
$Sdk = (Resolve-Path -LiteralPath $Sdk).ProviderPath
$GradleUserHome = if ($GradleUserHome) {
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($GradleUserHome)
} else {
    [IO.Path]::Combine($root, '.tools', 'gradle-cache')
}
$previousEnvironment = @{}
foreach ($name in @('JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
Push-Location (Join-Path $root 'android')
try {
    $env:JAVA_HOME = $Jdk
    $env:ANDROID_HOME = $Sdk
    $env:ANDROID_SDK_ROOT = $Sdk
    $env:GRADLE_USER_HOME = $GradleUserHome
    $tasks = @(':app:assembleDebug', ':app:testDebugUnitTest')
    if ($Lint) { $tasks += ':app:lintDebug' }
    if ($Instrumentation) { $tasks += ':app:assembleDebugAndroidTest' }
    if ($IsWindows) {
        & .\gradlew.bat --no-daemon --console=plain @tasks
    } else {
        $wrapper = [IO.Path]::Combine([string[]]@($root, 'android', 'gradle', 'wrapper', 'gradle-wrapper.jar'))
        & ([IO.Path]::Combine($Jdk, 'bin', 'java')) '--enable-native-access=ALL-UNNAMED' '-Dorg.gradle.appname=gradlew' '-classpath' $wrapper `
            'org.gradle.wrapper.GradleWrapperMain' --no-daemon --console=plain @tasks
    }
    if ($LASTEXITCODE -ne 0) { throw "Android build failed with exit code $LASTEXITCODE" }
} finally {
    foreach ($name in $previousEnvironment.Keys) {
        if ($null -eq $previousEnvironment[$name]) {
            Remove-Item -LiteralPath "Env:\$name"
        } else {
            [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
        }
    }
    Pop-Location
}
