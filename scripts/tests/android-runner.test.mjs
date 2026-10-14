import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const exec = promisify(execFile);
const entry = path.resolve("scripts/android-runner.mjs");

const homeComponent = "com.example.launcher/.Home";
const homeActivity = [
  "  topResumedActivity=ActivityRecord{123 u0 com.example.launcher/.Home t7}",
  "  * Hist #0: ActivityRecord{123 u0 com.example.launcher/.Home t7}",
  "    mActivityComponent=com.example.launcher/.Home",
  "    state=RESUMED delayedResume=false finishing=false",
  "    mVisibleRequested=true mVisible=true mClientVisible=true reportedDrawn=true reportedVisible=true",
  "    mNumInterestingWindows=1 mNumDrawnWindows=1 allDrawn=true lastAllDrawn=false)",
  "    startingData=null firstWindowDrawn=true mIsExiting=false",
].join("\n");
const homeWindows = "  Display: mDisplayId=0 (organized)\n" +
  "  mCurrentFocus=Window{123 u0 com.example.launcher/com.example.launcher.Home}\n";
const homeProbe = { resolved: homeComponent, activities: homeActivity, windows: homeWindows, anrs: "" };

test("boot completion and nominal focus do not admit an undrawn HOME window", async () => {
  const { androidHomeState } = await import("../android-home.mjs");
  assert.equal(androidHomeState(homeProbe).status, "ready");
  for (const activities of [
    homeActivity.replace("reportedDrawn=true", "reportedDrawn=false"),
    homeActivity.replace("allDrawn=true", "allDrawn=false"),
    homeActivity.replace("mVisible=true", "mVisible=false"),
    homeActivity.replace("firstWindowDrawn=true", "firstWindowDrawn=false"),
    homeActivity.replace("state=RESUMED", "state=PAUSED"),
    homeActivity.replace("mActivityComponent=com.example.launcher/.Home", "mActivityComponent=com.example.foreign/.Other"),
  ]) assert.equal(androidHomeState({ ...homeProbe, activities }).status, "pending");
  assert.equal(androidHomeState({ ...homeProbe, windows: homeWindows.replace("com.example.launcher.Home", "com.example.launcher.Other") }).status, "pending");
  assert.equal(androidHomeState({ ...homeProbe, resolved: "No activity found" }).status, "pending");
  assert.equal(androidHomeState({ ...homeProbe, activities: "" }).status, "pending");
});

test("a visible or already recorded HOME ANR cannot be hidden by later focused-window evidence", async () => {
  const { androidHomeState } = await import("../android-home.mjs");
  for (const evidence of [
    { ...homeProbe, windows: " Display: mDisplayId=0\n mCurrentFocus=Window{123 u0 Application Not Responding: com.example.launcher}" },
    { ...homeProbe, anrs: "01-01 00:00:00 1 2 I am_anr : [0,123,com.example.launcher,123,Input dispatching timed out]" },
  ]) assert.deepEqual(androidHomeState(evidence), { status: "blocked", reason: "launcher-anr" });
});

test("the real readiness driver uses only read probes and shares the original absolute boot deadline", async () => {
  const { waitForAndroidHome } = await import("../android-home.mjs");
  const reads = [], observations = [];
  let attempts = 0;
  const deadline = Date.now() + 3000;
  const result = await waitForAndroidHome(async (args, timeout) => {
    reads.push({ args, timeout, remaining: deadline - Date.now() });
    if (args.includes("resolve-activity")) return { stdout: homeComponent };
    if (args.includes("activities")) return { stdout: attempts++ === 0 ? homeActivity.replace("reportedDrawn=true", "reportedDrawn=false") : homeActivity };
    if (args.includes("displays")) return { stdout: homeWindows };
    return { stdout: "" };
  }, { deadline, observe: (state) => { observations.push(state); } });
  assert.equal(result.status, "ready");
  assert.deepEqual(observations.map((state) => state.reason), ["home-undrawn", "home-drawn-focused"]);
  assert.ok(reads.every(({ args, timeout, remaining }) =>
    !args.includes("input") && !args.includes("settings") && timeout <= remaining + 5));
  let called = false;
  await assert.rejects(waitForAndroidHome(async () => { called = true; },
    { deadline: Date.now() - 1 }), { diagnosticCode: "readiness-timeout" });
  assert.equal(called, false);
});

