import { execFile } from "node:child_process";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { MAX_PREVIEW, MAX_UPLOAD, type SessionSummary } from "./protocol.js";
import { Fault, fileName, hash, redact } from "./security.js";

const exec = promisify(execFile);
const policySchema = z.object({ available: z.boolean(), checks: z.array(z.object({ path: z.string(), excluded: z.boolean() })) });
const excludedName = (name: string) => /^(?:\.git|\.data|\.tools|\.copilot|\.ssh|\.gnupg|node_modules|\.gradle)$/i.test(name) ||
  /^(?:\.env(?:\..*)?|credentials(?:\..*)?|google-services\.json|local\.properties)$/i.test(name) ||
  /\.(?:local\.json|pem|key|p12|pfx|jks|keystore)$/i.test(name) || /service-account.*\.json$/i.test(name);
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

export function contentExclusionDecisions(response: unknown, paths: string[]): boolean[] {
  const parsed = policySchema.safeParse(response);
  if (!parsed.success || !parsed.data.available || parsed.data.checks.length !== paths.length ||
    parsed.data.checks.some((check, i) => check.path !== paths[i]))
    throw new Fault("POLICY_UNAVAILABLE", "Content-exclusion policy is unavailable or incomplete. Access was denied.", 409);
  return parsed.data.checks.map((check) => !check.excluded);
}

export class ProjectFiles {
  constructor(private readonly root: string, private readonly check: (paths: string[]) => Promise<unknown>) {}

  private parts(input: string): string[] {
    if (/^[\\/]|^[A-Za-z]:|[\x00-\x1f]/.test(input)) throw new Fault("INVALID_PATH", "Only relative project paths are allowed.");
    const parts = input === "" ? [] : input.split(/[\\/]/);
    for (const part of parts) {
      try { fileName(part); }
      catch { throw new Fault("INVALID_PATH", "Invalid, reserved or traversing path segment."); }
      if (excludedName(part)) throw new Fault("SENSITIVE_PATH", "DevPocket does not expose credential, runtime or private configuration paths.", 403);
    }
    return parts;
  }

