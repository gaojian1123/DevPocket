import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { LINUX_PLATFORM_TESTS } from "../backend-diagnostics.mjs";
import { TOOLING_TEST_FILES } from "../test-tooling.mjs";

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
  const testSource = path.join(item.root, "android", "app", "src", "test", "java", "dev", "devpocket", "app", "BackgroundModeTest.kt");
  await mkdir(path.dirname(source), { recursive: true });
  await mkdir(path.dirname(testSource), { recursive: true });
  await writeFile(source, "package dev.devpocket.app\nclass Main\n" + "\n".repeat(20));
  await writeFile(manifest, "<manifest>\n" + "\n".repeat(20) + "</manifest>\n");
  await writeFile(testSource, "package dev.devpocket.app\nclass BackgroundModeTest {\n@Test fun cursorRestores() {}\n}\n" + "\n".repeat(240));
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
    finding.suite === "dev.devpocket.app.BackgroundModeTest" && finding.test === "cursorRestores" && finding.invocationIndex === 26));
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

test("JDK diagnostics recognize the JDK 25 requirement and historical build messages", async (t) => {
  for (const versions of ["25", "21 or 25", "17 or 21", "17, 21 or 25"]) {
    const item = await fixture(t, `JDK ${versions} is required. Pass -Jdk or run prepare-android.ps1 -DownloadJdk.\n`);
    const { report } = await collect(item);
    assert.deepEqual(report.failureKinds, ["jdk-incompatible"]);
  }
});

test("SDK diagnostics recognize decimal platforms and historical integer messages", async (t) => {
  const build = await readFile(path.resolve("scripts/build-android.ps1"), "utf8");
  const current = /WriteLine\('(Android SDK platform [^']+)'\)/.exec(build)?.[1];
  assert.ok(current, "Exercise the actual native build prerequisite message.");
  for (const message of [current, "Android SDK platform 35 is missing.", "Android SDK platform 37 is missing."]) {
    const item = await fixture(t, `${message}\n`);
    const { report } = await collect(item);
    assert.deepEqual(report.failureKinds, ["sdk-missing"], message);
  }
});

