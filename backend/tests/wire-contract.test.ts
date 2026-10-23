import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Action, Command, ComponentRecord, Id, Json, MetadataPatch, PendingRequest, PushRegistration, QuestionRecord, Receipt, RequestId, SessionSummary } from "../src/protocol.js";

type Sample = {
  id: string;
  shape: "command" | "session" | "request" | "receipt" | "question" | "component" | "push-registration";
  wire: Record<string, unknown>;
  backendValid: boolean;
  androidValid: boolean;
};

test("dependency upgrades preserve protocol-v1 IDs, defaults and recursive JSON validation", () => {
  for (const id of ["00000000-0000-0000-0000-000000000000", "12345678-1234-1234-1234-123456789abc"]) {
    assert.equal(Id.parse(id), id);
    assert.deepEqual(Command.parse({ commandId: id, action: { type: "message", text: "hello" } }), {
      commandId: id, action: { type: "message", text: "hello", attachmentIds: [] },
    });
  }
  const result = { nested: [{ value: 1.5, empty: null, enabled: true }], text: "hello" };
  assert.deepEqual(Json.parse(result), result);
  for (const value of [undefined, { nested: undefined }, [Infinity], { nested: [NaN] }])
    assert.equal(Json.safeParse(value).success, false);
  assert.equal(Id.safeParse("not-an-id").success, false);
  assert.equal(Action.safeParse({ type: "abort", unexpected: true }).success, false);
});

test("wire text limits remain UTF-16 based and trimming still precedes metadata bounds", () => {
  const emoji = "\u{1F600}";
  assert.equal(RequestId.parse(emoji.repeat(100)), emoji.repeat(100));
  assert.equal(RequestId.safeParse(emoji.repeat(101)).success, false);
  assert.deepEqual(MetadataPatch.parse({ title: " ".repeat(200) + emoji.repeat(80) + " ".repeat(200) }),
    { title: emoji.repeat(80) });
  assert.equal(MetadataPatch.safeParse({ title: emoji.repeat(81) }).success, false);
  assert.equal(Action.safeParse({ type: "answer", requestId: "answer", answer: emoji.repeat(4000) }).success, true);
  assert.equal(Action.safeParse({ type: "answer", requestId: "answer", answer: emoji.repeat(4001) }).success, false);
});

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
      question: QuestionRecord, component: ComponentRecord, "push-registration": PushRegistration }[sample.shape];
    assert.equal(schema.safeParse(value).success, sample.backendValid, sample.id);
    if (sample.shape === "command" && sample.backendValid) {
      const decoded = Command.parse(value);
      assert.equal(decoded.commandId, sample.wire.commandId, sample.id);
      assert.equal(Action.parse(decoded.action).type, (sample.wire.action as { type: string }).type, sample.id);
    }
  }
});
