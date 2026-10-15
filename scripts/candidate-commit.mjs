import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdtemp, open, readFile, readlink, realpath, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { git, sourceSnapshot } from "./verification.mjs";

const exec = promisify(execFile);
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const sameSource = (a, b) => a?.head === b?.head && a?.fingerprint === b?.fingerprint;
const paths = (text) => text.split("\0").filter(Boolean);
const coauthor = "Copilot App <223556219+Copilot@users.noreply.github.com>";
const fail = (message) => { throw Object.assign(new Error(message), { candidateFailure: "candidate-changed" }); };
const hookNames = new Set(["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "post-index-change", "reference-transaction"]);

async function hookFailures(trace) {
  const { size } = await trace.stat();
  if (!size || size > 1024 * 1024) throw new Error("Missing or oversized Git hook trace.");
  const buffer = Buffer.alloc(size + 1);
  const { bytesRead } = await trace.read(buffer, 0, buffer.length, 0);
  if (bytesRead !== size || buffer[size - 1] !== 10) throw new Error("Incomplete Git hook trace.");
  const events = buffer.subarray(0, size).toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  const first = events[0];
  if (first.event !== "version" || typeof first.sid !== "string") throw new Error("Missing Git trace identity.");
  const own = events.filter((event) => event.sid === first.sid);
  if (!own.some((event) => event.event === "start") ||
      !own.some((event) => event.event === "exit" && event.code === 0) ||
      !own.some((event) => event.event === "atexit" && event.code === 0)) throw new Error("Missing Git completion evidence.");
  const hooks = new Map();
  for (const event of own) {
    if (event.event === "child_start" && event.child_class === "hook") {
      if (!Number.isSafeInteger(event.child_id) || !hookNames.has(event.hook_name) || hooks.has(event.child_id)) {
        throw new Error("Unrecognized Git hook evidence.");
      }
      hooks.set(event.child_id, { hook: event.hook_name });
    } else if (event.event === "child_exit" && hooks.has(event.child_id)) {
      const hook = hooks.get(event.child_id);
      if (!Number.isInteger(event.code) || hook.exitCode !== undefined) throw new Error("Invalid Git hook exit.");
      hook.exitCode = event.code;
    }
  }
  if ([...hooks.values()].some((hook) => hook.exitCode === undefined)) throw new Error("Missing Git hook exit.");
  return [...hooks.values()].filter((hook) => hook.exitCode !== 0);
}

async function gitMutation(root, args, input, environment = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "devpocket-candidate-"));
  const file = path.join(directory, "hooks.jsonl");
  let trace, output, failure;
  try {
    trace = await open(file, "wx+", 0o600);
    const command = exec("git", ["--no-pager", ...args], {
      cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
      env: { ...process.env, ...environment, GIT_TRACE2_EVENT: file },
    });
    command.child.stdin.end(input);
    output = await command;
    let failed;
    try { failed = await hookFailures(trace); }
    catch (cause) {
      throw Object.assign(new Error("Git completed but hook-exit evidence is unavailable; inspect before continuing.", { cause }),
        { candidateFailure: "hook-evidence", code: 0, stderr: output.stderr });
    }
    // Git ignores some hook exits (including post-commit); observe them without rerunning or replacing hooks.
    if (failed.length) throw Object.assign(new Error("A Git hook failed; retain the completed Git operation for inspection."),
      { candidateFailure: "hook-failed", code: 0, hookFailures: failed, stderr: output.stderr });
  } catch (error) { failure = error; }
  try {
    await trace?.close();
    await rm(file, { force: true });
    await rmdir(directory);
  } catch (cause) {
    failure ??= Object.assign(new Error("Git hook trace cleanup failed; inspect before continuing.", { cause }),
      { candidateFailure: "hook-evidence" });
    failure.traceCleanupFailed = true;
  }
  if (failure) throw failure;
  return output.stdout;
}

