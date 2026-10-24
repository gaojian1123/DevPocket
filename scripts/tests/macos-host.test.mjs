import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { acquireHostVerificationSlot } from "../verification-admission.mjs";
import { resolveVerificationExecutable } from "../verification-preflight.mjs";

const exec = promisify(execFile);

async function fixture(t) {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/macos-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("POSIX Python lookup preserves the virtual environment used by the shell",
  { skip: process.platform === "win32" }, async (t) => {
    const root = await fixture(t), environment = path.join(root, "python-env");
    await exec("python", ["-m", "venv", "--without-pip", environment], { timeout: 30000 });
    const program = path.join(environment, "bin", "python");
    const packages = (await exec(program, ["-c", "import sysconfig;print(sysconfig.get_path('purelib'))"])).stdout.trim();
    await writeFile(path.join(packages, "devpocket_lookup_fixture.py"), "marker = 'venv-only'\n");
    const previous = process.env.PATH;
    process.env.PATH = `${path.dirname(program)}${path.delimiter}${previous ?? ""}`;
    try {
      const resolved = await resolveVerificationExecutable(root, "python", { shell: true });
      assert.equal(resolved, program);
      const result = await exec(resolved, ["-B", "-c", "import devpocket_lookup_fixture as f;print(f.marker)"]);
      assert.equal(result.stdout.trim(), "venv-only");
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });

test("macOS host admission retries Unix socket creation contention",
  { skip: process.platform !== "darwin" }, async (t) => {
    const root = await fixture(t), directory = path.join(root, "admission"), listen = net.Server.prototype.listen;
    let collided = false;
    t.mock.method(net.Server.prototype, "listen", function (options, ...args) {
      if (!collided && typeof options?.path === "string") {
        collided = true;
        queueMicrotask(() => this.emit("error", Object.assign(new Error("Concurrent socket creation."), { code: "EEXIST" })));
        return this;
      }
      return listen.call(this, options, ...args);
    });
    const first = await acquireHostVerificationSlot(root, { directory });
    await first.release(true);
    assert.equal(collided, true);
    const next = await acquireHostVerificationSlot(root, { directory });
    await next.release(true);
  });

test("the native shard retains macOS host regressions without launching an Android emulator", async () => {
  const { TOOLING_TEST_SHARDS } = await import("../test-tooling.mjs");
  const native = TOOLING_TEST_SHARDS.find((part) => part.id === "native");
  for (const name of ["macos-host", "process", "emulator-resources", "android-runner", "android-build"]) {
    assert.ok(native.files.includes(`scripts/tests/${name}.test.mjs`));
  }
  const workflow = (await readFile(".github/workflows/ci.yml", "utf8")).replaceAll("\r\n", "\n");
  const job = workflow.slice(workflow.indexOf("  macos:\n"), workflow.indexOf("  backend:\n"));
  assert.doesNotMatch(job, /sdkmanager|prepare-native|test-android\.ps1/);
});
