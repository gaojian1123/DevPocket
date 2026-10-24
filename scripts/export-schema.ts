import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { Action, Command, HostFrame, PendingRequest, PushRegistration, Receipt, RelayReady, SessionSummary, UserEvent } from "../backend/src/protocol.js";

const schema = z.toJSONSchema(z.object({
  action: Action, command: Command, hostFrame: HostFrame, pendingRequest: PendingRequest,
  receipt: Receipt, relayReady: RelayReady, sessionSummary: SessionSummary, userEvent: UserEvent,
  pushRegistration: PushRegistration,
}), { target: "draft-7", io: "input", reused: "ref" });
let newline = "\n";
try {
  if ((await readFile("protocol.schema.json", "utf8")).includes("\r\n")) newline = "\r\n";
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
await writeFile("protocol.schema.json", (JSON.stringify(schema, null, 2) + "\n").replaceAll("\n", newline));
console.log("Exported protocol.schema.json from the runtime-validated v1 contract.");
