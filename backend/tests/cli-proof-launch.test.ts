import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { startCliProof } from "../integration/cli-proof.js";
import { runCommand } from "../../scripts/process.mjs";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
async function exec(file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout?: number }) {
  try {
    await runCommand(file, args, { env: options.env, timeoutMs: options.timeout ?? 60_000, graceMs: 5000 });
  } catch (error) {
    if (error instanceof Error && "stderr" in error && typeof error.stderr === "string") {
      throw new Error(error.stderr || error.message, { cause: error });
    }
    throw error;
  }
}

test("the ordinary launcher requires scoped consent, uses the chosen CLI and restores process environment", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = path.resolve(".data", "cli-proofs", `launch test-${randomUUID()}`);
  const run = await startCliProof(root);
  t.after(async () => { await run.close(); await rm(root, { recursive: true, force: true }); });
  const fakeBin = path.join(root, "fake-bin");
  await mkdir(fakeBin);
  const fakeCli = path.join(fakeBin, "copilot.ps1");
  await copyFile(path.resolve("scripts", "tests", "fixtures", "proof-cli.ps1"), fakeCli);
  await writeFile(path.join(fakeBin, "copilot.cmd"), '@pwsh -NoProfile -File "%~dp0copilot.ps1" %*\r\n');
  const capture = path.join(root, "fake-cli.json"), parent = path.join(root, "parent.json");
  const launcher = path.resolve("scripts", "launch-cli-proof.ps1");
  const environment = {
    ...process.env, PATH: `${fakeBin};${process.env.PATH}`,
    DP_FAKE_CLI_SNAPSHOT: capture, DP_FAKE_CLI_EXIT: "17",
    COPILOT_TRAMPOLINE_IDENTIFIER: "test-routing", WT_SESSION: "test-terminal",
    COPILOT_AUTO_UPDATE: "test-update", COPILOT_ALLOW_ALL: "test-allow",
  };
  const invoke = `& ${literal(launcher)} -RunDirectory ${literal(root)} -CliPath ${literal(fakeCli)}`;
  await assert.rejects(exec("pwsh", ["-NoProfile", "-Command", invoke], { env: environment }),
    /ConfirmLaunch|confirm/i);
  await assert.rejects(readFile(capture), { code: "ENOENT" });
  await exec("pwsh", ["-NoProfile", "-Command", `
    ${invoke} -ConfirmLaunch
    $code = $LASTEXITCODE
    [IO.File]::WriteAllText(${literal(parent)}, (@{
      exitCode = $code; directory = (Get-Location).Path
      routing = $env:COPILOT_TRAMPOLINE_IDENTIFIER; terminal = $env:WT_SESSION
      autoUpdate = $env:COPILOT_AUTO_UPDATE; allowAll = $env:COPILOT_ALLOW_ALL
    } | ConvertTo-Json))
    exit 0
  `], { env: environment, timeout: 60_000 });
  const cli = JSON.parse(await readFile(capture, "utf8"));
  assert.equal(cli.directory, run.proof.workspace);
  assert.equal(cli.routing, null);
  assert.equal(cli.terminal, null);
  assert.equal(cli.autoUpdate, "false");
  assert.equal(cli.allowAll, "false");
  assert.ok(!cli.arguments.includes("--prefer-version"));
  assert.ok(!cli.arguments.includes("--allow-all"));
  assert.equal(cli.arguments[cli.arguments.indexOf("--session-id") + 1], run.proof.sessionId);
  assert.equal(cli.arguments[cli.arguments.indexOf("--plugin-dir") + 1], run.proof.plugin);
  assert.ok(cli.arguments.includes("--no-remote"));
  assert.ok(cli.arguments.includes("--mode"));
  const after = JSON.parse(await readFile(parent, "utf8"));
  assert.deepEqual(after, { exitCode: 17, directory: process.cwd(), routing: "test-routing",
    terminal: "test-terminal", autoUpdate: "test-update", allowAll: "test-allow" });
  const launch = JSON.parse(await readFile(path.join(root, "launch.json"), "utf8"));
  assert.equal(launch.cliPath, fakeCli);
  assert.equal(launch.sessionId, run.proof.sessionId);
  assert.equal(launch.parentPid, undefined, "Launcher PID cannot masquerade as original runtime identity.");
  await assert.rejects(exec("pwsh", ["-NoProfile", "-Command", `${invoke} -ConfirmLaunch`], { env: environment }),
    /already|new proof|exist/i);
});

test("capture records the chosen live process before attachment and never invents identity from the launcher PID", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = path.resolve(".data", "cli-proofs", `identity test-${randomUUID()}`);
  const run = await startCliProof(root);
  t.after(async () => { await run.close(); await rm(root, { recursive: true, force: true }); });
  const fakeCli = path.join(root, "fake-cli.cmd"), capture = path.join(root, "fake-cli.json");
  await writeFile(fakeCli, `@"${process.execPath}" "${path.resolve("scripts", "tests", "fixtures", "proof-cli-process.mjs")}" %*\r\n`);
  await exec("pwsh", ["-NoProfile", "-File", path.resolve("scripts", "launch-cli-proof.ps1"),
    "-RunDirectory", root, "-CliPath", fakeCli, "-ConfirmLaunch"], {
    env: { ...process.env, DP_PROOF_REPO: process.cwd(), DP_PROOF_DIRECTORY: root, DP_FAKE_CLI_SNAPSHOT: capture },
    timeout: 120_000,
  });
  const observed = JSON.parse(await readFile(capture, "utf8"));
  const before = JSON.parse(await readFile(path.join(root, "before-attachment.evidence.json"), "utf8"));
  const launch = JSON.parse(await readFile(path.join(root, "launch.json"), "utf8"));
  assert.equal(before.parentPid, observed.pid);
  assert.notEqual(before.parentPid, launch.launcherPid);
  assert.equal(before.sessionId, run.proof.sessionId);
  assert.ok(Date.parse(before.processCreatedAt) >= Date.parse(launch.launchedAt));
  assert.equal(observed.repeatedExit, 1);
  assert.equal(observed.args[observed.args.indexOf("--plugin-dir") + 1], run.proof.plugin);
  assert.equal(observed.args[observed.args.indexOf("--session-id") + 1], run.proof.sessionId);
  for (const check of observed.checks) {
    assert.equal(check.firstExit, 1, "An unattached fake CLI cannot pass real acceptance.");
    assert.equal(check.secondExit, 1);
    assert.equal(check.preserved, true, "Re-running a check must not overwrite its previous evidence.");
  }
  assert.ok(!observed.checks[0].evidence.some((item: { name: string }) => item.name === "command-dispatch"));
  assert.deepEqual(observed.checks[1].evidence.commands, []);
  await assert.rejects(readFile(path.join(root, "checks.lock")), { code: "ENOENT" });
});
