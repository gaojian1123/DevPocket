import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { isolatedCandidateEnvironment, isolatedCommandBoundary, runIsolatedPlatformChecks } from "../isolated-worker.mjs";
import { LINUX_PLATFORM_TESTS, LINUX_CANDIDATE_PLATFORM_TESTS, LINUX_PRIVILEGED_PLATFORM_TESTS } from "../backend-diagnostics.mjs";
import { runCommand, withCommandBoundary } from "../process.mjs";
import { git, withGitExecutable } from "../git-state.mjs";
import { verificationPlan } from "../verification.mjs";
import { verificationPreflight } from "../verification-preflight.mjs";

const exec = promisify(execFile);

async function fixture(t) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/isolated-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuration = { version: 1, platform: process.platform, group: "tooling", control: path.join(root, "control"),
    candidate: path.join(root, "candidate"), fixture: path.join(root, "fixture"), private: path.join(root, "private"),
    home: path.join(root, "home"), temporary: path.join(root, "temporary"), identity: path.join(root, "private", "identity.json"),
    uid: 1234, gid: 1234, tools: { node: process.execPath, pwsh: process.execPath, python3: process.execPath } };
  await Promise.all(["control", "candidate", "fixture", "private", "home", "temporary"]
    .map((name) => mkdir(configuration[name])));
  return configuration;
}

function environment(configuration) {
  return isolatedCandidateEnvironment(configuration, { PATH: path.dirname(process.execPath),
    SystemRoot: process.env.SystemRoot ?? path.resolve("fixture-windows"), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
    GH_TOKEN: "synthetic-owner-token", GITHUB_TOKEN: "synthetic-repository-token", ACTIONS_RUNTIME_TOKEN: "synthetic-artifact-token",
    GITHUB_ENV: "private-runner-environment", GITHUB_OUTPUT: "private-runner-output",
    NODE_OPTIONS: "--import candidate-loader.mjs", PYTHONPATH: "candidate-modules" });
}

const successfulCommand = () => ({ stdout: "candidate output", stderr: "", processTreeStopped: true,
  commandOutcome: { observedProcess: "owned-command-supervisor", reason: "exit", exitCode: 0, cleanupFailure: null } });

async function fixtureBroker(configuration) {
  const file = path.join(configuration.private, "supervisor.json"), bytes = "{}\n";
  await writeFile(file, bytes);
  configuration.broker = { file: process.execPath, configuration: file, sha256: createHash("sha256").update(bytes).digest("hex") };
}

test("isolated Linux preparation partitions privileged and candidate checks without dropping ordinary coverage", () => {
  assert.deepEqual(LINUX_PLATFORM_TESTS, [...LINUX_CANDIDATE_PLATFORM_TESTS, ...LINUX_PRIVILEGED_PLATFORM_TESTS]);
  assert.equal(new Set(LINUX_PLATFORM_TESTS).size, LINUX_PLATFORM_TESTS.length);
  assert.deepEqual(LINUX_PRIVILEGED_PLATFORM_TESTS, ["scripts/tests/linux-privileged-process.test.mjs"]);
  assert.ok(!LINUX_CANDIDATE_PLATFORM_TESTS.some((file) => LINUX_PRIVILEGED_PLATFORM_TESTS.includes(file)));
});

test("platform preparation retains its real control source separately from candidate checks", async (t) => {
  const configuration = await fixture(t);
  for (const root of [configuration.control, configuration.candidate]) {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: path.basename(root), private: true }));
    await git(root, ["init", "--quiet"]);
    await git(root, ["add", "--all"]);
    await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Platform partition"]);
  }
  const calls = [];
  await withCommandBoundary(async (file, args, options, execute) => {
    if (!args.includes("--test")) return execute(file, args, options);
    calls.push({ file: args.at(-1), cwd: options.cwd });
    return { ...successfulCommand(), stdout: "# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n" };
  }, async () => {
    const control = await runIsolatedPlatformChecks(configuration, configuration.control, LINUX_PRIVILEGED_PLATFORM_TESTS);
    const candidate = await runIsolatedPlatformChecks(configuration, configuration.candidate, LINUX_CANDIDATE_PLATFORM_TESTS);
    assert.notEqual(control.source.head, candidate.source.head);
    assert.deepEqual(control.checks.map((check) => check.file), LINUX_PRIVILEGED_PLATFORM_TESTS);
    assert.deepEqual(candidate.checks.map((check) => check.file), LINUX_CANDIDATE_PLATFORM_TESTS);
  });
  assert.deepEqual(calls, [
    ...LINUX_PRIVILEGED_PLATFORM_TESTS.map((file) => ({ file, cwd: configuration.control })),
    ...LINUX_CANDIDATE_PLATFORM_TESTS.map((file) => ({ file, cwd: configuration.candidate })),
  ]);
  const source = await readFile(new URL("../isolated-worker.mjs", import.meta.url), "utf8");
  assert.ok(source.indexOf('bootstrapPhase = "trusted-platform-preparation"') <
    source.indexOf("await withCommandBoundary((file, args, options, execute)"));
});

test("Windows service commands retain the original owner and bind the private service configuration", async (t) => {
  const configuration = { ...await fixture(t), platform: "win32" };
  await fixtureBroker(configuration);
  const ownerEnvironment = { PATH: "trusted-owner" };
  const boundary = isolatedCommandBoundary(configuration, ownerEnvironment, environment(configuration));
  await boundary("node", ["--version"], { cwd: configuration.candidate }, async (file, args, options) => {
    assert.equal(file, configuration.broker.file);
    assert.deepEqual(args.slice(0, 3), ["--client", configuration.broker.configuration, configuration.broker.sha256]);
    assert.deepEqual(options.env, ownerEnvironment);
    assert.notEqual(options.cwd, configuration.candidate);
    const bytes = await readFile(args.at(-1)), request = JSON.parse(bytes);
    await writeFile(`${args.at(-1)}.result.json`, JSON.stringify({
      version: 1, id: request.id, status: "executed", admission: "running", started: true,
      processTreeStopped: true, exitCode: 0, requestSha256: createHash("sha256").update(bytes).digest("hex"),
    }));
    return successfulCommand();
  });
});

