import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TOOLING_TEST_FILES = Object.freeze([
  "verification", "verification-execution", "verification-refinement", "verification-refinement-context", "verification-refinement-evidence", "verification-apple-batches",
  "verification-diagnostics", "apple-selection", "apple-local", "apple-runner",
  "android-runner", "android-build", "android-diagnostics",
  "device-diagnostics", "platform-diagnostics", "backend-diagnostics", "worker-diagnostics", "native-lifecycle",
  "bounded-worker-log", "development-tools", "development-approval", "process", "emulator-resources", "manual-emulator",
  "linux-emulator", "linux-runtime", "xcode-mcp", "tooling-runner", "macos-host",
].map((name) => `scripts/tests/${name}.test.mjs`));

const shardFor = (file) => /\/verification-(?:refinement(?:-(?:context|evidence))?|apple-batches)\.test\.mjs$/.test(file) ? "native"
  : /\/apple-(?:selection|local)\.test\.mjs$/.test(file) ? "verification"
  : /\/development-(?:tools|approval)\.test\.mjs$/.test(file) ? "candidate"
  : /\/(?:verification[^/]*|git-state)\.test\.mjs$/.test(file) ? "verification"
    : /(?:diagnostics|bounded-worker-log)\.test\.mjs$/.test(file) ? "diagnostics" : "native";

export const TOOLING_TEST_SHARDS = Object.freeze(["candidate", "verification", "diagnostics", "native"]
  .map((id) => Object.freeze({ id, files: Object.freeze(TOOLING_TEST_FILES.filter((file) => shardFor(file) === id)) }))
  .filter((part) => part.files.length));

export function toolingProgressRecord(event, root = process.cwd()) {
  if (!["test:enqueue", "test:dequeue", "test:start", "test:pass", "test:fail"].includes(event?.type) ||
      typeof event.data?.file !== "string") return undefined;
  const file = path.relative(root, event.data.file).replaceAll("\\", "/");
  if (!TOOLING_TEST_FILES.includes(file)) return undefined;
  const record = { version: 1, kind: "tooling-progress", event: event.type, file };
  for (const key of ["line", "column"]) {
    if (Number.isSafeInteger(event.data[key]) && event.data[key] > 0) record[key] = event.data[key];
  }
  return record;
}

function progressDestination(value) {
  if (process.env.GITHUB_ACTIONS !== "true" || typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error("Tooling progress requires an explicit hosted-CI destination.");
  }
  const absolute = path.resolve(value), relative = path.relative(process.cwd(), absolute).replaceAll("\\", "/");
  if (!relative.startsWith(".data/ci/") || path.basename(absolute) !== "tooling-progress.jsonl") {
    throw new Error("Tooling progress must use a new tooling-progress.jsonl inside this checkout's .data/ci.");
  }
  return absolute;
}

export default async function* toolingProgress(events) {
  const file = progressDestination(process.env.DEVPOCKET_TOOLING_PROGRESS);
  const { diagnosticDirectory } = await import("./diagnostic-publication.mjs");
  await diagnosticDirectory(process.cwd(), path.dirname(file));
  const output = await open(file, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const event of events) {
      const record = toolingProgressRecord(event);
      if (!record) continue;
      const line = JSON.stringify({ ...record, observedAt: new Date().toISOString() }) + "\n";
      bytes += Buffer.byteLength(line);
      if (bytes > 4 * 1024 * 1024) throw new Error("Tooling progress exceeded its bounded output.");
      await output.writeFile(line);
    }
    await output.sync();
  } finally { await output.close(); }
  yield "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const progressArguments = args.map((arg, index) => arg.startsWith("--progress") ? index : -1).filter((index) => index >= 0);
  let progress;
  if (progressArguments.length) {
    const index = progressArguments[0];
    if (progressArguments.length !== 1 || args[index] !== "--progress" ||
        !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Use --progress with one explicit CI output path.");
    progress = progressDestination(args[index + 1]);
    args.splice(index, 2);
  }
  const sharded = args.some((arg) => arg.startsWith("--tooling-shard"));
  const part = sharded && args.length === 2 && args[0] === "--tooling-shard"
    ? TOOLING_TEST_SHARDS.find((part) => part.id === args[1]) : null;
  if (sharded && !part) throw new Error("Use --tooling-shard with one known part and no additional filters.");
  const reporters = progress ? ["--test-reporter=spec", `--test-reporter=${import.meta.url}`,
    "--test-reporter-destination=stdout", "--test-reporter-destination=stdout"] : [];
  const child = spawn(process.execPath, ["--test", ...reporters, ...(part ? part.files : [...args, ...TOOLING_TEST_FILES])],
    { stdio: "inherit", ...(progress ? { env: { ...process.env, DEVPOCKET_TOOLING_PROGRESS: progress } } : {}) });
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
