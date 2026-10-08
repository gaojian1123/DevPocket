import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProjectFiles } from "../src/files.js";
import { gitFixture } from "./git-fixture.js";

const allow = async (paths: string[]) => ({
  available: true, checks: paths.map((file) => ({ path: file, excluded: false })),
});

test("file previews stay under the registered project and fail closed on excluded paths or unavailable policy", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const dir = await mkdtemp(path.resolve(".data/tests/files-"));
  const root = path.join(dir, "project"), outside = path.join(dir, "outside");
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(root, "hello.txt"), "Native preview");
  await writeFile(path.join(root, "excluded.txt"), "PRIVATE");
  await writeFile(path.join(root, ".env"), "SECRET=never");
  await writeFile(path.join(outside, "outside.txt"), "OUTSIDE");
  await symlink(outside, path.join(root, "escape"), "junction");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  let available = true;
  const files = new ProjectFiles(root, async (paths) => ({
    available, checks: paths.map((file) => ({ path: file, excluded: file.endsWith("excluded.txt") })),
  }));
  const preview = await files.read("hello.txt");
  assert.equal(preview.file.content, "Native preview");
  const names = (await files.list("")).entries.map((entry) => entry.name);
  assert.ok(names.includes("hello.txt"));
  assert.ok(!names.includes("excluded.txt"));
  assert.ok(!names.includes(".env"));
  await assert.rejects(files.read("..\\outside\\outside.txt"), { code: "INVALID_PATH" });
  await assert.rejects(files.read("C:\\Windows\\win.ini"), { code: "INVALID_PATH" });
  await assert.rejects(files.read("escape\\outside.txt"), { code: "SYMLINK_DENIED" });
  await assert.rejects(files.read("hello.txt:secret"), { code: "INVALID_PATH" });
  await assert.rejects(files.read(".env"), { code: "SENSITIVE_PATH" });
  await assert.rejects(files.read("excluded.txt"), { code: "CONTENT_EXCLUDED" });
  available = false;
  await assert.rejects(files.read("hello.txt"), { code: "POLICY_UNAVAILABLE" });
  await assert.rejects(files.list(""), { code: "POLICY_UNAVAILABLE" });
  await assert.rejects(files.project(), { code: "POLICY_UNAVAILABLE" });
});

test("project grouping uses the canonical shared Git directory, not names or remotes", async (t) => {
  const f = await gitFixture(t);
  const main = await new ProjectFiles(f.root, allow).project();
  const linked = await new ProjectFiles(f.worktree, allow).project();
  assert.ok(main && linked);
  assert.equal(main.projectId, linked.projectId);
  assert.equal(linked.projectName, "project");
  assert.deepEqual(linked.workspace, { name: "task-worktree", branch: "feature/worktree-grouping" });
  assert.ok(!JSON.stringify(linked).includes(f.directory));

  const nested = path.join(f.worktree, "src"), alias = path.join(f.directory, "alias");
  await mkdir(nested);
  await writeFile(path.join(nested, "scoped.txt"), "Only this folder");
  await symlink(f.worktree, alias, "junction");
  assert.deepEqual(await new ProjectFiles(alias, allow).project(), linked);
  const subdirectory = new ProjectFiles(nested, allow);
  assert.deepEqual(await subdirectory.project(), linked);
  assert.deepEqual((await subdirectory.list("")).entries.map((file) => file.name), ["scoped.txt"]);
  await assert.rejects(subdirectory.read("../note.txt"), { code: "INVALID_PATH" });

  const clone = path.join(f.directory, "another", "project");
  await mkdir(path.dirname(clone));
  await f.git(f.directory, "clone", "--quiet", f.root, clone);
  await f.git(f.root, "remote", "add", "origin", "https://example.invalid/shared/project.git");
  await f.git(clone, "remote", "set-url", "origin", "https://example.invalid/shared/project.git");
  const independent = await new ProjectFiles(clone, allow).project();
  assert.equal(independent?.projectName, main.projectName);
  assert.notEqual(independent?.projectId, main.projectId);

  const movingAlias = new ProjectFiles(alias, async (paths) => {
    await unlink(alias);
    await symlink(clone, alias, "junction");
    return allow(paths);
  });
  assert.deepEqual(await movingAlias.project(), linked, "Git metadata stays anchored to the path allowed by policy.");
});

test("workspace metadata supports detached HEAD, unborn branches and separate Git directories", async (t) => {
  const f = await gitFixture(t);
  const files = new ProjectFiles(f.worktree, allow), before = await files.project();
  await f.git(f.worktree, "checkout", "--detach");
  const detached = await files.project();
  assert.equal(detached?.projectId, before?.projectId);
  assert.deepEqual(detached?.workspace, { name: "task-worktree", branch: "" });

  const unborn = path.join(f.directory, "new-project");
  await f.git(f.directory, "init", "--initial-branch=unborn", unborn);
  assert.deepEqual((await new ProjectFiles(unborn, allow).project())?.workspace, { name: "new-project", branch: "unborn" });

  const separate = path.join(f.directory, "separate"), metadata = path.join(f.directory, "git-metadata");
  await f.git(f.directory, "init", "--initial-branch=main", `--separate-git-dir=${metadata}`, separate);
  await f.git(separate, "commit", "--allow-empty", "-m", "Separate Git directory");
  const another = path.join(f.directory, "separate-task");
  await f.git(separate, "worktree", "add", "-b", "separate-task", another);
  const first = await new ProjectFiles(separate, allow).project(), second = await new ProjectFiles(another, allow).project();
  assert.ok(first && second);
  assert.equal(first.projectId, second.projectId);
  assert.equal(first.projectName, second.projectName);
});

test("project metadata ignores inherited Git overrides and redacts branch names", async (t) => {
  const f = await gitFixture(t);
  const files = new ProjectFiles(f.worktree, allow), before = await files.project();
  const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  try {
    process.env.GIT_DIR = path.join(f.root, ".git");
    process.env.GIT_WORK_TREE = f.root;
    assert.deepEqual(await files.project(), before);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  await f.git(f.worktree, "branch", "-m", "feature/ghp_disposable_example_not_a_credential");
  const redacted = await files.project();
  assert.equal(redacted?.workspace?.branch, "feature/[REDACTED]");
});

test("ordinary folders remain folder projects and denied policy prevents Git metadata discovery", async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "devpocket-folder-"));
  t.after(async () => { await rm(folder, { recursive: true, force: true }); });
  assert.equal(await new ProjectFiles(folder, allow).project(), null);
  const f = await gitFixture(t);
  const denied = new ProjectFiles(f.worktree, async (paths) => ({
    available: true, checks: paths.map((file) => ({ path: file, excluded: true })),
  }));
  await assert.rejects(denied.project(), { code: "CONTENT_EXCLUDED" });
  const incomplete = new ProjectFiles(f.worktree, async () => ({ available: true, checks: [] }));
  await assert.rejects(incomplete.project(), { code: "POLICY_UNAVAILABLE" });
});

test("cancelling project discovery does not wait for or trust a late policy response", async (t) => {
  const f = await gitFixture(t);
  let started = () => {}, release = () => {};
  const checking = new Promise<void>((resolve) => { started = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const files = new ProjectFiles(f.worktree, async (paths) => { started(); await pending; return allow(paths); });
  const cancellation = new AbortController();
  const discovery = files.project(cancellation.signal);
  await checking;
  cancellation.abort();
  await assert.rejects(discovery, { name: "AbortError" });
  release();
});
