import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const splitPaths = (value) => value.split("\0").filter(Boolean);

export async function git(root, args) {
  const result = await exec("git", ["--no-pager", ...args], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
  });
  return result.stdout;
}

export const readOnlyGitArgs = (args) => ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args];

export async function readOnlyGit(root, args) {
  return git(root, readOnlyGitArgs(args));
}

export async function sourceSnapshot(root) {
  const head = (await git(root, ["rev-parse", "--verify", "HEAD"])).trim();
  const modes = new Map();
  for (const entry of splitPaths(await readOnlyGit(root, ["ls-files", "--stage", "-z"]))) {
    const tab = entry.indexOf("\t");
    const [mode, , stage] = entry.slice(0, tab).split(" ");
    if (stage !== "0") throw new Error("Resolve the unmerged index before collecting source evidence.");
    modes.set(entry.slice(tab + 1), mode);
  }
  const files = [...new Set(splitPaths(await readOnlyGit(root,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])))].sort();
  const entries = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    try {
      const info = await lstat(absolute);
      entries.push([file, modes.get(file) ?? (info.isSymbolicLink() ? "120000" : "100644"),
        info.isSymbolicLink() ? "link" : "file",
        digest(info.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute))]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      entries.push([file, "deleted"]);
    }
  }
  return { head, fingerprint: digest(JSON.stringify(entries)) };
}
