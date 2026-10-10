param(
    [string]$ExistingSdk = $env:ANDROID_HOME,
    [switch]$DownloadJdk,
    [switch]$Emulator
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root '.tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null

function Fetch-Verified([string]$Url, [string]$Destination, [string]$Algorithm, [string]$Checksum) {
    if (-not (Test-Path -LiteralPath $Destination)) {
        Invoke-WebRequest -Uri $Url -OutFile $Destination -TimeoutSec 900
    }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm $Algorithm).Hash -ne $Checksum) {
        throw "Checksum mismatch: $Destination. Delete that exact archive and try again."
    }
}

if (-not $ExistingSdk) { $ExistingSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$license = Join-Path $ExistingSdk 'licenses\android-sdk-license'
if (-not (Test-Path -LiteralPath $license)) {
    throw 'Android SDK license has not been accepted. Install Android Studio/SDK and accept the Android SDK license yourself, then rerun with -ExistingSdk.'
}
$sdk = Join-Path $tools 'android-sdk'
New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'licenses') | Out-Null
Copy-Item -LiteralPath $license -Destination (Join-Path $sdk 'licenses\android-sdk-license')
[xml]$repo = (Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/repository2-3.xml' -TimeoutSec 90).Content
$packages = @(
    @{ Package = 'platforms;android-35'; Destination = 'platforms\android-35' },
    @{ Package = 'build-tools;35.0.0'; Destination = 'build-tools\35.0.0' }
)
if ($Emulator) {
    $packages += @(
        @{ Package = 'emulator'; Destination = 'emulator' },
        @{ Package = 'platform-tools'; Destination = 'platform-tools' }
    )
}
foreach ($spec in $packages) {
    $dest = Join-Path $sdk $spec.Destination
    if (Test-Path -LiteralPath $dest) { continue }
    $pkg = $repo.SelectSingleNode("//*[local-name()='remotePackage' and @path='$($spec.Package)']")
    $archive = @($pkg.archives.archive | Where-Object { -not $_.'host-os' -or $_.'host-os' -eq 'windows' })[0].complete
    if (-not $archive.url -or -not $archive.checksum.InnerText) { throw "No verified package found: $($spec.Package)" }
    $zip = Join-Path $tools $archive.url
    Fetch-Verified "https://dl.google.com/android/repository/$($archive.url)" $zip 'SHA1' $archive.checksum.InnerText
    $stage = Join-Path $tools ($archive.url + '.unpack')
    Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
    $top = @(Get-ChildItem -LiteralPath $stage -Directory)
    if ($top.Count -ne 1) { throw "Unexpected archive layout in $stage" }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Move-Item -LiteralPath $top[0].FullName -Destination $dest
}
if ($Emulator) {
    $image = Join-Path $sdk 'system-images\android-35\google_apis\x86_64'
    if (-not (Test-Path -LiteralPath $image)) {
        [xml]$images = (Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml' -TimeoutSec 90).Content
        $pkg = $images.SelectSingleNode("//*[local-name()='remotePackage' and @path='system-images;android-35;google_apis;x86_64']")
        $licenseId = $pkg.'uses-license'.ref
        $acceptedLicense = Join-Path $ExistingSdk "licenses\$licenseId"
        if (-not $licenseId -or -not (Test-Path -LiteralPath $acceptedLicense)) {
            throw 'The selected system image license must already be accepted in the existing SDK.'
        }
        Copy-Item -LiteralPath $acceptedLicense -Destination (Join-Path $sdk "licenses\$licenseId")
        $archive = @($pkg.archives.archive | Where-Object { -not $_.'host-os' -or $_.'host-os' -eq 'windows' })[0].complete
        if (-not $archive.url -or -not $archive.checksum.InnerText) { throw 'No verified API-35 x86_64 image archive was found.' }
        $zip = Join-Path $tools ('api35-' + $archive.url)
        Fetch-Verified "https://dl.google.com/android/repository/sys-img/google_apis/$($archive.url)" $zip 'SHA1' $archive.checksum.InnerText
        $stage = Join-Path $tools 'api35-image.unpack'
        Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
        $top = @(Get-ChildItem -LiteralPath $stage -Directory)
        if ($top.Count -ne 1) { throw 'Unexpected API-35 image archive layout.' }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $image) | Out-Null
        Move-Item -LiteralPath $top[0].FullName -Destination $image
    }
}
if ($DownloadJdk) {
    $jdk = Join-Path $tools 'jdk-21'
    if (-not (Test-Path -LiteralPath $jdk)) {
        $asset = @(Invoke-RestMethod -Uri 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse' -TimeoutSec 90)[0]
        $package = $asset.binary.package
        $zip = Join-Path $tools 'jdk-21.zip'
        Fetch-Verified $package.link $zip 'SHA256' $package.checksum
        $stage = Join-Path $tools 'jdk-21.unpack'
        Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
        $top = @(Get-ChildItem -LiteralPath $stage -Directory)
        if ($top.Count -ne 1) { throw 'Unexpected JDK archive layout.' }
        Move-Item -LiteralPath $top[0].FullName -Destination $jdk
    }
}
$wrapper = Join-Path $root 'android\gradle\wrapper\gradle-wrapper.jar'
$checksumResponse = (Invoke-WebRequest -Uri 'https://services.gradle.org/distributions/gradle-8.11.1-wrapper.jar.sha256' -TimeoutSec 90).Content
$checksum = if ($checksumResponse -is [byte[]]) { [Text.Encoding]::UTF8.GetString($checksumResponse).Trim() } else { "$checksumResponse".Trim() }
Fetch-Verified 'https://raw.githubusercontent.com/gradle/gradle/v8.11.1/gradle/wrapper/gradle-wrapper.jar' $wrapper 'SHA256' $checksum
Write-Output "Android SDK ready: $sdk"
Write-Output 'Only local .tools files and the pinned wrapper were prepared; no licenses were auto-accepted and no global toolchain was changed.'
