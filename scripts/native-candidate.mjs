import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nativeFiles = ["candidate-commit.mjs", "git-state.mjs"];
const implementationFiles = [...new Set([...nativeFiles, "native-candidate.mjs", "development-policy.mjs", "development-paths.mjs",
  "verification.mjs", "verification-policy.mjs", "process.mjs", "device-run.mjs", "worker-diagnostics.mjs",
  "device-diagnostics.mjs", "diagnostic-errors.mjs", "bounded-worker-log.mjs", "diagnostic-publication.mjs",
  "native-lifecycle.mjs", "verification-executor.mjs", "verification-backend.mjs", "verification-android.mjs",
  "backend-diagnostics.mjs", "verification-preflight.mjs", "verification-run.mjs", "verification-transition.mjs",
  "verification-tooling.mjs", "verification-admission.mjs", "verification-ci.mjs", "verification-ci-artifact.ps1",
  "verify.mjs", "verify.ps1", "test-workflow.mjs", "owned-command-windows.mjs", "owned-command.cs", "owned-command.ps1",
  "owned-command-linux.py", "owned-command-darwin.py", "local-ipc.mjs", "android-platform.mjs", "emulator-resources.mjs"])].sort();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function captureCandidateImplementation(directory = fileURLToPath(new URL(".", import.meta.url))) {
  directory = await realpath(directory);
  const files = await Promise.all(implementationFiles.map(async (name) => {
    const file = path.join(directory, name), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file || info.size > 1024 * 1024) {
      throw new Error("Candidate implementation input is unavailable.");
    }
    const input = await open(file, "r");
    try {
      let first;
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await input.stat();
        if (["dev", "ino", "mode", "size", "mtimeMs"].some((key) => current[key] !== info[key]) ||
            current.size > 1024 * 1024) throw new Error("Candidate implementation changed while being captured.");
        const bytes = Buffer.alloc(current.size);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await input.read(bytes, offset, bytes.length - offset, offset);
          if (!result.bytesRead) throw new Error("Candidate implementation changed while being captured.");
          offset += result.bytesRead;
        }
        const after = [await input.stat(), await lstat(file)];
        if (after.some((value) => ["dev", "ino", "mode", "size", "mtimeMs"].some((key) => value[key] !== current[key])) ||
            first && !bytes.equals(first)) {
          throw new Error("Candidate implementation changed while being captured.");
        }
        if (after.every((value) => value.ctimeMs === current.ctimeMs)) return Object.freeze({ name, sha256: digest(bytes) });
        // A cold Windows close-time update gets one same-handle, byte-identical stability read.
        if (process.platform !== "win32" || attempt) throw new Error("Candidate implementation changed while being captured.");
        first = bytes;
      }
      throw new Error("Candidate implementation changed while being captured.");
    } finally { await input.close(); }
  }));
  return Object.freeze({ version: 2, directory, files: Object.freeze(files) });
}

export async function requireCandidateImplementation(expected) {
  if (expected?.version !== 2 || typeof expected.directory !== "string" ||
      !Array.isArray(expected.files) || expected.files.length !== implementationFiles.length) {
    throw new Error("A current captured candidate/verification implementation is required.");
  }
  const current = await captureCandidateImplementation(expected.directory);
  if (current.directory !== expected.directory || current.files.some((file, index) =>
    file.name !== expected.files[index]?.name || file.sha256 !== expected.files[index]?.sha256)) {
    throw new Error("The captured candidate/verification implementation changed; obtain approval and recapture it before continuing.");
  }
}

