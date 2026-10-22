import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runCommand, spawnOwnedCommand, stopOwnedProcess, withCommandBoundary } from "./process.mjs";
import { git, sourceSnapshot, withGitExecutable } from "./git-state.mjs";
import { executeVerification, verificationPlan, combineVerification, verificationFault, verificationFailure } from "./verification.mjs";
import { isolatedContext } from "./isolated-verification.mjs";
import { WORKFLOW_TEST_FILES } from "./test-workflow.mjs";
import { LINUX_CANDIDATE_PLATFORM_TESTS, LINUX_PRIVILEGED_PLATFORM_TESTS } from "./backend-diagnostics.mjs";
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

function matchingExitCode(platform, reported, observed) {
  if (!Number.isInteger(reported) || !Number.isInteger(observed)) return false;
  if (platform !== "win32") return reported === observed;
  const dword = (value) => value >= -2147483648 && value <= 4294967295;
  return dword(reported) && dword(observed) && (reported >>> 0) === (observed >>> 0);
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

async function immutableJson(file, value, maximum = 1024 * 1024, signal) {
  const bytes = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(bytes) > maximum) throw new Error("Isolated worker evidence exceeded its bound.");
  signal?.throwIfAborted();
  const output = await open(file, "wx", 0o600);
  let failure;
  try { await output.writeFile(bytes); await output.sync(); }
  catch (error) { failure = error; }
  try { await output.close(); }
  catch (error) { failure = failure ? new AggregateError([failure, error], "Isolated worker evidence could not be closed.") : error; }
  if (signal?.aborted) {
    failure = failure ? new AggregateError([failure, signal.reason], "Isolated worker evidence publication was cancelled.") : signal.reason;
  }
  if (failure) {
    try { await unlink(file); }
    catch (error) { throw new AggregateError([failure, error], "Failed isolated worker evidence could not be invalidated."); }
    throw failure;
  }
  return digest(bytes);
}

