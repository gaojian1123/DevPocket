import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const syntheticExecution = (source) => ({
  source: { ...source }, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z",
});

export async function sdkPreparationFixture(root) {
  for (const directory of ["scripts", "android/gradle/wrapper", "existing-sdk/licenses", "fixtures"]) {
    await mkdir(path.join(root, ...directory.split("/")), { recursive: true });
  }
  await copyFile(path.resolve("scripts", "prepare-android.ps1"), path.join(root, "scripts", "prepare-android.ps1"));
  await writeFile(path.join(root, "existing-sdk", "licenses", "android-sdk-license"), "fixture-already-accepted\n");
  await writeFile(path.join(root, "fixtures", "wrapper.jar"), "fixture-wrapper\n");
  const entry = path.join(root, "prepare-fixture.ps1");
  await writeFile(entry, String.raw`$ErrorActionPreference = 'Stop'
$global:FixtureRoot = $PSScriptRoot
$packages = @(
    @{ Path='platforms;android-35'; Revision='2'; Archive='platform.zip'; Type='sdk:platformDetailsType'; Details='<api-level>35</api-level><layoutlib api="15"/>' },
    @{ Path='build-tools;35.0.0'; Revision='35.0.0'; Archive='build-tools.zip'; Type='generic:genericDetailsType'; Details='' }
)
$nodes = foreach ($package in $packages) {
    $directory = Join-Path $PSScriptRoot ('fixtures\' + $package.Archive + '.source\package')
    $null = New-Item -ItemType Directory -Force -Path $directory
    [IO.File]::WriteAllText((Join-Path $directory 'source.properties'), "Pkg.Revision=$($package.Revision)")
    [IO.File]::WriteAllText((Join-Path $directory 'fixture.bin'), 'unchanged-tool-bytes')
    $zip = Join-Path $PSScriptRoot ('fixtures\' + $package.Archive)
    if (-not (Test-Path -LiteralPath $zip)) { Compress-Archive -LiteralPath $directory -DestinationPath $zip }
    $checksum = (Get-FileHash -LiteralPath $zip -Algorithm SHA1).Hash
    $revision = if ($package.Revision -eq '2') { '<major>2</major>' } else { '<major>35</major><minor>0</minor><micro>0</micro>' }
    @"
<remotePackage path="$($package.Path)">
  <type-details xsi:type="$($package.Type)">$($package.Details)</type-details>
  <revision>$revision</revision><display-name>Fixture package</display-name>
  <uses-license ref="android-sdk-license"/><channelRef ref="channel-0"/>
  <archives><archive><host-os>windows</host-os><complete><url>$($package.Archive)</url><checksum type="sha1">$checksum</checksum></complete></archive></archives>
</remotePackage>
"@
}
$global:FixtureRepository = @"
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03"
 xmlns:common="http://schemas.android.com/repository/android/common/02"
 xmlns:generic="http://schemas.android.com/repository/android/generic/02"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <license id="android-sdk-license" type="text">fixture license text</license>
 $($nodes -join '')
</sdk:sdk-repository>
"@
function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [int]$TimeoutSec)
    if ($Uri -eq 'https://dl.google.com/android/repository/repository2-3.xml') {
        return @{Content=$global:FixtureRepository}
    }
    if ($Uri -eq 'https://services.gradle.org/distributions/gradle-8.11.1-wrapper.jar.sha256') {
        return @{Content=(Get-FileHash -LiteralPath (Join-Path $global:FixtureRoot 'fixtures\wrapper.jar') -Algorithm SHA256).Hash}
    }
    $name = switch ($Uri) {
        'https://dl.google.com/android/repository/platform.zip' { 'platform.zip' }
        'https://dl.google.com/android/repository/build-tools.zip' { 'build-tools.zip' }
        'https://raw.githubusercontent.com/gradle/gradle/v8.11.1/gradle/wrapper/gradle-wrapper.jar' { 'wrapper.jar' }
        default { throw 'Unexpected network request in fixture.' }
    }
    if (-not $OutFile) { throw 'Unexpected download shape in fixture.' }
    Copy-Item -LiteralPath (Join-Path $global:FixtureRoot ('fixtures\' + $name)) -Destination $OutFile
}
function Invoke-RestMethod { throw 'Unexpected network request in fixture.' }
& (Join-Path $PSScriptRoot 'scripts\prepare-android.ps1') -ExistingSdk (Join-Path $PSScriptRoot 'existing-sdk') | Out-Null
$result = foreach ($relative in @('platforms\android-35', 'build-tools\35.0.0')) {
    $file = Join-Path $PSScriptRoot ('.tools\android-sdk\' + $relative + '\package.xml')
    if (-not (Test-Path -LiteralPath $file)) { @{path=$relative;exists=$false}; continue }
    [xml]$xml = Get-Content -LiteralPath $file -Raw
    $package = $xml.SelectSingleNode('//*[local-name()="localPackage"]')
    $type = $package.SelectSingleNode('./*[local-name()="type-details"]')
    $typeName = $type.GetAttribute('type', 'http://www.w3.org/2001/XMLSchema-instance')
    @{
        path=$package.GetAttribute('path'); exists=$true; rootNamespace=$xml.DocumentElement.NamespaceURI
        typeNamespace=$type.GetNamespaceOfPrefix($typeName.Split(':')[0])
        remoteNodes=$package.SelectNodes('./*[local-name()="archives" or local-name()="channelRef"]').Count
        license=$package.SelectSingleNode('./*[local-name()="uses-license"]').GetAttribute('ref')
    }
}
ConvertTo-Json -InputObject @($result) -Depth 4
`);
  return entry;
}

