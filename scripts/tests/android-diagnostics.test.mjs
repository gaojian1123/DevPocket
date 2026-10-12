import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const entry = path.resolve("scripts/android-diagnostics.mjs");

async function fixture(t, log) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/android-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ".data", "ci", "android");
  await mkdir(directory, { recursive: true });
  if (log !== undefined) await writeFile(path.join(directory, "android-build.log"), log);
  return { root, directory, output: path.join(directory, "android-diagnostics.json") };
}

async function collect(fixture) {
  const result = await exec(process.execPath, [entry], { cwd: fixture.root, timeout: 20_000 });
  const bytes = await readFile(fixture.output, "utf8");
  assert.equal(result.stdout.trim(), bytes.trim(), "CI output must contain only the same safe projection.");
  assert.equal(result.stderr, "");
  return { report: JSON.parse(bytes), bytes };
}

test("the diagnostic command projects SDK, compiler, JVM and lint failures without exporting raw text", async (t) => {
  const item = await fixture(t);
  const source = path.join(item.root, "android", "app", "src", "main", "java", "dev", "devpocket", "app", "Main.kt");
  const manifest = path.join(item.root, "android", "app", "src", "main", "AndroidManifest.xml");
  const secret = "synthetic-private-value-do-not-publish";
  const log = [
    `Authorization: Bearer ${secret}`,
    `ANDROID_HOME: C:\\private\\${secret}`,
    `ANDROID_SDK_ROOT: D:\\private\\${secret}`,
    "Several environment variables and/or system properties contain different paths to the SDK.",
    `e: ${pathToFileURL(source).href}:12:7 Unresolved reference '${secret}'.`,
    `BackgroundModeTest > cursorRestores[26] FAILED`,
    `    java.lang.AssertionError: expected:<${secret}> but was:<private session text>`,
    "    android.database.sqlite.SQLiteException at BackgroundModeTest.kt:236",
    "80 tests completed, 2 failed",
    `${manifest}:17: Error: ${secret} [MissingPermission]`,
    "Lint found 1 errors, 3 warnings.",
    "> Task :app:testDebugUnitTest FAILED",
    "Execution failed for task ':app:lintDebug'.",
    `Could not GET 'https://user:${secret}@example.test/maven?token=${secret}'`,
    `Private prompt: ${secret}`,
    "BUILD FAILED in 1m",
  ].join("\n");
  await writeFile(path.join(item.directory, "android-build.log"), log);
  await writeFile(path.join(item.directory, "report.json"), '{"preserved":"machine report"}\n');
  const { report, bytes } = await collect(item);
  assert.equal(report.kind, "android-build-diagnostics");
  assert.equal(report.availability, "available");
  assert.equal(report.truncated, false);
  assert.deepEqual(report.failedTasks, [":app:testDebugUnitTest", ":app:lintDebug"]);
  for (const code of ["sdk-path-conflict", "compiler", "jvm-tests", "lint", "dependency-download"]) {
    assert.ok(report.failureKinds.includes(code), code);
  }
  assert.deepEqual(report.testSummary, { tests: 80, failed: 2, skipped: 0 });
  assert.ok(report.findings.some((finding) => finding.kind === "compiler" &&
    finding.file === "app/src/main/java/dev/devpocket/app/Main.kt" && finding.line === 12 && finding.column === 7));
  assert.ok(report.findings.some((finding) => finding.kind === "jvm-test" &&
    finding.suite === "BackgroundModeTest" && finding.test === "cursorRestores[26]"));
  assert.ok(report.findings.some((finding) => finding.kind === "exception" &&
    finding.type === "android.database.sqlite.SQLiteException" && finding.line === 236));
  assert.ok(report.findings.some((finding) => finding.kind === "lint" && finding.issue === "MissingPermission" &&
    finding.file === "app/src/main/AndroidManifest.xml" && finding.line === 17));
  for (const excluded of [secret, "Authorization", "private session text", "example.test", item.root, "ANDROID_HOME:"]) {
    assert.ok(!bytes.includes(excluded), excluded);
  }
  assert.equal(await readFile(path.join(item.directory, "report.json"), "utf8"), '{"preserved":"machine report"}\n');
  assert.equal(await readFile(path.join(item.directory, "android-build.log"), "utf8"), log);
});

