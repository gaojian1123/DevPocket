import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { commandCleanupConfirmed, listenForCommandCancellation, runCommand } from "./process.mjs";
import { commandDetails, failureDetails } from "./diagnostic-errors.mjs";
import { readOnlyGit, sourceSnapshot } from "./git-state.mjs";
import { requireVerificationOutputDirectory } from "./verification.mjs";
import {
  APPLE_NATIVE_REPORT_MAX_BYTES, APPLE_PROBES, APPLE_REQUIREMENTS, APPLE_RESULT_READINESS_MS,
  appleDeviceId, appleDevices, appleDigest, appleEnumerationArguments, appleJSON, appleResultManifestReference, appleTestSelection,
  appleXcodeArguments, inspectAppleScheme, inspectAppleToolchain, localAppleToolchain,
  normalizeAppleTestCatalog, normalizeAppleTestResult, selectAppleLocalTargets,
  projectAppleCleanupEvidence, projectAppleCommandOutput, projectAppleXcresult,
  requireApple, validateAppleNativeEvidence, validateApplePlan,
} from "./apple-evidence.mjs";

export function requireAppleCIEnvironment(environment, platform) {
  requireApple(platform === "darwin" && environment?.GITHUB_ACTIONS === "true" &&
    environment.RUNNER_ENVIRONMENT === "github-hosted",
  "Native Apple command execution is GitHub-hosted CI only. Use the original Xcode MCP locally.", "configuration");
}

export function parseAppleRunnerArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, "");
    requireApple(["repo", "plan", "directory"].includes(key) && args[index] === `--${key}` &&
      !Object.hasOwn(options, key) && typeof args[index + 1] === "string" &&
      args[index + 1].length > 0 && !args[index + 1].startsWith("--") && !args[index + 1].includes("\0"),
    "Use --repo ROOT --plan PLAN_JSON --directory OUTPUT_DIRECTORY, once each.", "configuration");
    options[key] = args[index + 1];
  }
  requireApple(Object.keys(options).length === 3, "All Apple runner arguments are required.", "configuration");
  return options;
}

export function appleRunnerOutputPath(root, directory) {
  requireApple(typeof directory === "string" && directory.length > 0 && !directory.includes("\0"),
    "An Apple output directory is required.", "ownership-mismatch");
  const absolute = path.resolve(root, directory), relative = path.relative(root, absolute).replaceAll("\\", "/");
  requireApple(/^\.data\/(?:verification|ci)\/[^/]+/.test(relative) &&
    relative.split("/").every((part) => part && part !== "." && part !== "..") &&
    !/^\.data\/verification\/local(?:\/|$)/.test(relative),
  "Apple outputs must use a new directory below this checkout's .data/verification or .data/ci.", "ownership-mismatch");
  return absolute;
}

async function checkedPath(root, file, directory = false) {
  const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
  requireApple(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative),
    "An Apple input or artifact is outside the checkout.", "ownership-mismatch");
  let current = root;
  const parts = relative.split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current);
    requireApple(!info.isSymbolicLink() && await realpath(current) === current &&
      (index < parts.length - 1 || directory ? info.isDirectory() : info.isFile() && info.nlink === 1),
    "Linked or nonregular Apple inputs and artifacts are unsupported.", "ownership-mismatch");
  }
  return absolute;
}

async function smallFile(root, file, maximum = 2 * 1024 * 1024) {
  const absolute = await checkedPath(root, file);
  requireApple((await lstat(absolute)).size <= maximum, "An Apple input exceeded its size limit.", "output-limit");
  return readFile(absolute, "utf8");
}

const copiedTreeReference = ({ path, producedBy, sha256 }) => ({ path, producedBy, sha256 });

