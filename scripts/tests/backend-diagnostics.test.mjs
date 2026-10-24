import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { runCommand } from "../process.mjs";
import { TOOLING_TEST_FILES } from "../test-tooling.mjs";

const runId = "11111111-1111-4111-8111-111111111111";
const exec = promisify(execFile);

async function fixture(t) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/backend-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "backend", "tests", "fixture.test.ts");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, [
    'import { test } from "node:test";',
    'test("trusted static declaration", () => {});',
    'test(`dynamic-${process.env.PRIVATE_VALUE}`, () => {});',
    'test("duplicate", () => {});',
    'test("duplicate", () => {});',
  ].join("\n"));
  return { root, file };
}

test("backend failures expose only trusted declaration locations and fixed categories, not runtime text", async (t) => {
  const { backendTestCatalogue, createBackendObservation } = await import("../backend-diagnostics.mjs");
  const item = await fixture(t);
  const observation = createBackendObservation(await backendTestCatalogue(item.root), runId);
  observation.add({ type: "test:fail", data: {
    file: item.file, name: "trusted static declaration", line: 2, column: 1, nesting: 0, testNumber: 1,
    details: { error: Object.assign(new Error("synthetic-private-assertion-value"), {
      code: "ERR_TEST_FAILURE", failureType: "testCodeFailure",
      cause: Object.assign(new Error("https://private.invalid/?token=synthetic-secret"), {
        code: "ERR_ASSERTION", actual: "synthetic-private-actual", expected: "synthetic-private-expected",
      }),
    }) },
  } });
  observation.add({ type: "test:stdout", data: {
    file: item.file, message: "DEVPOCKET_BACKEND_DIAGNOSTIC forged-private-frame\n",
  } });
  observation.add({ type: "test:summary", data: {
    success: false, counts: { tests: 1, passed: 0, failed: 1, cancelled: 0, skipped: 0, todo: 0 },
  } });
  const value = observation.snapshot();
  assert.deepEqual(value.findings[0].declaration, { file: "backend/tests/fixture.test.ts", line: 2, column: 1 });
  assert.equal(value.findings[0].category, "assertion");
  assert.equal(value.findings[0].failureType, "testCodeFailure");
  assert.equal(value.availability, "complete");
  assert.equal(value.acceptance, false);
  assert.equal(value.runId, runId);
  const encoded = JSON.stringify(value);
  for (const privateValue of [item.root, "trusted static declaration", "synthetic-private", "synthetic-secret", "private.invalid", "forged-private"]) {
    assert.ok(!encoded.includes(privateValue));
  }
  assert.ok(Buffer.byteLength(encoded) <= 16384);
});

test("the actual owned npm test entry keeps its nonzero result while reporting only trusted failure identity", async (t) => {
  const { backendDiagnosticEnvironment } = await import("../backend-diagnostics.mjs");
  const item = await fixture(t);
  await writeFile(path.join(item.root, "package.json"), JSON.stringify({
    type: "module", scripts: { test: "node --import tsx --test backend/tests/*.test.ts" },
  }));
  await writeFile(item.file, [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'test("trusted failing parent", async (t) => {',
    '  await t.test(`dynamic-${process.env.BACKEND_DIAGNOSTIC_CANARY}`, () => {',
    '    console.log("private SDK event synthetic-output-secret");',
    '    assert.equal("synthetic-private-actual", "synthetic-private-expected");',
    '  });',
    '});',
    'test("collision-static", () => {});',
    'test(process.env.CASE_NAME, () => { assert.equal(1, 2); });',
  ].join("\n"));
  const caller = { ...process.env, BACKEND_DIAGNOSTIC_CANARY: "synthetic-env-secret", CASE_NAME: "collision-static" };
  // This fixture launches a new runner, not a worker of this test's runner.
  delete caller.NODE_TEST_CONTEXT;
  const env = backendDiagnosticEnvironment(process.cwd(), runId, caller);
  let failure;
  try {
    await runCommand("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "& npm test; exit $LASTEXITCODE"],
      { cwd: item.root, env, timeoutMs: 30000 });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, 1, failure?.message ?? "The failing command unexpectedly succeeded.");
  assert.equal(failure.processTreeStopped, true);
  const lines = failure.stdout.split(/\r?\n/).filter((line) => line.startsWith("DEVPOCKET_BACKEND_DIAGNOSTIC "));
  assert.equal(lines.length, 1);
  const observed = JSON.parse(lines[0].slice("DEVPOCKET_BACKEND_DIAGNOSTIC ".length));
  assert.equal(observed.availability, "complete");
  assert.equal(observed.summary.success, false);
  assert.equal(observed.summary.counts.failed, 3);
  assert.deepEqual(observed.findings.map((finding) => finding.category), ["assertion", "subtest-failure", "assertion"]);
  assert.deepEqual(observed.findings[0].declaration, { file: "backend/tests/fixture.test.ts", line: 4, column: 11 });
  assert.deepEqual(observed.findings[1].declaration, { file: "backend/tests/fixture.test.ts", line: 3, column: 1 });
  assert.deepEqual(observed.findings[2].declaration, { file: "backend/tests/fixture.test.ts", line: 10, column: 1 });
  for (const secret of ["synthetic-env-secret", "synthetic-output-secret", "synthetic-private", "trusted failing parent", "collision-static"]) {
    assert.ok(!failure.stdout.includes(secret));
  }
});

