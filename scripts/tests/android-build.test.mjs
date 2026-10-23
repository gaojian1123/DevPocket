import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { verificationTools } from "./fixtures/verification-tools.mjs";

const exec = promisify(execFile);

test("SDK preparation selects the stable channel and rejects unavailable or ambiguous stable packages", async () => {
  const harness = [
    "$ErrorActionPreference = 'Stop'",
    "$tokens = $null; $errors = $null",
    "$ast = [Management.Automation.Language.Parser]::ParseFile($env:SDK_PREPARATION_SOURCE, [ref]$tokens, [ref]$errors)",
    "if ($errors.Count) { throw 'SDK preparation did not parse.' }",
    "$selector = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-StablePackage'}, $true)",
    "if ($selector) { . ([scriptblock]::Create($selector.Extent.Text)) }",
    "$assignment = $ast.Find({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and $node.Left.VariablePath.UserPath -eq 'pkg'}, $true)",
    "if (-not $assignment) { throw 'SDK package-selection call site is missing.' }",
    "$select = [scriptblock]::Create($assignment.Right.Extent.Text)",
    "$spec = @{ Package = 'emulator' }",
    "$preview = '<remotePackage path=\"emulator\"><revision><major>99</major></revision><channelRef ref=\"channel-2\"/></remotePackage>'",
    "$stable = '<remotePackage path=\"emulator\"><revision><major>37</major></revision><channelRef ref=\"channel-0\"/></remotePackage>'",
    "[xml]$repo = '<repository>' + $preview + $stable + '</repository>'",
    "$selected = & $select",
    "$rejected = @()",
    "foreach ($body in @($preview, ($stable + $stable), $stable.Replace('channel-0', 'channel-unknown'), $stable.Replace('</major>', '</major><preview>1</preview>'))) {",
    "  [xml]$repo = '<repository>' + $body + '</repository>'",
    "  try { $null = & $select; $rejected += $false } catch {",
    "    if ($_.Exception.Message -notmatch 'Stable SDK package') { throw }",
    "    $rejected += $true",
    "  }",
    "}",
    "@{ channel = $selected.channelRef.ref; revision = $selected.revision.major; rejected = $rejected } | ConvertTo-Json -Compress",
  ].join("\n");
  const result = await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", harness],
    { env: { ...process.env, SDK_PREPARATION_SOURCE: path.resolve("scripts/prepare-android.ps1") }, timeout: 20_000 });
  const selected = JSON.parse(result.stdout);
  assert.equal(selected.channel, "channel-0", "A preview listed first must not be selected.");
  assert.equal(selected.revision, "37");
  assert.deepEqual(selected.rejected, [true, true, true, true]);
});

test("the clean Android CI job restores locked Node inputs before invoking the component-aware native build", async () => {
  const workflow = (await readFile(".github/workflows/ci.yml", "utf8")).replaceAll("\r\n", "\n");
  const job = workflow.split("\n  android:")[1].split("\n  device:")[0];
  const node = job.indexOf("uses: actions/setup-node@");
  const install = job.indexOf("run: npm ci --no-audit --no-fund");
  const build = job.indexOf("Verify native build, JVM contracts and lint");
  assert.ok(node >= 0 && install > node && build > install);
  const gradle = await readFile("android/app/build.gradle.kts", "utf8");
  assert.match(gradle, /commandLine\(npm \+ listOf\("run", "build", "--workspace", "@devpocket\/components"\)\)/);
  assert.match(gradle, /addGeneratedSourceDirectory\(copyAssets, CopyComponentAssets::outputDirectory\)/);
  assert.match(gradle, /from\(inputDirectory\) \{ into\("components"\) \}/);
  assert.doesNotMatch(gradle, /assets\.srcDir|android\.sourceset\.disallowProvider/);
  const preparation = await readFile(".github/actions/prepare-native/action.yml", "utf8");
  assert.ok(preparation.includes("npm ci --no-audit --no-fund"));
});