export function taskPaths(value) {
  if (!Array.isArray(value) || value.length > 2000 || value.some((file) =>
    typeof file !== "string" || !file.length || file.length > 1000 ||
    /[\\\x00-\x1f]|^[\/]|^[A-Za-z]:/.test(file) ||
    file.split("/").some((part) => ["", ".", "..", ".git"].includes(part.toLowerCase())) ||
    file.toLowerCase() === ".data" || file.toLowerCase().startsWith(".data/"))) throw new TypeError("Invalid task-owned paths.");
  if (new Set(value).size !== value.length) throw new TypeError("Duplicate task-owned paths.");
  return [...value].sort();
}

export async function changedPaths(root, base) {
  return [...new Set([
    ...paths(await git(root, ["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, "--"])),
    ...paths(await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])),
  ])].sort();
}

export async function inspectWorktree(root) {
  root = path.resolve(root);
  const [topPath, gitPath, commonPath] = await Promise.all([
    git(root, ["rev-parse", "--show-toplevel"]), git(root, ["rev-parse", "--git-dir"]),
    git(root, ["rev-parse", "--git-common-dir"]),
  ]);
  const [physicalRoot, top, gitDirectory, commonDirectory] = await Promise.all([
    realpath(root), realpath(topPath.trim()),
    realpath(path.resolve(root, gitPath.trim())), realpath(path.resolve(root, commonPath.trim())),
  ]);
  if (top !== physicalRoot || gitDirectory === commonDirectory) fail("Use the root of an isolated linked worktree, not the primary checkout.");
  const branch = (await git(root, ["symbolic-ref", "--quiet", "HEAD"])).trim();
  if (!branch.startsWith("refs/heads/")) fail("An attached task branch is required.");
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_START"]) {
    const file = path.join(gitDirectory, marker);
    try { await lstat(file); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    fail("An in-progress Git operation requires inspection before continuing.");
  }
  if (paths(await git(root, ["ls-files", "-v", "-z"])).some((entry) => !entry.startsWith("H "))) {
    fail("Unmerged, sparse or assume-unchanged index entries require inspection.");
  }
  const [source, index, configuration, status] = await Promise.all([
    sourceSnapshot(root), git(root, ["ls-files", "--stage", "-z"]),
    git(root, ["config", "--null", "--list", "--show-origin", "--show-scope"]),
    git(root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  return { identity: { root, gitDirectory, commonDirectory, branch }, source,
    index: sha256(index), configuration: sha256(configuration), status };
}

export function assertIdentity(current, expected) {
  if (JSON.stringify(current.identity) !== JSON.stringify(expected.identity)) fail("The task worktree or branch identity changed.");
  if (current.configuration !== expected.configuration) fail("Git configuration changed during the task; inspect it without restoring or overwriting it.");
}

export async function assertCandidate(root, workspace, candidate) {
  const current = await inspectWorktree(root);
  assertIdentity(current, workspace);
  if (current.status || current.index !== candidate.index || !sameSource(current.source, candidate.source) ||
      current.source.head !== candidate.commit ||
      (await git(root, ["rev-parse", "HEAD^{tree}"])).trim() !== candidate.tree) {
    fail("The candidate HEAD, source or index changed; a clean, exact committed candidate is required.");
  }
  return current;
}

// Unlike sourceSnapshot, this guard ignores deleted index entries and index modes
// that legitimately change during staging. Final evidence still uses sourceSnapshot.
async function contentFingerprint(root) {
  const files = [...new Set(paths(await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])))].sort();
  const entries = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    try {
      const info = await lstat(absolute);
      entries.push([file, info.isSymbolicLink() ? "link" : "file", info.mode & 0o111,
        sha256(info.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute))]);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return sha256(JSON.stringify(entries));
}

export async function prepareCandidate(root, before, source, ownedFiles, sessionId, goal) {
  const current = await inspectWorktree(root);
  assertIdentity(current, before);
  if (current.source.head !== before.source.head || current.index !== before.index) {
    fail("Implementation changed Git history or the index; inspect before continuing.");
  }
  if (!sameSource(current.source, source)) fail("Source changed after the implementer's inspection.");
  const files = taskPaths(ownedFiles);
  if (JSON.stringify(await changedPaths(root, before.source.head)) !== JSON.stringify(files)) {
    fail("Changed paths do not match the inspected task-owned changes; concurrent or unowned changes require inspection.");
  }
  if (!files.length) {
    if (current.status) fail("A no-op task must leave a clean index and worktree.");
    return { candidate: { created: false, commit: current.source.head, source: current.source,
      tree: (await git(root, ["rev-parse", "HEAD^{tree}"])).trim(), index: current.index } };
  }
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(sessionId)) {
    fail("The original session identity is required for the candidate commit trailer.");
  }
  const title = `DevPocket: ${goal.replace(/\s+/g, " ").trim()}`.slice(0, 100);
  return { request: {
    version: 1, root: path.resolve(root), expected: current, files, sessionId,
    content: await contentFingerprint(root),
    message: `${title}\n\nCo-authored-by: ${coauthor}\nCopilot-Session: ${sessionId}\n`,
  } };
}

async function requireCommitResult(root, request, candidate) {
  const current = await assertCandidate(root, request.expected, candidate);
  const ancestry = (await git(root, ["rev-list", "--parents", "-n", "1", candidate.commit])).trim().split(" ");
  if (!candidate.created || candidate.commit === request.expected.source.head ||
      JSON.stringify(ancestry) !== JSON.stringify([candidate.commit, request.expected.source.head]) ||
      candidate.parent !== request.expected.source.head) fail("Candidate history is not exactly one new local commit on the expected parent.");
  const changed = paths(await git(root, ["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only",
    "-z", request.expected.source.head, candidate.commit, "--"])).sort();
  if (JSON.stringify(changed) !== JSON.stringify(request.files) || await contentFingerprint(root) !== request.content) {
    fail("Candidate content differs from the inspected task-owned changes.");
  }
  for (const [key, value] of [["Co-authored-by", coauthor], ["Copilot-Session", request.sessionId]]) {
    if ((await git(root, ["show", "--no-show-signature", "-s", `--format=%(trailers:key=${key},valueonly)`, candidate.commit])).trim() !== value) {
      fail("A required candidate commit trailer is missing or changed.");
    }
  }
  return current;
}

export async function validateCandidateCommit(root, request, candidate) {
  await requireCommitResult(root, request, candidate);
  return candidate;
}

async function commitInspectedIndex(root, request, staged, tree) {
  const index = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "index"])).trim());
  const lockPath = `${index}.lock`;
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() }) + "\n";
  let lock, directory, failure;
  const check = async () => {
    const current = await inspectWorktree(root);
    assertIdentity(current, request.expected);
    if (current.source.head !== request.expected.source.head ||
        current.index !== staged.index || !sameSource(current.source, staged.source)) {
      fail("The inspected candidate or expected parent changed before committing.");
    }
  };
  try {
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if (error.code === "EEXIST") fail("The candidate commit index is locked; preserve the existing lock and inspect before continuing.");
      throw error;
    }
    await lock.writeFile(owner);
    await check();
    directory = await mkdtemp(path.join(tmpdir(), "devpocket-candidate-index-"));
    const isolated = path.join(directory, "index");
    await copyFile(index, isolated);
    const environment = { GIT_INDEX_FILE: isolated };
    if ((await gitMutation(root, ["write-tree"], undefined, environment)).trim() !== tree) {
      fail("The isolated candidate index does not match the inspected tree.");
    }
    await check();
    await gitMutation(root, ["commit", "--file=-"], request.message, environment);
  } catch (error) { failure = error; }
  for (const cleanup of [
    async () => { if (directory) await rm(directory, { recursive: true, force: true }); },
    async () => {
      if (!lock) return;
      await lock.close();
      if (await readFile(lockPath, "utf8") !== owner) throw new Error("Candidate index lock ownership changed.");
      await rm(lockPath);
    },
  ]) {
    try { await cleanup(); }
    catch (cause) {
      failure ??= Object.assign(new Error("Candidate index cleanup failed; inspect the retained lock and index.", { cause }),
        { candidateFailure: "index-cleanup" });
      failure.indexCleanupFailed = true;
    }
  }
  if (failure) throw failure;
}

