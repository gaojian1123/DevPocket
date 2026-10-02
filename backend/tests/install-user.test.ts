import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { installUserExtension, userExtensionDirectory } from "../src/install-user.js";
import { VERSION } from "../src/protocol.js";

async function fixture(t: TestContext) {
  const parent = path.resolve(".data", "tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "install-user-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "bundle"), home = path.join(root, "copilot-home");
  const configPath = path.join(root, "private", "host.local.json");
  const config = {
    hostId: "00000000-0000-4000-8000-000000000001", token: `dph_${"a".repeat(43)}`,
    relayUrl: "https://relay.example.test", dataDir: path.join(root, "private", "bridge"),
  };
  await mkdir(source);
  await mkdir(path.dirname(configPath));
  await writeFile(path.join(source, "extension.mjs"), 'throw new Error("The installer must never run the extension");\n');
  await writeFile(path.join(source, "bridge.mjs"), "export const fixture = true;\n");
  await writeFile(configPath, JSON.stringify(config));
  return { root, source, home, configPath, config, target: userExtensionDirectory(home) };
}

test("user installation copies a self-contained extension without launching it or copying host credentials", async (t) => {
  const f = await fixture(t);
  const settings = path.join(f.home, "config.json");
  await mkdir(path.join(f.home, "extensions", "unrelated"), { recursive: true });
  await writeFile(settings, '{"permissions":"unchanged"}');
  await writeFile(path.join(f.home, "extensions", "unrelated", "extension.mjs"), "unrelated");
  const result = await installUserExtension(f.source, f.configPath, f.home);
  assert.deepEqual(result, { target: f.target, updated: false });
  assert.deepEqual((await readdir(f.target)).sort(),
    [".gitignore", "bridge.mjs", "connection.local.json", "extension.mjs", "installation.json"]);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.target, "connection.local.json"), "utf8")),
    { hostConfigPath: f.configPath });
  for (const name of await readdir(f.target)) {
    const text = await readFile(path.join(f.target, name), "utf8");
    assert.ok(!text.includes(f.config.token));
  }
  assert.equal(await readFile(settings, "utf8"), '{"permissions":"unchanged"}');
  assert.equal(await readFile(path.join(f.home, "extensions", "unrelated", "extension.mjs"), "utf8"), "unrelated");
  assert.deepEqual((await readdir(path.dirname(f.target))).sort(), ["devpocket", "unrelated"]);
  await rm(f.source, { recursive: true });
  assert.match(await readFile(path.join(f.target, "bridge.mjs"), "utf8"), /fixture = true/);
});

test("reinstall upgrades only a managed user extension and keeps private data outside it", async (t) => {
  const f = await fixture(t);
  await installUserExtension(f.source, f.configPath, f.home);
  await mkdir(f.config.dataDir);
  await writeFile(path.join(f.config.dataDir, "retained.txt"), "runtime journal");
  await writeFile(path.join(f.source, "bridge.mjs"), "export const updated = true;\n");
  const result = await installUserExtension(f.source, f.configPath, f.home);
  assert.equal(result.updated, true);
  assert.match(await readFile(path.join(f.target, "bridge.mjs"), "utf8"), /updated = true/);
  assert.equal(JSON.parse(await readFile(path.join(f.target, "installation.json"), "utf8")).version, VERSION);
  assert.equal(await readFile(f.configPath, "utf8"), JSON.stringify(f.config));
  assert.equal(await readFile(path.join(f.config.dataDir, "retained.txt"), "utf8"), "runtime journal");
  assert.deepEqual(await readdir(path.dirname(f.target)), ["devpocket"]);
});

test("unmanaged or supplemented installations are not overwritten", async (t) => {
  const f = await fixture(t);
  await mkdir(f.target, { recursive: true });
  await writeFile(path.join(f.target, "extension.mjs"), "user extension");
  await assert.rejects(installUserExtension(f.source, f.configPath, f.home), /unmanaged/);
  assert.equal(await readFile(path.join(f.target, "extension.mjs"), "utf8"), "user extension");
  await rm(f.target, { recursive: true });
  await installUserExtension(f.source, f.configPath, f.home);
  await writeFile(path.join(f.target, "keep.txt"), "user data");
  await assert.rejects(installUserExtension(f.source, f.configPath, f.home), /additional files/);
  assert.equal(await readFile(path.join(f.target, "keep.txt"), "utf8"), "user data");
});

