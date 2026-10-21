import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ComponentProjection, componentToolLinks } from "../src/components.js";
import { ComponentRecord, decodeComponentPayload, type UserEvent } from "../src/protocol.js";
import { CopilotRuntime, type JoinedSession } from "../src/runtime.js";
import { hash } from "../src/security.js";

const owner = {
  instanceId: "deck", canvasId: "agenticdeck-canvas",
  extensionId: "plugin:agenticdeck-gh-app-extensions:agenticdeck-canvas",
};
const at = "2026-10-19T00:00:00.000Z";
const event = (type: string, data: Record<string, unknown>) => ({ id: randomUUID(), type, timestamp: at, data });
const markdown = { type: "markdown", title: "Notes", content: "A visible result." };
const chart = { type: "line", xAxisKey: "day", data: [{ day: "A", value: 3 }],
  series: [{ name: "Count", dataKey: "value" }] };

function start(toolCallId: string, spec: unknown, instanceId = owner.instanceId) {
  return event("tool.execution_start", { toolCallId, toolName: "invoke_canvas_action",
    arguments: { instanceId, actionName: "render_component", input: { spec } } });
}
function finish(toolCallId: string, success: boolean | undefined = true) {
  return event("tool.execution_complete", { toolCallId, ...(success === undefined ? {} : { success }) });
}
function ready(events: UserEvent[]) {
  const value = events.find((item) => item.kind === "component")?.data;
  assert.ok(value && value.status === "ready");
  return value;
}
function linked(projection: ComponentProjection, toolCallId: string, origin = "user-A", turnId = "0") {
  projection.observe(event("assistant.message", {
    messageId: randomUUID(), originatingMessageId: origin, turnId, content: "",
    toolRequests: [{ toolCallId, name: "invoke_canvas_action" }],
  }));
}

test("only a validated provider/instance binding can produce a component", () => {
  const projection = new ComponentProjection(randomUUID());
  projection.observe(start("unbound", markdown));
  assert.deepEqual(projection.observe(finish("unbound")), []);
  projection.observe(event("session.canvas.recorded", { ...owner, extensionId: "plugin:another-provider" }));
  projection.observe(start("wrong-provider", markdown));
  assert.deepEqual(projection.observe(finish("wrong-provider")), []);
  projection.observe(event("session.canvas.recorded", owner));
  assert.deepEqual(projection.observe(start("valid", markdown)), []);
  const record = ready(projection.observe(finish("valid")));
  assert.deepEqual(decodeComponentPayload(record.payload, record.sha256), markdown);
  assert.equal(ComponentRecord.safeParse(record).success, true);
});

test("snapshot conflicts cannot replace newer identity evidence with a different provider", () => {
  const projection = new ComponentProjection(randomUUID());
  projection.observe(event("session.canvas.recorded", { ...owner, extensionId: "plugin:another-provider" }));
  assert.equal(projection.beginLive([owner]), false);
  projection.observe(start("ambiguous", markdown));
  assert.deepEqual(projection.observe(finish("ambiguous")), []);
  projection.observe(event("session.canvas.opened", owner));
  projection.observe(start("confirmed", markdown));
  assert.equal(ready(projection.observe(finish("confirmed"))).status, "ready");
  assert.throws(() => projection.snapshot([owner, owner]), { code: "COMPONENT_SNAPSHOT_UNSUPPORTED" });
});

test("all four supported types retain their actual JSON data after projection and decoding", () => {
  const projection = new ComponentProjection(randomUUID());
  projection.beginLive(projection.snapshot([owner])!);
  const table = { type: "datagrid", columns: [{ key: "name", label: "Name" }, { key: "n", label: "Count", type: "number" }],
    rows: [{ name: "A", n: 1 }, { name: "B", n: 2 }] };
  const specs = [markdown, chart, { ...chart, type: "bar" }, table];
  for (const [index, spec] of specs.entries()) {
    projection.observe(start(`call-${index}`, spec));
    const record = ready(projection.observe(finish(`call-${index}`)));
    assert.deepEqual(decodeComponentPayload(record.payload, record.sha256), spec);
  }
});

