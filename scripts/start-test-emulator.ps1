param([string]$Sdk = (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$avdHome = Join-Path $root '.data\emulator\avd'
$avd = Join-Path $avdHome 'DevPocketProof.avd'
$image = Join-Path $Sdk 'system-images\android-37.0\google_apis_playstore\x86_64'
if (-not (Test-Path -LiteralPath (Join-Path $image 'system.img'))) { throw "Installed test system image is missing: $image" }
if (Get-NetTCPConnection -State Listen -LocalPort 5580 -ErrorAction SilentlyContinue) { throw 'Port 5580 is occupied; no existing emulator will be reused.' }
New-Item -ItemType Directory -Force -Path $avd | Out-Null
$env:ANDROID_AVD_HOME = $avdHome
$env:ANDROID_EMULATOR_HOME = Join-Path $root '.data\emulator\home'
$env:ANDROID_ADB_SERVER_PORT = '5038'
$env:ADB_SERVER_PORT = '5038'
New-Item -ItemType Directory -Force -Path $env:ANDROID_EMULATOR_HOME | Out-Null
& (Join-Path $Sdk 'platform-tools\adb.exe') -P 5038 start-server
@"
avd.ini.encoding=UTF-8
path=$avd
target=android-37
"@ | Set-Content -LiteralPath (Join-Path $avdHome 'DevPocketProof.ini') -Encoding utf8NoBOM
@"
AvdId=DevPocketProof
avd.ini.displayname=DevPocket isolated proof
abi.type=x86_64
hw.cpu.arch=x86_64
hw.cpu.ncore=2
hw.ramSize=2048
hw.lcd.width=1080
hw.lcd.height=2400
hw.lcd.density=420
hw.keyboard=yes
hw.mainKeys=no
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
disk.dataPartition.size=2G
image.sysdir.1=$image\
tag.id=google_apis_playstore
tag.display=Google Play
PlayStore.enabled=false
showDeviceFrame=no
fastboot.forceColdBoot=yes
fastboot.forceFastBoot=no
skin.dynamic=yes
"@ | Set-Content -LiteralPath (Join-Path $avd 'config.ini') -Encoding utf8NoBOM
& (Join-Path $Sdk 'emulator\emulator.exe') -avd DevPocketProof -port 5580 -no-window -no-audio -no-boot-anim -no-snapshot -no-metrics -show-kernel -gpu swiftshader_indirect
exit $LASTEXITCODE
