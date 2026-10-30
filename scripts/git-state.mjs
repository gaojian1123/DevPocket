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

function githubRepositoryUrl(url) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  if (!match || match[1].split("/").some((part) => [".", ".."].includes(part))) {
    throw new Error("The effective Git URL is not a GitHub.com repository URL.");
  }
  return match[1];
}

export async function originRepository(root) {
  return githubRepositoryUrl((await readOnlyGit(root, ["remote", "get-url", "origin"])).trim());
}

export async function requirePushTarget(root, repository) {
  const urls = (await readOnlyGit(root, ["remote", "get-url", "--push", "--all", "origin"])).trim().split(/\r?\n/);
  if (urls.length !== 1 || githubRepositoryUrl(urls[0]) !== repository) {
    throw new Error("Every effective push destination must be the single authorized GitHub repository.");
  }
  return urls[0];
}

export async function sourceSnapshot(root) {
  const head = (await git(root, ["rev-parse", "--verify", "HEAD"])).trim();
  return { head, fingerprint: digest(JSON.stringify(await sourceInputs(root))) };
}

export async function sourceInputs(root) {
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
        digest(info.isSymbolicLink() ? await readlink(absolute, { encoding: "buffer" }) : await readFile(absolute))]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      entries.push([file, "deleted"]);
    }
  }
  return entries;
}

export async function committedInputEntries(root, commit) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("An exact commit is required.");
  return splitPaths(await readOnlyGit(root, ["ls-tree", "-r", "-z", "--full-tree", commit])).map((entry) => {
    const tab = entry.indexOf("\t"), [mode, type, oid] = entry.slice(0, tab).split(" ");
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) throw new Error("Unsupported committed input.");
    return { file: entry.slice(tab + 1), mode, oid };
  }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}
