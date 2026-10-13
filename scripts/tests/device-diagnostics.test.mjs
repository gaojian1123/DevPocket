import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runNativeCase } from "../android-runner.mjs";
import { runCommand } from "../process.mjs";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { finished } from "node:stream/promises";
import { createBoundedWorkerLog } from "../bounded-worker-log.mjs";

const exec = promisify(execFile);

test("fixture instrumentation and its live worker log use separate exclusive files", async (t) => {
  for (const liveWorker of [false, true]) {
    await t.test(liveWorker ? "with a live fixture worker log" : "without a fixture worker log", async (t) => {
      await mkdir(".data/tests", { recursive: true });
      const directory = await mkdtemp(path.resolve(".data/tests/device-log-namespace-"));
      let worker;
      t.after(async () => {
        if (worker) { worker.end(); await finished(worker); }
        await rm(directory, { recursive: true, force: true });
      });
      if (liveWorker) {
        worker = createBoundedWorkerLog(path.join(directory, "fixture.log"));
        await new Promise((resolve, reject) => worker.write("PRIVATE_FIXTURE_WORKER\n", (error) => error ? reject(error) : resolve()));
      }
      const output = "INSTRUMENTATION_STATUS: class=dev.devpocket.app.FixtureFlowTest\n" +
        "INSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n";
      const device = { root: process.cwd(), directory, runId: randomUUID(), adb: async (args) =>
        runCommand(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(args.includes("instrument") ? output : "Success\n")})`],
          { cwd: directory, timeoutMs: 15000 }) };
      const result = await runNativeCase(device, "fixture", "FixtureFlowTest");
      assert.equal(result.status, "passed");
      assert.equal(result.tests, 1);
      if (worker) {
        assert.equal(await readFile(path.join(directory, "fixture.log"), "utf8"), "PRIVATE_FIXTURE_WORKER\n");
        assert.equal(await readFile(path.join(directory, "case-fixture.log"), "utf8"), output);
      }
    });
  }
});

test("the actual native case preserves an instrumentation failure when its crash collector also fails", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/device-diagnostic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failed = [
    "INSTRUMENTATION_STATUS: class=dev.devpocket.app.NativeFlowTest",
    "INSTRUMENTATION_STATUS: test=nativePairingFormUsesEditableComposeControlsWithoutAWebView",
    "INSTRUMENTATION_STATUS: stack=java.lang.AssertionError: synthetic-private-assertion",
    "INSTRUMENTATION_STATUS_CODE: -2",
    "FAILURES!!!",
    "INSTRUMENTATION_CODE: -1",
    "",
  ].join("\n");
  const device = { directory, adb: async (args) => {
    if (args[0] === "logcat") throw new Error("synthetic-private-logcat-error");
    return { stdout: args.includes("instrument") ? failed : "Success\n", stderr: "" };
  } };
  let observed;
  try { await runNativeCase(device, "native", "NativeFlowTest"); }
  catch (error) { observed = error; }
  assert.match(observed?.message ?? "", /Instrumentation did not complete/,
    "A secondary logcat error must not replace the primary native test failure.");
  assert.equal(observed.diagnosticIssues[0].operation, "logcat");
  assert.equal(observed.diagnosticIssues[0].reason, "collector-failed");
  assert.ok(!JSON.stringify(observed.diagnosticIssues).includes("synthetic-private"));
  assert.ok((await readFile(path.join(directory, "case-native.log"), "utf8")).includes("INSTRUMENTATION_STATUS_CODE: -2"));
});

test("an owned instrumentation command keeps its attempted case, trusted method and primary failure without leaking assertion text", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/device-owned-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = [
    "INSTRUMENTATION_STATUS: class=dev.devpocket.app.NativeFlowTest",
    "INSTRUMENTATION_STATUS: test=nativePairingFormUsesEditableComposeControlsWithoutAWebView",
    "INSTRUMENTATION_STATUS: stack=java.lang.AssertionError: PRIVATE_ASSERTION_CANARY token=synthetic-secret",
    "\tat dev.devpocket.app.NativeFlowTest.nativePairingFormUsesEditableComposeControlsWithoutAWebView(NativeFlowTest.kt:20)",
    "\tat private.sdk.Token.privateValue(PrivateSecret.kt:123)",
    "INSTRUMENTATION_STATUS_CODE: -2",
    "FAILURES!!!",
    "INSTRUMENTATION_CODE: -1",
    "",
  ].join("\n");
  const device = { root: process.cwd(), directory, runId: randomUUID(), adb: async (args) =>
    runCommand(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(args.includes("instrument") ? output : args[0] === "logcat" ? "PRIVATE_LOGCAT_CANARY" : "Success\n")})`],
      { cwd: directory, timeoutMs: 15000 }) };
  let observed;
  try { await runNativeCase(device, "native", "NativeFlowTest"); }
  catch (error) { observed = error; }
  const detail = observed?.deviceDiagnostics;
  assert.equal(detail?.primary?.phase, "native");
  assert.equal(detail.primary.operation, "instrumentation");
  assert.equal(detail.cases[0].name, "native");
  assert.equal(detail.cases[0].status, "failed");
  const finding = detail.primary.instrumentation.failures[0];
  assert.equal(finding.method.name, "nativePairingFormUsesEditableComposeControlsWithoutAWebView");
  assert.equal(finding.exception, "java.lang.AssertionError");
  assert.equal(finding.category, "assertion");
  assert.deepEqual(finding.frames, [{ file: "android/app/src/androidTest/java/dev/devpocket/app/NativeFlowTest.kt", line: 20 }]);
  for (const secret of ["PRIVATE_", "synthetic-secret", "private.sdk", "PrivateSecret.kt", directory]) {
    assert.ok(!JSON.stringify(detail).includes(secret));
  }
  assert.equal(detail.acceptance, false);
});