test("native defaults and the JDK download select JDK 25 without a legacy fallback", async () => {
  for (const file of ["build-android.ps1", "android-emulator.mjs", "verification-preflight.mjs", "prepare-android.ps1"]) {
    const source = await readFile(path.join("scripts", file), "utf8");
    assert.match(source, /["']jdk-25["']/, file);
    assert.doesNotMatch(source, /jdk-21/, file);
  }
  const preparation = await readFile("scripts/prepare-android.ps1", "utf8");
  assert.match(preparation, /api\.adoptium\.net\/v3\/assets\/latest\/25\/hotspot\?/);
  assert.match(preparation, /'jdk-25\.zip'/);
  assert.match(preparation, /'jdk-25\.unpack'/);
});

async function buildFixture(t, javaVersion = "25.0.1") {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/android-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of [
    "scripts", "android/gradle/wrapper", "selected jdk/bin", "inherited jdk/bin",
    "selected sdk/platforms/android-37.2", "inherited sdk/platforms/android-37.2",
  ]) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, "scripts", "build-android.ps1"), await readFile("scripts/build-android.ps1"));
  if (process.platform === "win32") await verificationTools(root, {
    native: true, jdk: path.join(root, "selected jdk"), sdk: path.join(root, "selected sdk"), javaVersion,
  });
  const wrapper = path.join(root, "android", "gradle", "wrapper", "gradle-wrapper.jar");
  await writeFile(wrapper, "synthetic wrapper");
  for (const name of ["selected", "inherited"]) {
    const java = path.join(root, `${name} jdk`, "bin", process.platform === "win32" ? "java.exe" : "java");
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    if (process.platform === "win32") {
      if (name === "inherited") await copyFile(path.join(root, "selected jdk", "bin", "java.exe"), java);
    } else {
      await writeFile(java, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, "android", "gradle-fixture.mjs"))} "$@"\n`);
      await chmod(java, 0o755);
    }
    await writeFile(path.join(root, `${name} sdk`, "platforms", "android-37.2", "android.jar"), "");
  }
  await writeFile(path.join(root, "android", "gradlew.bat"),
    `@echo off\r\n"${process.execPath}" "%~dp0gradle-fixture.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  await writeFile(path.join(root, "android", "gradle-fixture.mjs"), [
    "import {writeFileSync} from 'node:fs';",
    "import assert from 'node:assert/strict';",
    "const args=process.argv.slice(2);",
    `if(args.length===1 && args[0]==="-version"){console.error(${JSON.stringify(`openjdk version "${javaVersion}"`)});process.exit(0);}`,
    `if(process.platform!=="win32") assert.deepEqual(args.splice(0,5),["--enable-native-access=ALL-UNNAMED","-Dorg.gradle.appname=gradlew","-classpath",${JSON.stringify(wrapper)},"org.gradle.wrapper.GradleWrapperMain"]);`,
    "writeFileSync('invocation.json', JSON.stringify({",
    "  cwd: process.cwd(), args,",
    "  java: process.env.JAVA_HOME, sdk: process.env.ANDROID_HOME,",
    "  sdkRoot: process.env.ANDROID_SDK_ROOT, cache: process.env.GRADLE_USER_HOME,",
    "}));",
    "if (process.env.ANDROID_HOME !== process.env.ANDROID_SDK_ROOT) {",
    "  console.error('Several environment variables and/or system properties contain different paths to the SDK.');",
    "  process.exit(1);",
    "}",
    "process.exit(Number(process.env.FIXTURE_GRADLE_EXIT ?? 0));",
  ].join("\n"));
  return {
    root, jdk: path.join(root, "selected jdk"), sdk: path.join(root, "selected sdk"),
    env: {
      ...process.env, JAVA_HOME: path.join(root, "inherited jdk"),
      ANDROID_HOME: path.join(root, "inherited sdk"), ANDROID_SDK_ROOT: path.join(root, "inherited sdk"),
      GRADLE_USER_HOME: path.join(root, "inherited cache"),
    },
  };
}

test("the direct build entrypoint rejects non-project JDKs before starting Gradle", async (t) => {
  for (const version of ["21.0.1", "25-ea", "26.0.1"]) await t.test(version, async (t) => {
    const fixture = await buildFixture(t, version);
    await assert.rejects(exec("pwsh", ["-NoProfile", "-NonInteractive", "-File",
      path.join(fixture.root, "scripts", "build-android.ps1"), "-Jdk", fixture.jdk, "-Sdk", fixture.sdk],
    { cwd: fixture.root, env: fixture.env, timeout: 20_000 }),
    (error) => error.code === 78 && /JDK 25 is required/.test(error.stderr));
    await assert.rejects(readFile(path.join(fixture.root, "android", "invocation.json")), { code: "ENOENT" });
  });
});

test("the build entrypoint applies explicit JDK and SDK despite conflicting inherited variables", async (t) => {
  const fixture = await buildFixture(t);
  let failure;
  try {
    await exec("pwsh", ["-NoProfile", "-NonInteractive", "-File",
      path.join(fixture.root, "scripts", "build-android.ps1"), "-Jdk", fixture.jdk, "-Sdk", fixture.sdk,
      "-Lint", "-Instrumentation"], { cwd: fixture.root, env: fixture.env, timeout: 20_000 });
  } catch (error) { failure = error; }
  const invocation = JSON.parse(await readFile(path.join(fixture.root, "android", "invocation.json"), "utf8"));
  assert.equal(invocation.java, fixture.jdk);
  assert.equal(invocation.sdk, fixture.sdk);
  assert.equal(invocation.sdkRoot, fixture.sdk, "Both Android SDK variables must select the explicit SDK.");
  assert.equal(invocation.cache, path.join(fixture.root, ".tools", "gradle-cache"));
  assert.equal(invocation.cwd, path.join(fixture.root, "android"));
  assert.deepEqual(invocation.args, [
    "--no-daemon", "--console=plain", ":app:assembleDebug", ":app:testDebugUnitTest",
    ":app:lintDebug", ":app:assembleDebugAndroidTest",
  ]);
  assert.equal(failure, undefined, failure?.stderr);
});

