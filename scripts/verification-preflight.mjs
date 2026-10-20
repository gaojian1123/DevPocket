import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./process.mjs";
import { readOnlyGit, sourceInputs } from "./git-state.mjs";
import { diagnosticError, diagnosticVersion, failureDetails } from "./diagnostic-errors.mjs";
import { CHECKS } from "./verification-policy.mjs";
import { verificationStorageLocation } from "./verification-run.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const scripts = fileURLToPath(new URL(".", import.meta.url));
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const directNode = (value, kind) => value?.kind === kind && /\.(?:com|exe)$/i.test(value.file) &&
  samePath(value.file, process.execPath) && samePath(value.target, process.execPath);
const policyInputs = [
  "verify.mjs", "verify.ps1", "verification.mjs", "verification-policy.mjs", "verification-executor.mjs", "verification-preflight.mjs",
  "verification-run.mjs", "verification-transition.mjs", "verification-backend.mjs", "verification-android.mjs",
  "test-workflow.mjs", "verification-tooling.mjs", "verification-admission.mjs", "verification-ci.mjs",
  "verification-ci-artifact.ps1", "development-policy.mjs", "development-controller.mjs", "isolated-verification.mjs",
  "candidate-commit.mjs", "native-candidate.mjs", "git-state.mjs", "process.mjs",
  "owned-command-windows.mjs", "owned-command.cs", "owned-command.ps1", "owned-command-linux.py",
  "backend-diagnostics.mjs", "diagnostic-errors.mjs", "diagnostic-publication.mjs", "bounded-worker-log.mjs",
  "device-run.mjs", "worker-diagnostics.mjs", "device-diagnostics.mjs", "native-lifecycle.mjs",
];

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

async function treeInputs(directory, requiredFile) {
  const root = await realpath(directory), files = [], identities = [];
  let count = 0;
  async function visit(current, relative, entry) {
    const info = entry ?? await lstat(current);
    if (++count > 100000) throw diagnosticError("output-limit");
    if (info.isSymbolicLink()) {
      if (entry && !(await lstat(current)).isSymbolicLink()) throw diagnosticError("environment-changed");
      const target = await realpath(current), rel = path.relative(root, target);
      if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ||
          !(await lstat(target)).isFile()) throw diagnosticError("preflight-path");
      files.push({ file: target, relative, target: rel });
    } else if (info.isDirectory()) {
      if (entry) {
        const actual = await lstat(current);
        if (!actual.isDirectory() || actual.isSymbolicLink()) throw diagnosticError("environment-changed");
      }
      const children = (await readdir(current, { withFileTypes: true }))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const child of children) await visit(path.join(current, child.name), path.join(relative, child.name), child);
    } else {
      // fileIdentity still opens and checks every file before and after hashing.
      files.push({ file: current, relative });
    }
  }
  await visit(directory, "");
  if (requiredFile && !files.some(({ relative, target }) => relative === requiredFile && target === undefined)) {
    throw diagnosticError("preflight-path");
  }
  for (let start = 0; start < files.length; start += 16) {
    identities.push(...await Promise.all(files.slice(start, start + 16).map(async ({ file, relative, target }) => {
      const identity = await fileIdentity(file);
      return [relative, target === undefined ? identity : { target, identity }];
    })));
  }
  return identities;
}

