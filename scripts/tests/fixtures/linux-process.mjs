import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../../process.mjs";
import { parseLinuxProcess } from "../../linux-emulator.mjs";

export async function fixture(t) {
  await mkdir(".data/tests", { recursive: true });
  const directory = await mkdtemp(path.resolve(".data/tests/linux-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function readWhenReady(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await readFile(file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Owned Linux fixture did not become ready.");
}

export async function alive(pid) {
  try { return parseLinuxProcess(await readFile(`/proc/${pid}/stat`, "utf8")).state !== "Z"; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function checkInterruption(t, cancelled, privileged) {
  const directory = await fixture(t), marker = path.join(directory, "child.pid");
  const program = [
    "const {spawn}=require('node:child_process');const fs=require('node:fs');",
    "const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'inherit'});",
    `child.once('spawn',()=>fs.writeFileSync(${JSON.stringify(marker)},String(child.pid)));setInterval(()=>{},1000);`,
  ].join("\n");
  const cancellation = new AbortController();
  const running = runCommand(process.execPath, ["-e", program],
    { timeoutMs: cancelled ? 5000 : 1000, graceMs: 250, signal: cancellation.signal, privileged })
    .then(() => ({ passed: true }), (error) => ({ error }));
  const pid = Number(await readWhenReady(marker));
  if (cancelled) cancellation.abort();
  const outcome = await running;
  assert.ok(outcome.error, "An interrupted command must fail, not return success.");
  assert.equal(outcome.error.processTreeStopped, true);
  assert.equal(await alive(pid), false);
  assert.equal(await alive(process.pid), true);
}