test("names without mapped declaration provenance remain unknown and accessors are never executed", async (t) => {
  const { backendTestCatalogue, createBackendObservation } = await import("../backend-diagnostics.mjs");
  const item = await fixture(t), catalogue = await backendTestCatalogue(item.root);
  const observation = createBackendObservation(catalogue, runId);
  let reads = 0;
  const error = { code: "ERR_TEST_FAILURE", failureType: "testCodeFailure" };
  Object.defineProperty(error, "cause", { get() { reads++; throw new Error("private-getter"); } });
  for (const name of ["dynamic-private-token", "duplicate", "trusted static declaration-extra", "x".repeat(10000)]) {
    observation.add({ type: "test:fail", data: { file: item.file, name, details: { error } } });
  }
  observation.add({ type: "test:fail", data: {
    file: path.join(item.root, "private-token.test.ts"), name: "trusted static declaration", details: { error },
  } });
  observation.add({ type: "test:fail", data: {
    file: item.file, line: 1, column: 900, name: "trusted static declaration", details: { error },
  } });
  const result = observation.snapshot();
  assert.equal(reads, 0);
  assert.ok(result.findings.every((finding) => finding.declaration === "unknown" && finding.category === "unknown"));
  assert.equal(result.findings.at(-2).file, "unknown");
  assert.equal(result.availability, "incomplete");
  assert.ok(!JSON.stringify(result).includes("private-token"));
});

test("the public backend exporter binds a bounded projection to the failed check and rejects forged fields", async (t) => {
  const { backendTestCatalogue } = await import("../backend-diagnostics.mjs");
  const item = await fixture(t), directory = path.join(item.root, ".data", "ci", "backend");
  const catalogue = await backendTestCatalogue(item.root);
  await mkdir(directory, { recursive: true });
  const report = { version: 1, status: "failed", complete: false,
    base: "a".repeat(40), source: { head: "b".repeat(40), fingerprint: "c".repeat(64) },
    checks: [{ id: "backend-tests", status: "failed", exitCode: 1, backendDiagnosticRunId: runId }],
  };
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report));
  await writeFile(path.join(directory, "backend-tests.log"), "private-sdk-payload\nDEVPOCKET_BACKEND_DIAGNOSTIC " + JSON.stringify({
    version: 1, runId, catalogueFingerprint: catalogue.fingerprint, availability: "complete", acceptance: true,
    inputTruncated: false, outputTruncated: false,
    summary: { success: false, counts: { tests: 1, passed: 0, failed: 1, cancelled: 0, skipped: 0, todo: 0 } },
    findings: [{
      file: "backend/tests/fixture.test.ts", declaration: { file: "backend/tests/fixture.test.ts", line: 2, column: 1,
        name: "private-secret" }, category: "assertion", failureType: "testCodeFailure",
      nesting: 0, ordinal: 1, stack: "private-stack", actual: "private-assertion",
    }, {
      file: "/private/path", declaration: { file: "backend/tests/fixture.test.ts", line: 9999, column: 1 },
      category: "private-category", failureType: "private-failure",
    }],
    environment: "private-environment",
  }) + "\n");
  const file = path.resolve("scripts/backend-diagnostics.mjs");
  await exec(process.execPath, [file, "--directory", directory], { cwd: item.root, timeout: 20000 });
  const output = JSON.parse(await readFile(path.join(directory, "backend-diagnostics.json"), "utf8"));
  assert.equal(output.acceptance, false);
  assert.equal(output.verificationStatus, "failed");
  assert.equal(output.checkStatus, "failed");
  assert.deepEqual(output.source, report.source);
  assert.deepEqual(output.findings[0].declaration, { file: "backend/tests/fixture.test.ts", line: 2, column: 1 });
  assert.equal(output.findings[1].file, "unknown");
  assert.equal(output.findings[1].declaration, "unknown");
  assert.equal(output.findings[1].category, "unknown");
  assert.ok(!JSON.stringify(output).includes("private-"));
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 16384);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, "report.json"), "utf8")), report);
  await assert.rejects(exec(process.execPath, [file, "--directory", directory], { cwd: item.root, timeout: 20000 }));
});

