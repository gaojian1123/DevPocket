import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { runCommand } from "../process.mjs";

const exec = promisify(execFile);

test("successful owned commands expose the cleanup receipt before callers reclaim scratch data", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('completed')"], { timeoutMs: 5000 });
  assert.equal(result.stdout, "completed");
  assert.equal(result.processTreeStopped, true);
});

test("an exited launcher cannot strand a descendant or keep a bounded command unresolved", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/process-owner-"));
  const pidFile = path.join(directory, "child.pid");
  let pid;
  t.after(async () => {
    try { pid ??= Number(await readFile(pidFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (pid) await exec("pwsh", ["-NoProfile", "-Command",
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Stop-Process -Id ${pid} -Force }`]);
    await rm(directory, { recursive: true, force: true });
  });
  const program = [
    "const {spawn}=require('node:child_process'); const fs=require('node:fs');",
    "const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit',detached:true});",
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.exit(0);`,
  ].join("\n");
  let timer;
  const outcome = await Promise.race([
    runCommand(process.execPath, ["-e", program], { timeoutMs: 3000 }).then(() => "settled", () => "settled"),
    new Promise((resolve) => { timer = setTimeout(() => resolve("stranded"), 12_000); }),
  ]);
  clearTimeout(timer);
  assert.equal(outcome, "settled");
  pid = Number(await readFile(pidFile, "utf8"));
  const alive = await exec("pwsh", ["-NoProfile", "-Command",
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Write-Output alive }`]);
  assert.equal(alive.stdout.trim(), "", "The owned descendant must actually be gone.");
});
