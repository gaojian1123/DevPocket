import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const target = path.join(root, "dist", "web");
const require = createRequire(import.meta.url);
await mkdir(target, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["src/web.ts"],
  outfile: path.join(target, "component.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  minify: true,
  legalComments: "linked",
});
for (const file of ["index.html", "component.css"])
  await copyFile(path.join(root, "web", file), path.join(target, file));

async function packageRoot(name) {
  let directory = path.dirname(require.resolve(name));
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (manifest.name === name) return directory;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot locate the installed package license: ${name}`);
}

const notices = [];
for (const name of ["chart.js", "@kurkle/color", "markdown-it", "argparse", "entities", "linkify-it",
  "mdurl", "punycode.js", "uc.micro", "zod"]) {
  const directory = await packageRoot(name);
  let license;
  for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md", "LICENSE-MIT", "LICENSE-MIT.txt"]) {
    try { license = await readFile(path.join(directory, file), "utf8"); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!license) throw new Error(`Missing redistribution notice: ${name}`);
  notices.push(`=== ${name} ===\n${license}`);
}
await writeFile(path.join(target, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n"), "utf8");