test("failed service clients cannot lend native facts or cleanup evidence to an unbound receipt", async (t) => {
  for (const mode of ["matching", "mismatched", "missing"]) await t.test(mode, async (t) => {
    const configuration = { ...await fixture(t), platform: "win32" };
    await fixtureBroker(configuration);
    const boundary = isolatedCommandBoundary(configuration, {}, environment(configuration));
    await assert.rejects(boundary("node", [], {}, async (_file, args) => {
      const file = args.at(-1), bytes = await readFile(file), request = JSON.parse(bytes);
      const receipt = { version: 1, id: request.id, status: "blocked", admission: "creation-attempted",
        started: false, processTreeStopped: true, exitCode: null,
        native: { stage: "create", errorCode: 1314, assignPrimaryTokenEnabled: false, increaseQuotaEnabled: true } };
      if (mode !== "missing") receipt.requestSha256 = mode === "matching"
        ? createHash("sha256").update(bytes).digest("hex") : "0".repeat(64);
      await writeFile(`${file}.result.json`, JSON.stringify(receipt));
      throw Object.assign(new Error("Service client rejected the operation"), successfulCommand(), { code: 78 });
    }), (error) => {
      if (mode === "matching") {
        assert.equal(error.diagnosticCode, "preflight-tool");
        assert.equal(error.processTreeStopped, true);
        assert.equal(error.nativeFailure.errorCode, 1314);
      } else {
        assert.equal(error.diagnosticCode, "cleanup-failed");
        assert.equal(error.processTreeStopped, false);
        assert.equal(error.isolatedAdmission, undefined);
        assert.equal(error.nativeFailure, undefined);
      }
      return true;
    });
  });
});

test("LocalService validation rejects arbitrary commands and startup injection without running a service",
  { skip: process.platform !== "win32" }, async (t) => {
    const configuration = await fixture(t), binary = path.join(configuration.private, "contracts.exe");
    await writeFile(path.join(configuration.candidate, "outside.exe"), "validation must not execute this file");
    await symlink(configuration.candidate, path.join(configuration.private, "escape"), "junction");
    const compiler = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    await exec(compiler, ["/nologo", "/target:exe", "/main:SupervisorContracts",
      "/reference:System.ServiceProcess.dll", "/reference:System.Web.Extensions.dll", `/out:${binary}`,
      path.resolve("scripts", "isolated-command.cs"), path.resolve("scripts", "windows-supervisor.cs"),
      path.resolve("scripts", "tests", "fixtures", "windows-supervisor-contracts.cs")], { timeout: 30000 });
    const result = await exec(binary, [configuration.private], { timeout: 30000 });
    assert.equal(result.stdout.trim(), "SUPERVISOR_VALIDATION_ONLY");
  });

test("Windows token inspection borrows the candidate identity only to open its actual process token", async () => {
  const source = await readFile(new URL("../isolated-command.cs", import.meta.url), "utf8");
  const restriction = source.slice(source.indexOf("void RestrictToken("), source.indexOf("public int Run("));
  const borrowed = /WindowsIdentity\.RunImpersonated\(logonToken, \(\) => \{([\s\S]*?)\}\);/.exec(restriction);
  assert.ok(borrowed, "Opening a different account's token must not require adding SeDebugPrivilege.");
  assert.equal(borrowed[1].replace(/\s+/g, " ").trim(),
    "if (!OpenProcessToken(process, 0x28, out token)) throw new Win32Exception();");
  assert.ok(restriction.indexOf("using (var identity") > borrowed.index + borrowed[0].length,
    "Identity comparison and privilege restriction run after restoring the supervisor identity.");
  assert.match(source, /RestrictToken\(sid, logonSid, token\);\s+Stage = "resume";/);
});

test("Windows cleanup attempts service removal and publication even after a broken owner pipe",
  { skip: process.platform !== "win32" }, async (t) => {
    for (const fault of ["none", "pipe", "service"]) await t.test(fault, async (t) => {
      const configuration = await fixture(t);
      const output = await exec("pwsh", ["-NoProfile", "-NonInteractive", "-File",
        path.resolve("scripts", "tests", "fixtures", "windows-cleanup.ps1"),
        "-Bootstrap", path.resolve("scripts", "isolated-worker.ps1"), "-Root", configuration.home, "-Fault", fault],
      { timeout: 30000 });
      const result = JSON.parse(output.stdout);
      assert.equal(result.failed, fault !== "none");
      assert.equal(result.report.status, fault === "none" ? "completed" : "blocked");
      assert.equal(result.report.acceptance, false);
      assert.ok(result.events.includes("service-stop"));
      assert.equal(result.events.includes("service-delete"), fault !== "service");
      assert.equal(result.events.includes("account-delete"), fault !== "service");
      assert.equal(result.report.serviceRemoved, fault !== "service");
      assert.equal(result.report.candidateAccountRemoved, fault !== "service");
      assert.equal(result.capabilityCopied, true);
      assert.equal(result.diagnosticCopied, true);
      assert.equal(result.reportCopied, fault === "none");
      assert.equal(result.credentialsRetained, fault === "service");
      if (fault === "pipe") assert.ok(result.report.issues.some((issue) => issue.stage === "owner-pipe"));
    });
  });

test("candidate environments contain no credentials, runner command files or inherited startup hooks", async (t) => {
  const configuration = await fixture(t), selected = environment(configuration);
  assert.equal(selected.HOME, configuration.home);
  assert.equal(selected.RUNNER_TEMP, configuration.temporary);
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "GITHUB_ENV", "GITHUB_OUTPUT", "PYTHONPATH", "NODE_OPTIONS"]) {
    assert.equal(Object.hasOwn(selected, name), false, name);
  }
  assert.equal(selected.GIT_CONFIG_VALUE_1, configuration.candidate);
  assert.equal(selected.GIT_CONFIG_VALUE_2, configuration.fixture);
});