test("unrecognized and missing private logs do not become a successful verification result", async (t) => {
  for (const log of [undefined, "unstructured-private-build-output"]) {
    await t.test(log === undefined ? "missing" : "unrecognized", async (t) => {
      const item = await fixture(t, log);
      const { report, bytes } = await collect(item);
      assert.equal(report.availability, log === undefined ? "missing" : "available");
      assert.deepEqual(report.failedTasks, []);
      assert.deepEqual(report.findings, []);
      assert.equal(report.status, undefined);
      assert.equal(report.complete, undefined);
      assert.match(report.note, /not verification evidence/i);
      assert.ok(!bytes.includes("unstructured-private-build-output"));
    });
  }
});

test("diagnostics bound both input and output while retaining the failure at the end", async (t) => {
  const large = Array.from({ length: 500 }, (_, index) =>
    `e: app/src/main/java/File${index}.kt:7:8 compiler message must stay private`).join("\n");
  const item = await fixture(t, large + "\n" + "unreviewed-private-line\n".repeat(40_000) +
    "> Task :app:compileDebugKotlin FAILED\nBUILD FAILED\n");
  const { report, bytes } = await collect(item);
  assert.equal(report.truncated, true);
  assert.ok(report.failedTasks.includes(":app:compileDebugKotlin"));
  assert.ok(report.findings.length > 0 && report.findings.length <= 24);
  assert.ok(Buffer.byteLength(bytes) <= 16 * 1024);
  assert.ok(!bytes.includes("unreviewed-private-line"));
  assert.ok(!bytes.includes("compiler message"));
});

test("diagnostics cannot overwrite earlier output or follow linked input directories", async (t) => {
  const item = await fixture(t, "BUILD FAILED\n");
  await writeFile(item.output, "preserved prior diagnostics");
  await assert.rejects(exec(process.execPath, [entry], { cwd: item.root, timeout: 20_000 }));
  assert.equal(await readFile(item.output, "utf8"), "preserved prior diagnostics");
  const linked = path.join(item.root, ".data", "ci", "linked");
  await symlink(item.directory, linked, "junction");
  await assert.rejects(exec(process.execPath, [entry, "--directory", linked], { cwd: item.root, timeout: 20_000 }));
  await assert.rejects(exec(process.execPath, [entry, "--directory", path.join(item.root, "outside")],
    { cwd: item.root, timeout: 20_000 }));
});

test("source locations outside Android source and untrusted identifiers stay private", async (t) => {
  const item = await fixture(t, [
    "e: C:\\private\\outside.kt:1:2 private text",
    "e: app/src/../../../../private.kt:1:2 private text",
    "e: app/src/main/java/ghp_syntheticSecret.kt:1:2 private text",
    "PrivatePrompt > human readable private message FAILED",
    "private.runtime.ConversationError: internal session content",
    "::error::synthetic action command",
    "\u001b[31m> Task :app:compileDebugKotlin FAILED\u001b[0m",
    "> Task :app:ghp_syntheticSecret FAILED",
    "BUILD FAILED",
  ].join("\n"));
  const { report, bytes } = await collect(item);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.failedTasks, [":app:compileDebugKotlin"]);
  for (const value of ["outside.kt", "private.kt", "ghp_", "PrivatePrompt", "ConversationError", "::error", "\u001b"]) {
    assert.ok(!bytes.includes(value), value);
  }
});

