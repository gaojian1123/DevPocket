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

function Get-StablePackage([xml]$Repository, [string]$PackagePath) {
    $packages = @($Repository.SelectNodes("//*[local-name()='remotePackage' and @path='$PackagePath']") | Where-Object {
        $channel = $_.SelectSingleNode("./*[local-name()='channelRef']/@ref")
        $preview = $_.SelectSingleNode("./*[local-name()='revision']/*[local-name()='preview']")
        $channel -and $channel.Value -eq 'channel-0' -and (-not $preview -or $preview.InnerText -eq '0')
    })
    if ($packages.Count -ne 1) { throw "Stable SDK package is missing or ambiguous: $PackagePath" }
    return ,$packages[0]
}

function Write-LocalPackage([xml]$Repository, [System.Xml.XmlElement]$Package, [string]$Destination) {
    if (-not $Package) { throw "Package metadata is unavailable: $Destination" }
    $cursor = [IO.Path]::GetFullPath($Destination)
    while ($cursor -ne $root) {
        if (-not $cursor.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Package metadata must remain in this project.'
        }
        $item = Get-Item -LiteralPath $cursor -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Package metadata requires an unlinked local directory: $cursor"
        }
        $cursor = Split-Path -Parent $cursor
    }
    $file = Join-Path $Destination 'package.xml'
    if (Test-Path -LiteralPath $file) {
        $item = Get-Item -LiteralPath $file -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Package metadata requires a regular file: $file"
        }
        [xml]$existing = Get-Content -LiteralPath $file -Raw
        $local = @($existing.SelectNodes('//*[local-name()="localPackage"]'))
        if ($local.Count -ne 1 -or $local[0].GetAttribute('path') -ne $Package.GetAttribute('path')) {
            throw "Existing package metadata does not identify the selected package: $file"
        }
        return
    }
    $sourceProperties = Join-Path $Destination 'source.properties'
    $item = Get-Item -LiteralPath $sourceProperties -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Package revision requires a regular source.properties file: $Destination"
    }
    $properties = Get-Content -LiteralPath $sourceProperties -Raw
    $revision = [regex]::Matches($properties, '(?m)^Pkg\.Revision\s*=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\s+rc(\d+))?\s*$')
    if ($revision.Count -ne 1) { throw "Installed package revision is unavailable: $Destination" }
    $installed = foreach ($index in 1..4) { [int]$revision[0].Groups[$index].Value }
    $expected = foreach ($name in @('major', 'minor', 'micro', 'preview')) {
        $value = $Package.SelectSingleNode("./*[local-name()='revision']/*[local-name()='$name']")
        if ($value -and $value.InnerText -notmatch '^\d+$') { throw 'Unsupported package revision metadata.' }
        if ($value) { [int]$value.InnerText } else { 0 }
    }
    if (($installed -join '.') -ne ($expected -join '.')) {
        throw "Installed package revision does not match the available metadata; no metadata was written: $Destination"
    }
    $namespace = 'http://schemas.android.com/repository/android/common/02'
    $prefix = $Repository.DocumentElement.GetNamespaceOfPrefix('local')
    if ($prefix -and $prefix -ne $namespace) { throw 'Unsupported package namespace binding.' }
    $document = [xml]::new()
    $container = $document.CreateElement('local', 'repository', $namespace)
    foreach ($attribute in $Repository.DocumentElement.Attributes) {
        if ($attribute.Prefix -eq 'xmlns' -or $attribute.Name -eq 'xmlns') {
            $null = $container.Attributes.Append($document.ImportNode($attribute, $true))
        }
    }
    $null = $document.AppendChild($container)
    $local = $document.CreateElement('localPackage')
    $local.SetAttribute('path', $Package.GetAttribute('path'))
    $local.SetAttribute('obsolete', $(if ($Package.HasAttribute('obsolete')) { $Package.GetAttribute('obsolete') } else { 'false' }))
    foreach ($child in $Package.ChildNodes) {
        if ($child.LocalName -in @('type-details', 'revision', 'display-name', 'uses-license', 'dependencies')) {
            $null = $local.AppendChild($document.ImportNode($child, $true))
        }
    }
    $licenseId = $Package.SelectSingleNode('./*[local-name()="uses-license"]').GetAttribute('ref')
    $licenses = @($Repository.SelectNodes('//*[local-name()="license"]') | Where-Object { $_.GetAttribute('id') -eq $licenseId })
    if ($licenses.Count -ne 1) { throw 'The selected package license metadata is unavailable.' }
    $null = $container.AppendChild($document.ImportNode($licenses[0], $true))
    $null = $container.AppendChild($local)
    $stream = [IO.File]::Open($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $document.Save($stream); $stream.Flush($true) }
    finally { $stream.Dispose() }
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
    @{ Package = 'platforms;android-37.2'; Destination = 'platforms\android-37.2' },
    @{ Package = 'build-tools;37.0.0'; Destination = 'build-tools\37.0.0' }
)
if ($Emulator) {
    $packages += @(
        @{ Package = 'emulator'; Destination = 'emulator' },
        @{ Package = 'platform-tools'; Destination = 'platform-tools' }
    )
}
foreach ($spec in $packages) {
    $dest = Join-Path $sdk $spec.Destination
    $pkg = Get-StablePackage $repo $spec.Package
    if (Test-Path -LiteralPath $dest) {
        Write-LocalPackage $repo $pkg $dest
        continue
    }
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
    Write-LocalPackage $repo $pkg $dest
}
if ($Emulator) {
    $image = Join-Path $sdk 'system-images\android-37.0\google_apis\x86_64'
    if (-not (Test-Path -LiteralPath (Join-Path $image 'package.xml'))) {
        [xml]$images = (Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml' -TimeoutSec 90).Content
        $pkg = Get-StablePackage $images 'system-images;android-37.0;google_apis;x86_64'
        $licenseId = $pkg.'uses-license'.ref
        $acceptedLicense = Join-Path $ExistingSdk "licenses\$licenseId"
        if (-not $licenseId -or -not (Test-Path -LiteralPath $acceptedLicense)) {
            throw 'The selected system image license must already be accepted in the existing SDK.'
        }
        Copy-Item -LiteralPath $acceptedLicense -Destination (Join-Path $sdk "licenses\$licenseId")
        if (-not (Test-Path -LiteralPath $image)) {
            $archive = @($pkg.archives.archive | Where-Object { -not $_.'host-os' -or $_.'host-os' -eq 'windows' })[0].complete
            if (-not $archive.url -or -not $archive.checksum.InnerText) { throw 'No verified API-37 x86_64 image archive was found.' }
            $zip = Join-Path $tools ('api37-' + $archive.url)
            Fetch-Verified "https://dl.google.com/android/repository/sys-img/google_apis/$($archive.url)" $zip 'SHA1' $archive.checksum.InnerText
            $stage = Join-Path $tools 'api37-image.unpack'
            Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
            $top = @(Get-ChildItem -LiteralPath $stage -Directory)
            if ($top.Count -ne 1) { throw 'Unexpected API-37 image archive layout.' }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $image) | Out-Null
            Move-Item -LiteralPath $top[0].FullName -Destination $image
        }
        Write-LocalPackage $images $pkg $image
    }
}
if ($DownloadJdk) {
    $jdk = Join-Path $tools 'jdk-25'
    if (-not (Test-Path -LiteralPath $jdk)) {
        $asset = @(Invoke-RestMethod -Uri 'https://api.adoptium.net/v3/assets/latest/25/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse' -TimeoutSec 90)[0]
        $package = $asset.binary.package
        $zip = Join-Path $tools 'jdk-25.zip'
        Fetch-Verified $package.link $zip 'SHA256' $package.checksum
        $stage = Join-Path $tools 'jdk-25.unpack'
        Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
        $top = @(Get-ChildItem -LiteralPath $stage -Directory)
        if ($top.Count -ne 1) { throw 'Unexpected JDK archive layout.' }
        Move-Item -LiteralPath $top[0].FullName -Destination $jdk
    }
}
$wrapper = Join-Path $root 'android\gradle\wrapper\gradle-wrapper.jar'
$checksumResponse = (Invoke-WebRequest -Uri 'https://services.gradle.org/distributions/gradle-9.8.2-wrapper.jar.sha256' -TimeoutSec 90).Content
$checksum = if ($checksumResponse -is [byte[]]) { [Text.Encoding]::UTF8.GetString($checksumResponse).Trim() } else { "$checksumResponse".Trim() }
Fetch-Verified 'https://raw.githubusercontent.com/gradle/gradle/v9.8.2/gradle/wrapper/gradle-wrapper.jar' $wrapper 'SHA256' $checksum
Write-Output "Android SDK ready: $sdk"
Write-Output 'Only local .tools files and the pinned wrapper were prepared; no licenses were auto-accepted and no global toolchain was changed.'