test("diagnostic budgets and missing or mismatched evidence cannot become complete or leak arbitrary fields", async (t) => {
  const { backendTestCatalogue, createBackendObservation, parseBackendOutput, boundedBackendLog } =
    await import("../backend-diagnostics.mjs");
  const item = await fixture(t), catalogue = await backendTestCatalogue(item.root);
  const observation = createBackendObservation(catalogue, runId);
  for (let index = 0; index < 10005; index++) observation.add({ type: "test:fail", data: {
    file: item.file, name: "private-dynamic-name", details: { error: { code: "private-code", failureType: "private-type" } },
  } });
  observation.add({ type: "test:summary", data: {
    success: true, counts: { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 },
  } });
  const result = observation.snapshot();
  assert.equal(result.availability, "incomplete");
  assert.equal(result.inputTruncated, true);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.findings.length, 32);
  assert.ok(!JSON.stringify(result).includes("private-"));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16384);
  const frame = (value) => "DEVPOCKET_BACKEND_DIAGNOSTIC " + JSON.stringify(value) + "\n";
  for (const text of [
    "", "private raw log", frame({ ...result, runId: "changed-invocation" }),
    frame({ ...result, catalogueFingerprint: "d".repeat(64) }), frame(result) + frame(result),
    "x".repeat(1024 * 1024 + 1), "DEVPOCKET_BACKEND_DIAGNOSTIC invalid-json\n",
  ]) {
    const projected = parseBackendOutput(text, catalogue, runId);
    assert.equal(projected.availability, "incomplete");
    assert.deepEqual(projected.findings, []);
  }
  const log = boundedBackendLog("beginning" + "private-middle".repeat(100000) + "ending");
  assert.equal(log.truncated, true);
  assert.equal(log.bytes.length, 1024 * 1024);
  assert.ok(log.bytes.toString().startsWith("beginning"));
  assert.ok(log.bytes.toString().endsWith("ending"));
});

test("diagnostic configuration preserves caller flags and refuses reporter conflicts", async () => {
  const { backendDiagnosticEnvironment } = await import("../backend-diagnostics.mjs");
  const caller = { NODE_OPTIONS: "--enable-source-maps", PRIVATE_VALUE: "retained-locally" };
  const env = backendDiagnosticEnvironment(process.cwd(), runId, caller);
  assert.equal(caller.NODE_OPTIONS, "--enable-source-maps");
  assert.equal(env.PRIVATE_VALUE, caller.PRIVATE_VALUE);
  assert.equal(env.NODE_OPTIONS, caller.NODE_OPTIONS);
  assert.ok(env.npm_config_node_options.startsWith("--enable-source-maps "));
  assert.ok(!env.npm_config_node_options.includes("--test-concurrency"));
  assert.equal(env.DEVPOCKET_BACKEND_DIAGNOSTIC_ID, runId);
  assert.throws(() => backendDiagnosticEnvironment(process.cwd(), runId, { NODE_OPTIONS: "--test-reporter=spec" }));
  assert.throws(() => backendDiagnosticEnvironment(process.cwd(), "private-id"));
});