test("HOME readiness preserves cancellation, uncertain cleanup and a reported ANR without retrying it", async () => {
  const { waitForAndroidHome } = await import("../android-home.mjs");
  const cancelled = new AbortController();
  cancelled.abort(new Error("Owned probe cancelled"));
  await assert.rejects(waitForAndroidHome(async () => assert.fail("Cannot probe after cancellation"),
    { deadline: Date.now() + 1000, signal: cancelled.signal }), /Owned probe cancelled/);
  const failure = Object.assign(new Error("Unconfirmed cleanup"), { processTreeStopped: false });
  await assert.rejects(waitForAndroidHome(async () => { throw failure; },
    { deadline: Date.now() + 1000 }), (error) => error === failure);
  let calls = 0;
  await assert.rejects(waitForAndroidHome(async (args) => {
    calls++;
    if (args.includes("resolve-activity")) return { stdout: homeComponent };
    if (args.includes("activities")) return { stdout: homeActivity };
    if (args.includes("displays")) return { stdout: homeWindows };
    return { stdout: "01-01 I am_anr : [0,123,com.example.launcher,0,No focused window]" };
  }, { deadline: Date.now() + 1000 }), { diagnosticCode: "resource-unavailable", readinessReason: "launcher-anr" });
  assert.equal(calls, 4);
});

