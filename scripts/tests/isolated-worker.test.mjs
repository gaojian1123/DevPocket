import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { isolatedCandidateEnvironment, isolatedCommandBoundary } from "../isolated-worker.mjs";
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
  const result = await withCommandBoundary(async (file, args, options, execute) => {
    if (args[0] !== "-B") return execute(file, args, options);
    calls.push({ file, args });
    assert.equal(file, process.execPath);
    return { ...successfulCommand(), stdout: JSON.stringify({ version: [3, 12, 0], executable: file, dependencies: "a".repeat(64) }) };
  }, () => verificationPreflight(root, plan, { group: "backend", operationsPython: process.execPath,
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
  const bootstrap = await readFile(new URL("../isolated-worker.ps1", import.meta.url), "utf8");
  assert.ok(bootstrap.indexOf("::PrepareCreationPrivileges()") < bootstrap.indexOf("New-LocalUser"));
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

test("Windows ancestor protection uses the handle-bound non-propagating mutation",
  { skip: process.platform !== "win32" }, async (t) => {
    const configuration = await fixture(t);
    const result = await exec("pwsh", ["-NoProfile", "-NonInteractive", "-File",
      path.resolve("scripts", "tests", "fixtures", "isolated-ancestor-acl.ps1"),
      "-Bootstrap", path.resolve("scripts", "isolated-worker.ps1"),
      "-NativeSource", path.resolve("scripts", "isolated-command.cs"), "-WorkingDirectory", configuration.candidate],
    { timeout: 30000 });
    assert.deepEqual(JSON.parse(result.stdout), ["C:\\fixture", "C:\\"]);
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