test("call start is not success, and failed or malformed completion never exposes the input", () => {
  const projection = new ComponentProjection(randomUUID());
  projection.beginLive([owner]);
  for (const [id, completed] of [["failed", finish("failed", false)],
    ["unknown", event("tool.execution_complete", { toolCallId: "unknown" })]] as const) {
    assert.deepEqual(projection.observe(start(id, { type: "markdown", content: "DO_NOT_PUBLISH" })), []);
    const output = projection.observe(completed);
    assert.equal(output[0]?.kind, "component");
    assert.equal((output[0]?.data as { status: string }).status, "unavailable");
    assert.ok(!JSON.stringify(output).includes("DO_NOT_PUBLISH"));
    assert.deepEqual(projection.observe(completed), []);
  }
});

test("unknown types, extra configuration and missing component input are visible unavailable records", () => {
  const projection = new ComponentProjection(randomUUID());
  projection.beginLive([owner]);
  for (const [id, spec] of [["unsupported", { type: "explainer", secret: "NEVER_EXPORT" }],
    ["invalid", { ...markdown, scripts: "NEVER_EXPORT" }]] as const) {
    projection.observe(start(id, spec));
    const output = projection.observe(finish(id));
    assert.equal((output[0]?.data as { status: string }).status, "unavailable");
    assert.ok(!JSON.stringify(output).includes("NEVER_EXPORT"));
  }
  projection.observe(event("tool.execution_start", { toolName: "invoke_canvas_action", toolCallId: "missing",
    arguments: { instanceId: owner.instanceId, actionName: "render_component", input: {} } }));
  assert.equal((projection.observe(finish("missing"))[0]?.data as { status: string }).status, "unavailable");
});

test("origins follow explicit tool requests, not reused model turns or the latest user message", () => {
  const projection = new ComponentProjection(randomUUID());
  projection.beginLive([owner]);
  linked(projection, "A", "user-A", "0");
  linked(projection, "B", "user-B", "0");
  projection.observe(event("user.message", { messageId: "user-C", content: "A queued question" }));
  projection.observe(start("A", markdown));
  projection.observe(start("B", markdown));
  assert.equal(ready(projection.observe(finish("A"))).originatingMessageId, "user-A");
  assert.equal(ready(projection.observe(finish("B"))).originatingMessageId, "user-B");
  linked(projection, "conflict", "user-A");
  linked(projection, "conflict", "user-B");
  projection.observe(start("conflict", markdown));
  assert.equal(ready(projection.observe(finish("conflict"))).originatingMessageId, undefined);
  assert.deepEqual(componentToolLinks({ originatingMessageId: "A", toolRequests: [{ toolCallId: "one" }] }), ["one"]);
  assert.equal(componentToolLinks({ toolRequests: [{ toolCallId: "one" }] }), undefined);
});

test("late origin metadata does not turn an identical replayed call into a content conflict", () => {
  const projection = new ComponentProjection(randomUUID());
  projection.beginLive([owner]);
  const started = start("replayed", markdown);
  projection.observe(started);
  linked(projection, "replayed", "confirmed-user");
  projection.observe(started);
  const record = ready(projection.observe(finish("replayed")));
  assert.equal(record.originatingMessageId, "confirmed-user");
  assert.deepEqual(decodeComponentPayload(record.payload, record.sha256), markdown);
});

test("sensitive values are redacted before encoding, including links and column-labelled secrets", () => {
  const projection = new ComponentProjection(randomUUID());
  projection.beginLive([owner]);
  const token = "ghp_" + "x".repeat(36);
  const content = `${token}\nhttps://account:private-password@example.com/\nhttps://example.com/?X-Amz-Signature=private-signature`;
  projection.observe(start("text", { type: "markdown", content }));
  const record = ready(projection.observe(finish("text")));
  const decoded = JSON.stringify(decodeComponentPayload(record.payload, record.sha256));
  for (const value of [token, "private-password", "private-signature"]) assert.ok(!decoded.includes(value));
  assert.equal(record.redacted, true);
  projection.observe(start("table", { type: "datagrid", columns: [{ key: "value", label: "Password" }],
    rows: [{ value: "private-value" }] }));
  const table = ready(projection.observe(finish("table")));
  assert.ok(!JSON.stringify(decodeComponentPayload(table.payload, table.sha256)).includes("private-value"));
});

