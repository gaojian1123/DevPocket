import { execFile } from "node:child_process";
import { isUtf8 } from "node:buffer";
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
        digest(info.isSymbolicLink() ? await readlink(absolute, { encoding: "buffer" }) : await readFile(absolute))]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      entries.push([file, "deleted"]);
    }
  }
  return entries;
}

export async function commitSourceProjection(root, inputs) {
  const live = inputs.filter((entry) => entry[1] !== "deleted");
  if (live.some(([file]) => typeof file !== "string" || path.isAbsolute(file) ||
      file.split(/[\\/]/).some((part) => !part || part === "." || part === ".."))) {
    throw new Error("Invalid source projection path.");
  }
  let autocrlf;
  try { autocrlf = (await readOnlyGit(root, ["config", "--get", "core.autocrlf"])).trim().toLowerCase(); }
  catch (error) { if (error.code !== 1) throw error; autocrlf = "false"; }
  if (!["false", "true", "input"].includes(autocrlf)) {
    return { version: 1, status: "unsupported", reason: "git-text-configuration" };
  }
  const reading = exec("git", ["--no-pager", ...readOnlyGitArgs(["check-attr", "--all", "-z", "--stdin"])],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  reading.child.stdin.end(live.map(([file]) => file).join("\0") + (live.length ? "\0" : ""));
  const output = (await reading).stdout, attributes = [];
  if (output && !output.endsWith("\0")) throw new Error("Incomplete Git attribute evidence.");
  const fields = output ? output.split("\0").slice(0, -1) : [];
  if (fields.length % 3) throw new Error("Incomplete Git attribute evidence.");
  const byFile = new Map(live.map(([file]) => [file, new Map()]));
  for (let offset = 0; offset < fields.length; offset += 3) {
    const [file, name, value] = fields.slice(offset, offset + 3), entry = byFile.get(file);
    if (!entry || entry.has(name)) throw new Error("Invalid Git attribute evidence.");
    entry.set(name, value);
    attributes.push([file, name, value]);
  }
  const normalized = [];
  for (const [file, mode, kind, hash] of live) {
    const attrs = byFile.get(file);
    // Inspect attributes only; proof collection must never invoke a clean filter.
    if (["filter", "working-tree-encoding", "ident", "crlf"].some((name) => attrs.has(name)) ||
        ![undefined, "set", "unset", "auto"].includes(attrs.get("text")) ||
        ![undefined, "unset", "lf", "crlf"].includes(attrs.get("eol"))) {
      return { version: 1, status: "unsupported", reason: "git-text-attributes" };
    }
    if (kind !== "file" || !["100644", "100755"].includes(mode)) continue;
    const bytes = await readFile(path.join(root, file));
    if (digest(bytes) !== hash) throw new Error("Source changed while collecting commit projection.");
    const text = attrs.get("text"), eol = attrs.get("eol");
    const explicit = text === "set" || text === undefined && ["lf", "crlf"].includes(eol);
    const automatic = text === "auto" || text === undefined && autocrlf !== "false";
    if (text === "unset" || (!explicit && !automatic) || !bytes.includes(13)) continue;
    if (!explicit && (!isUtf8(bytes) ||
        bytes.some((byte, index) => byte < 32 && ![9, 10, 12, 13].includes(byte) ||
          byte === 13 && bytes[index + 1] !== 10))) continue;
    const output = Buffer.allocUnsafe(bytes.length);
    let length = 0;
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== 13 || bytes[index + 1] !== 10) output[length++] = bytes[index];
    }
    const normalizedHash = digest(output.subarray(0, length));
    if (normalizedHash !== hash) normalized.push([file, hash, normalizedHash]);
  }
  attributes.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  return { version: 1, status: "bound", policy: digest(JSON.stringify({ autocrlf, attributes })), normalized };
}

export function committedInputsMatch(inputs, committed, projection) {
  const live = inputs.filter((entry) => entry[1] !== "deleted");
  if (projection?.version !== 1 || projection.status !== "bound" || !Array.isArray(projection.normalized) ||
      live.length !== committed.length) return false;
  const normalized = new Map(projection.normalized.map(([file, raw, converted]) => [file, { raw, converted }]));
  if (normalized.size !== projection.normalized.length) return false;
  return live.every(([file, mode, kind, hash], index) => {
    const actual = committed[index], alternative = normalized.get(file);
    return actual?.length === 4 && actual[0] === file && actual[1] === mode && actual[2] === kind &&
      (actual[3] === hash || alternative?.raw === hash && actual[3] === alternative.converted);
  });
}

export async function committedInputEntries(root, commit) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("An exact commit is required.");
  return splitPaths(await readOnlyGit(root, ["ls-tree", "-r", "-z", "--full-tree", commit])).map((entry) => {
    const tab = entry.indexOf("\t"), [mode, type, oid] = entry.slice(0, tab).split(" ");
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) throw new Error("Unsupported committed input.");
    return { file: entry.slice(tab + 1), mode, oid };
  }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}

export async function committedSourceInputs(root, commit) {
  const entries = await committedInputEntries(root, commit);
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
