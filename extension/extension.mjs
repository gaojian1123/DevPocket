import { readFile } from "node:fs/promises";
import { joinSession } from "@github/copilot-sdk/extension";
import { HostConfig, startBridge } from "./bridge.mjs";

const pointer = JSON.parse(await readFile(new URL("./connection.local.json", import.meta.url), "utf8"));
if (typeof pointer.hostConfigPath !== "string") throw new Error("DevPocket requires an opt-in hostConfigPath.");
const config = HostConfig.parse(JSON.parse(await readFile(pointer.hostConfigPath, "utf8")));
const session = await joinSession({ onPermissionRequest: () => ({ kind: "no-result" }) });
const bridge = await startBridge(session, config, { waitForReady: false });
console.error(`[DevPocket] Joined original session ${session.sessionId}; parent PID ${process.ppid}; permission policy is unchanged.`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await bridge.close();
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