  private async physical(input: string, allowMissing = false): Promise<string> {
    const parts = this.parts(input);
    let current = await realpath(this.root);
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]!);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Fault("SYMLINK_DENIED", "Links and junctions are not exposed by file views.", 403);
      } catch (error) {
        if (isMissing(error) && allowMissing) return path.join(current, ...parts.slice(i + 1));
        if (isMissing(error)) throw new Fault("FILE_NOT_FOUND", "Project path does not exist.", 404);
        throw error;
      }
    }
    return current;
  }

  private async checks(paths: string[]): Promise<boolean[]> {
    let response: unknown;
    try { response = await this.check(paths); }
    catch { throw new Fault("POLICY_UNAVAILABLE", "The runtime could not evaluate content-exclusion policy. Access was denied.", 409); }
    return contentExclusionDecisions(response, paths);
  }

  private async allowed(input: string, allowMissing = false): Promise<string> {
    const absolute = await this.physical(input, allowMissing);
    if (!(await this.checks([absolute]))[0]) throw new Fault("CONTENT_EXCLUDED", "This path is excluded by organization policy.", 403);
    return absolute;
  }

  async list(input: string) {
    const absolute = await this.allowed(input);
    if (!(await lstat(absolute)).isDirectory()) throw new Fault("NOT_DIRECTORY", "Choose a directory.");
    const all = await readdir(absolute, { withFileTypes: true });
    const candidates = all.filter((entry) => !excludedName(entry.name) && !entry.isSymbolicLink())
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 200);
    const flags = candidates.length ? await this.checks(candidates.map((entry) => path.join(absolute, entry.name))) : [];
    return { entries: candidates.flatMap((entry, index) => flags[index] ? [{
      name: entry.name, path: [...this.parts(input), entry.name].join("/"), directory: entry.isDirectory(),
    }] : []), truncated: all.length > 200 };
  }

  async read(input: string) {
    const absolute = await this.allowed(input);
    const handle = await open(absolute, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Fault("NOT_FILE", "Choose a regular file.");
      const ext = path.extname(absolute).toLowerCase();
      const binaryMime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf" };
      const mime = binaryMime[ext];
      const limit = mime ? MAX_UPLOAD : MAX_PREVIEW;
      if (stat.size > limit) throw new Fault("FILE_TOO_LARGE", `Preview limit is ${limit / 1024} KiB. Use the original client for larger files.`, 413);
      const bytes = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const content = bytes.subarray(0, bytesRead);
      let display: string;
      if (mime) {
        const valid = mime === "image/png" ? content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
          mime === "image/jpeg" ? content[0] === 255 && content[1] === 216 :
            mime === "image/webp" ? content.toString("ascii", 0, 4) === "RIFF" && content.toString("ascii", 8, 12) === "WEBP" :
              content.toString("ascii", 0, 5) === "%PDF-";
        if (!valid) throw new Fault("INVALID_MEDIA", "File contents do not match the declared image or PDF type.");
        display = content.toString("base64");
      } else {
        if (content.includes(0)) throw new Fault("BINARY_FILE", "This binary format cannot be previewed.", 415);
        try { display = redact(new TextDecoder("utf-8", { fatal: true }).decode(content), MAX_PREVIEW); }
        catch { throw new Fault("TEXT_ENCODING", "Only UTF-8 text is supported by the safe preview.", 415); }
      }
      return { file: { path: input, name: path.basename(absolute), mime: mime ?? "text/plain",
        size: bytesRead, encoding: mime ? "base64" : "utf8", content: display } };
    } finally { await handle.close(); }
  }

  private async git(args: string[], signal?: AbortSignal, root = this.root): Promise<string> {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
    try {
      const operation = exec("git", [
        "--no-pager", "--no-optional-locks", "--literal-pathspecs",
        "-c", "core.fsmonitor=false", "-c", "diff.external=", "-C", root, ...args,
      ], {
        windowsHide: true, shell: false, timeout: 15_000, maxBuffer: MAX_PREVIEW, signal,
        env: { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      });
      const closed = new Promise<void>((resolve) => { operation.child.once("close", () => resolve()); });
      try { return (await operation).stdout; } finally { await closed; }
    } catch (error) {
      const details = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
      if (/not a git repository/i.test(details)) throw new Fault("NOT_GIT_PROJECT", "The registered directory is not a Git repository.", 409);
      if (isMissing(error)) throw new Fault("GIT_UNAVAILABLE", "Git is not installed on this Dev Box.", 409);
      throw new Fault("GIT_READ_FAILED", "Read-only Git query failed or exceeded its time/output limit. Check the original client.", 409);
    }
  }

  async project(parentSignal?: AbortSignal): Promise<Pick<SessionSummary, "projectId" | "projectName" | "workspace"> | null> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(4000), ...(parentSignal ? [parentSignal] : [])]);
    const queries: Promise<string>[] = [];
    let onAbort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      const directory = await Promise.race([this.allowed(""), aborted]);
      const git = (args: string[]) => {
        signal.throwIfAborted();
        const query = this.git(args, signal, directory);
        queries.push(query);
        return query;
      };
      let location: string;
      try {
        location = await git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
      } catch (error) {
        if (error instanceof Fault && error.code === "NOT_GIT_PROJECT") return null;
        throw error;
      }
      const roots = location.replace(/\r?\n$/, "").split(/\r?\n/);
      if (roots.length !== 2 || roots.some((root) => !path.isAbsolute(root) || root.includes("\0")))
        throw new Fault("GIT_IDENTITY_INVALID", "Git did not return a supported repository identity.", 409);
      const [worktreeRoot, common, listing, branch] = await Promise.race([Promise.all([
        realpath(roots[0]!), realpath(roots[1]!),
        git(["worktree", "list", "--porcelain", "-z"]), git(["branch", "--show-current"]),
      ]), aborted]);
      const first = listing.split("\0", 1)[0];
      const mainRoot = first?.startsWith("worktree ") ? first.slice(9) : "";
      if (!path.isAbsolute(mainRoot))
        throw new Fault("GIT_IDENTITY_INVALID", "Git did not identify the repository's primary working tree.", 409);
      const label = (value: string, limit: number) => redact(value, limit).replace(/\s+/g, " ").trim();
      return {
        projectId: hash(`git:${process.platform === "win32" ? common.toLowerCase() : common}`),
        projectName: label(path.basename(mainRoot), 120) || "Git project",
        workspace: {
          name: label(path.basename(worktreeRoot), 120) || "Workspace",
          branch: label(branch.replace(/\r?\n$/, ""), 200),
        },
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      controller.abort();
      await Promise.allSettled(queries);
    }
  }

  async gitStatus() {
    await this.allowed("");
    const prefix = (await this.git(["rev-parse", "--show-prefix"])).replace(/\r?\n$/, "");
    const output = await this.git(["status", "--porcelain=v1", "-z", "--branch", "--no-renames", "--untracked-files=normal", "--", "."]);
    const records = output.split("\0").filter(Boolean);
    const branch = records[0]?.startsWith("## ") ? records.shift()!.slice(3) : "Unknown";
    const files = [];
    for (const item of records.slice(0, 300)) {
      let relative = item.slice(3);
      if (prefix) {
        if (!relative.startsWith(prefix)) continue;
        relative = relative.slice(prefix.length);
      }
      if (relative.endsWith("/")) relative = relative.slice(0, -1);
      try {
        await this.allowed(relative, true);
        files.push({ path: relative, index: item[0] ?? " ", worktree: item[1] ?? " " });
      } catch (error) {
        if (error instanceof Fault && ["SENSITIVE_PATH", "SYMLINK_DENIED", "CONTENT_EXCLUDED", "INVALID_PATH"].includes(error.code)) continue;
        throw error;
      }
    }
    return { git: { branch: redact(branch, 200), files, truncated: records.length > 300 } };
  }

  async gitDiff(input: string, staged: boolean) {
    await this.allowed(input, true);
    const diff = await this.git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames",
      ...(staged ? ["--cached"] : []), "--", input]);
    return { diff: { path: input, staged, text: redact(diff, MAX_PREVIEW) } };
  }
}
