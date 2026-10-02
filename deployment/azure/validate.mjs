import { readFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { parse } from "yaml";
import Ajv from "ajv/dist/2019.js";
import draft7 from "ajv/dist/refs/json-schema-draft-07.json" with { type: "json" };
import addFormats from "ajv-formats";
import { packageRelease, sourceFingerprint } from "./package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const output = path.join(root, ".data", "azure-validation");
await mkdir(output, { recursive: true });
for (const file of await readdir(path.join(root, "deployment", "azure"))) {
  if (file.endsWith(".mjs")) execFileSync(process.execPath, ["--check", path.join(root, "deployment", "azure", file)],
    { stdio: "inherit", timeout: 30_000 });
}
const compiler = process.platform === "win32" ? path.join(root, ".tools", "bicep", "bicep.exe") : process.env.DEVPOCKET_BICEP;
if (!compiler) throw new Error("A local Bicep compiler is required; use DEVPOCKET_BICEP on POSIX.");
execFileSync(compiler, ["build", path.join(root, "infra", "main.bicep"), "--outfile", path.join(output, "main.json")], {
  cwd: root, stdio: "inherit", timeout: 120_000,
});
for (const phase of ["create-ingress", "switch-ingress"]) {
  execFileSync(compiler, ["build", path.join(root, "infra", "recovery", `${phase}.bicep`), "--outfile", path.join(output, `${phase}.json`)],
    { stdio: "inherit", timeout: 120_000 });
}
const create = JSON.parse(await readFile(path.join(output, "create-ingress.json"), "utf8"));
assert.equal(create.resources.length, 1);
assert.equal(create.resources[0].type, "Microsoft.Network/publicIPAddresses");
assert.equal(create.resources[0].properties.dnsSettings.domainNameLabelScope, undefined);
const activate = JSON.parse(await readFile(path.join(output, "switch-ingress.json"), "utf8"));
assert.deepEqual(activate.resources.map((r) => r.type).sort(), ["Microsoft.Network/networkInterfaces", "Microsoft.Storage/storageAccounts"]);
const project = parse(await readFile(path.join(root, "azure.yaml"), "utf8"));
const schema = JSON.parse(await readFile(path.join(root, ".tools", "bicep", "azd-1.25.5.schema.json"), "utf8"));
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addMetaSchema(draft7);
addFormats(ajv);
ajv.addSchema(JSON.parse(await readFile(path.join(root, ".tools", "bicep", "azd-1.25.5.agent.schema.json"), "utf8")),
  "https://raw.githubusercontent.com/Azure/azure-dev/refs/heads/main/cli/azd/extensions/azure.ai.agents/schemas/azure.ai.agent.json");
const validate = ajv.compile(schema);
if (!validate(project)) throw new Error("azure.yaml differs from the official azd 1.25.5 schema: " + JSON.stringify(validate.errors));
assert.equal(project.name, "devpocket");
assert.equal(project.services, undefined, "VM deployment must not invent an azd service host or services: {}.");
assert.equal(project.infra.provider, "bicep");
for (const phase of ["preprovision", "postprovision", "predeploy", "postdeploy", "predown"]) {
  for (const platform of ["windows", "posix"]) {
    const hook = project.hooks[phase][platform];
    assert.ok(hook.run.endsWith(`cli.mjs ${phase}`));
    assert.equal(hook.continueOnError, false);
    assert.equal(hook.shell, platform === "windows" ? "pwsh" : "sh");
  }
}
const template = JSON.parse(await readFile(path.join(output, "main.json"), "utf8"));
const resources = template.resources.find((r) => r.type === "Microsoft.Resources/deployments").properties.template.resources;
const vm = resources.find((r) => r.type === "Microsoft.Compute/virtualMachines");
assert.equal(vm.properties.storageProfile.dataDisks.length, 1);
assert.equal(vm.properties.storageProfile.dataDisks[0].deleteOption, "Detach");
assert.equal(vm.properties.osProfile.customData, undefined, "No bootstrap/credentials in cloud-init.");
assert.equal(vm.properties.osProfile.adminPassword, undefined);
assert.equal(vm.properties.osProfile.linuxConfiguration.disablePasswordAuthentication, true);
const rules = resources.find((r) => r.type === "Microsoft.Network/networkSecurityGroups").properties.securityRules;
assert.deepEqual(rules.filter((r) => r.properties.access === "Allow").flatMap((r) => r.properties.destinationPortRanges), ["80", "443"]);
assert.equal(rules.at(-1).properties.access, "Deny");
const storage = resources.find((r) => r.type === "Microsoft.Storage/storageAccounts");
assert.equal(storage.properties.allowBlobPublicAccess, false);
assert.equal(storage.properties.allowSharedKeyAccess, false);
assert.equal(storage.properties.networkAcls.defaultAction, "Deny");
assert.ok(resources.some((r) => r.type === "Microsoft.Authorization/locks" && r.properties.level === "CanNotDelete"));
const outputs = Object.keys(template.outputs);
assert.ok(outputs.every((name) => !/token|password|secret|sas|host_config/i.test(name)));
const compose = parse(await readFile(path.join(root, "deployment", "azure", "compose.yaml"), "utf8"));
assert.deepEqual(compose.services.relay.ports, ["80:80", "443:443"]);
assert.equal(compose.services.tls.network_mode, "service:relay");
assert.equal(compose.services.relay.restart, "no");
assert.ok(compose.services.relay.volumes.includes("/srv/devpocket/relay:/data"));
assert.equal(compose.services.relay.read_only, true);
execFileSync("python", ["-c", "import ast,pathlib; ast.parse(pathlib.Path(r'deployment/azure/vm/control.py').read_text())"], {
  cwd: root, stdio: "inherit", timeout: 30_000,
});
const artifact = process.argv.includes("--no-package") ? undefined : await packageRelease(root, output);
console.log(`LOCAL VALIDATION PASSED: Bicep, manifest/hook contracts, ingress/storage guards, Python syntax, deterministic source packaging.`);
console.log(`Source fingerprint: ${await sourceFingerprint(root)}`);
if (artifact) console.log(`Private upload package prepared locally: ${artifact.file} (${artifact.size} bytes). No Azure identity, provider or resource operation executed.`);
else console.log("No application package was generated; staged recovery requires live DNS and completed network-switch evidence first.");