test("credential-field aliases are removed before both transport and reference retention", () => {
  const projection = new ComponentProjection(randomUUID()), canary = "CREDENTIAL_CANARY_SHOULD_NOT_LEAVE";
  projection.beginLive([owner]);
  const names = ["client_secret", "clientSecret", "client-secret", "Client Secret", "secret_key", "secretKey",
    "private_key", "dbPassword", "service_token", "clientSecretValue", "AWS_SECRET_ACCESS_KEY"];
  const specs: unknown[] = names.flatMap((name) => [
    { type: "datagrid", columns: [{ key: name, label: "Value" }], rows: [{ [name]: canary }] },
    { type: "datagrid", columns: [{ key: "value", label: name }], rows: [{ value: canary }] },
  ]);
  for (const label of ["API key (production)", "Private key [staging]", "access_token {temporary}",
    "Bearer token - production", "Authorization (required)", "Cookie [session]",
    "API key (production [EU])", "API key: production", "API key [production] (required)"]) {
    specs.push({ type: "datagrid", columns: [{ key: "value", label }], rows: [{ value: canary }] });
  }
  specs.push(
    { type: "datagrid", columns: [{ key: "value", label: "OAuth client secret (production)" }], rows: [{ value: canary }] },
    { type: "datagrid", columns: [{ key: "value", label: "Client secret", type: "link", hrefKey: "target" }],
      rows: [{ value: canary, target: `https://example.test/${canary}` }] },
    { ...chart, xAxisKey: "clientSecret", data: [{ clientSecret: canary, value: 3 }] },
    { type: "markdown", content: `https://example.test/?client_secret=${canary}` },
    { type: "markdown", content: `secret_key: ${canary}\nclientSecretValue=${canary}` },
    { type: "markdown", content: `https://example.test/?API%20key%20%28production%29=${canary}` },
    { type: "markdown", content: `API key (production)="${canary}"\nPrivate key [staging]: ${canary}` },
  );
  for (const content of [
    `Authorization (required)="${canary}"`,
    `auth="${canary}"`,
    `password="prefix ${canary} suffix"`,
    `secret_key='prefix ${canary} suffix'`,
    `clientSecret="escaped \\"prefix\\" ${canary}"`,
    `password='escaped ''prefix'' ${canary}'`,
    `password="prefix\n${canary}\nsuffix"`,
    `password="prefix ${canary}`,
    `secret_key='prefix ${canary}\\`,
    `Authorization: Basic prefix ${canary}`,
    `Authorization: Digest username="public", response="${canary}"`,
  ]) specs.push({ type: "markdown", content });
  for (const [index, spec] of specs.entries()) {
    const call = `credential-${index}`;
    projection.observe(start(call, spec));
    const record = ready(projection.observe(finish(call)));
    const decoded = decodeComponentPayload(record.payload, record.sha256);
    assert.ok(!JSON.stringify(decoded).includes(canary), `transport case ${index}`);
    assert.equal(record.redacted, true, `redaction marker ${index}`);
    const reference = projection.referenceContent({ componentId: record.componentId, sha256: record.sha256 });
    assert.ok(!reference.content.includes(canary), `reference case ${index}`);
    assert.deepEqual(JSON.parse(reference.content).spec, decoded);
  }
});

test("sensitive link columns with static or templated hrefs are unavailable before retention", () => {
  const projection = new ComponentProjection(randomUUID()), canary = "CREDENTIAL_LINK_CANARY";
  projection.beginLive([owner]);
  for (const [index, column] of [
    { key: "value", label: "API key", type: "link", href: `https://example.test/keys/${canary}` },
    { key: "value", label: "API key", type: "link", href: "https://example.test/{target}" },
    { key: "client_secret", label: "Value", type: "link", href: "https://example.test/{value}" },
  ].entries()) {
    const call = `sensitive-link-${index}`;
    projection.observe(start(call, { type: "datagrid", columns: [column],
      rows: [{ [column.key]: canary, ...(index === 1 ? { target: canary } : {}) }] }));
    const output = projection.observe(finish(call)), record = output.find((item) => item.kind === "component")?.data;
    assert.ok(record && record.status === "unavailable");
    assert.equal(record.error.code, "COMPONENT_INVALID");
    assert.ok(!JSON.stringify(output).includes(canary));
    assert.throws(() => projection.referenceContent({ componentId: record.componentId, sha256: "0".repeat(64) }),
      { code: "COMPONENT_REFERENCE_EXPIRED" });
  }
});