async function configurationFrom(file) {
  const config = await readDiagnosticReport(file, { maximum: 65536 });
  if (config.version !== 1 || config.platform !== process.platform || config.control !== controlRoot ||
      !["worker", "self-test", "atomic-launch-probe"].includes(config.mode) ||
      config.mode === "atomic-launch-probe" && config.platform !== "win32" ||
      !["tooling", "backend", "android", "device"].includes(config.group) ||
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
  if (config.platform === "win32") {
    const broker = config.broker;
    if (!broker || !path.isAbsolute(broker.file) || !(await lstat(broker.file)).isFile() ||
        path.dirname(broker.configuration ?? "") !== config.private || !/^[a-f0-9]{64}$/.test(broker.sha256 ?? "") ||
        digest(await readFile(broker.configuration)) !== broker.sha256) {
      throw new Error("The private Windows service configuration is unavailable or changed.");
    }
    if (config.mode !== "atomic-launch-probe" && config.desktopProbe !== broker.file) {
      throw new Error("The fixed Windows desktop capability probe is missing.");
    }
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
    const requestSha256 = await immutableJson(requestFile, request, 65536);
    const broker = configuration.platform === "win32" ? configuration.broker : null;
    let result, failure, receipt, dispatched = false;
    try {
      options.signal?.throwIfAborted();
      const windows = configuration.platform === "win32";
      dispatched = true;
      result = await execute(broker ? broker.file : windows ? configuration.tools.pwsh : configuration.tools.python3,
        broker ? ["--client", broker.configuration, broker.sha256, requestFile]
          : windows ? ["-NoProfile", "-NonInteractive", "-File", path.join(controlRoot, "scripts", "isolated-command.ps1"),
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
    const admissionKnown = ["not-admitted", "creation-attempted", "created", "running"].includes(receipt?.admission) &&
        receipt.started === (receipt.admission === "running");
    const interruptionKnown = receipt?.interruption == null || ["cancelled", "timeout"].includes(receipt.interruption);
    const outcome = result?.commandOutcome ?? failure?.commandOutcome;
    const outerStopped = (result?.processTreeStopped ?? failure?.processTreeStopped) === true;
    const consistent = receipt?.version === 1 && receipt.id === id &&
      (!broker || receipt.requestSha256 === requestSha256) && admissionKnown && interruptionKnown &&
      (receipt.outputTruncated === undefined || typeof receipt.outputTruncated === "boolean") &&
      (receipt.outputTruncated !== true || receipt.status === "blocked" && receipt.started === true) &&
      typeof receipt.processTreeStopped === "boolean" &&
      (receipt.status === "blocked" && receipt.exitCode === null ||
        receipt.status === "executed" && receipt.started === true && Number.isInteger(receipt.exitCode) &&
          (!receipt.processTreeStopped || !outerStopped || matchingExitCode(configuration.platform, receipt.exitCode, outcome?.exitCode)));
    const nativeFacts = consistent
      ? { isolatedAdmission: receipt.admission, nativeFailure: nativeFailure(receipt.native) } : {};
    const stopped = consistent && receipt.processTreeStopped === true && outerStopped;
    if (outcome?.reason !== "timeout" && stopped &&
        (outcome?.reason === "output-limit" || receipt.outputTruncated === true)) {
      throw Object.assign(verificationFault("output-limit"), {
        processTreeStopped: true, isolatedAdmission: receipt.admission,
        stdout: result?.stdout ?? failure?.stdout ?? "", stderr: result?.stderr ?? failure?.stderr ?? "",
        commandOutcome: { ...outcome, reason: "output-limit", outputTruncated: true, cleanupFailure: null },
      });
    }
    if (outcome?.reason !== "timeout" && (options.signal?.aborted || receipt?.interruption === "cancelled") && stopped) {
      throw Object.assign(new Error("Isolated command was cancelled.", { cause: options.signal?.reason }),
        { processTreeStopped: true, stdout: failure?.stdout ?? "", stderr: failure?.stderr ?? "",
          isolatedAdmission: receipt.admission,
          commandOutcome: { ...(failure?.commandOutcome ?? result?.commandOutcome), reason: "cancelled", cleanupFailure: null } });
    }
    if ((outcome?.reason === "timeout" || receipt?.interruption === "timeout") && stopped) {
      throw Object.assign(verificationFault("command-timeout"), {
        processTreeStopped: true, isolatedAdmission: receipt.admission,
        stdout: failure?.stdout ?? "", stderr: failure?.stderr ?? "",
        commandOutcome: { ...(failure?.commandOutcome ?? result?.commandOutcome), reason: "timeout", cleanupFailure: null },
      });
    }
    if (receipt?.status === "blocked" && stopped) {
      throw Object.assign(verificationFault("preflight-tool", { phase: "preflight" }), {
        processTreeStopped: true, stdout: failure?.stdout ?? "", stderr: failure?.stderr ?? "",
        ...nativeFacts,
        commandOutcome: { ...(failure?.commandOutcome ?? result?.commandOutcome), reason: "spawn", cleanupFailure: null },
      });
    }
    if (!stopped || receipt.status !== "executed" || receipt.started !== true || !Number.isInteger(receipt.exitCode) ||
        !matchingExitCode(configuration.platform, receipt.exitCode, outcome?.exitCode)) {
      throw Object.assign(verificationFault("cleanup-failed"), { ...nativeFacts, processTreeStopped: false,
        stdout: result?.stdout ?? failure?.stdout ?? "", stderr: result?.stderr ?? failure?.stderr ?? "",
        commandOutcome: { ...(result?.commandOutcome ?? failure?.commandOutcome), reason: "spawn",
          cleanupFailure: failureDetails(verificationFault("cleanup-failed")) } });
    }
    if (failure) {
      failure.isolatedExecutionObserved = true;
      failure.isolatedAdmission = receipt.admission;
      throw failure;
    }
    return { ...result, isolatedAdmission: receipt.admission, isolatedExecutionObserved: true };
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
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "bootstrap-failure.log");
  const privateLog = await writeBoundedWorkerLog(file, `${error.stdout ?? ""}${error.stderr ?? ""}`);
  const report = { version: 1, kind: "isolated-bootstrap-diagnostics", acceptance: false,
    status: "blocked", phase: bootstrapPhase, failure: failureDetails(error),
    admission: ["not-admitted", "creation-attempted", "created", "running"].includes(error.isolatedAdmission)
      ? error.isolatedAdmission : null,
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
  if (configuration.platform === "win32") {
    assert.equal(configuration.permissionOnlyPaths?.length, 2);
    assert.ok(configuration.permissionOnlyPaths.every((item) => configuration.protectedPaths.includes(item)));
  }
  const input = { fixture, runner, evidence, marker, supervisorPid: process.pid, files: WORKFLOW_TEST_FILES,
    probe: path.join(controlRoot, "scripts", "isolated-worker-probe.mjs"), protectedPaths: configuration.protectedPaths,
    permissionOnlyPaths: configuration.permissionOnlyPaths ?? [], protectedReadFiles: configuration.protectedReadFiles ?? [] };
  if (configuration.platform === "win32") {
    bootstrapPhase = "public-network";
    const network = await runCommand(configuration.tools.node, ["--disable-sigusr1", "-e",
      "const request=require('node:https').get('https://registry.npmjs.org/-/ping',response=>{" +
      "response.resume();response.on('end',()=>{if(response.statusCode===200)process.stdout.write('DEVPOCKET_ISOLATED_NETWORK');" +
      "else process.exitCode=1;});});request.setTimeout(15000,()=>request.destroy(new Error('Network deadline')));" +
      "request.on('error',error=>{console.error(error.code??'NETWORK_CHECK_FAILED');process.exitCode=1;});"],
    { cwd: fixture, timeoutMs: 30000 });
    assert.equal(network.stdout, "DEVPOCKET_ISOLATED_NETWORK");
  }
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
  assert.equal(attacks.length, configuration.protectedPaths.length * 4 + input.protectedReadFiles.length + 5);
  assert.deepEqual(attacks.filter((item) => item.name === "evidence-read"), [{ name: "evidence-read", denied: true }]);
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

async function windowsSupervisorChecks(configuration, ownerEnvironment, candidateEnvironment, signal) {
  signal?.throwIfAborted();
  const broker = configuration.broker, probe = path.join(controlRoot, "scripts", "isolated-worker-probe.mjs");
  const runner = path.join(controlRoot, "scripts", "test-workflow.mjs");
  const supervisorConfiguration = await readDiagnosticReport(broker.configuration);
  const bounded = async (promise, message, operationSignal = signal) => {
    let timer, abort;
    try {
      operationSignal?.throwIfAborted();
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 15000);
        abort = () => reject(operationSignal.reason);
        operationSignal?.addEventListener("abort", abort, { once: true });
      })]);
    } finally {
      clearTimeout(timer);
      if (abort) operationSignal?.removeEventListener("abort", abort);
    }
  };
  const openPeer = async () => {
    signal?.throwIfAborted();
    const socket = createConnection({ path: `\\\\.\\pipe\\${supervisorConfiguration.commandPipe}`, allowHalfOpen: true, signal });
    let failure;
    socket.on("error", (error) => { failure = error; });
    try {
      await bounded(new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      }), "The diagnostic peer did not connect.");
      return { socket, failure: () => failure };
    } catch (error) { socket.destroy(); throw error; }
  };
  const prepare = async (args) => {
    signal?.throwIfAborted();
    const id = randomUUID(), file = path.join(configuration.private, `${id}.json`);
    const request = { version: 1, id, file: configuration.tools.node, arguments: args,
      cwd: configuration.fixture, timeoutMs: 30000, environment: candidateEnvironment, identity: configuration.identity };
    const requestSha256 = await immutableJson(file, request, 65536);
    return { id, file, requestSha256, arguments: ["--client", broker.configuration, broker.sha256, file] };
  };
  const execute = (request, commandSignal = signal) => {
    signal?.throwIfAborted();
    return runCommand(broker.file, request.arguments, { cwd: controlRoot, env: ownerEnvironment, timeoutMs: 35000, signal: commandSignal });
  };
  const waitFor = async (file) => {
    const deadline = Date.now() + 15000;
    while (true) {
      signal?.throwIfAborted();
      try { await lstat(file); signal?.throwIfAborted(); return; }
      catch (error) { if (error.code !== "ENOENT" || Date.now() >= deadline) throw error; }
      await delay(20, undefined, { signal });
    }
  };
  const receipt = async (request) => {
    await waitFor(`${request.file}.result.json`);
    const value = await readDiagnosticReport(`${request.file}.result.json`, { maximum: 4096 });
    assert.equal(value.version, 1);
    assert.equal(value.id, request.id);
    assert.equal(value.requestSha256, request.requestSha256);
    assert.equal(value.started, true);
    assert.equal(value.admission, "running");
    assert.equal(typeof value.processTreeStopped, "boolean");
    assert.ok(value.status === "blocked" && value.exitCode === null ||
      value.status === "executed" && Number.isInteger(value.exitCode));
    return value;
  };
  const stableCounter = async (counter) => {
    signal?.throwIfAborted();
    const bytes = await readFile(counter);
    assert.equal(JSON.parse(bytes).denied, true);
    await delay(300, undefined, { signal });
    assert.deepEqual(await readFile(counter), bytes);
  };
  const counter = path.join(configuration.fixture, ".data", `service-operations-${randomUUID()}`);
  const append = ["--disable-sigusr1", "-e",
    `require('node:fs').appendFileSync(${JSON.stringify(counter)},'1');process.stdout.write('SERVICE_COMMAND')`];
  bootstrapPhase = "supervisor-sequential-commands";
  const first = await prepare(append);
  assert.equal((await execute(first)).stdout, "SERVICE_COMMAND");
  const firstReceipt = await receipt(first);
  assert.equal(firstReceipt.processTreeStopped, true);
  assert.equal(firstReceipt.status, "executed");
  const second = await prepare(append);
  assert.equal((await execute(second)).stdout, "SERVICE_COMMAND");
  assert.equal((await receipt(second)).processTreeStopped, true);
  assert.equal(await readFile(counter, "utf8"), "11");
  bootstrapPhase = "supervisor-held-client";
  const heldRequest = await prepare(append), peer = await openPeer();
  try {
    const completion = new Promise((resolve, reject) => {
      let text = "";
      peer.socket.on("data", (bytes) => {
        if (Buffer.byteLength(text) + bytes.length > 64) {
          reject(new Error("An oversized supervisor response was received."));
          peer.socket.destroy();
          return;
        }
        text += bytes.toString("utf8");
        if (text.endsWith("\n")) resolve(text.trim());
      });
      peer.socket.once("end", () => reject(new Error("The supervisor closed before acknowledging the command.")));
      peer.socket.once("error", reject);
    });
    signal?.throwIfAborted();
    peer.socket.write(JSON.stringify({ id: heldRequest.id, sha256: heldRequest.requestSha256,
      nonce: supervisorConfiguration.nonce }) + "\n");
    assert.equal(await bounded(completion, "The held client did not receive completion."), "complete");
    assert.equal((await receipt(heldRequest)).processTreeStopped, true);
    assert.equal((await execute(await prepare(append))).stdout, "SERVICE_COMMAND");
    assert.equal(await readFile(counter, "utf8"), "1111");
    const failure = peer.failure();
    if (failure && !["EPIPE", "ECONNRESET"].includes(failure.code)) throw failure;
  } finally { peer.socket.destroy(); }
  bootstrapPhase = "supervisor-header-eof";
  const closedPeer = await openPeer();
  closedPeer.socket.destroy();
  assert.equal((await execute(await prepare(append))).stdout, "SERVICE_COMMAND");
  assert.equal(await readFile(counter, "utf8"), "11111");
  bootstrapPhase = "supervisor-replay";
  const retained = await readFile(`${first.file}.result.json`);
  await assert.rejects(execute(first), (error) => error.processTreeStopped === true && error.commandOutcome?.exitCode !== 0);
  assert.deepEqual(await readFile(`${first.file}.result.json`), retained);
  assert.equal(await readFile(counter, "utf8"), "11111");
  bootstrapPhase = "supervisor-admitted-peer-eof";
  const eofCounter = path.join(configuration.fixture, ".data", `peer-eof-${randomUUID()}.json`);
  const eofRequest = await prepare([probe, "descendant", JSON.stringify({ counter: eofCounter, runner })]);
  const eofPeer = await openPeer();
  try {
    signal?.throwIfAborted();
    eofPeer.socket.write(JSON.stringify({ id: eofRequest.id, sha256: eofRequest.requestSha256,
      nonce: supervisorConfiguration.nonce }) + "\n");
    await waitFor(eofCounter);
  } finally { eofPeer.socket.destroy(); }
  const eofResult = await receipt(eofRequest);
  assert.equal(eofResult.status, "blocked");
  assert.equal(eofResult.interruption, "cancelled");
  assert.equal(eofResult.processTreeStopped, true);
  await stableCounter(eofCounter);
  assert.equal((await execute(await prepare(append))).stdout, "SERVICE_COMMAND");
  bootstrapPhase = "supervisor-output-limit";
  const noisy = await prepare(["--disable-sigusr1", "-e", "process.stdout.write('x'.repeat(16*1024*1024+8192))"]);
  await assert.rejects(execute(noisy), (error) => error.processTreeStopped === true);
  const limited = await receipt(noisy);
  assert.equal(limited.outputTruncated, true);
  assert.equal(limited.processTreeStopped, true);
  assert.equal(limited.status, "blocked");
  assert.ok((await lstat(`${noisy.file}.stdout`)).size + (await lstat(`${noisy.file}.stderr`)).size <= 16 * 1024 * 1024);
  bootstrapPhase = "supervisor-caller-crash";
  const callerCounter = path.join(configuration.fixture, ".data", `caller-crash-${randomUUID()}.json`);
  const caller = await prepare([probe, "descendant", JSON.stringify({ counter: callerCounter, runner })]);
  signal?.throwIfAborted();
  const child = spawnOwnedCommand(broker.file, caller.arguments,
    { cwd: controlRoot, env: ownerEnvironment, timeoutMs: 35000, cancelled: signal?.aborted ?? false });
  child.stdout.resume();
  child.stderr.resume();
  let inputFailure;
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") inputFailure = error; });
  const closed = new Promise((resolve) => { child.once("close", () => resolve(null)); child.once("error", resolve); });
  let crashed = false;
  try {
    await waitFor(callerCounter);
    signal?.throwIfAborted();
    crashed = child.kill();
    assert.equal(crashed, true);
    const closedError = await bounded(closed, "The crashed caller retained its output handles.");
    if (closedError) throw closedError;
    if (inputFailure) throw inputFailure;
    const stopped = await receipt(caller);
    assert.equal(stopped.status, "blocked");
    assert.equal(stopped.processTreeStopped, true);
    await stableCounter(callerCounter);
  } finally {
    if (!crashed && child.exitCode === null && child.signalCode === null) await stopOwnedProcess(child);
    if (crashed) {
      const cleanupError = await bounded(closed, "The crashed caller did not release its handles during cleanup.", null);
      if (cleanupError) throw cleanupError;
    }
  }
  bootstrapPhase = "supervisor-crash";
  const serviceCounter = path.join(configuration.fixture, ".data", `service-crash-${randomUUID()}.json`);
  const serviceRequest = await prepare([probe, "descendant", JSON.stringify({ counter: serviceCounter, runner })]);
  const serviceCancellation = new AbortController();
  const serviceSignal = signal ? AbortSignal.any([signal, serviceCancellation.signal]) : serviceCancellation.signal;
  const serviceOutcome = execute(serviceRequest, serviceSignal).then(() => ({ unexpectedSuccess: true }), (error) => error);
  try {
    await waitFor(serviceCounter);
    const service = await readDiagnosticReport(path.join(configuration.private, "service-capabilities.json"));
    assert.ok(Number.isSafeInteger(service.servicePid) && service.servicePid > 0);
    assert.equal(JSON.parse(await readFile(serviceCounter, "utf8")).parentPid, service.servicePid);
    const stopFile = path.join(configuration.private, `stop-service-${randomUUID()}.ps1`);
    await writeFile(stopFile, [
      "param([int]$ServicePid, [string]$ServiceName, [string]$Executable)",
      "$ErrorActionPreference = 'Stop'",
      "if ($ServiceName -notmatch '^dpws_[a-f0-9]{24}$') { throw 'Invalid task service' }",
      "$target = Get-Process -Id $ServicePid",
      "try {",
      "  $null = $target.Handle",
      "  $service = @(Get-CimInstance Win32_Service -Filter \"Name='$ServiceName'\")",
      "  if ($service.Count -ne 1 -or $service[0].ProcessId -ne $target.Id -or $target.Path -ne $Executable) { throw 'Service identity changed' }",
      "  Stop-Process -Id $target.Id -Force",
      "  if (!$target.WaitForExit(10000)) { throw 'The task service did not exit' }",
      "} finally { $target.Dispose() }",
      "'SERVICE_STOPPED'",
    ].join("\n"), { flag: "wx", mode: 0o600 });
    signal?.throwIfAborted();
    const terminated = await runCommand(configuration.tools.pwsh,
      ["-NoProfile", "-NonInteractive", "-File", stopFile, "-ServicePid", String(service.servicePid),
        "-ServiceName", supervisorConfiguration.service, "-Executable", broker.file],
      { cwd: controlRoot, env: ownerEnvironment, timeoutMs: 30000, signal });
    assert.equal(terminated.stdout.trim(), "SERVICE_STOPPED");
    const crashedService = await serviceOutcome;
    assert.equal(crashedService.unexpectedSuccess, undefined);
    assert.equal(crashedService.processTreeStopped, true, "The client owner still needs its own cleanup confirmation.");
    await assert.rejects(readFile(`${serviceRequest.file}.result.json`), { code: "ENOENT" });
    await stableCounter(serviceCounter);
  } finally {
    serviceCancellation.abort();
    await serviceOutcome;
  }
  signal?.throwIfAborted();
  return {
    version: 1, kind: "windows-supervisor-lifecycle", status: "passed", acceptance: false,
    checks: ["sequential-commands", "retained-client-handle", "pre-header-eof", "admitted-peer-eof", "replay-refusal",
      "bounded-output", "caller-crash-cleanup", "service-crash-job-close"],
    serviceCrashReceipt: "missing-as-expected", candidateCleanup: "requires-bootstrap-account-sweep",
  };
}

