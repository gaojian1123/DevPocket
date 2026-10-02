import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { requireValue } from "./handoff.mjs";

const exec = promisify(execFile);

export async function exists(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

export async function readJson(file) {
  const info = await lstat(file);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024, "SETUP_STATE_FILE_INVALID");
  return JSON.parse(await readFile(file, "utf8"));
}

export async function saveJson(file, value) {
  const temporary = `${file}.${randomUUID()}.pending`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) { await unlink(temporary); throw error; }
  try { await rename(temporary, file); }
  catch (error) { await unlink(temporary); throw error; }
}

export async function savePrivate(file, content) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
}

export async function protectDirectory(directory, script, create) {
  requireValue(process.platform === "win32" && path.isAbsolute(directory), "WINDOWS_PRIVATE_STORAGE_REQUIRED");
  if (create) await mkdir(path.dirname(directory), { recursive: true });
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-Directory", directory];
  if (!create) args.push("-CheckOnly");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  try {
    const result = await exec("powershell.exe", args, { env, encoding: "utf8", windowsHide: true, timeout: 20_000 });
    requireValue(JSON.parse(result.stdout).protected === true, "PRIVATE_DIRECTORY_ACL_FAILED");
  } catch {
    throw new Error("PRIVATE_DIRECTORY_ACL_FAILED: Setup requires a private directory owned by the current Windows user and SYSTEM.");
  }
}

export async function lockDirectory(directory) {
  const file = path.join(directory, "setup.lock");
  let lock;
  try { lock = await open(file, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`SETUP_BUSY: Another or interrupted setup owns ${file}. Verify no setup is running before removing this specific lock; retain state.json and keys.`);
    throw error;
  }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); }
  catch (error) { await lock.close(); await unlink(file); throw error; }
  return async () => { await lock.close(); await unlink(file); };
}
