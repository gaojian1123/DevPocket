import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);

async function buildFixture(t) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/android-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of [
    "scripts", "android/gradle/wrapper", "selected jdk/bin", "inherited jdk/bin",
    "selected sdk/platforms/android-35", "inherited sdk/platforms/android-35",
  ]) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, "scripts", "build-android.ps1"), await readFile("scripts/build-android.ps1"));
  const wrapper = path.join(root, "android", "gradle", "wrapper", "gradle-wrapper.jar");
  await writeFile(wrapper, "synthetic wrapper");
  for (const name of ["selected", "inherited"]) {
    const java = path.join(root, `${name} jdk`, "bin", process.platform === "win32" ? "java.exe" : "java");
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(java, process.platform === "win32" ? "" :
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, "android", "gradle-fixture.mjs"))} "$@"\n`);
    if (process.platform !== "win32") await chmod(java, 0o755);
    await writeFile(path.join(root, `${name} sdk`, "platforms", "android-35", "android.jar"), "");
  }
  await writeFile(path.join(root, "android", "gradlew.bat"),
    `@echo off\r\n"${process.execPath}" "%~dp0gradle-fixture.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  await writeFile(path.join(root, "android", "gradle-fixture.mjs"), [
    "import {writeFileSync} from 'node:fs';",
    "import assert from 'node:assert/strict';",
    "const args=process.argv.slice(2);",
    `if(process.platform!=="win32") assert.deepEqual(args.splice(0,4),["-Dorg.gradle.appname=gradlew","-classpath",${JSON.stringify(wrapper)},"org.gradle.wrapper.GradleWrapperMain"]);`,
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
