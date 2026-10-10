import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { combineVerification, executeVerification, verificationPlan } from "./verification.mjs";

const { values } = parseArgs({ options: {
  repo: { type: "string", default: process.cwd() },
  base: { type: "string" },
  report: { type: "string" },
  plan: { type: "boolean", default: false },
  all: { type: "boolean", default: false },
  group: { type: "string", default: "all" },
  jdk: { type: "string" },
  sdk: { type: "string" },
  image: { type: "string" },
  combine: { type: "boolean", default: false },
  input: { type: "string", multiple: true, default: [] },
} });
const root = path.resolve(values.repo);
const reportPath = path.resolve(root, values.report ?? path.join(".data", "verification", randomUUID(), "report.json"));
const relative = path.relative(root, reportPath);
if (!["verification", "ci"].some((folder) => relative.startsWith(path.join(".data", folder) + path.sep))) {
  throw new Error("New reports belong under .data\\verification or .data\\ci, never sealed or operational evidence directories.");
}
let parent = root;
for (const part of path.relative(root, path.dirname(reportPath)).split(path.sep)) {
  parent = path.join(parent, part);
  try { await mkdir(parent); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (!(await lstat(parent)).isDirectory() || (await lstat(parent)).isSymbolicLink()) {
    throw new Error("Linked report directories are not supported.");
  }
}
const output = await open(reportPath, "wx", 0o600);
let report;
try {
  try {
    const plan = await verificationPlan(root, values.base, values.all);
    if (values.plan && values.combine) throw new Error("Plan and combine are mutually exclusive.");
    if (values.combine) {
      const reports = await Promise.all(values.input.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
      report = combineVerification(plan, reports);
    } else {
      report = values.plan ? { ...plan, status: "planned", complete: false, checks: [] }
        : await executeVerification(root, plan, { ...values, directory: path.dirname(reportPath) });
    }
    if (["failed", "blocked"].includes(report.status)) process.exitCode = 1;
  } catch (error) {
    report = { version: 1, status: "blocked", complete: false, error: error.message, checks: [] };
    process.exitCode = 1;
  }
  await output.writeFile(JSON.stringify(report, null, 2) + "\n");
  await output.sync();
} finally { await output.close(); }
console.log(`Verification ${report.status}: ${reportPath}`);