test("credential-bearing link templates cannot retain their otherwise ordinary source fields", async (t) => {
  const canary = "LINK_TEMPLATE_CREDENTIAL_CANARY";
  const cases = [
    { name: "value placeholder", href: "https://example.test/?client_secret={value}", fields: [],
      row: { id: canary } },
    { name: "named placeholder", href: "https://example.test/?client_secret={target}", fields: ["target"],
      row: { id: "View", target: canary } },
    { name: "dynamic query name", href: "https://example.test/?{parameter}={value}", fields: ["parameter"],
      row: { id: canary, parameter: "client_secret" } },
    { name: "dynamic signature name and value", href: "https://example.test/?{parameter}={target}",
      fields: ["parameter", "target"], row: { id: "View", parameter: "X-Amz-Signature", target: canary } },
    { name: "userinfo placeholders", href: "https://{account}:{access}@example.test/", fields: ["account", "access"],
      row: { id: "View", account: "fixture", access: canary } },
    { name: "oversized resolved target", href: "https://example.test/?{parameter}={value}", fields: ["parameter"],
      row: { id: canary.repeat(80), parameter: "client_secret" } },
    { name: "incomplete template", href: "https://example.test/{missing}?{parameter}={value}", fields: ["parameter"],
      row: { id: canary, parameter: "client_secret" } },
    { name: "malformed template value", href: "https://example.test/?{parameter}={value}", fields: ["parameter"],
      row: { id: canary + "\ud800", parameter: "client_secret" } },
  ];
  for (const value of cases) await t.test(value.name, () => {
    const projection = new ComponentProjection(randomUUID());
    projection.beginLive([owner]);
    projection.observe(start("template", { type: "datagrid", columns: [
      { key: "id", label: "Record", type: "link", href: value.href },
      ...value.fields.map((key) => ({ key, label: key })),
    ], rows: [value.row] }));
    const output = projection.observe(finish("template")), record = output.find((item) => item.kind === "component")?.data;
    assert.ok(record && record.status === "unavailable");
    assert.equal(record.error.code, "COMPONENT_INVALID");
    assert.ok(!JSON.stringify(output).includes(canary));
    assert.throws(() => projection.referenceContent({ componentId: record.componentId, sha256: "0".repeat(64) }),
      { code: "COMPONENT_REFERENCE_EXPIRED" });
  });
});

test("unresolvable templates explicitly remain in the original client even for otherwise ordinary data", () => {
  const projection = new ComponentProjection(randomUUID());
  projection.beginLive([owner]);
  projection.observe(start("incomplete-template", { type: "datagrid",
    columns: [{ key: "name", label: "Name", type: "link", href: "https://example.test/{missing}" }],
    rows: [{ name: "Ordinary data" }] }));
  const record = projection.observe(finish("incomplete-template")).find((item) => item.kind === "component")?.data;
  assert.ok(record && record.status === "unavailable");
  assert.equal(record.error.code, "COMPONENT_INVALID");
});

test("ordinary static and templated link columns keep their complete transport and reference content", () => {
  const projection = new ComponentProjection(randomUUID());
  projection.beginLive([owner]);
  for (const [index, href] of ["https://example.test/docs", "https://example.test/{target}",
    "https://example.test/?{parameter}={target}"].entries()) {
    const call = `public-link-${index}`, spec = { type: "datagrid",
      columns: [{ key: "name", label: "Documentation", type: "link", href }],
      rows: [{ name: "Guide", ...(index > 0 ? { target: "public-guide" } : {}),
        ...(index === 2 ? { parameter: "id" } : {}) }] };
    projection.observe(start(call, spec));
    const record = ready(projection.observe(finish(call)));
    assert.equal(record.redacted, false);
    assert.deepEqual(decodeComponentPayload(record.payload, record.sha256), spec);
    assert.deepEqual(JSON.parse(projection.referenceContent(record).content).spec, spec);
  }
});

