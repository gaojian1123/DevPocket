import { appendFile, lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { diagnosticError } from "./diagnostic-errors.mjs";

const names = new Set(["device-diagnostics.json", "verification-diagnostics.json", "platform-diagnostics.json",
  "startup-report.json", "android-diagnostics.json", "worker-diagnostics.json", "backend-diagnostics.json"]);
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

export async function diagnosticDirectory(root, value) {
  root = path.resolve(root);
  const directory = path.resolve(root, value), relative = path.relative(root, directory);
  if (relative !== path.join(".data", "ci") &&
      !["ci", "verification"].some((folder) => relative.startsWith(path.join(".data", folder) + path.sep))) {
    throw diagnosticError("ownership-mismatch");
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { await mkdir(current); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(current), current)) {
      throw diagnosticError("ownership-mismatch");
    }
  }
  return directory;
}

async function githubFile(variable, prefix, environment) {
  const file = environment[variable], temp = environment.RUNNER_TEMP;
  if (environment.GITHUB_ACTIONS !== "true" || !file || !temp) throw diagnosticError("report-unavailable");
  const root = await realpath(temp), absolute = path.resolve(file);
  if (!samePath(path.dirname(absolute), path.join(root, "_runner_file_commands")) ||
      !new RegExp(`^${prefix}_[a-f0-9-]{36}$`, "i").test(path.basename(absolute))) {
    throw diagnosticError("ownership-mismatch");
  }
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || !samePath(await realpath(absolute), absolute)) {
    throw diagnosticError("ownership-mismatch");
  }
  return absolute;
}

export async function publishStartupOwner(runId, environment = process.env) {
  if (typeof runId !== "string" || !/^[a-f0-9-]{36}$/.test(runId)) throw diagnosticError("configuration");
  await appendFile(await githubFile("GITHUB_OUTPUT", "set_output", environment), `startup_run_id=${runId}\n`);
}

export async function publishDiagnostic({
  root = process.cwd(), directory, name, value, limit = 32768, github = false, environment = process.env,
  outputKey = "report_ready",
}) {
  if (!names.has(name) || !["report_ready", "startup_report_ready"].includes(outputKey) ||
      !Number.isInteger(limit) || limit < 1 || limit > 65536) throw diagnosticError("plan-invalid");
  const destination = await diagnosticDirectory(root, directory);
  const bytes = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > limit) throw diagnosticError("output-limit");
  const output = await open(path.join(destination, name), "wx", 0o600);
  try { await output.writeFile(bytes); await output.sync(); }
  finally { await output.close(); }
  if (github) {
    await appendFile(await githubFile("GITHUB_OUTPUT", "set_output", environment), `${outputKey}=true\n`);
  }
  process.stdout.write(bytes);
  if (github) {
    await appendFile(await githubFile("GITHUB_STEP_SUMMARY", "step_summary", environment),
      `### ${name}\n\nDiagnostic metadata only; original execution and required gate remain authoritative.\n\n\`\`\`json\n${bytes}\`\`\`\n`);
  }
}
