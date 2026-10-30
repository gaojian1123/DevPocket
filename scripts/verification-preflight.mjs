import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./process.mjs";
import { readOnlyGit, sourceInputs } from "./git-state.mjs";
import { diagnosticError, diagnosticVersion, failureDetails } from "./diagnostic-errors.mjs";
import { CHECKS } from "./verification-policy.mjs";
import { verificationStorageLocation } from "./verification-run.mjs";
import { androidImageArchitecture, androidImagePattern, macOSAcceleration } from "./android-platform.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const scripts = fileURLToPath(new URL(".", import.meta.url));
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const directNode = (value, kind) => value?.kind === kind && /\.(?:com|exe)$/i.test(value.file) &&
  samePath(value.file, process.execPath) && samePath(value.target, process.execPath);
const policyInputs = [
  "verify.mjs", "verify.ps1", "verification.mjs", "verification-policy.mjs", "verification-executor.mjs", "verification-preflight.mjs",
  "verification-run.mjs", "verification-backend.mjs", "verification-android.mjs",
  "test-tooling.mjs", "verification-tooling.mjs", "verification-admission.mjs", "verification-ci.mjs",
  "verification-ci-artifact.ps1", "development-policy.mjs", "development-paths.mjs",
  "candidate-commit.mjs", "native-candidate.mjs", "git-state.mjs", "process.mjs",
  "owned-command-windows.mjs", "owned-command.cs", "owned-command.ps1", "owned-command-linux.py", "owned-command-darwin.py", "local-ipc.mjs",
  "backend-diagnostics.mjs", "diagnostic-errors.mjs", "diagnostic-publication.mjs", "bounded-worker-log.mjs",
  "device-run.mjs", "worker-diagnostics.mjs", "device-diagnostics.mjs", "native-lifecycle.mjs", "android-platform.mjs",
  "emulator-resources.mjs",
];

export function npmLaunchersBound(group, powershellNpm, nativeNpm) {
  return powershellNpm?.candidateSafe === true && powershellNpm?.candidateImplementation === true &&
    (!["tooling", "android", "device"].includes(group) || nativeNpm?.bound === true);
}

async function fileIdentity(file, { optional = false } = {}) {
  let info;
  try { info = await lstat(file); }
  catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw diagnosticError("preflight-path");
  const handle = await open(file, "r");
  try {
    const current = await handle.stat(), hash = createHash("sha256");
    if (current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size ||
        current.mode !== info.mode || current.mtimeMs !== info.mtimeMs) throw diagnosticError("environment-changed");
    if (current.size <= 1024 * 1024) {
      const bytes = Buffer.alloc(current.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) throw diagnosticError("environment-changed");
        offset += result.bytesRead;
      }
      hash.update(bytes);
    } else for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    for (const after of await Promise.all([handle.stat(), lstat(file)])) {
      if (["dev", "ino", "size", "mode", "mtimeMs", "ctimeMs"].some((key) => after[key] !== current[key])) {
        throw diagnosticError("environment-changed");
      }
    }
    return { size: current.size, mode: current.mode, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

async function treeInputs(directory, requiredFile, { directoryLinks = new Map(), excludedRootDirectories = [], hashFiles = true } = {}) {
  const root = await realpath(directory), files = [], identities = [];
  let count = 0;
  async function visit(current, relative, entry) {
    const info = entry ?? await lstat(current);
    if (++count > 100000) throw diagnosticError("output-limit");
    if (info.isSymbolicLink()) {
      if (entry && !(await lstat(current)).isSymbolicLink()) throw diagnosticError("environment-changed");
      const approved = [...directoryLinks.entries()].find(([file]) => samePath(file, current))?.[1];
      if (approved) {
        const link = await readlink(current), target = await realpath(current);
        if (!samePath(path.toNamespacedPath(path.resolve(path.dirname(current), link)), path.toNamespacedPath(approved.target)) ||
            !samePath(target, approved.target) || !(await lstat(target)).isDirectory())
          throw diagnosticError("preflight-path");
        identities.push([relative, { workspace: approved.relative, link: digest(link) }]);
        return;
      }
      const target = await realpath(current), rel = path.relative(root, target);
      if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ||
          !(await lstat(target)).isFile()) throw diagnosticError("preflight-path");
      if (hashFiles) files.push({ file: target, relative, target: rel });
      else identities.push([relative, { target: rel }]);
    } else if (info.isDirectory()) {
      if (entry) {
        const actual = await lstat(current);
        if (!actual.isDirectory() || actual.isSymbolicLink()) throw diagnosticError("environment-changed");
      }
      const children = (await readdir(current, { withFileTypes: true }))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const child of children) {
        if (!relative && excludedRootDirectories.includes(child.name)) {
          const output = await lstat(path.join(current, child.name));
          if (!output.isDirectory() || output.isSymbolicLink()) throw diagnosticError("preflight-path");
          continue;
        }
        await visit(path.join(current, child.name), path.join(relative, child.name), child);
      }
    } else {
      if (!info.isFile()) throw diagnosticError("preflight-path");
      if (hashFiles || relative === requiredFile) files.push({ file: current, relative });
    }
  }
  await visit(directory, "");
  if (requiredFile && !files.some(({ relative, target }) => relative === requiredFile && target === undefined)) {
    throw diagnosticError("preflight-path");
  }
  // Readiness still checks directory/link scope, but cannot qualify unchanged file contents for reuse.
  if (!hashFiles) return identities;
  for (let start = 0; start < files.length; start += 16) {
    identities.push(...await Promise.all(files.slice(start, start + 16).map(async ({ file, relative, target }) => {
      const identity = await fileIdentity(file);
      return [relative, target === undefined ? identity : { target, identity }];
    })));
  }
  return identities;
}

async function treeIdentity(directory, requiredFile, options) {
  return digest(JSON.stringify(await treeInputs(directory, requiredFile, options)));
}

