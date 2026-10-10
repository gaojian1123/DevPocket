import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { HostConfig } from "../src/bridge.js";
import { Action, Id } from "../src/protocol.js";
import { readHistory } from "./history.js";
import {
  captureCliIdentity, cliProofRequest, cliProofSummary, lockCliCheck, proofArguments, readCliIdentity, readCliProof,
  requireManualCli, startCliProof, stopCliProof, verifyCliAttachment,
} from "./cli-proof.js";

const { values, positionals, directory } = proofArguments({
  "confirm-install": { type: "boolean" }, "command-id": { type: "string" }, "runtime-pid": { type: "string" },
});
const command = z.enum(["start", "inspect", "stop", "capture", "install", "catalog", "events", "send", "receipt", "state", "android"])
  .parse(positionals[0]);
if (["send", "android"].includes(command) && values["confirm-runtime-checks"] !== true) {
  throw new Error("This operation requires --confirm-runtime-checks for the selected disposable proof.");
}
if (command === "install" && values["confirm-install"] !== true) {
  throw new Error("Staging the extension requires --confirm-install for this proof's private plugin.");
}
if (command === "start") {
  const run = await startCliProof(directory);
  console.log(JSON.stringify(cliProofSummary(run.proof), null, 2));
  const close = () => { void run.close().catch((error: unknown) => {
    console.error("Proof cleanup failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  }); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} else if (command === "stop") {
  await stopCliProof(directory);
  console.log("The selected local proof relay is closed. Its original CLI was not stopped.");
} else {
  const proof = await readCliProof(directory);
  const request = cliProofRequest(proof);
  const scoped = `/v1/hosts/${proof.hostId}/sessions/${proof.sessionId}`;
  if (command === "inspect") {
    console.log(JSON.stringify(cliProofSummary(proof)));
  } else if (command === "capture") {
    const pid = z.coerce.number().int().positive().parse(values["runtime-pid"]);
    console.log(JSON.stringify(await captureCliIdentity(proof, pid)));
  } else if (command === "install") {
    await readCliIdentity(proof);
    const target = path.join(proof.plugin, "extensions", "devpocket");
    await mkdir(target);
    for (const file of ["extension.mjs", "bridge.mjs"]) await copyFile(path.resolve("dist", "extension", file), path.join(target, file));
    await writeFile(path.join(target, "connection.local.json"), JSON.stringify({ hostConfigPath: proof.hostConfigPath }), { mode: 0o600, flag: "wx" });
    await writeFile(path.join(proof.root, "attachment-time.json"), JSON.stringify({ attachedFilesAt: Date.now() }), { flag: "wx" });
    console.log("Own extension files installed into the disposable plugin only. Explicitly hot-load them in the EXISTING terminal.");
  } else if (command === "catalog") {
    console.log(JSON.stringify(await request("/v1/catalog"), null, 2));
  } else if (command === "events") {
    const result = { events: await readHistory(request, scoped) };
    await writeFile(path.join(proof.root, "visible-events.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result.events.slice(-16), null, 2));
  } else if (command === "send") {
    const action = Action.parse(JSON.parse(positionals[1] ?? "{}"));
    if (!values["command-id"]) throw new Error("Supply --command-id UUID and preserve it with the same action when checking an uncertain retry.");
    const commandId = Id.parse(values["command-id"]);
    const release = await lockCliCheck(proof, `command-${commandId}`);
    try {
      await verifyCliAttachment(proof);
      await requireManualCli(proof);
      console.log(JSON.stringify(await request(scoped + "/commands", { commandId, action }), null, 2));
    } finally { await release(); }
  } else if (command === "receipt") {
    console.log(JSON.stringify(await request(scoped + "/commands/" + Id.parse(positionals[1])), null, 2));
  } else if (command === "state") {
    const result = { events: await readHistory(request, scoped) };
    console.log(JSON.stringify(result.events.filter((event) => event.kind === "runtime.state" || event.kind === "requests").slice(-5), null, 2));
  } else if (command === "android") {
    const host = HostConfig.parse(JSON.parse(await readFile(proof.hostConfigPath, "utf8")));
    const pairing = await request("/v1/host/pairings", {}, host.token) as { code: string };
    const file = path.join(proof.root, `android-${randomUUID()}.local.json`);
    await writeFile(file, JSON.stringify({
      relayUrl: proof.relayUrl.replace("127.0.0.1", "10.0.2.2"), pairingCode: pairing.code, sessionId: proof.sessionId,
      marker: `DP_NATIVE_ANDROID_${Date.now()}`,
    }), { mode: 0o600, flag: "wx" });
    console.log(`Scoped five-minute pairing saved privately to ${file}; its value was not printed.`);
  } else throw new Error("Unknown proof command.");
}