async function runFrozenCandidate(specification) {
  const { createHash, randomUUID } = await import("node:crypto");
  const { lstat, readFile, realpath, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { registerHooks } = await import("node:module");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const [flag, file, hashFlag, expectedHash, ...extra] = process.argv.slice(1);
  let loader, entered = false, failure, reason = "execution-inputs-changed";
  try {
    if (flag !== "--request" || hashFlag !== "--sha256" || extra.length || !/^[a-f0-9]{64}$/.test(expectedHash ?? "")) {
      throw new Error("Invalid frozen candidate invocation.");
    }
    const bytes = await readFile(file);
    if (bytes.length > 1024 * 1024 || hash(bytes) !== expectedHash) throw new Error("Candidate request changed before execution.");
    if (typeof registerHooks !== "function") {
      reason = "execution-loader-unavailable";
      throw new Error("The native Node.js runtime cannot load captured modules; a supported runtime is required.");
    }
    const request = JSON.parse(bytes), implementation = request.execution;
    if (implementation?.version !== 2 || typeof implementation.directory !== "string" ||
        !Array.isArray(implementation.files) ||
        JSON.stringify(implementation.files.map((input) => input?.name)) !== JSON.stringify(specification.inputs)) {
      throw new Error("Candidate executable-input binding is missing or unrecognized.");
    }
    if (await realpath(implementation.directory) !== implementation.directory) throw new Error("Candidate implementation location changed.");
    const contents = new Map();
    for (const input of implementation.files) {
      const source = path.join(implementation.directory, input.name), info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("Candidate executable input is unavailable.");
      const content = await readFile(source);
      if (content.length !== info.size || hash(content) !== input.sha256) throw new Error("Candidate executable inputs changed after approval.");
      if (specification.native.includes(input.name)) contents.set(input.name, content);
    }
    const directory = path.join(tmpdir(), `devpocket-approved-candidate-${randomUUID()}`);
    const sources = new Map([...contents].map(([name, content]) =>
      [pathToFileURL(path.join(directory, name)).href, content.toString("utf8")]));
    loader = registerHooks({
      resolve(specifier, context, next) {
        if (specifier.startsWith("node:")) return next(specifier, context);
        const url = new URL(specifier, context.parentURL).href;
        if (!sources.has(url)) throw new Error("An unclassified candidate import requires approval.");
        return { url, shortCircuit: true };
      },
      load(url, context, next) {
        if (url.startsWith("node:")) return next(url, context);
        if (!sources.has(url)) throw new Error("An unclassified candidate module requires approval.");
        return { format: "module", source: sources.get(url), shortCircuit: true };
      },
    });
    const helper = await import(pathToFileURL(path.join(directory, "candidate-commit.mjs")).href);
    entered = true;
    await helper.runCandidateRequest(file, expectedHash);
  } catch (error) {
    failure = error;
    if (!entered && typeof file === "string") {
      try {
        await writeFile(`${file}.result.json`, JSON.stringify({ status: "blocked", failure: reason }) + "\n",
          { flag: "wx", mode: 0o600 });
      } catch (recordError) {
        if (recordError.code !== "EEXIST") console.error("Candidate input-failure receipt could not be written.");
      }
    }
  } finally {
    loader?.deregister();
  }
  if (failure) {
    console.error(failure.message);
    if (failure.stderr) console.error(failure.stderr);
    if (failure.traceCleanupFailed) console.error("Git hook trace cleanup also failed.");
    if (failure.indexCleanupFailed) console.error("Candidate index cleanup also failed.");
    process.exitCode = 1;
  }
}

export function nativeCandidateCommand(file, requestHash) {
  if (arguments.length !== 2) throw new TypeError("The native candidate command accepts only a commit request and its hash.");
  if (!/^[a-f0-9]{64}$/.test(requestHash)) throw new Error("A bound candidate request hash is required.");
  const quote = (text) => `'${text.replaceAll("'", "''")}'`;
  const source = `await (${runFrozenCandidate.toString()})(${JSON.stringify({
    inputs: implementationFiles, native: nativeFiles,
  })});`;
  const startup = [
    "if (-not [string]::IsNullOrEmpty($env:NODE_OPTIONS)) {",
    "  $startupReceipt = $null",
    "  try {",
    `    $startupReceipt = [IO.File]::Open(${quote(`${file}.result.json`)}, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)`,
    `    $startupBytes = [Text.Encoding]::UTF8.GetBytes(${quote(JSON.stringify({ status: "blocked", failure: "execution-startup-unbound" }))})`,
    "    $startupReceipt.Write($startupBytes, 0, $startupBytes.Length)",
    "    $startupReceipt.Flush($true)",
    "  } catch {",
    "    [Console]::Error.WriteLine('Could not record the native startup refusal; existing evidence was not overwritten.')",
    "  } finally {",
    "    if ($null -ne $startupReceipt) { $startupReceipt.Dispose() }",
    "  }",
    "  [Console]::Error.WriteLine('Native candidate refuses unbound NODE_OPTIONS; no Node helper was started and the environment was not modified.')",
    "  exit 78",
    "}",
  ].join("\n");
  return `${startup}\n& ${quote(process.execPath)} --input-type=module --eval ${quote(source)} -- --request ${quote(file)} --sha256 ${quote(requestHash)}; exit $LASTEXITCODE`;
}