test("missing bundle input cannot damage an installed extension", async (t) => {
  const f = await fixture(t);
  await installUserExtension(f.source, f.configPath, f.home);
  const previous = await readFile(path.join(f.target, "bridge.mjs"));
  await rm(path.join(f.source, "bridge.mjs"));
  await assert.rejects(installUserExtension(f.source, f.configPath, f.home), /ENOENT/);
  assert.deepEqual(await readFile(path.join(f.target, "bridge.mjs")), previous);
  assert.deepEqual(await readdir(path.dirname(f.target)), ["devpocket"]);
});

test("a failed installation swap restores the old version or preserves an explicit recovery copy", async (t) => {
  for (const recover of [true, false]) await t.test(recover ? "rollback succeeds" : "rollback also fails", async (t) => {
    const f = await fixture(t);
    await installUserExtension(f.source, f.configPath, f.home);
    const previous = await readFile(path.join(f.target, "bridge.mjs"));
    await writeFile(path.join(f.source, "bridge.mjs"), "export const newer = true;\n");
    const originalRename = fs.rename;
    t.mock.method(fs, "rename", async (from, to) => {
      if (String(from).endsWith(`${path.sep}prepared`) || (!recover && String(from).endsWith(`${path.sep}previous`)))
        throw Object.assign(new Error("Simulated rename failure"), { code: "EACCES" });
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(installUserExtension(f.source, f.configPath, f.home),
        recover ? /Simulated rename failure/ : /previous files remain/);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    const remaining = await readdir(path.dirname(f.target));
    if (recover) {
      assert.deepEqual(remaining, ["devpocket"]);
      assert.deepEqual(await readFile(path.join(f.target, "bridge.mjs")), previous);
    } else {
      assert.equal(remaining.length, 1);
      assert.match(remaining[0]!, /^\.devpocket-install-/);
      const recovery = path.join(path.dirname(f.target), remaining[0]!);
      assert.deepEqual(await readFile(path.join(recovery, "previous", "bridge.mjs")), previous);
      await assert.rejects(readFile(path.join(recovery, "extension.mjs")), { code: "ENOENT" });
    }
  });
});

test("user installation rejects relative bridge data and credentials stored inside the upgrade target", async (t) => {
  const f = await fixture(t);
  await assert.rejects(installUserExtension(f.source, f.configPath, "relative-copilot-home"), /COPILOT_HOME must be an absolute/);
  await writeFile(f.configPath, JSON.stringify({ ...f.config, dataDir: "relative-private-data" }));
  await assert.rejects(installUserExtension(f.source, f.configPath, f.home), /absolute dataDir/);
  await writeFile(f.configPath, JSON.stringify({ ...f.config, dataDir: path.join(f.target, "data") }));
  await assert.rejects(installUserExtension(f.source, f.configPath, f.home), /outside the extension/);
  await mkdir(f.target, { recursive: true });
  const internal = path.join(f.target, "host.local.json");
  await writeFile(internal, JSON.stringify(f.config));
  await assert.rejects(installUserExtension(f.source, internal, f.home), /outside the extension/);
  assert.deepEqual(await readdir(f.target), ["host.local.json"]);
});

test("linked installation targets and concurrent installers fail without changing their contents", async (t) => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.target), { recursive: true });
  const destination = path.join(f.root, "unrelated");
  await mkdir(destination);
  await writeFile(path.join(destination, "keep.txt"), "unchanged");
  await symlink(destination, f.target, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(installUserExtension(f.source, f.configPath, f.home), /regular DevPocket/);
  assert.equal(await readFile(path.join(destination, "keep.txt"), "utf8"), "unchanged");
  await rm(f.target);
  const lock = path.join(path.dirname(f.target), ".devpocket-install.lock");
  await writeFile(lock, "another installer");
  await assert.rejects(installUserExtension(f.source, f.configPath, f.home), /Another or interrupted/);
  assert.equal(await readFile(lock, "utf8"), "another installer");
});
