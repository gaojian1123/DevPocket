import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureHostedEmulatorRuntime } from "../linux-runtime.mjs";
import { ownedCommandLaunch } from "../process.mjs";

const environment = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
const options = { sdk: "/sdk", platform: "linux", environment };

test("runtime preparation refuses non-hosted execution before invoking any command", async () => {
  let calls = 0;
  await assert.rejects(ensureHostedEmulatorRuntime({ ...options, environment: {},
    run: async () => { calls++; } }), /hosted/i);
  assert.equal(calls, 0);
});

test("a working emulator probe installs nothing", async () => {
  const calls = [];
  const result = await ensureHostedEmulatorRuntime({ ...options, run: async (file, args) => {
    calls.push({ file, args });
    return { stdout: "Android emulator version", stderr: "" };
  } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["-version"]);
  assert.deepEqual(result.installedPackages, []);
});

test("only an observed missing libpulse enables the fixed official runtime dependency install", async () => {
  const calls = [];
  const result = await ensureHostedEmulatorRuntime({ ...options, run: async (file, args, execution) => {
    calls.push({ file, args, execution });
    if (calls.length === 1) throw Object.assign(new Error("probe failed"), {
      code: 127, stderr: "emulator: error while loading shared libraries: libpulse.so.0: cannot open shared object file",
    });
    return { stdout: "", stderr: "" };
  } });
  assert.deepEqual(calls.slice(1).map(({ file, args }) => ({ file, args })), [
    { file: "apt-get", args: ["update", "-qq"] },
    { file: "apt-get", args: ["install", "-y", "--no-install-recommends", "libpulse0"] },
    { file: calls[0].file, args: ["-version"] },
  ]);
  assert.equal(calls[1].execution.privileged, true);
  assert.equal(calls[2].execution.privileged, true);
  assert.equal(calls[3].execution.privileged, undefined);
  assert.deepEqual(result.installedPackages, ["libpulse0"]);
});

test("privileged hosted commands elevate their supervisor, not an unowned child command", () => {
  const launch = ownedCommandLaunch("linux", true, environment);
  assert.equal(launch.file, "sudo");
  assert.deepEqual(launch.args.slice(0, 3), ["-n", "python3", "-u"]);
  assert.match(launch.args[3], /owned-command-linux\.py$/);
  assert.throws(() => ownedCommandLaunch("linux", true, {}), /hosted/i);
  assert.throws(() => ownedCommandLaunch("win32", true, environment), /hosted/i);
  assert.equal(ownedCommandLaunch("win32", false, {}).file, "pwsh");
});

test("unknown loader failures and failed repairs stop without another install or retry", async () => {
  for (const known of [false, true]) {
    let calls = 0;
    await assert.rejects(ensureHostedEmulatorRuntime({ ...options, run: async () => {
      calls++;
      if (calls === 1 || calls === 4) throw Object.assign(new Error("probe failed"), {
        code: 127, stderr: `emulator: error while loading shared libraries: ${known ? "libpulse.so.0" : "libunknown.so.1"}: cannot open shared object file`,
      });
      return { stdout: "", stderr: "" };
    } }));
    assert.equal(calls, known ? 4 : 1);
  }
});

test("failed loader projection omits raw diagnostics and credential-shaped identifiers", async () => {
  const secret = "private-diagnostic-fixture-value";
  await assert.rejects(ensureHostedEmulatorRuntime({ ...options, run: async () => {
    throw Object.assign(new Error(secret), { code: 127,
      stderr: `error while loading shared libraries: libghp_synthetic.so: ${secret}` });
  } }), (error) => {
    assert.equal(error.library, undefined);
    assert.ok(!error.message.includes(secret));
    assert.equal(error.stderr, undefined);
    return true;
  });
});
