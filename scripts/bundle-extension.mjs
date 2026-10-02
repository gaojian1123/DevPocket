import { build } from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { VERSION } from "../dist/protocol.js";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.version !== VERSION) throw new Error("Package and protocol application versions must match before distribution.");
await mkdir("dist/extension", { recursive: true });
await build({
  entryPoints: ["backend/src/bridge.ts"], outfile: "dist/extension/bridge.mjs",
  bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: false,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
await copyFile("extension/extension.mjs", "dist/extension/extension.mjs");
await build({
  entryPoints: ["backend/src/cli.ts"], outfile: "dist/devpocket.mjs",
  bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: false,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
console.log("Built the DevPocket bridge and standalone command; neither has been installed or reloaded.");