test("ambiguous sensitive URL spans cannot expose credential suffixes in transport or references", () => {
  const canary = "QUOTED_URL_CREDENTIAL_CANARY";
  const names = ["client_secret", "clientSecret", "sig", "signature", "code", "X-Amz-Signature",
    "X-Goog-Credential", "X-Amz-Security-Token"];
  for (const [index, content] of names.flatMap((name) => [
    `https://example.test/?${name}=prefix'${canary}`,
    `https://example.test/?${name}=prefix"${canary}`,
    `https://example.test/?${name}='prefix ${canary}'`,
    `https://example.test/?${name}= 'prefix ${canary}'`,
    `https://example.test/?${name}=prefix<${canary}`,
  ]).concat(`https://fixture:prefix'${canary}@example.test/`).entries()) {
    for (const spec of [{ type: "markdown", content },
      { type: "datagrid", columns: [{ key: "value", label: "Value" }], rows: [{ value: content }] }]) {
      const projection = new ComponentProjection(randomUUID());
      projection.beginLive([owner]);
      const call = `quoted-url-${index}`;
      projection.observe(start(call, spec));
      const output = projection.observe(finish(call)), record = output.find((item) => item.kind === "component")?.data;
      if (record?.status === "ready") {
        assert.ok(!JSON.stringify(decodeComponentPayload(record.payload, record.sha256)).includes(canary), "No credential suffix in transport.");
        assert.ok(!projection.referenceContent(record).content.includes(canary), "No credential suffix in retained references.");
      }
      assert.ok(record && record.status === "unavailable");
      assert.equal(record.error.code, "COMPONENT_INVALID");
      assert.ok(!JSON.stringify(output).includes(canary));
      assert.throws(() => projection.referenceContent({ componentId: record.componentId, sha256: "0".repeat(64) }),
        { code: "COMPONENT_REFERENCE_EXPIRED" });
    }
  }
});

test("ordinary quoted URLs are preserved and encoded private URL values remain safely redacted", () => {
  const projection = new ComponentProjection(randomUUID());
  projection.beginLive([owner]);
  for (const [index, content] of ['See "https://example.test"', "https://example.test/?q=O'Reilly"].entries()) {
    projection.observe(start(`ordinary-url-${index}`, { type: "markdown", content }));
    const record = ready(projection.observe(finish(`ordinary-url-${index}`)));
    assert.equal(record.redacted, false);
    assert.deepEqual(decodeComponentPayload(record.payload, record.sha256), { type: "markdown", content });
  }
  projection.observe(start("encoded-private-url", { type: "markdown",
    content: "https://example.test/?sig=prefix%27ENCODED_URL_CANARY" }));
  const record = ready(projection.observe(finish("encoded-private-url")));
  assert.equal(record.redacted, true);
  assert.ok(!JSON.stringify(decodeComponentPayload(record.payload, record.sha256)).includes("ENCODED_URL_CANARY"));
  assert.ok(!projection.referenceContent(record).content.includes("ENCODED_URL_CANARY"));
});

test("all renderer-accepted HTTP spellings are inspected before transport and reference retention", () => {
  const canary = "NORMALIZED_URL_CREDENTIAL_CANARY";
  for (const prefix of ["https:", "https:/", "http:", "http:/", "ht\u0000tps://", "ht\u001b[31mtps://"]) {
    const url = `${prefix}example.test/?sig=${canary}`;
    for (const spec of [
      { type: "markdown", content: url },
      { type: "datagrid", columns: [{ key: "url", label: "Link", type: "link" }], rows: [{ url }] },
      { type: "datagrid", columns: [{ key: "name", label: "Link", type: "link", hrefKey: "url" }],
        rows: [{ name: "View", url }] },
      { type: "datagrid", columns: [{ key: "name", label: "Link", type: "link", href: url }], rows: [{ name: "View" }] },
    ]) {
      const projection = new ComponentProjection(randomUUID());
      projection.beginLive([owner]);
      projection.observe(start("normalized-url", spec));
      const record = projection.observe(finish("normalized-url")).find((item) => item.kind === "component")?.data;
      assert.ok(record);
      if (record.status === "ready") {
        assert.ok(!JSON.stringify(decodeComponentPayload(record.payload, record.sha256)).includes(canary));
        assert.ok(!projection.referenceContent(record).content.includes(canary));
        assert.equal(record.redacted, true);
      } else {
        assert.equal(record.error.code, "COMPONENT_INVALID");
        assert.throws(() => projection.referenceContent({ componentId: record.componentId, sha256: "0".repeat(64) }),
          { code: "COMPONENT_REFERENCE_EXPIRED" });
      }
    }
  }
});