export function emulatorInputDifference(before, after) {
  if (!before || !after) return { version: 1, acceptance: false, availability: "incomplete" };
  const fingerprint = (value) => value === undefined ? null : digest(JSON.stringify(value));
  const facts = ["binary", "acceleration", "version", "tree"].filter((name) =>
    fingerprint(before.identity[name]) !== fingerprint(after.identity[name]))
    .map((name) => ({ name, before: fingerprint(before.identity[name]), after: fingerprint(after.identity[name]) }));
  const previous = new Map(before.files), current = new Map(after.files);
  const changed = [...new Set([...previous.keys(), ...current.keys()])].sort()
    .filter((name) => fingerprint(previous.get(name)) !== fingerprint(current.get(name)));
  const describe = (value) => {
    if (!value) return null;
    const file = value.identity ?? value;
    return { sha256: file.sha256, bytes: file.size, mode: file.mode,
      ...(value.target === undefined ? {} : { linkTargetSha256: digest(value.target) }) };
  };
  return { version: 1, acceptance: false, availability: "complete", facts,
    files: { changed: changed.length, omitted: Math.max(0, changed.length - 32),
      entries: changed.slice(0, 32).map((name) => {
        const relative = name.replaceAll("\\", "/");
        const publicPath = relative.length <= 240 && /^[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*$/.test(relative) &&
          !relative.split("/").some((part) => part === "." || part === "..") &&
          !/(?:gh[pousr]_|github_pat_|dpp_|credential|password|secret|token|private)/i.test(relative);
        return { ...(publicPath ? { path: relative } : {}), pathSha256: digest(relative),
          before: describe(previous.get(name)), after: describe(current.get(name)) };
      }) } };
}

function properties(text) {
  const result = new Map();
  const decode = (value) => value.replace(/\\(u[0-9a-fA-F]{4}|.)|\\$/g, (_, escape) => {
    if (!escape || escape[0] === "u" && escape.length !== 5) throw diagnosticError("preflight-sdk");
    return escape[0] === "u" ? String.fromCharCode(parseInt(escape.slice(1), 16))
      : ({ t: "\t", n: "\n", r: "\r", f: "\f" }[escape] ?? escape);
  });
  for (const line of text.split(/\r?\n/).map((value) => value.trimStart())) {
    if (!line || /^[#!]/.test(line)) continue;
    const match = /^((?:\\.|[^\s:=\\])+)\s*(?:[:=]\s*)?(.*)$/.exec(line);
    if (!match) throw diagnosticError("preflight-sdk");
    const key = decode(match[1]);
    result.set(key, decode(match[2]));
  }
  return result;
}

async function nativeConfiguration(root, jdk, sdk, cache) {
  const inputs = [];
  let reusable = true;
  for (const file of [path.join(root, "android", "local.properties"), path.join(root, "android", "gradle.properties"),
    path.join(cache, "gradle.properties")]) {
    const identity = await fileIdentity(file, { optional: true });
    if (!identity) { inputs.push(null); continue; }
    if (identity.size > 65536) throw diagnosticError("preflight-sdk");
    const values = properties(await readFile(file, "latin1"));
    for (const [key, value] of values) {
      if (!/(?:^|\.)jvmargs$/i.test(key)) continue;
      reusable &&= value.trim().split(/\s+/).filter(Boolean).every((argument) =>
        /^(?:-Xm[sx]\d+[kKmMgG]|-XX:MaxMetaspaceSize=\d+[kKmMgG]|-XX:\+HeapDumpOnOutOfMemoryError|-Dfile\.encoding=UTF-8)$/.test(argument));
    }
    for (const [key, selected] of [["sdk.dir", sdk], ["org.gradle.java.home", jdk]]) {
      if (values.has(key)) {
        const configured = path.resolve(root, "android", values.get(key));
        if (!samePath(configured, path.resolve(selected)) && !samePath(configured, await realpath(selected))) {
          throw diagnosticError("preflight-sdk");
        }
      }
    }
    inputs.push(identity);
  }
  const criteria = await fileIdentity(path.join(root, "android", "gradle", "gradle-daemon-jvm.properties"), { optional: true });
  if (criteria) throw diagnosticError("preflight-sdk");
  return { inputs, reusable };
}

async function gradleArtifacts(root) {
  const directory = path.join(root, ".tools", "gradle-cache"), files = [];
  let entries = 0;
  async function collect(current, relative) {
    if (++entries > 100000) throw diagnosticError("output-limit");
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw diagnosticError("preflight-path");
    if (info.isDirectory()) {
      for (const name of (await readdir(current)).sort()) await collect(path.join(current, name), path.join(relative, name));
    } else {
      if (!info.isFile()) throw diagnosticError("preflight-path");
      files.push({ file: current, relative });
    }
  }
  await collect(path.join(directory, "wrapper", "dists"), path.join("wrapper", "dists"));
  await collect(path.join(directory, "caches"), "caches");
  const identities = [];
  for (let start = 0; start < files.length; start += 16) {
    identities.push(...await Promise.all(files.slice(start, start + 16).map(async ({ file, relative }) =>
      [relative, await fileIdentity(file)])));
  }
  if (!files.some((item) => item.relative.endsWith(".jar"))) return null;
  return digest(JSON.stringify(identities));
}

export async function resolveVerificationExecutable(root, name, { shell = false } = {}) {
  const windows = process.platform === "win32";
  // libuv tries COM/EXE independently of CMD's PATHEXT order.
  const explicitExtension = windows && /\.(?:com|exe|bat|cmd)$/i.test(name);
  const extensions = explicitExtension ? [""] : windows ? shell ? (process.env.PATHEXT ?? "").split(";") : [".com", ".exe"] : [""];
  if (windows && !explicitExtension && extensions.some((extension) => !/^\.[a-z0-9]+$/i.test(extension))) {
    throw diagnosticError("preflight-tool");
  }
  const directories = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter);
  if (windows && process.env.NoDefaultCurrentDirectoryInExePath === undefined) directories.unshift(root);
  for (let directory of directories) {
    if (windows) {
      if (!directory) {
        if (shell) throw diagnosticError("preflight-tool");
        continue;
      }
      if (directory.includes('"')) {
        if (!/^"[^"]+"$/.test(directory)) throw diagnosticError("preflight-path");
        directory = directory.slice(1, -1);
      }
    }
    for (const extension of extensions) {
      const file = path.resolve(root, directory, name + extension);
      try {
        const resolved = await realpath(file);
        await access(resolved, constants.R_OK | constants.X_OK);
        if ((await lstat(resolved)).isFile()) return shell ? file : resolved;
      } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
    }
  }
  throw diagnosticError("preflight-tool");
}

async function writable(root, target) {
  const location = await verificationStorageLocation(root, target);
  root = location.root;
  target = location.file;
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw diagnosticError("preflight-path");
  let current = path.resolve(target);
  while (true) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(current), current)) {
        throw diagnosticError("preflight-path");
      }
      await access(current, constants.W_OK | constants.X_OK);
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || current === path.dirname(current)) throw error;
      current = path.dirname(current);
    }
  }
  return true;
}

