import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { runCommand, spawnOwnedCommand, stopOwnedProcess } from "../process.mjs";
import { ownsLinuxListener, parseLinuxProcess } from "../linux-emulator.mjs";
import { createNativeLifecycleCapture } from "../native-lifecycle.mjs";
import { prepareAndroidRuntime } from "../android-runner.mjs";
import { waitForAndroid, withAndroidEmulator } from "../android-emulator.mjs";
import { cleanDeviceRun } from "../device-run.mjs";
import { createDeviceDiagnostics } from "../device-diagnostics.mjs";

const exec = promisify(execFile);
assert.equal(process.platform, "linux", "These real Linux lifecycle checks must run on the hosted Ubuntu job.");

async function fixture(t) {
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/linux-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readWhenReady(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await readFile(file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Owned Linux fixture did not become ready.");
}

async function alive(pid) {
  try { return parseLinuxProcess(await readFile(`/proc/${pid}/stat`, "utf8")).state !== "Z"; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

test("hosted preparation snapshots the JDK cache alias and trust store without changing their sources", async (t) => {
  const directory = await fixture(t), source = path.join(directory, "jdk"), alias = path.join(directory, "cache");
  const temporary = path.join(directory, "temporary"), store = path.join(directory, "trust-store");
  await mkdir(path.join(source, "bin"), { recursive: true });
  await mkdir(path.join(source, "lib", "security"), { recursive: true });
  await mkdir(temporary);
  await mkdir(store);
  await writeFile(path.join(source, "bin", "java"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(source, "bin", "java"), 0o755);
  await writeFile(path.join(source, "release"), 'JAVA_VERSION="25.0.1"\n');
  await writeFile(path.join(source, "lib", "src.zip"), "fixture-source");
  await symlink("lib/src.zip", path.join(source, "src.zip"));
  const certificate = path.join(store, "cacerts");
  await writeFile(certificate, "fixture-trust-store");
  await symlink(certificate, path.join(source, "lib", "security", "cacerts"));
  await symlink(source, alias);
  const environmentFile = path.join(directory, "environment"), pathFile = path.join(directory, "path");
  await writeFile(environmentFile, "");
  await writeFile(pathFile, "");
  const action = (await readFile(".github/actions/prepare-native/action.yml", "utf8")).replaceAll("\r\n", "\n");
  const step = action.split("    - name: Snapshot the selected JDK for bounded verification\n")[1]?.split("\n    - ")[0];
  assert.ok(step);
  const body = step.split("      run: |\n")[1].split("\n").map((line) => line.startsWith("        ") ? line.slice(8) : line).join("\n");
  const run = () => exec("bash", ["--noprofile", "--norc", "-c", body], {
    cwd: directory, timeout: 20000,
    env: { ...process.env, JAVA_HOME: alias, RUNNER_TEMP: temporary, GITHUB_ENV: environmentFile, GITHUB_PATH: pathFile },
  });
  await run();
  const environment = await readFile(environmentFile, "utf8"), snapshot = /^JAVA_HOME=(.+)$/m.exec(environment)?.[1];
  assert.ok(snapshot && path.dirname(snapshot) === temporary);
  assert.equal((await lstat(snapshot)).isSymbolicLink(), false);
  assert.equal((await lstat(path.join(snapshot, "lib", "security", "cacerts"))).isSymbolicLink(), false);
  assert.equal((await lstat(path.join(snapshot, "src.zip"))).isSymbolicLink(), true);
  assert.equal(await realpath(path.join(snapshot, "src.zip")), path.join(snapshot, "lib", "src.zip"));
  assert.equal(await readFile(path.join(snapshot, "lib", "security", "cacerts"), "utf8"), "fixture-trust-store");
  assert.equal(await readFile(certificate, "utf8"), "fixture-trust-store");
  assert.equal(await realpath(alias), source);
  assert.equal((await lstat(path.join(source, "lib", "security", "cacerts"))).isSymbolicLink(), true);
  assert.equal(await readFile(pathFile, "utf8"), `${snapshot}/bin\n`);
  await rm(path.join(source, "lib", "security"), { recursive: true });
  await symlink(store, path.join(source, "lib", "security"));
  await assert.rejects(run(), (error) => error.code === 1);
  assert.equal(await readFile(certificate, "utf8"), "fixture-trust-store");
  assert.equal(await readFile(environmentFile, "utf8"), environment);
});

test("short successful Linux commands keep their real exit status while the process table changes", async () => {
  for (let index = 0; index < 20; index++) {
    const result = await runCommand("/bin/true", [], { timeoutMs: 5000 });
    assert.equal(result.stdout, "");
  }
});

test("the Linux owner reaps detached descendants after an ordinary launcher exits", async (t) => {
  const directory = await fixture(t), marker = path.join(directory, "child.pid");
  const program = [
    "const {spawn}=require('node:child_process');const fs=require('node:fs');",
    "const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'inherit'});",
    `child.once('spawn',()=>{fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));process.exit(0)});`,
  ].join("\n");
  await runCommand(process.execPath, ["-e", program], { timeoutMs: 5000, graceMs: 500 });
  const pid = Number(await readFile(marker, "utf8"));
  assert.equal(await alive(pid), false, "The detached descendant must not survive a successful command.");
});

test("Linux timeout and cancellation terminate and reap only their owned process family", async (t) => {
  for (const [cancelled, privileged] of [[false, false], [true, false], [false, true], [true, true]]) {
    await t.test(`${privileged ? "privileged " : ""}${cancelled ? "cancellation" : "timeout"}`, async (t) => {
      const directory = await fixture(t), marker = path.join(directory, "child.pid");
      const program = [
        "const {spawn}=require('node:child_process');const fs=require('node:fs');",
        "const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'inherit'});",
        `child.once('spawn',()=>fs.writeFileSync(${JSON.stringify(marker)},String(child.pid)));setInterval(()=>{},1000);`,
      ].join("\n");
      const cancellation = new AbortController();
      const running = runCommand(process.execPath, ["-e", program],
        { timeoutMs: cancelled ? 5000 : 1000, graceMs: 250, signal: cancellation.signal, privileged })
        .then(() => ({ passed: true }), (error) => ({ error }));
      const pid = Number(await readWhenReady(marker));
      if (cancelled) cancellation.abort();
      const outcome = await running;
      assert.ok(outcome.error, "An interrupted command must fail, not return success.");
      assert.equal(outcome.error.processTreeStopped, true);
      assert.equal(await alive(pid), false);
      assert.equal(await alive(process.pid), true);
    });
  }
});

test("Linux listener ownership distinguishes two live supervised servers", async (t) => {
  const directory = await fixture(t);
  const workers = [];
  t.after(async () => {
    for (const worker of workers) {
      await stopOwnedProcess(worker.child);
      await worker.done;
    }
  });
  for (let index = 0; index < 2; index++) {
    const marker = path.join(directory, `${index}.json`);
    const program = `const net=require('node:net'),fs=require('node:fs');const server=net.createServer();` +
      `server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({port:server.address().port,pid:process.pid})));`;
    const child = spawnOwnedCommand(process.execPath, ["-e", program], { timeoutMs: 15000, persistent: true });
    child.stdout.resume();
    child.stderr.resume();
    const done = once(child, "close");
    workers.push({ child, done, ...JSON.parse(await readWhenReady(marker)) });
  }
  assert.equal(await ownsLinuxListener(workers[0].port, workers[0].child.pid), true);
  assert.equal(await ownsLinuxListener(workers[1].port, workers[0].child.pid), false);
});

test("the real Linux PowerShell build entrypoint invokes the pinned wrapper with the explicit toolchain", async (t) => {
  const directory = await fixture(t);
  for (const parts of [
    ["scripts"], ["android", "gradle", "wrapper"], ["selected jdk", "bin"], ["selected sdk", "platforms", "android-37.2"],
  ]) await mkdir(path.join(directory, ...parts), { recursive: true });
  await writeFile(path.join(directory, "scripts", "build-android.ps1"), await readFile("scripts/build-android.ps1"));
  await writeFile(path.join(directory, "android", "gradle", "wrapper", "gradle-wrapper.jar"), "fixture");
  await writeFile(path.join(directory, "selected sdk", "platforms", "android-37.2", "android.jar"), "fixture");
  await writeFile(path.join(directory, "selected jdk", "bin", "java"),
    '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_JAVA" "$@"\n', { mode: 0o700 });
  const recorder = path.join(directory, "java.mjs");
  await writeFile(recorder, [
    "import {writeFileSync} from 'node:fs';",
    "if(process.argv.length===3 && process.argv[2]==='-version'){console.error('openjdk version \"25.0.1\"');process.exit(0);}",
    "writeFileSync('invocation.json',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),",
    "java:process.env.JAVA_HOME,sdk:process.env.ANDROID_HOME,sdkRoot:process.env.ANDROID_SDK_ROOT,cache:process.env.GRADLE_USER_HOME}));",
    "process.exit(Number(process.env.FIXTURE_EXIT??0));",
  ].join("\n"));
  const jdk = path.join(directory, "selected jdk"), sdk = path.join(directory, "selected sdk");
  const args = ["-NoProfile", "-NonInteractive", "-File", path.join(directory, "scripts", "build-android.ps1"),
    "-Jdk", jdk, "-Sdk", sdk, "-Lint", "-Instrumentation"];
  const env = { ...process.env, JAVA_HOME: "/inherited/jdk", ANDROID_HOME: "/inherited/sdk",
    ANDROID_SDK_ROOT: "/another/sdk", GRADLE_USER_HOME: "/inherited/cache",
    FIXTURE_NODE: process.execPath, FIXTURE_JAVA: recorder };
  await exec("pwsh", args, { cwd: directory, env, timeout: 20000 });
  const invocation = JSON.parse(await readFile(path.join(directory, "android", "invocation.json"), "utf8"));
  assert.deepEqual(invocation, {
    cwd: path.join(directory, "android"), java: jdk, sdk, sdkRoot: sdk, cache: path.join(directory, ".tools", "gradle-cache"),
    args: ["--enable-native-access=ALL-UNNAMED", "-Dorg.gradle.appname=gradlew", "-classpath", path.join(directory, "android", "gradle", "wrapper", "gradle-wrapper.jar"),
      "org.gradle.wrapper.GradleWrapperMain", "--no-daemon", "--console=plain",
      ":app:assembleDebug", ":app:testDebugUnitTest", ":app:lintDebug", ":app:assembleDebugAndroidTest"],
  });

  await assert.rejects(exec("pwsh", args, { cwd: directory, env: { ...env, FIXTURE_EXIT: "37" }, timeout: 20000 }),
    (error) => error.code === 1 && /Android build failed with exit code 37/.test(error.stderr));
});

async function nativeBuildFixture(t) {
  const root = await fixture(t);
  const jdk = path.join(root, "selected jdk"), sdk = path.join(root, "selected sdk");
  const image = path.join("system-images", "android-37.0", "google_apis", "x86_64");
  const imageDir = path.join(sdk, image);
  const javaPath = path.join(jdk, "bin", "java"), adbPath = path.join(sdk, "platform-tools", "adb");
  const executable = path.join(sdk, "emulator", "emulator");
  for (const directory of [path.join(root, "scripts"), path.join(root, "android", "gradle", "wrapper"),
    path.dirname(javaPath), path.dirname(adbPath), path.dirname(executable), imageDir,
    path.join(sdk, "platforms", "android-37.2"), path.join(root, ".tools", "gradle-cache")]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(path.join(root, "scripts", "build-android.ps1"), await readFile("scripts/build-android.ps1"));
  await writeFile(path.join(root, "android", "gradle", "wrapper", "gradle-wrapper.jar"), "fixture");
  await writeFile(path.join(sdk, "platforms", "android-37.2", "android.jar"), "fixture");
  await writeFile(path.join(imageDir, "system.img"), "fixture");
  await writeFile(path.join(imageDir, "source.properties"), "Pkg.Revision=9\n");
  await writeFile(adbPath, "#!/bin/sh\nprintf 'Android Debug Bridge version 1.0.41\\n'\n", { mode: 0o700 });
  await writeFile(executable, "#!/bin/sh\nprintf 'Android emulator version 37.2.12.0\\n'\n", { mode: 0o700 });
  await writeFile(javaPath, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs'),path=require('node:path');",
    `const root=${JSON.stringify(root)};`,
    "if(process.argv.includes('-version')) { process.stderr.write('openjdk version \"25.0.1\"\\n'); }",
    "else {",
    " const cache=process.env.GRADLE_USER_HOME; fs.mkdirSync(cache,{recursive:true});",
    " fs.writeFileSync(path.join(cache,'build-only'),'synthetic dependency');",
    " fs.writeFileSync(path.join(root,'android','invocation.json'),JSON.stringify({cache,args:process.argv.slice(2)}));",
    " const mode=fs.readFileSync(path.join(root,'mode.txt'),'utf8');",
    " if(mode==='cancel') setInterval(()=>{},1000);",
    " else if(mode==='fail') process.exitCode=37;",
    " else for(const [relative,bytes] of [['debug/app-debug.apk','synthetic-app'],",
    "   ['androidTest/debug/app-debug-androidTest.apk','synthetic-tests']]) {",
    "  const file=path.join(root,'android','app','build','outputs','apk',relative);",
    "  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);",
    " }",
    "}",
  ].join("\n"), { mode: 0o700 });
  await writeFile(path.join(root, ".tools", "gradle-cache", "preserved"), "shared cache");
  await writeFile(path.join(root, "mode.txt"), "success");
  await writeFile(path.join(root, "package.json"), '{"type":"commonjs"}\n');
  await writeFile(path.join(root, ".gitignore"), ".data/\n.tools/\nandroid/\n");
  await exec("git", ["init", "--quiet"], { cwd: root, timeout: 10000 });
  await exec("git", ["add", ".gitignore"], { cwd: root, timeout: 10000 });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${path.join(root, ".git", "hooks")}`,
    "commit", "--quiet", "-m", "fixture"], { cwd: root, timeout: 10000 });
  return { root, jdk, sdk, image, imageDir, javaPath, adbPath, executable };
}

async function ownedBuildRun(identity, name) {
  const directory = path.join(identity.root, ".data", name), runId = randomUUID();
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "owner.json"), JSON.stringify({
    version: 1, root: identity.root, runId, pid: process.pid,
  }));
  return { ...identity, directory, runId };
}

test("hosted native preparation reclaims only its completed run cache and preserves APK/source evidence", async (t) => {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  const fixture = await nativeBuildFixture(t);
  const identity = await ownedBuildRun(fixture, "native success"), report = {};
  const artifacts = await prepareAndroidRuntime(identity, report);
  const invocation = JSON.parse(await readFile(path.join(fixture.root, "android", "invocation.json"), "utf8"));
  assert.equal(invocation.cache, path.join(identity.directory, "gradle-cache"));
  assert.deepEqual(invocation.args.slice(-3), [":app:assembleDebug", ":app:testDebugUnitTest", ":app:assembleDebugAndroidTest"]);
  await assert.rejects(readFile(path.join(invocation.cache, "build-only")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(fixture.root, ".tools", "gradle-cache", "preserved"), "utf8"), "shared cache");
  assert.equal(await readFile(artifacts.apk, "utf8"), "synthetic-app");
  assert.equal(await readFile(artifacts.testApk, "utf8"), "synthetic-tests");
  assert.equal(report.apkSha256, createHash("sha256").update("synthetic-app").digest("hex"));
  assert.equal(report.testApkSha256, createHash("sha256").update("synthetic-tests").digest("hex"));
  assert.match(report.source.head, /^[a-f0-9]{40}$/);
  assert.match(report.source.fingerprint, /^[a-f0-9]{64}$/);

  for (const mode of ["fail", "cancel"]) {
    const failed = await ownedBuildRun(fixture, `native-${mode}`);
    await writeFile(path.join(fixture.root, "mode.txt"), mode);
    const cancellation = new AbortController();
    const running = prepareAndroidRuntime(failed, {}, cancellation.signal).then(
      () => ({ passed: true }), (error) => ({ error }));
    let outcome;
    try {
      if (mode === "cancel") {
        await readWhenReady(path.join(failed.directory, "gradle-cache", "build-only"));
        cancellation.abort();
      }
      outcome = await running;
    } finally {
      cancellation.abort();
      await running;
    }
    assert.ok(outcome.error, "A failed or cancelled build cannot be accepted.");
    assert.equal(outcome.error.processTreeStopped, true);
    await cleanDeviceRun(fixture.root, failed.directory, failed.runId);
    await assert.rejects(readFile(path.join(failed.directory, "gradle-cache", "build-only")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(fixture.root, ".tools", "gradle-cache", "preserved"), "utf8"), "shared cache");
  }
});

test("the real owned toolchain probes do not retain arbitrary version suffixes in device evidence", async (t) => {
  const fixture = await nativeBuildFixture(t);
  const credential = `25-dpp_${"A".repeat(43)}`;
  await writeFile(fixture.javaPath, (await readFile(fixture.javaPath, "utf8")).replace("25.0.1", credential));
  const report = {};
  await prepareAndroidRuntime(await ownedBuildRun(fixture, "version-projection"), report, undefined, { buildApks: false });
  assert.equal(report.toolchain.java, null);
  assert.ok(!JSON.stringify(report).includes(credential));
});

test("unconfirmed preparation cleanup holds owned data and the Linux lease record", async (t) => {
  for (const nextReady of [true, false, "missing-owner"]) {
    const fixture = await nativeBuildFixture(t), owner = randomUUID();
    const directory = path.join(fixture.root, ".data", "unconfirmed");
    const diagnostics = await createDeviceDiagnostics({ root: fixture.root, runId: owner });
    let attempts = 0;
    await assert.rejects(withAndroidEmulator({
      repo: fixture.root, directory, owner, sdk: fixture.sdk, emulatorSdk: fixture.sdk, image: fixture.image, jdk: fixture.jdk, diagnostics,
      prepare: async () => {
        await mkdir(path.join(directory, "gradle-cache"));
        await writeFile(path.join(directory, "gradle-cache", "preserved"), "unconfirmed command data");
        if (nextReady === "missing-owner") {
          await rm(path.join(directory, "owner.json"));
          throw new Error("Synthetic owner record lost during preparation.");
        }
        await waitForAndroid(async () => {
          if (++attempts === 1) throw Object.assign(new Error("Synthetic missing cleanup receipt."), { processTreeStopped: false });
          return nextReady;
        }, "Synthetic boot", nextReady ? 2000 : 50);
        assert.fail("Unconfirmed cleanup must not be retried into readiness.");
      },
    }, () => assert.fail("A failed preparation must not start native acceptance.")),
    (error) => error.cleanup === "failed" && error.cleanupErrors.some((message) => /cleanup.*unconfirmed|command.*cleanup/i.test(message)));
    assert.equal(attempts, nextReady === "missing-owner" ? 0 : 1);
    assert.equal(await readFile(path.join(directory, "gradle-cache", "preserved"), "utf8"), "unconfirmed command data");
    const lease = JSON.parse(await readFile(path.join(fixture.root, ".data", "linux-emulator.lock"), "utf8"));
    assert.equal(lease.runId, owner);
    const evidence = diagnostics.snapshot();
    assert.equal(evidence.primary.phase, "prepare");
    assert.equal(evidence.phase, "cleanup");
    assert.ok(evidence.secondary.some((issue) => issue.operation === "cleanup"));
  }
});

test("the hosted startup CLI preserves the owned process exit when recovery cleanup rejects ownership", async (t) => {
  const fixture = await nativeBuildFixture(t);
  await writeFile(path.join(fixture.root, "scripts", "test-android.ps1"), [
    "param([switch]$StartupDiagnostic,$Base,$Variant,$RunDirectory,$Owner)",
    "New-Item -ItemType Directory -Path $RunDirectory -Force | Out-Null",
    "@{version=1;root=(Get-Location).Path;runId='foreign-owner';pid=$PID} | ConvertTo-Json | Set-Content (Join-Path $RunDirectory 'owner.json')",
    "exit 37",
  ].join("\n"));
  const environment = { ...process.env, GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
  delete environment.NODE_TEST_CONTEXT;
  await assert.rejects(exec(process.execPath, [path.resolve("scripts/native-startup.mjs"), "--base", "HEAD",
    "--directory", path.join(fixture.root, ".data", "startup-entry")],
  { cwd: fixture.root, env: environment, timeout: 20000 }), (error) => {
    assert.equal(error.code, 1);
    const value = JSON.parse(error.stdout.trim());
    assert.equal(value.exitCode, 37);
    assert.equal(value.recoveryCleanup, "failed");
    assert.equal(value.failure.exitCode, 37);
    assert.ok(!error.stdout.includes(fixture.root));
    return true;
  });
});

test("startup execution and report-write failure survive the real hosted CLI and public collector", async (t) => {
  const fixture = await nativeBuildFixture(t), directory = path.join(fixture.root, ".data", "ci", "native-startup");
  const entry = path.resolve("scripts/native-startup.mjs");
  const wrapper = (await readFile("scripts/test-android.ps1", "utf8"))
    .replace("(Join-Path $PSScriptRoot 'native-startup.mjs')", `'${entry.replaceAll("'", "''")}'`);
  await writeFile(path.join(fixture.root, "scripts", "test-android.ps1"), wrapper);
  await writeFile(fixture.javaPath, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');",
    `fs.mkdirSync(${JSON.stringify(path.join(directory, "startup-report.json"))},{recursive:true});`,
    "process.exit(37);",
  ].join("\n"));
  const env = { ...process.env, GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(exec(process.execPath, [entry, "--base", "HEAD", "--directory", directory,
    "--sdk", fixture.sdk, "--jdk", fixture.jdk, "--image", fixture.image],
  { cwd: fixture.root, env, timeout: 30000 }), (error) => {
    assert.equal(error.code, 1);
    const result = JSON.parse(error.stdout.trim());
    assert.equal(result.startup.deviceDiagnostics.primary.phase, "prepare");
    assert.equal(result.startup.deviceDiagnostics.primary.operation, "jdk");
    assert.equal(result.startup.deviceDiagnostics.primary.exitCode, 37);
    assert.equal(result.startup.reportFailure.reason, "report-write");
    return true;
  });
  const entryReport = JSON.parse(await readFile(path.join(directory, "startup-entry-report.json"), "utf8"));
  await assert.rejects(exec(process.execPath, [path.resolve("scripts/verification-diagnostics.mjs"),
    "--directory", directory, "--job", "startup", "--owner", entryReport.runId], { cwd: fixture.root, env, timeout: 20000 }), (error) => error.code === 1);
  const report = JSON.parse(await readFile(path.join(directory, "verification-diagnostics.json"), "utf8"));
  assert.equal(report.reportOrigin, "owned-entry-fallback");
  assert.equal(report.startup.deviceDiagnostics.primary.exitCode, 37);
  assert.equal(report.startup.reportFailure.reason, "report-write");
});

async function nativeCommand(t, file, args, options = {}) {
  const child = spawnOwnedCommand(file, args, { timeoutMs: 5000, graceMs: 250, nativeLifecycle: true, ...options });
  child.stdout.resume();
  child.stderr.resume();
  const capture = createNativeLifecycleCapture();
  child.stdio[3].on("data", capture.data);
  child.stdio[3].once("end", capture.end);
  child.stdio[3].once("error", capture.fail);
  const done = once(child, "close");
  t.after(async () => { await stopOwnedProcess(child); await done; });
  return { child, capture, done };
}

test("dedicated native telemetry distinguishes spawn errno from an actual child return code", async (t) => {
  const directory = await fixture(t);
  const missing = await nativeCommand(t, path.join(directory, "private-missing-executable"), []);
  await missing.done;
  const failure = missing.capture.snapshot();
  assert.equal(failure.availability, "complete");
  assert.equal(failure.started, false);
  assert.equal(failure.returnCode, "unknown");
  assert.equal(failure.events.find((event) => event.phase === "spawn-failed").errno, 2);
  assert.ok(!JSON.stringify(failure).includes("private-missing-executable"));

  const native = await nativeCommand(t, process.execPath, ["-e",
    'console.log(\'{"version":1,"sequence":1,"phase":"native-exited","returnCode":0,"signalNumber":0}\');process.exitCode=7']);
  await native.done;
  const exited = native.capture.snapshot();
  assert.equal(exited.availability, "complete");
  assert.equal(exited.returnCode, 7, "Child stdout cannot forge the supervisor-only lifecycle channel.");
  assert.equal(exited.exitContext, "before-cleanup");
});

test("native signal status is not replaced by the supervisor's process exit status", async (t) => {
  const native = await nativeCommand(t, process.execPath, ["-e", "process.kill(process.pid,'SIGTERM')"]);
  await native.done;
  const evidence = native.capture.snapshot();
  assert.equal(evidence.returnCode, -15);
  assert.equal(evidence.signalNumber, 15);
  assert.notEqual(native.child.exitCode, evidence.returnCode);
});

test("stdin closure records a live native child before confirmed cleanup kills it", async (t) => {
  const directory = await fixture(t), marker = path.join(directory, "native.pid");
  const native = await nativeCommand(t, process.execPath, ["-e",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`]);
  const pid = Number(await readWhenReady(marker));
  native.child.stdin.end();
  await native.done;
  const evidence = native.capture.snapshot();
  const stop = evidence.events.find((event) => event.phase === "stop-requested");
  assert.equal(stop.reason, "stdin-eof");
  assert.equal(stop.nativeAlive, true);
  assert.equal(evidence.returnCode, -9);
  assert.equal(evidence.exitContext, "during-cleanup");
  assert.equal(await alive(pid), false);
});
