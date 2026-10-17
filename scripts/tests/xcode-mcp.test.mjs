import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { discoverMcpbridge, installXcodeMcp, syncXcodeMcp } from "../setup-xcode-mcp.mjs";

const exec = promisify(execFile);
const server = { type: "local", command: "/usr/bin/xcrun", args: ["mcpbridge"], tools: ["*"] };
const available = async () => ({ available: true });
const supported = (cwd) => ({ cwd, platform: "darwin", probe: available });
const previousGitEnvironment = new Map(["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_TEMPLATE_DIR", "GIT_EXEC_PATH",
  "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_QUARANTINE_PATH"].map((key) => [key, process.env[key]]));
let gitConfigDirectory;
before(async () => {
  await mkdir(".data/tests", { recursive: true });
  gitConfigDirectory = await mkdtemp(path.resolve(".data/tests/xcode-git-config-"));
  const gitConfig = path.join(gitConfigDirectory, "config");
  await writeFile(gitConfig, "", { mode: 0o600 });
  for (const key of previousGitEnvironment.keys()) delete process.env[key];
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
});
after(async () => {
  for (const [key, value] of previousGitEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (gitConfigDirectory) await rm(gitConfigDirectory, { recursive: true, force: true });
});

async function temporary(t) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/xcode-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function git(root, ...args) {
  return (await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
    { cwd: root, encoding: "utf8", timeout: 20_000 })).stdout.trim();
}

async function repository(t) {
  const parent = await temporary(t), root = path.join(parent, "repository with ' spaces");
  await mkdir(root);
  await git(root, "-c", "init.templateDir=", "init", "--quiet");
  await mkdir(path.join(root, ".git/hooks"), { recursive: true });
  await mkdir(path.join(root, ".git/info"), { recursive: true });
  await git(root, "config", "--local", "commit.gpgsign", "false");
  await git(root, "config", "--local", "core.hooksPath", path.join(root, ".git/hooks"));
  await writeFile(path.join(root, "README.md"), "Disposable Git hook fixture.\n");
  await writeFile(path.join(root, ".gitignore"), "/.mcp.json\n/.mcp.json.lock\n");
  await git(root, "add", "README.md", ".gitignore");
  await git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "Fixture");
  await git(root, "config", "--local", "--unset", "core.hooksPath");
  return root;
}

const configPath = (root) => path.join(root, ".mcp.json");
const config = async (root) => JSON.parse(await readFile(configPath(root), "utf8"));
const absent = async (file) => assert.rejects(lstat(file), { code: "ENOENT" });

test("Git fixtures use a regular empty config instead of an OS-specific null device", async () => {
  assert.equal(process.env.GIT_CONFIG_GLOBAL, path.join(gitConfigDirectory, "config"));
  assert.equal((await lstat(process.env.GIT_CONFIG_GLOBAL)).isFile(), true);
  assert.equal(await readFile(process.env.GIT_CONFIG_GLOBAL, "utf8"), "");
});

test("the shared template has the requested native configuration but is not an auto-loaded file", async () => {
  const template = JSON.parse(await readFile(new URL("../../config/xcode-mcp.example.json", import.meta.url), "utf8"));
  assert.deepEqual(template, { mcpServers: { xcode: server } });
});

test("Windows and Linux initialization do not probe Xcode, inspect Git, or write files", async (t) => {
  for (const platform of ["win32", "linux"]) {
    const root = await temporary(t);
    for (const action of [installXcodeMcp, syncXcodeMcp]) {
      const result = await action({ cwd: root, platform, probe: () => assert.fail("Unexpected Xcode probe") });
      assert.equal(result.status, "skipped");
      assert.match(result.reason, /macOS/);
    }
    assert.deepEqual(await readdir(root), []);
  }
});