test("the public Android exporter indexes standard build-type resources without losing the original failure", async (t) => {
  const item = await fixture(t);
  const source = path.join(item.root, "android", "app", "src", "debug", "res", "xml", "network_security_config.xml");
  const release = path.join(item.root, "android", "app", "src", "release", "res", "xml", "network_security_config.xml");
  for (const file of [source, release]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "<network-security-config>\n\n</network-security-config>\n");
  }
  await writeFile(path.join(item.directory, "android-build.log"),
    `${source}:2: Error: PRIVATE_BUILD_TYPE_VALUE [MissingPermission]\nBUILD FAILED\n`);
  const { report, bytes } = await collect(item);
  assert.equal(report.sourceCatalogueAvailable, true);
  assert.equal(report.collectionFailure, null);
  assert.ok(report.failureKinds.includes("build-failed"));
  assert.ok(report.findings.some((finding) => finding.kind === "lint" &&
    finding.file === "app/src/debug/res/xml/network_security_config.xml" && finding.line === 2));
  assert.ok(!bytes.includes("PRIVATE_BUILD_TYPE_VALUE"));
  assert.ok(!bytes.includes(item.root));
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
  const sources = path.join(item.root, "android", "app", "src", "main", "java");
  await mkdir(sources, { recursive: true });
  for (let index = 0; index < 30; index++) await writeFile(path.join(sources, `File${index}.kt`),
    "package dev.devpocket.app\n" + "\n".repeat(10));
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
  assert.match(android, /name: Export bounded Android failure diagnostics\r?\n\s+id: android_diagnostics\r?\n\s+if: failure\(\)/);
  assert.match(android, /node scripts\\android-diagnostics\.mjs --directory \.data\\ci\\android --github\r?\n\s+exit \$LASTEXITCODE/);
  assert.match(android, /node scripts\\verify\.mjs[^\r\n]+\r?\n\s+exit \$LASTEXITCODE/);
  assert.ok(!android.includes("continue-on-error"));
  const uploadStart = android.indexOf("name: verification-android");
  assert.ok(uploadStart >= 0, "The Android report upload step must exist.");
  const upload = android.slice(uploadStart).split("- uses:")[0];
  const paths = [...upload.matchAll(/^\s+(\.data\\[^\r\n]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(paths, [".data\\ci\\android\\report.json", ".data\\ci\\android\\ci-report.json"]);
  assert.match(android, /if: always\(\) && steps\.android_diagnostics\.outputs\.report_ready == 'true'/);
  assert.match(android, /name: android-test-diagnostics-attempt-\$\{\{ github\.run_attempt \}\}\r?\n\s+path: \.data\/ci\/android\/android-diagnostics\.json/);
  for (const testFile of ["android-build.test.mjs", "android-diagnostics.test.mjs"]) {
    assert.ok(TOOLING_TEST_FILES.includes(`scripts/tests/${testFile}`));
  }
});

test("CI Action upgrades preserve toolchain selection, artifact isolation and the required device gate", async () => {
  const workflow = (await readFile(".github/workflows/ci.yml", "utf8")).replaceAll("\r\n", "\n");
  const preparation = (await readFile(".github/actions/prepare-native/action.yml", "utf8")).replaceAll("\r\n", "\n");
  const normalWorkflow = workflow;
  assert.doesNotMatch(workflow, /startup_diagnostic|startup_variant|STARTUP_ONLY|\n  startup:/);
  assert.deepEqual([...workflow.split("\njobs:\n")[1].matchAll(/^  ([A-Za-z_][\w-]*):[ \t]*$/gm)]
    .map((match) => match[1]), ["plan", "tooling", "macos", "backend", "android", "device", "apple", "gate"]);
  const expandedNormal = `${normalWorkflow}\n${preparation}`;
  const actions = [...expandedNormal.matchAll(/^\s+- uses: (actions\/[^\s]+)$/gm)].map((match) => match[1]);
  const counts = {};
  for (const action of actions) counts[action] = (counts[action] ?? 0) + 1;
  assert.deepEqual(counts, {
    "actions/checkout@v7": 8, "actions/setup-node@v7": 8, "actions/setup-python@v7": 4,
    "actions/upload-artifact@v7": 24, "actions/setup-java@v6": 2, "actions/download-artifact@v8": 1,
  });
  assert.equal([...normalWorkflow.matchAll(
    /- uses: actions\/checkout@v7\n\s+with:\n\s+fetch-depth: 0\n\s+persist-credentials: false/g,
  )].length, 8);
  assert.equal([...expandedNormal.matchAll(
    /- uses: actions\/setup-node@v7\n\s+with:\n\s+node-version: 26\.12\.1\n/g,
  )].length, 8);
  assert.equal([...expandedNormal.matchAll(/- uses: actions\/setup-java@v6\n\s+with:\n\s+distribution: temurin\n\s+java-version: '25'/g)].length, 2);
  const androidBuild = await readFile("android/app/build.gradle.kts", "utf8");
  assert.match(androidBuild, /sourceCompatibility = JavaVersion\.VERSION_17/);
  assert.match(androidBuild, /targetCompatibility = JavaVersion\.VERSION_17/);
  assert.match(androidBuild, /jvmTarget\.set\(org\.jetbrains\.kotlin\.gradle\.dsl\.JvmTarget\.JVM_17\)/);
  assert.match(workflow, /- uses: actions\/setup-python@v7\n\s+with:\n\s+python-version: '3\.12'/);
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(workflow, /continue-on-error:|FORCE_JAVASCRIPT_ACTIONS_TO_NODE20|ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION/);
  assert.doesNotMatch(workflow, /^\s+(?:merge-multiple|overwrite|archive|digest-mismatch):/m);
  assert.equal([...normalWorkflow.matchAll(/^\s+if-no-files-found: error$/gm)].length, 23);

  const backend = workflow.split("\n  backend:")[1].split("\n  android:")[0];
  assert.match(backend, /\$env:DEVPOCKET_PROBE_PYTHON = \(Get-Command python -CommandType Application -ErrorAction Stop \| Select-Object -First 1\)\.Source\n\s+node scripts\\verify\.mjs/);
  const android = workflow.split("\n  android:")[1].split("\n  device:")[0];
  assert.match(android, /--jdk \$env:JAVA_HOME --sdk \.tools\\android-sdk --report \.data\\ci\\android\\report\.json/);
  const device = workflow.split("\n  device:")[1].split("\n  apple:")[0];
  assert.match(device, /needs: \[plan, android\]/);
  assert.match(device, /needs\.plan\.outputs\.device == 'true' &&/);
  assert.ok(device.includes("(github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository)"));
  assert.match(device, /runs-on: ubuntu-24\.04/);
  assert.doesNotMatch(device, /self-hosted|DEVPOCKET_ANDROID_RUNNER_ENABLED|environment:|container:|ubuntu-slim/);
  assert.match(device, /uses: \.\/\.github\/actions\/prepare-native/);
  assert.ok(preparation.includes('OWNER:="%s", MODE:="0600"'));
  assert.ok(preparation.includes('RUNNER_ENVIRONMENT:-'));
  assert.ok(preparation.includes('sudo -n udevadm trigger --action=change --name-match=kvm'));
  assert.ok(preparation.includes('sudo -n udevadm settle --timeout=30'));
  assert.ok(preparation.includes("--channel=0"));
  assert.ok(preparation.includes("</dev/null"));
  assert.doesNotMatch(preparation, /yes\s*\||--licenses|chmod\s+666/);
  assert.match(device, /scripts\/verify\.ps1 -Base \$env:BASE_SHA -Group device -Jdk \$env:JAVA_HOME -Sdk \$env:ANDROID_HOME/);
  assert.match(device, /-Image system-images\/android-37\.0\/google_apis\/x86_64 -Report \.data\/ci\/device\/report\.json/);
  assert.match(preparation, /node scripts\/linux-runtime\.mjs\n\s+exit \$LASTEXITCODE/);
  assert.match(preparation, /node scripts\/platform-diagnostics\.mjs --github/);
  assert.deepEqual(LINUX_PLATFORM_TESTS, [
    "scripts/tests/linux-emulator.test.mjs", "scripts/tests/linux-process.test.mjs", "scripts/tests/linux-runtime.test.mjs",
    "scripts/tests/worker-diagnostics.test.mjs", "scripts/tests/native-lifecycle.test.mjs", "scripts/tests/bounded-worker-log.test.mjs",
  ]);
  assert.match(device, /name: Export bounded owned-worker diagnostics\n\s+id: worker_diagnostics\n\s+if: always\(\)/);
  assert.match(device, /node scripts\/worker-diagnostics\.mjs --directory \.data\/ci\/device --github\n\s+exit \$LASTEXITCODE/);
  assert.deepEqual([...device.matchAll(/^\s+((?:\.data|android)\/[^\r\n]+)$/gm)].map((match) => match[1]), [
    ".data/ci/device/report.json",
    ".data/ci/device/ci-report.json",
    "android/app/build/outputs/apk/debug/app-debug.apk",
    "android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
    ".data/ci/device/device/device-report.json",
  ]);
  assert.match(device, /steps\.worker_diagnostics\.outputs\.report_ready == 'true'/);
  assert.match(device, /name: owned-worker-diagnostics-attempt-\$\{\{ github\.run_attempt \}\}\n\s+path: \.data\/ci\/device\/worker-diagnostics\.json/);
  assert.match(device, /steps\.device_diagnostics\.outputs\.report_ready == 'true'/);

  const apple = workflow.split("\n  apple:")[1].split("\n  gate:")[0];
  assert.match(apple, /needs\.plan\.outputs\.apple == 'true'/);
  assert.match(apple, /runs-on: xcode-27/);
  assert.match(apple, /DEVELOPER_DIR: \/Applications\/Xcode_27\.2\.app\/Contents\/Developer/);
  assert.match(apple, /xcodebuild -downloadPlatform iOS -buildVersion 24B8117 -architectureVariant arm64/);
  assert.match(apple, /xcodebuild -downloadPlatform iOS -buildVersion 24B91016s -architectureVariant arm64/);
  assert.ok(apple.indexOf("name: Install the required iOS 27.2 runtimes") <
    apple.indexOf("name: Verify the selected Apple platform"));
  assert.doesNotMatch(apple, /-downloadAllPlatforms/);
  assert.match(apple, /npm_config_registry: https:\/\/packagefeedproxy\.microsoft\.io\/npm\//);
  assert.match(apple, /role: \[mac, iphone, ipad, duo\]/);
  assert.match(apple, /fail-fast: false/);
  assert.match(apple, /node scripts\/verify\.mjs --base "\$BASE_SHA" --group apple --apple-role "\$APPLE_ROLE" --report \.data\/ci\/apple\/report\.json/);
  assert.match(apple, /"acceptance": False/);
  assert.match(apple, /"tag": "apple-service-observation"/);
  assert.match(apple, /observer_pid=\$!\n\s+trap 'kill "\$observer_pid"/);
  assert.match(apple, /--seal --unit "apple-\$APPLE_ROLE"/);
  assert.match(apple, /name: verification-apple-\$\{\{ matrix\.role \}\}-attempt-[^\n]+\n\s+path: \|\n\s+\.data\/ci\/apple\/report\.json\n\s+\.data\/ci\/apple\/ci-report\.json\n\s+if-no-files-found: error/);
  assert.doesNotMatch(workflow.replace(apple, ""), /^\s+include-hidden-files:/m);
  assert.equal([...apple.matchAll(/^\s+include-hidden-files:/gm)].length, 1);
  const nativeArtifacts = apple.split("name: apple-native-evidence-${{ matrix.role }}-attempt-")[1];
  assert.match(nativeArtifacts, /include-hidden-files: true/);
  assert.deepEqual([...nativeArtifacts.matchAll(/^\s+(\.data\/[^\r\n]+)$/gm)].map((match) => match[1]), [
    ".data/ci/apple/apple/apple-owner.json",
    ".data/ci/apple/apple/apple-report*.json",
    ".data/ci/apple/apple/logs/",
    ".data/ci/apple/apple/*/result.xcresult/",
    ".data/ci/apple/apple/test-*/result-files.json",
    ".data/ci/apple/apple/test-*/catalog/enumeration.json",
    ".data/ci/apple/apple/test-*/catalog/result.xcresult/",
    ".data/ci/apple/apple/build-*/derived/Build/Products/**/DevPocket.app/",
    ".data/ci/apple-service-observation/",
  ]);

  const gate = workflow.split("\n  gate:")[1];
  assert.match(gate, /needs: \[plan, tooling, macos, backend, android, device, apple\]\n\s+if: always\(\)/);
  assert.ok(gate.includes("APPLE_RESULT: ${{ needs.apple.result }}"));
  assert.doesNotMatch(gate, /ISOLATION_REQUIRED|ISOLATION_RESULT|isolated-boundary/);
  assert.match(gate, /- uses: actions\/download-artifact@v8\n\s+with:\n\s+pattern: verification-\*\n\s+path: \.data\\ci\\inputs/);
  assert.ok(gate.includes("'scripts\\verification-ci.mjs', '--base', $env:BASE_SHA, '--collect'"));
  assert.ok(gate.includes("'--inputs', '.data\\ci\\inputs'"));
  assert.match(gate, /node @arguments\n\s+if \(\$LASTEXITCODE -ne 0\) \{ throw /);
});

test("the independent tooling CI job runs the complete tooling suite without application or device provisioning", async () => {
  const { CHECKS } = await import("../verification-policy.mjs");
  assert.deepEqual(CHECKS.filter((check) => check.group === "tooling"),
    [{ id: "tooling-tests", group: "tooling" }]);
  const workflow = (await readFile(".github/workflows/ci.yml", "utf8")).replaceAll("\r\n", "\n");
  const tooling = workflow.split("\n  tooling:")[1]?.split("\n  macos:")[0];
  assert.ok(tooling);
  assert.match(tooling, /needs: plan\n\s+if: needs\.plan\.outputs\.tooling == 'true'/);
  assert.match(tooling, /!\(github\.event_name == 'workflow_dispatch' && inputs\.backend_diagnostic\)/);
  assert.match(tooling, /runs-on: windows-latest/);
  assert.match(tooling, /actions\/setup-node@v7\n\s+with:\n\s+node-version: 26\.12\.1/);
  assert.match(tooling, /actions\/setup-python@v7\n\s+with:\n\s+python-version: '3\.12'/);
  assert.match(tooling, /- run: npm ci --no-audit --no-fund/);
  assert.ok(tooling.includes("'scripts\\verify.mjs', '--base', $env:BASE_SHA, '--group', 'tooling'"));
  assert.ok(tooling.includes("'--tooling-shard', $env:TOOLING_PART"));
  assert.match(tooling, /fail-fast: false/);
  assert.ok(tooling.includes("fromJSON(needs.plan.outputs.tooling_shards)"));
  assert.match(tooling, /node @arguments\n\s+exit \$LASTEXITCODE/);
  assert.match(tooling, /--directory \.data\/ci\/tooling --job tooling --step-result \$env:STEP_RESULT --github/);
  assert.match(tooling, /name: verification-tooling-\$\{\{ matrix\.part \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.match(tooling, /path: \|\n\s+\.data\\ci\\tooling\\report\.json\n\s+\.data\\ci\\tooling\\ci-report\.json\n\s+if-no-files-found: error/);
  assert.match(tooling, /if: always\(\) && steps\.diagnostics\.outputs\.report_ready == 'true'/);
  assert.match(tooling, /name: check-diagnostics-tooling-\$\{\{ matrix\.part \}\}-attempt-\$\{\{ github\.run_attempt \}\}\n\s+path: \.data\/ci\/tooling\/verification-diagnostics\.json/);
  assert.doesNotMatch(tooling, /setup-java|prepare-native|prepare-android|npm run build|npm --prefix|pip install|--(?:sdk|jdk|image)|continue-on-error/);
  const gate = workflow.split("\n  gate:")[1];
  assert.match(gate, /name: Required verification\n\s+needs: \[plan, tooling, macos, backend, android, device, apple\]\n\s+if: always\(\)/);
  assert.ok(gate.includes("TOOLING_RESULT: ${{ needs.tooling.result }}"));
  assert.match(gate, /pattern: verification-\*/);
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(manifest.scripts["test:tooling"], "node scripts/test-tooling.mjs");
  assert.ok(TOOLING_TEST_FILES.includes("scripts/tests/xcode-mcp.test.mjs"));
  assert.ok(TOOLING_TEST_FILES.includes("scripts/tests/tooling-runner.test.mjs"));
  const executor = await readFile("scripts/verification-executor.mjs", "utf8");
  const adapter = executor.split('definition.group === "tooling" ? {')[1]?.split('} : definition.group === "backend"')[0];
  assert.ok(adapter);
  assert.ok(executor.includes('const npm = process.platform === "win32" ? "npm.cmd" : "npm"'));
  assert.ok(adapter.includes('& ${npm} run test:tooling${progress ? ` --${progressArgument}` : ""}; exit $LASTEXITCODE'));
  assert.ok(adapter.includes("& ${npm} run test:tooling -- --tooling-shard ${check.toolingShard.id}${progressArgument}; exit $LASTEXITCODE"));
  assert.ok(executor.includes('process.env.GITHUB_ACTIONS === "true"'));
  assert.ok(executor.includes('tooling-progress.jsonl'));
  assert.match(adapter, /timeoutMs: progress \? 25 \* 60_000 : 60 \* 60_000/);
});

test("native startup diagnostics are manual-only, reuse the owned entry and never become a verification shard", async () => {
  const startup = (await readFile(".github/workflows/native-startup-diagnostics.yml", "utf8")).replaceAll("\r\n", "\n");
  const events = startup.split("\non:\n")[1].split("\npermissions:\n")[0];
  assert.deepEqual([...events.matchAll(/^  ([A-Za-z_][\w-]*):[ \t]*$/gm)].map((match) => match[1]), ["workflow_dispatch"]);
  assert.deepEqual([...events.matchAll(/^      ([A-Za-z_][\w-]*):[ \t]*$/gm)].map((match) => match[1]), ["base", "variant"]);
  assert.match(events, /base:\n\s+description:.*\n\s+type: string\n\s+required: true/);
  assert.match(events, /variant:\n\s+description:.*\n\s+type: choice\n\s+options:\n\s+- same-build\n\s+- without-build\n\s+default: same-build/);
  assert.match(startup, /^permissions:\n  contents: read\n/m);
  assert.deepEqual([...startup.split("\njobs:\n")[1].matchAll(/^  ([A-Za-z_][\w-]*):[ \t]*$/gm)]
    .map((match) => match[1]), ["startup"]);
  assert.match(startup, /GIT_CONFIG_KEY_0: core\.autocrlf\n\s+GIT_CONFIG_VALUE_0: 'false'/);
  assert.match(startup, /group: devpocket-native-startup-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: false/);
  assert.match(startup, /runs-on: ubuntu-24\.04/);
  assert.match(startup, /timeout-minutes: 35/);
  assert.match(startup, /uses: actions\/checkout@v7\n\s+with:\n\s+fetch-depth: 0\n\s+persist-credentials: false/);
  assert.ok(startup.includes("BASE_REF: ${{ inputs.base }}"));
  assert.match(startup, /\$base = git merge-base -- HEAD \$env:BASE_REF\n\s+if \(\$LASTEXITCODE -ne 0 -or -not \$base\) \{ throw /);
  assert.ok(startup.includes('"sha=$base" >> $env:GITHUB_OUTPUT'));
  assert.ok(startup.includes("BASE_SHA: ${{ steps.base.outputs.sha }}"));
  assert.ok(startup.includes("STARTUP_VARIANT: ${{ inputs.variant }}"));
  assert.match(startup, /uses: \.\/\.github\/actions\/prepare-native/);
  assert.match(startup, /node scripts\/native-startup\.mjs --base \$env:BASE_SHA --variant \$env:STARTUP_VARIANT `\n\s+--directory \.data\/ci\/native-startup --jdk \$env:JAVA_HOME --sdk \$env:ANDROID_HOME `\n\s+--image system-images\/android-37\.0\/google_apis\/x86_64 --github\n\s+exit \$LASTEXITCODE/);
  assert.ok(startup.includes("CURRENT_OWNER: ${{ steps.probe.outputs.startup_run_id }}"));
  assert.match(startup, /--job startup --step-result \$env:STEP_RESULT --owner=\$env:CURRENT_OWNER --github/);
  assert.match(startup, /uses: actions\/upload-artifact@v7\n\s+if: always\(\) && steps\.diagnostics\.outputs\.startup_report_ready == 'true'/);
  assert.match(startup, /name: native-startup-diagnostic\n\s+path: \.data\/ci\/native-startup\/public\/startup-report\.json/);
  assert.match(startup, /if-no-files-found: error/);
  assert.doesNotMatch(startup, /Required verification|name: verification-|continue-on-error|pull_request|pull_request_target|push:|schedule:|workflow_run:|workflow_call:|container:|self-hosted/);
});

test("Mac CI cache paths use a step context while preserving private profile gathering settings", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  for (const job of ["macos", "apple"]) {
    const body = workflow.split(`\n  ${job}:`)[1].split(/\n  [a-z][a-z-]*:/)[0];
    const header = body.split("\n    steps:")[0];
    assert.doesNotMatch(header, /\$\{\{\s*runner\./);
    assert.match(header, /DOTNET_MultiCoreJitNoProfileGather: '1'/);
    assert.match(body, /\n {10}XDG_CACHE_HOME: \$\{\{ runner\.temp \}\}\/devpocket-cache/);
  }
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