test("Markdown destinations and text cannot conceal credentials through entity or escape decoding", async (t) => {
  const canary = "MARKDOWN_ESCAPE_CREDENTIAL_CANARY";
  const target = `https://example.test/?id=1&amp;sig=${canary}`;
  const cases: [string, string][] = [
    ["named entity", `[Download](${target})`],
    ["decimal entity", `[Download](https://example.test/?id=1&#38;sig=${canary})`],
    ["hex entity", `[Download](https://example.test/?id=1&#x26;sig=${canary})`],
    ["encoded scheme", `[Download](&#104;ttps://example.test/?sig=${canary})`],
    ["escaped delimiter", `[Download](https://example.test/?sig\\=${canary})`],
    ["reference", `[Download][item]\n\n[item]: ${target}`],
    ["unused reference", `[item]: ${target}\n\nPublic text.`],
    ["image", `![Not loaded](${target})`],
    ["visible link text", `[${target}](https://example.test/public)`],
    ["title", `[Download](https://example.test/public "${target}")`],
  ];
  for (const [name, content] of cases) await t.test(name, () => {
    const projection = new ComponentProjection(randomUUID());
    projection.beginLive([owner]);
    projection.observe(start("escaped-markdown", { type: "markdown", content }));
    const output = projection.observe(finish("escaped-markdown")), record = output.find((item) => item.kind === "component")?.data;
    assert.ok(record);
    if (record.status === "ready") {
      assert.ok(!JSON.stringify(decodeComponentPayload(record.payload, record.sha256)).includes(canary), "No escaped credential in transport.");
      assert.ok(!projection.referenceContent(record).content.includes(canary), "No escaped credential in retained source.");
    }
    assert.equal(record.status, "unavailable");
    assert.ok(!JSON.stringify(output).includes(canary));
  });
});

test("ordinary Markdown escapes and noncredential URL spellings keep their original source", () => {
  const projection = new ComponentProjection(randomUUID());
  projection.beginLive([owner]);
  const contents = [
    "Tom &amp; Jerry\n\n[Next](https://example.test/?id=1&amp;page=2)",
    "[Search](https://example.test/?q=a%26sig%3Db)",
    "https:example.test/?page=2",
    "[Too long to navigate](https://example.test/" + "\u754c".repeat(30_000) + ")",
  ];
  for (const [index, content] of contents.entries()) {
    const call = `ordinary-escape-${index}`;
    projection.observe(start(call, { type: "markdown", content }));
    const record = ready(projection.observe(finish(call)));
    assert.equal(record.redacted, false);
    assert.deepEqual(decodeComponentPayload(record.payload, record.sha256), { type: "markdown", content });
    assert.deepEqual(JSON.parse(projection.referenceContent(record).content).spec, { type: "markdown", content });
  }
});

test("redaction expansion still fails the final component byte limit instead of truncating content", () => {
  const spec = { type: "markdown", content: "token=x;".repeat(20_000) };
  assert.ok(Buffer.byteLength(JSON.stringify(spec)) < 256 * 1024);
  const projection = new ComponentProjection(randomUUID());
  projection.beginLive([owner]);
  projection.observe(start("expanded-redaction", spec));
  const record = projection.observe(finish("expanded-redaction")).find((item) => item.kind === "component")?.data;
  assert.ok(record && record.status === "unavailable");
  assert.equal(record.error.code, "COMPONENT_INVALID");
  assert.throws(() => projection.referenceContent({ componentId: record.componentId, sha256: "0".repeat(64) }),
    { code: "COMPONENT_REFERENCE_EXPIRED" });
});

test("ordinary token counts, public keys and similarly named fields retain their values", () => {
  const projection = new ComponentProjection(randomUUID());
  projection.beginLive([owner]);
  const spec = { type: "datagrid", columns: [
    { key: "secretary", label: "Secretary (team)" }, { key: "tokenCount", label: "Token count (daily)", type: "number" },
    { key: "publicKey", label: "Public key [public]" },
  ], rows: [{ secretary: "Alice", tokenCount: 23, publicKey: "public-value" }] };
  projection.observe(start("public-data", spec));
  const record = ready(projection.observe(finish("public-data")));
  assert.equal(record.redacted, false);
  assert.deepEqual(decodeComponentPayload(record.payload, record.sha256), spec);
});

