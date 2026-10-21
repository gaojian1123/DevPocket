import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, rename, realpath, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify, stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { test } from "node:test";
import * as tar from "tar";
import { packageRelease } from "../package.mjs";
import { runCommand } from "../../../scripts/process.mjs";

const exec = promisify(execFile);

function releaseFixtureFailure(stage, error) {
  assert.ok(["install", "build", "prune"].includes(stage));
  const output = stripVTControlCharacters(`${error.stdout ?? ""}\n${error.stderr ?? ""}`);
  const npmCode = /\bnpm (?:error|ERR!) code ([A-Z0-9_]+)/i.exec(output)?.[1]?.toUpperCase();
  const known = ["ENOTCACHED", "ENOENT", "EACCES", "EPERM", "EUSAGE", "ETARGET", "ERESOLVE",
    "EINTEGRITY", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "E401", "E403", "E404"];
  const code = known.includes(npmCode) ? npmCode : /Missing script:/i.test(output) ? "MISSING_SCRIPT"
    : /ERR_MODULE_NOT_FOUND|Cannot find module/.test(output) ? "MODULE_NOT_FOUND"
      : /error TS\d{4}/.test(output) ? "TYPESCRIPT_ERROR" : "UNKNOWN";
  return new Error(`DEVPOCKET_RELEASE_FIXTURE_FAILURE ${stage} ${code}`, { cause: error });
}

function contractResolutionFailure(actual, expected, cause) {
  let code = "OTHER_OUTPUT";
  if (actual !== expected && actual.toLowerCase() === expected.toLowerCase()) code = "CASE_ONLY";
  else if (!/[\r\n]/.test(actual)) {
    let url;
    try { url = new URL(actual); }
    catch (error) { if (!(error instanceof TypeError)) throw error; }
    if (url?.protocol === "file:") {
      code = /\/node_modules\/(?:@|%40)devpocket\/components\/dist\/spec\.js$/i.test(url.pathname) ? "INSTALLED_PATH"
        : /\/packages\/components\/dist\/spec\.js$/i.test(url.pathname) ? "WORKSPACE_PATH" : "OTHER_FILE_URL";
    }
  }
  return new Error(`DEVPOCKET_RELEASE_FIXTURE_FAILURE resolve ${code}`, { cause });
}

test("runtime resolution diagnostics never disclose URLs, paths or child output", () => {
  const expected = "file:///C:/fixture/packages/components/dist/spec.js";
  const cause = new assert.AssertionError({ actual: "PRIVATE_CANARY", expected, operator: "strictEqual" });
  for (const [actual, code] of [[expected.toLowerCase(), "CASE_ONLY"], [expected, "WORKSPACE_PATH"],
    ["file:///C:/PRIVATE_CANARY/node_modules/@devpocket/components/dist/spec.js", "INSTALLED_PATH"],
    ["file:///C:/PRIVATE_CANARY/node_modules/%40devpocket/components/dist/spec.js", "INSTALLED_PATH"],
    ["file:///C:/PRIVATE_CANARY/packages/components/dist/spec.js", "WORKSPACE_PATH"],
    ["file:///C:/PRIVATE_CANARY/unknown.js", "OTHER_FILE_URL"], ["PRIVATE_CANARY", "OTHER_OUTPUT"],
    ["https://example.test/PRIVATE_CANARY", "OTHER_OUTPUT"], [expected + "\nPRIVATE_CANARY", "OTHER_OUTPUT"]]) {
    const failure = contractResolutionFailure(actual, expected, cause);
    assert.equal(failure.message, `DEVPOCKET_RELEASE_FIXTURE_FAILURE resolve ${code}`);
    assert.equal(failure.cause, cause);
    assert.ok(!failure.message.includes("PRIVATE_CANARY"));
  }
});

test("release fixture diagnostics expose only fixed stages and allowlisted failure codes", () => {
  for (const [output, code] of [["npm error code ENOTCACHED", "ENOTCACHED"],
    ["npm \u001b[31merror\u001b[0m code ERESOLVE", "ERESOLVE"],
    ['npm error Missing script: "build"', "MISSING_SCRIPT"], ["error TS2307: private-path", "TYPESCRIPT_ERROR"],
    ["npm error code EPRIVATE_CANARY\npassword=PRIVATE_CANARY", "UNKNOWN"]]) {
    const original = Object.assign(new Error("PRIVATE_CANARY"), { stderr: output });
    const failure = releaseFixtureFailure("build", original);
    assert.equal(failure.message, `DEVPOCKET_RELEASE_FIXTURE_FAILURE build ${code}`);
    assert.equal(failure.cause, original);
    assert.ok(!failure.message.includes("PRIVATE_CANARY"));
  }
});