const environment = (pattern) => digest(JSON.stringify(Object.entries(process.env)
  .filter(([name]) => pattern.test(name)).sort(([a], [b]) => a.localeCompare(b))));

const dependencyMap = (value) => {
  if (value === undefined || value === null) return "[]";
  if (typeof value !== "object" || Array.isArray(value) ||
      Object.values(value).some((entry) => typeof entry !== "string")) throw diagnosticError("preflight-dependencies");
  return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
};

async function declaredWorkspaces(root, manifest) {
  if (manifest.workspaces === undefined) return [];
  if (!Array.isArray(manifest.workspaces) || manifest.workspaces.length > 32 ||
      new Set(manifest.workspaces).size !== manifest.workspaces.length) throw diagnosticError("preflight-dependencies");
  const physicalRoot = await realpath(root), result = [];
  for (const relative of manifest.workspaces) {
    if (typeof relative !== "string" || !/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/i.test(relative) ||
        relative.split("/").some((part) => [".", "..", ".git", ".data", ".tools", "node_modules"].includes(part.toLowerCase())))
      throw diagnosticError("preflight-dependencies");
    let directory = physicalRoot;
    for (const part of relative.split("/")) {
      directory = path.join(directory, part);
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(directory, await realpath(directory)))
        throw diagnosticError("preflight-path");
    }
    const file = path.join(directory, "package.json"), before = await fileIdentity(file);
    const text = await readFile(file, "utf8");
    if (digest(text) !== before.sha256) throw diagnosticError("environment-changed");
    const contents = JSON.parse(text);
    if (typeof contents.name !== "string" || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(contents.name) ||
        typeof contents.version !== "string" || !contents.version || contents.workspaces !== undefined)
      throw diagnosticError("preflight-dependencies");
    result.push({ relative, directory, manifest: contents,
      outputs: Array.isArray(contents.files) && contents.files.includes("dist") ? ["dist"] : [] });
  }
  if (new Set(result.map((item) => item.manifest.name)).size !== result.length)
    throw diagnosticError("preflight-dependencies");
  return result;
}

export async function dependencies(root, { bind = true } = {}) {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const workspaces = await declaredWorkspaces(root, manifest), workspaceByPath = new Map(workspaces.map((item) => [item.relative, item]));
  if (!Object.keys(declared).length && !workspaces.length) return { manifest: digest(JSON.stringify(manifest)), installed: null };
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  if (!lock.packages || ![2, 3].includes(lock.lockfileVersion)) throw diagnosticError("preflight-dependencies");
  for (const name of Object.keys(declared)) {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw diagnosticError("preflight-dependencies");
    const installed = JSON.parse(await readFile(path.join(root, "node_modules", name, "package.json"), "utf8"));
    const item = lock.packages[`node_modules/${name}`];
    const version = item?.link === true ? workspaceByPath.get(item.resolved)?.manifest.version : item?.version;
    if (installed.version !== version) throw diagnosticError("preflight-dependencies");
  }
  const directoryLinks = new Map();
  for (const workspace of workspaces) {
    const locked = lock.packages[workspace.relative], link = lock.packages[`node_modules/${workspace.manifest.name}`];
    if (locked?.name !== workspace.manifest.name || locked?.version !== workspace.manifest.version ||
        link?.link !== true || link.resolved !== workspace.relative) throw diagnosticError("preflight-dependencies");
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])
      if (dependencyMap(locked[field]) !== dependencyMap(workspace.manifest[field]))
        throw diagnosticError("preflight-dependencies");
  }
  for (const [name, item] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (workspaceByPath.has(name)) continue;
    const modulePath = name.startsWith("node_modules/") ||
      workspaces.some((workspace) => name.startsWith(`${workspace.relative}/node_modules/`));
    if (!modulePath || name.includes("\\") || name.split("/").some((part) => ["", ".", ".."].includes(part))) {
      throw diagnosticError("preflight-dependencies");
    }
    if (item.link === true) {
      const workspace = workspaceByPath.get(item.resolved), file = path.join(root, name);
      if (!workspace || name.split("node_modules/").at(-1) !== workspace.manifest.name ||
          !(await lstat(file)).isSymbolicLink()) throw diagnosticError("preflight-dependencies");
      if (!samePath(await realpath(file), workspace.directory)) throw diagnosticError("preflight-path");
      directoryLinks.set(file, { target: workspace.directory, relative: workspace.relative });
      continue;
    }
    const applicable = (!item.os || item.os.includes(process.platform) || item.os.every((os) => os.startsWith("!") && os !== `!${process.platform}`)) &&
      (!item.cpu || item.cpu.includes(process.arch));
    if (item.optional && !applicable) continue;
    const installed = JSON.parse(await readFile(path.join(root, name, "package.json"), "utf8"));
    if (installed.version !== item.version) throw diagnosticError("preflight-dependencies");
  }
  return { manifest: digest(JSON.stringify(manifest)), lock: digest(JSON.stringify(lock)),
    installed: await treeIdentity(path.join(root, "node_modules"), undefined, { directoryLinks, hashFiles: bind }),
    ...(workspaces.length ? { workspaces: await Promise.all(workspaces.map(async (workspace) => ({
      path: workspace.relative, source: await treeIdentity(workspace.directory, "package.json",
        { directoryLinks, excludedRootDirectories: workspace.outputs, hashFiles: bind }),
    }))) } : {}) };
}

