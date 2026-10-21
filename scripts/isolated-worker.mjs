import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runCommand, withCommandBoundary } from "./process.mjs";
import { git, sourceSnapshot, withGitExecutable } from "./git-state.mjs";
import { executeVerification, verificationPlan, combineVerification, verificationFault, verificationFailure } from "./verification.mjs";
import { isolatedContext } from "./isolated-verification.mjs";
import { WORKFLOW_TEST_FILES } from "./test-workflow.mjs";
import { LINUX_PLATFORM_TESTS } from "./backend-diagnostics.mjs";
import { readDiagnosticReport } from "./worker-diagnostics.mjs";
import { failureDetails } from "./diagnostic-errors.mjs";
import { readWorkerLogTail, writeBoundedWorkerLog } from "./bounded-worker-log.mjs";

const controlRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
let bootstrapPhase = "configuration";

function nativeFailure(value) {
  if (!value || !["control", "privileges", "job", "logon", "attributes", "create", "identity", "resume", "wait", "cleanup"].includes(value.stage)) return null;
  return { stage: value.stage,
    errorCode: Number.isInteger(value.errorCode) && value.errorCode >= 0 && value.errorCode <= 65535 ? value.errorCode : null,
    assignPrimaryTokenEnabled: typeof value.assignPrimaryTokenEnabled === "boolean" ? value.assignPrimaryTokenEnabled : null,
    increaseQuotaEnabled: typeof value.increaseQuotaEnabled === "boolean" ? value.increaseQuotaEnabled : null };
}

