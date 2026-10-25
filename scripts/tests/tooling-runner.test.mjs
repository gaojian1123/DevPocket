import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { TOOLING_TEST_FILES, TOOLING_TEST_SHARDS } from "../test-tooling.mjs";

const exec = promisify(execFile);

async function fixture(t) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/tooling runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts/tests"), { recursive: true });
  const entry = path.join(root, "scripts/test-tooling.mjs");
  await copyFile("scripts/test-tooling.mjs", entry);
  const env = { ...process.env, DEVPOCKET_TOOLING_ISOLATION: "parent" };
  delete env.NODE_TEST_CONTEXT;
  return { root, entry, env };
}

async function run(item, args) {
  try {
    return { code: 0, signal: null, ...await exec(process.execPath, args,
      { cwd: item.root, env: item.env, timeout: 30_000 }) };
  } catch (error) {
    if (typeof error.code !== "number" && !error.signal) throw error;
    return { code: error.code, signal: error.signal, stdout: error.stdout, stderr: error.stderr };
  }
}

test("the dedicated tooling entry retains the complete explicit suite without directory discovery", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(manifest.scripts["test:tooling"], "node scripts/test-tooling.mjs");
  assert.deepEqual(TOOLING_TEST_FILES, [
    "verification", "verification-execution", "verification-refinement", "verification-diagnostics", "android-runner", "android-build", "android-diagnostics",
    "device-diagnostics", "platform-diagnostics", "backend-diagnostics", "worker-diagnostics", "native-lifecycle",
    "bounded-worker-log", "development-tools", "development-approval", "process", "emulator-resources", "manual-emulator",
    "linux-emulator", "linux-runtime", "xcode-mcp", "tooling-runner", "macos-host",
  ].map((name) => `scripts/tests/${name}.test.mjs`));
  assert.equal(new Set(TOOLING_TEST_FILES).size, TOOLING_TEST_FILES.length);
  assert.deepEqual(TOOLING_TEST_SHARDS.flatMap((part) => part.files).sort(), [...TOOLING_TEST_FILES].sort());
  assert.deepEqual(TOOLING_TEST_SHARDS.find((part) => part.id === "candidate").files,
    ["scripts/tests/development-tools.test.mjs", "scripts/tests/development-approval.test.mjs"]);
  assert.ok(TOOLING_TEST_SHARDS.find((part) => part.id === "native").files.includes("scripts/tests/verification-refinement.test.mjs"));
  for (const file of TOOLING_TEST_FILES) await readFile(file);
  const development = await readFile("scripts/tests/development-tools.test.mjs", "utf8");
  assert.doesNotMatch(development, /import\(["']\.\/xcode-mcp\.test\.mjs["']\)/);
});

test("the standalone approval contracts run without Git, PowerShell, signing or candidate fixtures", async (t) => {
  const item = await fixture(t);
  item.env.PATH = item.root;
  const entry = path.resolve("scripts/tests/development-approval.test.mjs");
  const result = await run(item, ["--test", "--test-reporter=tap", entry]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /^# tests 10\r?$/m);
  assert.match(result.stdout, /^# skipped 0\r?$/m);
  assert.match(result.stdout, /^# fail 0\r?$/m);
  const quick = await readFile(entry, "utf8");
  const full = await readFile("scripts/tests/development-tools.test.mjs", "utf8");
  const names = [...quick.matchAll(/^test\("([^"]+)"/gm)].map((match) => match[1]);
  assert.equal(names.length, 10);
  assert.ok(names.every((name) => !full.includes(`test("${name}"`)), "Moved contracts must run exactly once in the full suite.");
  assert.doesNotMatch(quick,
    /(?:from\s+|import\(\s*)["'](?:node:(?:child_process|fs(?:\/promises)?)|\.\.\/(?:candidate-commit|native-candidate|verification)\.mjs)["']/);
});

test("the runner preserves Node file isolation, inherited environment, complete execution and failure status", async (t) => {
  const item = await fixture(t);
  await mkdir(path.join(item.root, "records"));
  for (const [index, file] of TOOLING_TEST_FILES.entries()) {
    await writeFile(path.join(item.root, file), [
      'import assert from "node:assert/strict";',
      'import { writeFile } from "node:fs/promises";',
      'import { performance } from "node:perf_hooks";',
      'import { test } from "node:test";',
      'import { isMainThread } from "node:worker_threads";',
      `test("tooling fixture ${index}", async () => {`,
      '  assert.equal(process.env.DEVPOCKET_TOOLING_ISOLATION, "parent");',
      '  assert.equal(isMainThread, true);',
      `  process.env.DEVPOCKET_TOOLING_ISOLATION = ${JSON.stringify(file)};`,
      `  await writeFile("records/${index}.json", JSON.stringify({ file: ${JSON.stringify(file)}, pid: process.pid, startedAt: performance.timeOrigin }));`,
      `  if (process.env.DEVPOCKET_TOOLING_FAIL === ${JSON.stringify(file)}) assert.fail("fixture failure");`,
      '});',
    ].join("\n"));
  }
  for (const name of ["extension-package", "linux-process", "unlisted"]) {
    await writeFile(path.join(item.root, `scripts/tests/${name}.test.mjs`), 'throw new Error("Unlisted test executed");\n');
  }
  for (const failing of [false, true]) {
    if (failing) item.env.DEVPOCKET_TOOLING_FAIL = TOOLING_TEST_FILES[0];
    const direct = await run(item, ["--test", "--test-reporter=tap", ...TOOLING_TEST_FILES]);
    await rm(path.join(item.root, "records"), { recursive: true });
    await mkdir(path.join(item.root, "records"));
    const result = await run(item, [item.entry, "--test-reporter=tap"]);
    assert.equal(direct.code, failing ? 1 : 0, direct.stderr + direct.stdout);
    assert.equal(result.code, direct.code, result.stderr + result.stdout);
    assert.equal(result.signal, null);
    const records = await Promise.all((await readdir(path.join(item.root, "records"))).map(async (file) =>
      JSON.parse(await readFile(path.join(item.root, "records", file), "utf8"))));
    assert.deepEqual(records.map((record) => record.file).sort(), [...TOOLING_TEST_FILES].sort());
    assert.ok(records.every((record) => Number.isFinite(record.startedAt) && record.startedAt > 0));
    // An exited child's PID can be recycled before later files start on a small runner.
    assert.equal(new Set(records.map((record) => `${record.pid}:${record.startedAt}`)).size, TOOLING_TEST_FILES.length);
    for (const output of [direct.stdout, result.stdout]) {
      assert.match(output, new RegExp(`^# tests ${TOOLING_TEST_FILES.length}\\r?$`, "m"));
      assert.match(output, new RegExp(`^# fail ${failing ? 1 : 0}\\r?$`, "m"));
      assert.doesNotMatch(output, /Unlisted test executed/);
    }
  }
});

test("the launcher leaves concurrency and isolation at Node defaults and propagates exits, errors and signals", async (t) => {
  const item = await fixture(t);
  const guard = path.join(item.root, "observe-spawn.mjs");
  await writeFile(guard, [
    'import childProcess from "node:child_process";',
    'import { EventEmitter } from "node:events";',
    'import { writeFileSync } from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    'childProcess.spawn = (file, args, options) => {',
    '  writeFileSync("spawn.json", JSON.stringify({ file, args, options }));',
    '  const child = new EventEmitter();',
    '  child.kill = (signal) => {',
    '    writeFileSync("forwarded.json", JSON.stringify(signal));',
    '    child.emit("close", null, signal);',
    '    return true;',
    '  };',
    '  queueMicrotask(() => {',
    '    const mode = process.env.DEVPOCKET_TOOLING_MODE;',
    '    if (mode === "parent-signal") process.emit("SIGTERM", "SIGTERM");',
    '    else if (mode === "child-signal") child.emit("close", null, "SIGTERM");',
    '    else if (mode === "error") {',
    '      child.emit("error", new Error("fixture launch failure"));',
    '      child.emit("close", -2, null);',
    '    } else child.emit("close", mode === "exit" ? 37 : 0, null);',
    '  });',
    '  return child;',
    '};',
    'syncBuiltinESMExports();',
  ].join("\n"));
  const modes = ["success", "exit", "error", ...(process.platform === "win32" ? [] : ["child-signal", "parent-signal"])];
  for (const mode of modes) {
    item.env.DEVPOCKET_TOOLING_MODE = mode;
    const args = mode === "success" ? [] : ["--test-reporter=tap"];
    const result = await run(item, ["--import", pathToFileURL(guard).href, item.entry, ...args]);
    const launch = JSON.parse(await readFile(path.join(item.root, "spawn.json"), "utf8"));
    assert.deepEqual(launch, {
      file: process.execPath, args: ["--test", ...args, ...TOOLING_TEST_FILES], options: { stdio: "inherit" },
    });
    if (mode.endsWith("signal")) {
      assert.equal(result.signal, "SIGTERM");
      if (mode === "parent-signal") {
        assert.equal(JSON.parse(await readFile(path.join(item.root, "forwarded.json"), "utf8")), "SIGTERM");
      }
    } else {
      assert.equal(result.code, mode === "exit" ? 37 : mode === "error" ? 1 : 0, result.stderr);
      if (mode === "error") assert.match(result.stderr, /Unable to start tooling tests: fixture launch failure/);
    }
  }
  item.env.DEVPOCKET_TOOLING_MODE = "success";
  const part = TOOLING_TEST_SHARDS[0];
  const sharded = await run(item, ["--import", pathToFileURL(guard).href, item.entry, "--tooling-shard", part.id]);
  assert.equal(sharded.code, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(item.root, "spawn.json"), "utf8")),
    { file: process.execPath, args: ["--test", ...part.files], options: { stdio: "inherit" } });
  const invalid = await run(item, [item.entry, "--tooling-shard", part.id, "--test-name-pattern=not-a-full-shard"]);
  assert.notEqual(invalid.code, 0);
});
