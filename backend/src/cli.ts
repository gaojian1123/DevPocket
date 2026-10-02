import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HostConfig } from "./bridge.js";
import { startRelay } from "./relay.js";
import { provisionHost } from "./store.js";
import { Fault, relayUrl } from "./security.js";
import { VERSION } from "./protocol.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: "string", default: ".data/relay" },
    port: { type: "string", default: "8787" }, bind: { type: "string", default: "127.0.0.1" },
    url: { type: "string" }, name: { type: "string" }, out: { type: "string" },
    config: { type: "string" }, "bridge-data": { type: "string" },
    "trusted-proxy": { type: "string" }, "dev-loopback": { type: "boolean", default: false },
    "fcm-credentials": { type: "string" }, device: { type: "string" }, project: { type: "string" },
    "plugin-dir": { type: "string" }, "confirm-install": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
const [command, verb] = positionals;
const required = (value: string | undefined, name: string): string => {
  if (!value) throw new Fault("ARGUMENT_REQUIRED", `Provide --${name}.`);
  return value;
};
async function loadHost(): Promise<HostConfig> {
  return HostConfig.parse(JSON.parse(await readFile(path.resolve(required(values.config, "config")), "utf8")));
}
async function hostRequest(config: HostConfig, route: string, method: string): Promise<unknown> {
  const response = await fetch(new URL(route, relayUrl(config.relayUrl, config.allowInsecureLoopback)), {
    method, headers: { Authorization: `Bearer ${config.token}` }, redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  const data: unknown = await response.json();
  if (!response.ok) throw new Fault("RELAY_REJECTED", `Relay rejected host operation (${response.status}): ${JSON.stringify(data)}`);
  return data;
}

async function main(): Promise<void> {
  if (values.help || !command) {
    console.log(`DevPocket ${VERSION}
Commands:
  relay --data <private-directory> --url https://relay.example --trusted-proxy 127.0.0.1
  relay --data .data/relay --dev-loopback --port 8787
  host create --data <relay-private-directory> --name <name> --url <relay-origin> --out <host.local.json> --bridge-data <Dev-Box-private-directory>
  pair --config <host.local.json>
  devices --config <host.local.json>
  revoke --config <host.local.json> --device <device-id>
  install --config <host.local.json> --project <existing-git-root> --confirm-install
  install --config <host.local.json> --plugin-dir <local-plugin-folder> --confirm-install

Host creation is an offline administrative operation on the relay host. No network registration endpoint exists.
Install is opt-in and never hot-reloads, changes the global CLI, starts a new session, or initializes Git.`);
    return;
  }
  switch (command) {
    case "relay": {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Fault("PORT_INVALID", "Port must be 0..65535.");
      const relay = await startRelay({
        dataDir: path.resolve(values.data), port, bind: values.bind, publicUrl: values.url,
        allowInsecureLoopback: values["dev-loopback"], trustedProxy: values["trusted-proxy"],
        fcmServiceAccount: values["fcm-credentials"] ?? process.env.DEVPOCKET_FCM_CREDENTIALS,
      });
      console.log(`DevPocket ${VERSION} relay listening on ${relay.url}; public endpoint ${values.url ?? "LOCAL DEVELOPMENT ONLY"}`);
      let stopping = false;
      const stop = async () => { if (stopping) return; stopping = true; await relay.close(); };
      process.once("SIGTERM", () => void stop());
      process.once("SIGINT", () => void stop());
      break;
    }
    case "host": {
      if (verb !== "create") throw new Fault("ARGUMENT_INVALID", "Use host create.");
      const url = relayUrl(required(values.url, "url"), values["dev-loopback"]).origin;
      const out = path.resolve(required(values.out, "out"));
      const name = required(values.name, "name").trim();
      if (!name || name.length > 80) throw new Fault("INVALID_NAME", "Host name must have 1..80 characters.");
      const bridgeData = required(values["bridge-data"], "bridge-data");
      if (!out.endsWith(".local.json")) throw new Fault("PRIVATE_FILE_REQUIRED", "Host credentials must use an ignored .local.json file.");
      await mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
      const target = await import("node:fs/promises").then(({ open }) => open(out, "wx", 0o600));
      try {
        const host = provisionHost(path.resolve(values.data), name);
        const config = HostConfig.parse({ hostId: host.hostId, token: host.token, relayUrl: url,
          dataDir: bridgeData, allowInsecureLoopback: values["dev-loopback"] });
        await target.writeFile(JSON.stringify(config, null, 2));
        console.log(`Provisioned ${host.name}. Private Dev Box configuration written to ${out}. No token was printed.`);
        console.log("Transfer this file privately to the Dev Box. On Windows restrict its ACL to your user; never put it in a public deployment.");
      } finally { await target.close(); }
      break;
    }
    case "pair": console.log(JSON.stringify(await hostRequest(await loadHost(), "/v1/host/pairings", "POST"), null, 2)); break;
    case "devices": console.log(JSON.stringify(await hostRequest(await loadHost(), "/v1/host/devices", "GET"), null, 2)); break;
    case "revoke": {
      const device = required(values.device, "device");
      if (!/^[a-f0-9-]{36}$/.test(device)) throw new Fault("DEVICE_ID_INVALID", "Use the device UUID shown by devices.");
      console.log(JSON.stringify(await hostRequest(await loadHost(), `/v1/host/devices/${device}`, "DELETE"), null, 2));
      break;
    }
    case "install": {
      if (!values["confirm-install"]) throw new Fault("OPT_IN_REQUIRED", "Inspect the target and rerun with --confirm-install. No files changed.");
      if (!!values.project === !!values["plugin-dir"]) throw new Fault("TARGET_REQUIRED", "Specify either --project or --plugin-dir, not both.");
      const configPath = path.resolve(required(values.config, "config"));
      await loadHost();
      let target: string;
      if (values.project) {
        const root = path.resolve(values.project);
        await stat(path.join(root, ".git")).catch(() => { throw new Fault("NOT_GIT_ROOT", "Project installation requires an existing Git root. DevPocket never initializes Git."); });
        target = path.join(root, ".github", "extensions", "devpocket");
      } else {
        const pluginRoot = path.resolve(required(values["plugin-dir"], "plugin-dir"));
        await mkdir(pluginRoot, { recursive: true });
        await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({
          name: "devpocket", version: VERSION, description: "Opt-in access to the original Copilot CLI session", extensions: "./extensions",
        }, null, 2), { flag: "wx" });
        target = path.join(pluginRoot, "extensions", "devpocket");
      }
      const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "extension");
      await mkdir(target, { recursive: true });
      for (const name of ["extension.mjs", "bridge.mjs"]) await copyFile(path.join(source, name), path.join(target, name), 1);
      await writeFile(path.join(target, "connection.local.json"), JSON.stringify({ hostConfigPath: configPath }, null, 2), { flag: "wx", mode: 0o600 });
      await writeFile(path.join(target, ".gitignore"), "*.local.json\n", { flag: "wx" });
      if (process.platform !== "win32") await chmod(configPath, 0o600);
      console.log(`Installed only to ${target}. Nothing was reloaded.`);
      console.log(values.project
        ? "In the EXISTING terminal, explicitly ask its built-in extensions_reload tool to reload extensions. Verify the terminal session ID remains the same."
        : "For folder-only opt-in tests, start an ordinary terminal with --plugin-dir <this-plugin-root>. Existing terminals cannot retroactively add startup flags; use a project extension + explicit hot-load for already-running Git-root sessions.");
      break;
    }
    default: throw new Fault("COMMAND_UNKNOWN", "Unknown command. Use --help.");
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Fault ? `${error.code}: ${error.message}` :
    `DevPocket failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
