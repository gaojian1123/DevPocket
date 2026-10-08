import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function gitFixture(t: TestContext) {
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/worktrees-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const root = path.join(directory, "project"), worktree = path.join(directory, "task-worktree");
  const hooks = path.join(directory, "empty-hooks");
  await mkdir(hooks);
  async function git(cwd: string, ...args: string[]): Promise<string> {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
    return (await exec("git", [
      "--no-pager", "-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false",
      "-c", "user.name=DevPocket Test", "-c", "user.email=devpocket@example.invalid", "-C", cwd, ...args,
    ], { windowsHide: true, timeout: 15_000, env: { ...environment, GIT_TERMINAL_PROMPT: "0" } })).stdout;
  }
  await git(directory, "init", "--initial-branch=main", root);
  await writeFile(path.join(root, "note.txt"), "Main checkout");
  await git(root, "add", "note.txt");
  await git(root, "commit", "-m", "Disposable worktree fixture");
  await git(root, "worktree", "add", "-b", "feature/worktree-grouping", worktree);
  await writeFile(path.join(worktree, "note.txt"), "Linked checkout");
  return { directory, root, worktree, git };
}