test("the actual device CLI reports the resource phase on failure without printing the private SDK path", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/device-cli-diagnostic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "owned"), runId = randomUUID();
  const sdk = path.join(root, "PRIVATE_SDK_PATH_CANARY");
  let failed;
  try {
    await exec(process.execPath, [path.resolve("scripts/android-runner.mjs"),
      "--directory", directory, "--sdk", sdk, "--emulator-sdk", sdk, "--owner", runId], { timeout: 20000 });
  } catch (error) { failed = error; }
  assert.equal(failed?.code, 1);
  const line = failed.stdout.split(/\r?\n/).find((line) => line.startsWith("DEVPOCKET_DEVICE_DIAGNOSTIC "));
  assert.ok(line, "The real outer CLI must preserve a safe device failure projection.");
  const value = JSON.parse(line.slice("DEVPOCKET_DEVICE_DIAGNOSTIC ".length));
  assert.equal(value.runId, runId);
  assert.equal(value.primary.phase, "resources");
  assert.equal(value.primary.reason, "resource-unavailable");
  assert.equal(value.acceptance, false);
  assert.ok(!failed.stdout.includes("PRIVATE_SDK_PATH_CANARY"));
  assert.ok(!failed.stderr.includes("PRIVATE_SDK_PATH_CANARY"));
  const report = JSON.parse(await readFile(path.join(directory, "device-report.json"), "utf8"));
  assert.equal(report.status, "blocked");
  assert.equal(report.deviceDiagnostics.primary.phase, "resources");
});