test("backend installation, operational probes and literal python commands select one low-identity environment", async (t) => {
  const configuration = { ...await fixture(t), group: "backend" };
  const selected = environment(configuration);
  assert.equal(selected.PATH.split(path.delimiter)[0], path.dirname(selected.DEVPOCKET_PROBE_PYTHON));
  assert.equal(selected.DEVPOCKET_PROBE_PYTHON, path.join(configuration.candidate, ".tools", "probe-python",
    process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python"));
});

test("operational preflight probes the explicitly selected target without changing the owner PATH", async (t) => {
  const configuration = await fixture(t), root = configuration.candidate;
  await writeFile(path.join(root, "package.json"), '{"name":"python-selection-fixture","private":true}\n');
  await mkdir(path.join(root, "deployment", "azure", "probe"), { recursive: true });
  await writeFile(path.join(root, "deployment", "azure", "probe", "requirements-test.txt"), "cryptography==1.2.3\n");
  await git(root, ["init", "--quiet"]);
  await git(root, ["add", "--all"]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Python selector fixture"]);
  const plan = { ...await verificationPlan(root, "HEAD"), requiredChecks: ["operations-tests"], requiredGroups: ["backend"] };
  const before = process.env.PATH, calls = [];
  const boundary = async (file, args, options, execute) => {
    if (args[0] !== "-B" || args[1] !== "-c") return execute(file, args, options);
    calls.push({ file, args });
    assert.equal(file, process.execPath);
    return { ...successfulCommand(), stdout: JSON.stringify({ version: [3, 12, 0], executable: file, dependencies: "a".repeat(64) }) };
  };
  const ownerFile = path.join(root, "owner-python");
  const ownerArgs = ["-B", path.resolve("scripts", "owned-command-darwin.py"), "--probe"];
  let forwarded = false;
  await boundary(ownerFile, ownerArgs, {}, async (file, args) => {
    forwarded = true;
    assert.equal(file, ownerFile);
    assert.deepEqual(args, ownerArgs);
    return successfulCommand();
  });
  assert.equal(forwarded, true);
  const result = await withCommandBoundary(boundary, () => verificationPreflight(root, plan, { group: "backend", operationsPython: process.execPath,
    directory: path.join(root, ".data", "ci", "preflight") }));
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(calls.length, 2);
  assert.ok(calls.some(({ args }) => args[2].includes("cryptography")));
  assert.equal(process.env.PATH, before);
});

test("the owned supervisor retains its trusted context while only the target receives candidate settings", async (t) => {
  const configuration = await fixture(t), candidateEnvironment = environment(configuration);
  const ownerEnvironment = { PATH: "fixed-owner-tools", HOME: "protected-owner-home", GH_TOKEN: "synthetic-owner-only" };
  const boundary = isolatedCommandBoundary(configuration, ownerEnvironment, candidateEnvironment);
  let calls = 0;
  const result = await boundary("node", ["--test", "fixture.test.mjs"],
    { cwd: configuration.candidate, env: { PATH: "candidate-shim", NODE_OPTIONS: "--require malicious.cjs",
      DEVPOCKET_BACKEND_DIAGNOSTIC_ID: "fixture-diagnostic" }, timeoutMs: 1000 }, async (_file, args, options) => {
      calls++;
      assert.deepEqual(options.env, ownerEnvironment);
      assert.notEqual(options.cwd, configuration.candidate);
      const requestFile = args.at(-1), request = JSON.parse(await readFile(requestFile, "utf8"));
      assert.equal(path.dirname(requestFile), configuration.private);
      assert.equal(request.cwd, configuration.candidate);
      assert.equal(request.file, process.execPath);
      assert.deepEqual(request.arguments, ["--test", "fixture.test.mjs"]);
      assert.deepEqual(request.environment, { ...candidateEnvironment, DEVPOCKET_BACKEND_DIAGNOSTIC_ID: "fixture-diagnostic" });
      assert.equal(Object.hasOwn(request.environment, "GH_TOKEN"), false);
      await writeFile(`${requestFile}.result.json`, JSON.stringify({ version: 1, id: request.id, status: "executed",
        admission: "running", started: true, processTreeStopped: true, exitCode: 0 }));
      return successfulCommand();
    });
  assert.equal(calls, 1);
  assert.equal(result.stdout, "candidate output");
  assert.ok((await readdir(configuration.private)).every((name) => name.endsWith(".result.json")));
});

test("missing or contradictory private receipts cannot become successful candidate execution", async (t) => {
  for (const mode of ["missing", "wrong-id", "wrong-exit", "cleanup", "not-started"]) {
    await t.test(mode, async (t) => {
      const configuration = await fixture(t);
      const boundary = isolatedCommandBoundary(configuration, { PATH: "owner-tools" }, environment(configuration));
      await assert.rejects(boundary("node", [], { cwd: configuration.candidate }, async (_file, args) => {
        const file = args.at(-1), request = JSON.parse(await readFile(file, "utf8"));
        if (mode !== "missing") await writeFile(`${file}.result.json`, JSON.stringify({
          version: 1, id: mode === "wrong-id" ? "another-command" : request.id, status: "executed",
          admission: "running",
          started: mode !== "not-started", processTreeStopped: mode !== "cleanup", exitCode: mode === "wrong-exit" ? 1 : 0,
        }));
        return successfulCommand();
      }), (error) => error.diagnosticCode === "cleanup-failed" && error.processTreeStopped === false);
    });
  }
});

test("confirmed no-admission cancellation is distinct from an unconfirmed suspended process", async (t) => {
  for (const platform of ["win32", "linux"]) for (const admission of ["not-admitted", "created"]) {
    await t.test(`${platform}/${admission}`, async (t) => {
      const configuration = { ...await fixture(t), platform };
      const boundary = isolatedCommandBoundary(configuration, {}, environment(configuration));
      await assert.rejects(boundary("node", [], {}, async (_file, args) => {
        const file = args.at(-1), request = JSON.parse(await readFile(file, "utf8"));
        await writeFile(`${file}.result.json`, JSON.stringify({ version: 1, id: request.id, status: "blocked",
          admission, interruption: "cancelled", started: false, exitCode: null, processTreeStopped: admission === "not-admitted" }));
        throw Object.assign(new Error("Native command did not execute"), successfulCommand());
      }), (error) => admission === "not-admitted"
        ? error.processTreeStopped === true && error.isolatedAdmission === "not-admitted" && error.commandOutcome?.reason === "cancelled"
        : error.processTreeStopped === false && error.diagnosticCode === "cleanup-failed");
    });
  }
});

test("outer command deadlines are not reclassified as native cancellation", async (t) => {
  for (const platform of ["win32", "linux"]) for (const cleaned of [true, false]) {
    await t.test(`${platform}/${cleaned ? "stopped" : "unconfirmed"}`, async (t) => {
      const configuration = { ...await fixture(t), platform };
      if (platform === "win32") await fixtureBroker(configuration);
      const boundary = isolatedCommandBoundary(configuration, {}, environment(configuration));
      await assert.rejects(boundary("node", [], {}, async (_file, args) => {
        const file = args.at(-1), bytes = await readFile(file), request = JSON.parse(bytes);
        await writeFile(`${file}.result.json`, JSON.stringify({
          version: 1, id: request.id, requestSha256: createHash("sha256").update(bytes).digest("hex"),
          status: "blocked", admission: "running", interruption: "cancelled", started: true,
          processTreeStopped: cleaned, exitCode: null,
        }));
        throw Object.assign(new Error("The outer deadline expired"), successfulCommand(), {
          commandOutcome: { observedProcess: "owned-command-supervisor", reason: "timeout",
            exitCode: 78, cleanupFailure: null },
        });
      }), (error) => {
        assert.equal(error.processTreeStopped, cleaned);
        assert.equal(error.diagnosticCode, cleaned ? "command-timeout" : "cleanup-failed");
        if (cleaned) assert.equal(error.commandOutcome.reason, "timeout");
        return true;
      });
    });
  }
});

test("native output limits remain failures and still require both cleanup confirmations", async (t) => {
  for (const cause of ["native", "outer"]) for (const cleaned of [true, false]) {
    await t.test(`${cause}/${cleaned}`, async (t) => {
      const configuration = { ...await fixture(t), platform: "win32" };
      await fixtureBroker(configuration);
      const boundary = isolatedCommandBoundary(configuration, {}, environment(configuration));
      await assert.rejects(boundary("node", [], {}, async (_file, args) => {
        const file = args.at(-1), bytes = await readFile(file), request = JSON.parse(bytes);
        await writeFile(`${file}.result.json`, JSON.stringify({
          version: 1, id: request.id, requestSha256: createHash("sha256").update(bytes).digest("hex"),
          status: "blocked", admission: "running", interruption: "cancelled", started: true,
          processTreeStopped: cleaned, exitCode: null, outputTruncated: cause === "native",
        }));
        throw Object.assign(new Error("Private output exceeded its budget"), successfulCommand(), {
          commandOutcome: { observedProcess: "owned-command-supervisor",
            reason: cause === "outer" ? "output-limit" : "exit", exitCode: 78, cleanupFailure: null },
        });
      }), (error) => {
        assert.equal(error.processTreeStopped, cleaned);
        assert.equal(error.diagnosticCode, cleaned ? "output-limit" : "cleanup-failed");
        if (cleaned) {
          assert.equal(error.commandOutcome.reason, "output-limit");
          assert.equal(error.commandOutcome.outputTruncated, true);
        }
        return true;
      });
    });
  }
});

test("Windows DWORD exit representations preserve real failures without weakening receipt matching", async (t) => {
  for (const [platform, reported, observed, matches] of [
    ["win32", -1073741502, 3221225794, true],
    ["win32", 3221225794, -1073741502, true],
    ["win32", -1073741502, 3221225795, false],
    ["win32", -4294967297, 4294967295, false],
    ["linux", -1073741502, 3221225794, false],
  ]) {
    await t.test(`${platform}/${reported}/${observed}`, async (t) => {
      const configuration = { ...await fixture(t), platform };
      if (platform === "win32") await fixtureBroker(configuration);
      const boundary = isolatedCommandBoundary(configuration, {}, environment(configuration));
      const failure = Object.assign(new Error("The target did not initialize"), successfulCommand(), {
        commandOutcome: { observedProcess: "owned-command-supervisor", reason: "exit",
          exitCode: observed, cleanupFailure: null },
      });
      await assert.rejects(boundary("node", [], {}, async (_file, args) => {
        const file = args.at(-1), bytes = await readFile(file), request = JSON.parse(bytes);
        await writeFile(`${file}.result.json`, JSON.stringify({
          version: 1, id: request.id, requestSha256: createHash("sha256").update(bytes).digest("hex"),
          status: "executed", admission: "running", started: true, processTreeStopped: true, exitCode: reported,
        }));
        throw failure;
      }), (error) => {
        if (matches) {
          assert.equal(error, failure);
          assert.equal(error.isolatedAdmission, "running");
          assert.equal(error.isolatedExecutionObserved, true);
          assert.equal(error.processTreeStopped, true);
          assert.equal(error.commandOutcome.exitCode, observed);
        } else {
          assert.equal(error.diagnosticCode, "cleanup-failed");
          assert.equal(error.processTreeStopped, false);
        }
        return true;
      });
    });
  }
});

test("atomic launch failures preserve bounded native stage and privilege facts", async (t) => {
  const configuration = { ...await fixture(t), platform: "win32" };
  const boundary = isolatedCommandBoundary(configuration, {}, environment(configuration));
  await assert.rejects(boundary("node", [], {}, async (_file, args) => {
    const file = args.at(-1), request = JSON.parse(await readFile(file, "utf8"));
    await writeFile(`${file}.result.json`, JSON.stringify({ version: 1, id: request.id, status: "blocked",
      admission: "creation-attempted", started: false, processTreeStopped: true, exitCode: null,
      native: { stage: "create", errorCode: 1314, assignPrimaryTokenEnabled: false, increaseQuotaEnabled: true,
        privateValue: "must-not-be-projected" } }));
    throw Object.assign(new Error("Atomic launch rejected"), successfulCommand());
  }), (error) => {
    assert.equal(error.diagnosticCode, "preflight-tool");
    assert.equal(error.processTreeStopped, true);
    assert.equal(error.commandOutcome.reason, "spawn");
    assert.deepEqual(error.nativeFailure, { stage: "create", errorCode: 1314,
      assignPrimaryTokenEnabled: false, increaseQuotaEnabled: true });
    return true;
  });
});

test("unconfirmed cleanup retains only consistent, identified native failure facts", async (t) => {
  for (const mode of ["native-cleanup", "outer-cleanup", "wrong-id", "wrong-version", "wrong-started", "wrong-exit"]) {
    await t.test(mode, async (t) => {
      const configuration = { ...await fixture(t), platform: "win32" };
      const boundary = isolatedCommandBoundary(configuration, {}, environment(configuration));
      await assert.rejects(boundary("node", [], {}, async (_file, args) => {
        const file = args.at(-1), request = JSON.parse(await readFile(file, "utf8"));
        await writeFile(`${file}.result.json`, JSON.stringify({
          version: mode === "wrong-version" ? 2 : 1, id: mode === "wrong-id" ? "another-request" : request.id,
          status: "blocked", admission: "creation-attempted", started: mode === "wrong-started",
          processTreeStopped: mode === "outer-cleanup", exitCode: mode === "wrong-exit" ? 0 : null,
          native: { stage: "create", errorCode: 1314, assignPrimaryTokenEnabled: false, increaseQuotaEnabled: true },
        }));
        throw Object.assign(new Error("Native attempt and cleanup did not complete"), successfulCommand(),
          { processTreeStopped: mode !== "outer-cleanup" });
      }), (error) => {
        assert.equal(error.diagnosticCode, "cleanup-failed");
        assert.equal(error.processTreeStopped, false);
        if (["native-cleanup", "outer-cleanup"].includes(mode)) {
          assert.equal(error.isolatedAdmission, "creation-attempted");
          assert.deepEqual(error.nativeFailure, {
            stage: "create", errorCode: 1314, assignPrimaryTokenEnabled: false, increaseQuotaEnabled: true,
          });
        } else {
          assert.equal(error.isolatedAdmission, undefined);
          assert.equal(error.nativeFailure, undefined);
        }
        return true;
      });
    });
  }
});

test("Windows control cancellation and EOF before native creation report a confirmed no-start outcome",
  { skip: process.platform !== "win32" }, async (t) => {
    const configuration = await fixture(t), marker = path.join(configuration.candidate, "must-not-run");
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const script = [
      "$ErrorActionPreference='Stop'",
      `Add-Type -Path ${quote(path.resolve("scripts", "isolated-command.cs"))}`,
      "$results=@()",
      "foreach($message in @('cancel',[System.Management.Automation.Language.NullString]::Value)) {",
      "  $inputTask=[Threading.Tasks.TaskCompletionSource[string]]::new(); $inputTask.SetResult($message)",
      "  $owner=[DevPocketIsolatedCommand]::new($inputTask.Task)",
      "  try {",
      "    try {",
      `      $null=$owner.Run('unused-fixture-user','unused-fixture-password','S-1-0-0',${quote(process.execPath)},` +
        `[string[]]@('-e',${quote(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`)}),` +
        `[string[]]@(),${quote(configuration.candidate)},5000)`,
      "      throw 'Cancellation did not stop native creation.'",
      "    } catch {",
      "      $failure=$_.Exception; while($failure.InnerException) { $failure=$failure.InnerException }",
      "      if($failure -isnot [OperationCanceledException]) { throw }",
      "    }",
      "    $results+=@{admission=$owner.Admission;started=$owner.Started;stopped=$owner.ProcessTreeStopped;interruption=$owner.Interruption}",
      "  } finally { $owner.Dispose() }",
      "}",
      "ConvertTo-Json -InputObject $results -Compress",
    ].join("\n");
    const output = await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 30000 });
    assert.deepEqual(JSON.parse(output.stdout), Array.from({ length: 2 }, () =>
      ({ admission: "not-admitted", started: false, stopped: true, interruption: "cancelled" })));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  });

test("Linux control cancellation, EOF and expired deadlines stop admission before Popen", async (t) => {
  const configuration = await fixture(t);
  const script = String.raw`
import ctypes
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("isolated_command", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
directory = Path(sys.argv[2])
for mode in ["cancel", "eof", "timeout", "exit-cancel", "success"]:
    request = directory / (mode + ".json")
    request.write_text(json.dumps({"version": 1, "id": mode, "uid": 1234, "gid": 1234,
        "file": sys.executable, "arguments": [], "cwd": str(directory), "environment": {}, "timeoutMs": 1000}))
    info = SimpleNamespace(st_uid=0, st_mode=0o600, st_size=request.stat().st_size)
    spawned = Mock(return_value=SimpleNamespace(poll=lambda: 0, returncode=0))
    cleanup = Mock()
    owned = SimpleNamespace(stop_descendants=cleanup)
    loader = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))
    ready = Mock(return_value=([0], [], []) if mode in ["cancel", "eof"] else ([], [], []))
    if mode == "exit-cancel":
        ready.side_effect = [([], [], []), ([0], [], [])]
    clock = Mock(side_effect=[0, 2]) if mode == "timeout" else Mock(return_value=0)
    error = None
    with (
        patch.object(worker.os, "geteuid", return_value=0, create=True),
        patch.object(worker.Path, "stat", return_value=info),
        patch.object(worker.importlib.util, "spec_from_file_location", return_value=loader),
        patch.object(worker.importlib.util, "module_from_spec", return_value=owned),
        patch.object(ctypes, "CDLL", return_value=SimpleNamespace(prctl=lambda *args: 0)),
        patch.object(worker.subprocess, "Popen", spawned),
        patch.object(worker.select, "select", ready),
        patch.object(worker.os, "read", return_value=b"" if mode == "eof" else b"cancel\n"),
        patch.object(worker.time, "monotonic", clock),
    ):
        try:
            worker.main(str(request))
        except (InterruptedError, TimeoutError) as failure:
            error = failure
    receipt = json.loads(Path(str(request) + ".result.json").read_text())
    admitted = mode in ["exit-cancel", "success"]
    assert spawned.call_count == int(admitted), (mode, receipt)
    assert receipt["started"] is admitted, (mode, receipt)
    assert receipt["admission"] == ("running" if admitted else "not-admitted"), (mode, receipt)
    assert receipt["processTreeStopped"] is True, (mode, receipt)
    cleanup.assert_called_once()
    if mode == "success":
        assert error is None and receipt["status"] == "executed" and receipt["exitCode"] == 0, receipt
    else:
        expected = TimeoutError if mode == "timeout" else InterruptedError
        assert isinstance(error, expected), (mode, error)
        assert receipt["status"] == "blocked" and receipt["exitCode"] is None, (mode, receipt)
        assert receipt["interruption"] == ("timeout" if mode == "timeout" else "cancelled"), (mode, receipt)
print("pre-admission cancellation, EOF, deadline and exit reconciliation passed")
`;
  const output = await exec("python", ["-I", "-B", "-c", script, path.resolve("scripts", "isolated-command.py"), configuration.private],
    { timeout: 30000 });
  assert.match(output.stdout, /pre-admission cancellation, EOF, deadline and exit reconciliation passed/);
});

test("cancellation before admission never invokes the native isolated owner", async (t) => {
  const configuration = await fixture(t), controller = new AbortController();
  controller.abort(new Error("Already cancelled"));
  const boundary = isolatedCommandBoundary(configuration, {}, environment(configuration));
  await assert.rejects(boundary("node", [], { signal: controller.signal }, () => assert.fail("No native admission after cancellation.")),
    /Already cancelled/);
  assert.deepEqual(await readdir(configuration.private), []);
});

test("command boundaries remain scoped across asynchronous operations and cannot be replaced", async () => {
  await Promise.all(["first", "second"].map((label) => withCommandBoundary(async (file) => ({ label, file }), async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await runCommand("not-an-executable", []), { label, file: "not-an-executable" });
    assert.throws(() => withCommandBoundary(() => {}, () => {}), /cannot be replaced/);
  })));
  assert.throws(() => withGitExecutable("git", {}, () => {}), /absolute/);
  await withGitExecutable(process.execPath, {}, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => withGitExecutable(process.execPath, {}, () => {}), /non-replaceable/);
  });
});

test("Windows token creation joins its Job atomically and has no weaker credential-launch fallback", async () => {
  const source = await readFile(new URL("../isolated-command.cs", import.meta.url), "utf8");
  assert.match(source, /CreateProcessAsUserW/);
  assert.match(source, /0x2000d/);
  assert.match(source, /0x20002/);
  assert.match(source, /0x08080404/);
  assert.doesNotMatch(source, /CreateProcessWithLogonW|AssignProcessToJobObject/);
  assert.ok(source.indexOf("AssignPrimaryTokenEnabled = PrepareCreationPrivileges();") < source.indexOf("job = CreateJobObjectW"));
  assert.match(source, /name == "SeAssignPrimaryTokenPrivilege" && error == 1300/);
  assert.match(source, /if \(!adjusted\) throw new Win32Exception\(error\)/);
  assert.ok(source.indexOf("if (!IsProcessInJob") < source.indexOf("if (ResumeThread"));
  assert.match(source, /Task\.Run\(\(\) => Console\.In\.ReadLine\(\)\)/);
  assert.doesNotMatch(source, /Console\.In\.ReadLineAsync|input = GetStdHandle\(-10\)/);
  assert.match(source, /CheckControl\(cancellation, deadline\);\s+if \(ResumeThread/);
  assert.match(source, /input = targetInput/);
  assert.match(source, /CreateRestrictedToken\(token, 0x9, 0, IntPtr\.Zero, 0, IntPtr\.Zero, 1, sids/);
  assert.match(source, /GetTokenInformation\(token, 11/);
  assert.match(source, /Marshal\.ReadInt32\(restrictions\) != 1/);
  assert.match(source, /desktop = ""/);
  assert.match(source, /DescribeDesktopScope/);
  assert.doesNotMatch(source, /CreateWindowStationW|ProtectAncestor|SetUserObjectSecurity|CreateDesktopW/);
  const bootstrap = await readFile(new URL("../isolated-worker.ps1", import.meta.url), "utf8");
  assert.match(bootstrap, /NT AUTHORITY\\LocalService/);
  assert.match(bootstrap, /SeAssignPrimaryTokenPrivilege\/SeIncreaseQuotaPrivilege/);
  assert.doesNotMatch(bootstrap, /\[DevPocketIsolatedCommand\]::PrepareCreationPrivileges\(\)/);
  assert.doesNotMatch(bootstrap, /Protect-Ancestors|Assert-AncestorProtection|Invoke-AtomicLaunchProbe/);
  assert.match(bootstrap, /permissionOnlyPaths = @\(\$broadParent, \$broadChild\)/);
  const service = await readFile(new URL("../windows-supervisor.cs", import.meta.url), "utf8");
  assert.match(service, /while \(!shutdown\.Task\.IsCompleted\)/);
  assert.match(service, /OutputLimit = 16 \* 1024 \* 1024/);
  assert.match(service, /AnonymousPipeServerStream\(PipeDirection\.In, HandleInheritability\.None\)/);
  assert.match(service, /File\.Move\(temporary, file\)/);
});

test("Linux drops every candidate capability and never places its root owner below setpriv", async () => {
  const source = await readFile(new URL("../isolated-command.py", import.meta.url), "utf8");
  for (const flag of ["--no-new-privs", "--clear-groups", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all"]) {
    assert.ok(source.includes(flag), flag);
  }
  assert.match(source, /os\.geteuid\(\) != 0/);
  assert.match(source, /owned\.stop_descendants\(\)/);
  assert.match(source, /os\.O_EXCL/);
});

test("Linux bootstrap refusal reports its bounded stage without entering hosted OS setup", async () => {
  const script = [
    "import os, runpy, sys, types",
    "sys.modules['pwd'] = types.ModuleType('pwd')",
    "os.environ['GITHUB_ACTIONS'] = 'false'",
    "runpy.run_path(sys.argv[1], run_name='__main__')",
  ].join("\n");
  await assert.rejects(exec("python", ["-I", "-B", "-c", script, path.resolve("scripts", "isolated-worker.py")],
    { timeout: 30000 }), (error) => {
    assert.equal(error.code, 78);
    assert.deepEqual(JSON.parse(error.stderr), {
      status: "blocked", phase: "isolated-bootstrap", error: "RuntimeError", stage: "configuration",
    });
    return true;
  });
});

test("evidence-read proof accepts only permission denial, not sharing errors or readable data", async (t) => {
  const script = String.raw`
import fs from "node:fs";
import childProcess from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
const [mode, probe] = process.argv.slice(1);
const source = fs.readFileSync(new URL(probe), "utf8");
const deny = () => { throw Object.assign(new Error("synthetic permission denial"), {code:"EACCES"}); };
let reads = 0, outcomes;
Object.assign(fs, {
  chmodSync: deny, renameSync: deny, rmSync: deny, symlinkSync: deny, existsSync: () => true,
  writeFileSync(file, value) {
    if (file.endsWith("attacks.json")) outcomes = JSON.parse(value);
    else deny();
  },
  readFileSync() {
    reads++;
    if (mode === "readable") return Buffer.from("synthetic private data");
    throw Object.assign(new Error("synthetic read result"), {code:mode});
  },
});
childProcess.spawn = () => ({unref() {}});
process.kill = deny;
syncBuiltinESMExports();
process.argv = ["node", "probe", "attack", JSON.stringify({
  fixture:"synthetic-fixture", probe:"synthetic-probe", runner:"synthetic-runner",
  evidence:"synthetic-evidence", supervisorPid:1, protectedPaths:[],
})];
try {
  await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  console.log(JSON.stringify({status:"passed", reads, outcomes}));
} catch (error) {
  console.log(JSON.stringify({status:"blocked", reads, code:error.code}));
}
`;
  for (const mode of ["EACCES", "EPERM", "EBUSY", "ENOTEMPTY", "readable"]) await t.test(mode, async () => {
    const result = await exec(process.execPath, ["--input-type=module", "-e", script, mode,
      new URL("../isolated-worker-probe.mjs", import.meta.url).href], {
      timeout: 30000, env: { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.reads, 1);
    if (["EACCES", "EPERM"].includes(mode)) {
      assert.equal(outcome.status, "passed");
      assert.deepEqual(outcome.outcomes.filter((item) => item.name === "evidence-read"), [{ name: "evidence-read", denied: true }]);
    } else {
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.code, mode === "readable" ? "ERR_ASSERTION" : mode);
    }
  });
});

test("Windows bootstrap does not assign the read-only HOME automatic variable", async () => {
  const file = path.resolve("scripts", "isolated-worker.ps1").replaceAll("'", "''");
  const script = `$tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$tokens,[ref]$errors); ` +
    "if($errors.Count){throw 'Bootstrap syntax failed'}; " +
    "$assignments=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and " +
    "$node.Left -is [Management.Automation.Language.VariableExpressionAst] -and $node.Left.VariablePath.UserPath -ieq 'HOME'},$true)); " +
    "ConvertTo-Json -InputObject @($assignments | ForEach-Object { $_.Extent.StartLineNumber }) -Compress";
  const result = await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 30000 });
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test("atomic launch diagnostics stop before candidate preparation and cannot become an isolation proof",
  { skip: process.platform !== "win32" }, async (t) => {
    const configuration = await fixture(t), scripts = path.join(configuration.control, "scripts");
    await cp(path.resolve("scripts"), scripts, { recursive: true });
    const file = path.join(scripts, "process.mjs"), source = await readFile(file, "utf8");
    const entry = "export function runCommand(file, args, options = {}) {";
    assert.ok(source.includes(entry));
    const result = { ...successfulCommand(), stdout: "DEVPOCKET_ISOLATED_LAUNCH",
      isolatedAdmission: "running", isolatedExecutionObserved: true };
    await writeFile(file, source.replace(entry, `${entry}
      if (file !== process.execPath || JSON.stringify(args) !== ${JSON.stringify(JSON.stringify([
        "--disable-sigusr1", "-e", "process.stdout.write('DEVPOCKET_ISOLATED_LAUNCH')",
      ]))}) throw new Error("Only the fixed atomic launch is allowed in this fixture.");
      return Promise.resolve(${JSON.stringify(result)});
    `));
    configuration.mode = "atomic-launch-probe";
    await fixtureBroker(configuration);
    configuration.tools.git = process.execPath;
    configuration.tools.python = process.execPath;
    const input = path.join(configuration.private, "configuration.json");
    await writeFile(input, JSON.stringify(configuration));
    const output = await exec(process.execPath, [path.join(scripts, "isolated-worker.mjs"), "--configuration", input], {
      cwd: configuration.control, timeout: 30000,
      env: { ...process.env, GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" },
    });
    const directory = path.join(configuration.control, ".data", "ci", "isolated");
    const capability = JSON.parse(await readFile(path.join(directory, "atomic-launch-capability.json"), "utf8"));
    assert.deepEqual(capability, { version: 1, kind: "atomic-launch-capability", acceptance: false,
      status: "available", platform: "win32", admission: "running", exitCode: 0, processTreeStopped: true });
    assert.deepEqual(JSON.parse(output.stdout), capability);
    await assert.rejects(readFile(path.join(directory, "isolation-proof.json")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(directory, "report.json")), { code: "ENOENT" });
    assert.deepEqual(await readdir(configuration.candidate), []);
    assert.deepEqual(await readdir(configuration.fixture), []);
  });

test("self-test completes uncancelled owner-side lifecycle checks before publishing its proof",
  { skip: process.platform !== "win32" }, async (t) => {
    for (const outcome of ["passed", "failed", "aborted", "abort-sync", "abort-close", "missing"]) await t.test(outcome, async (t) => {
      const configuration = await fixture(t), scripts = path.join(configuration.control, "scripts");
      await cp(path.resolve("scripts"), scripts, { recursive: true });
      await fixtureBroker(configuration);
      configuration.mode = "self-test";
      configuration.sid = "S-1-5-21-1-2-3-1001";
      configuration.desktopProbe = configuration.broker.file;
      configuration.tools.git = process.execPath;
      configuration.tools.python = process.execPath;
      await writeFile(path.join(configuration.private, "service-capabilities.json"), JSON.stringify({
        desktopScope: { sid: "S-1-5-19", interactive: false, sessionId: 0,
          authenticationId: "0000000000000000", logonSid: "S-1-5-5-0-0", windowStation: "service-owner" },
      }));
      const processFile = path.join(scripts, "process.mjs");
      let processSource = await readFile(processFile, "utf8");
      const body = processSource.indexOf("  const deadlineUnixMs = Date.now() + timeoutMs;", processSource.indexOf("function runOwnedCommand("));
      assert.ok(body > 0);
      processSource = "import {readFile as fixtureRead,writeFile as fixtureWrite} from 'node:fs/promises';\n" +
        "import {createHash as fixtureHash} from 'node:crypto';\nlet fixtureDesktop = 0;\n" +
        processSource.slice(0, body) + `
  return (async () => {
    if (file === 'fixture-owner-only') {
      await fixtureWrite(${JSON.stringify(path.join(configuration.private, "owner-admitted"))}, 'owner');
      return {stdout:'OWNER_CONTEXT'};
    }
    if (args[0] !== '--client') throw new Error('Target work escaped the command boundary');
    const requestFile = args.at(-1), bytes = await fixtureRead(requestFile), request = JSON.parse(bytes);
    let stdout;
    if (request.arguments.includes('--desktop-scope')) {
      const serial = ++fixtureDesktop;
      stdout = JSON.stringify({version:1,kind:'windows-desktop-scope',sid:${JSON.stringify(configuration.sid)},
        interactive:false,sessionId:0,authenticationId:String(serial).padStart(16,'0'),
        logonSid:'S-1-5-5-0-'+serial,windowStation:'candidate-'+serial,desktop:'Default'});
    } else if (request.arguments.includes('--version')) stdout = 'PowerShell 7.6.7';
    else if (request.arguments.includes('--fixture-target')) stdout = 'TARGET_CONTEXT';
    else if (request.arguments.includes("process.stdout.write('DEVPOCKET_ISOLATED_LAUNCH')")) stdout = 'DEVPOCKET_ISOLATED_LAUNCH';
    else throw new Error('Unexpected fixture target');
    await fixtureWrite(requestFile+'.result.json',JSON.stringify({version:1,id:request.id,
      requestSha256:fixtureHash('sha256').update(bytes).digest('hex'),status:'executed',admission:'running',
      started:true,processTreeStopped:true,exitCode:0}));
    return {stdout,stderr:'',processTreeStopped:true,
      commandOutcome:{observedProcess:'owned-command-supervisor',reason:'exit',exitCode:0,cleanupFailure:null}};
  })();
