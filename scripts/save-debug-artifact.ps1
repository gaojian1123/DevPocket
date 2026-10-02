param([Parameter(Mandatory)][ValidatePattern('^[0-9]{3}$')][string]$BuildNumber)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$apk = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'
$testApk = Join-Path $root 'android\app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk'
$testResult = Join-Path $root '.data\android-connected-extended.txt'
$accepted = Join-Path $root '.data\installed-acceptance.json'
$directory = Join-Path $root ".data\artifacts\build-$BuildNumber"
if (Test-Path -LiteralPath $directory) { throw "Build $BuildNumber is already sealed; choose a new build number." }
if (-not (Select-String -LiteralPath $testResult -Pattern '^OK \(1 test\)' -Quiet)) {
    throw 'The complete native ConnectedFlowTest has not passed; the artifact will not be sealed as accepted.'
}
$installed = Get-Content -LiteralPath $accepted -Raw | ConvertFrom-Json
$apkMetadata = Get-Content -LiteralPath (Join-Path $root 'android\app\build\outputs\apk\debug\output-metadata.json') -Raw | ConvertFrom-Json
$version = $apkMetadata.elements[0]
$hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash
if ($installed.apkSha256 -ne $hash -or $installed.installedSha256 -ne $hash) {
    throw 'The current APK differs from the actually installed acceptance APK.'
}
New-Item -ItemType Directory -Path $directory | Out-Null
$name = "DevPocket-$($version.versionName)-build$BuildNumber-debug.apk"
Copy-Item -LiteralPath $apk -Destination (Join-Path $directory $name)
Copy-Item -LiteralPath $testApk -Destination (Join-Path $directory 'instrumentation.apk')
Copy-Item -LiteralPath $testResult -Destination (Join-Path $directory 'native-acceptance.txt')
Copy-Item -LiteralPath $accepted -Destination (Join-Path $directory 'installed-acceptance.json')
$sources = @(
    Get-ChildItem -LiteralPath (Join-Path $root 'android\app\src') -Recurse -File
    Get-Item -LiteralPath (Join-Path $root 'android\app\build.gradle.kts'), (Join-Path $root 'android\app\proguard-rules.pro'),
        (Join-Path $root 'android\build.gradle.kts'), (Join-Path $root 'android\settings.gradle.kts'),
        (Join-Path $root 'android\gradle.properties'), (Join-Path $root 'android\gradlew.bat')
    Get-ChildItem -LiteralPath (Join-Path $root 'android\gradle\wrapper') -File
) | Sort-Object FullName | ForEach-Object {
    @{ path = [IO.Path]::GetRelativePath($root, $_.FullName); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
}
$sourceManifest = Join-Path $directory 'android-sources.json'
$sources | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $sourceManifest -Encoding utf8NoBOM
$manifest = @{
    buildNumber = $BuildNumber
    versionName = $version.versionName
    versionCode = $version.versionCode
    applicationId = $apkMetadata.applicationId
    variant = 'debug'
    createdAt = [DateTime]::UtcNow.ToString('o')
    apk = $name
    apkSha256 = $hash
    installedApkSha256 = $installed.installedSha256
    instrumentationApkSha256 = (Get-FileHash -LiteralPath $testApk -Algorithm SHA256).Hash
    sourceManifestSha256 = (Get-FileHash -LiteralPath $sourceManifest -Algorithm SHA256).Hash
    sourceFileCount = @($sources).Count
    gitRepository = $false
    acceptance = 'ConnectedFlowTest extended: real original CLI, native chat/approval/question/stop and draft recreation'
    externalLimits = @('public TLS/cellular not deployed', 'FCM not provisioned', 'physical devices not tested', 'real CLI file/Git views blocked by unavailable content-exclusion evaluation')
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $directory 'build.json') -Encoding utf8NoBOM
if ((Get-FileHash -LiteralPath (Join-Path $directory $name) -Algorithm SHA256).Hash -ne $hash) { throw 'Artifact copy hash mismatch.' }
Write-Output "Sealed build ${BuildNumber}: $(Join-Path $directory $name)"
Write-Output "SHA256: $hash"