test("missing emulator prerequisites produce blocked evidence without touching an existing run", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const parent = await mkdtemp(path.resolve(".data/tests/emulator-runner-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "owned");
  await assert.rejects(exec(process.execPath, [entry, "--directory", directory, "--sdk", path.join(parent, "missing")]));
  const report = JSON.parse(await readFile(path.join(directory, "device-report.json"), "utf8"));
  assert.equal(report.status, "blocked");
  assert.equal(report.tests, 0);
  await writeFile(path.join(directory, "retained.txt"), "preserve");
  await assert.rejects(exec(process.execPath, [entry, "--directory", directory, "--sdk", path.join(parent, "missing")]));
  assert.equal(await readFile(path.join(directory, "retained.txt"), "utf8"), "preserve");
});

test("instrumentation success requires actual tests and rejects skipped, crashed or truncated output", async () => {
  const { instrumentationResult } = await import("../android-runner.mjs");
  const success = "INSTRUMENTATION_STATUS: class=example.NativeTest\nINSTRUMENTATION_STATUS: test=works\n" +
    "INSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n";
  assert.deepEqual(instrumentationResult(success, "example.NativeTest"), { tests: 1, status: "passed" });
  for (const invalid of [
    "OK (0 tests)\nINSTRUMENTATION_CODE: -1\n",
    success.replace("STATUS_CODE: 0", "STATUS_CODE: -3"),
    success.replace("INSTRUMENTATION_CODE: -1", "INSTRUMENTATION_CODE: 0"),
    success.replace("OK (1 test)", "FAILURES!!!"),
    success.replace("example.NativeTest", "example.UnrelatedTest"),
  ]) assert.throws(() => instrumentationResult(invalid, "example.NativeTest"));
});

test("APK discovery includes additional regression classes while refusing real-CLI test selection", async () => {
  const { instrumentationClasses } = await import("../android-runner.mjs");
  const names = ["NativeFlowTest", "AdaptiveLayoutTest", "FixtureFlowTest", "FeatureFlowTest"];
  const output = names.map((name) => `INSTRUMENTATION_STATUS: class=dev.devpocket.app.${name}`).join("\n") +
    "\nINSTRUMENTATION_CODE: -1\n";
  assert.deepEqual(instrumentationClasses(output), names.map((name) => `dev.devpocket.app.${name}`).sort());
  assert.throws(() => instrumentationClasses(output.replace("FeatureFlowTest", "ConnectedFlowTest")));
  assert.throws(() => instrumentationClasses("INSTRUMENTATION_CODE: -1\n"));
});

test("cancelled-run cleanup cannot delete another run's AVD, build cache or fixture credentials", async (t) => {
  const { cleanDeviceRun } = await import("../device-run.mjs");
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/cleanup-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = randomUUID();
  await writeFile(path.join(directory, "owner.json"), JSON.stringify({
    version: 1, root: process.cwd(), runId: owner, pid: process.pid,
  }));
  await mkdir(path.join(directory, "avd"));
  await writeFile(path.join(directory, "avd", "preserved.txt"), "owned by the other run");
  await mkdir(path.join(directory, "gradle-cache"));
  await writeFile(path.join(directory, "gradle-cache", "preserved.txt"), "owned build cache");
  await assert.rejects(cleanDeviceRun(process.cwd(), directory, randomUUID()), /ownership/i);
  assert.equal(await readFile(path.join(directory, "avd", "preserved.txt"), "utf8"), "owned by the other run");
  assert.equal(await readFile(path.join(directory, "gradle-cache", "preserved.txt"), "utf8"), "owned build cache");
  await cleanDeviceRun(process.cwd(), directory, owner);
  await assert.rejects(readFile(path.join(directory, "avd", "preserved.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(directory, "gradle-cache", "preserved.txt")), { code: "ENOENT" });
});

test("cache-only cleanup validates ownership without removing the remaining run data", async (t) => {
  const { cleanDeviceRun } = await import("../device-run.mjs");
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/cache-only-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = randomUUID();
  await writeFile(path.join(directory, "owner.json"), JSON.stringify({
    version: 1, root: process.cwd(), runId: owner, pid: process.pid,
  }));
  for (const name of ["avd", "gradle-cache"]) {
    await mkdir(path.join(directory, name));
    await writeFile(path.join(directory, name, "preserved"), name);
  }
  await assert.rejects(cleanDeviceRun(process.cwd(), directory, randomUUID(), { cacheOnly: true }), /ownership/i);
  await cleanDeviceRun(process.cwd(), directory, owner, { cacheOnly: true });
  await assert.rejects(readFile(path.join(directory, "gradle-cache", "preserved")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(directory, "avd", "preserved"), "utf8"), "avd");
  await rm(path.join(directory, "owner.json"));
  await assert.rejects(cleanDeviceRun(process.cwd(), directory, owner, { cacheOnly: true }), /owner/i);
  assert.equal(await cleanDeviceRun(process.cwd(), directory, owner), false);
});

test("cache cleanup rejects a replaced run directory and never follows a cache link", async (t) => {
  const { cleanDeviceRun } = await import("../device-run.mjs");
  await mkdir(".data/tests", { recursive: true });
  const parent = await mkdtemp(path.resolve(".data/tests/cache-links-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "owned"), foreign = path.join(parent, "foreign"), owner = randomUUID();
  await mkdir(directory);
  await mkdir(foreign);
  await writeFile(path.join(foreign, "preserved"), "unrelated data");
  await writeFile(path.join(directory, "owner.json"), JSON.stringify({
    version: 1, root: process.cwd(), runId: owner, pid: process.pid,
  }));
  await symlink(directory, path.join(parent, "alias"), "junction");
  await assert.rejects(cleanDeviceRun(process.cwd(), path.join(parent, "alias"), owner, { cacheOnly: true }), /ownership/i);
  await symlink(foreign, path.join(directory, "gradle-cache"), "junction");
  await cleanDeviceRun(process.cwd(), directory, owner, { cacheOnly: true });
  assert.equal(await readFile(path.join(foreign, "preserved"), "utf8"), "unrelated data");
  await assert.rejects(cleanDeviceRun(process.cwd(), directory, owner, { cacheOnly: "all" }), /mode/i);
});

test("readiness polling cannot retry or wrap an explicitly unconfirmed command cleanup", async (t) => {
  const { waitForAndroid } = await import("../android-emulator.mjs");
  for (const nextReady of [true, false]) {
    await t.test(nextReady ? "later readiness" : "later timeout", async () => {
      const failure = Object.assign(new Error("Synthetic unconfirmed command."), { processTreeStopped: false });
      let attempts = 0;
      await assert.rejects(waitForAndroid(async () => {
        if (++attempts === 1) throw failure;
        return nextReady;
      }, "Synthetic boot", nextReady ? 2000 : 50), (error) => error === failure);
      assert.equal(attempts, 1);
    });
  }
});

test("readiness polling still retries ordinary transient failures with no cleanup uncertainty", async () => {
  const { waitForAndroid } = await import("../android-emulator.mjs");
  for (const receipt of [undefined, true]) {
    let attempts = 0;
    await waitForAndroid(async () => {
      if (++attempts === 1) throw Object.assign(new Error("Not ready."), { processTreeStopped: receipt });
      return true;
    }, "Transient boot", 2000);
    assert.equal(attempts, 2);
  }
});

test("a live device handle is revoked when a worker exits or listener ownership changes", async () => {
  const { createLiveDeviceGuard } = await import("../android-emulator.mjs");
  const worker = () => ({ child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }), settled: false });
  const adb = worker(), emulator = worker();
  let probes = 0;
  const guard = createLiveDeviceGuard([adb, emulator], async () => { probes++; });
  await guard.verify();
  assert.equal(probes, 1);
  emulator.child.emit("exit", 1);
  assert.equal(guard.signal.aborted, true);
  await assert.rejects(guard.verify(), /exited|unavailable/);
  assert.equal(probes, 1, "A replacement listener must not revive an exited owned worker.");
  guard.close();
  let replaced = false;
  const live = createLiveDeviceGuard([worker(), worker()], async () => {
    if (replaced) throw new Error("Listener ownership mismatch.");
  });
  await live.verify();
  replaced = true;
  await assert.rejects(live.verify(), /ownership mismatch/);
  assert.equal(live.signal.aborted, true);
  live.close();
});

test("caller cancellation during ownership inspection is not latched as an unexpected worker failure", async () => {
  const { createLiveDeviceGuard } = await import("../android-emulator.mjs");
  const worker = { child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }), settled: false };
  const cancellation = new AbortController();
  let finish;
  const inspected = new Promise((resolve) => { finish = resolve; });
  const guard = createLiveDeviceGuard([worker], () => inspected, cancellation.signal);
  const verification = guard.verify();
  cancellation.abort(new Error("Manual stop requested."));
  finish();
  await assert.rejects(verification, /Manual stop/);
  assert.equal(guard.failure, undefined);
  guard.close();
});

test("unconfirmed supervisor exit cannot be accepted as completed resource cleanup", async () => {
  const { trackManagedCommand, requireManagedCleanup } = await import("../android-emulator.mjs");
  for (const [platform, acknowledged] of [["linux", false], ["linux", true], ["win32", false]]) {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    });
    const output = new PassThrough();
    output.resume();
    const state = trackManagedCommand(child, output, platform);
    child.stderr.write(acknowledged ? "DEVPOCKET_OWNED_TREE_STOPPED\n" : "Owned descendants did not confirm exit.\n");
    child.emit("close", 1);
    await state.done;
    if (!acknowledged) assert.throws(() => requireManagedCleanup(state), /cleanup.*confirm/i);
    else assert.doesNotThrow(() => requireManagedCleanup(state));
  }
});

test("the Linux supervisor frames its acknowledgement after unterminated worker stderr", async () => {
  const file = path.resolve("scripts/owned-command-linux.py");
  const program = "import runpy,sys\nmodule=runpy.run_path(sys.argv[1])\nsys.stderr.write('partial')\nmodule['write_cleanup_ack']()";
  const result = await exec("python", ["-c", program, file], { timeout: 10000 });
  assert.deepEqual(result.stderr.split(/\r?\n/), ["partial", "DEVPOCKET_OWNED_TREE_STOPPED", ""]);
});
