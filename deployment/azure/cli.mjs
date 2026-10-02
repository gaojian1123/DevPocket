import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { makePlan, requireApproval, PHASES, bicepParameters } from "./plan.mjs";
import { packageRelease, sourceFingerprint } from "./package.mjs";
import { prepareApplication, startApplication, publicCheck } from "./application.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  config: { type: "string" }, phases: { type: "string" }, confirm: { type: "string" },
  minutes: { type: "string", default: "60" }, release: { type: "string" },
} });
const command = positionals[0] ?? "help";
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });

async function context() {
  let env = process.env;
  if (values.config) env = JSON.parse(await readFile(path.resolve(values.config), "utf8"));
  else if (!env.DEVPOCKET_DEPLOYMENT_ID) {
    try {
      const local = JSON.parse(execFileSync("azd", ["env", "get-values", "--output", "json", "--no-prompt"], {
        cwd: root, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      }));
      env = { ...local, ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("AZURE_") || name.startsWith("DEVPOCKET_"))) };
    } catch {
      throw new Error("A project-local azd environment is required. Configure its explicit inputs or use --config with a private JSON file. No login or Azure operation was attempted.");
    }
  }
  const plan = makePlan(env, await sourceFingerprint(root));
  const directory = path.join(root, ".data", "azure", plan.target.environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).some((name) => /^recovery-\d{3}$/.test(name)))
    throw new Error("A separately numbered recovery plan exists. Use recovery.mjs; the original evidence and initial large template must not be overwritten or reapplied.");
  return { root, plan, directory };
}