test("the full runner records an attempted failed case instead of dropping it before the success callback", async (t) => {
  const { runAndroidTests } = await import("../android-runner.mjs");
  const { sourceSnapshot } = await import("../verification.mjs");
  await mkdir(".data/tests", { recursive: true });
  const parent = await mkdtemp(path.resolve(".data/tests/device-runner-record-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  let directory = path.join(parent, "owned"), refuseReport = false;
  const failure = [
    "INSTRUMENTATION_STATUS: class=dev.devpocket.app.NativeFlowTest",
    "INSTRUMENTATION_STATUS: test=nativePairingFormUsesEditableComposeControlsWithoutAWebView",
    "INSTRUMENTATION_STATUS: stack=java.lang.AssertionError: PRIVATE_FULL_RUN_CANARY",
    "INSTRUMENTATION_STATUS_CODE: -2",
    "INSTRUMENTATION_CODE: -1\n",
  ].join("\n");
  const runtime = {
    prepare: async (_identity, report) => {
      report.source = await sourceSnapshot(process.cwd());
      return { apk: "synthetic-app.apk", testApk: "synthetic-tests.apk" };
    },
    emulator: async (options, operation) => {
      await mkdir(directory);
      if (refuseReport) await mkdir(path.join(directory, "device-report.json"));
      options.diagnostics.stage("prepare", "start");
      await options.prepare({ root: process.cwd(), directory });
      try {
        return { result: await operation({
          root: process.cwd(), directory, runId: options.owner, leaseId: randomUUID(), ports: {},
          adb: async (args) => {
            if (args.includes("instrument")) return { stdout: args.includes("log")
              ? ["NativeFlowTest", "AdaptiveLayoutTest", "FixtureFlowTest"].map((name) =>
                `INSTRUMENTATION_STATUS: class=dev.devpocket.app.${name}`).join("\n") + "\nINSTRUMENTATION_CODE: -1\n"
              : failure, stderr: "" };
            return { stdout: "Success\n", stderr: "" };
          },
        }), cleanup: "completed" };
      } catch (error) {
        options.diagnostics.stage("cleanup", "processes");
        throw Object.assign(error, { runDirectory: directory, cleanup: "completed" });
      }
    },
  };
  const sdk = path.join(parent, "synthetic-sdk-not-installed");
  const result = await runAndroidTests({ directory, sdk, emulatorSdk: sdk }, runtime);
  assert.equal(result.status, "failed");
  assert.equal(result.cases.length, 1);
  assert.equal(result.cases[0].name, "native");
  assert.equal(result.cases[0].status, "failed");
  assert.equal(result.deviceDiagnostics.primary.phase, "native");
  assert.equal(result.deviceDiagnostics.primary.instrumentation.failures[0].category, "assertion");
  assert.ok(!JSON.stringify(result.deviceDiagnostics).includes("PRIVATE_FULL_RUN_CANARY"));
  const saved = JSON.parse(await readFile(path.join(directory, "device-report.json"), "utf8"));
  assert.equal(saved.cases[0].status, "failed");
  assert.equal(saved.cleanup, "completed");
  directory = path.join(parent, "refused-report");
  refuseReport = true;
  await assert.rejects(runAndroidTests({ directory, sdk, emulatorSdk: sdk }, runtime), (error) => {
    assert.match(error.message, /Instrumentation did not complete/);
    assert.equal(error.deviceDiagnostics.primary.reason, "instrumentation");
    assert.ok(error.deviceDiagnostics.secondary.some((issue) => issue.operation === "report"));
    assert.ok(!JSON.stringify(error.deviceDiagnostics).includes("PRIVATE_FULL_RUN_CANARY"));
    return true;
  });
});

test("truncated instrumentation text retains known exception and method facts without assertion operands", async () => {
  const { deviceSourceCatalogue, instrumentationDiagnostics } = await import("../device-diagnostics.mjs");
  const catalogue = await deviceSourceCatalogue(process.cwd());
  const output = [
    "INSTRUMENTATION_STATUS: class=dev.devpocket.app.NativeFlowTest",
    "INSTRUMENTATION_STATUS: test=nativePairingFormUsesEditableComposeControlsWithoutAWebView",
    "INSTRUMENTATION_STATUS: stack=java.lang.AssertionError: " + "PRIVATE_LONG_ASSERTION".repeat(500),
    "INSTRUMENTATION_STATUS_CODE: -2",
    "INSTRUMENTATION_CODE: -1\n",
  ].join("\n");
  const result = instrumentationDiagnostics(output, "dev.devpocket.app.NativeFlowTest", catalogue);
  assert.equal(result.availability, "incomplete");
  assert.equal(result.truncated, true);
  assert.equal(result.failures[0].exception, "java.lang.AssertionError");
  assert.equal(result.failures[0].method.name, "nativePairingFormUsesEditableComposeControlsWithoutAWebView");
  assert.ok(!JSON.stringify(result).includes("PRIVATE_LONG_ASSERTION"));
});

test("secondary output and cleanup failures cannot erase a known native failure or invent complete collection", async () => {
  const { createDeviceDiagnostics } = await import("../device-diagnostics.mjs");
  const { diagnosticError } = await import("../diagnostic-errors.mjs");
  const diagnostics = await createDeviceDiagnostics({
    root: process.cwd(), runId: randomUUID(),
    onSnapshot: () => { throw new Error("PRIVATE_OUTPUT_ERROR"); },
  });
  diagnostics.caseStarted("native", "dev.devpocket.app.NativeFlowTest");
  diagnostics.operation("instrumentation");
  diagnostics.fail(diagnosticError("instrumentation"));
  diagnostics.stage("cleanup", "processes");
  diagnostics.issue("cleanup", Object.assign(new Error("PRIVATE_CLEANUP_ERROR"), { code: "EPERM" }));
  const result = diagnostics.finish("failed");
  assert.equal(result.primary.phase, "native");
  assert.equal(result.primary.reason, "instrumentation");
  assert.equal(result.phase, "cleanup");
  assert.equal(result.availability, "incomplete");
  assert.ok(result.secondary.some((issue) => issue.operation === "cleanup" && issue.osCode === "EPERM"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
});

test("malformed reports produce safe collector-failure artifacts while pre-existing unvalidated outputs are never approved", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/device-export-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ".data", "ci", "device"), temp = path.join(root, ".data", "temp");
  const commands = path.join(temp, "_runner_file_commands");
  await mkdir(directory, { recursive: true });
  await mkdir(commands, { recursive: true });
  const output = path.join(commands, `set_output_${randomUUID()}`), summary = path.join(commands, `step_summary_${randomUUID()}`);
  await writeFile(output, "");
  await writeFile(summary, "");
  await writeFile(path.join(directory, "report.json"), "PRIVATE_MALFORMED_REPORT_CANARY");
  const environment = { ...process.env, GITHUB_ACTIONS: "true", RUNNER_TEMP: temp, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary };
  const exporter = path.resolve("scripts/device-diagnostics.mjs");
  await assert.rejects(exec(process.execPath, [exporter, "--directory", directory, "--github"],
    { cwd: root, env: environment, timeout: 20000 }), (error) => {
    assert.equal(error.code, 1);
    assert.ok(!error.stdout.includes("PRIVATE_MALFORMED_REPORT_CANARY"));
    assert.ok(!error.stderr.includes("PRIVATE_MALFORMED_REPORT_CANARY"));
    return true;
  });
  const report = JSON.parse(await readFile(path.join(directory, "device-diagnostics.json"), "utf8"));
  assert.equal(report.collectionFailure.reason, "report-invalid");
  assert.equal(report.reportAvailability, "invalid-or-unavailable");
  assert.equal(await readFile(output, "utf8"), "report_ready=true\n");
  assert.ok(!(await readFile(summary, "utf8")).includes("PRIVATE_MALFORMED_REPORT_CANARY"));
  await writeFile(output, "");
  await writeFile(path.join(directory, "device-diagnostics.json"), "PRIVATE_UNVALIDATED_OUTPUT");
  await assert.rejects(exec(process.execPath, [exporter, "--directory", directory, "--github"],
    { cwd: root, env: environment, timeout: 20000 }));
  assert.equal(await readFile(output, "utf8"), "");
  assert.equal(await readFile(path.join(directory, "device-diagnostics.json"), "utf8"), "PRIVATE_UNVALIDATED_OUTPUT");
});

test("device projection rejects raw fields and foreign source identities while preserving known phase facts", async () => {
  const { deviceSourceCatalogue, projectDeviceDiagnostics } = await import("../device-diagnostics.mjs");
  const catalogue = await deviceSourceCatalogue(process.cwd()), runId = randomUUID();
  const value = { version: 1, runId, catalogueFingerprint: "a".repeat(64), phase: "fixture", operation: "instrumentation",
    status: "failed", primary: { phase: "fixture", operation: "instrumentation", reason: "instrumentation",
      summary: "PRIVATE_SUMMARY_CANARY", actual: "PRIVATE_ASSERTION_VALUE", argv: ["PRIVATE_PAIRING_CODE"] },
    cases: [{ name: "fixture", class: { name: "PRIVATE_RUNTIME_CLASS" }, status: "failed", tests: 0 }], error: "PRIVATE_RAW_ERROR" };
  const result = projectDeviceDiagnostics(value, catalogue, runId);
  assert.equal(result.phase, "fixture");
  assert.equal(result.primary.reason, "instrumentation");
  assert.equal(result.availability, "incomplete");
  assert.equal(result.cases[0].class, "unknown");
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  const foreign = projectDeviceDiagnostics(value, catalogue, randomUUID());
  assert.equal(foreign.availability, "foreign");
  assert.equal(foreign.primary, null);
});

test("Kotlin strings with nested interpolation never manufacture trusted declarations", async (t) => {
  const { deviceSourceCatalogue } = await import("../device-diagnostics.mjs");
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/kotlin-catalogue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "android", "app", "src", "androidTest", "java", "dev", "devpocket", "app");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "RealTest.kt"), [
    "package dev.devpocket.app",
    'val payload = "${listOf("class CanaryTest @Test fun privateOperand()").size}"',
    'val raw = """${listOf("class OtherCanaryTest @Test fun otherOperand()").size}"""',
    "class RealTest { @Test fun actualTest() {} }",
  ].join("\n"));
  const catalogue = await deviceSourceCatalogue(root);
  assert.deepEqual(catalogue.files[0].classes.map((item) => item.name), ["dev.devpocket.app.RealTest"]);
  assert.deepEqual(catalogue.files[0].methods.map((item) => item.name), ["actualTest"]);
});

