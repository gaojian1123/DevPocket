import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { runCommand, spawnOwnedCommand, stopOwnedProcess } from "../process.mjs";
import { ownsLinuxListener, parseLinuxProcess } from "../linux-emulator.mjs";

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
  for (const cancelled of [false, true]) {
    await t.test(cancelled ? "cancellation" : "timeout", async (t) => {
      const directory = await fixture(t), marker = path.join(directory, "child.pid");
      const program = [
        "const {spawn}=require('node:child_process');const fs=require('node:fs');",
        "const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'inherit'});",
        `child.once('spawn',()=>fs.writeFileSync(${JSON.stringify(marker)},String(child.pid)));setInterval(()=>{},1000);`,
      ].join("\n");
      const cancellation = new AbortController();
      const running = runCommand(process.execPath, ["-e", program],
        { timeoutMs: cancelled ? 5000 : 1000, graceMs: 250, signal: cancellation.signal })
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
    ["scripts"], ["android", "gradle", "wrapper"], ["selected jdk", "bin"], ["selected sdk", "platforms", "android-35"],
  ]) await mkdir(path.join(directory, ...parts), { recursive: true });
  await writeFile(path.join(directory, "scripts", "build-android.ps1"), await readFile("scripts/build-android.ps1"));
  await writeFile(path.join(directory, "android", "gradle", "wrapper", "gradle-wrapper.jar"), "fixture");
  await writeFile(path.join(directory, "selected sdk", "platforms", "android-35", "android.jar"), "fixture");
  await writeFile(path.join(directory, "selected jdk", "bin", "java"),
    '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_JAVA" "$@"\n', { mode: 0o700 });
  const recorder = path.join(directory, "java.mjs");
  await writeFile(recorder, [
    "import {writeFileSync} from 'node:fs';",
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
    args: ["-Dorg.gradle.appname=gradlew", "-classpath", path.join(directory, "android", "gradle", "wrapper", "gradle-wrapper.jar"),
      "org.gradle.wrapper.GradleWrapperMain", "--no-daemon", "--console=plain",
      ":app:assembleDebug", ":app:testDebugUnitTest", ":app:lintDebug", ":app:assembleDebugAndroidTest"],
  });
  await assert.rejects(exec("pwsh", args, { cwd: directory, env: { ...env, FIXTURE_EXIT: "37" }, timeout: 20000 }),
    (error) => error.code === 1 && /Android build failed with exit code 37/.test(error.stderr));
});
