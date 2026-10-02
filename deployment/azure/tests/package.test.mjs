import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import * as tar from "tar";
import { packageRelease } from "../package.mjs";

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
    "deployment/onboarding/guest.py", "deployment/onboarding/private-directory.ps1"]) {
    const file = path.join(root, ...name.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, name.endsWith(".json") ? "{}" : "test");
  }
  await mkdir(path.join(root, ".data"), { recursive: true });
  await mkdir(path.join(root, ".azure"), { recursive: true });
  await writeFile(path.join(root, ".data", "host.local.json"), "SENSITIVE_MUST_NOT_LEAVE");
  await writeFile(path.join(root, ".azure", "env"), "SENSITIVE_MUST_NOT_LEAVE");
  await writeFile(path.join(root, "backend", "src", "credential.local.json"), "SENSITIVE_MUST_NOT_LEAVE");
  const result = await packageRelease(root, path.join(root, "out"));
  const entries = [];
  await tar.t({ file: result.file, onReadEntry: (entry) => entries.push(entry.path) });
  assert.ok(entries.includes("backend/src/relay.ts"));
  assert.ok(entries.includes("release-manifest.json"));
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