async function stageCandidateApks(configuration, directory) {
  if (!["android", "device"].includes(configuration.group)) return;
  const destination = path.join(directory, "artifacts");
  await mkdir(destination, { mode: 0o700 });
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

export async function runIsolatedPlatformChecks(configuration, root, files, signal) {
  const source = await sourceSnapshot(root), checks = [];
  for (const file of files) {
    const startedAt = new Date().toISOString();
    const output = await runCommand(configuration.tools.node, ["--disable-sigusr1", "--test", "--test-reporter=tap", file],
      { cwd: root, timeoutMs: 10 * 60_000, signal });
    const counts = Object.fromEntries(["tests", "pass", "fail", "cancelled", "skipped"].map((name) => {
      const matches = [...output.stdout.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, "gm"))];
      if (matches.length !== 1) throw verificationFault("collector-failed");
      return [name, Number(matches[0][1])];
    }));
    if (counts.tests < 1 || counts.pass !== counts.tests || counts.fail || counts.cancelled || counts.skipped ||
        output.processTreeStopped !== true) throw verificationFault("check-failed");
    if (!same(await sourceSnapshot(root), source)) throw verificationFault("source-changed");
    checks.push({ file, counts, startedAt, completedAt: new Date().toISOString(),
      exitCode: output.commandOutcome.exitCode, processTreeStopped: output.processTreeStopped });
  }
  return { source, checks };
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
    await runIsolatedPlatformChecks(configuration, root, LINUX_CANDIDATE_PLATFORM_TESTS);
  }
}

