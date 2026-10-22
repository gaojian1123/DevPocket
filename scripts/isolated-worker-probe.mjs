import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [mode, argument] = process.argv.slice(2);
const input = JSON.parse(argument);

if (mode === "fixture") {
  const root = input.fixture;
  mkdirSync(path.join(root, "scripts", "tests"), { recursive: true });
  mkdirSync(path.join(root, ".data"), { recursive: true });
  writeFileSync(path.join(root, ".gitignore"), ".data/\nnode_modules/\n");
  const manifest = { name: "devpocket-isolation-proof", version: "1.0.0", private: true, type: "module",
    scripts: { postinstall: `node ${JSON.stringify(input.probe)} attack ${JSON.stringify(JSON.stringify(input))}`,
      "test:workflow": "node scripts/test-workflow.mjs" } };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: manifest.name, version: manifest.version,
    lockfileVersion: 3, requires: true, packages: { "": { name: manifest.name, version: manifest.version, hasInstallScript: true } } }));
  writeFileSync(path.join(root, "scripts", "test-workflow.mjs"), "export const WORKFLOW_TEST_FILES=[];export const WORKFLOW_TEST_SHARDS=[];\n");
  for (const [index, file] of input.files.entries()) {
    writeFileSync(path.join(root, file), "import {test} from 'node:test';import assert from 'node:assert/strict';\n" +
      `test('isolated-proof-${index}',()=>${index === 0 ? "assert.fail('DEVPOCKET_REQUIRED_FAILURE')" : "assert.ok(true)"});\n`);
  }
} else if (mode === "attack") {
  const outcomes = [];
  const denied = (name, operation, codes = ["EACCES", "EPERM", "EBUSY", "ENOTEMPTY"]) => {
    try { operation(); outcomes.push({ name, denied: false }); }
    catch (error) {
      if (!codes.includes(error.code)) throw error;
      outcomes.push({ name, denied: true });
    }
  };
  for (const [index, directory] of input.protectedPaths.entries()) {
    const codes = input.permissionOnlyPaths?.includes(directory) ? ["EACCES", "EPERM"] : undefined;
    denied(`write-${index}`, () => writeFileSync(path.join(directory, input.marker), "candidate overwrite", { flag: "wx" }), codes);
    denied(`rename-${index}`, () => renameSync(directory, directory + "-candidate-replaced"), codes);
    denied(`chmod-${index}`, () => chmodSync(directory, 0o777), codes);
    denied(`redirect-${index}`, () => symlinkSync(input.fixture, path.join(directory, input.marker + "-link"),
      process.platform === "win32" ? "junction" : "dir"), codes);
  }
  for (const [index, file] of (input.protectedReadFiles ?? []).entries())
    denied(`runner-file-read-${index}`, () => readFileSync(file), ["EACCES", "EPERM"]);
  denied("supervisor-termination", () => process.kill(input.supervisorPid));
  denied("runner-substitution", () => writeFileSync(input.runner,
    "export const WORKFLOW_TEST_FILES=[];export const WORKFLOW_TEST_SHARDS=[];\n"));
  denied("evidence-read", () => readFileSync(input.evidence), ["EACCES", "EPERM"]);
  denied("evidence-overwrite", () => writeFileSync(input.evidence, '{"status":"passed","complete":true}\n'));
  denied("evidence-delete", () => rmSync(input.evidence));
  assert.ok(Object.keys(process.env).every((name) => !/^(?:GH_TOKEN|GITHUB_TOKEN|ACTIONS_.*|GITHUB_(?:ENV|OUTPUT|PATH|EVENT_PATH|STEP_SUMMARY))$/.test(name)),
    "Candidate environment contains a runner channel or credential.");
  const counter = path.join(input.fixture, ".data", "descendant.json");
  const child = spawn(process.execPath, [input.probe, "descendant", JSON.stringify({ counter, runner: input.runner })],
    { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 10000;
  while (!existsSync(counter) && Date.now() < deadline) await delay(20);
  assert.ok(existsSync(counter), "The background descendant never started.");
  writeFileSync(path.join(input.fixture, ".data", "attacks.json"), JSON.stringify(outcomes));
  assert.ok(outcomes.every((item) => item.denied),
    `The candidate crossed protected boundaries: ${outcomes.filter((item) => !item.denied).map((item) => item.name).join(", ")}`);
} else if (mode === "descendant") {
  let attempts = 0;
  setInterval(() => {
    let denied = false;
    try { writeFileSync(input.runner, "process.exit(0);\n"); }
    catch (error) { if (["EACCES", "EPERM"].includes(error.code)) denied = true; else throw error; }
    writeFileSync(input.counter + ".next", JSON.stringify({ pid: process.pid, parentPid: process.ppid, attempts: ++attempts, denied }));
    renameSync(input.counter + ".next", input.counter);
  }, 20);
} else {
  throw new Error("Unknown isolation proof phase.");
}