async function treeIdentity(directory, requiredFile) {
  return digest(JSON.stringify(await treeInputs(directory, requiredFile)));
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
  const extensions = windows ? shell ? (process.env.PATHEXT ?? "").split(";") : [".com", ".exe"] : [""];
  if (windows && extensions.some((extension) => !/^\.[a-z0-9]+$/i.test(extension))) {
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
        if ((await lstat(resolved)).isFile()) return windows && shell ? file : resolved;
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

async function dependencies(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  if (!Object.keys(declared).length) return { manifest: digest(JSON.stringify(manifest)), installed: null };
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  if (!lock.packages || ![2, 3].includes(lock.lockfileVersion)) throw diagnosticError("preflight-dependencies");
  for (const name of Object.keys(declared)) {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw diagnosticError("preflight-dependencies");
    const installed = JSON.parse(await readFile(path.join(root, "node_modules", name, "package.json"), "utf8"));
    if (installed.version !== lock.packages[`node_modules/${name}`]?.version) throw diagnosticError("preflight-dependencies");
  }
  for (const [name, item] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (!name.startsWith("node_modules/") || name.split("/").some((part) => [".", ".."].includes(part))) {
      throw diagnosticError("preflight-dependencies");
    }
    const applicable = (!item.os || item.os.includes(process.platform) || item.os.every((os) => os.startsWith("!") && os !== `!${process.platform}`)) &&
      (!item.cpu || item.cpu.includes(process.arch));
    if (item.optional && !applicable) continue;
    const installed = JSON.parse(await readFile(path.join(root, name, "package.json"), "utf8"));
    if (installed.version !== item.version) throw diagnosticError("preflight-dependencies");
  }
  return { manifest: digest(JSON.stringify(manifest)), lock: digest(JSON.stringify(lock)),
    installed: await treeIdentity(path.join(root, "node_modules")) };
}

const typecheckInputs = [
  ["node_modules/typescript/bin/tsc", "8d5fa5bd883fec0979fc2004f1fe1d99aef40570155d550eadc0b03b55513bf0"],
  ["node_modules/typescript/lib/tsc.js", "2cffde0b8c6760dfb0b5b0382bbb7e00ba6a8b2d981b9205b256a700a481d983"],
  ["node_modules/typescript/lib/_tsc.js", "1f62c69e832fbbbd05a6dac950f152937f594a4d0b88087be5406ace348efcb5"],
  ["node_modules/typescript/package.json", "ebb0ce176c85ac13ce82f5be7e6f15114732ba0f064ccc893fd9051426d35d3a"],
  ["node_modules/.bin/tsc.cmd", "98ed79f5b1c9abc1e791fc2e39f133264fb2e8278b5f9dce63c299a4790939b4", true],
  ["backend/tsconfig.json", "3ab66fc1027c208e9ef0fcd7ad9728aa7e809e1eefb26736ebb645364e24a5ca", true],
  ["backend/tsconfig.cli-proof.json", "a7654c02f2b9349dbde6e7574190a0072251c4d29edcba6017c5f2a0dbe59037", true],
];

async function typecheckContract(root, inputs, node, npm, commandNode, signal) {
  const unbound = (reason) => ({ status: "unbound", reason });
  if (process.platform !== "win32" || !npm?.candidateSafe ||
      !samePath(node?.child?.file ?? "", process.execPath) ||
      !directNode(commandNode, "native") ||
      !directNode(npm?.powershellNode, "Application") ||
      !samePath(process.env.ComSpec ?? process.env.COMSPEC ?? "",
        path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "", "System32", "cmd.exe")) ||
      !/^\.COM;\.EXE;\.BAT;\.CMD(?:;|$)/i.test(process.env.PATHEXT ?? "") ||
      /development/i.test(process.env.NODE_ENV ?? "")) return unbound("startup-unrecognized");
  if (npm.candidateImplementation !== true) return unbound("npm-unrecognized");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (pkg.scripts?.typecheck !== "tsc -p backend/tsconfig.json --noEmit && tsc -p backend/tsconfig.cli-proof.json" ||
      pkg.scripts.pretypecheck || pkg.scripts.posttypecheck || pkg.devDependencies?.typescript !== "5.8.3") {
    return unbound("command-unrecognized");
  }
  if ((await readdir(root)).some((name) => /^(?:node|tsc)(?:\.[^.]+)?$/i.test(name))) return unbound("command-shadowed");
  for (let directory = path.resolve(root);;) {
    let names;
    try { names = await readdir(path.join(directory, "node_modules", ".bin")); }
    catch (error) { if (error.code !== "ENOENT") throw error; names = []; }
    if (names.some((name) => /^node(?:\.[^.]+)?$/i.test(name) ||
        samePath(directory, root) && /^tsc\.(?:com|exe|bat)$/i.test(name))) return unbound("command-shadowed");
    if (directory === path.dirname(directory)) break;
    directory = path.dirname(directory);
  }
  for (const [relative, expected, text] of typecheckInputs) {
    const file = path.join(root, ...relative.split("/"));
    let bytes;
    try {
      if (!(await lstat(file)).isFile()) return unbound("compiler-unrecognized");
      bytes = await readFile(file);
    } catch (error) { if (error.code === "ENOENT") return unbound("compiler-unrecognized"); throw error; }
    if (digest(text ? bytes.toString("utf8").replaceAll("\r\n", "\n") : bytes) !== expected) {
      return unbound("compiler-unrecognized");
    }
  }
  const sourcePaths = new Set(inputs.filter((entry) => entry[1] !== "deleted")
    .map(([file]) => path.resolve(root, file).toLowerCase()));
  const modules = await realpath(path.join(root, "node_modules")), files = new Set();
  for (const config of ["tsconfig.json", "tsconfig.cli-proof.json"]) {
    let output;
    try {
      output = await runCommand(process.execPath, [path.join(root, "node_modules", "typescript", "lib", "tsc.js"),
        "-p", path.join(root, "backend", config), "--noEmit", "--listFilesOnly", "--pretty", "false"],
      { cwd: root, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" }, signal, timeoutMs: 30000 });
    } catch (error) {
      if (error.processTreeStopped !== true) throw error;
      return { status: "unavailable", failure: failureDetails(error, "preflight-tool") };
    }
    if (Buffer.byteLength(output.stdout) > 256 * 1024) return unbound("inputs-unrecognized");
    const selected = output.stdout.split(/\r?\n/).filter(Boolean);
    if (!selected.length || selected.length > 4096) return unbound("inputs-unrecognized");
    for (const name of selected) {
      if (!path.isAbsolute(name)) return unbound("inputs-unrecognized");
      const file = path.resolve(name), physical = await realpath(file), relative = path.relative(modules, physical);
      const dependency = relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      if (!dependency && (!sourcePaths.has(file.toLowerCase()) || !samePath(file, physical))) {
        return unbound("inputs-unrecognized");
      }
      if (!dependency) {
        for (let directory = path.dirname(file); samePath(directory, root) || directory.startsWith(root + path.sep);
          directory = path.dirname(directory)) {
          const manifest = path.join(directory, "package.json");
          if (await fileIdentity(manifest, { optional: true }) && !sourcePaths.has(manifest.toLowerCase())) {
            return unbound("inputs-unrecognized");
          }
        }
      }
      files.add(path.relative(root, physical));
    }
  }
  return { status: "bound", fingerprint: digest(JSON.stringify([...files].sort())) };
}

export async function verificationExecutionPolicy() {
  return digest(JSON.stringify(await Promise.all(policyInputs.map(async (name) =>
    [name, await fileIdentity(path.join(scripts, name))]))));
}

export async function verificationArtifacts(root, plan, group) {
  const paths = group === "backend" && plan.requiredChecks.includes("backend-build") ? ["dist"]
    : ["android", "device"].includes(group)
      ? ["android/app/build/outputs/apk/debug/app-debug.apk", "android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"] : [];
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
  if (["android", "device"].includes(group)) {
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
    if (process.platform !== "win32") throw diagnosticError("preflight-tool");
    const directory = path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "", "Microsoft.NET", "Framework64", "v4.0.30319");
    return Promise.all(["csc.exe", "csc.exe.config", "csc.rsp", "clr.dll", "mscorlib.dll", "System.Runtime.Serialization.dll"]
      .map((name) => fileIdentity(path.join(directory, name))));
  });
  const powershell = () => once("pwsh", () => tool("pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], (text) => /^7\./.test(text)));
  const npm = () => once("npm", async () => {
    const shell = await powershell();
    const output = JSON.parse(await probe(shell.file, ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; $command=Get-Command npm -CommandType Application,ExternalScript | Select-Object -First 1; " +
      "$nodeCommand=Get-Command node -CommandType Application,ExternalScript | Select-Object -First 1; " +
      "$version=& npm --version; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; " +
      "$lines=@(& npm config get node-options script-shell userconfig globalconfig); if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; " +
      "$settings=@{}; foreach($line in $lines){ " +
      "if($line -notmatch '^(node-options|script-shell|userconfig|globalconfig)=(.*)$'){throw 'Unsupported npm configuration output.'}; " +
      "if($settings.ContainsKey($Matches[1])){throw 'Duplicate npm configuration output.'}; $settings[$Matches[1]]=$Matches[2] }; " +
      "if($settings.Count -ne 4){throw 'Incomplete npm configuration output.'}; " +
      "@{file=$command.Source;nodeFile=$nodeCommand.Source;nodeType=$nodeCommand.CommandType.ToString();version=\"$version\";nodeOptions=$settings['node-options'];scriptShell=$settings['script-shell'];" +
      "userConfig=$settings['userconfig'];globalConfig=$settings['globalconfig']} | ConvertTo-Json -Compress"]));
    if (!/^\d+\.\d+\.\d+$/.test(output.version) || !path.isAbsolute(output.file) || !path.isAbsolute(output.nodeFile) ||
        !["Application", "ExternalScript"].includes(output.nodeType)) {
      throw diagnosticError("preflight-version");
    }
    const nodeFile = path.resolve(output.nodeFile), nodeTarget = await realpath(nodeFile), hostNode = await memo.get("node");
    const powershellNode = { file: nodeFile, target: nodeTarget, kind: output.nodeType,
      binary: samePath(nodeTarget, hostNode.file) ? hostNode.binary : await fileIdentity(nodeTarget) };
    const config = [];
    for (const name of [...new Set([path.join(homedir(), ".npmrc"), output.userConfig, output.globalConfig].filter(Boolean))]) {
      config.push([name, await fileIdentity(name, { optional: true })]);
    }
    const actual = await realpath(output.file);
    const candidates = [path.join(path.dirname(actual), "node_modules", "npm"), path.resolve(path.dirname(actual), "..")];
    let packageIdentity;
    for (const directory of candidates) {
      let value;
      try { value = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (value.name === "npm") {
        packageIdentity = await treeIdentity(directory);
        break;
      }
    }
    if (!packageIdentity) throw diagnosticError("preflight-tool");
    const binary = await fileIdentity(actual);
    const candidateSafe = ["", "null"].includes(output.nodeOptions) && ["", "null"].includes(output.scriptShell) &&
      !process.execArgv.some((value) => /^--(?:import|require|loader|experimental-loader)(?:=|$)|^-r$/.test(value)) &&
      !Object.entries(process.env).some(([name, value]) =>
        /^(?:NODE_OPTIONS|NODE_PATH|NPM_CONFIG_NODE_OPTIONS|NPM_CONFIG_SCRIPT_SHELL)$/i.test(name) && value);
    let candidateImplementation = process.platform === "win32" && candidateSafe && output.version === "11.16.0" &&
      samePath(path.resolve(output.file), actual) &&
      packageIdentity === "0f3af07d0eef7aeeeadb0efc710993da57bdbfacd9edbfc3cde3fd63a0a4206a" &&
      ["e8aedc8c76d6cb9423b70ede071228f7cb1644094c114b8721ae6d121100d4fe",
        "3bf7c5ef339b71d6f8bc4ef4a7b7adb90727788674f0a3cef2ede8f5969ca327"].includes(binary.sha256);
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
    return { version: output.version, file: output.file, binary, packageIdentity, config,
      candidateImplementation, candidateSafe, prefixResolution, powershellNode };
  });
  const python = (file, requirements) => once(`python:${file}:${requirements ?? ""}`, async () => {
    const program = path.isAbsolute(file) ? file : await resolveVerificationExecutable(root, file);
    const script = "import sys,json,importlib.metadata as m,hashlib\n" +
      "if sys.version_info < (3,12): raise RuntimeError('Python 3.12 or newer is required')\n" +
      "result={'version':list(sys.version_info[:3]),'executable':sys.executable}\n" +
      (requirements ? "import cryptography.hazmat.primitives.asymmetric.rsa\n" +
        `if m.version('cryptography') != ${JSON.stringify(requirements)}: raise RuntimeError('cryptography version does not match the declared pin')\n` +
        "h=hashlib.sha256()\n" +
        "for name in ('cryptography','cffi','pycparser'):\n" +
        " try: d=m.distribution(name)\n" +
        " except m.PackageNotFoundError:\n" +
        "  if name=='cryptography': raise\n" +
        "  continue\n" +
        " for f in sorted(d.files or []):\n" +
        "  if str(f).endswith('.pyc'): continue\n" +
        "  p=d.locate_file(f)\n" +
        "  if p.is_file(): h.update(str(f).encode());h.update(p.read_bytes())\n" +
        "result['dependencies']=h.hexdigest()\n" : "") +
      "print(json.dumps(result))";
    const output = JSON.parse(await probe(program, ["-B", "-c", script]));
    return { ...output, binary: await fileIdentity(await realpath(program)) };
  });
  const results = [];
  for (const group of groups) {
    const identities = [], issues = [];
    const check = async (prerequisite, operation, reason = "preflight-tool") => {
      try { identities.push([prerequisite, await operation()]); }
      catch (error) {
        issues.push({ prerequisite, failure: failureDetails(error, reason) });
      }
    };
    const has = (id) => selected.some((item) => item.group === group && item.id === id);
    await check("node", () => once("node", async () => {
      if (!/^v24\./.test(process.version)) throw diagnosticError("preflight-version");
      return { version: process.version, file: process.execPath, binary: await fileIdentity(process.execPath),
        child: await tool("node", ["--version"], (text) => /^v24\./.test(text)) };
    }));
    await check("command-ownership", owner);
    if (!issues.length) await check("powershell", powershell);
    await check("output-directory", () => writable(root, options.directory), "preflight-path");
    const usesNpm = ["tooling", "backend", "device"].includes(group);
    if (usesNpm) {
      await check("root-dependencies", () => once("root-dependencies", () => dependencies(root)), "preflight-dependencies");
      if (!issues.length) await check("npm", npm);
      if (!issues.length) await check("node-command", () => once("node-command", async () => {
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
        if (!/^v24\./.test(output)) throw diagnosticError("preflight-version");
        return { file, target, kind, binary, output: digest(output) };
      }));
      identities.push(["node-environment", environment(/^(?:NODE_.*|TSX_.*|TS_NODE_.*|NPM_CONFIG_.*|PATH|COMSPEC|PATHEXT|NODEFAULTCURRENTDIRECTORYINEXEPATH|SHELL|SYSTEMROOT|WINDIR|CI|TZ|LANG|LC_.*)$/i)]);
    }
    if (has("typecheck") && !issues.length) {
      await check("typecheck-contract", () => typecheckContract(root, inputs,
        identities.find(([name]) => name === "node")?.[1], identities.find(([name]) => name === "npm")?.[1],
        identities.find(([name]) => name === "node-command")?.[1], options.signal));
    }
    if (has("backend-build")) await check("backend-output", () => writable(root, path.join(root, "dist")), "preflight-path");
    if (group === "tooling" || has("backend-tests")) {
      if (!issues.length) {
        await check("git", () => once("git", async () => ({
          tool: await tool("git", ["--version"], (text) => /^git version 2\.(?:3[4-9]|[4-9]\d|\d{3,})\./.test(text)),
          configuration: digest(await readOnlyGit(root, ["config", "--null", "--list", "--show-origin", "--show-scope"])),
          branch: (await readOnlyGit(root, ["rev-parse", "--symbolic-full-name", "HEAD"])).trim(),
        })));
      }
    }
    if (group === "tooling") {
      if (!issues.length) {
        await check("ssh-keygen", () => once("ssh-keygen", async () => {
          const file = await resolveVerificationExecutable(root, "ssh-keygen");
          return { file, binary: await fileIdentity(file) };
        }));
      }
    }
    if (group === "tooling" || has("setup") || has("operations-tests")) {
      if (!issues.length) await check("python", () => python("python"));
      identities.push(["python-environment", environment(/^(?:PYTHON.*|VIRTUAL_ENV)$/i)]);
    }
    if (has("azure-tests")) {
      const azure = path.join(root, "deployment", "azure");
      await check("azure-dependencies", () => once("azure-dependencies", () => dependencies(azure)), "preflight-dependencies");
      await check("probe-python", async () => {
        const requirements = await readFile(path.join(azure, "probe", "requirements-test.txt"), "utf8");
        const match = requirements.trim().match(/^cryptography==(\d+\.\d+\.\d+)$/);
        if (!match) throw diagnosticError("preflight-dependencies");
        const file = process.env.DEVPOCKET_PROBE_PYTHON ??
          path.join(root, ".tools", "probe-python", process.platform === "win32" ? "Scripts" : "bin",
            process.platform === "win32" ? "python.exe" : "python");
        return python(file, match[1]);
      }, "preflight-dependencies");
    }
    if (has("operations-tests")) {
      await check("operations-python", async () => {
        const requirements = await readFile(path.join(root, "deployment", "azure", "probe", "requirements-test.txt"), "utf8");
        const match = requirements.trim().match(/^cryptography==(\d+\.\d+\.\d+)$/);
        if (!match) throw diagnosticError("preflight-dependencies");
        return python("python", match[1]);
      }, "preflight-dependencies");
    }
    if (["android", "device"].includes(group)) {
      const device = group === "device";
      await check("android-entry", () => fileIdentity(path.join(root, "scripts", device ? "test-android.ps1" : "build-android.ps1")), "preflight-path");
      const jdk = path.resolve(root, options.jdk ?? (device ? process.env.DEVPOCKET_JDK : undefined) ?? path.join(".tools", "jdk-21"));
      const sdk = path.resolve(root, options.sdk ?? (device ? process.env.DEVPOCKET_ANDROID_SDK : undefined) ?? path.join(".tools", "android-sdk"));
      const cacheDirectory = device && process.platform === "linux" && process.env.GITHUB_ACTIONS === "true" &&
        process.env.RUNNER_ENVIRONMENT === "github-hosted" ? path.join(options.directory, "device", "gradle-cache")
        : path.join(root, ".tools", "gradle-cache");
      const executableName = (name) => process.platform === "win32" ? `${name}.exe` : name;
      await check("jdk", () => once(`jdk:${jdk}`, async () => {
        const java = path.join(jdk, "bin", executableName("java"));
        await access(java, constants.R_OK | constants.X_OK);
        const output = await probe(java, ["-version"]);
        if (!/(?:openjdk|java) version "(?:17|21)\./.test(output)) throw diagnosticError("preflight-version");
        return { jdk, java: await fileIdentity(java), release: await fileIdentity(path.join(jdk, "release")),
          tree: await treeIdentity(jdk), version: digest(output) };
      }), "preflight-sdk");
      await check("android-platform-35", () => once(`sdk:${sdk}`, async () => ({
        sdk, platform: await fileIdentity(path.join(sdk, "platforms", "android-35", "android.jar")),
        platformMetadata: await fileIdentity(path.join(sdk, "platforms", "android-35", "package.xml")),
        license: await fileIdentity(path.join(sdk, "licenses", "android-sdk-license")),
        aapt: await fileIdentity(path.join(sdk, "build-tools", "35.0.0", executableName("aapt2"))),
        zipalign: await fileIdentity(path.join(sdk, "build-tools", "35.0.0", executableName("zipalign"))),
        buildToolsMetadata: await fileIdentity(path.join(sdk, "build-tools", "35.0.0", "package.xml")),
        buildTools: await treeIdentity(path.join(sdk, "build-tools", "35.0.0")),
      })), "preflight-sdk");
      await check("gradle-wrapper", () => once("gradle-wrapper", async () => ({
        jar: await fileIdentity(path.join(root, "android", "gradle", "wrapper", "gradle-wrapper.jar")),
        properties: await fileIdentity(path.join(root, "android", "gradle", "wrapper", "gradle-wrapper.properties")),
      })), "preflight-sdk");
      await check("android-output", () => writable(root, path.join(root, "android", "app", "build")), "preflight-path");
      await check("gradle-cache", async () => {
        const directory = cacheDirectory;
        await writable(root, directory);
        let initDirectory = null;
        try { initDirectory = await treeIdentity(path.join(directory, "init.d")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        return { properties: await fileIdentity(path.join(directory, "gradle.properties"), { optional: true }),
          init: await fileIdentity(path.join(directory, "init.gradle"), { optional: true }),
          initKotlin: await fileIdentity(path.join(directory, "init.gradle.kts"), { optional: true }), initDirectory };
      }, "preflight-path");
      await check("native-configuration", () => nativeConfiguration(root, jdk, sdk, cacheDirectory), "preflight-sdk");
      identities.push(["java-environment", environment(/^(?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GRADLE_OPTS|JAVA_OPTS|ORG_GRADLE_PROJECT_.*)$/i)]);
      if (device) {
        const emulatorSdk = path.resolve(root, process.env.DEVPOCKET_EMULATOR_SDK ?? sdk);
        const image = (options.image ?? process.env.DEVPOCKET_ANDROID_IMAGE ??
          "system-images/android-35/google_apis/x86_64").replaceAll("\\", "/");
        await check("android-image", () => once(`image:${emulatorSdk}:${image}`, async () => {
          if (!/^system-images\/android-\d+(?:\.\d+)?\/(?:google_apis(?:_playstore)?|default)\/x86_64$/.test(image)) {
            throw diagnosticError("preflight-sdk");
          }
          const directory = path.join(emulatorSdk, ...image.split("/"));
          return { emulatorSdk, image, properties: await fileIdentity(path.join(directory, "source.properties")),
            tree: await treeIdentity(directory, "system.img") };
        }), "preflight-sdk");
        await check("adb", () => once(`adb:${emulatorSdk}`, async () => {
          const adb = path.join(emulatorSdk, "platform-tools", executableName("adb"));
          return { binary: await fileIdentity(adb), version: digest(await probe(adb, ["version"])) };
        }), "preflight-sdk");
        await check("emulator-acceleration", () => once(`emulator:${emulatorSdk}`, async () => {
          const emulator = path.join(emulatorSdk, "emulator", executableName("emulator"));
          const output = await probe(emulator, ["-accel-check"]);
          const acceleration = [...new Set([...output.matchAll(
            /\b((?:KVM|WHPX|HAXM|AEHD|Hypervisor\.Framework|Android Emulator hypervisor driver)[^\r\n]*\bis installed and usable)\.?[ \t]*$/gmi,
          )].map((match) => match[1].trim()))];
          if (acceleration.length !== 1 || process.platform === "linux" && !/^KVM\b/i.test(acceleration[0])) {
            throw diagnosticError("preflight-acceleration");
          }
          const versionOutput = await probe(emulator, ["-version"]);
          const versions = [...new Set([...versionOutput.matchAll(/Android emulator version ([A-Za-z0-9._+-]+)/g)]
            .map((match) => diagnosticVersion(match[1])))];
          if (versions.length !== 1 || !versions[0]) throw diagnosticError("preflight-version");
          const binary = await fileIdentity(emulator), files = await treeInputs(path.join(emulatorSdk, "emulator"));
          const identity = { binary, acceleration: digest(acceleration[0]),
            version: digest(versions[0]), tree: digest(JSON.stringify(files)) };
          options.onEmulatorIdentity?.(structuredClone({ identity, files }));
          return identity;
        }), "preflight-acceleration");
      }
    }
    const npmIdentity = identities.find(([name]) => name === "npm")?.[1];
    const candidateSafe = npmIdentity?.candidateSafe === true;
    const injected = (pattern) => Object.entries(process.env).some(([name, value]) => value && pattern.test(name));
    const java = ["android", "device"].includes(group), cache = identities.find(([name]) => name === "gradle-cache")?.[1];
    const unbound = sourceHasLinks || usesNpm &&
      (!candidateSafe || npmIdentity?.candidateImplementation !== true || injected(/^(?:TSX_|TS_NODE_)/i) ||
        !samePath(identities.find(([name]) => name === "node")?.[1]?.child?.file ?? "", process.execPath) ||
        !directNode(identities.find(([name]) => name === "node-command")?.[1], "native") ||
        !directNode(npmIdentity?.powershellNode, "Application")) ||
      (group === "tooling" || has("setup") || has("operations-tests") || has("azure-tests")) &&
        injected(/^(?:PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONUSERBASE)$/i) ||
      java && (injected(/^(?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GRADLE_OPTS|JAVA_OPTS)$/i) ||
        cache?.init || cache?.initKotlin || cache?.initDirectory ||
        identities.find(([name]) => name === "native-configuration")?.[1]?.reusable !== true);
    results.push({ group, status: issues.length ? "blocked" : "passed", issues,
      candidateSafe, reusable: !issues.length && !unbound,
      ...(has("typecheck") ? { candidateEligibility: identities.find(([name]) => name === "typecheck-contract")?.[1] ??
        { status: "unavailable", reason: "prerequisites-blocked" } } : {}),
      ...(issues.length ? {} : {
        fingerprint: digest(JSON.stringify({ platform: process.platform, arch: process.arch, identities })),
        prerequisites: identities.map(([prerequisite, value]) => ({ prerequisite, fingerprint: digest(JSON.stringify(value)) })),
      }) });
  }
  return { version: 1, status: results.some((item) => item.status !== "passed") ? "blocked" : "passed", groups: results };
}