test("Java Unicode preprocessing cannot manufacture trusted classes from a literal", async (t) => {
  const { deviceSourceCatalogue } = await import("../device-diagnostics.mjs");
  const { verificationPlan } = await import("../verification.mjs");
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/java-catalogue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture"], { cwd: root });
  const directory = path.join(root, "android", "app", "src", "androidTest", "java", "dev", "devpocket", "app");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "RealTest.java"), [
    "package dev.devpocket.app;",
    "class RealTest {",
    "String payload = \\u0022 class PRIVATE_JAVA_CANARYTest \\u0022;",
    "}",
  ].join("\n"));
  const catalogue = await deviceSourceCatalogue(root);
  assert.ok(!JSON.stringify(catalogue.files.flatMap((file) => file.classes)).includes("PRIVATE_JAVA_CANARY"));
  const plan = await verificationPlan(root, "HEAD");
  assert.ok(!JSON.stringify(plan.trustedDeviceClasses).includes("PRIVATE_JAVA_CANARY"));
  await writeFile(path.join(directory, "RealTest.java"), [
    "package dev.devpocket.app;",
    "class RealTest {",
    "/* /* */",
    'String payload = "*/ class PRIVATE_LITERAL_CANARYTest //";',
    "}",
  ].join("\n"));
  const javaComments = await deviceSourceCatalogue(root);
  assert.ok(!JSON.stringify(javaComments.files.flatMap((file) => file.classes)).includes("PRIVATE_LITERAL_CANARY"));
  const javaPlan = await verificationPlan(root, "HEAD");
  assert.ok(!JSON.stringify(javaPlan.trustedDeviceClasses).includes("PRIVATE_LITERAL_CANARY"));
});