export function isolatedCandidateEnvironment(configuration, environment) {
  const windows = configuration.platform === "win32";
  const result = { PATH: environment.PATH ?? environment.Path, HOME: configuration.home, CI: "true",
    TMP: configuration.temporary, TEMP: configuration.temporary, TMPDIR: configuration.temporary,
    GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_TEMP: configuration.temporary,
    GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "safe.directory", GIT_CONFIG_VALUE_1: configuration.candidate,
    GIT_CONFIG_KEY_2: "safe.directory", GIT_CONFIG_VALUE_2: configuration.fixture,
    npm_config_cache: path.join(configuration.home, "npm-cache") };
  for (const name of ["JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
    if (environment[name]) result[name] = environment[name];
  }
  if (windows) {
    Object.assign(result, { SystemRoot: environment.SystemRoot, WINDIR: environment.WINDIR ?? environment.SystemRoot,
      ComSpec: path.join(environment.SystemRoot, "System32", "cmd.exe"), PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: configuration.home, APPDATA: path.join(configuration.home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(configuration.home, "AppData", "Local"), NoDefaultCurrentDirectoryInExePath: "1" });
  } else Object.assign(result, { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
  if (configuration.group === "backend") {
    const pythonDirectory = path.join(configuration.candidate, ".tools", "probe-python", windows ? "Scripts" : "bin");
    result.DEVPOCKET_PROBE_PYTHON = path.join(pythonDirectory, windows ? "python.exe" : "python");
    result.PATH = `${pythonDirectory}${path.delimiter}${result.PATH}`;
  }
  if (Object.values(result).some((value) => typeof value !== "string" || value.includes("\0"))) {
    throw new Error("Incomplete isolated candidate environment.");
  }
  return result;
}

async function immutableJson(file, value, maximum = 1024 * 1024) {
  const bytes = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(bytes) > maximum) throw new Error("Isolated worker evidence exceeded its bound.");
  const output = await open(file, "wx", 0o600);
  try { await output.writeFile(bytes); await output.sync(); }
  finally { await output.close(); }
}

async function configurationFrom(file) {
  const config = await readDiagnosticReport(file, { maximum: 65536 });
  if (config.version !== 1 || config.platform !== process.platform || config.control !== controlRoot ||
      !["worker", "self-test"].includes(config.mode) || !["tooling", "backend", "android", "device"].includes(config.group) ||
      process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("An authenticated hosted bootstrap configuration is required.");
  }
  for (const directory of [config.control, config.candidate, config.fixture, config.private, config.home, config.temporary]) {
    if (!path.isAbsolute(directory) || await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) {
      throw new Error("The isolated worker allocation changed.");
    }
  }
  if (path.dirname(await realpath(file)) !== config.private ||
      config.platform === "linux" && (process.getuid() !== 0 || !Number.isSafeInteger(config.uid) || config.uid < 1000 ||
        !Number.isSafeInteger(config.gid) || config.gid < 1000)) throw new Error("The private worker allocation is unavailable.");
  for (const name of ["node", "pwsh", "git", config.platform === "win32" ? "python" : "python3"]) {
    const executable = config.tools?.[name];
    if (!path.isAbsolute(executable) || !(await lstat(executable)).isFile()) throw new Error("A fixed worker tool is unavailable.");
  }
  return config;
}

export function isolatedCommandBoundary(configuration, ownerEnvironment, candidateEnvironment) {
  return async (file, args, options, execute) => {
    options.signal?.throwIfAborted();
    if (options.privileged) throw verificationFault("configuration");
    const executable = path.isAbsolute(file) ? file : configuration.tools[file];
    if (!executable || !path.isAbsolute(executable)) throw verificationFault("preflight-tool");
    const id = randomUUID(), requestFile = path.join(configuration.private, `${id}.json`);
    const environment = { ...candidateEnvironment };
    for (const name of ["DEVPOCKET_BACKEND_DIAGNOSTIC_ID", "DEVPOCKET_TEST_DIAGNOSTIC_SCOPE"]) {
      if (options.env?.[name]) environment[name] = options.env[name];
    }
    const request = { version: 1, id, file: executable, arguments: args, cwd: path.resolve(options.cwd ?? configuration.candidate),
      timeoutMs: options.timeoutMs ?? 30000, environment,
      ...(configuration.platform === "win32" ? { identity: configuration.identity }
        : { uid: configuration.uid, gid: configuration.gid }) };
    await immutableJson(requestFile, request, 65536);
    let result, failure, receipt, dispatched = false;
    try {
      options.signal?.throwIfAborted();
      const windows = configuration.platform === "win32";
      dispatched = true;
      result = await execute(windows ? configuration.tools.pwsh : configuration.tools.python3,
        windows ? ["-NoProfile", "-NonInteractive", "-File", path.join(controlRoot, "scripts", "isolated-command.ps1"),
          "-Request", requestFile]
          : ["-I", path.join(controlRoot, "scripts", "isolated-command.py"), requestFile],
        { ...options, cwd: controlRoot, env: ownerEnvironment, privileged: !windows });
    } catch (error) { failure = error; }
    if (!dispatched) {
      await unlink(requestFile);
      throw failure;
    }
    try { receipt = await readDiagnosticReport(`${requestFile}.result.json`, { maximum: 4096 }); }
    catch (error) {
      throw Object.assign(verificationFault("cleanup-failed", {}, error), {
        processTreeStopped: false, stdout: result?.stdout ?? failure?.stdout ?? "", stderr: result?.stderr ?? failure?.stderr ?? "",
        commandOutcome: { ...(result?.commandOutcome ?? failure?.commandOutcome), reason: "spawn",
          cleanupFailure: failureDetails(error, "cleanup-failed") },
      });
    } finally {
      await unlink(requestFile);
    }
    const admissionKnown = configuration.platform !== "win32" ||
      ["not-admitted", "creation-attempted", "created", "running"].includes(receipt?.admission) &&
        receipt.started === (receipt.admission === "running");
    const interruptionKnown = receipt?.interruption == null || ["cancelled", "timeout"].includes(receipt.interruption);
    const stopped = receipt?.version === 1 && receipt.id === id && admissionKnown && interruptionKnown && receipt.processTreeStopped === true &&
      (result?.processTreeStopped ?? failure?.processTreeStopped) === true;
    if ((options.signal?.aborted || receipt?.interruption === "cancelled") && stopped) {
      throw Object.assign(new Error("Isolated command was cancelled.", { cause: options.signal?.reason }),
        { processTreeStopped: true, stdout: failure?.stdout ?? "", stderr: failure?.stderr ?? "",
          isolatedAdmission: receipt.admission,
          commandOutcome: { ...(failure?.commandOutcome ?? result?.commandOutcome), reason: "cancelled", cleanupFailure: null } });
    }
    if (receipt?.interruption === "timeout" && stopped) {
      throw Object.assign(verificationFault("command-timeout"), {
        processTreeStopped: true, isolatedAdmission: receipt.admission,
        stdout: failure?.stdout ?? "", stderr: failure?.stderr ?? "",
        commandOutcome: { ...(failure?.commandOutcome ?? result?.commandOutcome), reason: "timeout", cleanupFailure: null },
      });
    }
    if (receipt?.status === "blocked" && stopped) {
      throw Object.assign(verificationFault("preflight-tool", { phase: "preflight" }), {
        processTreeStopped: true, stdout: failure?.stdout ?? "", stderr: failure?.stderr ?? "",
        nativeFailure: nativeFailure(receipt.native),
        commandOutcome: { ...(failure?.commandOutcome ?? result?.commandOutcome), reason: "spawn", cleanupFailure: null },
      });
    }
    if (!stopped || receipt.status !== "executed" || receipt.started !== true || !Number.isInteger(receipt.exitCode) ||
        receipt.exitCode !== (result?.commandOutcome ?? failure?.commandOutcome)?.exitCode) {
      throw Object.assign(verificationFault("cleanup-failed"), { processTreeStopped: false,
        stdout: result?.stdout ?? failure?.stdout ?? "", stderr: result?.stderr ?? failure?.stderr ?? "",
        commandOutcome: { ...(result?.commandOutcome ?? failure?.commandOutcome), reason: "spawn",
          cleanupFailure: failureDetails(verificationFault("cleanup-failed")) } });
    }
    if (failure) {
      failure.isolatedExecutionObserved = true;
      throw failure;
    }
    return result;
  };
}

async function printFailureTail(file) {
  const tail = (await readWorkerLogTail(file))
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
  const token = randomUUID();
  console.error(`::stop-commands::${token}\n${tail}\n::${token}::`);
}

async function retainBootstrapFailure(error) {
  const directory = path.join(controlRoot, ".data", "ci", "isolated");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "bootstrap-failure.log");
  const privateLog = await writeBoundedWorkerLog(file, `${error.stdout ?? ""}${error.stderr ?? ""}`);
  const report = { version: 1, kind: "isolated-bootstrap-diagnostics", acceptance: false,
    status: "blocked", phase: bootstrapPhase, failure: failureDetails(error),
    nativeFailure: nativeFailure(error.nativeFailure), privateLog };
  await immutableJson(path.join(directory, "bootstrap-failure.json"), report);
  console.error(JSON.stringify(report));
  if (error.isolatedExecutionObserved === true) await printFailureTail(file);
}

async function proveIsolation(configuration, directory) {
  const fixture = configuration.fixture, runner = path.join(controlRoot, "scripts", "test-workflow.mjs");
  const marker = `denied-${randomUUID()}`, evidence = path.join(directory, "protected-evidence.json");
  await immutableJson(evidence, { marker, status: "not-candidate-evidence" });
  const runnerBytes = await readFile(runner), evidenceBytes = await readFile(evidence);
  const input = { fixture, runner, evidence, marker, supervisorPid: process.pid, files: WORKFLOW_TEST_FILES,
    probe: path.join(controlRoot, "scripts", "isolated-worker-probe.mjs"), protectedPaths: configuration.protectedPaths };
  bootstrapPhase = "fixture-create";
  await runCommand(configuration.tools.node, [input.probe, "fixture", JSON.stringify(input)], { cwd: fixture, timeoutMs: 30000 });
  bootstrapPhase = "fixture-git";
  await git(fixture, ["-c", "init.templateDir=", "init", "--quiet"]);
  await git(fixture, ["add", "--all"]);
  await git(fixture, ["-c", "user.name=Isolation fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Known failing fixture"]);
  await writeFile(path.join(fixture, "scripts", "verification.mjs"), "// Select the fixed tooling gate.\n");
  const plan = await verificationPlan(fixture, "HEAD", false, { trustedTooling: true });
  bootstrapPhase = "fixture-install";
  await runCommand(configuration.tools.pwsh, ["-NoProfile", "-NonInteractive", "-Command", "& npm ci --no-audit --no-fund; exit $LASTEXITCODE"],
    { cwd: fixture, timeoutMs: 120000 });
  bootstrapPhase = "boundary-assertions";
  assert.deepEqual(await readFile(runner), runnerBytes, "A candidate installation replaced trusted selection code.");
  assert.deepEqual(await readFile(evidence), evidenceBytes, "A candidate installation replaced trusted evidence.");
  const attacks = await readDiagnosticReport(path.join(fixture, ".data", "attacks.json"), { maximum: 16384 });
  assert.equal(attacks.length, configuration.protectedPaths.length * 4 + 4);
  assert.ok(attacks.every((item) => item.denied === true));
  const descendant = path.join(fixture, ".data", "descendant.json"), stopped = await readFile(descendant);
  assert.equal(JSON.parse(stopped).denied, true);
  await delay(250);
  assert.deepEqual(await readFile(descendant), stopped, "The background candidate descendant survived its owner.");
  bootstrapPhase = "cancellation-check";
  const cancellation = new AbortController(), counter = path.join(fixture, ".data", "cancelled-descendant.json");
  const cancelled = runCommand(configuration.tools.node, [input.probe, "descendant", JSON.stringify({ counter, runner })],
    { cwd: fixture, signal: cancellation.signal, timeoutMs: 30000 });
  const outcome = cancelled.then(() => ({ unexpectedSuccess: true }), (error) => error);
  try {
    const deadline = Date.now() + 15000;
    while (true) {
      try { await lstat(counter); break; }
      catch (error) { if (error.code !== "ENOENT" || Date.now() >= deadline) throw error; }
      await delay(20);
    }
  } finally { cancellation.abort(); }
  const cancelledOutcome = await outcome;
  assert.equal(cancelledOutcome.processTreeStopped, true, "Cancellation did not confirm the low-identity process tree stopped.");
  assert.equal(cancelledOutcome.commandOutcome?.reason, "cancelled");
  const cancelledBytes = await readFile(counter);
  await delay(250);
  assert.deepEqual(await readFile(counter), cancelledBytes);
  bootstrapPhase = "negative-gate";
  const report = await executeVerification(fixture, plan, { group: "tooling", evidenceRoot: controlRoot,
    directory: path.join(directory, "negative-gate"), isolatedTooling: true,
    trustedToolingRunner: runner });
  await immutableJson(path.join(directory, "isolation-negative-report.json"), report);
  const check = report.checks.find((check) => check.id === "workflow-tests");
  assert.equal(report.status, "failed", "The negative fixture must reach the actual fixed check, not fail in setup.");
  assert.equal(check?.status, "failed");
  assert.equal(check?.executionState, "exited");
  assert.equal(check?.failure?.phase, "command");
  assert.notEqual(check?.exitCode, 0);
  assert.match(await readFile(path.join(directory, "negative-gate", "workflow-tests.log"), "utf8"), /DEVPOCKET_REQUIRED_FAILURE/);
  assert.throws(() => combineVerification(plan, [report]));
  return { version: 1, kind: "hosted-isolation-proof", status: "passed", platform: process.platform,
    checks: ["protected-control", "protected-evidence", "protected-ancestors", "runner-channels", "descendant-cleanup", "failing-fixed-gate"],
    negativeSource: plan.source, negativeReportSha256: digest(JSON.stringify(report)) };
}

async function stageCandidateApks(configuration, directory) {
  if (!["android", "device"].includes(configuration.group)) return;
  const destination = path.join(directory, "artifacts");
  await mkdir(destination);
  for (const [parts, name] of [
    [["debug", "app-debug.apk"], "app-debug.apk"],
    [["androidTest", "debug", "app-debug-androidTest.apk"], "app-debug-androidTest.apk"],
  ]) {
    const components = ["android", "app", "build", "outputs", "apk", ...parts];
    let source = configuration.candidate;
    for (const [index, component] of components.entries()) {
      source = path.join(source, component);
      const info = await lstat(source);
      if (info.isSymbolicLink() || await realpath(source) !== source ||
          (index < components.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 || info.size > 256 * 1024 * 1024)) {
        throw verificationFault("apk-unavailable", { phase: "artifact-validation" });
      }
    }
    const before = await lstat(source), bytes = await readFile(source), after = await lstat(source);
    if (bytes.length !== before.size || ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some((key) => before[key] !== after[key])) {
      throw verificationFault("apk-mismatch", { phase: "artifact-validation" });
    }
    await writeFile(path.join(destination, name), bytes, { flag: "wx", mode: 0o600 });
  }
}

async function installCandidate(configuration) {
  const root = configuration.candidate;
  await runCommand(configuration.tools.pwsh,
    ["-NoProfile", "-NonInteractive", "-Command", "& npm ci --no-audit --no-fund; exit $LASTEXITCODE"],
    { cwd: root, timeoutMs: 15 * 60_000 });
  if (configuration.group === "backend") {
    await runCommand(configuration.tools.pwsh, ["-NoProfile", "-NonInteractive", "-Command",
      "& npm --prefix deployment/azure ci --no-audit --no-fund; exit $LASTEXITCODE"], { cwd: root, timeoutMs: 15 * 60_000 });
    const python = configuration.tools.python ?? configuration.tools.python3;
    await runCommand(python, ["-m", "venv", path.join(root, ".tools", "probe-python")], { cwd: root, timeoutMs: 120000 });
    await runCommand(process.env.DEVPOCKET_PROBE_PYTHON,
      ["-m", "pip", "install", "-r", path.join(root, "deployment", "azure", "probe", "requirements-test.txt")],
      { cwd: root, timeoutMs: 15 * 60_000 });
  }
  if (configuration.group === "device") {
    const source = await sourceSnapshot(root);
    for (const file of LINUX_PLATFORM_TESTS) {
      const output = await runCommand(configuration.tools.node, ["--disable-sigusr1", "--test", "--test-reporter=tap", file],
        { cwd: root, timeoutMs: 10 * 60_000 });
      const counts = Object.fromEntries(["tests", "pass", "fail", "cancelled", "skipped"].map((name) => {
        const matches = [...output.stdout.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, "gm"))];
        if (matches.length !== 1) throw verificationFault("collector-failed");
        return [name, Number(matches[0][1])];
      }));
      if (counts.tests < 1 || counts.pass !== counts.tests || counts.fail || counts.cancelled || counts.skipped) {
        throw verificationFault("check-failed");
      }
      if (!same(await sourceSnapshot(root), source)) throw verificationFault("source-changed");
    }
  }
}

