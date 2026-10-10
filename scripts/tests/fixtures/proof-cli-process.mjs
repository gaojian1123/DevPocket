import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = ["--import", import.meta.resolve("tsx"),
  path.join(process.env.DP_PROOF_REPO, "backend", "integration", "canvas-proof.ts"),
  "capture", "--directory", process.env.DP_PROOF_DIRECTORY, "--runtime-pid", String(process.pid)];
const options = { cwd: process.env.DP_PROOF_REPO, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] };
const lookalike = spawn(process.execPath, ["-e", "setTimeout(()=>{},15000)", "--",
  `text --session-id ${process.argv[process.argv.indexOf("--session-id") + 1]} trailing`], { stdio: "ignore" });
let lookalikeExit = 0;
try { execFileSync(process.execPath, [...args.slice(0, -1), String(lookalike.pid)], options); }
catch (error) { lookalikeExit = error.status; }
finally { lookalike.kill(); }
assert.equal(lookalikeExit, 1, "A session option inside another argument must not establish original identity.");
const wrapperFile = path.join(process.env.DP_PROOF_DIRECTORY, "wrapper-fixture.ps1");
writeFileSync(wrapperFile, "Start-Sleep -Seconds 15\n");
const wrapper = spawn("pwsh", ["-NoProfile", "-File", wrapperFile, "--session-id",
  process.argv[process.argv.indexOf("--session-id") + 1]], { stdio: "ignore" });
let wrapperExit = 0;
try { execFileSync(process.execPath, [...args.slice(0, -1), String(wrapper.pid)], options); }
catch (error) { wrapperExit = error.status; }
finally { wrapper.kill(); }
assert.equal(wrapperExit, 1, "A command-shell shim is not the original runtime process.");
const captured = JSON.parse(execFileSync(process.execPath, args, options));
let repeatedExit = 0;
try { execFileSync(process.execPath, args, options); }
catch (error) { repeatedExit = error.status; }
const checks = [];
for (const [script, file, extra] of [
  ["live-checks.ts", "live-checks.json", ["--model", "fixture-model", "--reasoning", "fixture-effort"]],
  ["cancel-check.ts", "cancellation.json", []],
]) {
  const command = ["--import", import.meta.resolve("tsx"),
    path.join(process.env.DP_PROOF_REPO, "backend", "integration", script),
    "--directory", process.env.DP_PROOF_DIRECTORY, "--confirm-runtime-checks", ...extra];
  const invoke = () => {
    try { execFileSync(process.execPath, command, options); return 0; }
    catch (error) { return error.status; }
  };
  const firstExit = invoke(), first = readFileSync(path.join(process.env.DP_PROOF_DIRECTORY, file), "utf8");
  const secondExit = invoke(), second = readFileSync(path.join(process.env.DP_PROOF_DIRECTORY, file), "utf8");
  checks.push({ script, firstExit, secondExit, preserved: first === second, evidence: JSON.parse(second) });
}
writeFileSync(process.env.DP_FAKE_CLI_SNAPSHOT, JSON.stringify({
  captured, repeatedExit, pid: process.pid, args: process.argv.slice(2), checks,
}));