test("a Mac without mcpbridge is explicitly skipped before creating any files", async (t) => {
  const root = await temporary(t);
  for (const action of [installXcodeMcp, syncXcodeMcp]) {
    assert.deepEqual(await action({ cwd: root, platform: "darwin",
      probe: async () => ({ available: false, reason: "Xcode unavailable." }) }),
    { status: "skipped", reason: "Xcode unavailable." });
  }
  assert.deepEqual(await readdir(root), []);
});

test("mcpbridge discovery is a bounded read-only lookup, not a server launch", async (t) => {
  const root = await temporary(t), executable = path.join(root, "mcpbridge");
  await writeFile(executable, "", { mode: 0o700 });
  const found = await discoverMcpbridge(async (command, args, options) => {
    assert.equal(command, "/usr/bin/xcrun");
    assert.deepEqual(args, ["--find", "mcpbridge"]);
    assert.equal(options.timeout, 5000);
    return { stdout: `${executable}\n` };
  });
  assert.deepEqual(found, { available: true });
  for (const code of [72, "ENOENT"]) {
    assert.equal((await discoverMcpbridge(async () => { throw Object.assign(new Error("Unavailable"), { code }); })).available, false);
  }
  await assert.rejects(discoverMcpbridge(async () => ({ stdout: "relative/path\n" })), /invalid mcpbridge path/);
  await assert.rejects(discoverMcpbridge(async () => {
    throw Object.assign(new Error("Probe timed out"), { code: "ETIMEDOUT", killed: true });
  }), /Probe timed out/);
});

test("initialization writes only the native Xcode entry at the repository root", async (t) => {
  const root = await repository(t), nested = path.join(root, "nested");
  await mkdir(nested);
  assert.equal((await syncXcodeMcp(supported(nested))).status, "configured");
  assert.deepEqual(await config(root), { mcpServers: { xcode: server } });
  await absent(path.join(nested, ".mcp.json"));
  await absent(`${configPath(root)}.lock`);
  if (process.platform !== "win32") assert.equal((await lstat(configPath(root))).mode & 0o777, 0o600);
});

test("wrapped and bare server maps preserve other entries, and repeat initialization preserves bytes", async (t) => {
  const other = { type: "http", url: "https://example.test/mcp", headers: { Authorization: "fixture-only" } };
  for (const original of [{ mcpServers: { other }, metadata: { note: "keep" } }, { other }]) {
    const root = await repository(t);
    await writeFile(configPath(root), JSON.stringify(original) + "\n", { mode: 0o640 });
    await syncXcodeMcp(supported(root));
    assert.deepEqual(await config(root), Object.hasOwn(original, "mcpServers")
      ? { ...original, mcpServers: { other, xcode: server } } : { other, xcode: server });
    if (process.platform !== "win32") assert.equal((await lstat(configPath(root))).mode & 0o777, 0o640);
    const before = await readFile(configPath(root)), mtime = (await lstat(configPath(root))).mtimeMs;
    assert.equal((await syncXcodeMcp(supported(root))).status, "unchanged");
    assert.deepEqual(await readFile(configPath(root)), before);
    assert.equal((await lstat(configPath(root))).mtimeMs, mtime);
  }
});

test("invalid JSON, invalid maps and conflicting Xcode entries are never overwritten", async (t) => {
  for (const text of ["private-fixture-token", "null", "[]", '{"mcpServers":[]}',
    JSON.stringify({ mcpServers: { xcode: { ...server, args: ["custom"] } } })]) {
    const root = await repository(t);
    await writeFile(configPath(root), text);
    await assert.rejects(syncXcodeMcp(supported(root)), (error) => {
      assert.doesNotMatch(error.message, /private-fixture-token/);
      return /JSON|object|different xcode/.test(error.message);
    });
    assert.equal(await readFile(configPath(root), "utf8"), text);
    await absent(`${configPath(root)}.lock`);
  }
});

