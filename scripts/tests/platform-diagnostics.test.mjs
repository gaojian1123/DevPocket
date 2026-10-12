import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { LINUX_PLATFORM_TESTS } from "../backend-diagnostics.mjs";
import { runPlatformChecks } from "../platform-diagnostics.mjs";

const exec = promisify(execFile);

test("the fixed platform suite keeps a real failing Node exit while withholding raw assertions and stdout", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/platform-diagnostic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts", "tests"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await writeFile(path.join(root, ".gitignore"), ".data/\n");
  for (const file of ["backend-diagnostics.mjs", "bounded-worker-log.mjs"]) {
    await writeFile(path.join(root, "scripts", file), await readFile(path.join("scripts", file)));
  }
  for (const [index, file] of LINUX_PLATFORM_TESTS.entries()) {
    await writeFile(path.join(root, file), [
      'import {test} from "node:test";import assert from "node:assert/strict";',
      `test("synthetic platform ${index}",()=>{${index === 1 ? 'console.log("PRIVATE_PLATFORM_STDOUT");assert.fail("PRIVATE_PLATFORM_ASSERTION");' : ""}});`,
    ].join("\n"));
  }
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture"], { cwd: root });
  const environment = { ...process.env, GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
  delete environment.NODE_TEST_CONTEXT;
  const report = await runPlatformChecks({ root, platform: "linux", environment });
  assert.equal(report.status, "failed");
  assert.equal(report.failure.exitCode, 1);
  assert.equal(report.tests.availability, "complete");
  assert.equal(report.tests.findings[0].declaration.file, "scripts/tests/linux-process.test.mjs");
  assert.equal(report.tests.findings[0].category, "assertion");
  assert.equal(report.acceptance, false);
  assert.ok(!JSON.stringify(report).includes("PRIVATE_PLATFORM"));
  assert.equal(report.privateLog.status, "retained");
});