test("device and startup CLI argument failures never print supplied private arguments or raw stacks", async () => {
  for (const entry of ["scripts/android-runner.mjs", "scripts/native-startup.mjs"]) {
    await assert.rejects(exec(process.execPath, [path.resolve(entry), "PRIVATE_ARGUMENT_CANARY"], { timeout: 15000 }), (error) => {
      assert.notEqual(error.code, 0);
      assert.ok(!error.stdout.includes("PRIVATE_ARGUMENT_CANARY"));
      assert.ok(!error.stderr.includes("PRIVATE_ARGUMENT_CANARY"));
      assert.ok(!error.stderr.includes(path.resolve(entry)));
      const line = error.stderr.trim().split(/\r?\n/).at(-1);
      assert.equal(JSON.parse(line).phase, "arguments");
      return true;
    });
  }
});

test("the actual owned startup entry retains exit 37 when recovery cleanup rejects its owner record", async (t) => {
  const { runStartupEntry } = await import("../native-startup.mjs");
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/startup-cleanup-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "test-android.ps1"), [
    "param([switch]$StartupDiagnostic,$Base,$Variant,$RunDirectory,$Owner)",
    "New-Item -ItemType Directory -Path $RunDirectory -Force | Out-Null",
    "@{version=1;root=(Get-Location).Path;runId='foreign-owner';pid=$PID} | ConvertTo-Json | Set-Content (Join-Path $RunDirectory 'owner.json')",
    "exit 37",
  ].join("\n"));
  const result = await runStartupEntry({ root, directory: path.join(root, ".data", "ci", "startup"), base: "HEAD" });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 37);
  assert.equal(result.failure.exitCode, 37);
  assert.equal(result.recoveryCleanup, "failed");
  assert.equal(result.cleanupFailure.reason, "cleanup-failed");
  assert.ok(!JSON.stringify(result).includes(root));
});