test("tracked MCP configuration and existing update locks stop initialization without writes", async (t) => {
  const root = await repository(t), text = '{"mcpServers":{}}\n';
  await writeFile(configPath(root), text);
  await git(root, "add", "--force", ".mcp.json");
  await assert.rejects(installXcodeMcp(supported(root)), /is tracked/);
  await absent(path.join(root, ".git/hooks/post-checkout"));
  await absent(path.join(root, ".git/devpocket-xcode-mcp"));
  await git(root, "rm", "--cached", ".mcp.json");
  await writeFile(`${configPath(root)}.lock`, "existing lock");
  await assert.rejects(syncXcodeMcp(supported(root)), /Another update may be active/);
  assert.equal(await readFile(configPath(root), "utf8"), text);
  assert.equal(await readFile(`${configPath(root)}.lock`, "utf8"), "existing lock");
});

test("symlinked MCP files and hook directories are not followed", { skip: process.platform === "win32" }, async (t) => {
  const root = await repository(t), outside = path.join(path.dirname(root), "outside.json");
  await writeFile(outside, '{"mcpServers":{}}\n');
  await symlink(outside, configPath(root));
  await assert.rejects(syncXcodeMcp(supported(root)), /non-regular file/);
  assert.equal(await readFile(outside, "utf8"), '{"mcpServers":{}}\n');
  await rm(configPath(root));
  const hooks = path.join(root, ".git/hooks"), otherHooks = path.join(path.dirname(root), "other-hooks");
  await mkdir(otherHooks);
  await rm(hooks, { recursive: true });
  await symlink(otherHooks, hooks);
  await assert.rejects(installXcodeMcp(supported(root)), /non-directory or symlink/);
  assert.deepEqual(await readdir(otherHooks), []);
});

test("installation preserves existing hooks and configured hook paths", async (t) => {
  const root = await repository(t), hookFile = path.join(root, ".git/hooks/post-checkout");
  const hook = "#!/bin/sh\nexit 0\n";
  await writeFile(hookFile, hook, { mode: 0o700 });
  await assert.rejects(installXcodeMcp(supported(root)), /existing post-checkout hook was preserved/);
  assert.equal(await readFile(hookFile, "utf8"), hook);
  await absent(configPath(root));
  await absent(path.join(root, ".git/devpocket-xcode-mcp"));
  await rm(hookFile);
  await git(root, "config", "--local", "core.hooksPath", ".custom-hooks");
  await assert.rejects(installXcodeMcp(supported(root)), /core.hooksPath is already configured/);
  assert.equal(await git(root, "config", "--get", "core.hooksPath"), ".custom-hooks");
  await absent(configPath(root));
});

test("effective ignore conflicts refuse configuration and lock creation without rewriting rules", async (t) => {
  for (const name of [".mcp.json", ".mcp.json.lock"]) {
    const root = await repository(t), ignores = `/.mcp.json\n/.mcp.json.lock\n!/${name}\n`;
    await writeFile(path.join(root, ".gitignore"), ignores);
    for (const action of [installXcodeMcp, syncXcodeMcp]) {
      await assert.rejects(action(supported(root)), /not effectively ignored/);
      await absent(configPath(root));
      await absent(`${configPath(root)}.lock`);
    }
    await absent(path.join(root, ".git/hooks/post-checkout"));
    assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), ignores);
  }
});

