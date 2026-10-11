import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const entry = path.resolve("scripts/verify.mjs");

async function repository(t) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/verification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".data/\n**/build/\n");
  await writeFile(path.join(root, "README.md"), "Original documentation\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
    "test:workflow": "node -e \"process.exit(0)\"",
    typecheck: "node -e \"process.exit(23)\"",
    test: "node -e \"process.exit(0)\"",
    build: "node -e \"process.exit(0)\"",
    schema: "node -e \"process.exit(0)\"",
  } }));
  await exec("git", ["init", "--quiet", root]);
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Fixture"], { cwd: root });
  return root;
}

async function verify(root, args) {
  const report = path.join(root, ".data", "verification", `${randomUUID()}.json`);
  let exitCode = 0;
  try {
    await exec(process.execPath, [entry, "--repo", root, "--base", "HEAD", "--report", report, ...args],
      { timeout: 60_000 });
  } catch (error) {
    exitCode = error.code;
  }
  return { exitCode, report: JSON.parse(await readFile(report, "utf8")) };
}

test("a documentation plan identifies the exact source without claiming checks ran", async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, "README.md"), "Revised documentation\n");
  const result = await verify(root, ["--plan"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.status, "planned");
  assert.equal(result.report.complete, false);
  assert.deepEqual(result.report.changedFiles, ["README.md"]);
  assert.deepEqual(result.report.requiredChecks, []);
  assert.match(result.report.source.fingerprint, /^[a-f0-9]{64}$/);
});

test("app, wire and unknown changes cannot omit device checks or lower their risk", async (t) => {
  for (const file of [
    "android/app/src/main/java/Screen.kt",
    "backend/src/protocol.ts",
    "scripts/verify.mjs",
    "new-unclassified-file",
  ]) {
    await t.test(file, async (t) => {
      const root = await repository(t);
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "fixture");
      const result = await verify(root, ["--plan"]);
      assert.equal(result.exitCode, 0);
      assert.ok(result.report.requiredChecks.includes("android-device"));
      assert.ok(result.report.requiredChecks.includes("android-build"));
      if (!file.startsWith("android/")) assert.equal(result.report.requiresHumanReview, true);
    });
  }
});

test("a failed command exits unsuccessfully and leaves later required checks not_run", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "backend", "tests"), { recursive: true });
  await writeFile(path.join(root, "backend", "tests", "fixture.test.ts"), "// fixture\n");
  const result = await verify(root, []);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.complete, false);
  assert.equal(result.report.checks.find((check) => check.id === "typecheck").status, "failed");
  assert.equal(result.report.checks.find((check) => check.id === "typecheck").exitCode, 23);
  assert.equal(result.report.checks.find((check) => check.id === "backend-tests").status, "not_run");
});

test("combining reports refuses absent device evidence and stale source fingerprints", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "android"), { recursive: true });
  await writeFile(path.join(root, "android", "screen.kt"), "// fixture\n");
  const planned = (await verify(root, ["--plan"])).report;
  const input = path.join(root, ".data", "android.json");
  const shard = {
    ...planned, group: "android", status: "partial", complete: false,
    checks: [{ id: "android-build", status: "passed", exitCode: 0 }, { id: "android-device", status: "not_run" }],
  };
  await writeFile(input, JSON.stringify(shard));
  let result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.complete, false);
  assert.match(result.report.error, /android-device/);
  await writeFile(input, JSON.stringify({
    ...shard, group: "all", status: "passed", complete: true,
    checks: planned.requiredChecks.map((id) => ({ id, status: "passed", exitCode: 0,
      ...(id === "android-device" ? { deviceEvidence: {
        status: "passed", cleanup: "completed", source: planned.source, evidence: "emulator-test-sdk-adapter",
        runId: "11111111-1111-4111-8111-111111111111",
        discoveredClasses: ["dev.devpocket.app.AdaptiveLayoutTest", "dev.devpocket.app.FixtureFlowTest", "dev.devpocket.app.NativeFlowTest"],
        apkSha256: "a".repeat(64), testApkSha256: "b".repeat(64), tests: 4,
        cases: [
          { name: "native", class: "dev.devpocket.app.NativeFlowTest", status: "passed", tests: 2 },
          { name: "layout-compact", class: "dev.devpocket.app.AdaptiveLayoutTest", status: "passed", tests: 1 },
          { name: "fixture", class: "dev.devpocket.app.FixtureFlowTest", status: "passed", tests: 1 },
        ],
      } } : {}),
    })),
  }));
  result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.complete, true);
  const linux = JSON.parse(await readFile(input, "utf8"));
  linux.environment = { platform: "linux" };
  const native = linux.checks.find((check) => check.id === "android-device").deviceEvidence;
  await writeFile(input, JSON.stringify(linux));
  result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 1, "Linux reports cannot omit platform/acceleration evidence.");
  native.platform = "linux";
  native.acceleration = { provider: "WHPX", usable: true };
  await writeFile(input, JSON.stringify(linux));
  result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 1, "A different hypervisor cannot qualify Linux KVM.");
  native.acceleration = { provider: "KVM", usable: true };
  await writeFile(input, JSON.stringify(linux));
  result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 0);
  await writeFile(path.join(root, "android", "screen.kt"), "// new source\n");
  result = await verify(root, ["--combine", "--input", input]);
  assert.equal(result.exitCode, 1);
  assert.match(result.report.error, /source|Source/);
});