export async function directoryArtifact(root, directory, producedBy) {
  const absolute = await checkedPath(root, directory, true), files = [];
  let totalBytes = 0;
  const walk = async (relative, depth = 0) => {
    requireApple(depth <= 30, "Apple artifact nesting exceeded its bound.", "output-limit");
    const entries = await readdir(path.join(absolute, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = path.join(relative, entry.name), file = path.join(absolute, name);
      requireApple(!entry.isSymbolicLink(), "Linked Apple artifact contents are unsupported.", "artifact-changed");
      if (entry.isDirectory()) { await checkedPath(root, file, true); await walk(name, depth + 1); continue; }
      requireApple(entry.isFile() && files.length < 20000, "Invalid or oversized Apple artifact.", "artifact-changed");
      await checkedPath(root, file);
      const before = await lstat(file), handle = await open(file, "r");
      try {
        const opened = await handle.stat();
        requireApple(opened.ino === before.ino && opened.dev === before.dev && opened.nlink === 1,
          "Apple artifact changed while opening it.", "artifact-changed");
        totalBytes += opened.size;
        requireApple(totalBytes <= 4 * 1024 ** 3, "Apple artifacts exceeded the retained byte budget.", "output-limit");
        const digest = createHash("sha256");
        for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
        for (const after of [await handle.stat(), await lstat(file)]) {
          requireApple(["dev", "ino", "size", "mode", "nlink", "mtimeMs", "ctimeMs"].every((key) => opened[key] === after[key]),
            "Apple artifact changed while hashing it.", "artifact-changed");
        }
        files.push({ path: name.replaceAll("\\", "/"), bytes: opened.size, sha256: digest.digest("hex") });
      } finally { await handle.close(); }
    }
  };
  await walk("");
  requireApple(files.length > 0 && await realpath(absolute) === absolute, "The original Apple artifact is empty or moved.", "artifact-changed");
  return { path: path.relative(root, absolute).replaceAll("\\", "/"), producedBy,
    sha256: appleDigest(appleJSON(files)), files };
}

export async function retainAppleResultManifest(root, manifest) {
  const bytes = appleJSON(manifest.files);
  requireApple(Buffer.byteLength(bytes) <= 16 * 1024 * 1024, "The native file manifest exceeded its bound.", "output-limit");
  const file = `${path.posix.dirname(manifest.path)}/result-files.json`;
  const reference = { path: file, bytes: Buffer.byteLength(bytes), sha256: appleDigest(bytes) };
  const result = appleResultManifestReference(manifest, reference);
  await checkedPath(root, path.dirname(file), true);
  await writeFile(path.join(root, file), bytes, { flag: "wx", mode: 0o600 });
  return result;
}

export async function waitForAppleResult(root, directory, commandId, signal) {
  const started = performance.now();
  const observation = { commandId, status: "waiting", timeoutMs: APPLE_RESULT_READINESS_MS,
    startedAt: new Date().toISOString(), completedAt: null, polls: 0 };
  try {
    while (performance.now() - started < APPLE_RESULT_READINESS_MS) {
      signal?.throwIfAborted();
      observation.polls++;
      try {
        const file = await checkedPath(root, path.join(directory, "Info.plist"));
        requireApple((await lstat(file)).size <= 2 * 1024 * 1024, "Native result metadata exceeded its bound.", "output-limit");
        const bytes = await readFile(file);
        if (bytes.length && performance.now() - started < APPLE_RESULT_READINESS_MS) {
          observation.status = "ready";
          observation.infoSha256 = appleDigest(bytes);
          return observation;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(100, undefined, { signal });
    }
    observation.status = "timeout";
    throw Object.assign(new Error("The completed native command did not finalize its result bundle in time."),
      { diagnosticCode: "apple-result-incomplete" });
  } catch (error) {
    if (observation.status === "waiting") observation.status = signal?.aborted ? "cancelled" : "failed";
    throw Object.assign(error, { appleResultReadiness: observation });
  } finally { observation.completedAt = new Date().toISOString(); }
}

export async function validateAppleLocalArtifacts(root, evidence, renderer) {
  const retained = async (reference, maximum = 16 * 1024 * 1024) => {
    const bytes = await smallFile(root, reference.path, maximum);
    requireApple(appleDigest(bytes) === reference.sha256 &&
      (reference.bytes === undefined || Buffer.byteLength(bytes) === reference.bytes),
    "An original local command artifact changed.", "artifact-changed");
    return bytes;
  };
  for (const command of evidence.commands) {
    const request = JSON.parse(await retained(command.request));
    requireApple(equal(request, { id: command.id, kind: command.kind, origin: command.origin,
      file: command.file, args: command.args, cwd: command.cwd, startedAt: command.startedAt,
      completedAt: null, status: "running", cleanup: "unknown" }), "The original command request changed.", "execution-origin");
    const response = JSON.parse(await retained(command.response)), { response: _response, ...expected } = command;
    requireApple(equal(response, expected), "The original command completion changed.", "execution-origin");
    const stdout = await retained(command.stdout), stderr = await retained(command.stderr);
    requireApple(equal(projectAppleCommandOutput(command, stdout, stderr), command.output),
      "A command projection differs from its retained output.", "artifact-changed");
  }
  for (const item of [...evidence.builds, ...evidence.tests]) {
    for (const reference of [item.resultBundle, item.retainedResultBundle,
      ...(item.action === "build" ? [item.product, item.retainedProduct] : [])]) {
      const actual = await directoryArtifact(root, reference.path, reference.producedBy);
      if (reference.fileManifest) {
        requireApple(equal(actual.files, JSON.parse(await retained(reference.fileManifest))) &&
          equal(appleResultManifestReference(actual, reference.fileManifest), reference),
        "The native file manifest or its original artifact changed.", "artifact-changed");
      } else {
        requireApple(equal(reference.files ? actual : copiedTreeReference(actual), reference),
          "An original or copied native artifact changed.", "artifact-changed");
      }
    }
    if (item.action === "test") {
      requireApple(equal(JSON.parse(await retained(item.catalog)), item.catalog.data),
        "The native catalogue changed.", "artifact-changed");
      continue;
    }
    const seal = JSON.parse(await retained(item.seal)), info = evidence.commands.find((command) => command.id === item.infoCommandId).output.data;
    requireApple(equal(seal.source, evidence.source) && seal.platform === item.platform &&
      seal.originalProduct === item.originalProduct && seal.signatureExitCode === 0 &&
      seal.bundleId === info.CFBundleIdentifier &&
      seal.minimumOS === (item.platform === "ios" ? info.MinimumOSVersion : info.LSMinimumSystemVersion) &&
      equal(seal.files, Object.fromEntries(item.product.files.map((file) => [file.path, file.sha256]))),
    "The accepted product seal differs from its native result.", "artifact-changed");
    const prefix = item.platform === "ios" ? "Renderer/" : "Contents/Resources/Renderer/";
    const packaged = item.product.files.filter((file) => file.path.startsWith(prefix))
      .map((file) => [file.path.slice(prefix.length), file.sha256]).sort();
    requireApple(equal(packaged, renderer.map(([file, identity]) => [file, identity.sha256]).sort()),
      "The normal product does not contain the captured offline renderer.", "artifact-changed");
  }
}

function ownedMatch(device, resource) {
  return device.name === resource.name && device.runtimeIdentifier === resource.runtimeIdentifier &&
    (!device.deviceTypeIdentifier || device.deviceTypeIdentifier === resource.deviceTypeIdentifier);
}

// The callback is mandatory and has no live default; unit tests use only in-memory command results.
export async function createAppleSimulator(selection, runId, resources, baselineInventory, invoke) {
  requireApple(appleDeviceId(runId) && APPLE_REQUIREMENTS.targets.some((target) => target.role === selection.role && target.role !== "mac"),
    "Invalid simulator owner or role.", "ownership-mismatch");
  const name = `DevPocket-${runId}-${selection.role}`;
  requireApple(!appleDevices(baselineInventory).some((device) => device.name === name) &&
    !resources.some((item) => item.role === selection.role), "The simulator name is already owned.", "ownership-mismatch");
  const resource = { role: selection.role, name, runtimeIdentifier: selection.runtimeIdentifier,
    deviceTypeIdentifier: selection.deviceTypeIdentifier, deviceId: null, cleanup: "unknown",
    createCommandId: `create-${selection.role}` };
  resources.push(resource);
  const created = await invoke(resource.createCommandId,
    ["simctl", "create", name, selection.deviceTypeIdentifier, selection.runtimeIdentifier]);
  const deviceId = created.stdout.text.trim();
  requireApple(appleDeviceId(deviceId), "Simulator creation returned no usable ID.", "ownership-mismatch");
  requireApple(!appleDevices(baselineInventory).some((device) => device.udid === deviceId) &&
    !resources.some((item) => item.deviceId === deviceId),
    "Simulator creation returned a pre-existing ID.", "ownership-mismatch");
  resource.deviceId = deviceId;
  resource.confirmCommandId = `confirm-${selection.role}`;
  const confirmed = await invoke(resource.confirmCommandId, ["simctl", "list", "devices", "--json"]);
  const devices = appleDevices(JSON.parse(confirmed.stdout.text)).filter((device) => device.udid === resource.deviceId);
  requireApple(devices.length === 1 && ownedMatch(devices[0], resource),
    "The created simulator identity is not confirmed; refusing to boot it.", "ownership-mismatch");
  resource.bootCommandId = `boot-${selection.role}`;
  await invoke(resource.bootCommandId, ["simctl", "boot", resource.deviceId]);
  resource.readyCommandId = `ready-${selection.role}`;
  await invoke(resource.readyCommandId, ["simctl", "bootstatus", resource.deviceId, "-b"]);
  return resource;
}

export async function cleanupAppleSimulators(resources, baselineInventory, invoke) {
  const result = { status: "completed", beforeCommandId: null, afterCommandId: null, failures: [] };
  if (!resources.length) return result;
  const baseline = appleDevices(baselineInventory);
  const failed = (error, role) => {
    result.failures.push({ error, role });
    result.status = "failed";
  };
  let current;
  try {
    result.beforeCommandId = "cleanup-before";
    current = appleDevices(JSON.parse((await invoke(result.beforeCommandId, ["simctl", "list", "devices", "--json"])).stdout.text));
  } catch (error) { failed(error); result.status = "unknown"; return result; }
  for (const resource of resources) {
    try {
      // A timed-out create can have succeeded. Recover only its unique new name, never a baseline device.
      const matches = current.filter((device) => resource.deviceId ? device.udid === resource.deviceId : device.name === resource.name);
      requireApple(matches.length <= 1 && (!matches.length || ownedMatch(matches[0], resource)) &&
        !baseline.some((device) => device.udid === resource.deviceId || device.name === resource.name),
      "Simulator cleanup cannot establish exclusive ownership.", "ownership-mismatch");
      if (!matches.length) { resource.cleanup = "completed"; continue; }
      const device = matches[0];
      requireApple(!baseline.some((item) => item.udid === device.udid), "Refusing to delete a pre-existing simulator.", "ownership-mismatch");
      if (!resource.deviceId) { resource.deviceId = device.udid; resource.recoveredAfterCreate = true; }
      if (device.state !== "Shutdown") {
        resource.shutdownCommandId = `shutdown-${resource.role}`;
        try { await invoke(resource.shutdownCommandId, ["simctl", "shutdown", resource.deviceId]); }
        catch (error) { failed(error, resource.role); }
      }
      resource.deleteCommandId = `delete-${resource.role}`;
      await invoke(resource.deleteCommandId, ["simctl", "delete", resource.deviceId]);
    } catch (error) { resource.cleanup = "failed"; failed(error, resource.role); }
  }
  try {
    result.afterCommandId = "cleanup-after";
    const remaining = appleDevices(JSON.parse((await invoke(result.afterCommandId, ["simctl", "list", "devices", "--json"])).stdout.text));
    for (const resource of resources) {
      if (resource.cleanup === "failed") continue;
      resource.cleanup = remaining.some((device) => device.udid === resource.deviceId || device.name === resource.name)
        ? "failed" : "completed";
      if (resource.cleanup === "failed") failed(Object.assign(new Error("An owned simulator remains after cleanup."),
        { diagnosticCode: "cleanup-failed" }), resource.role);
    }
  } catch (error) { failed(error); result.status = "unknown"; }
  return result;
}

export async function runAppleCI(options) {
  // These values are always read from the real process, not options or a test-injected executor.
  requireAppleCIEnvironment(process.env, process.platform);
  return runAppleNative(options);
}

export async function runAppleLocalCommands(options) {
  requireApple(process.platform === "darwin" && process.env.GITHUB_ACTIONS !== "true",
    "Local Apple commands require the local Mac entry, not a hosted-CI identity.", "configuration");
  const root = await realpath(path.resolve(options.repo));
  const local = JSON.parse(await smallFile(root, options.plan));
  requireApple(local?.kind === "local-apple-plan" && local.status === "planned" &&
    local.selection?.testMode === "xcodebuild" && local.context?.workspace === root &&
    Array.isArray(local.selection.tests) && local.selection.tests.length === 4,
  "Local commands require a fresh, source-bound xcodebuild plan.", "configuration");
  return runAppleNative(options, local);
}

async function runAppleNative(options, local) {
  const root = await realpath(path.resolve(options.repo));
  requireApple(root === await realpath(fileURLToPath(new URL("..", import.meta.url))) &&
    root === (await readOnlyGit(root, ["rev-parse", "--show-toplevel"])).trim(),
  "The Apple runner must operate in its own checkout.", "ownership-mismatch");
  const plan = validateApplePlan(local
    ? { base: local.base, source: local.context.source, apple: local.apple }
    : JSON.parse(await smallFile(root, options.plan)));
  const output = appleRunnerOutputPath(root, options.directory);
  if (local) requireApple(output.startsWith(path.resolve(root, local.directory) + path.sep) &&
    path.relative(root, output).replaceAll("\\", "/").startsWith(".data/verification/"),
  "Local native execution must use a fresh child directory of its plan.", "ownership-mismatch");
  await requireVerificationOutputDirectory(root, output);
  await mkdir(output, { recursive: true });
  await requireVerificationOutputDirectory(root, output);
  requireApple((await readdir(output)).length === 0, "Apple output directories cannot be reused.", "run-output-reused");
  const directory = path.relative(root, output).replaceAll("\\", "/"), runId = local?.runId ?? randomUUID();
  await writeFile(path.join(output, "apple-owner.json"), appleJSON({ runId, base: plan.base, source: plan.source }),
    { flag: "wx", mode: 0o600 });
  await mkdir(path.join(output, "logs"));
  await mkdir(path.join(output, "scratch"));
  const report = {
    version: 1, kind: "apple-native-evidence", origin: local ? "local-xcodebuild" : "ci-xcodebuild", runId, workspace: root, directory,
    base: plan.base, source: plan.source, sourceBefore: null, sourceAfter: null, apple: APPLE_REQUIREMENTS,
    startedAt: new Date().toISOString(), completedAt: null, status: "blocked", cleanup: "unknown",
    ...(!local ? { ci: { githubActions: process.env.GITHUB_ACTIONS, runnerEnvironment: process.env.RUNNER_ENVIRONMENT,
      platform: process.platform, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      job: process.env.GITHUB_JOB, repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA } } : {}),
    commands: [], builds: ["ios", "macos"].map((platform) => ({ platform, status: "blocked", reason: "not-run" })),
    tests: APPLE_REQUIREMENTS.targets.map(({ role }) => ({ role, status: "blocked", reason: "not-run" })),
    resources: [], failures: [],
  };
  if (local) {
    const request = await smallFile(root, options.request);
    await writeFile(path.join(output, "execution-request.json"), request, { flag: "wx", mode: 0o600 });
    report.local = { platform: process.platform, targets: local.selection.tests,
      plan: { path: path.relative(root, path.resolve(root, options.plan)).replaceAll("\\", "/"),
        sha256: appleDigest(await smallFile(root, options.plan)) },
      executionRequest: { path: `${directory}/execution-request.json`, sha256: appleDigest(request) } };
  }
  let overflowed = false, overflowSequence = 0;
  const overflowError = () => Object.assign(new Error("Apple evidence exceeds its publication budget; full evidence is retained separately."),
    { diagnosticCode: "output-limit" });
  const publish = async () => {
    let content = appleJSON(report);
    if (overflowed || Buffer.byteLength(content) > APPLE_NATIVE_REPORT_MAX_BYTES) {
      if (!overflowed) {
        overflowed = true;
        const error = overflowError();
        report.failures.push({ phase: "report", ...failureDetails(error), message: error.message });
      }
      report.status = "failed";
      const details = appleJSON(report), file = `${directory}/apple-report-details-${++overflowSequence}.json`;
      await writeFile(path.join(root, file), details, { flag: "wx", mode: 0o600 });
      const error = overflowError();
      const { version, kind, origin, runId, base, source, sourceBefore, sourceAfter, apple,
        workspace, startedAt, completedAt, cleanup } = report;
      content = appleJSON({ version, kind, origin, runId, base, source, sourceBefore, sourceAfter, apple,
        workspace, directory, startedAt, completedAt, status: "failed", cleanup,
        failures: [{ phase: "report", ...failureDetails(error), message: error.message }],
        fullReport: { path: file, bytes: Buffer.byteLength(details), sha256: appleDigest(details) } });
    }
    const pending = path.join(output, ".apple-report.pending.json");
    await writeFile(pending, content, { mode: 0o600 });
    await rename(pending, path.join(output, "apple-report.json"));
  };
  const failure = (error, phase, role) => report.failures.push({ phase, ...(role ? { role } : {}),
    ...(error.appleCommandId ? { commandId: error.appleCommandId } : {}),
    ...failureDetails(error), message: String(error.message ?? error).slice(0, 4000) });
  const controller = new AbortController();
  const environment = { ...process.env, TMPDIR: path.join(output, "scratch") + path.sep,
    TMP: path.join(output, "scratch"), TEMP: path.join(output, "scratch") };
  const execute = async (id, file, args, { timeoutMs = 30_000, cleanup = false } = {}) => {
    if (!cleanup && (overflowed || Buffer.byteLength(appleJSON(report)) > APPLE_NATIVE_REPORT_MAX_BYTES)) throw overflowError();
    requireApple(!report.commands.some((item) => item.id === id) && /^[a-z0-9-]+$/.test(id),
      "An Apple command ID was reused.", "execution-origin");
    const invocation = { file, args, cwd: root };
    const entry = { id, kind: "owned-command", origin: report.origin, ...invocation,
      startedAt: new Date().toISOString(), completedAt: null, status: "running", cleanup: "unknown" };
    report.commands.push(entry);
    if (local) {
      const bytes = appleJSON(entry), file = `${directory}/logs/${id}.request.json`;
      await writeFile(path.join(root, file), bytes, { flag: "wx", mode: 0o600 });
      entry.request = { path: file, bytes: Buffer.byteLength(bytes), sha256: appleDigest(bytes) };
    }
    await publish();
    let outcome, error;
    try {
      outcome = await runCommand(file, args, { cwd: root, env: environment, timeoutMs,
        graceMs: 15_000, ...(cleanup ? {} : { signal: controller.signal }) });
    } catch (caught) { error = caught; outcome = caught; }
    entry.completedAt = new Date().toISOString();
    entry.status = error ? "failed" : "passed";
    entry.cleanup = commandCleanupConfirmed(outcome, invocation) ? "completed" : "unknown";
    entry.outcome = commandDetails(outcome?.commandOutcome);
    if (error) entry.failure = failureDetails(error);
    try {
      for (const stream of ["stdout", "stderr"]) {
        const text = outcome?.[stream] ?? "", file = `${directory}/logs/${id}.${stream}.txt`;
        await writeFile(path.join(root, file), text, { flag: "wx", mode: 0o600 });
        entry[stream] = { path: file, bytes: Buffer.byteLength(text), sha256: appleDigest(text) };
      }
      entry.output = projectAppleCommandOutput(entry, outcome?.stdout ?? "", outcome?.stderr ?? "");
    } catch (collectorError) {
      if (error) failure(collectorError, "command-artifact");
      else error = collectorError;
      entry.status = "failed";
    }
    if (!error && entry.cleanup !== "completed") {
      entry.status = "failed";
      error = Object.assign(new Error("Apple command cleanup is unconfirmed."), { diagnosticCode: "cleanup-failed" });
    }
    if (local) {
      try {
        const bytes = appleJSON(entry), file = `${directory}/logs/${id}.response.json`;
        await writeFile(path.join(root, file), bytes, { flag: "wx", mode: 0o600 });
        entry.response = { path: file, bytes: Buffer.byteLength(bytes), sha256: appleDigest(bytes) };
      } catch (writeError) {
        if (error) failure(writeError, "command-receipt");
        else error = writeError;
      }
    }
    try { await publish(); }
    catch (writeError) {
      if (error) failure(writeError, "report");
      else error = writeError;
    }
    if (error) throw Object.assign(error, { appleCommandId: id });
    return { ...entry, stdout: { ...entry.stdout, text: outcome?.stdout ?? "" },
      stderr: { ...entry.stderr, text: outcome?.stderr ?? "" } };
  };
  const simulatorCommand = (cleanup = false) => (id, args) => execute(id, "/usr/bin/xcrun", args,
    { timeoutMs: args[1] === "bootstatus" ? 180_000 : 60_000, cleanup });
  const nativeExecution = (command) => ({ kind: command.kind, origin: report.origin, commandId: command.id,
    workspace: path.join(root, APPLE_REQUIREMENTS.project), startedAt: command.startedAt, completedAt: command.completedAt });
  const confirmLocalTargets = async (id) => {
    const checked = await execute(id, "/usr/bin/xcrun", ["simctl", "list", "--json"]);
    const targets = selectAppleLocalTargets(JSON.parse(checked.stdout.text), report.toolchain, local.selection.tests, true);
    requireApple(equal(targets, local.selection.tests), "A planned local target changed or stopped.", "device-evidence");
    return checked.id;
  };
  let phase = "preflight", active, inventory = { devices: {} }, localTargetsBound = false;
  const stopCancellation = listenForCommandCancellation(controller);
  const cancel = () => controller.abort(options.signal.reason);
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    await publish();
    report.sourceBefore = await sourceSnapshot(root);
    requireApple(equal(report.sourceBefore, plan.source) &&
      (await readOnlyGit(root, ["rev-parse", "--verify", `${plan.base}^{commit}`])).trim() === plan.base,
    "The planned Apple base or source does not match this checkout.", "source-mismatch");
    const scheme = `${APPLE_REQUIREMENTS.project}/xcshareddata/xcschemes/DevPocket.xcscheme`;
    try {
      await checkedPath(root, `${APPLE_REQUIREMENTS.project}/project.pbxproj`);
      await checkedPath(root, "apple/prepare-components.mjs");
      const xml = await smallFile(root, scheme, 512 * 1024);
      report.scheme = { path: scheme, xml, sha256: appleDigest(xml), targets: inspectAppleScheme(xml) };
    } catch (error) {
      if (error.code === "ENOENT") throw Object.assign(new Error("Apple project, shared scheme or preparation source is not present in this checkout."),
        { diagnosticCode: "preflight-path", cause: error });
      throw error;
    }
    const outputs = {};
    for (const probe of APPLE_PROBES) outputs[probe.id] = (await execute(`probe-${probe.id}`, probe.file, probe.args)).stdout.text;
    report.toolchain = inspectAppleToolchain(outputs);
    inventory = JSON.parse(outputs.simulators);
    if (local) {
      const targets = selectAppleLocalTargets(inventory, report.toolchain, local.selection.tests, true);
      requireApple(equal(targets, local.selection.tests), "The local planned destinations changed.", "device-evidence");
      report.toolchain = localAppleToolchain(report.toolchain, targets);
      requireApple(equal(report.toolchain, local.toolchain), "The local toolchain changed after planning.", "preflight-version");
      localTargetsBound = true;
    }
    requireApple(!appleDevices(inventory).some((device) => device.name.startsWith(`DevPocket-${runId}-`)),
      "The new simulator owner name already exists.", "ownership-mismatch");
    phase = "preparation";
    report.preparationCommandId = "prepare-components";
    await execute(report.preparationCommandId, process.execPath, ["apple/prepare-components.mjs"], { timeoutMs: 10 * 60_000 });
    for (const item of report.builds) {
      phase = `build-${item.platform}`; active = item; item.status = "running"; item.action = "build"; delete item.reason;
      const relative = `${directory}/${phase}`, platform = item.platform;
      await mkdir(path.join(root, relative));
      const destination = platform === "ios" ? "generic/platform=iOS Simulator" : local
        ? `platform=macOS,id=${local.selection.tests.find((target) => target.role === "mac").deviceId}`
        : `platform=macOS,arch=${report.toolchain.architecture}`;
      item.commandId = phase;
      let originalFailure;
      try {
        item.execution = nativeExecution(await execute(phase, "/usr/bin/xcrun", appleXcodeArguments({ workspace: root, directory: relative,
          action: "build", platform, destination }), { timeoutMs: 20 * 60_000 }));
      } catch (error) {
        originalFailure = error;
        const observed = report.commands.find((command) => command.id === phase);
        if (observed?.completedAt) item.execution = nativeExecution(observed);
        failure(error, phase);
        error.appleFailureRecorded = true;
      }
      try {
        requireApple(!originalFailure || report.commands.find((command) => command.id === phase)?.cleanup === "completed",
          "Cannot seal a build while its command cleanup is unconfirmed.", "cleanup-failed");
        if (local) item.readiness = await waitForAppleResult(root, `${relative}/result.xcresult`, phase,
          originalFailure ? undefined : controller.signal);
        item.resultBundle = await directoryArtifact(root, `${relative}/result.xcresult`, phase);
        item.product = await directoryArtifact(root,
          `${relative}/derived/Build/Products/${platform === "ios" ? "Debug-iphonesimulator" : "Debug"}/DevPocket.app`, phase);
        item.originalProduct = path.join(root, item.product.path);
        if (local && !originalFailure) {
          item.signatureCommandId = `${phase}-signature`;
          await execute(item.signatureCommandId, "/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", item.originalProduct]);
          item.infoCommandId = `${phase}-info`;
          const infoPath = path.join(item.originalProduct, platform === "ios" ? "Info.plist" : "Contents/Info.plist");
          const info = JSON.parse((await execute(item.infoCommandId, "/usr/bin/plutil",
            ["-convert", "json", "-o", "-", infoPath])).stdout.text);
          await mkdir(path.join(root, relative, "retained"));
          await cp(item.originalProduct, path.join(root, relative, "retained/DevPocket.app"),
            { recursive: true, force: false, errorOnExist: true });
          await cp(path.join(root, item.resultBundle.path), path.join(root, relative, "retained/result.xcresult"),
            { recursive: true, force: false, errorOnExist: true });
          item.retainedProduct = copiedTreeReference(await directoryArtifact(root, `${relative}/retained/DevPocket.app`, phase));
          item.retainedResultBundle = copiedTreeReference(await directoryArtifact(root, `${relative}/retained/result.xcresult`, phase));
          requireApple(item.product.sha256 === item.retainedProduct.sha256 &&
            item.resultBundle.sha256 === item.retainedResultBundle.sha256, "The native build copy changed.", "artifact-changed");
          const seal = { source: plan.source, platform, originalProduct: item.originalProduct,
            bundleId: info.CFBundleIdentifier, minimumOS: platform === "ios" ? info.MinimumOSVersion : info.LSMinimumSystemVersion,
            signatureExitCode: 0, files: Object.fromEntries(item.product.files.map((file) => [file.path, file.sha256])) };
          const bytes = appleJSON(seal), file = `${relative}/retained/artifact.json`;
          await writeFile(path.join(root, file), bytes, { flag: "wx", mode: 0o600 });
          item.seal = { path: file, bytes: Buffer.byteLength(bytes), sha256: appleDigest(bytes) };
        }
      } catch (error) {
        if (error.appleResultReadiness) item.readiness = error.appleResultReadiness;
        if (!originalFailure) throw error;
        failure(error, `${phase}-collection`);
      }
      if (originalFailure) throw originalFailure;
      item.status = "passed"; active = undefined;
    }
    for (const item of report.tests) {
      phase = `test-${item.role}`; active = item; item.status = "running"; item.action = "test"; delete item.reason;
      const mac = item.role === "mac";
      let target = local ? local.selection.tests.find((target) => target.role === item.role)
        : { role: "mac", platform: "macOS", osVersion: report.toolchain.macOS, architecture: report.toolchain.architecture };
      if (!mac && !local) {
        const selection = report.toolchain.simulators.find((candidate) => candidate.role === item.role);
        const resource = await createAppleSimulator(selection, runId, report.resources, inventory, simulatorCommand());
        target = { ...selection, deviceId: resource.deviceId, architecture: report.toolchain.architecture };
      }
      const relative = `${directory}/${phase}`;
      await mkdir(path.join(root, relative));
      const destination = mac && !local ? `platform=macOS,arch=${target.architecture}` : `platform=${target.platform},id=${target.deviceId}`;
      if (local) {
        const catalogDirectory = `${relative}/catalog`;
        await mkdir(path.join(root, catalogDirectory));
        item.beforeCatalogCommandId = await confirmLocalTargets(`${phase}-before-catalog`);
        item.catalogCommandId = `${phase}-catalog`;
        await execute(item.catalogCommandId, "/usr/bin/xcrun", appleEnumerationArguments(root, catalogDirectory, target),
          { timeoutMs: 180_000 });
        const bytes = await smallFile(root, `${catalogDirectory}/enumeration.json`);
        item.catalog = { path: `${catalogDirectory}/enumeration.json`, bytes: Buffer.byteLength(bytes),
          sha256: appleDigest(bytes), data: JSON.parse(bytes) };
        normalizeAppleTestCatalog(item.catalog.data, report.scheme.targets);
        item.beforeTestCommandId = await confirmLocalTargets(`${phase}-before-test`);
      }
      item.commandId = phase;
      let execution, originalFailure;
      try {
        execution = await execute(phase, "/usr/bin/xcrun", appleXcodeArguments({ workspace: root, directory: relative,
          action: "test", platform: mac ? "macos" : "ios", destination,
          ...(local ? { testDiagnostics: "never" } : {}) }), { timeoutMs: 20 * 60_000 });
        item.execution = nativeExecution(execution);
      } catch (error) {
        originalFailure = error;
        const observed = report.commands.find((command) => command.id === phase);
        if (observed?.completedAt) item.execution = nativeExecution(observed);
        failure(error, phase, item.role);
        error.appleFailureRecorded = true;
      }
      try {
        requireApple(!originalFailure || report.commands.find((command) => command.id === phase)?.cleanup === "completed",
          "Cannot inspect xcresult while test command cleanup is unconfirmed.", "cleanup-failed");
        if (local) item.readiness = await waitForAppleResult(root, `${relative}/result.xcresult`, phase,
          originalFailure ? undefined : controller.signal);
        await checkedPath(root, `${relative}/result.xcresult`, true);
        const exported = [];
        for (const kind of ["summary", "tests"]) {
          item[`${kind}CommandId`] = `${phase}-${kind}`;
          const result = await execute(item[`${kind}CommandId`], "/usr/bin/xcrun",
            ["xcresulttool", "get", "test-results", kind, "--path", path.join(root, relative, "result.xcresult"), "--compact"],
            { cleanup: Boolean(originalFailure) });
          exported.push(projectAppleXcresult(kind, JSON.parse(result.stdout.text)));
        }
        const resultManifest = await directoryArtifact(root, `${relative}/result.xcresult`, phase);
        item.resultBundle = await retainAppleResultManifest(root, resultManifest);
        [item.summary, item.testTree] = exported;
        if (local) {
          await mkdir(path.join(root, relative, "retained"));
          await cp(path.join(root, item.resultBundle.path), path.join(root, relative, "retained/result.xcresult"),
            { recursive: true, force: false, errorOnExist: true });
          item.retainedResultBundle = copiedTreeReference(await directoryArtifact(root, `${relative}/retained/result.xcresult`, phase));
          requireApple(item.resultBundle.sha256 === item.retainedResultBundle.sha256,
            "The original native result and retained copy differ.", "artifact-changed");
        }
        if (!originalFailure) {
          item.result = normalizeAppleTestResult(item.summary, item.testTree, target, execution, report.scheme.targets);
          item.target = { ...target, deviceId: item.result.device.deviceId };
          if (local) {
            requireApple(equal(appleTestSelection(item.result.cases.map((test) =>
              ({ targetName: test.target, testIdentifier: test.identifier }))),
            normalizeAppleTestCatalog(item.catalog.data, report.scheme.targets)),
            "The full native command did not cover its complete catalogue.", "case-evidence");
          }
        }
      } catch (error) {
        if (error.appleResultReadiness) item.readiness = error.appleResultReadiness;
        if (!originalFailure) throw error;
        failure(error, `${phase}-collection`, item.role);
      }
      if (originalFailure) throw originalFailure;
      item.status = "passed"; active = undefined;
    }
  } catch (error) {
    if (active) { active.status = "failed"; active.failure = failureDetails(error); }
    if (!error.appleFailureRecorded) failure(error, phase, active?.role);
  } finally {
    try {
      const cleaned = local ? { status: "completed", failures: [] }
        : await cleanupAppleSimulators(report.resources, inventory, simulatorCommand(true));
      if (local && localTargetsBound && report.commands.every((command) => command.cleanup === "completed")) {
        try {
          const checked = await execute("local-targets-after", "/usr/bin/xcrun", ["simctl", "list", "--json"], { cleanup: true });
          report.local.targetsAfterCommandId = checked.id;
          const targets = selectAppleLocalTargets(JSON.parse(checked.stdout.text), report.toolchain, local.selection.tests, true);
          requireApple(equal(targets, local.selection.tests), "Local target identity changed during execution.", "device-evidence");
        } catch (error) { failure(error, "target-validation"); }
      }
      report.cleanupEvidence = projectAppleCleanupEvidence(cleaned);
      for (const item of cleaned.failures) failure(item.error, "cleanup", item.role);
      report.cleanup = cleaned.status;
      if (report.commands.some((item) => item.cleanup !== "completed")) report.cleanup = "unknown";
    } catch (error) { report.cleanup = "failed"; failure(error, "cleanup"); }
    try {
      report.sourceAfter = await sourceSnapshot(root);
      requireApple(equal(report.sourceAfter, plan.source), "Apple source changed during verification.", "source-changed");
    } catch (error) { failure(error, "source-validation"); }
    stopCancellation();
    options.signal?.removeEventListener("abort", cancel);
    report.completedAt = new Date().toISOString();
    report.status = report.failures.length ? report.cleanup === "completed" &&
      report.failures.every((item) => item.phase === "preflight" && item.reason !== "source-mismatch") ? "blocked" : "failed" : "passed";
    if (report.status === "passed") {
      try { validateAppleNativeEvidence(report, plan, report.origin); }
      catch (error) { failure(error, "evidence-validation"); report.status = "failed"; }
    }
    await publish();
  }
  return report;
}

if (import.meta.main) {
  try {
    const report = await runAppleCI(parseAppleRunnerArguments(process.argv.slice(2)));
    console.log(`Apple native verification: ${report.status}; cleanup: ${report.cleanup}.`);
    process.exitCode = report.status === "passed" ? 0 : report.status === "blocked" ? 78 : 1;
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exitCode = 1;
  }
}