test("CI publishes only the diagnostic projection alongside the original Android machine report", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const android = workflow.split("\n  android:")[1].split("\n  device:")[0];
  assert.match(android, /name: Export bounded Android failure diagnostics\r?\n\s+if: failure\(\)/);
  assert.match(android, /node scripts\\android-diagnostics\.mjs --directory \.data\\ci\\android\r?\n\s+exit \$LASTEXITCODE/);
  assert.match(android, /node scripts\\verify\.mjs[^\r\n]+\r?\n\s+exit \$LASTEXITCODE/);
  assert.ok(!android.includes("continue-on-error"));
  const uploadStart = android.indexOf("- uses: actions/upload-artifact@v7");
  assert.ok(uploadStart >= 0, "The Android report upload step must exist.");
  const upload = android.slice(uploadStart);
  assert.match(upload, /if: always\(\)/);
  const paths = [...upload.matchAll(/^\s+(\.data\\[^\r\n]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(paths, [".data\\ci\\android\\report.json", ".data\\ci\\android\\android-diagnostics.json"]);
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  for (const testFile of ["android-build.test.mjs", "android-diagnostics.test.mjs"]) {
    assert.ok(manifest.scripts["test:workflow"].includes(`scripts/tests/${testFile}`));
  }
});

test("CI Action upgrades preserve toolchain selection, artifact isolation and the required device gate", async () => {
  const workflow = (await readFile(".github/workflows/ci.yml", "utf8")).replaceAll("\r\n", "\n");
  const preparation = (await readFile(".github/actions/prepare-native/action.yml", "utf8")).replaceAll("\r\n", "\n");
  const normalWorkflow = workflow.replace(/\n  startup:[\s\S]*?(?=\n  gate:)/, "");
  const expandedNormal = `${normalWorkflow}\n${preparation}`;
  const actions = [...expandedNormal.matchAll(/^\s+- uses: (actions\/[^\s]+)$/gm)].map((match) => match[1]);
  const counts = {};
  for (const action of actions) counts[action] = (counts[action] ?? 0) + 1;
  assert.deepEqual(counts, {
    "actions/checkout@v7": 5, "actions/setup-node@v7": 5, "actions/setup-python@v7": 1,
    "actions/upload-artifact@v7": 6, "actions/setup-java@v6": 2, "actions/download-artifact@v8": 1,
  });
  assert.equal([...normalWorkflow.matchAll(
    /- uses: actions\/checkout@v7\n\s+with:\n\s+fetch-depth: 0\n\s+persist-credentials: false/g,
  )].length, 5);
  assert.equal([...expandedNormal.matchAll(
    /- uses: actions\/setup-node@v7\n\s+with:\n\s+node-version: 24\n/g,
  )].length, 5);
  assert.equal([...expandedNormal.matchAll(/- uses: actions\/setup-java@v6\n\s+with:\n\s+distribution: temurin\n\s+java-version: '21'/g)].length, 2);
  assert.match(workflow, /- uses: actions\/setup-python@v7\n\s+with:\n\s+python-version: '3\.12'/);
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(workflow, /continue-on-error:|FORCE_JAVASCRIPT_ACTIONS_TO_NODE20|ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION/);
  assert.doesNotMatch(workflow, /^\s+(?:merge-multiple|include-hidden-files|overwrite|archive|digest-mismatch):/m);
  assert.equal([...normalWorkflow.matchAll(/^\s+if-no-files-found: error$/gm)].length, 6);

  const backend = workflow.split("\n  backend:")[1].split("\n  android:")[0];
  assert.match(backend, /\$env:DEVPOCKET_PROBE_PYTHON = \(Get-Command python -CommandType Application -ErrorAction Stop \| Select-Object -First 1\)\.Source\n\s+node scripts\\verify\.mjs/);
  const android = workflow.split("\n  android:")[1].split("\n  device:")[0];
  assert.match(android, /--jdk \$env:JAVA_HOME --sdk \.tools\\android-sdk --report \.data\\ci\\android\\report\.json/);
  const device = workflow.split("\n  device:")[1].split("\n  startup:")[0];
  assert.match(device, /needs: \[plan, android\]/);
  assert.match(device, /needs\.plan\.outputs\.device == 'true' &&/);
  assert.ok(device.includes("(github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository)"));
  assert.match(device, /runs-on: ubuntu-24\.04/);
  assert.doesNotMatch(device, /self-hosted|DEVPOCKET_ANDROID_RUNNER_ENABLED|environment:|container:|ubuntu-slim/);
  assert.match(device, /uses: \.\/\.github\/actions\/prepare-native/);
  assert.ok(preparation.includes('sudo setfacl -m "u:$(id -u):rw" /dev/kvm'));
  assert.ok(preparation.includes("--channel=0"));
  assert.ok(preparation.includes("</dev/null"));
  assert.doesNotMatch(preparation, /yes\s*\||--licenses|chmod\s+666/);
  assert.match(device, /scripts\/verify\.ps1 -Base \$env:BASE_SHA -Group device -Jdk \$env:JAVA_HOME -Sdk \$env:ANDROID_HOME/);
  assert.match(device, /-Image system-images\/android-35\/google_apis\/x86_64 -Report \.data\/ci\/device\/report\.json/);
  assert.match(preparation, /node scripts\/linux-runtime\.mjs\n\s+exit \$LASTEXITCODE/);
  assert.match(preparation, /node --test scripts\/tests\/linux-emulator\.test\.mjs scripts\/tests\/linux-process\.test\.mjs scripts\/tests\/linux-runtime\.test\.mjs/);
  assert.match(device, /name: Export bounded owned-worker diagnostics\n\s+if: always\(\)/);
  assert.match(device, /node scripts\/worker-diagnostics\.mjs --directory \.data\/ci\/device\n\s+exit \$LASTEXITCODE/);
  assert.deepEqual([...device.matchAll(/^\s+((?:\.data|android)\/[^\r\n]+)$/gm)].map((match) => match[1]), [
    ".data/ci/device/report.json",
    ".data/ci/device/worker-diagnostics.json",
    "android/app/build/outputs/apk/debug/app-debug.apk",
    "android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
    ".data/ci/device/device/device-report.json",
  ]);

  const gate = workflow.split("\n  gate:")[1];
  assert.match(gate, /needs: \[plan, backend, android, device\]\n\s+if: always\(\)/);
  assert.match(gate, /- uses: actions\/download-artifact@v8\n\s+with:\n\s+pattern: verification-\*\n\s+path: \.data\\ci\\inputs/);
  assert.ok(gate.includes("'--base', $env:BASE_SHA, '--combine'"));
  assert.ok(gate.includes("Get-ChildItem -LiteralPath .data\\ci\\inputs -Filter report.json -File -Recurse"));
  assert.match(gate, /node @arguments\n\s+if \(\$LASTEXITCODE -ne 0\) \{ throw /);
  assert.match(gate, /if \(\$env:STARTUP_ONLY -eq 'true'\) \{\n\s+node scripts\\verify\.mjs .*--plan --report \.data\\ci\\gate\.json\n\s+throw 'A startup diagnostic cannot satisfy Required verification/);
  const startup = workflow.split("\n  startup:")[1].split("\n  gate:")[0];
  assert.match(startup, /if: github\.event_name == 'workflow_dispatch' && inputs\.startup_diagnostic/);
  assert.match(startup, /runs-on: ubuntu-24\.04/);
  assert.match(startup, /uses: \.\/\.github\/actions\/prepare-native/);
  assert.match(startup, /name: native-startup-diagnostic\n\s+path: \.data\/ci\/native-startup\/startup-report\.json/);
  assert.doesNotMatch(startup, /name: verification-|continue-on-error/);
});

test("CI binds exactly the first Python executable when command discovery returns multiple matches", async (t) => {
  const item = await fixture(t);
  const directories = [path.join(item.root, "first Python"), path.join(item.root, "second Python")];
  const executable = process.platform === "win32" ? "python.exe" : "python";
  for (const directory of directories) {
    await mkdir(directory);
    await writeFile(path.join(directory, executable), "", { mode: 0o700 });
  }
  const workflow = (await readFile(".github/workflows/ci.yml", "utf8")).replaceAll("\r\n", "\n");
  const selector = workflow.split("\n").find((line) => line.trim().startsWith("$env:DEVPOCKET_PROBE_PYTHON ="));
  assert.ok(selector);
  const result = await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
    `${selector.trim()}\n$env:DEVPOCKET_PROBE_PYTHON | ConvertTo-Json -Compress`],
  { env: { ...process.env, PATH: [...directories, process.env.PATH].join(path.delimiter) }, timeout: 20000 });
  assert.equal(JSON.parse(result.stdout), path.join(directories[0], executable));
});
