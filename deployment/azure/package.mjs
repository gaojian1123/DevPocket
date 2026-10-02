import { lstat, readFile, readdir, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { digest } from "./plan.mjs";

const files = ["package.json", "package-lock.json", ".dockerignore", "backend/tsconfig.json",
  "scripts/bundle-extension.mjs", "deployment/Dockerfile", "deployment/Caddyfile", "deployment/azure/compose.yaml",
  "deployment/onboarding/setup.mjs", "deployment/onboarding/setup-azure.mjs", "deployment/onboarding/setup-actions.mjs",
  "deployment/onboarding/setup-state.mjs", "deployment/onboarding/handoff.mjs", "deployment/onboarding/cloud-host.mjs",
  "deployment/onboarding/guest.py", "deployment/onboarding/private-directory.ps1"];
const directories = ["backend/src", "extension", "deployment/azure/vm"];
const privatePath = /(^|\/)(\.azure|\.data|\.tools|node_modules|\.git|__pycache__)(\/|$)|(^|\/)\.env(?:\.|$)|\.local\.|(?:\.pem|\.key|\.jks|\.keystore|\.sqlite(?:-.*)?|\.db(?:-.*)?|\.apk)$/i;
const secretContent = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:github_pat_|ghp_)[A-Za-z0-9_]{30,}|dp[hdp]_[A-Za-z0-9_-]{43}/;
const local = (root, name) => path.join(root, ...name.split("/"));

async function walk(root, name, selected) {
  const info = await lstat(local(root, name));
  if (info.isSymbolicLink()) throw new Error(`Release packaging refuses links: ${name}`);
  if (privatePath.test(name)) return;
  if (info.isDirectory()) {
    for (const child of (await readdir(local(root, name))).sort()) await walk(root, `${name}/${child}`, selected);
  } else if (info.isFile()) {
    if (!/^[A-Za-z0-9_.\/-]+$/.test(name)) throw new Error(`Unsupported archive path: ${name}`);
    const content = await readFile(local(root, name));
    if (content.length > 4 * 1024 * 1024) throw new Error(`Source file too large: ${name}`);
    if (secretContent.test(content.toString("utf8"))) throw new Error(`Possible credential in release source: ${name}; not uploaded.`);
    selected.push({ name, content, sha256: digest(content) });
  } else throw new Error(`Not a regular source file: ${name}`);
}

export async function releaseSources(root) {
  const selected = [];
  for (const name of [...files, ...directories]) await walk(root, name, selected);
  if (!selected.some((item) => item.name.startsWith("deployment/azure/vm/"))) throw new Error("VM deployment implementation is missing.");
  if (selected.length > 250 || selected.reduce((sum, item) => sum + item.content.length, 0) > 20 * 1024 * 1024)
    throw new Error("Release exceeds the 250-file/20-MiB source limit.");
  return selected.sort((a, b) => a.name.localeCompare(b.name, "en"));
}

export async function sourceFingerprint(root) {
  const selected = await releaseSources(root);
  for (const name of ["azure.yaml", "infra"]) await walk(root, name, selected);
  for (const entry of (await readdir(local(root, "deployment/azure"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && /\.(mjs|json|ps1)$/.test(entry.name)) await walk(root, `deployment/azure/${entry.name}`, selected);
    if (entry.isDirectory() && ["probe", "real"].includes(entry.name)) await walk(root, `deployment/azure/${entry.name}`, selected);
  }
  return digest(JSON.stringify(selected.map(({ name, sha256 }) => ({ name, sha256 })).sort((a, b) => a.name.localeCompare(b.name, "en"))));
}

export async function packageRelease(root, output, binding) {
  const selected = await releaseSources(root);
  if (binding) {
    const content = Buffer.from(JSON.stringify({
      schemaVersion: 1, deploymentId: binding.deploymentId, host: binding.host,
      tlsEmail: binding.tlsEmail, autostart: binding.autostart,
    }, null, 2) + "\n");
    selected.push({ name: "deployment-target.json", content, sha256: digest(content) });
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(path.join(output, "snapshot-"));
  const archive = path.join(stage, "archive.tar.gz");
  try {
    for (const file of selected) {
      const target = local(stage, file.name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, { flag: "wx", mode: file.name.endsWith(".sh") ? 0o755 : 0o644 });
    }
    const manifest = { schemaVersion: 1, files: selected.map(({ name, sha256 }) => ({ name, sha256 })) };
    await writeFile(path.join(stage, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await tar.c({ cwd: stage, file: archive, gzip: true, portable: true, mtime: new Date(0), noDirRecurse: true },
      [...selected.map((item) => item.name), "release-manifest.json"]);
    const bytes = await readFile(archive);
    const sha256 = digest(bytes), target = path.join(output, `${sha256}.tar.gz`);
    try { await writeFile(target, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST" || digest(await readFile(target)) !== sha256) throw error;
    }
    return { file: target, sha256, size: bytes.length, manifest };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