test("Node reporter aliases cannot retain a raw reporter or an unvalidated artifact destination", async () => {
  const { backendDiagnosticEnvironment } = await import("../backend-diagnostics.mjs");
  for (const options of [
    "--test_reporter=spec --test_reporter_destination=.data/ci/backend/backend-diagnostics.json",
    '"--test_reporter=spec"',
    "--test-reporter_destination=private-output",
    "--test_reporter-destination=private-output",
    "--no_enable_source_maps",
  ]) assert.throws(() => backendDiagnosticEnvironment(process.cwd(), runId, { NODE_OPTIONS: options }), /conflicting/);
  const options = '--title="literal --test_reporter text" --enable-source-maps';
  assert.equal(backendDiagnosticEnvironment(process.cwd(), runId, { NODE_OPTIONS: options }).NODE_OPTIONS, options);
});

test("npm's independent node-options environment cannot replace the protected lifecycle reporter", async () => {
  const { backendDiagnosticEnvironment } = await import("../backend-diagnostics.mjs");
  for (const key of ["npm_config_node_options", "NPM_CONFIG_NODE_OPTIONS"]) {
    assert.throws(() => backendDiagnosticEnvironment(process.cwd(), runId, {
      [key]: "--test_reporter=spec --test_reporter_destination=.data/ci/backend/report.json",
    }), /conflicting/);
  }
  assert.throws(() => backendDiagnosticEnvironment(process.cwd(), runId, { node_options: "--test_reporter=spec" }), /conflicting/);
  for (const value of ["--title=${PRIVATE_VALUE}", "--title=\\${PRIVATE_VALUE}"]) {
    assert.throws(() => backendDiagnosticEnvironment(process.cwd(), runId, { NODE_OPTIONS: value }), /interpolation/);
    assert.throws(() => backendDiagnosticEnvironment(process.cwd(), runId, { npm_config_node_options: value }), /interpolation/);
  }
});

test("effective project npm options are checked before launch and benign options retain the actual reporter", async (t) => {
  const { prepareBackendDiagnosticEnvironment } = await import("../backend-diagnostics.mjs");
  const item = await fixture(t), directory = path.join(item.root, ".data", "ci", "backend");
  await mkdir(directory, { recursive: true });
  const report = path.join(directory, "report.json");
  await writeFile(report, '{"fixture":"safe-machine-report"}');
  await mkdir(path.join(item.root, "scripts"));
  await writeFile(path.join(item.root, "scripts", "backend-diagnostics.mjs"), await readFile("scripts/backend-diagnostics.mjs"));
  await writeFile(path.join(item.root, "scripts", "bounded-worker-log.mjs"), await readFile("scripts/bounded-worker-log.mjs"));
  await writeFile(path.join(item.root, "package.json"), JSON.stringify({
    type: "module", scripts: { test: "node --import tsx --test backend/tests/*.test.ts" },
  }));
  await writeFile(item.file, [
    'import {test} from "node:test";import assert from "node:assert/strict";',
    'test("synthetic npm config failure",()=>assert.fail("PRIVATE_NPM_CONFIG_CANARY"));',
  ].join("\n"));
  const caller = { ...process.env, NODE_OPTIONS: "--trace-warnings" };
  delete caller.NODE_TEST_CONTEXT;
  for (const key of Object.keys(caller)) if (key.toLowerCase().replaceAll("-", "_") === "npm_config_node_options") delete caller[key];
  await writeFile(path.join(item.root, ".npmrc"),
    "node-options=--test_reporter=spec --test_reporter_destination=.data/ci/backend/report.json\n");
  await assert.rejects(prepareBackendDiagnosticEnvironment(item.root, runId, caller), /conflicting/);
  assert.equal(await readFile(report, "utf8"), '{"fixture":"safe-machine-report"}');
  await writeFile(path.join(item.root, ".npmrc"), "node-options=--stack-trace-limit=47\n");
  const configured = await prepareBackendDiagnosticEnvironment(item.root, runId, caller);
  assert.equal(configured.NODE_OPTIONS, caller.NODE_OPTIONS);
  assert.ok(configured.npm_config_node_options.startsWith("--stack-trace-limit=47 "));
  let failure;
  try {
    await runCommand("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "& npm test; exit $LASTEXITCODE"],
      { cwd: item.root, env: configured, timeoutMs: 30000 });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, 1);
  assert.equal(failure.processTreeStopped, true);
  assert.ok(failure.stdout.includes("DEVPOCKET_BACKEND_DIAGNOSTIC "));
  assert.ok(!failure.stdout.includes("PRIVATE_NPM_CONFIG_CANARY"));
  assert.equal(await readFile(report, "utf8"), '{"fixture":"safe-machine-report"}');
});