test("the successful device report selected for the APK artifact cannot retain arbitrary toolchain suffixes", async (t) => {
  const { runAndroidTests } = await import("../android-runner.mjs");
  const { sourceSnapshot } = await import("../verification.mjs");
  await mkdir(".data/tests", { recursive: true });
  const parent = await mkdtemp(path.resolve(".data/tests/device-success-version-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  let directory = path.join(parent, "owned"), logFailure = false, caseLogFailure = false;
  const credential = `21-dpp_${"A".repeat(43)}`;
  const runtime = {
    prepare: async (_identity, report) => {
      report.source = await sourceSnapshot(process.cwd());
      report.toolchain = { java: credential, emulator: "37-custom-privatepayload", adb: "1.0.41", imageRevision: "9" };
      return { apk: "synthetic-app", testApk: "synthetic-tests" };
    },
    emulator: async (options, operation) => {
      await mkdir(directory);
      await options.prepare({});
      const result = await operation({
        root: process.cwd(), directory, runId: options.owner, ports: {}, leaseId: randomUUID(),
        manage(_file, args) {
          writeFileSync(path.join(directory, "fixture.log"), "PRIVATE_FIXTURE_WORKER\n");
          if (caseLogFailure) writeFileSync(path.join(directory, "case-fixture.log"), "preserve prior case evidence");
          writeFileSync(args[args.indexOf("--output") + 1], JSON.stringify({
            relayUrl: "http://127.0.0.1:54321", pairingCode: `dpp_${"A".repeat(43)}`, title: "synthetic",
          }));
          return { settled: false };
        },
        adb: async (args) => {
          if (!args.includes("instrument")) return { stdout: "Success\n", stderr: "" };
          if (args.includes("log")) return { stdout: ["NativeFlowTest", "AdaptiveLayoutTest", "FixtureFlowTest"]
            .map((name) => `INSTRUMENTATION_STATUS: class=dev.devpocket.app.${name}`).join("\n") + "\nINSTRUMENTATION_CODE: -1\n", stderr: "" };
          const testClass = args[args.indexOf("class") + 1], tests = testClass.endsWith("NativeFlowTest") ? 2 : 1;
          return { stdout: Array.from({ length: tests }, () =>
            `INSTRUMENTATION_STATUS: class=${testClass}\nINSTRUMENTATION_STATUS_CODE: 0\n`).join("") +
            `OK (${tests} tests)\nINSTRUMENTATION_CODE: -1\n`, stderr: "" };
        },
      });
      return { result, cleanup: "completed",
        ...(logFailure ? { workerDiagnostics: { runId: options.owner, cleanup: "completed", collectionStatus: "failed",
          collectionFailures: [{ role: "adb", failure: { reason: "collector-failed", osCode: "EEXIST" } }] } } : {}) };
    },
  };
  const report = await runAndroidTests({ directory }, runtime);
  assert.equal(report.status, "passed");
  const saved = await readFile(path.join(directory, "device-report.json"), "utf8");
  assert.ok(!saved.includes(credential));
  assert.ok(!saved.includes("custom-privatepayload"));
  assert.equal(JSON.parse(saved).toolchain.java, null);
  directory = path.join(parent, "failed-worker-log");
  logFailure = true;
  const blocked = await runAndroidTests({ directory }, runtime);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.executionStatus, "passed");
  assert.equal(blocked.collectionStatus, "failed");
  assert.equal(blocked.cleanup, "completed");
  assert.ok(blocked.cases.every((item) => item.status === "passed"));
  directory = path.join(parent, "failed-case-log");
  logFailure = false;
  caseLogFailure = true;
  const caseBlocked = await runAndroidTests({ directory }, runtime);
  assert.equal(caseBlocked.status, "blocked");
  assert.equal(caseBlocked.executionStatus, "passed");
  assert.equal(caseBlocked.collectionStatus, "failed");
  assert.equal(caseBlocked.cleanup, "completed");
  assert.ok(caseBlocked.cases.every((item) => item.status === "passed"));
  assert.equal(caseBlocked.deviceDiagnostics.primary, null);
  const issue = caseBlocked.deviceDiagnostics.secondary.find((item) => item.operation === "case-log");
  assert.equal(issue.osCode, "EEXIST");
  assert.equal(issue.phase, "fixture");
  assert.equal(issue.case.name, "fixture");
  assert.equal(issue.case.class.name, "dev.devpocket.app.FixtureFlowTest");
  assert.equal(await readFile(path.join(directory, "case-fixture.log"), "utf8"), "preserve prior case evidence");
  assert.equal(await readFile(path.join(directory, "fixture.log"), "utf8"), "PRIVATE_FIXTURE_WORKER\n");
  await mkdir(".data/verification", { recursive: true });
  const exportedDirectory = await mkdtemp(path.resolve(".data/verification/case-log-export-"));
  t.after(() => rm(exportedDirectory, { recursive: true, force: true }));
  await writeFile(path.join(exportedDirectory, "report.json"), JSON.stringify({
    version: 1, status: "blocked", source: caseBlocked.source,
    checks: [{ id: "android-device", status: "blocked", exitCode: 1, deviceRunId: caseBlocked.runId,
      reportedDeviceExecutionStatus: caseBlocked.executionStatus, collectionStatus: caseBlocked.collectionStatus,
      deviceDiagnostics: caseBlocked.deviceDiagnostics }],
  }));
  await assert.rejects(exec(process.execPath, [path.resolve("scripts/device-diagnostics.mjs"), "--directory", exportedDirectory],
    { cwd: process.cwd(), timeout: 20000 }), (error) => error.code === 1);
  const exported = JSON.parse(await readFile(path.join(exportedDirectory, "device-diagnostics.json"), "utf8"));
  assert.equal(exported.executionStatus, "passed");
  assert.equal(exported.collectionStatus, "failed");
  assert.equal(exported.secondary[0].phase, "fixture");
  assert.equal(exported.secondary[0].case.class.name, "dev.devpocket.app.FixtureFlowTest");
  assert.ok(!JSON.stringify(exported).includes("PRIVATE_FIXTURE_WORKER"));
  const { projectDeviceDiagnostics, deviceSourceCatalogue } = await import("../device-diagnostics.mjs");
  const untrusted = projectDeviceDiagnostics({ ...caseBlocked.deviceDiagnostics,
    secondary: [{ operation: "case-log", phase: "PRIVATE_PHASE",
      case: { name: "PRIVATE_CASE", class: { name: "PRIVATE_CLASS", file: "PRIVATE_FILE", line: 1 } } }],
  }, await deviceSourceCatalogue(process.cwd()), caseBlocked.runId);
  assert.equal(untrusted.secondary[0].phase, "unknown");
  assert.equal(untrusted.secondary[0].case.name, "unknown");
  assert.equal(untrusted.secondary[0].case.class, "unknown");
  assert.ok(!JSON.stringify(untrusted).includes("PRIVATE_"));
});

test("startup report publication failure preserves the original owned preparation failure snapshot", async (t) => {
  const { publishStartupReport } = await import("../native-startup.mjs");
  const { createDeviceDiagnostics } = await import("../device-diagnostics.mjs");
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/startup-report-write-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "startup-report.json"));
  const runId = randomUUID(), diagnostics = await createDeviceDiagnostics({ root: process.cwd(), runId });
  diagnostics.stage("prepare", "jdk");
  let primary;
  try { await runCommand(process.execPath, ["-e", "process.exit(37)"], { timeoutMs: 10000 }); }
  catch (error) { primary = error; diagnostics.fail(error); }
  const report = { version: 1, runId, status: "failed", phase: "prepare", nativeReadiness: false,
    cleanup: "completed", deviceDiagnostics: diagnostics.finish("failed") };
  await assert.rejects(publishStartupReport(report, directory, diagnostics, primary), (error) => {
    assert.equal(error, primary);
    assert.equal(error.startupReport.deviceDiagnostics.primary.phase, "prepare");
    assert.equal(error.startupReport.deviceDiagnostics.primary.exitCode, 37);
    assert.equal(error.startupReport.reportFailure.reason, "report-write");
    return true;
  });
});

test("a caller cancellation before lease acquisition remains cancelled without inventing an exit", async (t) => {
  const { runAndroidTests } = await import("../android-runner.mjs");
  await mkdir(".data/tests", { recursive: true });
  const parent = await mkdtemp(path.resolve(".data/tests/device-prelease-cancel-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const cancellation = new AbortController();
  cancellation.abort(new Error("PRIVATE_CANCEL_REASON"));
  const directory = path.join(parent, "owned");
  const result = await runAndroidTests({ directory, sdk: path.join(parent, "absent-sdk"),
    emulatorSdk: path.join(parent, "absent-sdk"), signal: cancellation.signal });
  assert.equal(result.status, "blocked");
  assert.equal(result.deviceDiagnostics.primary.reason, "command-cancelled");
  assert.equal(result.deviceDiagnostics.primary.exitCode, "unknown");
  assert.ok(!JSON.stringify(result.deviceDiagnostics).includes("PRIVATE_CANCEL_REASON"));
});