` + processSource.slice(body);
      await writeFile(processFile, processSource);
      const workerFile = path.join(scripts, "isolated-worker.mjs"), original = await readFile(workerFile, "utf8");
      const proofEntry = "async function proveIsolation(configuration, directory) {";
      const lifecycleEntry = "async function windowsSupervisorChecks(configuration, ownerEnvironment, candidateEnvironment, signal) {";
      assert.ok(original.includes(proofEntry) && original.includes(lifecycleEntry));
      let altered = original.replace(proofEntry, `${proofEntry}
  { const probe = await runCommand(configuration.tools.node, ['--fixture-target']);
    assert.equal(probe.stdout, 'TARGET_CONTEXT');
    return ${outcome === "missing" ? "undefined" : "{version:1,kind:'fixture-isolation-proof',status:'passed'}"}; }
`).replace(lifecycleEntry, `${lifecycleEntry}
  { ${outcome === "aborted" ? `
    assert.ok(signal);
    process.emit('SIGINT');
    assert.equal(signal.aborted, true);
    await writeFile(path.join(configuration.private, 'lifecycle-called'), 'aborted');
    return {status:'passed'};
    ` : ""}
    const owner = await runCommand('fixture-owner-only', []);
    assert.equal(owner.stdout, 'OWNER_CONTEXT');
    await writeFile(path.join(configuration.private, 'lifecycle-called'), 'owner');
    ${outcome === "failed" ? "throw new Error('FIXTURE_LIFECYCLE_FAILED');" : "return {status:'passed'};"} }
