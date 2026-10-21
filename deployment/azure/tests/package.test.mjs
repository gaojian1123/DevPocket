import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { test } from "node:test";
import * as tar from "tar";
import { packageRelease } from "../package.mjs";
import { runCommand } from "../../../scripts/process.mjs";

const exec = promisify(execFile);

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
    const snapshot = path.join(directory, "runtime");
    await mkdir(snapshot);
    const archive = await packageRelease(repository, path.join(directory, "archive"));
    await tar.x({ cwd: snapshot, file: archive.file });
    await assert.rejects(readFile(path.join(snapshot, "packages", "components", "dist", "spec.js")), { code: "ENOENT" });
    const run = async (command) => {
      safeToClean = false;
      try {
        const result = await runCommand("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
          `$ErrorActionPreference='Stop'; ${command}; exit $LASTEXITCODE`],
        { cwd: snapshot, timeoutMs: 90000, signal: t.signal });
        safeToClean = result.processTreeStopped === true;
        assert.ok(safeToClean, "Build process cleanup must be confirmed.");
      } catch (error) {
        safeToClean = error.processTreeStopped === true;
        throw error;
      }
    };
    await run("npm ci --offline --ignore-scripts --no-audit --no-fund");
    await run("npm run build");
    await run("npm prune --omit=dev --ignore-scripts --offline --no-audit --no-fund");
    for (const name of ["backend", "scripts", "extension", "deployment", "packages/components/src",
      "packages/components/web", "packages/components/build.mjs", "packages/components/tsconfig.json",
      "packages/components/README.md"]) {
      await rm(path.join(snapshot, ...name.split("/")), { recursive: true });
    }
    const imported = await exec(process.execPath, ["--input-type=module", "-e",
      "const c=await import('@devpocket/components'); if(c.parseComponentSpec({type:'markdown',content:'offline'}).type!=='markdown')process.exit(1);" +
      "console.log(import.meta.resolve('@devpocket/components'));"],
    { cwd: snapshot, timeout: 15000 });
    assert.ok(imported.stdout.trim().startsWith(pathToFileURL(path.join(snapshot, "packages", "components")).href + "/"));
    assert.match((await exec(process.execPath, ["dist/cli.js", "--help"], { cwd: snapshot, timeout: 15000 })).stdout, /DevPocket/);
    const contract = path.join(snapshot, "packages", "components", "dist", "spec.js");
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
