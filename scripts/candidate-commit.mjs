import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdtemp, open, readFile, readlink, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { git, readOnlyGit, readOnlyGitArgs, sourceSnapshot } from "./git-state.mjs";

const exec = promisify(execFile);
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const sameSource = (a, b) => a?.head === b?.head && a?.fingerprint === b?.fingerprint;
const paths = (text) => text.split("\0").filter(Boolean);
const coauthor = "Copilot App <223556219+Copilot@users.noreply.github.com>";
const fail = (message) => { throw Object.assign(new Error(message), { candidateFailure: "candidate-changed" }); };
const routedHookNames = new Set(["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "post-index-change", "reference-transaction"]);
const observedHookNames = new Set([...routedHookNames,
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-merge-commit", "pre-rebase",
  "post-checkout", "post-merge", "pre-push", "pre-receive", "update", "proc-receive",
  "post-receive", "post-update", "push-to-checkout", "pre-auto-gc", "post-rewrite",
  "sendemail-validate", "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist",
  "p4-post-changelist", "p4-pre-submit"]);

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
  for (const event of events) {
    const key = JSON.stringify([event.sid, event.child_id]);
    if (event.event === "child_start" && event.child_class === "hook") {
      if (typeof event.sid !== "string" || !event.sid.length ||
          !Number.isSafeInteger(event.child_id) || event.child_id < 0 ||
          !observedHookNames.has(event.hook_name) || hooks.has(key)) {
        throw new Error("Unrecognized Git hook evidence.");
      }
      hooks.set(key, { hook: event.hook_name });
    } else if (event.event === "child_exit" && hooks.has(key)) {
      const hook = hooks.get(key);
      if (!Number.isInteger(event.code) || hook.exitCode !== undefined) throw new Error("Invalid Git hook exit.");
      hook.exitCode = event.code;
    }
  }
  if ([...hooks.values()].some((hook) => hook.exitCode === undefined)) throw new Error("Missing Git hook exit.");
  const failures = [...hooks.values()].filter((hook) => hook.exitCode !== 0);
  return [...new Map(failures.map((hook) => [JSON.stringify([hook.hook, hook.exitCode]), hook])).values()];
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
    // Git ignores some hook exits (including post-commit); observe them without replaying hook code.
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
    ...paths(await readOnlyGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, "--"])),
    ...paths(await readOnlyGit(root, ["ls-files", "--others", "--exclude-standard", "-z"])),
  ])].sort();
}

export async function activeHookSnapshot(root) {
  const { execFile } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { lstat, readFile, readdir, readlink, realpath } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  const git = async (cwd, args) => (await execute("git", ["--no-pager", ...args],
    { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })).stdout;
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const fail = (message) => { throw Object.assign(new Error(message), { candidateFailure: "candidate-changed" }); };
  const directory = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "hooks"])).trim());
  const entries = [], visited = new Set();
  let totalBytes = 0;
  const visit = async (file, relative, depth) => {
    if (depth > 8 || entries.length >= 256) fail("Active Git hook inputs exceed the inspection bounds.");
    let info;
    try { info = await lstat(file); }
    catch (error) {
      if (error.code !== "ENOENT" || relative !== ".") throw error;
      entries.push([relative, "missing"]);
      return;
    }
    if (info.isSymbolicLink()) {
      entries.push([relative, "link", await readlink(file)]);
      await visit(await realpath(file), `${relative}/target`, depth + 1);
    } else if (info.isDirectory()) {
      const resolved = await realpath(file);
      if (visited.has(resolved)) fail("Active Git hook directories contain a cycle.");
      visited.add(resolved);
      entries.push([relative, "directory", resolved]);
      for (const name of (await readdir(file)).sort()) await visit(path.join(file, name), `${relative}/${name}`, depth + 1);
      visited.delete(resolved);
    } else if (info.isFile()) {
      totalBytes += info.size;
      if (info.size > 1024 * 1024 || totalBytes > 4 * 1024 * 1024) fail("Active Git hook inputs exceed the inspection bounds.");
      const bytes = await readFile(file);
      if (bytes.length !== info.size) fail("Active Git hook inputs changed during inspection.");
      entries.push([relative, "file", info.mode & 0o111, sha256(bytes)]);
    } else {
      fail("Active Git hook inputs have an unsupported file type.");
    }
    const after = await lstat(file);
    if (after.dev !== info.dev || after.ino !== info.ino || after.mode !== info.mode ||
        after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      fail("Active Git hook inputs changed during inspection.");
    }
  };
  await visit(directory, ".", 0);
  return { directory, fingerprint: sha256(JSON.stringify(entries)) };
}