export async function verificationExecutionPolicy() {
  return digest(JSON.stringify(await Promise.all(policyInputs.map(async (name) =>
    [name, await fileIdentity(path.join(scripts, name))]))));
}

export async function verificationArtifacts(root, plan, group, { bind = true } = {}) {
  const paths = group === "backend" && plan.requiredChecks.includes("backend-build") ? ["dist"]
    : ["android", "device"].includes(group)
      ? ["android/app/build/outputs/apk/debug/app-debug.apk", "android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"] : [];
  if (["backend", "android", "device"].includes(group)) {
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (manifest) for (const workspace of await declaredWorkspaces(root, manifest))
      paths.push(...workspace.outputs.map((output) => `${workspace.relative}/${output}`));
  }
  const identities = [];
  for (const relative of paths) {
    const file = path.join(root, ...relative.split("/"));
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw diagnosticError("preflight-path");
      identities.push([relative, info.isDirectory() ? await treeIdentity(file) : await fileIdentity(file)]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { available: false };
    }
  }
  if (bind && ["android", "device"].includes(group)) {
    if (group === "device" && process.platform === "linux" && process.env.GITHUB_ACTIONS === "true" &&
        process.env.RUNNER_ENVIRONMENT === "github-hosted") return { available: false };
    let gradle;
    try { gradle = await gradleArtifacts(root); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!gradle) return { available: false };
    identities.push(["gradle-executable-dependencies", gradle]);
  }
  return { available: true, fingerprint: digest(JSON.stringify(identities)) };
}

