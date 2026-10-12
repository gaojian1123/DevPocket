import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { runCommand } from "./process.mjs";
import { cleanDeviceRun } from "./device-run.mjs";
import { projectWorkerDiagnostics } from "./worker-diagnostics.mjs";

const exec = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const splitPaths = (value) => value.split("\0").filter(Boolean);

export const isVerificationPolicyPath = (file) =>
  /^(?:\.github\/|scripts\/|AGENTS\.md$|android\/gradle\/|android\/gradlew(?:\.bat)?$)/i.test(file) ||
  /(?:^|\/)\.npmrc$/i.test(file) ||
  /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|tsconfig(?:\.[^/]+)?\.json|requirements[^/]*\.txt)$/i.test(file) ||
  /^android\/.*(?:\.gradle(?:\.kts)?|gradle\.properties)$/i.test(file);

export const CHECKS = [
  { id: "workflow-tests", group: "backend", npm: "run test:workflow" },
  { id: "typecheck", group: "backend", npm: "run typecheck" },
  { id: "backend-tests", group: "backend", npm: "test" },
  { id: "backend-build", group: "backend", npm: "run build" },
  { id: "schema", group: "backend", npm: "run schema" },
  { id: "extension-package", group: "backend", npm: "run test:extension-package" },
  { id: "setup", group: "backend", npm: "run test:setup" },
  { id: "azure-tests", group: "backend", npm: "--prefix deployment\\azure test" },
  { id: "operations-tests", group: "backend", npm: "run test:operations" },
  { id: "android-build", group: "android", script: "build-android.ps1", args: ["-Lint", "-Instrumentation"] },
  { id: "android-device", group: "device", script: "test-android.ps1", args: [] },
];

export async function git(root, args) {
  const result = await exec("git", ["--no-pager", ...args], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
  });
  return result.stdout;
}

export async function sourceSnapshot(root) {
  const head = (await git(root, ["rev-parse", "--verify", "HEAD"])).trim();
  const modes = new Map();
  for (const entry of splitPaths(await git(root, ["ls-files", "--stage", "-z"]))) {
    const tab = entry.indexOf("\t");
    const [mode, , stage] = entry.slice(0, tab).split(" ");
    if (stage !== "0") throw new Error("Resolve the unmerged index before collecting source evidence.");
    modes.set(entry.slice(tab + 1), mode);
  }
  const files = [...new Set(splitPaths(await git(root,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])))].sort();
  const entries = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    try {
      const info = await lstat(absolute);
      entries.push([file, modes.get(file) ?? (info.isSymbolicLink() ? "120000" : "100644"),
        info.isSymbolicLink() ? "link" : "file",
        digest(info.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute))]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      entries.push([file, "deleted"]);
    }
  }
  return { head, fingerprint: digest(JSON.stringify(entries)) };
}