export async function commitCandidate(request) {
  if (request?.version !== 1 || !request.expected || path.resolve(request.root) !== request.expected.identity?.root ||
      !/^[A-Za-z0-9-]{1,100}$/.test(request.sessionId ?? "") || !taskPaths(request.files).length) {
    fail("Invalid candidate commit request.");
  }
  const root = request.root;
  let current = await inspectWorktree(root);
  assertIdentity(current, request.expected);
  if (!sameSource(current.source, request.expected.source) || current.index !== request.expected.index ||
      current.status !== request.expected.status || await contentFingerprint(root) !== request.content ||
      JSON.stringify(await changedPaths(root, current.source.head)) !== JSON.stringify(request.files)) {
    fail("Concurrent source, history or index changes detected before staging; nothing was committed.");
  }
  try {
    for (const file of request.files) await gitMutation(root, ["--literal-pathspecs", "add", "--all", "--", file]);
  } catch (error) { throw Object.assign(error, { candidateFailure: error.candidateFailure ?? "staging-failed" }); }
  current = await inspectWorktree(root);
  assertIdentity(current, request.expected);
  if (current.source.head !== request.expected.source.head || await contentFingerprint(root) !== request.content ||
      (await git(root, ["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--"])) ||
      (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])) ||
      JSON.stringify(paths(await git(root, ["--no-optional-locks", "diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames",
        "--name-only", "-z", request.expected.source.head, "--"])).sort()) !== JSON.stringify(request.files)) {
    fail("Concurrent changes detected during staging; inspect the retained index without resetting it.");
  }
  const tree = (await gitMutation(root, ["write-tree"])).trim();
  const staged = await inspectWorktree(root);
  assertIdentity(staged, current);
  if (staged.index !== current.index || !sameSource(staged.source, current.source)) fail("Source or index changed before commit.");
  try { await commitInspectedIndex(root, request, staged, tree); }
  catch (error) { throw Object.assign(error, { candidateFailure: error.candidateFailure ?? "commit-failed" }); }
  const after = await inspectWorktree(root);
  const candidate = { created: true, parent: request.expected.source.head, commit: after.source.head,
    source: after.source, tree, index: current.index };
  if (after.source.fingerprint !== current.source.fingerprint) fail("Source changed during the commit or its hooks.");
  await requireCommitResult(root, request, candidate);
  return candidate;
}