export async function verificationPreflight(root, plan, options = {}) {
  const selected = CHECKS.filter((check) => plan.requiredChecks.includes(check.id) &&
    (!options.group || options.group === "all" || options.group === check.group));
  const groups = [...new Set(selected.map((check) => check.group))], memo = new Map();
  const inputs = groups.length ? await sourceInputs(root) : [];
  if (groups.length && digest(JSON.stringify(inputs)) !== plan.source.fingerprint) throw diagnosticError("source-changed");
  const sourceHasLinks = inputs.some((entry) => entry[1] === "120000" || entry[2] === "link");
  const once = (name, operation) => {
    if (!memo.has(name)) memo.set(name, Promise.resolve().then(operation));
    return memo.get(name);
  };
  const probe = async (file, args, env) => {
    const result = await runCommand(file, args, { cwd: root, env, timeoutMs: 30000, signal: options.signal });
    return `${result.stdout}${result.stderr}`.trim();
  };
  const tool = async (name, args, acceptVersion) => {
    const file = await resolveVerificationExecutable(root, name), output = await probe(file, args);
    if (acceptVersion && !acceptVersion(output)) throw diagnosticError("preflight-version");
    return { file, binary: await fileIdentity(file), output: digest(output) };
  };
  const owner = () => once("ownership", async () => {
    if (process.platform === "linux") return tool("python3", ["--version"], (text) => /^Python 3\./.test(text));
    if (process.platform === "darwin") return tool("python3",
      ["-B", path.join(scripts, "owned-command-darwin.py"), "--probe"], (text) => {
        const value = JSON.parse(text);
        return value.platform === "darwin" && value.ownership === "responsibility-audit-token" &&
          typeof value.release === "string" && /^\d+\.\d+\.\d+$/.test(value.release);
      });
    if (process.platform !== "win32") throw diagnosticError("preflight-tool");
    const directory = path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "", "Microsoft.NET", "Framework64", "v4.0.30319");
    return Promise.all(["csc.exe", "csc.exe.config", "csc.rsp", "clr.dll", "mscorlib.dll", "System.Runtime.Serialization.dll"]
      .map((name) => fileIdentity(path.join(directory, name))));
  });
  const powershell = () => once("pwsh", () => tool("pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], (text) => /^7\./.test(text)));
  const npm = (bind = false) => once(`npm:${bind}`, async () => {
    const shell = await powershell();
    const probeResult = await runCommand(shell.file, ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; $command=Get-Command npm -CommandType Application,ExternalScript | Select-Object -First 1; " +
      "$nodeCommand=Get-Command node -CommandType Application,ExternalScript | Select-Object -First 1; " +
      "$version=& npm --version; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; " +
      "$lines=@(& npm config get node-options script-shell userconfig globalconfig); if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; " +
      "$settings=@{}; foreach($line in $lines){ " +
      "if($line -notmatch '^(node-options|script-shell|userconfig|globalconfig)=(.*)$'){throw 'Unsupported npm configuration output.'}; " +
      "if($settings.ContainsKey($Matches[1])){throw 'Duplicate npm configuration output.'}; $settings[$Matches[1]]=$Matches[2] }; " +
      "if($settings.Count -ne 4){throw 'Incomplete npm configuration output.'}; " +
      "@{file=$command.Source;nodeFile=$nodeCommand.Source;nodeType=$nodeCommand.CommandType.ToString();version=\"$version\";nodeOptions=$settings['node-options'];scriptShell=$settings['script-shell'];" +
      "userConfig=$settings['userconfig'];globalConfig=$settings['globalconfig']} | ConvertTo-Json -Compress"],
    { cwd: root, timeoutMs: 30000, signal: options.signal });
    const output = JSON.parse(probeResult.stdout);
    if (!/^\d+\.\d+\.\d+$/.test(output.version) || !path.isAbsolute(output.file) || !path.isAbsolute(output.nodeFile) ||
        !["Application", "ExternalScript"].includes(output.nodeType)) {
      throw diagnosticError("preflight-version");
    }
    const nodeFile = path.resolve(output.nodeFile), nodeTarget = await realpath(nodeFile), hostNode = await memo.get("node");
    const powershellNode = { file: nodeFile, target: nodeTarget, kind: output.nodeType,
      binary: samePath(nodeTarget, hostNode.file) ? hostNode.binary : await fileIdentity(nodeTarget) };
    const config = [];
    for (const name of [...new Set([path.join(await realpath(root), ".npmrc"), path.join(homedir(), ".npmrc"),
      output.userConfig, output.globalConfig].filter(Boolean))]) {
      config.push([name, await fileIdentity(name, { optional: true })]);
    }
    const actual = await realpath(output.file);
    const binary = await fileIdentity(actual);
    const candidateSafe = ["", "null"].includes(output.nodeOptions) && ["", "null"].includes(output.scriptShell) &&
      !process.execArgv.some((value) => /^--(?:import|require|loader|experimental-loader)(?:=|$)|^-r$/.test(value)) &&
      !Object.entries(process.env).some(([name, value]) =>
        /^(?:NODE_OPTIONS|NODE_PATH|NPM_CONFIG_NODE_OPTIONS|NPM_CONFIG_SCRIPT_SHELL)$/i.test(name) && value);
    const full = bind && process.platform === "win32" && candidateSafe && !probeResult.stderr.trim() &&
      output.version === "11.16.0" && samePath(path.resolve(output.file), actual) &&
      ["e8aedc8c76d6cb9423b70ede071228f7cb1644094c114b8721ae6d121100d4fe",
        "3bf7c5ef339b71d6f8bc4ef4a7b7adb90727788674f0a3cef2ede8f5969ca327"].includes(binary.sha256);
    const candidates = [path.join(path.dirname(actual), "node_modules", "npm"), path.resolve(path.dirname(actual), "..")];
    let packageIdentity;
    for (const directory of candidates) {
      let value;
      try { value = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (value.name === "npm") {
        const tree = await treeIdentity(directory, undefined, { hashFiles: full });
        packageIdentity = full ? tree : digest(JSON.stringify({
          manifest: await fileIdentity(path.join(directory, "package.json")), tree,
        }));
        break;
      }
    }
    if (!packageIdentity) throw diagnosticError("preflight-tool");
    let candidateImplementation = full &&
      packageIdentity === "0f3af07d0eef7aeeeadb0efc710993da57bdbfacd9edbfc3cde3fd63a0a4206a";
    let prefixResolution = { status: "unrecognized" };
    if (candidateImplementation) {
      const node = path.join(path.dirname(actual), "node.exe");
      let localNode;
      try { localNode = await realpath(node); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      candidateImplementation = Boolean(localNode && samePath(localNode, await realpath(process.execPath)));
      if (candidateImplementation) {
        const adjacent = path.join(path.dirname(actual), "node_modules", "npm", "bin");
        const result = await runCommand(node, [path.join(adjacent, "npm-prefix.js")],
          { cwd: root, timeoutMs: 30000, signal: options.signal });
        const prefix = result.stdout.replace(/\r?\n$/, "");
        candidateImplementation = path.isAbsolute(prefix) && prefix.length <= 4096 && !/[\x00-\x1f`"$]/.test(prefix) &&
          !result.stderr.trim();
        if (candidateImplementation) {
          const redirected = path.resolve(prefix, "node_modules", "npm", "bin", "npm-cli.js");
          let present = false;
          try { await lstat(redirected); present = true; }
          catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
          candidateImplementation = !present || samePath(redirected, path.join(adjacent, "npm-cli.js"));
          prefixResolution = { status: candidateImplementation ? "adjacent" : "redirected", prefix };
        }
      }
    }
    return { version: output.version, file: output.file, binary, packageIdentity, config, stderr: digest(probeResult.stderr),
      candidateImplementation, candidateSafe, prefixResolution, powershellNode };
  });
  const nativeNpm = (bind = false) => once(`native-npm:${bind}`, async () => {
    // Gradle and tooling shards use npm.cmd to preserve forwarded arguments on Windows.
    const windows = process.platform === "win32";
    const file = await resolveVerificationExecutable(root, windows ? "npm.cmd" : "npm", { shell: windows });
    const actual = await realpath(file), binary = await fileIdentity(actual), identity = await npm(bind);
    const known = await realpath(identity.file);
    const sameBootstrap = samePath(path.dirname(actual), path.dirname(known));
    let interpreter;
    let bound = identity.candidateSafe && identity.candidateImplementation && samePath(file, actual) && sameBootstrap;
    if (windows) {
      const command = await resolveVerificationExecutable(root, "cmd");
      const expected = path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "", "System32", "cmd.exe");
      interpreter = { file: command, binary: await fileIdentity(command) };
      bound &&= binary.sha256 === "21b46c69ad6e2f231f02a9e120f4ba6c8e75fef5a45637103002eab99f888ab8" &&
        identity.prefixResolution.status === "adjacent" && !/[&|<>^%!]/.test(identity.prefixResolution.prefix) &&
        samePath(command, expected) &&
        samePath(process.env.ComSpec ?? process.env.COMSPEC ?? "", expected) &&
        /^\.COM;\.EXE;\.BAT;\.CMD(?:;|$)/i.test(process.env.PATHEXT ?? "");
    }
    return { file, actual, binary, ...(interpreter ? { interpreter } : {}), bound,
      ...(sameBootstrap ? { packageIdentity: identity.packageIdentity, prefixResolution: identity.prefixResolution } : {}) };
  });
  const python = (file, requirements, bind = false) => once(`python:${file}:${requirements ?? ""}:${bind}`, async () => {
    const program = path.isAbsolute(file) ? file : await resolveVerificationExecutable(root, file, { shell: process.platform !== "win32" });
    const script = "import sys,json,importlib.metadata as m,hashlib\n" +
      "if sys.version_info < (3,12): raise RuntimeError('Python 3.12 or newer is required')\n" +
      "result={'version':list(sys.version_info[:3]),'executable':sys.executable}\n" +
      (requirements ? "import cryptography.hazmat.primitives.asymmetric.rsa\n" +
        `if m.version('cryptography') != ${JSON.stringify(requirements)}: raise RuntimeError('cryptography version does not match the declared pin')\n` +
        "h=hashlib.sha256()\n" +
        "for name in ('cryptography','cffi','pycparser'):\n" +
        " try: version=m.version(name)\n" +
        " except m.PackageNotFoundError:\n" +
        "  if name=='cryptography': raise\n" +
        "  continue\n" +
        " h.update(name.encode());h.update(version.encode())\n" +
        (bind ? " d=m.distribution(name)\n" +
          " for f in sorted(d.files or []):\n" +
          "  if str(f).endswith('.pyc'): continue\n" +
          "  p=d.locate_file(f)\n" +
          "  if p.is_file(): h.update(str(f).encode());h.update(p.read_bytes())\n" : "") +
        "result['dependencies']=h.hexdigest()\n" : "") +
      "print(json.dumps(result))";
    const output = JSON.parse(await probe(program, ["-B", "-c", script]));
    return { ...output, binary: await fileIdentity(await realpath(program)),
      ...(process.platform !== "win32" ? {
        virtualEnvironment: await fileIdentity(path.resolve(path.dirname(program), "..", "pyvenv.cfg"), { optional: true }),
      } : {}) };
  });
  const results = [];
  let ownershipFailure;
  for (const group of groups) {
    const identities = [], issues = [], notProbed = [], passed = new Set();
    let bindDependencies = false;
    const check = async (prerequisite, operation, reason = "preflight-tool", requires = []) => {
      const blockedBy = requires.filter((name) => !passed.has(name));
      if (blockedBy.length) {
        notProbed.push({ prerequisite, blockedBy });
        return;
      }
      try {
        const value = await operation(), previous = identities.find(([name]) => name === prerequisite);
        if (previous) previous[1] = value;
        else identities.push([prerequisite, value]);
        passed.add(prerequisite);
      } catch (error) {
        passed.delete(prerequisite);
        const failure = failureDetails(error, reason);
        issues.push({ prerequisite, failure });
        if (failure.observedProcess === "owned-command-supervisor" && failure.processTreeStopped !== true) {
          ownershipFailure = error;
          passed.delete("command-ownership");
        }
      }
    };
    const has = (id) => selected.some((item) => item.group === group && item.id === id);
    const injected = (pattern) => Object.entries(process.env).some(([name, value]) => value && pattern.test(name));
    const java = ["android", "device"].includes(group);
    const device = group === "device";
    let jdk, sdk, cacheDirectory;
    await check("command-ownership", () => {
      if (ownershipFailure) throw ownershipFailure;
      return owner();
    });
    await check("node", () => once("node", async () => {
      if (!/^v26\./.test(process.version)) throw diagnosticError("preflight-version");
      return { version: process.version, file: process.execPath, binary: await fileIdentity(process.execPath),
        child: await tool("node", ["--version"], (text) => /^v26\./.test(text)) };
    }), "preflight-tool", ["command-ownership"]);
    await check("powershell", powershell, "preflight-tool", ["command-ownership"]);
    await check("output-directory", () => writable(root, options.directory), "preflight-path");
    if (java) {
      jdk = path.resolve(root, options.jdk ?? (device ? process.env.DEVPOCKET_JDK : undefined) ?? path.join(".tools", "jdk-25"));
      sdk = path.resolve(root, options.sdk ?? (device ? process.env.DEVPOCKET_ANDROID_SDK : undefined) ?? path.join(".tools", "android-sdk"));
      cacheDirectory = device && process.platform === "linux" && process.env.GITHUB_ACTIONS === "true" &&
        process.env.RUNNER_ENVIRONMENT === "github-hosted" ? path.join(options.directory, "device", "gradle-cache")
        : path.join(root, ".tools", "gradle-cache");
      await check("gradle-cache", async () => {
        await writable(root, cacheDirectory);
        let initDirectory = null;
        try { initDirectory = await treeIdentity(path.join(cacheDirectory, "init.d"), undefined, { hashFiles: false }); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        return { properties: await fileIdentity(path.join(cacheDirectory, "gradle.properties"), { optional: true }),
          init: await fileIdentity(path.join(cacheDirectory, "init.gradle"), { optional: true }),
          initKotlin: await fileIdentity(path.join(cacheDirectory, "init.gradle.kts"), { optional: true }), initDirectory };
      }, "preflight-path");
      await check("native-configuration", () => nativeConfiguration(root, jdk, sdk, cacheDirectory), "preflight-sdk");
      identities.push(["java-environment", environment(/^(?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GRADLE_OPTS|JAVA_OPTS|ORG_GRADLE_PROJECT_.*)$/i)]);
    }
    const usesNpm = ["tooling", "backend", "android", "device"].includes(group);
    if (usesNpm) {
      await check("root-dependencies", () => once("root-dependencies", () => dependencies(root, { bind: false })), "preflight-dependencies");
      await check("npm", npm, "preflight-tool", ["command-ownership", "node", "powershell"]);
      if (group === "tooling" || java) await check("native-npm", nativeNpm, "preflight-tool", ["command-ownership", "npm"]);
      await check("node-command", () => once("node-command", async () => {
        if ((await npm()).candidateSafe !== true) return { status: "unbound" };
        const child = (await memo.get("node")).child;
        const file = await resolveVerificationExecutable(root, "node", { shell: true });
        const target = await realpath(file);
        const kind = process.platform !== "win32" || /\.(?:com|exe)$/i.test(file) ? "native"
          : /\.(?:cmd|bat)$/i.test(file) ? "batch" : "associated";
        if (kind === "associated") throw diagnosticError("preflight-tool");
        const binary = samePath(target, child.file) ? child.binary : await fileIdentity(target);
        if (!samePath(file, target)) return { file, target, kind, binary, status: "unbound" };
        if (kind === "native" && samePath(file, child.file)) return { ...child, target, kind };
        const output = await probe((await powershell()).file,
          ["-NoProfile", "-NonInteractive", "-Command", `& '${file.replaceAll("'", "''")}' --version; exit $LASTEXITCODE`]);
        if (!/^v26\./.test(output)) throw diagnosticError("preflight-version");
        return { file, target, kind, binary, output: digest(output) };
      }), "preflight-tool", ["command-ownership", "npm"]);
      identities.push(["node-environment", environment(/^(?:NODE_.*|TSX_.*|TS_NODE_.*|ESBUILD_.*|NPM_CONFIG_.*|PATH|COMSPEC|PATHEXT|NODEFAULTCURRENTDIRECTORYINEXEPATH|SHELL|SYSTEMROOT|WINDIR|CI|TZ|LANG|LC_.*)$/i)]);
      const npmInput = identities.find(([name]) => name === "npm")?.[1];
      const startupBound = (input) => input?.candidateSafe === true &&
        samePath(identities.find(([name]) => name === "node")?.[1]?.child?.file ?? "", process.execPath) &&
        directNode(identities.find(([name]) => name === "node-command")?.[1], "native") &&
        directNode(input.powershellNode, "Application");
      const cache = identities.find(([name]) => name === "gradle-cache")?.[1];
      const mayBind = process.platform === "win32" && npmInput?.version === "11.16.0" &&
        passed.has("root-dependencies") && !sourceHasLinks && startupBound(npmInput) &&
        !injected(/^(?:TSX_|TS_NODE_|ESBUILD_)/i) &&
        !(java && (identities.find(([name]) => name === "root-dependencies")?.[1]?.workspaces?.length ||
          !passed.has("gradle-cache") || !passed.has("native-configuration") ||
          cache?.init || cache?.initKotlin || cache?.initDirectory ||
          identities.find(([name]) => name === "native-configuration")?.[1]?.reusable !== true ||
          injected(/^(?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GRADLE_OPTS|JAVA_OPTS)$/i))) &&
        !((group === "tooling" || has("setup") || has("operations-tests") || has("azure-tests")) &&
          injected(/^(?:PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONUSERBASE)$/i));
      if (mayBind) {
        await check("npm", () => npm(true), "preflight-tool", ["command-ownership", "node", "powershell"]);
        if (group === "tooling" || java)
          await check("native-npm", () => nativeNpm(true), "preflight-tool", ["command-ownership", "npm"]);
        const boundNpm = identities.find(([name]) => name === "npm")?.[1];
        bindDependencies = startupBound(boundNpm) &&
          npmLaunchersBound(group, boundNpm, identities.find(([name]) => name === "native-npm")?.[1]);
        if (bindDependencies)
          await check("root-dependencies", () => once("bound-root-dependencies", () => dependencies(root)), "preflight-dependencies");
      }
    }
    if (has("backend-build")) await check("backend-output", () => writable(root, path.join(root, "dist")), "preflight-path");
    if (group === "tooling" || has("backend-tests")) {
      await check("git", () => once("git", async () => ({
        tool: await tool("git", ["--version"], (text) => /^git version 2\.(?:3[4-9]|[4-9]\d|\d{3,})\./.test(text)),
        configuration: digest(await readOnlyGit(root, ["config", "--null", "--list", "--show-origin", "--show-scope"])),
        branch: (await readOnlyGit(root, ["rev-parse", "--symbolic-full-name", "HEAD"])).trim(),
      })), "preflight-tool", ["command-ownership"]);
    }
    if (group === "tooling") {
      await check("ssh-keygen", () => once("ssh-keygen", async () => {
        const file = await resolveVerificationExecutable(root, "ssh-keygen");
        return { file, binary: await fileIdentity(file) };
      }));
    }
    if (group === "tooling" || has("setup") || has("operations-tests")) {
      await check("python", () => python("python"), "preflight-tool", ["command-ownership"]);
      identities.push(["python-environment", environment(/^(?:PYTHON.*|VIRTUAL_ENV)$/i)]);
    }
    if (has("azure-tests")) {
      const azure = path.join(root, "deployment", "azure");
      await check("azure-dependencies", () => once("azure-dependencies", () => dependencies(azure, { bind: bindDependencies })), "preflight-dependencies");
      await check("probe-python", async () => {
        const requirements = await readFile(path.join(azure, "probe", "requirements-test.txt"), "utf8");
        const match = requirements.trim().match(/^cryptography==(\d+\.\d+\.\d+)$/);
        if (!match) throw diagnosticError("preflight-dependencies");
        const file = process.env.DEVPOCKET_PROBE_PYTHON ??
          path.join(root, ".tools", "probe-python", process.platform === "win32" ? "Scripts" : "bin",
            process.platform === "win32" ? "python.exe" : "python");
        return python(file, match[1], bindDependencies);
      }, "preflight-dependencies", ["command-ownership"]);
    }
    if (has("operations-tests")) {
      await check("operations-python", async () => {
        const requirements = await readFile(path.join(root, "deployment", "azure", "probe", "requirements-test.txt"), "utf8");
        const match = requirements.trim().match(/^cryptography==(\d+\.\d+\.\d+)$/);
        if (!match) throw diagnosticError("preflight-dependencies");
        return python("python", match[1], bindDependencies);
      }, "preflight-dependencies", ["command-ownership"]);
    }
    if (["android", "device"].includes(group)) {
      await check("android-entry", () => fileIdentity(path.join(root, "scripts", device ? "test-android.ps1" : "build-android.ps1")), "preflight-path");
      const executableName = (name) => process.platform === "win32" ? `${name}.exe` : name;
      await check("jdk", () => once(`jdk:${jdk}:${bindDependencies}`, async () => {
        const java = path.join(jdk, "bin", executableName("java"));
        await access(java, constants.R_OK | constants.X_OK);
        const output = await probe(java, ["-version"]);
        if (!/(?:openjdk|java) version "25(?:\.\d+)*"/.test(output)) throw diagnosticError("preflight-version");
        return { jdk, java: await fileIdentity(java), release: await fileIdentity(path.join(jdk, "release")),
          tree: await treeIdentity(jdk, undefined, { hashFiles: bindDependencies }), version: digest(output) };
      }), "preflight-sdk", ["command-ownership"]);
      await check("android-platform-37.2", () => once(`sdk:${sdk}:${bindDependencies}`, async () => ({
        sdk, platform: await fileIdentity(path.join(sdk, "platforms", "android-37.2", "android.jar")),
        platformMetadata: await fileIdentity(path.join(sdk, "platforms", "android-37.2", "package.xml")),
        license: await fileIdentity(path.join(sdk, "licenses", "android-sdk-license")),
        aapt: await fileIdentity(path.join(sdk, "build-tools", "37.0.0", executableName("aapt2"))),
        zipalign: await fileIdentity(path.join(sdk, "build-tools", "37.0.0", executableName("zipalign"))),
        buildToolsMetadata: await fileIdentity(path.join(sdk, "build-tools", "37.0.0", "package.xml")),
        buildTools: await treeIdentity(path.join(sdk, "build-tools", "37.0.0"), undefined, { hashFiles: bindDependencies }),
      })), "preflight-sdk");
      await check("gradle-wrapper", () => once("gradle-wrapper", async () => ({
        jar: await fileIdentity(path.join(root, "android", "gradle", "wrapper", "gradle-wrapper.jar")),
        properties: await fileIdentity(path.join(root, "android", "gradle", "wrapper", "gradle-wrapper.properties")),
      })), "preflight-sdk");
      await check("android-output", () => writable(root, path.join(root, "android", "app", "build")), "preflight-path");
      if (device) {
        const emulatorSdk = path.resolve(root, process.env.DEVPOCKET_EMULATOR_SDK ?? sdk);
        const architecture = androidImageArchitecture();
        const image = (options.image ?? process.env.DEVPOCKET_ANDROID_IMAGE ??
          `system-images/android-37.0/google_apis/${architecture}`).replaceAll("\\", "/");
        await check("android-image", () => once(`image:${emulatorSdk}:${image}`, async () => {
          if (androidImagePattern.exec(image)?.[1] !== architecture) {
            throw diagnosticError("preflight-sdk");
          }
          const directory = path.join(emulatorSdk, ...image.split("/"));
          const system = await lstat(path.join(directory, "system.img"));
          if (!system.isFile() || system.isSymbolicLink()) throw diagnosticError("preflight-path");
          return { emulatorSdk, image, properties: await fileIdentity(path.join(directory, "source.properties")),
            tree: await treeIdentity(directory, "system.img", { hashFiles: bindDependencies }),
            ...(!bindDependencies ? { imageFile: { size: system.size, mode: system.mode, mtimeMs: system.mtimeMs } } : {}) };
        }), "preflight-sdk");
        await check("adb", () => once(`adb:${emulatorSdk}`, async () => {
          const adb = path.join(emulatorSdk, "platform-tools", executableName("adb"));
          return { binary: await fileIdentity(adb), version: digest(await probe(adb, ["version"])) };
        }), "preflight-sdk", ["command-ownership"]);
        await check("emulator-acceleration", () => once(`emulator:${emulatorSdk}`, async () => {
          const emulator = path.join(emulatorSdk, "emulator", executableName("emulator"));
          const output = await probe(emulator, ["-accel-check"]);
          const acceleration = process.platform === "darwin" ? [JSON.stringify(macOSAcceleration(output))]
            : [...new Set([...output.matchAll(
            /\b((?:KVM|WHPX|HAXM|AEHD|Hypervisor\.Framework|Android Emulator hypervisor driver)[^\r\n]*\bis installed and usable)\.?[ \t]*$/gmi,
          )].map((match) => match[1].trim()))];
          if (acceleration.length !== 1 || process.platform === "linux" && !/^KVM\b/i.test(acceleration[0])) {
            throw diagnosticError("preflight-acceleration");
          }
          const versionOutput = await probe(emulator, ["-version"]);
          const versions = [...new Set([...versionOutput.matchAll(/Android emulator version ([A-Za-z0-9._+-]+)/g)]
            .map((match) => diagnosticVersion(match[1])))];
          if (versions.length !== 1 || !versions[0]) throw diagnosticError("preflight-version");
          const binary = await fileIdentity(emulator);
          const files = await treeInputs(path.join(emulatorSdk, "emulator"), undefined, { hashFiles: bindDependencies });
          const identity = { binary, acceleration: digest(acceleration[0]),
            version: digest(versions[0]), tree: digest(JSON.stringify(files)) };
          options.onEmulatorIdentity?.(structuredClone({ identity, files: bindDependencies ? files : [] }));
          return identity;
        }), "preflight-acceleration", ["command-ownership"]);
      }
    }
    const npmIdentity = identities.find(([name]) => name === "npm")?.[1];
    const candidateSafe = npmIdentity?.candidateSafe === true;
    const unbound = !bindDependencies;
    const blocked = issues.length > 0 || notProbed.length > 0;
    results.push({ group, status: blocked ? "blocked" : "passed", issues, notProbed,
      candidateSafe, reusable: !blocked && !unbound,
      fingerprintKind: blocked ? "unavailable" : unbound ? "readiness" : "environment",
      ...(blocked ? {} : {
        fingerprint: digest(JSON.stringify({ platform: process.platform, arch: process.arch, identities })),
        prerequisites: identities.map(([prerequisite, value]) => ({ prerequisite, fingerprint: digest(JSON.stringify(value)) })),
      }) });
  }
  return { version: 1, status: results.some((item) => item.status !== "passed") ? "blocked" : "passed", groups: results };
}
