import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Action, Command, ComponentRecord, PendingRequest, QuestionRecord, Receipt, SessionSummary } from "../src/protocol.js";

type Sample = {
  id: string;
  shape: "command" | "session" | "request" | "receipt" | "question" | "component";
  wire: Record<string, unknown>;
  backendValid: boolean;
  androidValid: boolean;
};

test("shared protocol-v1 samples retain deliberate server and Android decoding contracts", async () => {
  const samples: Sample[] = JSON.parse(await readFile("test-fixtures/protocol/v1.json", "utf8"));
  assert.ok(samples.length >= 6, "The corpus must include legacy, current and invalid shapes.");
  for (const sample of samples) {
    let value = sample.wire;
    if (sample.shape === "session") {
      const { hostId, online, pinned, archived, lastSeen, ...summary } = value;
      assert.equal(typeof hostId, "string");
      assert.equal(typeof online, "boolean");
      assert.equal(typeof pinned, "boolean");
      assert.equal(typeof archived, "boolean");
      assert.equal(typeof lastSeen, "number");
      value = summary;
    }
    const schema = { command: Command, session: SessionSummary, request: PendingRequest, receipt: Receipt,
      question: QuestionRecord, component: ComponentRecord }[sample.shape];
    assert.equal(schema.safeParse(value).success, sample.backendValid, sample.id);
    if (sample.shape === "command" && sample.backendValid) {
      const decoded = Command.parse(value);
      assert.equal(decoded.commandId, sample.wire.commandId, sample.id);
      assert.equal(Action.parse(decoded.action).type, (sample.wire.action as { type: string }).type, sample.id);
    }
  }
});
