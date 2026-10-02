import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.resolve(process.argv[2] ?? "");
const allowed = path.resolve(".data");
if (!directory.startsWith(allowed + path.sep)) throw new Error("The wait probe only writes under this workspace's .data directory.");
await mkdir(directory, { recursive: true });
const child = process.argv[3] === "child";
if (child) {
  const timer = setInterval(() => void writeFile(path.join(directory, "heartbeat.txt"), String(Date.now())), 500);
  setTimeout(() => { clearInterval(timer); process.exit(0); }, 180_000);
} else {
  const processChild = spawn(process.execPath, [fileURLToPath(import.meta.url), directory, "child"],
    { stdio: "inherit", windowsHide: true, cwd: process.cwd() });
  await writeFile(path.join(directory, "pids.local.json"), JSON.stringify({
    parentPid: process.pid, childPid: processChild.pid, startedAt: new Date().toISOString(),
  }));
  console.log("DP_SHELL_WAIT_STARTED");
  processChild.once("exit", (code) => process.exit(code ?? 0));
}
