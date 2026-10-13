import { lstat, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

export async function cleanDeviceRun(root, directory, runId, { cacheOnly = false } = {}) {
  if (typeof cacheOnly !== "boolean") throw new Error("Unknown device cleanup mode.");
  root = path.resolve(root);
  directory = path.resolve(directory);
  const relative = path.relative(root, directory);
  if (!relative.startsWith(`.data${path.sep}`) || relative.split(path.sep).includes("..")) {
    throw new Error("Device cleanup is restricted to an owned checkout-local run.");
  }
  let owner;
  try { owner = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") {
      if (cacheOnly) throw new Error("Build cache cleanup requires an existing owner record.");
      return false;
    }
    throw error;
  }
  const canonical = await realpath(directory);
  if (owner.version !== 1 || owner.root !== root || owner.runId !== runId || !Number.isInteger(owner.pid) ||
      !/^[a-f0-9-]{36}$/.test(owner.runId) ||
      (process.platform === "win32" ? canonical.toLowerCase() !== directory.toLowerCase() : canonical !== directory)) {
    throw new Error("Device cleanup ownership cannot be verified.");
  }
  const names = cacheOnly ? ["gradle-cache"] : ["fixture", "fixture.local.json", "avd", "home", "emulator-home", "gradle-cache"];
  for (const name of names) {
    const target = path.join(directory, name);
    try {
      const info = await lstat(target);
      await rm(target, { recursive: info.isDirectory() && !info.isSymbolicLink(), force: true });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return true;
}
