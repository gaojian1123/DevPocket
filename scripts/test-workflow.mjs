import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const WORKFLOW_TEST_FILES = Object.freeze([
  "verification", "verification-diagnostics", "android-runner", "android-build", "android-diagnostics",
  "device-diagnostics", "platform-diagnostics", "backend-diagnostics", "worker-diagnostics", "native-lifecycle",
  "bounded-worker-log", "development-workflow", "process", "emulator-resources", "manual-emulator",
  "linux-emulator", "linux-runtime", "xcode-mcp", "workflow-runner",
].map((name) => `scripts/tests/${name}.test.mjs`));

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), ...WORKFLOW_TEST_FILES], { stdio: "inherit" });
  const forwardSignal = (signal) => child.kill(signal);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, forwardSignal);
  child.once("error", (error) => {
    console.error("Unable to start workflow tests:", error.message);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    for (const forwarded of ["SIGINT", "SIGTERM"]) process.off(forwarded, forwardSignal);
    if (signal) process.kill(process.pid, signal);
    else process.exitCode ??= code ?? 1;
  });
}
