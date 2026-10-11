import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand } from "./process.mjs";

function probeFailure(error, reason) {
  const match = /error while loading shared libraries: ([A-Za-z][A-Za-z0-9_.+-]{0,95}):/.exec(
    String(error.stderr ?? "").slice(0, 16384));
  const library = match && !/gh[pousr]_|github_pat_|token|secret|password|bearer/i.test(match[1]) ? match[1] : undefined;
  return Object.assign(new Error("Hosted emulator runtime preflight failed."), {
    reason, library, exitCode: Number.isInteger(error.code) ? error.code : null,
  });
}

export async function ensureHostedEmulatorRuntime({
  sdk = process.env.ANDROID_HOME, environment = process.env, platform = process.platform, run = runCommand,
} = {}) {
  if (platform !== "linux" || environment.GITHUB_ACTIONS !== "true" ||
      environment.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("Runtime preparation is restricted to the explicitly configured hosted Linux job.");
  }
  if (!sdk) throw new Error("The hosted Android SDK must be selected explicitly.");
  const executable = path.join(sdk, "emulator", "emulator");
  const probe = () => run(executable, ["-version"], { timeoutMs: 30000 });
  try {
    await probe();
    return { status: "ready", installedPackages: [] };
  } catch (error) {
    const failure = probeFailure(error, "runtime-probe-failed");
    if (failure.exitCode !== 127 || failure.library !== "libpulse.so.0") throw failure;
  }
  // Ubuntu Noble's libpulse0 supplies this exact loader dependency; install nothing on speculation.
  await run("apt-get", ["update", "-qq"], { timeoutMs: 180000, privileged: true });
  await run("apt-get", ["install", "-y", "--no-install-recommends", "libpulse0"], { timeoutMs: 180000, privileged: true });
  try { await probe(); }
  catch (error) { throw probeFailure(error, "runtime-probe-failed-after-dependency-install"); }
  return { status: "ready", installedPackages: ["libpulse0"] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await ensureHostedEmulatorRuntime())); }
  catch (error) {
    console.error(JSON.stringify({ status: "blocked", reason: error.reason ?? "runtime-preparation-failed",
      library: error.library ?? null, exitCode: error.exitCode ?? (Number.isInteger(error.code) ? error.code : null) }));
    process.exitCode = 1;
  }
}