export async function verificationPlan(root, base, all = false) {
  if (!base || base.startsWith("-")) throw new Error("An explicit base commit is required.");
  const baseSha = (await git(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`])).trim();
  const source = await sourceSnapshot(root);
  const changedFiles = [...new Set([
    ...splitPaths(await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", baseSha, "--"])),
    ...splitPaths(await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])),
  ])].sort();
  const selected = new Set();
  let requiresHumanReview = false, layouts = false;
  const add = (...ids) => ids.forEach((id) => selected.add(id));
  const backend = () => add("workflow-tests", "typecheck", "backend-tests", "backend-build", "schema");
  const android = () => add("android-build", "android-device");
  for (const file of changedFiles) {
    requiresHumanReview ||= isVerificationPolicyPath(file);
    if (["README.md", "VALIDATION.md"].includes(file) || /^docs\/.*\.md$/.test(file)) continue;
    if (file.startsWith("android/")) {
      android();
      layouts ||= /\/ui\/|\/res\/|Manifest|\.gradle|gradle\.properties/.test(file);
      requiresHumanReview ||= /\/data\/|Manifest|\.gradle|gradle\.properties/.test(file);
    } else if (file.startsWith("backend/")) {
      backend();
      if (file.startsWith("backend/src/")) {
        add("extension-package", "setup");
        android();
        requiresHumanReview = true;
      } else if (file.startsWith("backend/integration/")) android();
    } else if (file.startsWith("extension/")) {
      backend();
      add("extension-package", "setup");
      requiresHumanReview = true;
    } else if (file.startsWith("deployment/") || file.startsWith("infra/") || file === "azure.yaml") {
      backend();
      add("setup", "azure-tests", "operations-tests");
      requiresHumanReview = true;
    } else if (file.startsWith("test-fixtures/") || file === "protocol.schema.json") {
      backend();
      android();
      requiresHumanReview = true;
    } else {
      for (const check of CHECKS) selected.add(check.id);
      requiresHumanReview = true;
      layouts = true;
    }
  }
  if (all) for (const check of CHECKS) selected.add(check.id);
  return {
    version: 1, base: baseSha, source, changedFiles, requiresHumanReview, layouts,
    requiredChecks: CHECKS.filter((check) => selected.has(check.id)).map((check) => check.id),
  };
}

export async function executeVerification(root, plan, options = {}) {
  const group = options.group ?? "all";
  if (!["all", "backend", "android", "device"].includes(group)) throw new Error("Unknown verification group.");
  const checks = plan.requiredChecks.map((id) => ({ id, status: "not_run" }));
  const backendDiagnostics = options.backendDiagnostics ? await import("./backend-diagnostics.mjs") : undefined;
  const backendDiagnosticRunId = backendDiagnostics && ["all", "backend"].includes(group) &&
    plan.requiredChecks.includes("backend-tests") ? randomUUID() : undefined;
  const backendDiagnosticEnv = backendDiagnosticRunId
    ? await backendDiagnostics.prepareBackendDiagnosticEnvironment(root, backendDiagnosticRunId, process.env, options.signal)
    : undefined;
  await mkdir(options.directory, { recursive: true });
  let stopped = false;
  for (const check of checks) {
    const definition = CHECKS.find((item) => item.id === check.id);
    const deviceOwner = check.id === "android-device" ? randomUUID() : undefined;
    if (group !== "all" && group !== definition.group) continue;
    if (stopped) continue;
    const args = definition.npm
      ? ["-NoProfile", "-NonInteractive", "-Command", `& npm ${definition.npm}; exit $LASTEXITCODE`]
      : ["-NoProfile", "-NonInteractive", "-File", path.join(root, "scripts", definition.script),
        ...definition.args];
    if (definition.script) {
      if (options.jdk) args.push("-Jdk", options.jdk);
      if (options.sdk) args.push("-Sdk", options.sdk);
      if (check.id === "android-device") {
        args.push("-RunDirectory", path.join(options.directory, "device"));
        args.push("-Owner", deviceOwner);
        if (options.image) args.push("-Image", options.image);
        if (plan.layouts) args.push("-Layouts");
      }
    }
    const started = Date.now();
    const log = path.join(options.directory, `${check.id}.log`);
    const logFile = await open(log, "wx", 0o600);
    const writeLog = async (text) => {
      if (check.id === "backend-tests" && backendDiagnostics) {
        const bounded = backendDiagnostics.boundedBackendLog(text);
        check.backendDiagnosticLogTruncated = bounded.truncated;
        await logFile.writeFile(bounded.bytes);
      } else await logFile.writeFile(text);
    };
    try {
      let env;
      if (check.id === "backend-tests" && backendDiagnostics) {
        check.backendDiagnosticRunId = backendDiagnosticRunId;
        env = backendDiagnosticEnv;
      }
      const output = await runCommand("pwsh", args, {
        cwd: root, env, timeoutMs: 30 * 60_000, graceMs: check.id === "android-device" ? 30_000 : 5000, signal: options.signal,
      });
      await writeLog(output.stdout + output.stderr);
      if (check.id === "android-device") {
        const evidence = JSON.parse(await readFile(path.join(options.directory, "device", "device-report.json"), "utf8"));
        validateDeviceEvidence(evidence, plan, process.platform);
        if (evidence.runId !== deviceOwner) throw new Error("Device evidence belongs to another invocation.");
        for (const [field, parts] of [
          ["apkSha256", ["debug", "app-debug.apk"]],
          ["testApkSha256", ["androidTest", "debug", "app-debug-androidTest.apk"]],
        ]) {
          const bytes = await readFile(path.join(root, "android", "app", "build", "outputs", "apk", ...parts));
          if (digest(bytes) !== evidence[field]) throw new Error("The APK changed after device acceptance.");
        }
        check.workerDiagnostics = projectWorkerDiagnostics(evidence.workerDiagnostics, deviceOwner);
        check.deviceEvidence = { ...evidence, workerDiagnostics: check.workerDiagnostics };
      }
      Object.assign(check, { status: "passed", exitCode: 0 });
    } catch (error) {
      await writeLog(`${error.stdout ?? ""}${error.stderr ?? ""}\n${error.message}\n`);
      Object.assign(check, {
        status: check.id === "android-build" && error.code === 78 ? "blocked" : typeof error.code === "number" ? "failed" : "blocked",
        exitCode: typeof error.code === "number" ? error.code : null,
        reason: check.id === "android-build" && error.code === 78 ? "Android build prerequisites are unavailable."
          : error.killed ? "Command timed out." : "Command failed; inspect the private local log.",
      });
      if (check.id === "android-device") {
        if (error.processTreeStopped) {
          try {
            await cleanDeviceRun(root, path.join(options.directory, "device"), deviceOwner);
            check.cleanup = "completed";
          } catch (cleanupError) {
            check.cleanup = "failed";
            await logFile.writeFile(`\nPrivate cleanup failure: ${cleanupError.message}\n`);
            check.reason += " Cleanup remains incomplete; inspect retained owned resources.";
          }
        }
        try {
          const evidence = JSON.parse(await readFile(path.join(options.directory, "device", "device-report.json"), "utf8"));
          if (evidence.runId === deviceOwner) {
            check.workerDiagnostics = projectWorkerDiagnostics(evidence.workerDiagnostics, deviceOwner);
          }
          if (evidence.runId === deviceOwner && evidence.status === "blocked" && evidence.cleanup === "completed") {
            check.status = "blocked";
            check.reason = "Device prerequisites or worker readiness are unavailable; inspect the bounded worker diagnostics.";
          }
        } catch (evidenceError) {
          if (evidenceError.code !== "ENOENT" && !(evidenceError instanceof SyntaxError)) throw evidenceError;
          check.reason += " No complete device report was available.";
        }
      }
      stopped = true;
    } finally { await logFile.close(); }
    check.durationMs = Date.now() - started;
    check.log = path.relative(root, log);
  }
  const current = await sourceSnapshot(root);
  const changed = current.head !== plan.source.head || current.fingerprint !== plan.source.fingerprint;
  const failed = checks.some((check) => check.status === "failed");
  const blocked = checks.some((check) => check.status === "blocked");
  const complete = !changed && !failed && !blocked && checks.every((check) => check.status === "passed");
  return {
    ...plan, group, checks, complete,
    status: changed || failed ? "failed" : blocked ? "blocked" : complete ? "passed" : "partial",
    ...(changed ? { error: "Source changed during verification. Regenerate/review the change and run again." } : {}),
    environment: { node: process.version, platform: process.platform },
  };
}

export function combineVerification(plan, reports) {
  const passed = new Map();
  for (const report of reports) {
    if (report.version !== plan.version || report.base !== plan.base ||
        report.source?.head !== plan.source.head || report.source?.fingerprint !== plan.source.fingerprint) {
      throw new Error("Report source does not match the current source and base.");
    }
    if (!["passed", "partial"].includes(report.status) ||
        JSON.stringify(report.requiredChecks) !== JSON.stringify(plan.requiredChecks)) {
      throw new Error("A report is failed, blocked, planned, or uses a different check policy.");
    }
    if (!["all", "backend", "android", "device"].includes(report.group)) throw new Error("Invalid report group.");
    const seen = new Set();
    for (const check of report.checks ?? []) {
      const definition = CHECKS.find((item) => item.id === check.id);
      if (!definition || !plan.requiredChecks.includes(check.id) || seen.has(check.id)) {
        throw new Error("Unknown or duplicate check in report.");
      }
      seen.add(check.id);
      if (check.status === "not_run") continue;
      if (report.group !== "all" && definition.group !== report.group) throw new Error("Check belongs to another group.");
      if (check.status !== "passed" || check.exitCode !== 0 || passed.has(check.id)) {
        throw new Error(`Conflicting or unsuccessful evidence for ${check.id}.`);
      }
      if (check.id === "android-device") validateDeviceEvidence(check.deviceEvidence, plan, report.environment?.platform);
      passed.set(check.id, check);
    }
  }
  const missing = plan.requiredChecks.filter((id) => !passed.has(id));
  if (missing.length) throw new Error(`Missing required evidence: ${missing.join(", ")}.`);
  return { ...plan, group: "all", status: "passed", complete: true,
    checks: plan.requiredChecks.map((id) => passed.get(id)) };
}

function validateDeviceEvidence(evidence, plan, platform) {
  if (!evidence || evidence.status !== "passed" || evidence.cleanup !== "completed" ||
      evidence.evidence !== "emulator-test-sdk-adapter" || evidence.source?.head !== plan.source.head ||
      evidence.source?.fingerprint !== plan.source.fingerprint ||
      !/^[a-f0-9]{64}$/.test(evidence.apkSha256) || !/^[a-f0-9]{64}$/.test(evidence.testApkSha256) ||
      !/^[a-f0-9-]{36}$/.test(evidence.runId) || !Array.isArray(evidence.cases) ||
      !Array.isArray(evidence.discoveredClasses)) throw new Error("Missing or stale device instrumentation evidence.");
  if ((platform === "linux" && evidence.platform !== "linux") ||
      (evidence.platform === "linux" &&
        (evidence.acceleration?.provider !== "KVM" || evidence.acceleration.usable !== true))) {
    throw new Error("Linux device evidence requires usable KVM acceleration.");
  }
  const baseline = ["NativeFlowTest", "AdaptiveLayoutTest", "FixtureFlowTest"].map((name) => `dev.devpocket.app.${name}`);
  if (baseline.some((name) => !evidence.discoveredClasses.includes(name)) ||
      new Set(evidence.discoveredClasses).size !== evidence.discoveredClasses.length ||
      evidence.discoveredClasses.includes("dev.devpocket.app.ConnectedFlowTest")) {
    throw new Error("Device test discovery is incomplete or includes a real-CLI suite.");
  }
  const expected = new Map([
    ["native", baseline[0]], ["layout-compact", baseline[1]], ["fixture", baseline[2]],
    ...(plan.layouts ? ["medium", "expanded", "landscape", "large-font"].map((name) => [`layout-${name}`, baseline[1]]) : []),
    ...evidence.discoveredClasses.filter((name) => !baseline.includes(name)).map((name, index) => [`change-${index}`, name]),
  ]);
  let total = 0;
  for (const item of evidence.cases) {
    if (item.class !== expected.get(item.name) ||
        item.status !== "passed" || !Number.isSafeInteger(item.tests) || item.tests < (item.name === "native" ? 2 : 1)) {
      throw new Error("Device evidence contains a skipped, duplicate or unexpected case.");
    }
    expected.delete(item.name);
    total += item.tests;
  }
  if (expected.size || total !== evidence.tests) throw new Error("Required native, layout or fixture cases are missing.");
}