async function main() {
  const [flag, file, hashFlag, hash, ...extra] = process.argv.slice(2);
  if (flag !== "--request" || hashFlag !== "--sha256" || !/^[a-f0-9]{64}$/.test(hash ?? "") || extra.length) {
    fail("Use --request FILE --sha256 REQUEST_HASH through the original session's native tool pipeline.");
  }
  const input = await readFile(file);
  if (input.length > 1024 * 1024 || sha256(input) !== hash) fail("The candidate request changed before execution.");
  const receipt = await open(`${file}.result.json`, "wx", 0o600);
  try {
    const candidate = await commitCandidate(JSON.parse(input));
    await receipt.writeFile(JSON.stringify({ status: "committed", candidate }) + "\n");
  } catch (error) {
    await receipt.writeFile(JSON.stringify({ status: "blocked",
      failure: ["candidate-changed", "staging-failed", "commit-failed", "hook-failed", "hook-evidence", "index-cleanup"].includes(error.candidateFailure)
        ? error.candidateFailure : "inspection-failed",
      ...(Number.isInteger(error.code) ? { exitCode: error.code } : {}),
      ...(error.hookFailures ? { hookFailures: error.hookFailures } : {}),
      ...(error.traceCleanupFailed ? { traceCleanup: "failed" } : {}),
      ...(error.indexCleanupFailed ? { indexCleanup: "failed" } : {}) }) + "\n");
    throw error;
  } finally { await receipt.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    if (error.stderr) console.error(error.stderr);
    if (error.traceCleanupFailed) console.error("Git hook trace cleanup also failed.");
    if (error.indexCleanupFailed) console.error("Candidate index cleanup also failed.");
    process.exitCode = 1;
  });
}