test("an explicit run-owned Gradle cache reaches the build without changing SDK selection", async (t) => {
  const fixture = await buildFixture(t);
  const cache = path.join(fixture.root, ".data", "owned", "gradle-cache");
  await exec("pwsh", ["-NoProfile", "-NonInteractive", "-File",
    path.join(fixture.root, "scripts", "build-android.ps1"), "-Jdk", fixture.jdk, "-Sdk", fixture.sdk,
    "-GradleUserHome", cache, "-Instrumentation"], { cwd: fixture.root, env: fixture.env, timeout: 20_000 });
  const invocation = JSON.parse(await readFile(path.join(fixture.root, "android", "invocation.json"), "utf8"));
  assert.equal(invocation.cache, cache);
  assert.equal(invocation.java, fixture.jdk);
  assert.equal(invocation.sdk, fixture.sdk);
  assert.equal(invocation.sdkRoot, fixture.sdk);
  assert.deepEqual(invocation.args, [
    "--no-daemon", "--console=plain", ":app:assembleDebug", ":app:testDebugUnitTest", ":app:assembleDebugAndroidTest",
  ]);
});

test("success and Gradle failure restore the caller's environment and working directory", async (t) => {
  for (const populated of [false, true]) {
    for (const [exitCode, ownedCache] of [[0, false], [0, true], [37, false], [37, true]]) {
      await t.test(`inherited=${populated}, exit=${exitCode}, ownedCache=${ownedCache}`, async (t) => {
        const fixture = await buildFixture(t);
        const env = { ...fixture.env, FIXTURE_ROOT: fixture.root, FIXTURE_GRADLE_EXIT: String(exitCode) };
        if (!populated) {
          for (const name of ["JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "GRADLE_USER_HOME"]) delete env[name];
        }
        const harness = [
          "$ErrorActionPreference = 'Stop'",
          "$names = @('JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME')",
          "$before = @{}; foreach ($name in $names) { $before[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }",
          "$location = (Get-Location).Path; $failed = $false",
          "try {",
          `  & (Join-Path $env:FIXTURE_ROOT 'scripts\\build-android.ps1') -Jdk 'selected jdk' -Sdk 'selected sdk'${ownedCache ? " -GradleUserHome '.data\\owned-cache'" : ""}`,
          "} catch { $failed = $true }",
          "$after = @{}; foreach ($name in $names) { $after[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }",
          "@{before=$before;after=$after;locationBefore=$location;locationAfter=(Get-Location).Path;failed=$failed} |",
          "  ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $env:FIXTURE_ROOT 'caller.json')",
        ].join("\n");
        await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", harness],
          { cwd: fixture.root, env, timeout: 20_000 });
        const caller = JSON.parse(await readFile(path.join(fixture.root, "caller.json"), "utf8"));
        assert.deepEqual(caller.after, caller.before);
        assert.equal(caller.locationAfter, caller.locationBefore);
        assert.equal(caller.failed, exitCode !== 0);
        const invocation = JSON.parse(await readFile(path.join(fixture.root, "android", "invocation.json"), "utf8"));
        assert.equal(invocation.java, fixture.jdk);
        assert.equal(invocation.sdk, fixture.sdk);
        assert.equal(invocation.sdkRoot, fixture.sdk);
        assert.equal(invocation.cache, ownedCache
          ? path.join(fixture.root, ".data", "owned-cache") : path.join(fixture.root, ".tools", "gradle-cache"));
        assert.deepEqual(invocation.args, [
          "--no-daemon", "--console=plain", ":app:assembleDebug", ":app:testDebugUnitTest",
        ]);
      });
    }
  }
});

test("the public build command remains nonzero on Gradle failure", async (t) => {
  const fixture = await buildFixture(t);
  await assert.rejects(exec("pwsh", ["-NoProfile", "-NonInteractive", "-File",
    path.join(fixture.root, "scripts", "build-android.ps1"), "-Jdk", fixture.jdk, "-Sdk", fixture.sdk],
  { cwd: fixture.root, env: { ...fixture.env, FIXTURE_GRADLE_EXIT: "37" }, timeout: 20_000 }),
  (error) => error.code === 1 && /Android build failed with exit code 37/.test(error.stderr));
});
