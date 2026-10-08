import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Action, Command, HostFrame, PendingRequest, Receipt, RelayReady, SessionSummary, UserEvent } from "../backend/src/protocol.js";

const schema = zodToJsonSchema(z.object({
  action: Action, command: Command, hostFrame: HostFrame, pendingRequest: PendingRequest,
  receipt: Receipt, relayReady: RelayReady, sessionSummary: SessionSummary, userEvent: UserEvent,
}), { name: "DevPocketProtocolV1", $refStrategy: "root" });
await writeFile("protocol.schema.json", JSON.stringify(schema, null, 2) + "\n");
console.log("Exported protocol.schema.json from the runtime-validated v1 contract.");
