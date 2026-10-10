import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";
import { fileURLToPath } from "node:url";
import { registerDevelopmentExtension } from "../../../scripts/workflow-extension.mjs";

await registerDevelopmentExtension({ defineWorkflow, joinSession }, fileURLToPath(new URL("../../../", import.meta.url)));
