import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startBridge } from "../src/bridge.js";
import { startRelay } from "../src/relay.js";
import type { JoinedSession } from "../src/runtime.js";
import { provisionHost } from "../src/store.js";

export async function startAndroidFixture(directory: string) {
  await mkdir(directory);
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const relay = await startRelay({ dataDir: path.join(directory, "relay"), allowInsecureLoopback: true, port: 0 });
  const host = provisionHost(path.join(directory, "relay"), "Automated fixture host");
  const sessionId = randomUUID(), title = "DevPocket automated fixture";
  const history: { id: string; type: string; timestamp: string; data: object }[] = [];
  let listener: (event: unknown) => void = () => {};
  let active = false, closed = false, count = 0, answerCount = 0;
  type QuestionKind = "choice" | "text" | "form" | "race" | "uncertain";
  const questions = new Map<string, QuestionKind>();
  const emit = (type: string, data: object) => {
    const event = { id: randomUUID(), type, timestamp: new Date().toISOString(), data };
    history.push(event);
    listener(event);
  };
  emit("session.start", { sessionId, copilotVersion: "automated-test-adapter", context: { cwd: workspace } });
  emit("assistant.message", { messageId: "fixture-history", content: "Fixture history before attachment" });
  const answer = async (requestId: string, value: string) => {
    const kind = questions.get(requestId);
    if (!kind) return { success: false };
    if (!value || (kind !== "text" && !["Alpha", "Beta"].includes(value))) throw new Error("Invalid fixture answer.");
    answerCount++;
    questions.delete(requestId);
    emit(kind === "form" ? "elicitation.completed" : "user_input.completed", { requestId });
    emit("tool.execution_complete", { toolCallId: requestId, success: true, result: { content: "Private tool details" } });
    emit("assistant.message", { messageId: randomUUID(), content: `Fixture continued after ${kind} question` });
    active = false;
    emit("session.idle", {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    return kind === "uncertain" ? { accepted: true } : { success: kind !== "race" };
  };
  const session: JoinedSession = {
    sessionId, getEvents: async () => [...history],
    on: (handler) => { listener = handler; return () => { listener = () => {}; }; },
    send: async ({ prompt, mode, source }) => {
      if (mode !== "enqueue" || source !== "user") throw new Error("Invalid fixture message provenance.");
      if (closed) throw new Error("Fixture is closed.");
      count++;
      active = true;
      const messageId = randomUUID();
      emit("assistant.turn_start", {});
      emit("user.message", { messageId, content: prompt });
      const kind = /^native fixture ask (choice|text|form|race|uncertain)$/.exec(prompt)?.[1] as QuestionKind | undefined;
      if (kind) {
        const requestId = `fixture-${kind}-${count}`;
        questions.set(requestId, kind);
        emit("tool.execution_start", { toolCallId: requestId, toolName: "ask_user", arguments: { private: "NOT_EXPORTED" } });
        if (kind === "form") emit("elicitation.requested", {
          requestId, message: "Fixture form question\n" +
            Array.from({ length: 16 }, (_, index) => `Full safe form detail ${index + 1}`).join("\n"), mode: "form",
          requestedSchema: { type: "object", properties: {
            selection: { type: "string", title: "Fixture form", enum: ["Alpha", "Beta"] },
          }, required: ["selection"] },
        });
        else emit("user_input.requested", {
          requestId, question: `Fixture ${kind} question`,
          choices: kind === "text" ? [] : ["Alpha", "Beta"], allowFreeform: kind === "text",
        });
        return messageId;
      }
      emit("assistant.message", { messageId: randomUUID(), content: `Fixture reply: ${prompt}`, originatingMessageId: messageId });
      active = false;
      emit("session.idle", {});
      // Deliver completion before admission returns to exercise late acknowledgement handling.
      await new Promise((resolve) => setTimeout(resolve, 200));
      return messageId;
    },
    rpc: {
      metadata: { activity: async () => ({ hasActiveWork: active, abortable: false }) },
      permissions: { getMode: async () => ({ mode: "manual" }), pendingRequests: async () => ({ items: [] }),
        paths: { list: async () => ({ primary: workspace }) } },
      name: { get: async () => ({ name: title }) },
      queue: { pendingItems: async () => ({ items: [] }) },
      ui: {
        handlePendingUserInput: async ({ requestId, response }) => answer(requestId, response.answer),
        handlePendingElicitation: async ({ requestId, result }) => answer(requestId, result.content.selection ?? ""),
      },
    },
  };
  const config = { hostId: host.hostId, token: host.token, relayUrl: relay.url,
    dataDir: path.join(directory, "bridge"), allowInsecureLoopback: true };
  let bridge: Awaited<ReturnType<typeof startBridge>>;
  try {
    bridge = await startBridge(session, config);
    const response = await fetch(`${relay.url}/v1/host/pairings`, {
      method: "POST", headers: { Authorization: `Bearer ${host.token}` }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Fixture pairing failed (${response.status}).`);
    const pairing = await response.json() as { code: string };
    return {
      url: relay.url, sessionId, title, pairingCode: pairing.code,
      invocations: () => count,
      answers: () => answerCount,
      reconnect: async () => {
        await bridge.close();
        bridge = await startBridge(session, config);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await bridge.close();
        await relay.close();
      },
    };
  } catch (error) {
    await relay.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { directory: { type: "string" }, output: { type: "string" } } });
  if (!values.directory || !values.output) throw new Error("--directory and --output are required.");
  const fixture = await startAndroidFixture(path.resolve(values.directory));
  await writeFile(values.output, JSON.stringify({
    relayUrl: fixture.url, sessionId: fixture.sessionId, title: fixture.title, pairingCode: fixture.pairingCode,
  }), { mode: 0o600, flag: "wx" });
  console.log("Isolated Android fixture ready.");
  const stop = async () => { await fixture.close(); process.stdin.pause(); };
  process.stdin.once("data", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}
