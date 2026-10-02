import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist/extension", { recursive: true });
await build({
  entryPoints: ["backend/src/bridge.ts"], outfile: "dist/extension/bridge.mjs",
  bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: false,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
await copyFile("extension/extension.mjs", "dist/extension/extension.mjs");
console.log("Built the opt-in DevPocket extension; it has NOT been installed or reloaded.");
