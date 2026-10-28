import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const built = spawnSync("npm", ["run", "build", "--workspace", "@devpocket/components"], {
  cwd: root, stdio: "inherit", shell: false,
});
if (built.error) throw built.error;
if (built.status !== 0) throw new Error(`Component build failed (${built.status ?? built.signal}).`);
const { parseComponentSpec, COMPONENT_VERSION } = await import("../packages/components/dist/spec.js");
const fixtures = JSON.parse(await readFile(new URL("Fixtures/components.json", import.meta.url), "utf8"));
const ids = new Set();
const records = fixtures.map(({ id, spec }) => {
  if (typeof id !== "string" || !/^fixture-[a-z-]+$/.test(id) || ids.has(id))
    throw new Error("Fixture component IDs must be unique local identifiers.");
  ids.add(id);
  const bytes = Buffer.from(JSON.stringify(parseComponentSpec(spec)), "utf8");
  return {
    componentId: id, toolCallId: `tool-${id}`, version: COMPONENT_VERSION,
    originatingMessageId: "fixture-request-visual",
    status: "ready", encoding: "base64-json", payload: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"), redacted: false,
  };
});
if (records.length !== 4) throw new Error("The offline milestone requires all four component fixtures.");
const target = new URL("DevPocket/Renderer/", import.meta.url);
await mkdir(target, { recursive: true });
for (const name of ["index.html", "component.js", "component.css", "component.js.LEGAL.txt", "THIRD-PARTY-NOTICES.txt"])
  await copyFile(path.join(root, "packages/components/dist/web", name), new URL(name, target));
await writeFile(new URL("component-fixtures.json", target), JSON.stringify(records) + "\n");
console.log("Prepared four fictional components and the shared offline renderer for DevPocket.");