async function main(file) {
  const configuration = await configurationFrom(path.resolve(file));
  const candidateEnvironment = isolatedCandidateEnvironment(configuration, process.env);
  if (candidateEnvironment.DEVPOCKET_PROBE_PYTHON) process.env.DEVPOCKET_PROBE_PYTHON = candidateEnvironment.DEVPOCKET_PROBE_PYTHON;
  const ownerEnvironment = { ...process.env };
  const directory = path.join(controlRoot, ".data", "ci", "isolated");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const boundary = isolatedCommandBoundary(configuration, ownerEnvironment, candidateEnvironment);
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    await withGitExecutable(configuration.tools.git, ownerEnvironment, async () => {
      const context = configuration.mode === "worker" ? await isolatedContext(configuration.candidate) : null;
      const plan = context ? await verificationPlan(configuration.candidate, context.request.base, false, { trustedTooling: true }) : null;
      if (context && configuration.group === "device") {
        bootstrapPhase = "trusted-platform-preparation";
        const preparation = await runIsolatedPlatformChecks(configuration, controlRoot, LINUX_PRIVILEGED_PLATFORM_TESTS, cancellation.signal);
        await immutableJson(path.join(directory, "trusted-platform-preparation.json"), {
          version: 1, kind: "trusted-platform-preparation", acceptance: false,
          controllerSource: preparation.source, checks: preparation.checks,
        });
      }
      let selfTestProof;
      await withCommandBoundary((file, args, options, execute) =>
        boundary(file, args,
          { ...options, signal: options.signal ?? cancellation.signal }, execute), async () => {
        bootstrapPhase = "native-launch";
        const launch = await runCommand(configuration.tools.node,
          ["--disable-sigusr1", "-e", "process.stdout.write('DEVPOCKET_ISOLATED_LAUNCH')"],
          { cwd: controlRoot, timeoutMs: 30000 });
        assert.equal(launch.stdout, "DEVPOCKET_ISOLATED_LAUNCH");
        assert.equal(launch.isolatedAdmission, "running");
        assert.equal(launch.isolatedExecutionObserved, true);
        assert.equal(launch.processTreeStopped, true);
        assert.equal(launch.commandOutcome?.reason, "exit");
        assert.equal(launch.commandOutcome?.exitCode, 0);
        let desktopScope;
        if (configuration.platform === "win32" && configuration.desktopProbe) {
          bootstrapPhase = "shell-startup";
          const shell = await runCommand(configuration.tools.pwsh, ["--version"], { cwd: controlRoot, timeoutMs: 30000 });
          assert.match(shell.stdout.trim(), /^PowerShell \d+\.\d+/);
          bootstrapPhase = "desktop-scope";
          const service = (await readDiagnosticReport(path.join(configuration.private, "service-capabilities.json"))).desktopScope;
          assert.equal(service?.interactive, false);
          const candidates = [];
          for (let index = 0; index < 2; index++) {
            const output = await runCommand(configuration.desktopProbe, ["--desktop-scope"], { cwd: controlRoot, timeoutMs: 30000 });
            const observed = JSON.parse(output.stdout);
            assert.equal(observed.version, 1);
            assert.equal(observed.kind, "windows-desktop-scope");
            assert.equal(observed.sid, configuration.sid);
            assert.equal(observed.interactive, false);
            assert.equal(observed.sessionId, service.sessionId);
            assert.match(observed.authenticationId, /^[a-f0-9]{16}$/);
            assert.match(observed.logonSid, /^S-1-5-5-\d+-\d+$/);
            for (const name of ["windowStation", "desktop"]) {
              assert.equal(typeof observed[name], "string");
              assert.ok(observed[name].length > 0 && observed[name].length <= 256 && !/[\\\x00-\x1f]/.test(observed[name]));
            }
            for (const previous of [service, ...candidates]) {
              assert.notEqual(observed.authenticationId, previous.authenticationId);
              assert.notEqual(observed.logonSid, previous.logonSid);
              assert.notEqual(observed.windowStation, previous.windowStation);
            }
            candidates.push(observed);
          }
          desktopScope = { service, candidates };
        }
        const capability = { version: 1, kind: "atomic-launch-capability", acceptance: false,
          status: "available", platform: configuration.platform, admission: launch.isolatedAdmission,
          exitCode: launch.commandOutcome.exitCode, processTreeStopped: launch.processTreeStopped,
          ...(desktopScope ? { desktopScope } : {}) };
        if (configuration.platform === "win32") {
          await immutableJson(path.join(directory, "atomic-launch-capability.json"), capability);
          if (configuration.mode === "atomic-launch-probe") { console.log(JSON.stringify(capability)); return; }
          bootstrapPhase = "protected-ancestors";
          throw verificationFault("ownership-mismatch", { phase: "protected-ancestors" });
        }
        const proof = await proveIsolation(configuration, directory);
        if (desktopScope) proof.desktopScope = desktopScope;
        if (configuration.mode === "self-test") { selfTestProof = proof; return; }
        await immutableJson(path.join(directory, "isolation-proof.json"), proof, undefined, cancellation.signal);
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
      });
      if (configuration.mode === "self-test") {
        cancellation.signal.throwIfAborted();
        if (!selfTestProof) throw new Error("The isolated self-test did not complete its boundary proof.");
        if (configuration.platform === "win32") {
          selfTestProof.supervisorLifecycle = await windowsSupervisorChecks(configuration, ownerEnvironment, candidateEnvironment, cancellation.signal);
        }
        cancellation.signal.throwIfAborted();
        const proofFile = path.join(directory, "isolation-proof.json");
        await immutableJson(proofFile, selfTestProof, undefined, cancellation.signal);
        if (cancellation.signal.aborted) {
          try { await unlink(proofFile); }
          catch (error) { throw new AggregateError([cancellation.signal.reason, error], "Cancelled self-test proof could not be invalidated."); }
          cancellation.signal.throwIfAborted();
        }
      }
    });
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