test("source changes made by a successful check invalidate its green result", async (t) => {
  const root = await repository(t);
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  manifest.scripts.typecheck = "node -e \"require('fs').writeFileSync('README.md','changed by check')\"";
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Check fixture"], { cwd: root });
  await mkdir(path.join(root, "backend", "tests"), { recursive: true });
  await writeFile(path.join(root, "backend", "tests", "fixture.ts"), "// fixture\n");
  const result = await verify(root, []);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.complete, false);
  assert.match(result.report.error, /Source changed/);
});

test("a zero-exit device command without instrumentation evidence cannot pass its shard", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "test-android.ps1"),
    "param($Jdk,$Sdk,$Image,$RunDirectory,[switch]$Layouts)\nexit 0\n");
  const result = await verify(root, ["--group", "device"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.complete, false);
  assert.equal(result.report.checks.find((check) => check.id === "android-device").status, "blocked");
});

test("Git executable-mode changes invalidate source evidence even when bytes are identical", async (t) => {
  const root = await repository(t);
  const before = (await verify(root, ["--plan"])).report.source.fingerprint;
  await exec("git", ["update-index", "--chmod=+x", "README.md"], { cwd: root });
  const after = (await verify(root, ["--plan"])).report.source.fingerprint;
  assert.notEqual(after, before);
});

test("source fingerprints retain Git modes and bytes across distinct unnormalized checkouts", async (t) => {
  const { sourceSnapshot } = await import("../verification.mjs");
  const root = await repository(t);
  await exec("git", ["update-index", "--chmod=+x", "README.md"], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "Mode fixture"], { cwd: root });
  const clone = `${root}-clone`;
  t.after(() => rm(clone, { recursive: true, force: true }));
  await exec("git", ["-c", "core.autocrlf=false", "clone", "--quiet", "--no-local", root, clone]);
  assert.deepEqual(await sourceSnapshot(clone), await sourceSnapshot(root),
    "Absolute host checkout paths and filesystem executable bits are not source identity.");
  await writeFile(path.join(clone, "README.md"), "Original documentation\r\n");
  assert.notEqual((await sourceSnapshot(clone)).fingerprint, (await sourceSnapshot(root)).fingerprint,
    "Different checkout bytes must not be hidden by normalization.");
});

test("planning refuses sealed or existing evidence destinations without overwriting them", async (t) => {
  const root = await repository(t);
  for (const parts of [["artifacts", "build-002", "build.json"], ["verification", "existing.json"]]) {
    const target = path.join(root, ".data", ...parts);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "sealed evidence");
    await assert.rejects(exec(process.execPath, [entry, "--repo", root, "--base", "HEAD", "--plan", "--report", target]));
    assert.equal(await readFile(target, "utf8"), "sealed evidence");
  }
});

test("blocked native prerequisites remain blocked at the verification interface", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "test-android.ps1"), [
    "param($Jdk,$Sdk,$Image,$RunDirectory,$Owner,[switch]$Layouts)",
    "New-Item -ItemType Directory -Path $RunDirectory | Out-Null",
    "@{version=1;runId=$Owner;status='blocked';tests=0;cases=@();cleanup='completed';error='Missing test image.'} | ConvertTo-Json | Set-Content (Join-Path $RunDirectory 'device-report.json')",
    "exit 1", "",
  ].join("\n"));
  const result = await verify(root, ["--group", "device"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.checks.find((check) => check.id === "android-device").status, "blocked");
});