test("NODE_OPTIONS uses Node's literal apostrophes, not shell-style grouping", async (t) => {
  const { backendDiagnosticEnvironment } = await import("../backend-diagnostics.mjs");
  const item = await fixture(t), directory = path.join(item.root, ".data", "ci", "backend");
  await mkdir(directory, { recursive: true });
  const report = path.join(directory, "report.json");
  await writeFile(item.file, [
    'import {test} from "node:test";import assert from "node:assert/strict";',
    'test("synthetic failure",()=>assert.fail("PRIVATE_BACKEND_CANARY".repeat(256)));',
  ].join("\n"));
  const caller = { ...process.env };
  delete caller.NODE_TEST_CONTEXT;
  const hidden = `--title='x --test_reporter=spec --test_reporter_destination=${report} --title=y'`;
  await assert.rejects(exec(process.execPath, ["--import", "tsx", "--test", item.file],
    { cwd: item.root, env: { ...caller, NODE_OPTIONS: hidden }, timeout: 15000 }), (error) => error.code === 1);
  assert.ok((await readFile(report, "utf8")).includes("PRIVATE_BACKEND_CANARY"),
    "The actual Node runner must demonstrate that it recognizes the hidden raw reporter.");
  await writeFile(report, '{"fixture":"original-machine-report"}');
  assert.throws(() => backendDiagnosticEnvironment(process.cwd(), runId, { ...caller, NODE_OPTIONS: hidden }), /conflicting/);
  assert.equal(await readFile(report, "utf8"), '{"fixture":"original-machine-report"}');
  await assert.rejects(readFile(path.join(directory, "backend-diagnostics.json")), { code: "ENOENT" });
  const literal = "--title=O'Reilly";
  await exec(process.execPath, ["-e", "process.exit(0)"], { env: { ...caller, NODE_OPTIONS: literal }, timeout: 10000 });
  assert.ok(backendDiagnosticEnvironment(process.cwd(), runId, { ...caller, NODE_OPTIONS: literal }).NODE_OPTIONS.startsWith(literal));
});

test("colliding runtime names do not substitute for mapped, catalogue-validated declaration coordinates", async (t) => {
  const { backendTestCatalogue, createBackendObservation } = await import("../backend-diagnostics.mjs");
  const item = await fixture(t);
  await writeFile(item.file, [
    'import {test} from "node:test";',
    'test("known",()=>{});',
    'test(process.env.CASE_NAME,()=>{});',
  ].join("\n"));
  const observation = createBackendObservation(await backendTestCatalogue(item.root), runId);
  observation.add({ type: "test:fail", data: {
    file: item.file, name: "known", nesting: 0, testNumber: 2,
    details: { error: { code: "ERR_TEST_FAILURE", failureType: "testCodeFailure", cause: { code: "ERR_ASSERTION" } } },
  } });
  assert.equal(observation.snapshot().findings[0].declaration, "unknown");
  assert.equal(observation.snapshot().findings[0].file, "backend/tests/fixture.test.ts");
  observation.add({ type: "test:fail", data: {
    file: item.file, name: "known", line: 3, column: 1, nesting: 0, testNumber: 2,
    details: { error: { code: "ERR_TEST_FAILURE", failureType: "testCodeFailure", cause: { code: "ERR_ASSERTION" } } },
  } });
  assert.deepEqual(observation.snapshot().findings[1].declaration, { file: "backend/tests/fixture.test.ts", line: 3, column: 1 });
});