test("payload checks reject mismatched hashes, malformed encoding and UTF-8 BOMs", () => {
  const bytes = Buffer.from(JSON.stringify(markdown)), payload = bytes.toString("base64");
  assert.deepEqual(decodeComponentPayload(payload, hash(bytes)), markdown);
  assert.throws(() => decodeComponentPayload(payload, "0".repeat(64)));
  assert.throws(() => decodeComponentPayload(payload + "\n", hash(bytes)));
  const invalid = Buffer.from([0xff]);
  assert.throws(() => decodeComponentPayload(invalid.toString("base64"), hash(invalid)));
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
  assert.throws(() => decodeComponentPayload(bom.toString("base64"), hash(bom)));
});

test("references bind to the session and immutable card bytes and survive desktop clear", () => {
  const projection = new ComponentProjection("session-A");
  projection.beginLive([owner]);
  projection.observe(start("same-call", markdown));
  const record = ready(projection.observe(finish("same-call")));
  const reference = { componentId: record.componentId, sha256: record.sha256 };
  projection.observe(event("tool.execution_start", { toolCallId: "clear", toolName: "invoke_canvas_action",
    arguments: { instanceId: owner.instanceId, actionName: "clear_canvas" } }));
  const attached = JSON.parse(projection.referenceContent(reference).content);
  assert.equal(attached.componentId, reference.componentId);
  assert.deepEqual(attached.spec, markdown);
  assert.throws(() => projection.referenceContent({ ...reference, sha256: "0".repeat(64) }),
    { code: "COMPONENT_REFERENCE_MISMATCH" });
  assert.throws(() => new ComponentProjection("session-B").referenceContent(reference),
    { code: "COMPONENT_REFERENCE_EXPIRED" });
  projection.observe(start("same-call", markdown));
  assert.equal(ready(projection.observe(finish("same-call"))).componentId, record.componentId);
});

test("the runtime emits replayed and live cards after tool completion without exporting hidden messages", async (t) => {
  let listener: (value: unknown) => void = () => {};
  const history = [
    event("session.canvas.recorded", owner),
    event("assistant.message", { messageId: "private-owner", originatingMessageId: "user-A",
      phase: "analysis", content: "PRIVATE_REASONING", toolRequests: [{ toolCallId: "historical" }] }),
    start("historical", markdown), finish("historical"),
  ];
  const emitted: UserEvent[] = [];
  const runtime = new CopilotRuntime({
    sessionId: randomUUID(), openCanvases: [owner], getEvents: async () => history,
    on: (handler) => { listener = handler; return () => {}; }, rpc: {},
  }, (value) => emitted.push(value));
  t.after(() => runtime.close());
  await runtime.connect();
  const historical = ready(emitted);
  assert.equal(historical.originatingMessageId, "user-A");
  assert.deepEqual(decodeComponentPayload(historical.payload, historical.sha256), markdown);
  assert.ok(!JSON.stringify(emitted).includes("PRIVATE_REASONING"));
  listener(start("live", chart));
  assert.equal(emitted.filter((item) => item.kind === "component").length, 1);
  listener(finish("live"));
  assert.equal(emitted.filter((item) => item.kind === "component").length, 2);
  const completeIndex = emitted.findIndex((item) => item.kind === "tool.output" && item.data.toolCallId === "live");
  const cardIndex = emitted.findIndex((item) => item.kind === "component" && item.data.toolCallId === "live");
  assert.ok(cardIndex > completeIndex);
});

test("an unavailable optional canvas snapshot cannot disable ordinary runtime messaging", async (t) => {
  let sent = "";
  const peer: JoinedSession = {
    sessionId: randomUUID(), get openCanvases() { throw new Error("PRIVATE_SDK_ERROR"); },
    getEvents: async () => [], on: () => () => {},
    send: async ({ prompt }) => { sent = prompt; return "accepted-message"; },
    rpc: { metadata: { activity: async () => ({ hasActiveWork: false, abortable: false }) } },
  };
  const runtime = new CopilotRuntime(peer, () => {});
  t.after(() => runtime.close());
  const summary = await runtime.connect();
  assert.equal(summary.capabilities.messages, true);
  assert.ok(summary.warnings.some((warning) => /Canvas identity.*failed/.test(warning)));
  assert.ok(!JSON.stringify(summary).includes("PRIVATE_SDK_ERROR"));
  await runtime.execute({ type: "message", text: "Ordinary conversation", attachmentIds: [] });
  assert.equal(sent, "Ordinary conversation");
});
