param([string]$Sdk = (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$adb = Join-Path $Sdk 'platform-tools\adb.exe'
$serial = 'emulator-5580'
$avd = (& $adb -P 5038 -s $serial emu avd name | Out-String)
if ($avd -notmatch 'DevPocketProof') { throw 'This script only changes the disposable DevPocketProof emulator.' }
& $adb -P 5038 -s $serial install -r (Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk')
if ($LASTEXITCODE -ne 0) { throw 'App APK installation failed.' }
& $adb -P 5038 -s $serial install -r (Join-Path $root 'android\app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk')
if ($LASTEXITCODE -ne 0) { throw 'Instrumentation APK installation failed.' }
& $adb -P 5038 -s $serial shell settings put secure show_ime_with_hard_keyboard 1
$cases = @(
    @{ Name = 'compact'; Size = '1080x2400'; Density = '420'; Font = '1.0' },
    @{ Name = 'medium'; Size = '1400x2200'; Density = '320'; Font = '1.0' },
    @{ Name = 'expanded'; Size = '2400x1800'; Density = '240'; Font = '1.0' },
    @{ Name = 'landscape'; Size = '2400x1080'; Density = '420'; Font = '1.0' },
    @{ Name = 'large-font'; Size = '1080x2400'; Density = '420'; Font = '2.0' }
)
$failed = @()
try {
    foreach ($case in $cases) {
        & $adb -P 5038 -s $serial shell wm size $case.Size
        & $adb -P 5038 -s $serial shell wm density $case.Density
        & $adb -P 5038 -s $serial shell settings put system font_scale $case.Font
        Start-Sleep -Seconds 3
        $log = Join-Path $root ".data\layout-$($case.Name).txt"
        & $adb -P 5038 -s $serial shell am instrument -w -e class dev.devpocket.app.AdaptiveLayoutTest `
            dev.devpocket.app.debug.test/androidx.test.runner.AndroidJUnitRunner *> $log
        if (-not (Select-String -LiteralPath $log -Pattern '^OK \(1 test\)' -Quiet)) {
            $failed += $case.Name
            Get-Content -LiteralPath $log -Tail 25
        } else { Write-Output "$($case.Name): PASS" }
    }
} finally {
    & $adb -P 5038 -s $serial shell wm size reset
    & $adb -P 5038 -s $serial shell wm density reset
    & $adb -P 5038 -s $serial shell settings put system font_scale 1.0
}
if ($failed.Count) { throw "Native layout cases failed: $($failed -join ', ')" }