test("missing input, linked directories and linked catalogues cannot export false success or outside data", async (t) => {
  const { backendTestCatalogue } = await import("../backend-diagnostics.mjs");
  const item = await fixture(t), directory = path.join(item.root, ".data", "ci", "backend");
  const file = path.resolve("scripts/backend-diagnostics.mjs");
  await exec(process.execPath, [file, "--directory", directory], { cwd: item.root, timeout: 20000 });
  const missing = JSON.parse(await readFile(path.join(directory, "backend-diagnostics.json"), "utf8"));
  assert.equal(missing.availability, "missing");
  assert.equal(missing.acceptance, false);
  assert.equal(missing.verificationStatus, "unknown");
  const alias = path.join(item.root, ".data", "ci", "alias");
  await symlink(directory, alias, "junction");
  await assert.rejects(exec(process.execPath, [file, "--directory", alias], { cwd: item.root, timeout: 20000 }));
  await assert.rejects(exec(process.execPath, [file, "--directory", path.join(item.root, "outside")],
    { cwd: item.root, timeout: 20000 }));
  const real = path.join(item.root, "preserved.test.ts");
  await writeFile(real, 'import {test} from "node:test";test("private",()=>{});');
  await rm(item.file);
  await symlink(real, item.file);
  await assert.rejects(backendTestCatalogue(item.root), /Unsupported.*input/);
  assert.equal(await readFile(real, "utf8"), 'import {test} from "node:test";test("private",()=>{});');
});

test("an unvalidated diagnostic destination makes export fail without printing or replacing its contents", async (t) => {
  const item = await fixture(t), directory = path.join(item.root, ".data", "ci", "backend");
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, "backend-diagnostics.json");
  await writeFile(destination, "synthetic-private-raw-assertion");
  const file = path.resolve("scripts/backend-diagnostics.mjs");
  await assert.rejects(exec(process.execPath, [file, "--directory", directory], { cwd: item.root, timeout: 20000 }),
    (error) => error.code === 1 && !error.stdout.includes("synthetic-private") && !error.stderr.includes("synthetic-private"));
  assert.equal(await readFile(destination, "utf8"), "synthetic-private-raw-assertion");
});

