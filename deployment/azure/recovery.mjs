import { readFile, writeFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { makeRecoveryPlan, RECOVERY_PHASES } from "./recovery-plan.mjs";
import { requireApproval, digest } from "./plan.mjs";
import { sourceFingerprint } from "./package.mjs";
import { RecoveryOperations } from "./recovery-cloud.mjs";
import { prepareApplication, startApplication, publicCheck } from "./application.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  directory: { type: "string" }, phases: { type: "string" }, confirm: { type: "string" },
  minutes: { type: "string", default: "60" },
} });
const command = positionals[0] ?? "help";
const json = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });

async function context() {
  const directory = path.resolve(values.directory ?? "");
  if (!directory.startsWith(path.join(root, ".data", "azure") + path.sep) || !/^recovery-\d{3}$/.test(path.basename(directory)))
    throw new Error("Use an explicitly numbered recovery directory under this project's private .data/azure tree.");
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Recovery evidence directory must not be a link.");
  const [base, input, baseline] = await Promise.all(["base-plan.json", "input.local.json", "baseline.json"]
    .map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8"))));
  const plan = makeRecoveryPlan(base, input, baseline, await sourceFingerprint(root));
  if (path.basename(directory) !== `recovery-${plan.recovery.id}`) throw new Error("Recovery ID does not match its independent evidence directory.");
  return { root, directory, plan, baseline };
}

async function authorize(ctx, phases) {
  if (await sourceFingerprint(root) !== ctx.plan.sourceHash) throw new Error("Recovery source changed after planning.");
  const baseline = JSON.parse(await readFile(path.join(ctx.directory, "baseline.json"), "utf8"));
  if (digest(JSON.stringify(baseline)) !== ctx.plan.recovery.baselineHash) throw new Error("Preserved recovery baseline changed.");
  let approval;
  try { approval = JSON.parse(await readFile(path.join(ctx.directory, "approval.local.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const phase of phases) requireApproval(ctx.plan, approval, phase);
}

function compile(ctx, phase) {
  const compiler = process.platform === "win32" ? path.join(root, ".tools", "bicep", "bicep.exe") : process.env.DEVPOCKET_BICEP;
  if (!compiler) throw new Error("A standalone Bicep compiler is required.");
  const target = path.join(ctx.directory, `${phase}.template.json`);
  execFileSync(compiler, ["build", path.join(root, "infra", "recovery", `${phase}.bicep`), "--outfile", target],
    { stdio: "inherit", timeout: 120_000 });
  return readFile(target, "utf8").then(JSON.parse);
}

async function main() {
  if (command === "help") {
    console.log(`DevPocket staged recovery. Every command needs --directory <private recovery-NNN>.
plan (local) | preview (official ARM what-if only) | check-dns (read-only)
approve --phases preview --confirm <planHash> (only after explicit permission)
Future separately authorized mutations: create-ingress, switch-ingress, prepare-deploy, deploy, start.
Never edit/delete the original PIP or reuse old approvals. No new hostname is guessed.
create-ingress creates only the new PIP; switch-ingress requires fresh exact DNS evidence before NIC/single-IP rule changes.
Application packaging/upload/start is blocked until switch receipt + live DNS/attachment verification pass.`);
    return;
  }
  const ctx = await context();
  if (command === "plan") {
    await json(path.join(ctx.directory, "plan.json"), ctx.plan);
    console.log(JSON.stringify(ctx.plan, null, 2));
    return;
  }
  if (command === "approve") {
    const phases = (values.phases ?? "").split(",");
    if (!phases.length || phases.some((phase) => !RECOVERY_PHASES.includes(phase))) throw new Error("Invalid recovery phase.");
    if (values.confirm !== ctx.plan.planHash) throw new Error("Exact reviewed recovery plan hash is required.");
    const minutes = Number(values.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new Error("Approval must expire within four hours.");
    await json(path.join(ctx.directory, "approval.local.json"), {
      schemaVersion: 1, planHash: ctx.plan.planHash, phases, issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    });
    console.log(`Recovery-only local approval recorded for ${phases.join(",")}. No Azure operation was executed.`);
    return;
  }
  if (command === "preview") {
    await authorize(ctx, ["preview"]);
    const operations = new RecoveryOperations(ctx.plan, ctx.baseline, ctx.directory);
    for (const phase of ["create-ingress", "switch-ingress"]) {
      const result = await operations.previewPhase(phase, await compile(ctx, phase));
      console.log(JSON.stringify({ phase, gate: phase === "switch-ingress" ? "NOT READY: new IP DNS must be verified after creation" : "separate create approval required",
        changes: result.changes.filter((c) => c.changeType !== "Ignore").map((c) => ({
          id: c.resourceId, change: c.changeType, deltas: (c.delta ?? []).map((d) => ({ path: d.path, propertyChangeType: d.propertyChangeType })),
        })) }, null, 2));
    }
    console.log("Read-only previews completed. No PIP, firewall, NIC, VM, source upload or CA mutation occurred.");
    return;
  }
  if (command === "check-dns") {
    await authorize(ctx, ["preview"]);
    const operations = new RecoveryOperations(ctx.plan, ctx.baseline, ctx.directory);
    console.log(JSON.stringify(await operations.checkDns(), null, 2));
    return;
  }
  const phaseMap = { "create-ingress": ["create-ingress"], "switch-ingress": ["switch-ingress"],
    "prepare-deploy": ["upload", "deploy"], predeploy: ["upload", "deploy", "start"],
    deploy: ["upload", "deploy", "start"], start: ["start"] };
  const phases = phaseMap[command];
  if (command === "public-check") return publicCheck(ctx);
  if (!phases) throw new Error("Unsupported recovery command.");
  await authorize(ctx, phases);
  const operations = new RecoveryOperations(ctx.plan, ctx.baseline, ctx.directory);
  const guard = (next) => authorize(ctx, next);
  if (command === "predeploy") {
    await operations.vmContext();
    console.log("Recovery azd deployment gate passed: exact recovery approval, switched network and live new DNS.");
    return;
  }
  if (command === "create-ingress" || command === "switch-ingress")
    return operations.executePhase(command, await compile(ctx, command), guard);
  if (command === "start") return startApplication(ctx, operations, guard);
  return prepareApplication(ctx, operations, guard, { start: command === "deploy" });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
