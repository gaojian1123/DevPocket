import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { ProjectFiles } from "../src/files.js";

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
});