async function main(file) {
  const configuration = await configurationFrom(path.resolve(file));
  const candidateEnvironment = isolatedCandidateEnvironment(configuration, process.env);
  if (candidateEnvironment.DEVPOCKET_PROBE_PYTHON) process.env.DEVPOCKET_PROBE_PYTHON = candidateEnvironment.DEVPOCKET_PROBE_PYTHON;
  const ownerEnvironment = { ...process.env };
  const directory = path.join(controlRoot, ".data", "ci", "isolated");
  await mkdir(directory, { recursive: true });
  const boundary = isolatedCommandBoundary(configuration, ownerEnvironment, candidateEnvironment);
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    await withGitExecutable(configuration.tools.git, ownerEnvironment, () =>
      withCommandBoundary((file, args, options, execute) =>
        boundary(file, args,
          { ...options, signal: options.signal ?? cancellation.signal }, execute), async () => {
        const context = configuration.mode === "worker" ? await isolatedContext(configuration.candidate) : null;
        const plan = context ? await verificationPlan(configuration.candidate, context.request.base, false, { trustedTooling: true }) : null;
        bootstrapPhase = "native-launch";
        const launch = await runCommand(configuration.tools.node,
          ["--disable-sigusr1", "-e", "process.stdout.write('DEVPOCKET_ISOLATED_LAUNCH')"],
          { cwd: controlRoot, timeoutMs: 30000 });
        assert.equal(launch.stdout, "DEVPOCKET_ISOLATED_LAUNCH");
        const proof = await proveIsolation(configuration, directory);
        await immutableJson(path.join(directory, "isolation-proof.json"), proof);
        if (configuration.mode === "self-test") return;
        if (!plan.requiredGroups.includes(configuration.group)) throw new Error("The trusted plan did not select this worker.");
        let result;
        try {
          await installCandidate(configuration);
          if (!same(await sourceSnapshot(configuration.candidate), plan.source)) throw verificationFault("source-changed");
          result = await executeVerification(configuration.candidate, plan, {
            group: configuration.group, evidenceRoot: controlRoot, directory: path.join(directory, "checks"),
            deviceDirectory: path.join(configuration.candidate, ".data", "ci", "isolated-device"),
            trustedToolingRunner: path.join(controlRoot, "scripts", "test-workflow.mjs"), isolatedTooling: true,
            operationsPython: candidateEnvironment.DEVPOCKET_PROBE_PYTHON,
            jdk: process.env.JAVA_HOME, sdk: process.env.ANDROID_HOME, image: "system-images/android-35/google_apis/x86_64",
            signal: cancellation.signal,
            deviceCleanup: async (root, device, owner) => {
              const entry = pathToFileURL(path.join(controlRoot, "scripts", "device-run.mjs")).href;
              const output = await runCommand(configuration.tools.node, ["--input-type=module", "-e",
                `import {cleanDeviceRun} from ${JSON.stringify(entry)}; console.log(JSON.stringify(await cleanDeviceRun(...process.argv.slice(1))));`,
                root, device, owner], { cwd: root, timeoutMs: 30000, signal: AbortSignal.timeout(30000) });
              if (!["true", "false"].includes(output.stdout.trim())) throw verificationFault("cleanup-failed");
              return JSON.parse(output.stdout);
            },
          });
          if (["passed", "partial"].includes(result.status)) await stageCandidateApks(configuration, directory);
        } catch (error) {
          result = { ...(result ?? plan), group: configuration.group, status: "blocked", complete: false,
            checks: result?.checks ?? plan.requiredChecks.map((id) => ({ id, status: "not_run" })),
            failure: verificationFailure(error, error.verificationContext?.phase ?? "preflight") };
        }
        await immutableJson(path.join(directory, "report.json"), { ...result, isolation: proof });
        if (!["passed", "partial"].includes(result.status)) {
          process.exitCode = 1;
          console.error(JSON.stringify({ status: result.status, failure: result.failure ?? null, preflight: result.preflight ?? null }));
          for (const check of result.checks.filter((check) => ["failed", "blocked"].includes(check.status))) {
            console.error(JSON.stringify({ check: check.id, failure: check.failure ?? null }));
            if (check.privateLog?.availability === "retained") {
              await printFailureTail(path.join(directory, "checks", `${check.id}.log`));
            }
          }
        }
      }));
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { configuration: { type: "string" } } });
    if (!values.configuration) throw new Error("A private bootstrap configuration is required.");
    await main(values.configuration);
  } catch (error) {
    try { await retainBootstrapFailure(error); }
    catch (diagnosticError) {
      console.error(JSON.stringify({ status: "blocked", phase: "isolated-worker", failure: failureDetails(error),
        diagnosticFailure: failureDetails(diagnosticError, "report-write") }));
    }
    process.exitCode = 78;
  }
}