test("private release packaging is an allowlist snapshot, never the whole workspace", async (t) => {
  const parent = path.resolve("..", "..", ".data", "azure-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["package.json", "package-lock.json", ".dockerignore", "backend/tsconfig.json",
    "backend/src/relay.ts", "extension/extension.mjs", "scripts/bundle-extension.mjs",
    "deployment/Dockerfile", "deployment/Caddyfile", "deployment/azure/compose.yaml", "deployment/azure/vm/control.sh",
    "deployment/onboarding/setup.mjs", "deployment/onboarding/setup-azure.mjs", "deployment/onboarding/setup-actions.mjs",
    "deployment/onboarding/setup-state.mjs", "deployment/onboarding/handoff.mjs", "deployment/onboarding/cloud-host.mjs",
    "deployment/onboarding/guest.py", "deployment/onboarding/private-directory.ps1",
    "packages/components/package.json", "packages/components/tsconfig.json", "packages/components/build.mjs",
    "packages/components/README.md", "packages/components/src/spec.ts", "packages/components/web/index.html"]) {
    const file = path.join(root, ...name.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, name.endsWith(".json") ? "{}" : "test");
  }
  await mkdir(path.join(root, ".data"), { recursive: true });
  await mkdir(path.join(root, ".azure"), { recursive: true });
  await writeFile(path.join(root, ".data", "host.local.json"), "SENSITIVE_MUST_NOT_LEAVE");
  await writeFile(path.join(root, ".azure", "env"), "SENSITIVE_MUST_NOT_LEAVE");
  await writeFile(path.join(root, "backend", "src", "credential.local.json"), "SENSITIVE_MUST_NOT_LEAVE");
  await mkdir(path.join(root, "packages", "components", "dist"), { recursive: true });
  await writeFile(path.join(root, "packages", "components", "dist", "stale.js"), "GENERATED_MUST_NOT_LEAVE");
  const result = await packageRelease(root, path.join(root, "out"));
  const entries = [];
  await tar.t({ file: result.file, onReadEntry: (entry) => entries.push(entry.path) });
  assert.ok(entries.includes("backend/src/relay.ts"));
  assert.ok(entries.includes("release-manifest.json"));
  assert.ok(entries.includes("packages/components/package.json"));
  assert.ok(entries.includes("packages/components/src/spec.ts"));
  assert.ok(entries.includes("packages/components/web/index.html"));
  assert.ok(!entries.some((name) => name.startsWith("packages/components/dist/")));
  assert.ok(entries.every((name) => !name.includes(".local.") && !name.startsWith(".data") && !name.startsWith(".azure")));
  assert.equal((await packageRelease(root, path.join(root, "out"))).sha256, result.sha256);
  const bound = await packageRelease(root, path.join(root, "out"), {
    deploymentId: "fixture", host: "one.example.test", tlsEmail: "operator@example.com", autostart: false,
    token: "MUST_NOT_ENTER_PACKAGE",
  });
  const changed = await packageRelease(root, path.join(root, "out"), {
    deploymentId: "fixture", host: "two.example.test", tlsEmail: "operator@example.com", autostart: false,
  });
  assert.notEqual(bound.sha256, changed.sha256);
  let binding = "";
  await tar.t({ file: bound.file, onReadEntry: (entry) => {
    if (entry.path === "deployment-target.json") entry.on("data", (chunk) => { binding += chunk.toString(); });
  } });
  assert.ok(!binding.includes("MUST_NOT_ENTER_PACKAGE"));
  await symlink(path.join(root, ".data"), path.join(root, "backend", "src", "unsafe"), "junction");
  await assert.rejects(packageRelease(root, path.join(root, "out")), /link/i);
});