`);
      if (outcome.startsWith("abort-")) {
        const method = outcome.slice("abort-".length), opened = 'const output = await open(file, "wx", 0o600);';
        assert.ok(altered.includes(opened));
        altered = altered.replace(opened, `${opened}
  if (path.basename(file) === 'isolation-proof.json') {
    const original = output.${method}.bind(output);
    output.${method} = async () => {
      await original();
      assert.equal(JSON.parse(await readFile(file, 'utf8')).status, 'passed');
      await writeFile(path.join(path.dirname(file), 'proof-written'), '${method}');
      process.emit('SIGINT');
      throw new Error('FIXTURE_PROOF_${method.toUpperCase()}_FAILED');
    };
  }
`);
      }
      assert.notEqual(altered, original);
      await writeFile(workerFile, altered);
      const input = path.join(configuration.private, "configuration.json");
      await writeFile(input, JSON.stringify(configuration));
      const run = exec(process.execPath, [workerFile, "--configuration", input], {
        cwd: configuration.control, timeout: 30000,
        env: { ...process.env, GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" },
      });
      const proof = path.join(configuration.control, ".data", "ci", "isolated", "isolation-proof.json");
      if (outcome !== "passed") {
        await assert.rejects(run, (error) => error.code === 78);
        await assert.rejects(readFile(proof), { code: "ENOENT" });
      } else {
        await run;
        const recorded = JSON.parse(await readFile(proof, "utf8"));
        assert.equal(recorded.kind, "fixture-isolation-proof");
        assert.deepEqual(recorded.supervisorLifecycle, { status: "passed" });
      }
      if (outcome === "missing") {
        await assert.rejects(readFile(path.join(configuration.private, "lifecycle-called")), { code: "ENOENT" });
      } else {
        assert.equal(await readFile(path.join(configuration.private, "lifecycle-called"), "utf8"), outcome === "aborted" ? "aborted" : "owner");
      }
      if (["aborted", "missing"].includes(outcome)) {
        await assert.rejects(readFile(path.join(configuration.private, "owner-admitted")), { code: "ENOENT" });
      }
      if (outcome.startsWith("abort-")) {
        assert.equal(await readFile(path.join(path.dirname(proof), "proof-written"), "utf8"), outcome.slice("abort-".length));
      }
    });
  });

test("cancelled evidence publication preserves an existing file and reports owned invalidation failure", async (t) => {
  const configuration = await fixture(t), scripts = path.join(configuration.control, "scripts");
  await cp(path.resolve("scripts"), scripts, { recursive: true });
  const file = path.join(scripts, "isolated-worker.mjs");
  const original = await readFile(file, "utf8"), opened = 'const output = await open(file, "wx", 0o600);';
  assert.ok(original.includes(opened));
  const altered = original.replace(opened, `
  const fixtureCancellation = new AbortController();
  signal = fixtureCancellation.signal;
  if (file.endsWith('existing.json')) fixtureCancellation.abort(new Error('FIXTURE_CANCELLED'));
  ${opened}
  const fixtureSync = output.sync.bind(output);
  output.sync = async () => {
    await fixtureSync();
    fixtureCancellation.abort(new Error('FIXTURE_CANCELLED'));
    throw new Error('FIXTURE_SYNC_FAILED');
  };
