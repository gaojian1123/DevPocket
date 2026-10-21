import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const scriptFile = fileURLToPath(import.meta.url);
const templateFile = fileURLToPath(new URL("../config/xcode-mcp.example.json", import.meta.url));
const installationName = "devpocket-xcode-mcp";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const quoteShell = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function git(cwd, args, optional = false) {
  try {
    const result = await execute("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
      { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
    return result.stdout.replace(/\r?\n$/, "");
  } catch (error) {
    if (optional && error.code === 1) return undefined;
    throw error;
  }
}

async function regularFile(file) {
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile()) throw new Error(`Refusing non-regular file: ${file}`);
  return { bytes: await readFile(file), mode: info.mode & 0o777 };
}

async function directory(file, create = false) {
  try {
    if (!(await lstat(file)).isDirectory()) throw new Error(`Refusing non-directory or symlink: ${file}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (create) await mkdir(file);
  }
}

async function ownedStaging(file, identity) {
  const current = await lstat(file, { bigint: true });
  if (!identity || !current.isDirectory() || current.isSymbolicLink() ||
      ["dev", "ino", "birthtimeNs"].some((key) => current[key] !== identity[key])) {
    throw new Error("Xcode MCP staging directory changed; it was preserved.");
  }
}

// The installed Git-local snapshot must remain self-contained.
async function publish(staging, installed, identity) {
  for (let attempt = 0; ; attempt++) {
    await ownedStaging(staging, identity);
    let present = true;
    try { await lstat(installed); }
    catch (error) { if (error.code !== "ENOENT") throw error; present = false; }
    if (present) throw new Error("Xcode MCP publication destination appeared; it was not overwritten.");
    try { await rename(staging, installed); return; }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(error.code) || attempt === 3) throw error;
      await delay(100);
    }
  }
}

function parseObject(bytes, label) {
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${label} must contain valid UTF-8 JSON; it was not changed.`); }
  if (!object(value)) throw new Error(`${label} must contain a JSON object; it was not changed.`);
  return value;
}

async function xcodeTemplate() {
  const file = await regularFile(templateFile);
  if (!file) throw new Error(`Missing Xcode MCP template: ${templateFile}`);
  const template = parseObject(file.bytes, "Xcode MCP template");
  if (!object(template.mcpServers) || Object.keys(template.mcpServers).join() !== "xcode" ||
      !object(template.mcpServers.xcode)) throw new Error("The template must define only mcpServers.xcode.");
  return { bytes: file.bytes, server: template.mcpServers.xcode };
}

export async function discoverMcpbridge(run = execute) {
  let result;
  try {
    result = await run("/usr/bin/xcrun", ["--find", "mcpbridge"],
      { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
  } catch (error) {
    if (error.code === "ENOENT" || (Number.isInteger(error.code) && !error.killed)) {
      return { available: false, reason: "mcpbridge is unavailable in the active Xcode developer directory." };
    }
    throw error;
  }
  const executable = result.stdout.trim();
  if (!path.isAbsolute(executable)) throw new Error("xcrun returned an invalid mcpbridge path.");
  try {
    if (!(await lstat(executable)).isFile()) throw new Error("mcpbridge is not a regular executable.");
    await access(executable, constants.X_OK);
  } catch (error) {
    if (["ENOENT", "EACCES"].includes(error.code)) {
      return { available: false, reason: "The selected mcpbridge executable is missing or not executable." };
    }
    throw error;
  }
  return { available: true };
}

async function eligibility(platform, probe) {
  if (platform !== "darwin") return { status: "skipped", reason: "Xcode MCP is only configured on macOS." };
  const result = await probe();
  if (!result.available) return { status: "skipped", reason: result.reason };
}

async function repository(cwd) {
  return {
    root: await git(cwd, ["rev-parse", "--show-toplevel"]),
    common: await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  };
}

async function requireLocalConfig(root) {
  if (await git(root, ["ls-files", "--", ".mcp.json", ".mcp.json.lock"])) {
    throw new Error(".mcp.json or its lock is tracked. Move shared definitions to .github/mcp.json before local initialization.");
  }
}

async function requireIgnoredConfig(root) {
  for (const name of [".mcp.json", ".mcp.json.lock"]) {
    if (await git(root, ["check-ignore", "--no-index", "--quiet", "--", name], true) === undefined) {
      throw new Error(`${name} is not effectively ignored. Review conflicting .gitignore rules and the local installation before retrying.`);
    }
  }
}

function mergeConfig(current, server) {
  const config = current ? parseObject(current.bytes, ".mcp.json") : { mcpServers: {} };
  const servers = Object.hasOwn(config, "mcpServers") ? config.mcpServers : config;
  if (!object(servers)) throw new Error(".mcp.json mcpServers must be an object; it was not changed.");
  if (Object.hasOwn(servers, "xcode")) {
    if (!isDeepStrictEqual(servers.xcode, server)) {
      throw new Error(".mcp.json already has a different xcode definition; review it before initializing.");
    }
    return undefined;
  }
  servers.xcode = server;
  return Buffer.from(JSON.stringify(config, null, 2) + "\n");
}

async function updateFile(file, transform) {
  const lockPath = `${file}.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another update may be active. Inspect the retained lock before retrying: ${lockPath}`);
    throw error;
  }
  let published = false;
  try {
    const current = await regularFile(file);
    const bytes = transform(current);
    if (!bytes) return false;
    await lock.writeFile(bytes);
    await lock.chmod(current?.mode ?? 0o600);
    await lock.close();
    const latest = await regularFile(file);
    if (!isDeepStrictEqual(current, latest)) throw new Error(`File changed during initialization; retry after saving: ${file}`);
    await rename(lockPath, file);
    published = true;
    return true;
  } finally {
    await lock.close();
    if (!published) await unlink(lockPath);
  }
}

async function configure(root, server) {
  await requireLocalConfig(root);
  await requireIgnoredConfig(root);
  const changed = await updateFile(path.join(root, ".mcp.json"), (current) => mergeConfig(current, server));
  return { status: changed ? "configured" : "unchanged", file: path.join(root, ".mcp.json") };
}

export async function syncXcodeMcp({ cwd = process.cwd(), platform = process.platform, probe = discoverMcpbridge } = {}) {
  const skipped = await eligibility(platform, probe);
  if (skipped) return skipped;
  const { root } = await repository(cwd);
  return configure(root, (await xcodeTemplate()).server);
}

export async function installXcodeMcp({ cwd = process.cwd(), platform = process.platform, probe = discoverMcpbridge } = {}) {
  const skipped = await eligibility(platform, probe);
  if (skipped) return skipped;
  const { root, common } = await repository(cwd);
  const template = await xcodeTemplate();
  await requireLocalConfig(root);
  mergeConfig(await regularFile(path.join(root, ".mcp.json")), template.server);
  if (await git(root, ["config", "--get", "core.hooksPath"], true) !== undefined) {
    throw new Error("core.hooksPath is already configured. Keep it and integrate the sync command with its owner instead.");
  }
  const hooks = path.join(common, "hooks"), info = path.join(common, "info");
  const installed = path.join(common, installationName);
  const hookFile = path.join(hooks, "post-checkout");
  const hook = Buffer.from([
    "#!/bin/sh",
    "# DevPocket Xcode MCP: repository-local, approved installation snapshot.",
    'case "$(uname -s)" in',
    `  Darwin) exec ${quoteShell(process.execPath)} ${quoteShell(path.join(installed, "scripts/setup-xcode-mcp.mjs"))} sync ;;`,
    "  *) exit 0 ;;",
    "esac", "",
  ].join("\n"));
  await directory(hooks);
  await directory(info);
  await directory(installed);
  const previousHook = await regularFile(hookFile);
  if (previousHook && !previousHook.bytes.equals(hook)) {
    throw new Error(`An existing post-checkout hook was preserved: ${hookFile}. Integrate sync with its owner instead.`);
  }
  if (previousHook) await access(hookFile, constants.X_OK);
  const script = await regularFile(scriptFile);
  const copies = [
    ["scripts/setup-xcode-mcp.mjs", script.bytes],
    ["config/xcode-mcp.example.json", template.bytes],
  ];
  let installedExists = false;
  try { await lstat(installed); installedExists = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (installedExists) {
    for (const [name, bytes] of copies) {
      await directory(path.dirname(path.join(installed, name)));
      const previous = await regularFile(path.join(installed, name));
      if (!previous?.bytes.equals(bytes)) {
        throw new Error(`The installed snapshot differs; review and remove that installation before replacing it: ${installed}`);
      }
    }
  } else {
    const staging = await mkdtemp(path.join(common, `${installationName}-`));
    let identity;
    try {
      identity = await lstat(staging, { bigint: true });
      await ownedStaging(staging, identity);
      await mkdir(path.join(staging, "scripts"));
      await mkdir(path.join(staging, "config"));
      for (const [name, bytes] of copies) await writeFile(path.join(staging, name), bytes, { flag: "wx", mode: 0o600 });
      await publish(staging, installed, identity);
    } catch (error) {
      try {
        await ownedStaging(staging, identity);
        await rm(staging, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Xcode MCP publication and its scratch cleanup failed.");
      }
      throw error;
    }
  }
  await directory(info, true);
  await updateFile(path.join(info, "exclude"), (current) => {
    const lines = current?.bytes.toString("utf8").split(/\r?\n/) ?? [];
    const missing = ["/.mcp.json", "/.mcp.json.lock"].filter((line) => !lines.includes(line));
    if (!missing.length) return undefined;
    return Buffer.concat([current?.bytes ?? Buffer.alloc(0),
      Buffer.from(`${current?.bytes.length && !current.bytes.toString("utf8").endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`)]);
  });
  await configure(root, template.server);
  await directory(hooks, true);
  if (!previousHook) await writeFile(hookFile, hook, { flag: "wx", mode: 0o700 });
  return { status: "installed", file: path.join(root, ".mcp.json"), hook: hookFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  try {
    const [action, ...extra] = process.argv.slice(2);
    if (extra.length || !["install", "sync"].includes(action)) {
      throw new Error("Usage: node scripts/setup-xcode-mcp.mjs <install|sync>");
    }
    const result = await (action === "install" ? installXcodeMcp() : syncXcodeMcp());
    console.log(`[DevPocket Xcode MCP] ${result.status}: ${result.reason ?? result.hook ?? result.file}`);
  } catch (error) {
    console.error(`[DevPocket Xcode MCP] ${error.message}`);
    process.exitCode = 1;
  }
}