test("fixture subprocesses ignore inherited hook and object-storage overrides", async (t) => {
  const root = await temporary(t), hooks = path.join(root, "foreign-hooks"), objects = path.join(root, "foreign-objects");
  await mkdir(hooks);
  await mkdir(objects);
  await writeFile(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 87\n", { mode: 0o700 });
  for (const environment of [
    { GIT_CONFIG_PARAMETERS: `'core.hooksPath=${hooks.replaceAll("'", "'\\''")}'` },
    { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects },
  ]) {
    const env = { ...process.env, ...environment };
    delete env.NODE_TEST_CONTEXT;
    const target = "initialization writes only the native Xcode entry at the repository root";
    const result = await exec(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=^${target}$`,
      "scripts/tests/xcode-mcp.test.mjs"], { cwd: process.cwd(), env, timeout: 30_000 });
    assert.match(result.stdout, new RegExp(`^ok \\d+ - ${target}\\r?$`, "m"));
    assert.match(result.stdout, /^# pass 1\r?$/m);
    assert.match(result.stdout, /^# fail 0\r?$/m);
    assert.doesNotMatch(result.stderr, /foreign-hooks|exit 87/);
    assert.deepEqual(await readdir(objects), []);
  }
});

test("installation is repository-local, durable, ignored and idempotent", async (t) => {
  const root = await repository(t), exclude = path.join(root, ".git/info/exclude");
  await writeFile(exclude, "/existing-local-file");
  const result = await installXcodeMcp(supported(root));
  assert.equal(result.status, "installed");
  assert.equal(result.hook, path.join(root, ".git/hooks/post-checkout"));
  assert.deepEqual(await config(root), { mcpServers: { xcode: server } });
  assert.equal(await git(root, "check-ignore", ".mcp.json"), ".mcp.json");
  assert.equal(await git(root, "status", "--porcelain"), "");
  const hook = await readFile(result.hook), ignores = await readFile(exclude, "utf8");
  assert.equal(ignores, "/existing-local-file\n/.mcp.json\n/.mcp.json.lock\n");
  assert.match(hook.toString(), /Darwin\) exec/);
  assert.ok(hook.toString().includes(path.join("devpocket-xcode-mcp", "scripts", "setup-xcode-mcp.mjs")));
  assert.deepEqual(await readFile(path.join(root, ".git/devpocket-xcode-mcp/scripts/setup-xcode-mcp.mjs")),
    await readFile(new URL("../setup-xcode-mcp.mjs", import.meta.url)));
  await installXcodeMcp(supported(root));
  assert.deepEqual(await readFile(result.hook), hook);
  assert.equal(await readFile(exclude, "utf8"), ignores);
});

test("a changed installed snapshot is preserved rather than silently upgraded", async (t) => {
  const root = await repository(t);
  await installXcodeMcp(supported(root));
  const installed = path.join(root, ".git/devpocket-xcode-mcp/scripts/setup-xcode-mcp.mjs");
  await writeFile(installed, "locally modified snapshot\n");
  await assert.rejects(installXcodeMcp(supported(root)), /installed snapshot differs/);
  assert.equal(await readFile(installed, "utf8"), "locally modified snapshot\n");
});

test("ordinary Git worktree creation uses the installed snapshot without files in the checked-out branch", async (t) => {
  const root = await repository(t);
  const expectsXcode = process.platform === "darwin" && (await discoverMcpbridge()).available;
  await installXcodeMcp(supported(root));
  const worktree = path.join(path.dirname(root), "new worktree's folder");
  await git(root, "worktree", "add", "--quiet", "--detach", worktree, "HEAD");
  await absent(path.join(worktree, "scripts"));
  if (expectsXcode) {
    assert.deepEqual(await config(worktree), { mcpServers: { xcode: server } });
    assert.equal(await git(worktree, "check-ignore", ".mcp.json"), ".mcp.json");
    assert.equal(await git(worktree, "status", "--porcelain"), "");
  } else await absent(configPath(worktree));
});

test("a future worktree with a conflicting ignore rule does not receive an unignored MCP file", async (t) => {
  const root = await repository(t);
  const expectsHook = process.platform === "darwin" && (await discoverMcpbridge()).available;
  await installXcodeMcp(supported(root));
  await writeFile(path.join(root, ".gitignore"), "/.mcp.json.lock\n!/.mcp.json\n");
  await git(root, "add", ".gitignore");
  await git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "Conflicting ignore rule");
  const worktree = path.join(path.dirname(root), "conflicting-worktree");
  const checkout = git(root, "worktree", "add", "--quiet", "--detach", worktree, "HEAD");
  if (expectsHook) await assert.rejects(checkout, /not effectively ignored/);
  else await checkout;
  await assert.rejects(syncXcodeMcp(supported(worktree)), /not effectively ignored/);
  await absent(configPath(worktree));
  await absent(`${configPath(worktree)}.lock`);
});