`).replace("await unlink(file);", "throw new Error('FIXTURE_INVALIDATION_FAILED');");
  assert.notEqual(altered, original);
  await writeFile(file, altered + "\nexport { immutableJson };\n");
  const worker = await import(pathToFileURL(file).href);
  const existing = path.join(configuration.private, "existing.json"), retained = '{"existing":true}\n';
  await writeFile(existing, retained);
  await assert.rejects(worker.immutableJson(existing, { status: "passed" }), { code: "EEXIST" });
  assert.equal(await readFile(existing, "utf8"), retained);
  const owned = path.join(configuration.private, "owned.json");
  await assert.rejects(worker.immutableJson(owned, { status: "passed" }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /could not be invalidated/);
    assert.equal(error.errors.at(-1).message, "FIXTURE_INVALIDATION_FAILED");
    assert.ok(error.errors[0] instanceof AggregateError);
    assert.deepEqual(error.errors[0].errors.map((item) => item.message), ["FIXTURE_SYNC_FAILED", "FIXTURE_CANCELLED"]);
    return true;
  });
  assert.equal(JSON.parse(await readFile(owned, "utf8")).status, "passed");
});

test("already-aborted supervisor lifecycle cannot inspect configuration or admit work", async (t) => {
  const configuration = await fixture(t), scripts = path.join(configuration.control, "scripts");
  await cp(path.resolve("scripts"), scripts, { recursive: true });
  const file = path.join(scripts, "isolated-worker.mjs");
  await writeFile(file, await readFile(file, "utf8") + "\nexport { windowsSupervisorChecks };\n");
  const worker = await import(pathToFileURL(file).href);
  const cancellation = new AbortController(), reason = new Error("Fixture task stopped");
  cancellation.abort(reason);
  await assert.rejects(worker.windowsSupervisorChecks(null, null, null, cancellation.signal), (error) => error === reason);
});

test("bootstrap command failures retain the actual bounded diagnostic before exiting",
  { skip: process.platform !== "win32" }, async (t) => {
    const configuration = await fixture(t), scripts = path.join(configuration.control, "scripts");
    await cp(path.resolve("scripts"), scripts, { recursive: true });
    const file = path.join(scripts, "process.mjs"), original = await readFile(file, "utf8");
    const entry = "export function runCommand(file, args, options = {}) {";
    assert.ok(original.includes(entry));
    const altered = original.replace(entry, `${entry}
      throw Object.assign(new Error("Synthetic bootstrap command failure"), {
        code: 1, processTreeStopped: true, isolatedExecutionObserved: true,
        stdout: "x".repeat(300000), stderr: "\\n::error::ISOLATION_FAILURE_CANARY\\n",
        commandOutcome: { observedProcess: "owned-command-supervisor", reason: "exit", exitCode: 1, cleanupFailure: null },
      });`);
    assert.notEqual(altered, original);
    await writeFile(file, altered);
    assert.equal(await readFile(file, "utf8"), altered, "The isolated fixture must use the failing command implementation.");
    configuration.mode = "self-test";
    await fixtureBroker(configuration);
    configuration.desktopProbe = configuration.broker.file;
    configuration.tools.git = process.execPath;
    configuration.tools.python = process.execPath;
    configuration.protectedPaths = [configuration.control, configuration.private];
    const input = path.join(configuration.private, "configuration.json");
    await writeFile(input, JSON.stringify(configuration));
    let failure;
    try {
      await exec(process.execPath, [path.join(scripts, "isolated-worker.mjs"), "--configuration", input], {
        cwd: configuration.control, timeout: 30000,
        env: { ...process.env, GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" },
      });
    } catch (error) { failure = error; }
    assert.equal(failure?.code, 78);
    assert.match(failure.stderr, /"reason":"command-failed"/, "The fixture must reach the failing command, not an earlier setup error.");
    const output = path.join(configuration.control, ".data", "ci", "isolated");
    const report = JSON.parse(await readFile(path.join(output, "bootstrap-failure.json"), "utf8"));
    assert.equal(report.kind, "isolated-bootstrap-diagnostics");
    assert.equal(report.acceptance, false);
    assert.equal(report.status, "blocked");
    assert.equal(report.phase, "native-launch");
    assert.equal(report.failure.reason, "command-failed");
    const log = await readFile(path.join(output, "bootstrap-failure.log"));
    assert.ok(log.length <= 1024 * 1024);
    assert.ok(log.toString().endsWith("::error::ISOLATION_FAILURE_CANARY\n"));
    assert.match(failure.stderr, /::stop-commands::[a-f0-9-]{36}/);
    assert.match(failure.stderr, /ISOLATION_FAILURE_CANARY/);
    assert.ok(Buffer.byteLength(failure.stderr) < 20000);
  });
