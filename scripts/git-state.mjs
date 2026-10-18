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
        digest(info.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute))]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      entries.push([file, "deleted"]);
    }
  }
  return entries;
}

export async function committedSourceInputs(root, commit) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("An exact commit is required.");
  const entries = splitPaths(await readOnlyGit(root, ["ls-tree", "-r", "-z", "--full-tree", commit])).map((entry) => {
    const tab = entry.indexOf("\t"), [mode, type, oid] = entry.slice(0, tab).split(" ");
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) throw new Error("Unsupported committed input.");
    return { file: entry.slice(tab + 1), mode, oid };
  }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const reading = exec("git", ["--no-pager", ...readOnlyGitArgs(["cat-file", "--batch"])],
    { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  reading.child.stdin.end(entries.map((entry) => entry.oid).join("\n") + (entries.length ? "\n" : ""));
  const { stdout } = await reading;
  let offset = 0;
  const inputs = entries.map(({ file, mode, oid }) => {
    const end = stdout.indexOf(10, offset);
    if (end < offset) throw new Error("Incomplete committed input evidence.");
    const [actual, type, length] = stdout.subarray(offset, end).toString("ascii").split(" ");
    const size = Number(length);
    offset = end + 1;
    if (actual !== oid || type !== "blob" || !Number.isSafeInteger(size) || size < 0 ||
        offset + size >= stdout.length || stdout[offset + size] !== 10) throw new Error("Invalid committed input evidence.");
    const hash = digest(stdout.subarray(offset, offset + size));
    offset += size + 1;
    return [file, mode, mode === "120000" ? "link" : "file", hash];
  });
  if (offset !== stdout.length) throw new Error("Unexpected committed input evidence.");
  return inputs;
}