export async function windowsNodeLauncher(root, base) {
  const directory = path.join(root, ".data", "node-launcher");
  await mkdir(directory, { recursive: true });
  const source = path.join(directory, "node.cs"), binary = path.join(directory, "node.exe");
  const literal = (value) => `@"${value.replaceAll('"', '""')}"`;
  await writeFile(source, [
    "using System; using System.Diagnostics; using System.IO;",
    "class NodeLauncher { static int Main(string[] args) {",
    'if(args.Length>0 && args[0]=="--lookup-path"){Console.WriteLine(Process.GetCurrentProcess().MainModule.FileName);return 0;}',
    ...(base ? [
      'if(args.Length>0 && args[0].Replace(\'\\\\\',\'/\').EndsWith("/typescript/bin/tsc")){',
      'File.AppendAllText(".data/node-launch-count","called\\n");',
      'var git=new ProcessStartInfo("git","rev-parse HEAD"){UseShellExecute=false,RedirectStandardOutput=true,CreateNoWindow=true};',
      "using(var child=Process.Start(git)){string head=child.StandardOutput.ReadToEnd().Trim();child.WaitForExit();",
      `if(child.ExitCode!=0 || head!=${literal(base)})return 23;}}`,
    ] : []),
    "string command=Environment.CommandLine.TrimStart();",
    'int end=command[0]==\'"\' ? command.IndexOf(\'"\',1)+1 : command.IndexOf(\' \');',
    'string tail=end<0 ? "" : command.Substring(end).TrimStart();',
    `var start=new ProcessStartInfo(${literal(process.execPath)},tail){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};`,
    "using(var child=Process.Start(start)){",
    "var output=child.StandardOutput.ReadToEndAsync();var error=child.StandardError.ReadToEndAsync();child.WaitForExit();",
    "Console.Write(output.GetAwaiter().GetResult());Console.Error.Write(error.GetAwaiter().GetResult());return child.ExitCode;}",
    "} }",
  ].join("\n"));
  const compiler = path.join(process.env.SystemRoot ?? process.env.WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  await exec(compiler, ["/nologo", `/out:${binary}`, source], { timeout: 30000 });
  return binary;
}

export async function verificationTools(root, {
  native = false, operations = false, capturePython = false, jdk, sdk, emulatorNoise = false, emulatorVersion = "35.0.1",
  emulatorAcceleration = process.platform === "win32" ? "WHPX is installed and usable" : "KVM is installed and usable",
} = {}) {
  const directory = path.join(root, ".data", "synthetic-tools");
  await mkdir(directory, { recursive: true });
  const binary = path.join(directory, process.platform === "win32" ? "tool.exe" : "tool");
  if (process.platform === "win32") {
    const source = path.join(directory, "tool.cs");
    await writeFile(source, [
      "using System; using System.Diagnostics; using System.IO;",
      "class Tool { static void Main(string[] args) {",
      "string name=Path.GetFileNameWithoutExtension(Process.GetCurrentProcess().MainModule.FileName);",
      ...(capturePython ? ['if(name=="python" && args.Length==3 && args[0]=="-B" && args[1]=="-c") File.WriteAllText(".data/python-probe.py",args[2]);'] : []),
      'if(name=="emulator" && args.Length>0 && args[0]=="-accel-check" && File.Exists(".data/emulator-permission-lost")){Console.Error.WriteLine("PRIVATE_KVM_PERMISSION_CANARY");Environment.Exit(11);}',
      ...(emulatorNoise ? ['if(name=="emulator") Console.Error.WriteLine("INFO | Storing crashdata in: PRIVATE_PROBE_PATH, detection is enabled for process: "+Process.GetCurrentProcess().Id);'] : []),
      "if(name==\"java\") Console.Error.WriteLine(\"openjdk version \\\"21.0.1\\\"\");",
      "else if(name==\"adb\") Console.WriteLine(\"Android Debug Bridge version 1.0.41\");",
      `else if(name=="emulator") Console.WriteLine(args.Length>0 && args[0]=="-accel-check" ? ${JSON.stringify(emulatorAcceleration)} : ${JSON.stringify(`Android emulator version ${emulatorVersion}`)});`,
      "else if(args.Length>0 && args[0]==\"--version\") Console.WriteLine(\"Python 3.12.0\");",
      "else Console.WriteLine(\"{\\\"version\\\":[3,12,0],\\\"executable\\\":\\\"synthetic-python\\\",\\\"dependencies\\\":\\\"synthetic\\\"}\");",
      "} }",
    ].join("\n"));
    const compiler = path.join(process.env.SystemRoot ?? process.env.WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    await exec(compiler, ["/nologo", `/out:${binary}`, source], { timeout: 30000 });
  } else {
    await writeFile(binary, [
      "#!/bin/sh",
      ...(capturePython ? ['if [ "$(basename "$0")" = python ] && [ "$1" = "-B" ] && [ "$2" = "-c" ]; then printf "%s" "$3" > .data/python-probe.py; fi'] : []),
      'if [ "$(basename "$0")" = emulator ] && [ "$1" = "-accel-check" ] && [ -f .data/emulator-permission-lost ]; then echo PRIVATE_KVM_PERMISSION_CANARY >&2; exit 11; fi',
      ...(emulatorNoise ? ['if [ "$(basename "$0")" = emulator ]; then echo "INFO | Storing crashdata in: PRIVATE_PROBE_PATH, detection is enabled for process: $$" >&2; fi'] : []),
      "case \"$(basename \"$0\")\" in",
      "java) echo 'openjdk version \"21.0.1\"' >&2 ;;",
      "adb) echo 'Android Debug Bridge version 1.0.41' ;;",
      `emulator) if [ "$1" = '-accel-check' ]; then printf '%s\\n' '${emulatorAcceleration.replaceAll("'", "'\\''")}'; else printf '%s\\n' '${`Android emulator version ${emulatorVersion}`.replaceAll("'", "'\\''")}'; fi ;;`,
      "*) if [ \"$1\" = '--version' ]; then echo 'Python 3.12.0'; else echo '{\"version\":[3,12,0],\"executable\":\"synthetic-python\",\"dependencies\":\"synthetic\"}'; fi ;;",
      "esac", "",
    ].join("\n"));
    await chmod(binary, 0o755);
  }
  const putTool = async (file) => {
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(binary, file);
    if (process.platform !== "win32") await chmod(file, 0o755);
  };
  const executable = (name) => process.platform === "win32" ? `${name}.exe` : name;
  const env = {};
  if (operations) {
    const python = path.join(directory, executable("python"));
    await putTool(python);
    env.PATH = `${directory}${path.delimiter}${process.env.PATH ?? process.env.Path}`;
    env.DEVPOCKET_PROBE_PYTHON = python;
    const requirements = path.join(root, "deployment", "azure", "probe", "requirements-test.txt");
    await mkdir(path.dirname(requirements), { recursive: true });
    await writeFile(requirements, "cryptography==50.0.1\n");
  }
  if (native) {
    jdk ??= path.join(root, ".tools", "jdk-21");
    sdk ??= path.join(root, ".tools", "android-sdk");
    await putTool(path.join(jdk, "bin", executable("java")));
    await writeFile(path.join(jdk, "release"), 'JAVA_VERSION="21.0.1"\n');
    for (const name of ["aapt2", "zipalign"]) await putTool(path.join(sdk, "build-tools", "35.0.0", executable(name)));
    await putTool(path.join(sdk, "platform-tools", executable("adb")));
    await putTool(path.join(sdk, "emulator", executable("emulator")));
    for (const relative of ["platforms/android-35/android.jar", "platforms/android-35/package.xml",
      "build-tools/35.0.0/package.xml", "licenses/android-sdk-license",
      "system-images/android-35/google_apis/x86_64/system.img", "system-images/android-35/google_apis/x86_64/source.properties"]) {
      const file = path.join(sdk, ...relative.split("/"));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "synthetic SDK input\n");
    }
    const wrapper = path.join(root, "android", "gradle", "wrapper");
    await mkdir(wrapper, { recursive: true });
    await writeFile(path.join(wrapper, "gradle-wrapper.jar"), "synthetic wrapper\n");
    await writeFile(path.join(wrapper, "gradle-wrapper.properties"), "distributionUrl=synthetic-only\n");
  }
  return { jdk, sdk, env };
}
