import { lstat, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

export async function cleanDeviceRun(root, directory, runId) {
  root = path.resolve(root);
  directory = path.resolve(directory);
  const relative = path.relative(root, directory);
  if (!relative.startsWith(`.data${path.sep}`) || relative.split(path.sep).includes("..")) {
    throw new Error("Device cleanup is restricted to an owned checkout-local run.");
  }
  let owner;
  try { owner = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (owner.version !== 1 || owner.root !== root || owner.runId !== runId || !Number.isInteger(owner.pid) ||
      !/^[a-f0-9-]{36}$/.test(owner.runId) ||
      (await realpath(directory)).toLowerCase() !== directory.toLowerCase()) {
    throw new Error("Device cleanup ownership cannot be verified.");
  }
  for (const name of ["fixture", "fixture.local.json", "avd", "home", "emulator-home"]) {
    const target = path.join(directory, name);
    try {
      const info = await lstat(target);
      await rm(target, { recursive: info.isDirectory() && !info.isSymbolicLink(), force: true });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