test("a clean release snapshot builds and its pruned runtime resolves the portable contract without build sources",
  { timeout: 120000 }, async (t) => {
    const repository = path.resolve("..", "..");
    const directory = await mkdtemp(path.join(tmpdir(), "devpocket-release-"));
    let safeToClean = true;
    t.after(async () => {
      assert.ok(safeToClean, "Retain the scoped release fixture when process cleanup is unconfirmed.");
      await rm(directory, { recursive: true, force: true });
    });
    const physical = path.join(directory, "runtime"), snapshot = path.join(directory, "runtime-alias");
    await mkdir(physical);
    await symlink(physical, snapshot, "junction");
    const archive = await packageRelease(repository, path.join(directory, "archive"));
    await tar.x({ cwd: snapshot, file: archive.file });
    await assert.rejects(readFile(path.join(snapshot, "packages", "components", "dist", "spec.js")), { code: "ENOENT" });
    const run = async (stage, command) => {
      safeToClean = false;
      try {
        const result = await runCommand("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
          `$ErrorActionPreference='Stop'; $env:npm_config_cache='${path.join(directory, "npm-cache").replaceAll("'", "''")}'; ${command}; exit $LASTEXITCODE`],
        { cwd: snapshot, timeoutMs: 90000, signal: t.signal });
        safeToClean = result.processTreeStopped === true;
        assert.ok(safeToClean, "Build process cleanup must be confirmed.");
      } catch (error) {
        safeToClean = error.processTreeStopped === true;
        throw releaseFixtureFailure(stage, error);
      }
    };
    await assert.rejects(run("install", "npm ci --offline --ignore-scripts --no-audit --no-fund"),
      { message: "DEVPOCKET_RELEASE_FIXTURE_FAILURE install ENOTCACHED" });
    assert.ok(safeToClean, "Cold-cache failure cleanup must be confirmed before dependency preparation.");
    await run("install", "npm ci --ignore-scripts --no-audit --no-fund");
    await run("install", "npm ci --offline --ignore-scripts --no-audit --no-fund");
    await run("build", "npm run build");
    await run("prune", "npm prune --omit=dev --ignore-scripts --offline --no-audit --no-fund");
    for (const name of ["backend", "scripts", "extension", "deployment", "packages/components/src",
      "packages/components/web", "packages/components/build.mjs", "packages/components/tsconfig.json",
      "packages/components/README.md"]) {
      await rm(path.join(snapshot, ...name.split("/")), { recursive: true });
    }
    const probe = "import {stat} from 'node:fs/promises'; import {fileURLToPath} from 'node:url';" +
      "const url=import.meta.resolve('@devpocket/components');" +
      "const [actual,expected]=await Promise.all([stat(fileURLToPath(url),{bigint:true}),stat(process.argv[1],{bigint:true})]);" +
      "const sameFile=actual.isFile()&&expected.isFile()&&actual.ino!==0n&&expected.ino!==0n&&actual.dev===expected.dev&&actual.ino===expected.ino;" +
      "if(sameFile){const c=await import('@devpocket/components');if(c.parseComponentSpec({type:'markdown',content:'offline'}).type!=='markdown')process.exit(1);}" +
      "console.log(JSON.stringify({url,sameFile}));";
    const resolveContract = async (expectedFile) => {
      const imported = await exec(process.execPath, ["--input-type=module", "-e", probe, expectedFile],
        { cwd: snapshot, timeout: 15000 });
      const result = JSON.parse(imported.stdout);
      assert.deepEqual(Object.keys(result).sort(), ["sameFile", "url"]);
      assert.equal(typeof result.url, "string");
      try { assert.equal(result.sameFile, true); }
      catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        throw contractResolutionFailure(result.url, pathToFileURL(await realpath(expectedFile)).href, error);
      }
    };
    const contract = path.join(physical, "packages", "components", "dist", "spec.js");
    await resolveContract(contract);
    const decoy = path.join(directory, "different-file-same-bytes.js");
    await copyFile(contract, decoy);
    await assert.rejects(resolveContract(decoy), (error) => error.cause instanceof assert.AssertionError &&
      error.cause.actual === false && error.cause.expected === true);
    assert.match((await exec(process.execPath, ["dist/cli.js", "--help"], { cwd: snapshot, timeout: 15000 })).stdout, /DevPocket/);
    await rename(contract, contract + ".not-runtime");
    await assert.rejects(exec(process.execPath, ["dist/cli.js", "--help"], { cwd: snapshot, timeout: 15000 }),
      (error) => error.code === 1 && /ERR_MODULE_NOT_FOUND/.test(error.stderr));
    await rename(contract + ".not-runtime", contract);
    const docker = await readFile(path.join(repository, "deployment", "Dockerfile"), "utf8");
    assert.ok(docker.indexOf("COPY packages/components/package.json") < docker.indexOf("RUN npm ci"));
    assert.match(docker, /COPY packages\/components\/src packages\/components\/src/);
    assert.match(docker, /COPY packages\/components\/web packages\/components\/web/);
    assert.match(docker, /COPY --from=build --chown=node:node \/app\/packages\/components\/package\.json \.\/packages\/components\/package\.json/);
    assert.match(docker, /COPY --from=build --chown=node:node \/app\/packages\/components\/dist \.\/packages\/components\/dist/);
  });
