import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { WORKFLOW_TEST_FILES, WORKFLOW_TEST_SHARDS } from "../test-workflow.mjs";

const exec = promisify(execFile);

async function fixture(t) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/workflow runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts/tests"), { recursive: true });
  const entry = path.join(root, "scripts/test-workflow.mjs");
  await copyFile("scripts/test-workflow.mjs", entry);
  const env = { ...process.env, DEVPOCKET_WORKFLOW_ISOLATION: "parent" };
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

test("the dedicated workflow entry retains the complete explicit suite without directory discovery", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(manifest.scripts["test:workflow"], "node scripts/test-workflow.mjs");
  assert.deepEqual(WORKFLOW_TEST_FILES, [
    "verification", "verification-execution", "verification-diagnostics", "android-runner", "android-build", "android-diagnostics",
    "device-diagnostics", "platform-diagnostics", "backend-diagnostics", "worker-diagnostics", "native-lifecycle",
    "bounded-worker-log", "development-workflow", "process", "emulator-resources", "manual-emulator",
    "linux-emulator", "linux-runtime", "xcode-mcp", "workflow-runner", "macos-host",
  ].map((name) => `scripts/tests/${name}.test.mjs`));
  assert.equal(new Set(WORKFLOW_TEST_FILES).size, WORKFLOW_TEST_FILES.length);
  assert.deepEqual(WORKFLOW_TEST_SHARDS.flatMap((part) => part.files).sort(), [...WORKFLOW_TEST_FILES].sort());
  for (const file of WORKFLOW_TEST_FILES) await readFile(file);
  const development = await readFile("scripts/tests/development-workflow.test.mjs", "utf8");
  assert.doesNotMatch(development, /import\(["']\.\/xcode-mcp\.test\.mjs["']\)/);
});

test("the runner preserves Node file isolation, inherited environment, complete execution and failure status", async (t) => {
  const item = await fixture(t);
  await mkdir(path.join(item.root, "records"));
  for (const [index, file] of WORKFLOW_TEST_FILES.entries()) {
    await writeFile(path.join(item.root, file), [
      'import assert from "node:assert/strict";',
      'import { writeFile } from "node:fs/promises";',
      'import { performance } from "node:perf_hooks";',
      'import { test } from "node:test";',
      'import { isMainThread } from "node:worker_threads";',
      `test("workflow fixture ${index}", async () => {`,
      '  assert.equal(process.env.DEVPOCKET_WORKFLOW_ISOLATION, "parent");',
      '  assert.equal(isMainThread, true);',
      `  process.env.DEVPOCKET_WORKFLOW_ISOLATION = ${JSON.stringify(file)};`,
      `  await writeFile("records/${index}.json", JSON.stringify({ file: ${JSON.stringify(file)}, pid: process.pid, startedAt: performance.timeOrigin }));`,
      `  if (process.env.DEVPOCKET_WORKFLOW_FAIL === ${JSON.stringify(file)}) assert.fail("fixture failure");`,
      '});',
    ].join("\n"));
  }
  for (const name of ["extension-package", "linux-process", "unlisted"]) {
    await writeFile(path.join(item.root, `scripts/tests/${name}.test.mjs`), 'throw new Error("Unlisted test executed");\n');
  }
  for (const failing of [false, true]) {
    if (failing) item.env.DEVPOCKET_WORKFLOW_FAIL = WORKFLOW_TEST_FILES[0];
    const direct = await run(item, ["--test", "--test-reporter=tap", ...WORKFLOW_TEST_FILES]);
    await rm(path.join(item.root, "records"), { recursive: true });
    await mkdir(path.join(item.root, "records"));
    const result = await run(item, [item.entry, "--test-reporter=tap"]);
    assert.equal(direct.code, failing ? 1 : 0, direct.stderr + direct.stdout);
    assert.equal(result.code, direct.code, result.stderr + result.stdout);
    assert.equal(result.signal, null);
    const records = await Promise.all((await readdir(path.join(item.root, "records"))).map(async (file) =>
      JSON.parse(await readFile(path.join(item.root, "records", file), "utf8"))));
    assert.deepEqual(records.map((record) => record.file).sort(), [...WORKFLOW_TEST_FILES].sort());
    assert.ok(records.every((record) => Number.isFinite(record.startedAt) && record.startedAt > 0));
    // An exited child's PID can be recycled before later files start on a small runner.
    assert.equal(new Set(records.map((record) => `${record.pid}:${record.startedAt}`)).size, WORKFLOW_TEST_FILES.length);
    for (const output of [direct.stdout, result.stdout]) {
      assert.match(output, new RegExp(`^# tests ${WORKFLOW_TEST_FILES.length}\\r?$`, "m"));
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
    '    const mode = process.env.DEVPOCKET_WORKFLOW_MODE;',
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
    item.env.DEVPOCKET_WORKFLOW_MODE = mode;
    const args = mode === "success" ? [] : ["--test-reporter=tap"];
    const result = await run(item, ["--import", pathToFileURL(guard).href, item.entry, ...args]);
    const launch = JSON.parse(await readFile(path.join(item.root, "spawn.json"), "utf8"));
    assert.deepEqual(launch, {
      file: process.execPath, args: ["--test", ...args, ...WORKFLOW_TEST_FILES], options: { stdio: "inherit" },
    });
    if (mode.endsWith("signal")) {
      assert.equal(result.signal, "SIGTERM");
      if (mode === "parent-signal") {
        assert.equal(JSON.parse(await readFile(path.join(item.root, "forwarded.json"), "utf8")), "SIGTERM");
      }
    } else {
      assert.equal(result.code, mode === "exit" ? 37 : mode === "error" ? 1 : 0, result.stderr);
      if (mode === "error") assert.match(result.stderr, /Unable to start workflow tests: fixture launch failure/);
    }
  }
  item.env.DEVPOCKET_WORKFLOW_MODE = "success";
  const part = WORKFLOW_TEST_SHARDS[0];
  const sharded = await run(item, ["--import", pathToFileURL(guard).href, item.entry, "--workflow-shard", part.id]);
  assert.equal(sharded.code, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(item.root, "spawn.json"), "utf8")),
    { file: process.execPath, args: ["--test", ...part.files], options: { stdio: "inherit" } });
  const invalid = await run(item, [item.entry, "--workflow-shard", part.id, "--test-name-pattern=not-a-full-shard"]);
  assert.notEqual(invalid.code, 0);
});
