import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { HostConfig } from "./bridge.js";
import { VERSION } from "./protocol.js";
import { Fault } from "./security.js";

const installation = z.object({
  name: z.literal("devpocket"), scope: z.literal("user"), schemaVersion: z.literal(1), version: z.string(),
}).strict();
const managedFiles = new Set([
  "extension.mjs", "bridge.mjs", "connection.local.json", ".gitignore", "installation.json",
]);

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function contains(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function existingInstallation(target: string): Promise<boolean> {
  const info = await lstat(target).catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw error;
  });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Fault("UNMANAGED_EXTENSION", "The user extension target must be a regular DevPocket installation directory.");
  for (const name of await readdir(target)) {
    const entry = await lstat(path.join(target, name));
    if (!managedFiles.has(name) || !entry.isFile() || entry.isSymbolicLink())
      throw new Fault("INSTALLATION_CHANGED", "The extension directory contains additional files or links. Preserve them before updating.");
  }
  const marker = await readFile(path.join(target, "installation.json"), "utf8").catch((error: unknown) => {
    if (missing(error)) throw new Fault("UNMANAGED_EXTENSION", "An unmanaged devpocket extension already exists. It was not changed.");
    throw error;
  });
  let metadata: unknown;
  try { metadata = JSON.parse(marker); }
  catch (error) {
    if (error instanceof SyntaxError)
      throw new Fault("UNMANAGED_EXTENSION", "The existing installation marker is invalid. Its files were not changed.");
    throw error;
  }
  if (!installation.safeParse(metadata).success)
    throw new Fault("UNMANAGED_EXTENSION", "The existing extension is not a managed DevPocket user installation.");
  return true;
}

export function userExtensionDirectory(configDirectory = process.env.COPILOT_HOME || path.join(homedir(), ".copilot")): string {
  if (!path.isAbsolute(configDirectory))
    throw new Fault("COPILOT_HOME_INVALID", "COPILOT_HOME must be an absolute path matching the CLI's configuration directory.");
  return path.join(path.resolve(configDirectory), "extensions", "devpocket");
}

export async function inspectUserExtension(configDirectory?: string): Promise<{ target: string; installed: boolean }> {
  const target = userExtensionDirectory(configDirectory);
  return { target, installed: await existingInstallation(target) };
}

export async function installUserExtension(source: string, hostConfigPath: string,
  configDirectory?: string): Promise<{ target: string; updated: boolean }> {
  const target = userExtensionDirectory(configDirectory);
  const configPath = path.resolve(hostConfigPath);
  const config = HostConfig.parse(JSON.parse(await readFile(configPath, "utf8")));
  if (!path.isAbsolute(config.dataDir))
    throw new Fault("PRIVATE_DIRECTORY_REQUIRED", "User-wide installation requires an absolute dataDir in the host configuration.");
  if (contains(target, configPath) || contains(target, config.dataDir))
    throw new Fault("PRIVATE_DIRECTORY_REQUIRED", "Keep the host configuration and bridge data outside the extension installation directory.");
  const contents = new Map<string, string | Buffer>();
  for (const name of ["extension.mjs", "bridge.mjs"]) {
    const file = path.join(source, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Fault("INVALID_EXTENSION_BUNDLE", "Extension bundles must contain regular extension.mjs and bridge.mjs files.");
    contents.set(name, await readFile(file));
  }
  contents.set("connection.local.json", JSON.stringify({ hostConfigPath: configPath }, null, 2) + "\n");
  contents.set(".gitignore", "*.local.json\n");
  contents.set("installation.json", JSON.stringify({
    name: "devpocket", scope: "user", schemaVersion: 1, version: VERSION,
  }, null, 2) + "\n");
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const lockPath = path.join(parent, ".devpocket-install.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Fault("INSTALL_BUSY", `Another or interrupted installation owns ${lockPath}. Check it before retrying.`);
    throw error;
  });
  let stage: string | undefined;
  let preserveRecovery = false;
  try {
    const updated = await existingInstallation(target);
    stage = await mkdtemp(path.join(parent, ".devpocket-install-"));
    const prepared = path.join(stage, "prepared"), previous = path.join(stage, "previous");
    await mkdir(prepared);
    for (const [name, content] of contents)
      await writeFile(path.join(prepared, name), content, { flag: "wx", mode: name.endsWith(".local.json") ? 0o600 : 0o644 });
    if (updated) await rename(target, previous);
    try { await rename(prepared, target); }
    catch (error) {
      if (updated) {
        try { await rename(previous, target); }
        catch (restoreError) {
          preserveRecovery = true;
          throw new Fault("INSTALL_RECOVERY_REQUIRED",
            `Installation failed and its previous files remain at ${previous}. Restore them before retrying. ` +
            `Recovery failed: ${restoreError instanceof Error ? restoreError.message : "unknown filesystem error"}`);
        }
      }
      throw error;
    }
    return { target, updated };
  } finally {
    await lock.close();
    await rm(lockPath);
    if (stage && !preserveRecovery) await rm(stage, { recursive: true });
  }
}