export const sameHooks = (a, b) => a?.directory === b?.directory && a?.fingerprint === b?.fingerprint;

async function requireHooks(root, expected) {
  if (!expected || !sameHooks(await activeHookSnapshot(root), expected)) {
    fail("Active Git hook policy changed; obtain approval before executing it.");
  }
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
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "AUTO_MERGE", "rebase-merge", "rebase-apply", "BISECT_START"]) {
    const file = path.join(gitDirectory, marker);
    try { await lstat(file); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    fail("An in-progress Git operation requires inspection before continuing.");
  }
  if (paths(await readOnlyGit(root, ["ls-files", "-v", "-z"])).some((entry) => !entry.startsWith("H "))) {
    fail("Unmerged, sparse or assume-unchanged index entries require inspection.");
  }
  const [source, index, configuration, status] = await Promise.all([
    sourceSnapshot(root), readOnlyGit(root, ["ls-files", "--stage", "-z"]),
    git(root, ["config", "--null", "--list", "--show-origin", "--show-scope"]),
    readOnlyGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
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
  if (candidate.created && (candidate.reference?.version !== 2 ||
      candidate.reference.branch !== workspace.identity.branch ||
      candidate.reference.parent !== candidate.parent || candidate.reference.commit !== candidate.commit ||
      candidate.reference.tree !== candidate.tree)) {
    fail("Candidate reference-transaction evidence is missing or inconsistent.");
  }
  return current;
}

// Unlike sourceSnapshot, this guard ignores deleted index entries and index modes
// that legitimately change during staging. Final evidence still uses sourceSnapshot.
async function contentFingerprint(root) {
  const files = [...new Set(paths(await readOnlyGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])))].sort();
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

export async function prepareCandidate(root, before, source, ownedFiles, sessionId, goal, expectedHooks, execution) {
  const current = await inspectWorktree(root);
  assertIdentity(current, before);
  if (current.source.head !== before.source.head || current.index !== before.index) {
    fail("Implementation changed Git history or the index; inspect before continuing.");
  }
  if (!sameSource(current.source, source)) fail("Source changed after the implementer's inspection.");
  const hooks = await activeHookSnapshot(root);
  if (expectedHooks && !sameHooks(hooks, expectedHooks)) fail("Active Git hook policy changed before candidate preparation.");
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
  if (!execution || execution.version !== 2) fail("A current captured native implementation is required for candidate execution.");
  const title = `DevPocket: ${goal.replace(/\s+/g, " ").trim()}`.slice(0, 100);
  return { request: {
    version: 4, root: path.resolve(root), expected: current, files, sessionId, hooks: { ...hooks },
    execution: structuredClone(execution),
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
  const changed = paths(await readOnlyGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only",
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

async function verificationReceiptKey(root) {
  let current = await realpath(path.resolve(root));
  for (const name of [".data", "verification", "local", "receipt.key"]) {
    current = path.join(current, name);
    const info = await lstat(current);
    const physical = await realpath(current);
    if (info.isSymbolicLink() ||
        (process.platform === "win32" ? physical.toLowerCase() !== current.toLowerCase() : physical !== current) ||
        (name === "receipt.key" ? !info.isFile() || info.nlink !== 1 || info.size !== 32 : !info.isDirectory())) {
      fail("Verification receipt ownership cannot be established.");
    }
  }
  const key = await readFile(current);
  if (key.length !== 32) fail("Verification receipt key is incomplete.");
  return key;
}

function candidateReceiptProof(key, requestHash, candidate) {
  return { version: 1, request: requestHash,
    signature: createHmac("sha256", key).update(`candidate-receipt-v1\n${requestHash}\n${JSON.stringify(candidate)}`).digest("hex") };
}

export async function validateCandidateReceiptProof(root, requestHash, receipt) {
  const proof = receipt?.verificationProof;
  if (receipt?.status !== "committed" || proof?.version !== 1 || proof.request !== requestHash ||
      !/^[a-f0-9]{64}$/.test(proof.signature ?? "")) fail("A locally bound completed native commit receipt is required.");
  const expected = candidateReceiptProof(await verificationReceiptKey(root), requestHash, receipt.candidate);
  if (!timingSafeEqual(Buffer.from(expected.signature, "hex"), Buffer.from(proof.signature, "hex"))) {
    fail("Native commit receipt binding is invalid.");
  }
}

async function referenceGuard(specification, observeHooks) {
  const { createHash, randomUUID } = await import("node:crypto");
  const { execFileSync } = await import("node:child_process");
  const { readSync } = await import("node:fs");
  const { readFile, realpath, writeFile } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  let context;
  try {
    const encoded = process.env[specification.context];
    if (typeof encoded !== "string" || encoded.length > 32768) throw new Error("Reference context is unavailable.");
    const bytes = Buffer.from(encoded, "base64");
    if (hash(bytes) !== specification.hash) throw new Error("Reference context changed.");
    context = JSON.parse(bytes);
    if ((process.env.GIT_CONFIG_PARAMETERS !== undefined) !== context.parametersPresent ||
        hash(process.env.GIT_CONFIG_PARAMETERS ?? "") !== context.parametersHash) throw new Error("Original Git command configuration was not preserved.");
    const environment = { ...process.env };
    delete environment[specification.context];
    const query = (args, input) => execFileSync("git", ["--no-pager", "--no-replace-objects", ...args],
      { cwd: context.root, env: environment, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    const autoMergeAbsent = () => {
      try { query(["show-ref", "--exists", "AUTO_MERGE"]); return false; }
      catch (error) {
        if (error.status === 2 && !error.signal) return true;
        throw new Error("Native ref-state inspection is unavailable.", { cause: error });
      }
    };
    const chunks = [], buffer = Buffer.alloc(4096);
    let size = 0;
    for (let count; (count = readSync(0, buffer, 0, buffer.length, null)) > 0;) {
      size += count;
      if (size > 1024 * 1024) throw new Error("Hook input exceeds the supported bound.");
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const input = Buffer.concat(chunks), args = process.argv.slice(1);
    let approved;
    try { approved = JSON.parse(await readFile(path.join(context.directory, "prepared.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (approved && (approved.context !== specification.hash || approved.parent !== context.parent ||
        approved.branch !== context.branch || approved.tree !== context.tree ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(approved.commit))) {
      throw new Error("Prepared reference evidence changed.");
    }
    const identity = async () => {
      const locations = query(["rev-parse", "--absolute-git-dir", "--git-common-dir", "--show-toplevel"]).trimEnd().split(/\r?\n/);
      if (locations.length !== 3 ||
          await realpath(locations[0]) !== context.gitDirectory ||
          await realpath(path.resolve(context.root, locations[1])) !== context.commonDirectory ||
          await realpath(locations[2]) !== context.physicalRoot ||
          query(["symbolic-ref", "--quiet", "HEAD"]).trim() !== context.branch) {
        throw new Error("Expected worktree or attached branch changed.");
      }
      const head = query(["rev-parse", "--verify", "HEAD"]).trim();
      if (head !== context.parent && head !== approved?.commit) throw new Error("Expected parent changed.");
      if (hash(query(["config", "--null", "--list", "--show-origin", "--show-scope"])) !== context.configuration) {
        throw new Error("Git configuration changed before hook execution.");
      }
      const hooks = await observeHooks(context.root);
      if (hooks.directory !== context.hooks.directory || hooks.fingerprint !== context.hooks.fingerprint) {
        throw new Error("Approved hook inputs changed.");
      }
    };
    if (specification.hook === "reference-transaction") {
      if (args.length !== 1 || !["preparing", "prepared", "committed", "aborted"].includes(args[0]) ||
          !input.length || input.at(-1) !== 10) throw new Error("Unrecognized reference transaction shape.");
      const preparing = args[0] === "preparing";
      const text = input.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(input)) throw new Error("Unsupported reference encoding.");
      const rows = text.trimEnd().split("\n").map((line) => {
        const match = /^([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([^\s]+)$/.exec(line);
        if (!match) throw new Error("Unsupported reference update.");
        return { old: match[1], next: match[2], name: match[3] };
      });
      const zero = "0".repeat(context.parent.length);
      const probe = rows.length === 1 && rows[0].name === context.branch &&
        rows[0].old === context.parent && rows[0].next === zero;
      if (probe) {
        if (args[0] === "prepared") {
          await identity();
          if (!autoMergeAbsent()) throw new Error("Unexpected AUTO_MERGE requires inspection.");
          await writeFile(path.join(context.directory, "probe.json"), JSON.stringify({ context: specification.hash, veto: true, absenceLookup: true }),
            { flag: "wx", mode: 0o600 });
          process.exitCode = 19;
        } else process.exitCode = 77;
        return;
      }
      const cleanup = rows.length === 1 && rows[0].name === "AUTO_MERGE" && rows[0].old === zero && rows[0].next === zero;
      if (cleanup) {
        if (args[0] === "prepared") {
          await identity();
          if (!autoMergeAbsent()) throw new Error("Refusing to delete an unexpectedly present AUTO_MERGE.");
          await writeFile(path.join(context.directory, "cleanup-prepared.json"),
            JSON.stringify({ context: specification.hash, absent: true }), { flag: "wx", mode: 0o600 });
        } else if (args[0] === "committed") {
          const cleanupProof = JSON.parse(await readFile(path.join(context.directory, "cleanup-prepared.json"), "utf8"));
          if (cleanupProof.context !== specification.hash || cleanupProof.absent !== true) {
            throw new Error("Cleanup completion lacks its locked absence proof.");
          }
        }
      } else {
        const branch = rows.filter((row) => row.name === context.branch ||
          (preparing && rows.length === 1 && row.name === "HEAD"));
        if (branch.length !== 1 || rows.length > 2 || branch[0].old !== context.parent ||
            branch[0].next.length !== context.parent.length || [zero, context.parent].includes(branch[0].next) ||
            rows.some((row) => ![context.branch, "HEAD"].includes(row.name) ||
              row.old !== context.parent || row.next !== branch[0].next)) throw new Error("Reference update is not bound to the expected branch and parent.");
        if (args[0] === "prepared") {
          await identity();
          if (typeof context.tree !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(context.tree)) {
            throw new Error("A ref update requires its inspected tree binding.");
          }
          const object = query(["cat-file", "--batch"], `${branch[0].next}\n`);
          const newline = object.indexOf("\n"), header = object.slice(0, newline).split(" ");
          if (header.length !== 3 || header[0] !== branch[0].next || header[1] !== "commit") throw new Error("Expected a native commit object.");
          const headers = object.slice(newline + 1).split("\n\n", 1)[0].split("\n");
          const parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
          const trees = headers.filter((line) => line.startsWith("tree ")).map((line) => line.slice(5));
          if (JSON.stringify(parents) !== JSON.stringify([context.parent])) throw new Error("Native commit has a different parent.");
          if (JSON.stringify(trees) !== JSON.stringify([context.tree])) throw new Error("Native commit differs from the inspected tree.");
          await writeFile(path.join(context.directory, "prepared.json"),
            JSON.stringify({ context: specification.hash, branch: context.branch, parent: context.parent,
              commit: branch[0].next, tree: context.tree }),
            { flag: "wx", mode: 0o600 });
        } else if (!preparing && (!approved || approved.commit !== branch[0].next)) {
          throw new Error("Reference completion lacks its prepared binding.");
        }
      }
      if (specification.original) await identity();
    } else await identity();
    if (!specification.original) { process.exitCode = 77; return; }
    const file = path.join(context.directory, `input-${randomUUID()}`);
    await writeFile(file, input, { flag: "wx", mode: 0o600 });
    process.stdout.write(file);
  } catch (error) {
    if (context) {
      try { await writeFile(path.join(context.directory, "rejected.json"), JSON.stringify({ context: specification.hash, rejected: true }),
        { flag: "wx", mode: 0o600 }); }
      catch (recordError) { if (recordError.code !== "EEXIST") console.error("Reference refusal evidence could not be recorded."); }
    }
    console.error(`Native reference guard refused: ${error.message}`);
    process.exitCode = 1;
  }
}

async function prepareReferenceGuard(root, request, directory, tree) {
  const token = `DEVPOCKET_REF_${randomUUID().replaceAll("-", "")}`;
  const parameters = `${token}_PARAMETERS`, present = `${token}_PRESENT`;
  if ([token, parameters, present].some((name) => process.env[name] !== undefined)) fail("Reference guard environment ownership is unavailable.");
  const original = new Set();
  for (const hook of routedHookNames) {
    for (const suffix of process.platform === "win32" ? ["", ".exe"] : [""]) {
      try { await access(path.join(request.hooks.directory, hook + suffix), constants.X_OK); original.add(hook); break; }
      catch (error) { if (!["ENOENT", "EACCES"].includes(error.code)) throw error; }
    }
  }
  const context = { version: 1, root, directory, physicalRoot: await realpath(root),
    gitDirectory: request.expected.identity.gitDirectory, commonDirectory: request.expected.identity.commonDirectory,
    branch: request.expected.identity.branch, parent: request.expected.source.head,
    ...(tree ? { tree } : {}),
    configuration: request.expected.configuration, hooks: request.hooks,
    parametersPresent: process.env.GIT_CONFIG_PARAMETERS !== undefined,
    parametersHash: sha256(process.env.GIT_CONFIG_PARAMETERS ?? "") };
  const content = JSON.stringify(context), hash = sha256(content);
  const quote = (text) => `'${text.replaceAll("'", "'\"'\"'")}'`;
  for (const hook of new Set([...original, "pre-commit", "reference-transaction"])) {
    const source = `await (${referenceGuard.toString()})(${JSON.stringify({ context: token, hash, hook, original: original.has(hook) })}, ${activeHookSnapshot.toString()});`;
    const script = [
      "#!/bin/sh",
      'if test -n "${NODE_OPTIONS:-}"; then printf "%s\\n" "Unbound Node startup options in reference guard." >&2; exit 78; fi',
      `if test "$${present}" = 1; then GIT_CONFIG_PARAMETERS="$${parameters}"; export GIT_CONFIG_PARAMETERS; else unset GIT_CONFIG_PARAMETERS; fi`,
      `unset ${parameters} ${present}`,
      `if input_file=$(${quote(process.execPath.replaceAll("\\", "/"))} --input-type=module --eval ${quote(source)} -- "$@"); then`,
      `  unset ${token}`,
      `  exec git --no-pager hook run --ignore-missing --to-stdin="$input_file" ${quote(hook)} -- "$@"`,
      "else",
      "  code=$?",
      "  if test \"$code\" = 77; then exit 0; fi",
      "  exit \"$code\"",
      "fi",
      "",
    ].join("\n");
    await writeFile(path.join(directory, hook), script, { flag: "wx", mode: 0o700 });
  }
  return { hash, directory, environment: { [token]: Buffer.from(content).toString("base64"),
    [parameters]: process.env.GIT_CONFIG_PARAMETERS ?? "", [present]: context.parametersPresent ? "1" : "0" } };
}

async function proveReferenceVeto(root, request, guard) {
  let failure;
  try {
    await gitMutation(root, ["-c", `core.hooksPath=${guard.directory}`, "update-ref", "--stdin"],
      `start\nverify ${request.expected.identity.branch} ${request.expected.source.head}\nprepare\nabort\n`, guard.environment);
  } catch (error) { failure = error; }
  let proof;
  try { proof = JSON.parse(await readFile(path.join(guard.directory, "probe.json"), "utf8")); }
  catch { /* Missing evidence cannot authorize a ref-mutating command. */ }
  if (failure?.code !== 128 || failure.killed || failure.signal || failure.traceCleanupFailed ||
      proof?.context !== guard.hash || proof.veto !== true || proof.absenceLookup !== true) {
    fail("Git reference-transaction veto support was not proven; no candidate commit is permitted.");
  }
}

async function commitInspectedIndex(root, request) {
  const index = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "index"])).trim());
  const lockPath = `${index}.lock`;
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() }) + "\n";
  let lock, lockIdentity, directory, probeDirectory, referenceDirectory, failure, published = false, candidate;
  const requireLock = async () => {
    const current = await lstat(lockPath, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino) {
      fail("Candidate index lock ownership changed.");
    }
  };
  const check = async () => {
    const current = await inspectWorktree(root);
    assertIdentity(current, request.expected);
    if (current.source.head !== request.expected.source.head ||
        current.index !== request.expected.index || !sameSource(current.source, request.expected.source) ||
        current.status !== request.expected.status || await contentFingerprint(root) !== request.content ||
        JSON.stringify(await changedPaths(root, current.source.head)) !== JSON.stringify(request.files)) {
      fail("The inspected candidate or expected parent changed before committing.");
    }
    await requireHooks(root, request.hooks);
    await requireLock();
  };
  try {
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if (error.code === "EEXIST") fail("The candidate commit index is locked; preserve the existing lock and inspect before continuing.");
      throw error;
    }
    lockIdentity = await lock.stat({ bigint: true });
    if (lockIdentity.ino === 0n) fail("Candidate index lock identity is unavailable.");
    await lock.writeFile(owner);
    await check();
    probeDirectory = await mkdtemp(path.join(tmpdir(), "devpocket-ref-probe-"));
    const probe = await prepareReferenceGuard(root, request, probeDirectory);
    await proveReferenceVeto(root, request, probe);
    await check();
    directory = await mkdtemp(path.join(tmpdir(), "devpocket-candidate-index-"));
    const isolated = path.join(directory, "index");
    await copyFile(index, isolated);
    const environment = { GIT_INDEX_FILE: isolated };
    try {
      for (const file of request.files) {
        await requireHooks(root, request.hooks);
        await gitMutation(root, ["--literal-pathspecs", "add", "--all", "--", file], undefined, environment);
      }
    } catch (error) { throw Object.assign(error, { candidateFailure: error.candidateFailure ?? "staging-failed" }); }
    await check();
    const stagedPaths = paths(await gitMutation(root, readOnlyGitArgs(["diff", "--cached",
      "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", request.expected.source.head, "--"]), undefined, environment)).sort();
    if (JSON.stringify(stagedPaths) !== JSON.stringify(request.files) ||
        await gitMutation(root, readOnlyGitArgs(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--"]), undefined, environment) ||
        await gitMutation(root, readOnlyGitArgs(["ls-files", "--others", "--exclude-standard", "-z"]), undefined, environment)) {
      fail("The isolated index does not contain exactly the inspected task changes.");
    }
    await requireHooks(root, request.hooks);
    const tree = (await gitMutation(root, ["write-tree"], undefined, environment)).trim();
    const stagedIndex = sha256(await gitMutation(root, readOnlyGitArgs(["ls-files", "--stage", "-z"]), undefined, environment));
    await check();
    referenceDirectory = await mkdtemp(path.join(tmpdir(), "devpocket-ref-guard-"));
    const reference = await prepareReferenceGuard(root, request, referenceDirectory, tree);
    await check();
    try {
      await gitMutation(root, ["-c", `core.hooksPath=${reference.directory}`, "commit", "--file=-"], request.message,
        { ...environment, ...reference.environment });
    } catch (error) {
      try {
        const refusal = JSON.parse(await readFile(path.join(reference.directory, "rejected.json"), "utf8"));
        if (refusal.context === reference.hash && refusal.rejected === true) error.candidateFailure = "candidate-changed";
      } catch { /* The native command outcome remains authoritative when no refusal was recorded. */ }
      throw error;
    }
    const after = await inspectWorktree(root);
    assertIdentity(after, request.expected);
    const preparedReference = JSON.parse(await readFile(path.join(reference.directory, "prepared.json"), "utf8"));
    if (preparedReference.context !== reference.hash || preparedReference.branch !== request.expected.identity.branch ||
        preparedReference.parent !== request.expected.source.head || preparedReference.commit !== after.source.head ||
        preparedReference.tree !== tree) {
      fail("Native commit lacks its expected prepared reference transaction.");
    }
    const ancestry = (await git(root, ["rev-list", "--parents", "-n", "1", after.source.head])).trim().split(" ");
    if (after.index !== request.expected.index ||
        JSON.stringify(ancestry) !== JSON.stringify([after.source.head, request.expected.source.head]) ||
        after.source.head === request.expected.source.head ||
        (await git(root, ["rev-parse", "HEAD^{tree}"])).trim() !== tree ||
        sha256(await gitMutation(root, readOnlyGitArgs(["ls-files", "--stage", "-z"]), undefined, environment)) !== stagedIndex) {
      fail("Candidate commit history, tree or protected index changed.");
    }
    await requireHooks(root, request.hooks);
    await requireLock();
    const bytes = await readFile(isolated);
    await lock.truncate(0);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesWritten } = await lock.write(bytes, offset, bytes.length - offset, offset);
      if (!bytesWritten) fail("Candidate index publication could not write the complete index.");
      offset += bytesWritten;
    }
    await lock.sync();
    await requireLock();
    if (sha256(await readOnlyGit(root, ["ls-files", "--stage", "-z"])) !== request.expected.index) {
      fail("The protected live index changed before publication.");
    }
    await lock.close();
    lock = undefined;
    await requireLock();
    await rename(lockPath, index);
    published = true;
    const final = await inspectWorktree(root);
    candidate = { created: true, parent: request.expected.source.head, commit: after.source.head,
      source: final.source, tree, index: stagedIndex, reference: { version: 2, branch: request.expected.identity.branch,
        parent: request.expected.source.head, commit: after.source.head, tree } };
    await requireCommitResult(root, request, candidate);
  } catch (error) { failure = error; }
  for (const cleanup of [
    async () => { if (directory) await rm(directory, { recursive: true, force: true }); },
    async () => { if (probeDirectory) await rm(probeDirectory, { recursive: true, force: true }); },
    async () => { if (referenceDirectory) await rm(referenceDirectory, { recursive: true, force: true }); },
    async () => {
      if (published) return;
      if (lock) await lock.close();
      if (!lockIdentity) {
        if (lock) throw new Error("Candidate index lock identity was not established.");
        return;
      }
      await requireLock();
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
  return candidate;
}

async function commitCandidateResult(request, requestHash) {
  if (request?.version !== 4 || !request.expected || !request.hooks || !request.execution || path.resolve(request.root) !== request.expected.identity?.root ||
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
  await requireHooks(root, request.hooks);
  let key;
  if (requestHash) {
    try { key = await verificationReceiptKey(root); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  try {
    let candidate;
    try { candidate = await commitInspectedIndex(root, request); }
    catch (error) { throw Object.assign(error, { candidateFailure: error.candidateFailure ?? "commit-failed" }); }
    return { candidate, ...(key ? { verificationProof: candidateReceiptProof(key, requestHash, candidate) } : {}) };
  } finally { key?.fill(0); }
}

export async function commitCandidate(request) {
  return (await commitCandidateResult(request)).candidate;
}

export async function runCandidateRequest(file, hash) {
  if (typeof file !== "string" || !/^[a-f0-9]{64}$/.test(hash ?? "")) fail("Invalid native candidate request.");
  const input = await readFile(file);
  if (input.length > 1024 * 1024 || sha256(input) !== hash) fail("The candidate request changed before execution.");
  const receipt = await open(`${file}.result.json`, "wx", 0o600);
  try {
    const { candidate, verificationProof } = await commitCandidateResult(JSON.parse(input), hash);
    await receipt.writeFile(JSON.stringify({ status: "committed", candidate, ...(verificationProof ? { verificationProof } : {}) }) + "\n");
    await receipt.sync();
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
  console.error("Use the captured native candidate launcher; direct mutable helper execution is not supported.");
  process.exitCode = 1;
}