test("backend-only CI reuses the normal job, conditionally exports validated diagnostics and cannot satisfy Required verification", async () => {
  const workflow = (await readFile(".github/workflows/ci.yml", "utf8")).replaceAll("\r\n", "\n");
  const backend = workflow.split("\n  backend:")[1].split("\n  android:")[0];
  const android = workflow.split("\n  android:")[1].split("\n  device:")[0];
  const device = workflow.split("\n  device:")[1].split("\n  gate:")[0];
  const gate = workflow.split("\n  gate:")[1];
  assert.match(workflow, /backend_diagnostic:\n\s+description:.*\n\s+type: boolean\n\s+default: false/);
  assert.match(backend, /node scripts\\verify\.mjs --base \$env:BASE_SHA --group backend --backend-diagnostics --report/);
  assert.match(backend, /Export bounded backend test diagnostics\n\s+id: backend_diagnostics\n\s+if: always\(\)/);
  assert.match(backend, /node scripts\\backend-diagnostics\.mjs --directory \.data\\ci\\backend --github\n\s+exit \$LASTEXITCODE/);
  assert.deepEqual([...backend.matchAll(/^\s+(\.data\\[^\r\n]+)$/gm)].map((match) => match[1]),
    [".data\\ci\\backend\\report.json", ".data\\ci\\backend\\ci-report.json", ".data\\ci\\backend\\backend-diagnostics.json"]);
  assert.match(backend, /if: always\(\) && steps\.backend_diagnostics\.outputs\.report_ready == 'true'\n\s+with:\n\s+name: backend-test-diagnostics-attempt-\$\{\{ github\.run_attempt \}\}/);
  const originalUpload = backend.split("name: verification-backend")[1].split("- uses:")[0];
  assert.doesNotMatch(originalUpload, /backend-diagnostics\.json/);
  assert.ok(android.includes("!(github.event_name == 'workflow_dispatch' && inputs.backend_diagnostic)"));
  assert.ok(device.includes("!(github.event_name == 'workflow_dispatch' && inputs.backend_diagnostic)"));
  assert.match(gate, /BACKEND_ONLY:.*inputs\.backend_diagnostic/);
  assert.match(gate, /if \(\$env:BACKEND_ONLY -eq 'true'\) \{\n\s+node scripts\\verify\.mjs .*--plan --report \.data\\ci\\gate\.json\n\s+throw 'A backend diagnostic cannot satisfy Required verification/);
  assert.doesNotMatch(workflow, /continue-on-error:|--test-concurrency|--test-name-pattern|\.data[\\/]\*\*/);
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(manifest.scripts.test, "npm test --workspace @devpocket/components && node --import tsx --test backend/tests/*.test.ts");
  const components = JSON.parse(await readFile("packages/components/package.json", "utf8"));
  assert.equal(components.scripts.test, "npm run build && node --import tsx --test tests/*.test.ts");
  assert.ok(TOOLING_TEST_FILES.includes("scripts/tests/backend-diagnostics.test.mjs"));
});

test("an actual reporter catalogue exception remains failed after the test command restores catalogue health", async (t) => {
  const item = await fixture(t);
  await mkdir(path.join(item.root, "scripts"));
  for (const file of ["backend-diagnostics.mjs", "bounded-worker-log.mjs"]) {
    await writeFile(path.join(item.root, "scripts", file), await readFile(path.join("scripts", file)));
  }
  await writeFile(path.join(item.root, ".gitignore"), ".data/\nbackend/tests/ignored.test.ts\n");
  await writeFile(path.join(item.root, "package.json"), JSON.stringify({ type: "module", scripts: {
    "test:tooling": 'node -e "process.exit(0)"', typecheck: 'node -e "process.exit(0)"',
    test: 'node --import tsx --test backend/tests/*.test.ts && node -e "require(\'node:fs\').unlinkSync(\'backend/tests/ignored.test.ts\')"',
    build: 'node -e "process.exit(0)"', schema: 'node -e "process.exit(0)"',
  } }));
  await exec("git", ["init", "--quiet"], { cwd: item.root });
  await exec("git", ["add", "."], { cwd: item.root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture"], { cwd: item.root });
  await writeFile(item.file, (await readFile(item.file, "utf8")) + "\n// changed\n");
  const target = path.join(item.root, ".data", "empty.test.ts");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "export {};\n");
  await symlink(target, path.join(item.root, "backend", "tests", "ignored.test.ts"));
  const directory = path.join(item.root, ".data", "ci", "backend"), caller = { ...process.env };
  delete caller.NODE_TEST_CONTEXT;
  await assert.rejects(exec(process.execPath, [path.resolve("scripts/verify.mjs"), "--repo", item.root,
    "--base", "HEAD", "--group", "backend", "--backend-diagnostics", "--report", path.join(directory, "report.json")],
  { cwd: item.root, env: caller, timeout: 45000 }), (error) => error.code === 1);
  const report = JSON.parse(await readFile(path.join(directory, "report.json"), "utf8"));
  const check = report.checks.find((entry) => entry.id === "backend-tests");
  assert.equal(check.collectionStatus, "failed");
  assert.equal(check.reportedBackendTestStatus, "passed");
  assert.equal(check.commandOutcome.exitCode, 0);
  await assert.rejects(exec(process.execPath, [path.resolve("scripts/backend-diagnostics.mjs"), "--directory", directory],
    { cwd: item.root, env: caller, timeout: 20000 }), (error) => error.code === 1);
  const output = JSON.parse(await readFile(path.join(directory, "backend-diagnostics.json"), "utf8"));
  assert.equal(output.collectionStatus, "failed");
  assert.equal(output.collectionError, "catalogue-unavailable");
});
