import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TOOLING_TEST_FILES = Object.freeze([
  "verification", "verification-execution", "verification-diagnostics", "android-runner", "android-build", "android-diagnostics",
  "device-diagnostics", "platform-diagnostics", "backend-diagnostics", "worker-diagnostics", "native-lifecycle",
  "bounded-worker-log", "development-tools", "development-approval", "process", "emulator-resources", "manual-emulator",
  "linux-emulator", "linux-runtime", "xcode-mcp", "tooling-runner", "macos-host",
].map((name) => `scripts/tests/${name}.test.mjs`));

const shardFor = (file) => /\/development-(?:tools|approval)\.test\.mjs$/.test(file) ? "candidate"
  : /\/(?:verification[^/]*|git-state)\.test\.mjs$/.test(file) ? "verification"
    : /(?:diagnostics|bounded-worker-log)\.test\.mjs$/.test(file) ? "diagnostics" : "native";

export const TOOLING_TEST_SHARDS = Object.freeze(["candidate", "verification", "diagnostics", "native"]
  .map((id) => Object.freeze({ id, files: Object.freeze(TOOLING_TEST_FILES.filter((file) => shardFor(file) === id)) }))
  .filter((part) => part.files.length));

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const sharded = args.some((arg) => arg.startsWith("--tooling-shard"));
  const part = sharded && args.length === 2 && args[0] === "--tooling-shard"
    ? TOOLING_TEST_SHARDS.find((part) => part.id === args[1]) : null;
  if (sharded && !part) throw new Error("Use --tooling-shard with one known part and no additional filters.");
  const child = spawn(process.execPath, ["--test", ...(part ? part.files : [...args, ...TOOLING_TEST_FILES])], { stdio: "inherit" });
  const forwardSignal = (signal) => child.kill(signal);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, forwardSignal);
  child.once("error", (error) => {
    console.error("Unable to start tooling tests:", error.message);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    for (const forwarded of ["SIGINT", "SIGTERM"]) process.off(forwarded, forwardSignal);
    if (signal) process.kill(process.pid, signal);
    else process.exitCode ??= code ?? 1;
  });
}