async function approved(context, phases) {
  if (await sourceFingerprint(root) !== context.plan.sourceHash)
    throw new Error("Local source changed during the operation. Rebuild/review and approve the new plan; no next cloud phase was started.");
  let approval;
  try { approval = JSON.parse(await readFile(path.join(context.directory, "approval.local.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("Cannot read a valid local deployment approval."); }
  for (const phase of phases) requireApproval(context.plan, approval, phase);
  return approval;
}

async function cloud(context, phases) {
  await approved(context, phases);
  const { AzureOperations } = await import("./cloud.mjs");
  return new AzureOperations(context.plan);
}

async function deploy(context, { start = false } = {}) {
  const operations = await cloud(context, start ? ["upload", "deploy", "start"] : ["upload", "deploy"]);
  return prepareApplication(context, operations, (phases) => approved(context, phases), { start });
}

async function startPrepared(context, phase = "start") {
  const operations = await cloud(context, [phase]);
  return startApplication(context, operations, (phases) => approved(context, phases), { phase, release: values.release });
}

async function main() {
  if (command === "help") {
    console.log(`DevPocket Azure preparation (no app version/release changes)
Local only:
  npm --prefix deployment\\azure ci --ignore-scripts
  node deployment\\azure\\cli.mjs plan [--config .data\\azure-input.local.json]
  node deployment\\azure\\cli.mjs package [--config ...]
  node deployment\\azure\\validate.mjs
After the user explicitly authorizes the exact printed plan:
  node deployment\\azure\\cli.mjs approve --phases provision,upload,deploy,start --confirm <planHash> [--minutes 60]
  azd provision
  azd deploy
Separated operations: prepare-deploy (upload/build, no start), start, rollback --release <previous-digest>, backup, public-check.
Preview: approve the preview phase, then run preview for ARM what-if (not provisioning).
Approval is scoped to source + tenant/subscription/group/config and expires within four hours. No az login, account set, provider registration, FCM setup, host pairing or CLI installation is automated.
Predown always refuses destructive teardown; persistent disks are deletion-locked.`);
    return;
  }
  if (command === "predown") throw new Error("Destructive azd down is intentionally disabled. Review backups, exact resources and the data-disk deletion lock with the owner first.");
  if (["predeploy", "postdeploy"].includes(command) && process.env.DEVPOCKET_REAL_RELEASE_ID) {
    const id = process.env.DEVPOCKET_REAL_RELEASE_ID, environment = process.env.AZURE_ENV_NAME ?? "";
    if (id !== "001" || !/^devpocket-[a-z0-9][a-z0-9-]{0,28}$/.test(environment))
      throw new Error("Invalid explicit real-release hook selection.");
    execFileSync(process.execPath, [path.join(root, "deployment", "azure", "real-release.mjs"),
      command === "predeploy" ? "predeploy" : "run", "--directory",
      path.join(root, ".data", "azure", environment, `real-release-${id}`)],
    { stdio: "inherit", windowsHide: true, timeout: 3 * 3600_000 });
    return;
  }
  if (["predeploy", "postdeploy"].includes(command) && process.env.DEVPOCKET_RECOVERY_ID) {
    const id = process.env.DEVPOCKET_RECOVERY_ID;
    const environment = process.env.AZURE_ENV_NAME ?? "";
    if (!/^\d{3}$/.test(id) || !/^devpocket-[a-z0-9][a-z0-9-]{0,28}$/.test(environment))
      throw new Error("Invalid explicit project-local recovery hook selection.");
    execFileSync(process.execPath, [path.join(root, "deployment", "azure", "recovery.mjs"),
      command === "predeploy" ? "predeploy" : "deploy", "--directory",
      path.join(root, ".data", "azure", environment, `recovery-${id}`)],
    { stdio: "inherit", windowsHide: true, timeout: 2 * 3600_000 });
    return;
  }
  const ctx = await context();
  if (command === "plan") {
    await json(path.join(ctx.directory, "plan.json"), ctx.plan);
    const parameters = Object.fromEntries(Object.entries(bicepParameters(ctx.plan)).map(([key, value]) => [key, { value }]));
    await json(path.join(ctx.directory, "parameters.local.json"), { parameters });
    console.log(JSON.stringify(ctx.plan, null, 2));
    return;
  }
  if (command === "approve") {
    const phases = (values.phases ?? "").split(",");
    if (!phases.length || phases.some((phase) => !PHASES.includes(phase))) throw new Error("Specify only recognized approval phases.");
    if (values.confirm !== ctx.plan.planHash) throw new Error("Explicit --confirm must equal the inspected planHash.");
    const minutes = Number(values.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new Error("Approval lifetime must be 1..240 minutes.");
    await json(path.join(ctx.directory, "approval.local.json"), {
      schemaVersion: 1, planHash: ctx.plan.planHash, phases, issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    });
    console.log("Local approval recorded. No cloud call made. Do not record approval until the owner has agreed to the exact target, resources and costs.");
    return;
  }
  if (command === "package") {
    const result = await packageRelease(root, path.join(ctx.directory, "packages"));
    console.log(JSON.stringify({ file: result.file, sha256: result.sha256, size: result.size, files: result.manifest.files.length }));
    return;
  }
  if (command === "preview") {
    const operations = await cloud(ctx, ["preview"]);
    const compiler = process.platform === "win32" ? path.join(root, ".tools", "bicep", "bicep.exe") : process.env.DEVPOCKET_BICEP;
    if (!compiler) throw new Error("Set DEVPOCKET_BICEP to an installed standalone compiler.");
    const templateFile = path.join(ctx.directory, "main.json");
    execFileSync(compiler, ["build", path.join(root, "infra", "main.bicep"), "--outfile", templateFile], { stdio: "inherit", timeout: 120_000 });
    let changes;
    try {
      changes = await operations.preview(JSON.parse(await readFile(templateFile, "utf8")));
    } catch (error) {
      await json(path.join(ctx.directory, "what-if.json"), { at: new Date().toISOString(), planHash: ctx.plan.planHash,
        status: "blocked", error: error.message, preflight: operations.preflightInfo ?? { identity: "not-established" }, mutationsPerformed: false });
      throw error;
    }
    await json(path.join(ctx.directory, "what-if.json"), { at: new Date().toISOString(), planHash: ctx.plan.planHash,
      status: "succeeded", preflight: operations.preflightInfo, changes, mutationsPerformed: false });
    console.log(JSON.stringify(changes, null, 2));
    console.log("ARM what-if only. The owner must review replacements/deletions and approve actual provisioning separately.");
    return;
  }
  if (command === "preprovision") {
    const operations = await cloud(ctx, ["provision"]);
    const status = await operations.preflight({ allowMissing: true });
    console.log(`Approved isolated target checked (${status.existing ? "same owned group" : "new group"}). No provider registration or account switching performed.`);
    return;
  }
  if (command === "postprovision") {
    const operations = await cloud(ctx, ["provision"]);
    const actual = await operations.vmContext();
    await json(path.join(ctx.directory, "provisioned.local.json"), { planHash: ctx.plan.planHash, ...actual, at: new Date().toISOString() });
    console.log("INFRASTRUCTURE exists and ownership/disk identity verified. Docker/application, public TLS/WSS and pairing have not been accepted.");
    return;
  }
  if (command === "predeploy") {
    await cloud(ctx, ["upload", "deploy", "start"]);
    console.log("Custom VM deployment approved; the postdeploy hook owns package/upload/build/start. No built-in VM host is assumed.");
    return;
  }
  if (command === "postdeploy") return deploy(ctx, { start: true });
  if (command === "prepare-deploy") return deploy(ctx);
  if (command === "start" || command === "rollback") return startPrepared(ctx, command);
  if (command === "backup") {
    const operations = await cloud(ctx, ["backup"]);
    const actual = await operations.vmContext();
    await operations.runVm("backup", actual, await readFile(path.join(root, "deployment", "azure", "vm", "control.py"), "utf8"));
    console.log("A private local data-disk backup was created; it is not an off-VM disaster-recovery backup.");
    return;
  }
  if (command === "public-check") return publicCheck(ctx);
  throw new Error("Unsupported command; use help. No cloud mutation performed.");
}

main().catch((error) => {
  if (error.name === "CredentialUnavailableError" || error.name === "AuthenticationRequiredError")
    console.error("The explicitly tenant-scoped azd credential is unavailable. Confirm azd login and tenant; az CLI login was not used or changed.");
  else console.error(error.message);
  process.exitCode = 1;
});