test("controller cancellation removes only its owned device data after the process job stops", async (t) => {
  const { executeVerification, verificationPlan } = await import("../verification.mjs");
  const root = await repository(t);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "runner-fixture.mjs"), [
    "import {mkdir,writeFile} from 'node:fs/promises'; import path from 'node:path';",
    "const [directory,runId]=process.argv.slice(2);",
    "await mkdir(directory);",
    "await writeFile(path.join(directory,'owner.json'),JSON.stringify({version:1,root:process.cwd(),runId,pid:process.pid}));",
    "await mkdir(path.join(directory,'fixture'));",
    "await writeFile(path.join(directory,'fixture','synthetic.txt'),'fixture-only');",
    "process.stdin.on('data',()=>process.exit(1)); setInterval(()=>{},1000);",
  ].join("\n"));
  await writeFile(path.join(root, "scripts", "test-android.ps1"), [
    "param($Jdk,$Sdk,$Image,$RunDirectory,$Owner,[switch]$Layouts)",
    "& node (Join-Path $PSScriptRoot 'runner-fixture.mjs') $RunDirectory $Owner",
    "exit $LASTEXITCODE", "",
  ].join("\n"));
  const controller = new AbortController();
  const directory = path.join(root, ".data", "verification", "cancel");
  const running = executeVerification(root, await verificationPlan(root, "HEAD"), {
    group: "device", directory, signal: controller.signal,
  });
  const marker = path.join(directory, "device", "fixture", "synthetic.txt");
  let started = false;
  for (let attempt = 0; attempt < 400; attempt++) {
    try { await readFile(marker); started = true; break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  controller.abort();
  const report = await running;
  assert.equal(started, true, "The owned fixture must start before cancellation.");
  assert.equal(report.status, "blocked");
  const check = report.checks.find((item) => item.id === "android-device");
  assert.equal(check.cleanup, "completed", JSON.stringify({
    check, log: await readFile(path.join(directory, "android-device.log"), "utf8"),
  }));
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("a device shard accepts current complete case and APK evidence without fabricating other shards", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "scripts"));
  const module = pathToFileURL(path.resolve("scripts/verification.mjs")).href;
  await writeFile(path.join(root, "scripts", "device-fixture.mjs"), [
    "import {mkdir,writeFile} from 'node:fs/promises'; import path from 'node:path'; import {createHash} from 'node:crypto';",
    `import {sourceSnapshot} from ${JSON.stringify(module)};`,
    "const [directory,runId]=process.argv.slice(2); await mkdir(directory);",
    "const apk=path.resolve('android/app/build/outputs/apk/debug/app-debug.apk');",
    "const testApk=path.resolve('android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk');",
    "for(const file of [apk,testApk]) { await mkdir(path.dirname(file),{recursive:true}); await writeFile(file,'synthetic APK'); }",
    "const cases=[{name:'native',class:'dev.devpocket.app.NativeFlowTest',tests:2,status:'passed'},",
    "...['compact','medium','expanded','landscape','large-font'].map(name=>({name:'layout-'+name,class:'dev.devpocket.app.AdaptiveLayoutTest',tests:1,status:'passed'})),",
    "{name:'fixture',class:'dev.devpocket.app.FixtureFlowTest',tests:1,status:'passed'}];",
    "const sha=createHash('sha256').update('synthetic APK').digest('hex');",
    "await writeFile(path.join(directory,'device-report.json'),JSON.stringify({version:1,runId,status:'passed',cleanup:'completed',",
    "source:await sourceSnapshot(process.cwd()),evidence:'emulator-test-sdk-adapter',apkSha256:sha,testApkSha256:sha,",
    "tests:8,cases,discoveredClasses:['dev.devpocket.app.AdaptiveLayoutTest','dev.devpocket.app.FixtureFlowTest','dev.devpocket.app.NativeFlowTest']}));",
  ].join("\n"));
  await writeFile(path.join(root, "scripts", "test-android.ps1"), [
    "param($Jdk,$Sdk,$Image,$RunDirectory,$Owner,[switch]$Layouts)",
    "& node (Join-Path $PSScriptRoot 'device-fixture.mjs') $RunDirectory $Owner",
    "exit $LASTEXITCODE", "",
  ].join("\n"));
  const result = await verify(root, ["--group", "device"]);
  assert.equal(result.exitCode, 0, JSON.stringify(result.report));
  assert.equal(result.report.status, "partial");
  assert.equal(result.report.complete, false);
  assert.equal(result.report.checks.find((check) => check.id === "android-device").status, "passed");
});

test("schema regeneration preserves a Windows checkout's unchanged source bytes", async (t) => {
  const root = await repository(t);
  const schema = (await readFile("protocol.schema.json", "utf8")).replace(/\r?\n/g, "\r\n");
  await writeFile(path.join(root, "protocol.schema.json"), schema);
  await exec(process.execPath, ["--import", "tsx", path.resolve("scripts/export-schema.ts")], { cwd: root });
  const actual = await readFile(path.join(root, "protocol.schema.json"));
  assert.equal(createHash("sha256").update(actual).digest("hex"),
    createHash("sha256").update(schema).digest("hex"), "Unchanged schema generation must preserve source bytes.");
});

test("the build prerequisite gate blocks before spending a code-repair round", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "build-android.ps1"), await readFile("scripts/build-android.ps1"));
  const result = await verify(root, ["--group", "android", "--jdk", path.join(root, "missing-jdk")]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "blocked");
  assert.equal(result.report.checks.find((check) => check.id === "android-build").status, "blocked");
  assert.equal(result.report.checks.find((check) => check.id === "android-device").status, "not_run");
});
