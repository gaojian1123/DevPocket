import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { CopilotRuntime, type JoinedSession } from "../src/runtime.js";
import { Action, PendingRequest, SessionSummary, UserEvent } from "../src/protocol.js";
import { hash, isSensitiveFieldName, redact } from "../src/security.js";
import { gitFixture } from "./git-fixture.js";

export function runtimePeer(root: string, version: string | null = "1.0.90-0") {
  let listener: (event: unknown) => void = () => {};
  let pending = true;
  const id = randomUUID();
  const at = new Date().toISOString();
  const event = (type: string, data: object) => ({ id: randomUUID(), timestamp: at, type, data });
  const requests = [{ requestId: "approval-1", request: { kind: "commands", toolName: "powershell",
    fullCommandText: "Write-Output 'harmless'", intention: "Read test output" } }];
  const session: JoinedSession = {
    sessionId: id,
    getEvents: async () => [
      event("session.start", { sessionId: id, ...(version === null ? {} : { copilotVersion: version }), context: { cwd: root } }),
      event("user.message", { messageId: "original-user", content: "In the original client before attachment", source: "system" }),
      event("system.message", { content: "NEVER_EXPORT" }),
      event("model.messages_snapshot", { messages: [{ role: "system", content: "NEVER_EXPORT" }] }),
      event("assistant.reasoning_delta", { deltaContent: "PRIVATE_REASONING" }),
      event("assistant.message", { messageId: "original-answer", content: "Original answer", reasoningText: "NEVER_EXPORT" }),
    ],
    on: (fn) => { listener = fn; return () => { listener = () => {}; }; },
    send: async (options) => {
      assert.equal(options.mode, "enqueue");
      assert.equal(options.source, "user");
      return "runtime-user-id";
    },
    abort: async () => {},
    rpc: {
      permissions: {
        getMode: async () => ({ mode: "manual" }),
        pendingRequests: async () => ({ items: pending ? requests : [] }),
        handlePendingPermissionRequest: async () => { const success = pending; pending = false; return { success }; },
        paths: { list: async () => ({ primary: root, directories: [root] }) },
      },
      metadata: { activity: async () => ({ hasActiveWork: false, abortable: false }) },
      name: { get: async () => ({ name: "Original runtime" }) },
      model: {
        getCurrent: async () => ({ modelId: "test-model", reasoningEffort: "high" }),
        list: async () => ({ list: [{ id: "test-model", name: "Test", supportedReasoningEfforts: ["low", "high"] }] }),
        switchTo: async () => ({ modelId: "test-model" }),
      },
      contentExclusion: { checkPaths: async ({ paths }) => ({ available: true, checks: paths.map((p) => ({ path: p, excluded: false })) }) },
      ui: { handlePendingUserInput: async () => ({ success: true }) },
    },
  };
  return { session, emit: (type: string, data: object) => listener(event(type, data)) };
}

const allCapabilities: SessionSummary["capabilities"] = {
  messages: true, abort: true, permissions: true, questions: true, models: true, files: true, git: true,
};
const capabilityActions: [keyof SessionSummary["capabilities"], Action][] = [
  ["messages", { type: "message", text: "Unavailable control", attachmentIds: [] }],
  ["abort", { type: "abort" }],
  ["permissions", { type: "permission", requestId: "approval-1", decision: "approve-once" }],
  ["questions", { type: "answer", requestId: "question", answer: "Yes" }],
  ["models", { type: "models" }],
  ["models", { type: "model.set", modelId: "test-model" }],
  ["files", { type: "files.list", path: "" }],
  ["files", { type: "files.read", path: "file.txt" }],
  ["git", { type: "git.status" }],
  ["git", { type: "git.diff", path: "file.txt", staged: false }],
];

async function capabilityFixture(t: TestContext, version: string | null = "1.0.90-0") {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/capabilities-"));
  const peer = runtimePeer(root, version), events: UserEvent[] = [];
  const runtime = new CopilotRuntime(peer.session, (event) => events.push(event));
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { ...peer, runtime, events, root };
}

test("runtime attachment exports earlier visible history without system prompts or reasoning internals", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/runtime-"));
  const peer = runtimePeer(root), events: UserEvent[] = [];
  const runtime = new CopilotRuntime(peer.session, (event) => events.push(event));
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  const summary = await runtime.connect();
  assert.equal(summary.sessionId, peer.session.sessionId);
  assert.equal(summary.title, "Original runtime");
  assert.equal(summary.permissionMode, "manual");
  assert.equal(summary.state, "waiting");
  const text = JSON.stringify(events);
  assert.ok(text.includes("In the original client before attachment"));
  assert.ok(text.includes("Original answer"));
  assert.ok(!text.includes("NEVER_EXPORT"));
  assert.ok(!text.includes("PRIVATE_REASONING"));
  const receipt = await runtime.execute({ type: "message", text: "Phone continuation", attachmentIds: [] });
  assert.equal(receipt.status, "admitted");
  assert.equal(receipt.result?.messageId, "runtime-user-id");
});

test("shared runtime labels name GitHub Copilot without assuming a CLI client", async (t) => {
  const f = await capabilityFixture(t);
  delete f.session.rpc.name;
  const summary = await f.runtime.connect();
  assert.equal(summary.title, "GitHub Copilot");
  assert.equal(summary.sessionId, f.session.sessionId);
  assert.equal(summary.cliVersion, "1.0.90-0");
  assert.ok(summary.warnings.some((warning) => warning === "Session name is unavailable; use the original client."));

  f.emit("user_input.requested", { requestId: "question", question: "Continue?", choices: ["Yes", "No"] });
  const question = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "question");
  assert.equal(question?.title, "GitHub Copilot needs your answer");
  assert.equal(question?.supported, true);
  f.emit("exit_plan_mode.requested", { requestId: "plan" });
  const plan = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "plan");
  assert.equal(plan?.type, "terminal");
  assert.equal(plan?.supported, false);
  assert.match(plan?.detail ?? "", /original client/);
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "plan", answer: "Yes" }), {
    code: "TERMINAL_REQUIRED", message: "This request must be answered in the original client.",
  });

  f.session.rpc.name = { get: async () => ({ name: "User-defined session name" }) };
  assert.equal((await f.runtime.refresh()).title, "User-defined session name");
});

test("original-client truncation notices fit within projection text budgets", () => {
  assert.equal(redact("Short text", 80), "Short text");
  for (const limit of [80, 160, 500, 2000, 12_000, 64_000]) {
    const projected = redact("x".repeat(limit + 1), limit);
    assert.equal(projected.length, limit);
    assert.ok(projected.endsWith("\n[truncated; see original client]"));
  }
});

test("shared credential names cover structured aliases and assigned text without masking ordinary metrics", () => {
  const canary = "CREDENTIAL_CANARY_SHOULD_NOT_LEAVE";
  for (const name of ["client_secret", "clientSecret", "secret_key", "secretKey", "clientSecretValue",
    "AWS_SECRET_ACCESS_KEY", "private.key", "signing-key", "dbPassword", "service_token", "API Key", "auth", "authorization"]) {
    assert.equal(isSensitiveFieldName(name), true, name);
    assert.ok(!redact(`${name}="${canary}"`).includes(canary), name);
  }
  assert.equal(isSensitiveFieldName("OAuth client secret (production)"), true);
  for (const name of ["API key (production)", "Private key [staging]", "access_token {temporary}",
    "API key (production [EU])", "API key [production] (required)", "Bearer token - production",
    "Authorization (required)", "Cookie [session]", "API key: production"]) {
    assert.equal(isSensitiveFieldName(name), true, name);
  }
  for (const name of ["API key (production)", "Private key [staging]", "access_token {temporary}"]) {
    assert.ok(!redact(`${name}="${canary}"`).includes(canary), name);
  }
  for (const name of ["apiKey", "private_key", "access_token", "signing.key", "authorization"]) {
    for (const qualifier of [" (production)", " [required]", " {temporary}", ": production",
      " - production", " \u2013 staging", " \u2014 current"]) {
      assert.equal(isSensitiveFieldName(name + qualifier), true, name + qualifier);
    }
  }
  assert.ok(!redact(`API key (production) [region] (service) [current]="${canary}"`).includes(canary));
  const annotatedText = "secret" + "(note)".repeat(1000) + " without an assignment";
  assert.equal(redact(annotatedText), annotatedText);
  assert.equal(redact(`Authorization (required)="${canary}"`), 'Authorization (required)="[REDACTED]"');
  assert.equal(redact(`password="prefix ${canary}" public text`), 'password="[REDACTED]" public text');
  assert.equal(redact(`secret_key='escaped ''quote'' ${canary}'`), "secret_key='[REDACTED]'");
  assert.equal(redact(`password="prefix ${canary}`), 'password="[REDACTED]');
  assert.equal(redact(`password=prefix ${canary}\npublic=value`), "password=[REDACTED]\npublic=value");
  assert.equal(redact(`token=${canary}; public=value`), "token=[REDACTED]; public=value");
  assert.equal(redact(`Authorization: Basic prefix ${canary}\npublic=value`), "Authorization: [REDACTED]\npublic=value");
  assert.equal(redact("OAuth=public-value"), "OAuth=public-value");
  for (const name of ["secretary", "tokenCount", "publicKey", "authenticationRequests"]) {
    assert.equal(isSensitiveFieldName(name), false, name);
    assert.equal(redact(`${name}=public-value`), `${name}=public-value`);
    assert.equal(isSensitiveFieldName(`${name} (production)`), false, name);
  }
});

test("credential assignments with long whitespace cannot stall ordinary prose projection", async () => {
  const source = new URL("../src/security.ts", import.meta.url).href;
  await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    const { redact } = await import(${JSON.stringify(source)});
    for (const value of ["secret" + " ".repeat(128 * 1024) + "ordinary prose",
      "API key - " + " ".repeat(128 * 1024) + "ordinary prose",
      "secret - ".repeat(20_000) + "ordinary prose"]) {
      const started = performance.now();
      assert.equal(redact(value, 256 * 1024), value);
      assert.ok(performance.now() - started < 1000, "Credential matching must not rescan whitespace or qualifier tails.");
    }
  `], { timeout: 5000 });
});

test("shared redaction consumes base64url bodies, dash-qualified values and complete cookie lines", () => {
  for (const prefix of ["dph", "dpd", "dpp"]) {
    for (const body of ["-" + "A".repeat(42), "A".repeat(20) + "-" + "B".repeat(22), "C".repeat(42) + "-"]) {
      assert.equal(redact(`${prefix}_${body}`), "[REDACTED]");
    }
  }
  const canary = "SHARED_REDACTOR_CREDENTIAL_CANARY";
  for (const dash of ["-", "\u2013", "\u2014"]) {
    const name = `API key ${dash} production`;
    assert.equal(isSensitiveFieldName(name), true);
    const result = redact(`${name} = first; remaining=${canary}\npublic=value`);
    assert.equal(result, `${name} = [REDACTED]\npublic=value`);
    assert.equal(redact(result), result);
  }
  assert.equal(redact(`Cookie: first=one; csrf=${canary}\npublic=value`), "Cookie: [REDACTED]\npublic=value");
  assert.equal(redact(`Set-Cookie: "first"; csrf=${canary}\npublic=value`), "Set-Cookie: [REDACTED]\npublic=value");
  for (const ordinary of ["API key - production without assignment", "tokenCount - daily = 23",
    "OAuth - enabled = true", "publicKey - production = public"]) assert.equal(redact(ordinary), ordinary);
  const longName = "API key - " + "region ".repeat(15_000);
  assert.ok(!redact(`${longName}= ${canary}`, 256 * 1024).includes(canary));
});

test("linked worktrees share project identity without changing the original runtime or working directory", async (t) => {
  const f = await gitFixture(t);
  const roots = [f.root, f.worktree], peers = roots.map((root) => runtimePeer(root));
  const runtimes = peers.map((peer) => new CopilotRuntime(peer.session, () => {}));
  t.after(() => { for (const runtime of runtimes) runtime.close(); });
  const [main, linked] = await Promise.all(runtimes.map((runtime) => runtime.connect()));
  assert.equal(main!.projectId, linked!.projectId);
  assert.equal(main!.projectName, "project");
  assert.equal(linked!.projectName, "project");
  assert.deepEqual(main!.workspace, { name: "project", branch: "main" });
  assert.deepEqual(linked!.workspace, { name: "task-worktree", branch: "feature/worktree-grouping" });
  for (const [index, runtime] of runtimes.entries()) {
    assert.equal(runtime.summary.sessionId, peers[index]!.session.sessionId);
    assert.equal(runtime.workingDirectory, roots[index]);
    const read = await runtime.execute({ type: "files.read", path: "note.txt" });
    assert.deepEqual(read.result?.file, {
      path: "note.txt", name: "note.txt", mime: "text/plain", size: index ? 15 : 13,
      encoding: "utf8", content: index ? "Linked checkout" : "Main checkout",
    });
  }
});

test("refresh receipts omit unavailable workspace metadata without changing runtime capabilities", async (t) => {
  const f = await capabilityFixture(t);
  delete f.session.rpc.contentExclusion;
  const initial = await f.runtime.connect();
  const receipt = await f.runtime.execute({ type: "refresh" });
  assert.equal(receipt.status, "completed");
  const summary = SessionSummary.parse(receipt.result?.summary);
  assert.equal(Object.hasOwn(summary, "workspace"), false);
  assert.equal(Object.hasOwn(f.runtime.summary, "workspace"), false);
  assert.equal(summary.sessionId, initial.sessionId);
  assert.equal(summary.projectId, initial.projectId);
  assert.deepEqual(summary.capabilities, { ...allCapabilities, files: false, git: false });
  assert.deepEqual(receipt.result?.requests, f.events.filter((event) => event.kind === "requests").at(-1)?.data.items);
});

test("project metadata refresh follows the live branch and clears stale Git identity when policy is unavailable", async (t) => {
  const f = await gitFixture(t), peer = runtimePeer(f.worktree);
  const runtime = new CopilotRuntime(peer.session, () => {});
  t.after(() => runtime.close());
  const initial = await runtime.connect();
  await f.git(f.worktree, "checkout", "--detach");
  const detached = await runtime.refresh();
  assert.equal(detached.projectId, initial.projectId);
  assert.deepEqual(detached.workspace, { name: "task-worktree", branch: "" });

  const check = peer.session.rpc.contentExclusion!.checkPaths!;
  peer.session.rpc.contentExclusion!.checkPaths = async () => ({ available: false, checks: [] });
  const deniedReceipt = await runtime.execute({ type: "refresh" });
  assert.equal(deniedReceipt.status, "completed");
  const denied = SessionSummary.parse(deniedReceipt.result?.summary);
  assert.equal(Object.hasOwn(denied, "workspace"), false);
  assert.equal(denied.projectId, hash(process.platform === "win32" ? f.worktree.toLowerCase() : f.worktree));
  assert.equal(denied.projectName, "task-worktree");
  assert.equal(denied.capabilities.files, false);
  assert.equal(denied.capabilities.git, false);
  assert.equal(denied.sessionId, initial.sessionId);
  assert.equal(runtime.workingDirectory, f.worktree);
  assert.ok(denied.warnings.some((warning) => /File and Git views/.test(warning)));

  peer.session.rpc.contentExclusion!.checkPaths = check;
  const recoveredReceipt = await runtime.execute({ type: "refresh" });
  assert.equal(recoveredReceipt.status, "completed");
  const recovered = SessionSummary.parse(recoveredReceipt.result?.summary);
  assert.equal(recovered.projectId, initial.projectId);
  assert.deepEqual(recovered.workspace, detached.workspace);
  assert.equal(recovered.capabilities.files, true);
});

test("file actions do not wait for project discovery and late metadata cannot replace a newer working directory", async (t) => {
  const f = await gitFixture(t), peer = runtimePeer(f.worktree);
  const runtime = new CopilotRuntime(peer.session, () => {});
  let release = () => {}, started = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const probing = new Promise<void>((resolve) => { started = resolve; });
  t.after(() => { release(); runtime.close(); });
  await runtime.connect();
  const check = peer.session.rpc.contentExclusion!.checkPaths!;
  let calls = 0;
  peer.session.rpc.contentExclusion!.checkPaths = async (input) => {
    if (++calls === 2) { started(); await waiting; }
    return check(input);
  };
  const refreshing = runtime.refresh();
  await probing;
  peer.session.rpc.permissions!.paths!.list = async () => ({ primary: f.root });
  assert.equal((await runtime.execute({ type: "files.list", path: "" })).status, "completed");
  assert.equal(runtime.workingDirectory, f.root);
  release();
  await refreshing;
  assert.equal(runtime.summary.workspace, undefined);
  assert.equal(runtime.summary.projectId, hash(process.platform === "win32" ? f.root.toLowerCase() : f.root));
  assert.deepEqual((await runtime.refresh()).workspace, { name: "project", branch: "main" });
});

test("unchanged-directory file reads do not discard a concurrent branch refresh", async (t) => {
  const f = await gitFixture(t), peer = runtimePeer(f.worktree);
  const runtime = new CopilotRuntime(peer.session, () => {});
  let release = () => {}, started = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const probing = new Promise<void>((resolve) => { started = resolve; });
  t.after(() => { release(); runtime.close(); });
  const initial = await runtime.connect();
  await f.git(f.worktree, "branch", "-m", "feature/refreshed");
  const check = peer.session.rpc.contentExclusion!.checkPaths!;
  let calls = 0;
  peer.session.rpc.contentExclusion!.checkPaths = async (input) => {
    if (++calls === 2) { started(); await waiting; }
    return check(input);
  };
  const refreshing = runtime.refresh();
  await probing;
  assert.equal((await runtime.execute({ type: "files.list", path: "" })).status, "completed");
  release();
  const updated = await refreshing;
  assert.equal(updated.projectId, initial.projectId);
  assert.equal(updated.workspace?.branch, "feature/refreshed");
  assert.equal(updated.workspace?.name, "task-worktree");
});

test("file views use replaced policy owners and handlers even when their directory allowance is unchanged", async (t) => {
  const f = await gitFixture(t), peer = runtimePeer(f.worktree);
  const runtime = new CopilotRuntime(peer.session, () => {});
  t.after(() => runtime.close());
  await runtime.connect();
  const allow = peer.session.rpc.contentExclusion!.checkPaths!;
  peer.session.rpc.contentExclusion = {
    checkPaths: async ({ paths }) => ({
      available: true, checks: paths.map((file) => ({ path: file, excluded: path.basename(file) === "note.txt" })),
    }),
  };
  await assert.rejects(runtime.execute({ type: "files.read", path: "note.txt" }), { code: "CONTENT_EXCLUDED" });
  peer.session.rpc.contentExclusion.checkPaths = allow;
  assert.equal((await runtime.execute({ type: "files.read", path: "note.txt" })).status, "completed");
});

test("closing during directory discovery prevents a later Git metadata probe", async (t) => {
  const f = await capabilityFixture(t);
  let started = () => {}, release = () => {}, checks = 0;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  f.session.rpc.permissions!.paths!.list = async () => { started(); await pending; return { primary: f.root }; };
  const check = f.session.rpc.contentExclusion!.checkPaths!;
  f.session.rpc.contentExclusion!.checkPaths = (input) => { checks++; return check(input); };
  const connecting = f.runtime.connect();
  await reading;
  f.runtime.close();
  release();
  assert.equal((await connecting).workspace, undefined);
  assert.equal(checks, 1);
});

test("permission races, unknown forms and strict question choices never produce false approval success", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/approvals-"));
  const peer = runtimePeer(root), events: UserEvent[] = [];
  const runtime = new CopilotRuntime(peer.session, (event) => events.push(event));
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.connect();
  const permission = await runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" });
  assert.equal(permission.status, "completed");
  await assert.rejects(runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "REQUEST_STALE" });
  peer.emit("user_input.requested", { requestId: "question-1", question: "Choose a branch?", choices: ["Keep", "Stop"], allowFreeform: false });
  await assert.rejects(runtime.execute({ type: "answer", requestId: "question-1", answer: "Do everything" }), { code: "INVALID_CHOICE" });
  peer.emit("user_input.completed", { requestId: "question-1", answer: "Keep" });
  await assert.rejects(runtime.execute({ type: "answer", requestId: "question-1", answer: "Stop" }), { code: "REQUEST_STALE" });
  peer.emit("elicitation.requested", { requestId: "complex-1", requestedSchema: { anything: true } });
  const requests = events.filter((event) => event.kind === "requests").at(-1);
  assert.equal(requests?.data.items[0]?.type, "terminal");
  assert.equal(requests?.data.items[0]?.supported, false);
  const stop = await runtime.execute({ type: "abort" });
  assert.equal(stop.status, "cancel_requested");
  assert.equal(stop.result?.stopped, false);
  assert.equal(events.at(-1)?.kind, "runtime.state");
  assert.ok(!events.some((event) => event.kind === "runtime.state" && event.data.state === "idle"));
  peer.emit("session.idle", { aborted: true });
  assert.equal(events.at(-1)?.kind === "runtime.state" && events.at(-1)?.data.state, "idle");
});

test("a previously recorded question is not revived as pending after first attachment without a live question snapshot", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/questions-"));
  const peer = runtimePeer(root), events: UserEvent[] = [];
  const history = peer.session.getEvents;
  peer.session.getEvents = async () => [...await history(), {
    id: randomUUID(), timestamp: new Date().toISOString(), type: "user_input.requested",
    data: { requestId: "old-question", question: "Answered before attachment", choices: ["Yes", "No"] },
  }];
  const runtime = new CopilotRuntime(peer.session, (event) => events.push(event));
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.connect();
  assert.ok(!events.some((event) => event.kind === "requests" && event.data.items.some((item) => item.requestId === "old-question")));
});

test("simple native elicitation questions survive permission refresh and resolve with the exact schema field", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/elicitation-"));
  const peer = runtimePeer(root), events: UserEvent[] = [];
  let answer: unknown;
  peer.session.rpc.ui = {
    handlePendingElicitation: async (input) => { answer = input; return { success: true }; },
  };
  const runtime = new CopilotRuntime(peer.session, (event) => events.push(event));
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.connect();
  peer.emit("elicitation.requested", {
    requestId: "form-1", message: "Choose one", mode: "form",
    requestedSchema: { type: "object", properties: { selection: { type: "string", enum: ["Alpha", "Beta"], title: "Choice" } }, required: ["selection"] },
  });

  await runtime.refresh();
  const event = events.filter((event) => event.kind === "requests").at(-1);
  const item = event?.data.items.find((item) => item.requestId === "form-1");
  assert.equal(item?.type, "question");
  assert.equal(item.supported, true);
  await assert.rejects(runtime.execute({ type: "answer", requestId: "form-1", answer: "Not an option" }), { code: "INVALID_CHOICE" });
  assert.equal((await runtime.execute({ type: "answer", requestId: "form-1", answer: "Alpha" })).status, "completed");
  assert.deepEqual(answer, { requestId: "form-1", result: { action: "accept", content: { selection: "Alpha" } } });
});

test("question refresh remains JSON-safe when optional model and workspace evidence is unavailable", async (t) => {
  const f = await capabilityFixture(t);
  delete f.session.rpc.model;
  delete f.session.rpc.contentExclusion;
  await f.runtime.connect();
  f.emit("user_input.requested", { requestId: "refresh-question", question: "Free text", choices: [], allowFreeform: true });
  const receipt = await f.runtime.execute({ type: "refresh" });
  assert.equal(receipt.status, "completed");
  const requests = PendingRequest.array().parse(receipt.result?.requests);
  assert.ok(requests.some((item) => item.requestId === "refresh-question" && item.supported));
  assert.equal(SessionSummary.parse(receipt.result?.summary).workspace, undefined);
  assert.doesNotThrow(() => JSON.stringify(receipt));
});

test("confirmed phone ask_user answers remain in visible history after the pending request disappears", async (t) => {
  const f = await capabilityFixture(t);
  const question = "这是一条 ask_user 测试：你正在从哪个客户端回答这个问题？请优先在手机上的 DevPocket 中选择。";
  const answer = "我正在手机上的 DevPocket 中回答";
  f.session.rpc.ui = { handlePendingElicitation: async () => ({ success: true }) };
  await f.runtime.connect();
  f.emit("elicitation.requested", {
    requestId: "phone-question", message: question, mode: "form",
    requestedSchema: { type: "object", properties: {
      selection: { type: "string", enum: [answer, "我只能在原来的 Copilot 客户端中回答"] },
    }, required: ["selection"] },
  });
  assert.ok(f.events.some((event) => event.kind === "requests" &&
    event.data.items.some((item) => item.requestId === "phone-question" && item.supported)));
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "phone-question", answer })).status, "completed");
  f.emit("elicitation.completed", { requestId: "phone-question" });
  await f.runtime.refresh();
  assert.ok(!f.events.filter((event) => event.kind === "requests").at(-1)?.data.items
    .some((item) => item.requestId === "phone-question"));
  const history = f.events.filter((event) => !["requests", "assistant.message", "assistant.delta"].includes(event.kind));
  assert.ok(history.some((event) => JSON.stringify(event.data).includes(question) &&
    "answer" in event.data && event.data.answer === answer),
  "The full question and runtime-confirmed answer must remain in chat history, without an assistant repeating them.");
  const completed = f.events.filter((event) => event.kind === "question" && event.data.status === "confirmed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.data.request.requestId, "phone-question");
  assert.ok(completed[0]?.data.request.detail.includes(question));
  assert.equal(completed[0]?.data.status, "confirmed");
});

test("choice and freeform answers retain only the safe question projection and exact confirmed value", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  for (const [requestId, choices, answer] of [
    ["choice-history", ["Alpha", "Beta"], "Beta"],
    ["freeform-history", [], "一段自由文本\nwith another line"],
  ] as const) {
    const commandId = randomUUID();
    f.emit("user_input.requested", {
      requestId, question: "Full visible question", choices: [...choices], allowFreeform: choices.length === 0,
      toolCallId: "PRIVATE_TOOL_CORRELATION",
    });
    await f.runtime.execute({ type: "answer", requestId, answer }, [], commandId);
    const history = f.events.filter((event) => event.kind === "question" && event.data.request.requestId === requestId);
    assert.deepEqual(history.map((event) => event.data.status), ["pending", "confirmed"]);
    const completed = history.at(-1)!;
    assert.equal(completed.data.status === "confirmed" && completed.data.answer, answer);
    assert.equal(completed.data.status === "confirmed" && completed.data.commandId, commandId);
    assert.equal(completed.data.request.detail, "Full visible question");
    assert.equal(history[0]?.data.questionId, completed.data.questionId);
    assert.ok(!JSON.stringify(history).includes("PRIVATE_TOOL_CORRELATION"));
    await assert.rejects(f.runtime.execute({ type: "answer", requestId, answer }), { code: "REQUEST_STALE" });
  }
});

test("completion or another client winning never confirms the phone's attempted answer", async (t) => {
  for (const outcome of ["other-client", "malformed", "accepted"] as const) {
    await t.test(outcome, async (t) => {
      const f = await capabilityFixture(t), commandId = randomUUID();
      f.session.rpc.ui = {
        handlePendingUserInput: async () => {
          f.emit("user_input.completed", { requestId: "race", answer: "PRIVATE_UNVALIDATED_COMPLETION_VALUE" });
          return outcome === "malformed" ? { accepted: true } : { success: outcome === "accepted" };
        },
      };
      await f.runtime.connect();
      f.emit("user_input.requested", { requestId: "race", question: "Which client?", choices: ["Phone", "Original"] });
      const submitted = f.runtime.execute({ type: "answer", requestId: "race", answer: "Phone" }, [], commandId);
      if (outcome === "other-client") await assert.rejects(submitted, { code: "REQUEST_STALE" });
      else if (outcome === "malformed") await assert.rejects(submitted, { name: "ZodError" });
      else assert.equal((await submitted).status, "completed");
      const history = f.events.filter((event) => event.kind === "question");
      assert.deepEqual(history.map((event) => event.data.status),
        outcome === "accepted" ? ["pending", "unknown", "confirmed"] : ["pending", "unknown"]);
      assert.ok(!JSON.stringify(history).includes("PRIVATE_UNVALIDATED_COMPLETION_VALUE"));
      assert.equal(new Set(history.map((event) => event.data.questionId)).size, 1);
      if (outcome !== "accepted") assert.ok(history.every((event) => !("answer" in event.data)));
    });
  }
});

test("a late confirmed answer stays attached to its question without removing a replacement request", async (t) => {
  const f = await capabilityFixture(t);
  f.session.rpc.ui = { handlePendingUserInput: async () => {
    f.emit("user_input.requested", { requestId: "reused", question: "Replacement question", choices: ["New"] });
    return { success: true };
  } };
  await f.runtime.connect();
  f.emit("user_input.requested", { requestId: "reused", question: "Original question", choices: ["Old"] });
  await f.runtime.execute({ type: "answer", requestId: "reused", answer: "Old" });
  const history = f.events.filter((event) => event.kind === "question");
  const confirmed = history.find((event) => event.data.status === "confirmed")!;
  assert.equal(confirmed.data.request.detail, "Original question");
  assert.equal(confirmed.data.status === "confirmed" && confirmed.data.answer, "Old");
  assert.notEqual(confirmed.data.questionId, history.filter((event) => event.data.status === "pending").at(-1)?.data.questionId);
  const pending = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items;
  assert.equal(pending?.find((item) => item.requestId === "reused")?.detail, "Replacement question");
});

test("a stale RPC result without a completion event closes history with an unknown answer", async (t) => {
  const f = await capabilityFixture(t);
  f.session.rpc.ui = { handlePendingUserInput: async () => ({ success: false }) };
  await f.runtime.connect();
  f.emit("user_input.requested", { requestId: "stale-history", question: "Choose", choices: ["One", "Two"] });
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "stale-history", answer: "One" }), { code: "REQUEST_STALE" });
  assert.equal(f.events.filter((event) => event.kind === "question").at(-1)?.data.status, "unknown");
  assert.ok(!f.events.filter((event) => event.kind === "requests").at(-1)?.data.items
    .some((item) => item.requestId === "stale-history"));
});

test("confirmed free text is redacted and unsupported question forms do not become history approvals", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  f.emit("user_input.requested", { requestId: "redacted-answer", question: "Your label?", allowFreeform: true });
  const secret = "ghp_" + "a".repeat(36);
  await f.runtime.execute({ type: "answer", requestId: "redacted-answer", answer: `label ${secret}` });
  f.emit("elicitation.requested", { requestId: "unsupported-history", requestedSchema: { anything: true } });
  const history = f.events.filter((event) => event.kind === "question");
  assert.ok(!JSON.stringify(history).includes(secret));
  assert.ok(JSON.stringify(history).includes("[REDACTED]"));
  assert.ok(history.every((event) => event.data.request.requestId !== "unsupported-history"));
});

test("a confirmed answer fully removed by redaction retains success and an explicit safe history marker", async (t) => {
  for (const [name, answer] of [["ANSI-only", "\u001b[31m"], ["controls with whitespace", " \n\t\u0000\u001b[31m "]]) {
    await t.test(name, async (t) => {
      const f = await capabilityFixture(t);
      let accepted: string | undefined;
      f.session.rpc.ui = { handlePendingUserInput: async ({ requestId, response }) => {
        accepted = response.answer;
        f.emit("user_input.completed", { requestId });
        return { success: true };
      } };
      await f.runtime.connect();
      f.emit("user_input.requested", { requestId: "control-answer", question: "Your label?", allowFreeform: true });
      const receipt = await f.runtime.execute({ type: "answer", requestId: "control-answer", answer }, [], randomUUID());
      assert.equal(accepted, answer, "History projection must not change the original runtime's submitted answer.");
      assert.equal(receipt.status, "completed");
      assert.equal(receipt.result?.resolved, true);
      const confirmed = f.events.filter((event) => event.kind === "question" && event.data.status === "confirmed");
      assert.equal(confirmed.length, 1);
      assert.equal(confirmed[0]?.data.status === "confirmed" && confirmed[0].data.answer, "[REDACTED]");
      assert.ok(!JSON.stringify(confirmed).includes("\\u001b"));
      assert.ok(!f.events.filter((event) => event.kind === "requests").at(-1)?.data.items
        .some((request) => request.requestId === "control-answer"));
    });
  }
});

test("a message observed in the runtime queue is reported queued rather than processing", async (t) => {
  await mkdir(".data/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".data/tests/queue-"));
  const peer = runtimePeer(root);
  peer.session.rpc.queue = { pendingItems: async () => ({ items: [{ kind: "message", messageId: "runtime-user-id" }] }) };
  const runtime = new CopilotRuntime(peer.session, () => {});
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.connect();
  assert.equal((await runtime.execute({ type: "message", text: "Wait behind the running tool", attachmentIds: [] })).status, "queued");
  const stop = await runtime.execute({ type: "abort" });
  assert.equal(stop.status, "cancel_requested");
  assert.deepEqual(stop.result?.cancelledMessageIds, ["runtime-user-id"]);
});

test("capability discovery is read-only and independent of the recorded runtime version", async (t) => {
  for (const version of ["1.0.90-0", "0.0.1", "99.0.0-preview", "custom-build", null]) {
    await t.test(version ?? "missing version", async (t) => {
      const f = await capabilityFixture(t, version), mutations: string[] = [];
      f.session.send = async () => { mutations.push("send"); return "original-runtime-message"; };
      f.session.abort = async () => { mutations.push("abort"); };
      f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { mutations.push("permission"); return { success: true }; };
      f.session.rpc.model!.switchTo = async () => { mutations.push("model"); return { modelId: "test-model" }; };
      f.session.rpc.ui = {
        handlePendingUserInput: async () => { mutations.push("question"); return { success: true }; },
        handlePendingElicitation: async () => { mutations.push("form"); return { success: true }; },
      };
      await f.runtime.connect();
      const summary = await f.runtime.refresh();
      assert.deepEqual(mutations, []);
      assert.equal(summary.sessionId, f.session.sessionId);
      assert.equal(summary.cliVersion, version ?? "unknown");
      assert.deepEqual(summary.capabilities, allCapabilities);
      assert.deepEqual(SessionSummary.parse(JSON.parse(JSON.stringify(summary))), summary);
      assert.ok(!summary.warnings.some((warning) => /unsupported.*version|unknown versions.*read-only/i.test(warning)));
      assert.equal((await f.runtime.execute({ type: "message", text: "Keep the original runtime", attachmentIds: [] })).status, "admitted");
      assert.deepEqual(mutations, ["send"]);
    });
  }
});

test("capabilities require their own validated evidence even for a historically accepted version", async (t) => {
  const cases: {
    name: string; change: (session: JoinedSession) => void; disabled: Partial<SessionSummary["capabilities"]>;
  }[] = [
    { name: "missing RPC tree", change: (s) => { Object.defineProperty(s, "rpc", { value: undefined }); },
      disabled: { messages: false, abort: false, permissions: false, questions: false, models: false, files: false, git: false } },
    { name: "missing send", change: (s) => { delete s.send; }, disabled: { messages: false } },
    { name: "missing abort", change: (s) => { delete s.abort; }, disabled: { abort: false } },
    { name: "unknown abortability", change: (s) => { s.rpc.metadata!.activity = async () => ({ hasActiveWork: false }); },
      disabled: { abort: false } },
    { name: "malformed activity", change: (s) => { s.rpc.metadata!.activity = async () => ({ hasActiveWork: "false", abortable: true }); },
      disabled: { messages: false, abort: false, questions: false } },
    { name: "missing live directory", change: (s) => { delete s.rpc.permissions!.paths; }, disabled: { files: false, git: false } },
    { name: "relative live directory", change: (s) => { s.rpc.permissions!.paths!.list = async () => ({ primary: "relative" }); },
      disabled: { files: false, git: false } },
    { name: "missing permission snapshot", change: (s) => { delete s.rpc.permissions!.pendingRequests; }, disabled: { permissions: false } },
    { name: "incomplete permission snapshot", change: (s) => { s.rpc.permissions!.pendingRequests = async () => ({ items: [{ requestId: "approval-1" }] }); },
      disabled: { permissions: false } },
    { name: "missing permission handler", change: (s) => { delete s.rpc.permissions!.handlePendingPermissionRequest; },
      disabled: { permissions: false } },
    { name: "noncallable permission handler", change: (s) => { Object.defineProperty(s.rpc.permissions, "handlePendingPermissionRequest", { value: true }); },
      disabled: { permissions: false } },
    { name: "missing question handlers", change: (s) => { delete s.rpc.ui; }, disabled: { questions: false } },
    { name: "unknown current model", change: (s) => { s.rpc.model!.getCurrent = async () => ({}); }, disabled: { models: false } },
    { name: "missing catalogue", change: (s) => { delete s.rpc.model!.list; }, disabled: { models: false } },
    { name: "empty catalogue", change: (s) => { s.rpc.model!.list = async () => ({ list: [] }); }, disabled: { models: false } },
    { name: "incomplete model entry", change: (s) => { s.rpc.model!.list = async () => ({ list: [{ name: "No identifier" }] }); },
      disabled: { models: false } },
    { name: "unknown reasoning shape", change: (s) => { s.rpc.model!.list = async () => ({ list: [{ id: "test-model", supportedReasoningEfforts: ["low", 1] }] }); },
      disabled: { models: false } },
    { name: "catalogue error", change: (s) => { s.rpc.model!.list = async () => { throw new Error("PRIVATE_RPC_DETAIL"); }; },
      disabled: { models: false } },
    { name: "missing model mutation", change: (s) => { delete s.rpc.model!.switchTo; }, disabled: { models: false } },
    { name: "unsupported display-only metadata", change: (s) => {
      s.rpc.name!.get = async () => ({ name: 123 });
      s.rpc.permissions!.getMode = async () => ({ mode: false });
    }, disabled: {} },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const f = await capabilityFixture(t);
      scenario.change(f.session);
      const summary = await f.runtime.connect();
      assert.deepEqual(summary.capabilities, { ...allCapabilities, ...scenario.disabled });
      assert.ok(summary.warnings.length > 2);
      assert.ok(!JSON.stringify(summary).includes("PRIVATE_RPC_DETAIL"));
      if (scenario.disabled.permissions === false) {
        const pending = f.events.filter((event) => event.kind === "requests").at(-1);
        assert.ok(pending?.data.items.every((item) => !item.supported));
      }
      for (const [capability, action] of capabilityActions) {
        if (scenario.disabled[capability] === false)
          await assert.rejects(f.runtime.execute(action), { code: "UNSUPPORTED" }, action.type);
      }
    });
  }
});

test("additive read-only probe metadata is tolerated but never exported", async (t) => {
  const f = await capabilityFixture(t, "future-build");
  const extra = { privateInternalField: "PRIVATE_API_METADATA" };
  f.session.rpc.metadata!.activity = async () => ({ hasActiveWork: false, abortable: false, ...extra });
  f.session.rpc.permissions!.paths!.list = async () => ({ primary: f.root, ...extra });
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [], ...extra });
  f.session.rpc.model!.getCurrent = async () => ({ modelId: "test-model", ...extra });
  f.session.rpc.model!.list = async () => ({ list: [{ id: "test-model", ...extra }], ...extra });
  const summary = await f.runtime.connect();
  assert.deepEqual(summary.capabilities, allCapabilities);
  const models = await f.runtime.execute({ type: "models" });
  assert.ok(!JSON.stringify({ summary, models, events: f.events }).includes("PRIVATE_API_METADATA"));
});

test("model reasoning catalogues preserve runtime choices across supported field dialects", async (t) => {
  const levels = ["low", "medium", "high", "xhigh", "max"];
  const dialects = [
    ["CLI capability", { capabilities: { supports: { reasoning_effort: levels, adaptive_thinking: "unsupported" } } }],
    ["SDK camel case", { supportedReasoningEfforts: levels }],
    ["legacy snake case", { supported_reasoning_efforts: levels }],
    ["legacy plural capability", { capabilities: { supports: { reasoning_efforts: levels } } }],
  ] as const;
  for (const [name, fields] of dialects) {
    await t.test(name, async (t) => {
      const f = await capabilityFixture(t, "unlisted-build");
      let mutations = 0;
      f.session.rpc.model!.list = async () => ({ list: [{ id: "test-model", ...fields }] });
      f.session.rpc.model!.switchTo = async (input) => {
        mutations++;
        assert.equal(input.reasoningEffort, "xhigh");
        return { modelId: input.modelId };
      };
      await f.runtime.connect();
      assert.deepEqual((await f.runtime.execute({ type: "models" })).result?.models, [{
        id: "test-model", name: "test-model", reasoningEfforts: levels, reasoningManual: false, enabled: true,
      }]);
      assert.equal(mutations, 0);
      await assert.rejects(f.runtime.execute({ type: "model.set", modelId: "test-model", reasoningEffort: "none" }),
        { code: "REASONING_UNSUPPORTED" });
      assert.equal(mutations, 0);
      assert.equal((await f.runtime.execute({ type: "model.set", modelId: "test-model", reasoningEffort: "xhigh" })).status, "completed");
      assert.equal(mutations, 1);
    });
  }
});

test("CLI reasoning choices stay model-specific without guessing a fixed vocabulary", async (t) => {
  const f = await capabilityFixture(t);
  f.session.rpc.model!.list = async () => ({ list: [
    { id: "test-model", capabilities: { supports: { reasoning_effort: ["low", "high"] } } },
    { id: "other-model", capabilities: { supports: { reasoning_effort: ["none", "provider-specific"] } } },
    { id: "missing-levels" },
    { id: "empty-levels", capabilities: { supports: { reasoning_effort: [] } } },
  ] });
  await f.runtime.connect();
  const models = await f.runtime.models();
  assert.deepEqual(models.map(({ id, reasoningEfforts, reasoningManual }) => ({ id, reasoningEfforts, reasoningManual })), [
    { id: "test-model", reasoningEfforts: ["low", "high"], reasoningManual: false },
    { id: "other-model", reasoningEfforts: ["none", "provider-specific"], reasoningManual: false },
    { id: "missing-levels", reasoningEfforts: [], reasoningManual: true },
    { id: "empty-levels", reasoningEfforts: [], reasoningManual: true },
  ]);
});

test("malformed CLI reasoning choices revoke model controls instead of enabling manual input", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  assert.equal(f.runtime.summary.capabilities.models, true);
  let mutations = 0;
  f.session.rpc.model!.switchTo = async () => { mutations++; return { modelId: "test-model" }; };
  for (const levels of [["low", 1], [""], ["x".repeat(61)], "high", { levels: ["high"] }]) {
    f.session.rpc.model!.list = async () => ({ list: [{
      id: "test-model", capabilities: { supports: { reasoning_effort: levels } },
    }] });
    await assert.rejects(f.runtime.models(), { code: "UNSUPPORTED" });
    assert.equal(f.runtime.summary.capabilities.models, false);
    assert.ok(f.runtime.summary.warnings.some((warning) => warning.startsWith("Model catalogue returned an unsupported response shape")));
    await assert.rejects(f.runtime.execute({ type: "model.set", modelId: "test-model", reasoningEffort: "high" }),
      { code: "UNSUPPORTED" });
  }
  assert.equal(mutations, 0);
  f.session.rpc.model!.list = async () => ({ list: [{
    id: "test-model", capabilities: { supports: { reasoning_effort: ["high"] } },
  }] });
  assert.deepEqual((await f.runtime.models())[0]?.reasoningEfforts, ["high"]);
  assert.equal(f.runtime.summary.capabilities.models, true);
});

test("missing messaging does not block independently supported runtime operations", async (t) => {
  const f = await capabilityFixture(t, "unlisted-build");
  delete f.session.send;
  await f.runtime.connect();
  await assert.rejects(f.runtime.execute({ type: "message", text: "Unavailable", attachmentIds: [] }), { code: "UNSUPPORTED" });
  assert.equal((await f.runtime.execute({ type: "models" })).status, "completed");
  assert.equal((await f.runtime.execute({ type: "model.set", modelId: "test-model", reasoningEffort: "low" })).status, "completed");
  assert.equal((await f.runtime.execute({ type: "files.list", path: "" })).status, "completed");
  assert.equal((await f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "reject" })).status, "completed");
  f.emit("user_input.requested", { requestId: "question", question: "Continue?", choices: ["Yes", "No"], allowFreeform: false });
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "question", answer: "No" })).status, "completed");
  assert.equal((await f.runtime.execute({ type: "abort" })).status, "cancel_requested");
  f.session.rpc.metadata!.activity = async () => undefined;
  assert.equal((await f.runtime.refresh()).state, "cancel_requested");
});

test("file capability needs an explicit complete allow decision for the live directory", async (t) => {
  const cases: [string, (root: string) => unknown][] = [
    ["unavailable", (root) => ({ available: false, checks: [{ path: root, excluded: false }] })],
    ["missing checks", () => ({ available: true })],
    ["empty checks", () => ({ available: true, checks: [] })],
    ["mismatched path", (root) => ({ available: true, checks: [{ path: path.join(root, "other"), excluded: false }] })],
    ["incomplete check", (root) => ({ available: true, checks: [{ path: root }] })],
    ["nonboolean decision", (root) => ({ available: true, checks: [{ path: root, excluded: "false" }] })],
    ["duplicate checks", (root) => ({ available: true, checks: [{ path: root, excluded: false }, { path: root, excluded: false }] })],
    ["excluded directory", (root) => ({ available: true, checks: [{ path: root, excluded: true }] })],
  ];
  for (const [name, response] of cases) {
    await t.test(name, async (t) => {
      const f = await capabilityFixture(t);
      f.session.rpc.contentExclusion!.checkPaths = async () => response(f.root);
      const summary = await f.runtime.connect();
      assert.deepEqual(summary.capabilities, { ...allCapabilities, files: false, git: false });
      await assert.rejects(f.runtime.execute({ type: "files.list", path: "" }), { code: "UNSUPPORTED" });
      await assert.rejects(f.runtime.execute({ type: "git.status" }), { code: "UNSUPPORTED" });
    });
  }
});

test("execution refreshes stale grants and request projections recover without stale warnings", async (t) => {
  const f = await capabilityFixture(t), permissions = f.session.rpc.permissions!, activity = f.session.rpc.metadata!;
  const pending = permissions.pendingRequests, active = activity.activity;
  let decisions = 0;
  permissions.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  await f.runtime.connect();
  f.emit("user_input.requested", { requestId: "live-question", question: "Choose", choices: ["One", "Two"] });
  permissions.pendingRequests = async () => ({ items: "unknown" });
  activity.activity = async () => { throw new Error("PRIVATE_RUNTIME_ERROR"); };
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "UNSUPPORTED" });
  assert.equal(decisions, 0);
  const result = await f.runtime.execute({ type: "refresh" });
  assert.ok(PendingRequest.array().parse(result.result?.requests).every((item) => !item.supported));
  assert.ok(!JSON.stringify(f.runtime.summary).includes("PRIVATE_RUNTIME_ERROR"));
  assert.equal(f.runtime.summary.capabilities.models, true);
  assert.equal(f.runtime.summary.capabilities.files, true);
  permissions.pendingRequests = pending;
  activity.activity = active;
  const summary = await f.runtime.refresh();
  assert.deepEqual(summary.capabilities, allCapabilities);
  assert.ok(!summary.warnings.some((warning) => /probe failed|unsupported response shape/.test(warning)));
  assert.ok(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.every((item) => item.supported));
});

test("a stalled optional probe times out without granting support from its late response", async (t) => {
  const f = await capabilityFixture(t);
  let started!: () => void, finish!: (response: unknown) => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const response = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.model!.list = () => { started(); return response; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const connecting = f.runtime.connect();
  await reading;
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5000);
  const summary = await connecting;
  assert.deepEqual(summary.capabilities, { ...allCapabilities, models: false });
  assert.ok(summary.warnings.some((warning) => warning === "Model catalogue probe timed out; use the original client."));
  finish({ list: [{ id: "test-model" }] });
  await Promise.resolve();
  assert.equal(f.runtime.summary.capabilities.models, false);
  const recovered = await f.runtime.refresh();
  assert.equal(recovered.capabilities.models, true);
  assert.ok(!recovered.warnings.some((warning) => warning.includes("timed out")));
});

test("request controls require the matching handler, not another question dialect", async (t) => {
  const f = await capabilityFixture(t);
  f.session.rpc.ui = { handlePendingElicitation: async () => ({ success: true }) };
  await f.runtime.connect();
  assert.equal(f.runtime.summary.capabilities.questions, true);
  f.emit("user_input.requested", { requestId: "native", question: "Choose", choices: ["One", "Two"] });
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "native");
  assert.equal(request?.supported, false);
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "native", answer: "One" }), { code: "TERMINAL_REQUIRED" });
});

test("incomplete known permission and question forms cannot be approved on unfamiliar runtimes", async (t) => {
  const f = await capabilityFixture(t, "future-build");
  let decisions = 0;
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [
    { requestId: "incomplete", request: { kind: "commands", toolName: "powershell" } },
    { requestId: "unknown-flag", request: { kind: "commands", fullCommandText: "echo safe", requestSandboxBypass: "true" } },
  ] });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  f.session.rpc.ui = {
    handlePendingUserInput: async () => { decisions++; return { success: true }; },
    handlePendingElicitation: async () => { decisions++; return { success: true }; },
  };
  await f.runtime.connect();
  for (const requestId of ["incomplete", "unknown-flag"])
    await assert.rejects(f.runtime.execute({ type: "permission", requestId, decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
  const questions = [
    { requestId: "no-question", choices: ["Yes"] },
    { requestId: "bad-choices", question: "Choose", choices: "Yes" },
    { requestId: "bad-freeform", question: "Choose", choices: ["Yes"], allowFreeform: "false" },
    { requestId: "no-answer-form", question: "Choose", choices: [], allowFreeform: false },
  ];
  for (const question of questions) {
    f.emit("user_input.requested", question);
    await assert.rejects(f.runtime.execute({ type: "answer", requestId: question.requestId, answer: "Yes" }), { code: "TERMINAL_REQUIRED" });
  }
  const schemas = [
    { properties: { choice: { type: "string" } } },
    { type: "object", properties: { choice: { type: "string", enum: ["Yes", 1] } } },
    { type: "object", properties: { choice: { type: "string" } }, required: "choice" },
    { type: "object", properties: { choice: { type: "string", pattern: "^Yes$" } } },
    { type: "object", properties: { choice: { type: "string" }, other: { type: "string", format: "uri" } } },
  ];
  for (const [index, requestedSchema] of schemas.entries()) {
    const requestId = `form-${index}`;
    f.emit("elicitation.requested", { requestId, message: "Choose", requestedSchema });
    await assert.rejects(f.runtime.execute({ type: "answer", requestId, answer: "Yes" }), { code: "TERMINAL_REQUIRED" });
  }
  assert.equal(decisions, 0);
  assert.ok(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.every((item) => !item.supported));
});

test("simple elicitation forms enforce the actual primary and alternate string limits", async (t) => {
  const f = await capabilityFixture(t), answered: unknown[] = [];
  f.session.rpc.ui = { handlePendingElicitation: async (input) => { answered.push(input); return { success: true }; } };
  const invalidLength = { code: "INVALID_ANSWER", message: "The answer is outside this form's supported length range." };
  await f.runtime.connect();
  f.emit("elicitation.requested", { requestId: "short-form", message: "Enter a label", requestedSchema: {
    type: "object", properties: { label: { type: "string", minLength: 3, maxLength: 5 } }, required: ["label"],
  } });
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "short-form", answer: "a" }), invalidLength);
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "short-form", answer: "abcdef" }), invalidLength);
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "short-form", answer: "abc" })).status, "completed");
  f.emit("elicitation.requested", { requestId: "other-form", message: "Choose or write", requestedSchema: {
    type: "object", properties: {
      choice: { type: "string", enum: ["One", "Other"] },
      detail: { type: "string", minLength: 2, maxLength: 4 },
    }, required: ["choice"],
  } });
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "other-form", answer: "a" }), invalidLength);
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "other-form", answer: "too long" }), invalidLength);
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "other-form", answer: "Two" })).status, "completed");
  assert.deepEqual(answered, [
    { requestId: "short-form", result: { action: "accept", content: { label: "abc" } } },
    { requestId: "other-form", result: { action: "accept", content: { choice: "Other", detail: "Two" } } },
  ]);
});

test("unknown top-level question fields keep the request in the original client", async (t) => {
  const f = await capabilityFixture(t, "future-build");
  let answers = 0;
  f.session.rpc.ui = { handlePendingUserInput: async () => { answers++; return { success: true }; } };
  await f.runtime.connect();
  f.emit("user_input.requested", {
    requestId: "future-question", question: "Choose", choices: ["Yes", "No"], answerMode: "multiple",
  });
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "future-question");
  assert.equal(request?.type, "terminal");
  assert.equal(request.supported, false);
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "future-question", answer: "Yes" }), { code: "TERMINAL_REQUIRED" });
  assert.equal(answers, 0);
});

test("unknown top-level elicitation fields keep the form in the original client", async (t) => {
  const f = await capabilityFixture(t, "future-build");
  let answers = 0;
  f.session.rpc.ui = { handlePendingElicitation: async () => { answers++; return { success: true }; } };
  await f.runtime.connect();
  f.emit("elicitation.requested", {
    requestId: "future-form", message: "Choose", mode: "form", responsePolicy: { confirmationRequired: true },
    requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["Yes", "No"] } }, required: ["choice"] },
  });
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "future-form");
  assert.equal(request?.type, "terminal");
  assert.equal(request.supported, false);
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "future-form", answer: "Yes" }), { code: "TERMINAL_REQUIRED" });
  assert.equal(answers, 0);
});

test("supported question envelopes preserve their semantics without exporting correlation metadata", async (t) => {
  const f = await capabilityFixture(t), answers: unknown[] = [];
  f.session.rpc.ui = {
    handlePendingUserInput: async (input) => { answers.push(input); return { success: true }; },
    handlePendingElicitation: async (input) => { answers.push(input); return { success: true }; },
  };
  await f.runtime.connect();
  const requestedSchema = { type: "object", properties: { label: { type: "string", description: "A short label" } }, required: ["label"] };
  const formDefinition = `Form definition (defaults are informational):\n${JSON.stringify(requestedSchema, null, 2)}`;
  const requests = [
    { type: "user_input.requested", data: {
      requestId: "choice", question: "Choose", choices: ["Yes", "No"], allowFreeform: false, toolCallId: "PRIVATE_CORRELATION",
    }, detail: "Choose", answer: "Yes" },
    { type: "user_input.requested", data: {
      requestId: "freeform", question: "Enter a label", toolCallId: "PRIVATE_CORRELATION",
    }, detail: "Enter a label", answer: "Test" },
    { type: "elicitation.requested", data: {
      requestId: "form", message: "Enter a label", mode: "form", requestedSchema,
      toolCallId: "PRIVATE_CORRELATION", elicitationSource: "Example MCP",
    }, detail: `Source: Example MCP\nEnter a label\n${formDefinition}`, answer: "Test" },
    { type: "elicitation.requested", data: {
      requestId: "legacy-form", message: "Enter a label", requestedSchema,
    }, detail: `Enter a label\n${formDefinition}`, answer: "Legacy" },
  ];
  for (const request of requests) {
    f.emit(request.type, request.data);
    const item = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === request.data.requestId);
    assert.equal(item?.supported, true);
    assert.equal(item.detail, request.detail);
    assert.equal((await f.runtime.execute({ type: "answer", requestId: request.data.requestId, answer: request.answer })).status, "completed");
  }
  assert.deepEqual(answers, [
    { requestId: "choice", response: { answer: "Yes", wasFreeform: false } },
    { requestId: "freeform", response: { answer: "Test", wasFreeform: true } },
    { requestId: "form", result: { action: "accept", content: { label: "Test" } } },
    { requestId: "legacy-form", result: { action: "accept", content: { label: "Legacy" } } },
  ]);
  assert.ok(!JSON.stringify(f.events).includes("PRIVATE_CORRELATION"));
  UserEvent.array().parse(f.events);
});

test("question envelopes reject malformed metadata and unsupported response modes", async (t) => {
  const f = await capabilityFixture(t);
  let answers = 0;
  f.session.rpc.ui = {
    handlePendingUserInput: async () => { answers++; return { success: true }; },
    handlePendingElicitation: async () => { answers++; return { success: true }; },
  };
  await f.runtime.connect();
  const invalidMetadata = [
    { toolCallId: 42 }, { toolCallId: "" }, { toolCallId: "x".repeat(201) },
    { correlation: { toolCallId: "PRIVATE_CORRELATION" } },
    { responsePolicy: { mode: "PRIVATE_UNKNOWN_MODE" } },
  ];
  for (const type of ["user_input.requested", "elicitation.requested"]) {
    const envelope = type === "user_input.requested" ? { question: "Choose", choices: ["Yes", "No"] } : {
      message: "Choose", requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["Yes", "No"] } } },
    };
    const invalid: object[] = type === "user_input.requested" ? invalidMetadata : [
      ...invalidMetadata, { elicitationSource: 42 }, { elicitationSource: "" },
      { mode: "url", url: "https://example.test" }, { mode: "new-form" }, { mode: "form", url: "https://example.test" },
    ];
    for (const [index, extra] of invalid.entries()) {
      const requestId = `${type}-${index}`;
      f.emit(type, { ...envelope, requestId, ...extra });
      const item = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === requestId);
      assert.equal(item?.type, "terminal");
      assert.equal(item.supported, false);
      await assert.rejects(f.runtime.execute({ type: "answer", requestId, answer: "Yes" }), { code: "TERMINAL_REQUIRED" });
    }
  }
  assert.equal(answers, 0);
  assert.ok(!JSON.stringify(f.events).includes("PRIVATE_"));
  UserEvent.array().parse(f.events);
});

test("question envelopes with invalid request identities never enter projected pending state", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  for (const type of ["user_input.requested", "elicitation.requested"]) {
    const envelope = type === "user_input.requested" ? { question: "Choose", choices: ["Yes", "No"] } : {
      message: "Choose", requestedSchema: { type: "object", properties: { choice: { type: "string" } } },
    };
    for (const requestId of [undefined, null, "", 42, "x".repeat(201)]) {
      const before = f.events.length;
      f.emit(type, { ...envelope, ...(requestId !== undefined ? { requestId } : {}) });
      assert.deepEqual(f.events.slice(before).map((event) => event.kind), ["notice"]);
      const notice = f.events.at(-1);
      assert.equal(notice?.kind === "notice" && notice.data.code, "EVENT_UNSUPPORTED");
    }
  }
  const refresh = await f.runtime.execute({ type: "refresh" });
  const requests = PendingRequest.array().parse(refresh.result?.requests);
  assert.ok(requests.every((request) => request.type === "permission"));
  UserEvent.array().parse(f.events);
});

test("unsupported replacement envelopes revoke cached form routing", async (t) => {
  const f = await capabilityFixture(t), answers: unknown[] = [];
  f.session.rpc.ui = {
    handlePendingUserInput: async (input) => { answers.push(input); return { success: true }; },
    handlePendingElicitation: async (input) => { answers.push(input); return { success: true }; },
  };
  await f.runtime.connect();
  const form = {
    requestId: "reused", message: "Choose",
    requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["Yes", "No"] } } },
  };
  f.emit("elicitation.requested", form);
  f.emit("elicitation.requested", { ...form, responsePolicy: { confirmationRequired: true } });
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "reused", answer: "Yes" }), { code: "TERMINAL_REQUIRED" });
  assert.deepEqual(answers, []);
  f.emit("user_input.requested", { requestId: "reused", question: "Choose", choices: ["Yes", "No"] });
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "reused", answer: "Yes" })).status, "completed");
  assert.deepEqual(answers, [{ requestId: "reused", response: { answer: "Yes", wasFreeform: false } }]);
});

test("malformed optional queue evidence cannot claim that a message is queued or cancelled", async (t) => {
  const f = await capabilityFixture(t);
  f.session.rpc.queue = { pendingItems: async () => ({ items: [{ messageId: "runtime-user-id" }, { messageId: 42 }] }) };
  await f.runtime.connect();
  assert.equal((await f.runtime.execute({ type: "message", text: "Do not infer queue state", attachmentIds: [] })).status, "admitted");
  const stop = await f.runtime.execute({ type: "abort" });
  assert.equal(stop.status, "cancel_requested");
  assert.deepEqual(stop.result?.cancelledMessageIds, []);
});

test("unknown semantic fields in a known permission form require the original client", async (t) => {
  const f = await capabilityFixture(t, "future-build");
  let decisions = 0;
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [{
    requestId: "future-permission",
    request: { kind: "commands", fullCommandText: "echo harmless", executionScope: "all-sessions" },
  }] });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  await f.runtime.connect();
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items[0];
  assert.equal(request?.supported, false);
  await assert.rejects(f.runtime.execute({
    type: "permission", requestId: "future-permission", decision: "approve-once",
  }), { code: "TERMINAL_REQUIRED" });
  assert.equal(decisions, 0);
});

test("sending does not wait for an unrelated stalled model catalogue", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  let finish!: (value: unknown) => void;
  const catalogue = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.model!.list = () => catalogue;
  let completed = false;
  const command = f.runtime.execute({ type: "message", text: "Continue without model discovery", attachmentIds: [] })
    .then((receipt) => { completed = true; return receipt; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const completedBeforeCatalogue = completed;
  finish({ list: [{ id: "test-model" }] });
  assert.equal((await command).status, "admitted");
  assert.equal(completedBeforeCatalogue, true, "Sending must not wait for an unrelated capability probe.");
});

test("supported permission dialects expose every semantic field and reject unknown ones", async (t) => {
  const forms = [
    {
      kind: "shell", fullCommandText: "echo harmless", intention: "Display output", canOfferSessionApproval: true,
      commands: [{ identifier: "echo", readOnly: true }], commandSegments: [{ identifier: "echo", fullCommandText: "echo harmless" }],
      hasWriteFileRedirection: false, possiblePaths: ["example.txt"], possibleUrls: [{ url: "https://example.test" }],
      resolvedPaths: { "example.txt": "PRIVATE_CANONICAL_PATH" }, resolvedWorkingDirectory: "PRIVATE_CANONICAL_DIRECTORY",
    },
    {
      kind: "commands", fullCommandText: "echo harmless", commandIdentifiers: ["echo"],
      canOfferSessionApproval: false, warning: "Review the command", managedApprovalRequired: true,
    },
    { kind: "read", path: "example.txt", intention: "Read a file", resolvedPath: "PRIVATE_CANONICAL_PATH" },
    { kind: "write", fileName: "example.txt", diff: "-old\n+new", newFileContents: "new", canOfferSessionApproval: false },
    { kind: "url", url: "https://example.test/final", redirectedFrom: "https://example.test/start", intention: "Read a page" },
    {
      kind: "mcp", serverName: "example", toolName: "lookup", toolTitle: "Look up an item", readOnly: true,
      canOfferServerWideApproval: false, args: { query: "example", nested: { executionScope: "visible tool argument" } },
    },
    { kind: "custom-tool", toolName: "example", toolDescription: "A custom tool", skipPermission: false, args: { mode: "preview" } },
    { kind: "shell", args: { command: "echo legacy" } },
    { kind: "read", arguments: { path: "example.txt" } },
    { kind: "write", args: { path: "example.txt" }, newFileContents: "new" },
    { kind: "url", arguments: { url: "https://example.test" } },
    { kind: "mcp", mcpServerName: "example", toolName: "lookup", arguments: { query: "example" } },
    { kind: "custom-tool", toolName: "example", arguments: { mode: "preview" } },
  ];
  for (const [index, form] of forms.entries()) {
    await t.test(`${form.kind}-${index}`, async (t) => {
      const f = await capabilityFixture(t, "future-build"), requestId = `known-${index}`;
      const request = { ...form, toolCallId: "PRIVATE_CORRELATION_ID" };
      let current: Record<string, unknown> = request;
      let decisions = 0;
      f.session.rpc.permissions!.pendingRequests = async () => ({
        items: [{ requestId, request: current, recoveryEpisodeId: "PRIVATE_RECOVERY_ID" }],
      });
      f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
      await f.runtime.connect();
      const item = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === requestId);
      assert.equal(item?.supported, true);
      const visible = Object.fromEntries(Object.entries(request).filter(([key]) =>
        !["toolCallId", "resolvedPath", "resolvedPaths", "resolvedWorkingDirectory"].includes(key)));
      assert.deepEqual(JSON.parse(item.detail), visible);
      assert.ok(!JSON.stringify(item).includes("PRIVATE_"));
      assert.equal((await f.runtime.execute({ type: "permission", requestId, decision: "reject" })).status, "completed");
      assert.equal(decisions, 1);

      current = { ...request, executionScope: "all-sessions" };
      await f.runtime.refresh();
      f.emit("permission.requested", { requestId: `live-${index}`, permissionRequest: current });
      const projected = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items;
      assert.ok(projected?.every((item) => item.type === "terminal" && !item.supported));
      assert.ok(!JSON.stringify(projected).includes("all-sessions"));
      await assert.rejects(f.runtime.execute({ type: "permission", requestId, decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
      assert.equal(decisions, 1);
    });
  }
});

test("permission schemas reject malformed or unknown nested semantic fields", async (t) => {
  const requests = [
    { kind: "shell", fullCommandText: "echo safe", commands: [{ identifier: "echo", readOnly: true, elevated: true }] },
    { kind: "shell", fullCommandText: "echo safe", commandSegments: [{ identifier: "echo", fullCommandText: "echo safe", elevated: true }] },
    { kind: "shell", fullCommandText: "echo safe", possibleUrls: [{ url: "https://example.test", trustRedirects: true }] },
    { kind: "shell", args: { command: "echo safe", runAs: "administrator" } },
    { kind: "read", args: { path: "example.txt", recursive: true } },
    { kind: "write", args: { path: "example.txt", recursive: true }, diff: "+new" },
    { kind: "url", args: { url: "https://example.test", trustRedirects: true } },
    { kind: "mcp", serverName: "example", toolName: "lookup", args: {}, readOnly: "true" },
    { kind: "custom-tool", toolName: "lookup", args: {}, skipPermission: "true" },
    { kind: "commands", fullCommandText: "echo safe", commandIdentifiers: [42] },
    { kind: "read", path: "example.txt", resolvedPath: { unknownIdentity: true } },
    { kind: "commands", fullCommandText: "echo safe", assistedApproval: { approval: "skip-confirmation" } },
    { kind: "shell", fullCommandText: "echo safe", requestSandboxBypass: true },
    { kind: "commands", fullCommandText: "echo safe", requestSandboxPermissive: true },
    { kind: "write", path: "example.txt", diff: "[REDACTED]" },
  ];
  const f = await capabilityFixture(t);
  let decisions = 0;
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: requests.map((request, index) => ({ requestId: `invalid-${index}`, request })) });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  await f.runtime.connect();
  for (const index of requests.keys())
    await assert.rejects(f.runtime.execute({ type: "permission", requestId: `invalid-${index}`, decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
  assert.equal(decisions, 0);
  assert.ok(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.every((item) => !item.supported));
});

test("model switch confirmation does not reuse a current-model probe started before the switch", async (t) => {
  const f = await capabilityFixture(t), rpc = f.session.rpc.model!;
  let current = { modelId: "old-model", reasoningEffort: "low" };
  rpc.list = async () => ({ list: ["old-model", "new-model"].map((id) => ({
    id, supportedReasoningEfforts: ["low", "high"],
  })) });
  rpc.getCurrent = async () => ({ ...current });
  await f.runtime.connect();
  let switchStarted!: () => void, finishSwitch!: () => void;
  const switching = new Promise<void>((resolve) => { switchStarted = resolve; });
  const switched = new Promise<void>((resolve) => { finishSwitch = resolve; });
  rpc.switchTo = async () => {
    switchStarted();
    await switched;
    current = { modelId: "new-model", reasoningEffort: "high" };
    return { modelId: current.modelId };
  };
  const command = f.runtime.execute({ type: "model.set", modelId: "new-model", reasoningEffort: "high" });
  await switching;
  let probeStarted!: () => void, finishProbe!: () => void;
  const probing = new Promise<void>((resolve) => { probeStarted = resolve; });
  const probed = new Promise<void>((resolve) => { finishProbe = resolve; });
  rpc.getCurrent = async () => {
    const snapshot = { ...current };
    probeStarted();
    await probed;
    return snapshot;
  };
  const refresh = f.runtime.refresh();
  await probing;
  finishSwitch();
  await new Promise<void>((resolve) => setImmediate(resolve));
  finishProbe();
  await refresh;
  assert.equal((await command).status, "completed");
  assert.equal(f.runtime.summary.modelId, current.modelId);
  assert.equal(f.runtime.summary.reasoningEffort, current.reasoningEffort);
});

test("deferred model switches keep the active model until a live read confirms the change", async (t) => {
  const f = await capabilityFixture(t), rpc = f.session.rpc.model!;
  let current = { modelId: "old-model", reasoningEffort: "low" };
  rpc.getCurrent = async () => ({ ...current });
  rpc.list = async () => ({ list: ["old-model", "new-model"].map((id) => ({ id })) });
  rpc.switchTo = async () => ({ modelId: "new-model", deferred: true, message: "Queued" });
  await f.runtime.connect();
  const receipt = await f.runtime.execute({ type: "model.set", modelId: "new-model", reasoningEffort: "high" });
  assert.equal(receipt.result?.deferred, true);
  assert.equal(f.runtime.summary.modelId, "old-model");
  assert.equal(f.runtime.summary.reasoningEffort, "low");
  assert.ok(f.events.some((event) => event.kind === "notice" && event.data.code === "MODEL_SWITCH_DEFERRED"));
  current = { modelId: "new-model", reasoningEffort: "high" };
  await f.runtime.models();
  assert.equal(f.runtime.summary.modelId, current.modelId);
  assert.equal(f.runtime.summary.reasoningEffort, current.reasoningEffort);
});

test("live activity observations survive model-only and older activity refreshes", async (t) => {
  for (const wasActive of [false, true]) {
    await t.test(wasActive ? "live idle" : "live turn start", async (t) => {
      const f = await capabilityFixture(t);
      const snapshot = { hasActiveWork: wasActive, abortable: wasActive };
      f.session.rpc.permissions!.pendingRequests = async () => ({ items: [] });
      f.session.rpc.metadata!.activity = async () => snapshot;
      await f.runtime.connect();
      let release!: (value: unknown) => void, started!: () => void;
      const pending = new Promise<unknown>((resolve) => { release = resolve; });
      const reading = new Promise<void>((resolve) => { started = resolve; });
      f.session.rpc.metadata!.activity = () => { started(); return pending; };
      const refresh = f.runtime.refresh();
      await reading;
      f.emit(wasActive ? "session.idle" : "assistant.turn_start", {});
      release(snapshot);
      await refresh;
      const expected = wasActive ? "idle" : "running";
      assert.equal(f.runtime.summary.state, expected);
      await f.runtime.execute({ type: "models" });
      assert.equal(f.runtime.summary.state, expected);
      f.session.rpc.metadata!.activity = async () => snapshot;
      await f.runtime.refresh();
      assert.equal(f.runtime.summary.state, wasActive ? "running" : "idle", "A newer activity probe can reconcile the live observation.");
    });
  }
});

test("live activity state never invents missing runtime control capabilities", async (t) => {
  const f = await capabilityFixture(t);
  delete f.session.rpc.metadata;
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [] });
  await f.runtime.connect();
  f.emit("assistant.turn_start", {});
  await f.runtime.models();
  assert.equal(f.runtime.summary.state, "running");
  assert.equal(f.runtime.summary.capabilities.messages, false);
  assert.equal(f.runtime.summary.capabilities.abort, false);
  assert.equal(f.runtime.summary.capabilities.questions, false);
  await assert.rejects(f.runtime.execute({ type: "abort" }), { code: "UNSUPPORTED" });
  await f.runtime.refresh();
  assert.equal(f.runtime.summary.state, "running", "A missing activity RPC cannot erase a known live state.");
  assert.equal(f.runtime.summary.capabilities.messages, false);
  assert.equal(f.runtime.summary.capabilities.abort, false);
  assert.equal(f.runtime.summary.capabilities.questions, false);
});

test("live turn starts do not clear cancellation requested before runtime idle", async (t) => {
  const f = await capabilityFixture(t);
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [] });
  await f.runtime.connect();
  await f.runtime.execute({ type: "abort" });
  f.emit("assistant.turn_start", {});
  assert.equal(f.runtime.summary.state, "cancel_requested");
  assert.equal(f.events.at(-1)?.kind === "runtime.state" && f.events.at(-1)?.data.state, "cancel_requested");
  f.emit("session.idle", { aborted: true });
  assert.equal(f.runtime.summary.state, "idle");
});

test("failed activity probes retain known lifecycle state without retaining control grants", async (t) => {
  for (const state of ["running", "idle"] as const) {
    for (const failure of ["unavailable", "rejected", "malformed", "timeout"]) {
      await t.test(`${state}: ${failure}`, async (t) => {
        const f = await capabilityFixture(t), metadata = f.session.rpc.metadata!;
        delete f.session.rpc.permissions!.paths;
        f.session.rpc.permissions!.pendingRequests = async () => ({ items: [] });
        await f.runtime.connect();
        f.emit(state === "running" ? "assistant.turn_start" : "session.idle", {});
        let release: ((value: unknown) => void) | undefined;
        let reading = false;
        if (failure === "unavailable") delete metadata.activity;
        else if (failure === "rejected") metadata.activity = async () => { throw new Error("TEST_ACTIVITY_UNAVAILABLE"); };
        else if (failure === "malformed") metadata.activity = async () => ({ hasActiveWork: "unknown" });
        else {
          t.mock.timers.enable({ apis: ["setTimeout"] });
          metadata.activity = () => {
            reading = true;
            return new Promise<unknown>((resolve) => { release = resolve; });
          };
        }
        const refreshing = f.runtime.refresh();
        if (failure === "timeout") {
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.ok(reading);
          t.mock.timers.tick(5000);
        }
        const summary = await refreshing;
        assert.equal(summary.state, state);
        assert.equal(summary.capabilities.messages, false);
        assert.equal(summary.capabilities.abort, false);
        assert.equal(summary.capabilities.questions, false);
        assert.ok(summary.warnings.some((warning) => warning.startsWith("Runtime activity")));
        release?.({ hasActiveWork: state !== "running", abortable: true });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(f.runtime.summary.state, state, "An expired probe's late response is not new evidence.");
        assert.equal(f.runtime.summary.capabilities.abort, false);
        metadata.activity = async () => ({ hasActiveWork: state !== "running", abortable: true });
        const recovered = await f.runtime.refresh();
        assert.equal(recovered.state, state === "running" ? "idle" : "running");
        assert.equal(recovered.capabilities.messages, true);
        assert.equal(recovered.capabilities.abort, true);
        assert.equal(recovered.capabilities.questions, true);
      });
    }
  }
});

test("each command refreshes only its prerequisite evidence", async (t) => {
  const cases: { action: Action; reads: string[]; error?: string }[] = [
    { action: { type: "message", text: "Only activity", attachmentIds: [] }, reads: ["activity", "queue"] },
    { action: { type: "abort" }, reads: ["activity", "queue"] },
    { action: { type: "permission", requestId: "approval-1", decision: "reject" }, reads: ["permissions"] },
    { action: { type: "answer", requestId: "question", answer: "Yes" }, reads: ["activity"] },
    { action: { type: "models" }, reads: ["current-model", "catalogue"] },
    { action: { type: "model.set", modelId: "test-model" }, reads: ["current-model", "catalogue", "current-model", "catalogue"] },
    { action: { type: "files.list", path: "" }, reads: ["directory", "policy", "policy"] },
    { action: { type: "files.read", path: "..\\outside.txt" }, reads: ["directory", "policy"], error: "INVALID_PATH" },
    { action: { type: "git.status" }, reads: ["directory", "policy", "policy"] },
    { action: { type: "git.diff", path: "..\\outside.txt", staged: false }, reads: ["directory", "policy"], error: "INVALID_PATH" },
  ];
  for (const scenario of cases) {
    await t.test(scenario.action.type, async (t) => {
      const f = await capabilityFixture(t);
      await f.runtime.connect();
      f.emit("user_input.requested", { requestId: "question", question: "Continue?", choices: ["Yes", "No"] });
      const reads: string[] = [], rpc = f.session.rpc;
      const tracked = (name: string, read: () => Promise<unknown>) => async () => { reads.push(name); return await read(); };
      rpc.metadata!.activity = tracked("activity", rpc.metadata!.activity!);
      rpc.permissions!.pendingRequests = tracked("permissions", rpc.permissions!.pendingRequests!);
      rpc.permissions!.getMode = tracked("permission-mode", rpc.permissions!.getMode!);
      rpc.permissions!.paths!.list = tracked("directory", rpc.permissions!.paths!.list!);
      rpc.model!.getCurrent = tracked("current-model", rpc.model!.getCurrent!);
      rpc.model!.list = tracked("catalogue", rpc.model!.list!);
      rpc.name!.get = tracked("name", rpc.name!.get!);
      rpc.queue = { pendingItems: tracked("queue", async () => ({ items: [] })) };
      const policy = rpc.contentExclusion!.checkPaths!;
      rpc.contentExclusion!.checkPaths = async (input) => { reads.push("policy"); return await policy(input); };
      if (scenario.error) await assert.rejects(f.runtime.execute(scenario.action), { code: scenario.error });
      else await f.runtime.execute(scenario.action);
      assert.deepEqual(reads, scenario.reads);
    });
  }
});

test("messages and answers do not wait for unrelated probes in an ongoing full refresh", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  f.emit("user_input.requested", { requestId: "question", question: "Continue?", choices: ["Yes", "No"] });
  const rpc = f.session.rpc;
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  const block = (read: () => Promise<unknown>) => async () => { await stalled; return await read(); };
  rpc.model!.list = block(rpc.model!.list!);
  rpc.permissions!.pendingRequests = block(rpc.permissions!.pendingRequests!);
  rpc.name!.get = block(rpc.name!.get!);
  const policy = rpc.contentExclusion!.checkPaths!;
  rpc.contentExclusion!.checkPaths = async (input) => { await stalled; return await policy(input); };
  const refresh = f.runtime.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  let completed = 0;
  const commands = Promise.all([
    f.runtime.execute({ type: "message", text: "No unrelated waits", attachmentIds: [] }),
    f.runtime.execute({ type: "answer", requestId: "question", answer: "Yes" }),
  ].map((command) => command.then((receipt) => { completed++; return receipt; })));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const completedBeforeRelease = completed;
  release();
  await commands;
  await refresh;
  assert.equal(completedBeforeRelease, 2);
});

test("a late unrelated refresh cannot restore a capability rejected by a newer action probe", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  let finish!: (value: unknown) => void, sends = 0;
  const catalogue = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.model!.list = () => catalogue;
  f.session.send = async () => { sends++; return "must-not-send"; };
  const refresh = f.runtime.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.session.rpc.metadata!.activity = async () => ({ hasActiveWork: "unknown" });
  let rejected = false;
  const command = assert.rejects(
    f.runtime.execute({ type: "message", text: "Do not trust old activity", attachmentIds: [] }),
    { code: "UNSUPPORTED" },
  ).then(() => { rejected = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rejectedBeforeCatalogue = rejected;
  finish({ list: [{ id: "test-model" }] });
  await command;
  await refresh;
  assert.equal(rejectedBeforeCatalogue, true);
  assert.equal(sends, 0);
  assert.equal(f.runtime.summary.capabilities.messages, false);
  assert.equal(f.runtime.summary.capabilities.models, true);
  assert.ok(f.runtime.summary.warnings.some((warning) => warning.includes("Runtime activity returned an unsupported response shape")));
});

test("overlapping activity consumers share only the required in-flight probe", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  let finish!: (value: unknown) => void, reads = 0, sends = 0;
  const activity = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.metadata!.activity = () => { reads++; return activity; };
  f.session.send = async () => { sends++; return "must-not-send"; };
  const refresh = f.runtime.refresh();
  const command = assert.rejects(f.runtime.execute({
    type: "message", text: "Await required evidence", attachmentIds: [],
  }), { code: "UNSUPPORTED" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(sends, 0);
  finish({});
  await command;
  await refresh;
  assert.equal(f.runtime.summary.capabilities.messages, false);
  assert.equal(sends, 0);
});

test("unknown live permission envelope semantics cannot be approved after a snapshot refresh", async (t) => {
  const f = await capabilityFixture(t, "future-build");
  let decisions = 0;
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  await f.runtime.connect();
  f.emit("permission.requested", {
    requestId: "approval-1", executionScope: "PRIVATE_FUTURE_SCOPE",
    permissionRequest: { kind: "commands", fullCommandText: "echo harmless" },
  });
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "approval-1");
  assert.equal(request?.supported, false);
  assert.ok(!JSON.stringify(request).includes("PRIVATE_FUTURE_SCOPE"));
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
  assert.equal(decisions, 0);
});

test("competing live permission payload aliases are not selected by precedence", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  f.emit("permission.requested", {
    requestId: "approval-1",
    permissionRequest: { kind: "commands", fullCommandText: "echo safe" },
    request: { kind: "commands", fullCommandText: "echo different" },
  });
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "approval-1");
  assert.equal(request?.supported, false);
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
});

test("elicitation form limits count Unicode code points rather than UTF-16 units", async (t) => {
  const f = await capabilityFixture(t), answers: unknown[] = [];
  f.session.rpc.ui = { handlePendingElicitation: async (input) => { answers.push(input); return { success: true }; } };
  await f.runtime.connect();
  f.emit("elicitation.requested", {
    requestId: "single-character", message: "Enter one character",
    requestedSchema: { type: "object", properties: { label: { type: "string", minLength: 1, maxLength: 1 } }, required: ["label"] },
  });
  const answer = "\u{1F600}";
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "single-character", answer })).status, "completed");
  assert.deepEqual(answers, [{ requestId: "single-character", result: { action: "accept", content: { label: answer } } }]);
});

test("documented paired live permission payloads preserve all approval evidence through refresh", async (t) => {
  const forms: { original: Record<string, unknown>; prompt: Record<string, unknown> }[] = [
    {
      original: { kind: "shell", fullCommandText: "echo safe", commands: [{ identifier: "echo", readOnly: true }],
        possiblePaths: ["example.txt"], possibleUrls: [{ url: "https://example.test" }], hasWriteFileRedirection: false },
      prompt: { kind: "commands", fullCommandText: "echo safe", commandIdentifiers: ["echo"], warning: "Review the command" },
    },
    { original: { kind: "read", path: "example.txt" }, prompt: { kind: "read", path: "example.txt" } },
    {
      original: { kind: "write", fileName: "example.txt", diff: "-old\n+new", newFileContents: "new" },
      prompt: { kind: "write", fileName: "example.txt", diff: "-old\n+new", newFileContents: "new" },
    },
    { original: { kind: "url", url: "https://example.test" }, prompt: { kind: "url", url: "https://example.test" } },
    {
      original: { kind: "mcp", serverName: "example", toolName: "lookup", args: { first: "one", second: "two" }, readOnly: true },
      prompt: { kind: "mcp", serverName: "example", toolName: "lookup", args: { second: "two", first: "one" }, canOfferServerWideApproval: false },
    },
    { original: { kind: "custom-tool", toolName: "example", args: {} }, prompt: { kind: "custom-tool", toolName: "example", args: {} } },
  ];
  for (const { original, prompt } of forms) {
    await t.test(String(original.kind), async (t) => {
      const f = await capabilityFixture(t);
      let decisions = 0;
      f.session.rpc.permissions!.pendingRequests = async () => ({ items: [{ requestId: "paired", request: prompt }] });
      f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
      await f.runtime.connect();
      f.emit("permission.requested", {
        requestId: "paired", permissionRequest: { ...original, toolCallId: "PRIVATE_CORRELATION" }, promptRequest: prompt,
        agentMode: "interactive", permissionMode: "manual", resolvedByHook: false, recoveryEpisodeId: "PRIVATE_RECOVERY",
      });
      await f.runtime.refresh();
      const item = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "paired");
      assert.equal(item?.supported, true);
      assert.ok(item.detail.includes("Agent mode: interactive"));
      assert.ok(item.detail.includes("Permission mode: manual"));
      const [originalDetails, promptDetails] = item.detail.split("\nPrompt details:\n");
      assert.deepEqual(JSON.parse(originalDetails!.split("\n").slice(2).join("\n")), original);
      assert.deepEqual(JSON.parse(promptDetails!), prompt);
      assert.ok(!JSON.stringify(item).includes("PRIVATE_"));
      assert.equal((await f.runtime.execute({ type: "permission", requestId: "paired", decision: "reject" })).status, "completed");
      assert.equal(decisions, 1);
      UserEvent.array().parse(f.events);
    });
  }
});

test("single-payload live permission dialects remain supported", async (t) => {
  const f = await capabilityFixture(t);
  const request = { kind: "read", path: "example.txt" };
  const requests = ["request", "permissionRequest", "promptRequest"].map((field) => ({ requestId: field, request }));
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: requests });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => ({ success: true });
  await f.runtime.connect();
  for (const { requestId } of requests) {
    f.emit("permission.requested", { requestId, [requestId]: request });
    assert.equal((await f.runtime.execute({ type: "permission", requestId, decision: "reject" })).status, "completed");
  }
});

test("unsupported live permission metadata and conflicting paired content require the original client", async (t) => {
  const f = await capabilityFixture(t);
  const request = { kind: "commands", fullCommandText: "echo safe" };
  const invalid: Record<string, unknown>[] = [
    { permissionRequest: request, resolvedByHook: true },
    { permissionRequest: request, resolvedByHook: "false" },
    { permissionRequest: request, agentMode: "future-mode" },
    { permissionRequest: request, permissionMode: "future-policy" },
    { permissionRequest: request, recoveryEpisodeId: 42 },
    { permissionRequest: request, riskAssessment: { rawInternalState: "PRIVATE_RISK" } },
    { permissionRequest: request, request, promptRequest: request },
    { permissionRequest: { kind: "shell", fullCommandText: "echo original" }, promptRequest: request },
    { permissionRequest: { kind: "write", fileName: "original.txt", diff: "+one" },
      promptRequest: { kind: "write", fileName: "different.txt", diff: "+two" } },
    { permissionRequest: { kind: "mcp", serverName: "example", toolName: "read", args: {} },
      promptRequest: { kind: "mcp", serverName: "example", toolName: "write", args: {} } },
    { permissionRequest: { kind: "shell", fullCommandText: "echo safe", requestSandboxBypass: true }, promptRequest: request },
    { permissionRequest: request, promptRequest: { ...request, futureConstraint: true } },
    { permissionRequest: request, promptRequest: null },
    {},
  ];
  let decisions = 0;
  f.session.rpc.permissions!.pendingRequests = async () => ({
    items: invalid.map((_item, index) => ({ requestId: `invalid-${index}`, request })),
  });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  await f.runtime.connect();
  for (const [index, envelope] of invalid.entries()) {
    const requestId = `invalid-${index}`;
    f.emit("permission.requested", { requestId, ...envelope });
    await assert.rejects(f.runtime.execute({ type: "permission", requestId, decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
  }
  assert.equal(decisions, 0);
  const projected = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items;
  assert.ok(projected?.every((item) => !item.supported));
  assert.ok(!JSON.stringify(projected).includes("PRIVATE_RISK"));
  UserEvent.array().parse(f.events);
});

test("late permission snapshots do not erase live restrictions or change the approved subject", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  let finish!: (value: unknown) => void;
  const snapshot = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.permissions!.pendingRequests = () => snapshot;
  const refreshing = f.runtime.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.emit("permission.requested", {
    requestId: "approval-1", permissionRequest: { kind: "commands", fullCommandText: "echo safe" }, futureConstraint: true,
  });
  finish({ items: [{ requestId: "approval-1", request: { kind: "commands", fullCommandText: "echo safe" } }] });
  await refreshing;
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });

  f.emit("permission.completed", { requestId: "approval-1" });
  f.emit("permission.requested", {
    requestId: "approval-1", permissionRequest: { kind: "commands", fullCommandText: "echo changed" },
  });
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [] });
  f.emit("permission.completed", { requestId: "approval-1" });
  await f.runtime.refresh();
  assert.deepEqual(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items, []);
});

test("invalid live permission identifiers never poison projected request frames", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  for (const requestId of [undefined, null, "", 42, "x".repeat(201)]) {
    f.emit("permission.requested", { requestId, permissionRequest: { kind: "read", path: "example.txt" } });
    assert.equal(f.events.at(-1)?.kind, "notice");
  }
  UserEvent.array().parse(f.events);
});

test("unsupported historical permission envelopes stay unavailable after reattachment", async (t) => {
  const f = await capabilityFixture(t);
  const history = f.session.getEvents;
  f.session.getEvents = async () => [...await history(), {
    id: randomUUID(), timestamp: new Date().toISOString(), type: "permission.requested",
    data: { requestId: "approval-1", permissionRequest: { kind: "commands", fullCommandText: "echo safe" }, futureConstraint: true },
  }];
  await f.runtime.connect();
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
  assert.equal(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items[0]?.supported, false);
});

test("Unicode min and max constraints apply to primary and alternate answers without changing wire limits", async (t) => {
  const f = await capabilityFixture(t), answered: unknown[] = [];
  f.session.rpc.ui = { handlePendingElicitation: async (input) => { answered.push(input); return { success: true }; } };
  await f.runtime.connect();
  const emoji = "\u{1F600}";
  for (const alternate of [false, true]) {
    for (const length of [1, 2]) {
      const requestId = `${alternate ? "alternate" : "primary"}-${length}`;
      const field = { type: "string", minLength: length, maxLength: length };
      const properties = alternate
        ? { choice: { type: "string", enum: ["One", "Other"] }, answer: field }
        : { answer: field };
      f.emit("elicitation.requested", {
        requestId, message: "Enter characters",
        requestedSchema: { type: "object", properties, required: [alternate ? "choice" : "answer"] },
      });
      if (length === 2)
        await assert.rejects(f.runtime.execute({ type: "answer", requestId, answer: emoji }), { code: "INVALID_ANSWER" });
      await assert.rejects(f.runtime.execute({ type: "answer", requestId, answer: "e\u0301".repeat(length) }), { code: "INVALID_ANSWER" });
      const answer = emoji.repeat(length);
      assert.equal((await f.runtime.execute({ type: "answer", requestId, answer })).status, "completed");
      assert.deepEqual(answered.at(-1), {
        requestId, result: { action: "accept", content: alternate ? { choice: "Other", answer } : { answer } },
      });
    }
  }
  assert.equal(Action.safeParse({ type: "answer", requestId: "wire-limit", answer: emoji.repeat(4000) }).success, true);
  assert.equal(Action.safeParse({ type: "answer", requestId: "wire-limit", answer: emoji.repeat(4001) }).success, false);
});

test("known mutation result variants remain supported and unknown nested confirmations are rejected", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  f.session.rpc.model!.switchTo = async () => ({ modelId: "test-model", message: "Selected" });
  assert.equal((await f.runtime.execute({ type: "model.set", modelId: "test-model" })).status, "completed");
  f.session.rpc.model!.switchTo = async () => ({ deferred: true, message: "Queued" });
  assert.equal((await f.runtime.execute({ type: "model.set", modelId: "test-model" })).result?.deferred, true);
  const confirmation = { targetModelDisplayName: "Test", currentTokens: 100, targetLimit: 50 };
  f.session.rpc.model!.switchTo = async () => ({ confirmation });
  await assert.rejects(f.runtime.execute({ type: "model.set", modelId: "test-model" }), { code: "TERMINAL_REQUIRED" });
  for (const unknown of [false, {}, { ...confirmation, skipApproval: true }]) {
    f.session.rpc.model!.switchTo = async () => ({ modelId: "test-model", confirmation: unknown });
    await assert.rejects(f.runtime.execute({ type: "model.set", modelId: "test-model" }), { name: "ZodError" });
  }
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => ({ success: false });
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "approve-once" }), { code: "REQUEST_STALE" });
});

test("active non-abortable work disables cancellation without disabling other controls", async (t) => {
  const f = await capabilityFixture(t);
  let aborted = 0;
  f.session.abort = async () => { aborted++; };
  f.session.rpc.metadata!.activity = async () => ({ hasActiveWork: true, abortable: false });
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [] });
  const summary = await f.runtime.connect();
  assert.equal(summary.state, "running");
  assert.deepEqual(summary.capabilities, { ...allCapabilities, abort: false });
  await assert.rejects(f.runtime.execute({ type: "abort" }), { code: "UNSUPPORTED" });
  assert.equal(aborted, 0);
});

test("a late empty permission snapshot cannot remove a newer live request", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  let finish!: (value: unknown) => void;
  const snapshot = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.permissions!.pendingRequests = () => snapshot;
  const refreshing = f.runtime.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.emit("permission.requested", {
    requestId: "new-live", permissionRequest: { kind: "commands", fullCommandText: "echo safe" },
  });
  finish({ items: [] });
  await refreshing;
  const requests = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items;
  assert.deepEqual(requests?.map((item) => item.requestId), ["new-live"]);
  assert.equal(requests?.[0]?.supported, true);
});

test("a late permission snapshot cannot resurrect a completed request", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  let finish!: (value: unknown) => void;
  const snapshot = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.permissions!.pendingRequests = () => snapshot;
  const refreshing = f.runtime.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.emit("permission.completed", { requestId: "approval-1" });
  finish({ items: [{ requestId: "approval-1", request: { kind: "commands", fullCommandText: "echo safe" } }] });
  await refreshing;
  assert.deepEqual(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items, []);
});

test("unknown model policy states do not become available", async (t) => {
  const f = await capabilityFixture(t);
  let switches = 0;
  f.session.rpc.model!.list = async () => ({ list: [{ id: "test-model", policy: { state: "restricted-by-new-policy" } }] });
  f.session.rpc.model!.switchTo = async () => { switches++; return { modelId: "test-model" }; };
  const summary = await f.runtime.connect();
  assert.equal(summary.capabilities.models, false);
  assert.equal(summary.capabilities.messages, true);
  await assert.rejects(f.runtime.execute({ type: "model.set", modelId: "test-model" }), { code: "UNSUPPORTED" });
  assert.equal(switches, 0);
});

test("cancellation support recovers for abortable work and retains the idle false case", async (t) => {
  const f = await capabilityFixture(t);
  let activity = { hasActiveWork: true, abortable: false }, aborted = 0;
  f.session.rpc.metadata!.activity = async () => activity;
  f.session.abort = async () => { aborted++; };
  await f.runtime.connect();
  assert.equal(f.runtime.summary.capabilities.abort, false);
  assert.ok(f.runtime.summary.warnings.some((warning) => warning.includes("current work is not abortable")));
  for (const next of [
    { hasActiveWork: true, abortable: true },
    { hasActiveWork: false, abortable: false },
    { hasActiveWork: false, abortable: true },
  ]) {
    activity = next;
    const summary = await f.runtime.refresh();
    assert.equal(summary.capabilities.abort, true);
    assert.ok(!summary.warnings.some((warning) => warning.includes("current work is not abortable")));
    const receipt = await f.runtime.execute({ type: "abort" });
    assert.equal(receipt.status, "cancel_requested");
    assert.equal(receipt.result?.acknowledged, true);
    assert.equal(receipt.result?.stopped, false);
    f.emit("session.idle", { aborted: true });
  }
  assert.equal(aborted, 3);
  activity = { hasActiveWork: true, abortable: false };
  await assert.rejects(f.runtime.execute({ type: "abort" }), { code: "UNSUPPORTED" });
  assert.equal(aborted, 3);
});

test("permission snapshots still reconcile request IDs untouched by concurrent events", async (t) => {
  const f = await capabilityFixture(t);
  const item = (requestId: string, command: string) => ({
    requestId, request: { kind: "commands", fullCommandText: command },
  });
  f.session.rpc.permissions!.pendingRequests = async () => ({
    items: [item("completed", "echo old"), item("updated", "echo old"), item("untouched", "echo old"), item("removed", "echo old")],
  });
  await f.runtime.connect();
  let finish!: (value: unknown) => void;
  const snapshot = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.permissions!.pendingRequests = () => snapshot;
  const refreshing = f.runtime.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.emit("permission.completed", { requestId: "completed" });
  f.emit("permission.requested", { requestId: "updated", request: item("updated", "echo live-update").request });
  f.emit("permission.requested", { requestId: "new-live", request: item("new-live", "echo new-live").request });
  finish({ items: [
    item("completed", "echo old"), item("updated", "echo old"), item("untouched", "echo new-snapshot"), item("snapshot-only", "echo snapshot"),
  ] });
  await refreshing;
  const requests = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items;
  assert.deepEqual(requests?.map((request) => request.requestId).sort(), ["new-live", "snapshot-only", "untouched", "updated"]);
  assert.ok(requests?.find((request) => request.requestId === "updated")?.detail.includes("echo live-update"));
  assert.ok(requests?.find((request) => request.requestId === "untouched")?.detail.includes("echo new-snapshot"));
  assert.ok(requests?.every((request) => request.supported));

  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [] });
  await f.runtime.refresh();
  assert.deepEqual(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items, []);
});

test("a confirmed permission response also supersedes an older in-flight snapshot", async (t) => {
  const f = await capabilityFixture(t);
  let invoked!: () => void, complete!: () => void;
  const started = new Promise<void>((resolve) => { invoked = resolve; });
  const acknowledgement = new Promise<void>((resolve) => { complete = resolve; });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => {
    invoked();
    await acknowledgement;
    return { success: true };
  };
  await f.runtime.connect();
  const command = f.runtime.execute({ type: "permission", requestId: "approval-1", decision: "reject" });
  await started;
  let finish!: (value: unknown) => void;
  const snapshot = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.permissions!.pendingRequests = () => snapshot;
  const refreshing = f.runtime.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  complete();
  assert.equal((await command).status, "completed");
  finish({ items: [{ requestId: "approval-1", request: { kind: "commands", fullCommandText: "echo old" } }] });
  await refreshing;
  assert.deepEqual(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items, []);
});

test("failed permission snapshots release their event-ordering guard before the next read", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  f.session.rpc.permissions!.pendingRequests = async () => {
    f.emit("permission.requested", { requestId: "during-failure", request: { kind: "read", path: "example.txt" } });
    throw new Error("Simulated read failure");
  };
  assert.equal((await f.runtime.refresh()).capabilities.permissions, false);
  assert.ok(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.some((item) => item.requestId === "during-failure"));
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [] });
  assert.equal((await f.runtime.refresh()).capabilities.permissions, true);
  assert.deepEqual(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items, []);
});

test("model selection honors known policy states and rejects incomplete policy evidence", async (t) => {
  const f = await capabilityFixture(t);
  let policy: unknown, switches = 0;
  f.session.rpc.model!.list = async () => ({ list: [{ id: "test-model", ...(policy === undefined ? {} : { policy }) }] });
  f.session.rpc.model!.switchTo = async (input) => {
    assert.equal(input.requireAvailable, true);
    switches++;
    return { modelId: "test-model" };
  };
  await f.runtime.connect();
  for (const state of [undefined, "enabled", "disabled", "unconfigured"]) {
    policy = state === undefined ? undefined : { state, terms: "Runtime-managed terms" };
    const models = await f.runtime.models();
    const enabled = state === undefined || state === "enabled";
    assert.equal(models[0]?.enabled, enabled);
    if (enabled)
      assert.equal((await f.runtime.execute({ type: "model.set", modelId: "test-model" })).status, "completed");
    else
      await assert.rejects(f.runtime.execute({ type: "model.set", modelId: "test-model" }), { code: "MODEL_UNAVAILABLE" });
  }
  for (const invalid of [{}, { state: null }, { state: false }, { state: "unknown-restriction" }]) {
    policy = invalid;
    await assert.rejects(f.runtime.execute({ type: "model.set", modelId: "test-model" }), { code: "UNSUPPORTED" });
    assert.equal(f.runtime.summary.capabilities.messages, true);
  }
  assert.equal(switches, 2);
});

test("forms with unmapped enumNames labels require the original client", async (t) => {
  const f = await capabilityFixture(t);
  let answers = 0;
  f.session.rpc.ui = { handlePendingElicitation: async () => { answers++; return { success: true }; } };
  await f.runtime.connect();
  f.emit("elicitation.requested", {
    requestId: "labelled-choice", message: "Choose the operation",
    requestedSchema: { type: "object", properties: {
      choice: { type: "string", enum: ["a", "b"], enumNames: ["Preview the change", "Apply the change"] },
    }, required: ["choice"] },
  });
  const item = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "labelled-choice");
  assert.equal(item?.supported, false);
  assert.equal(item.type, "terminal");
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "labelled-choice", answer: "a" }), { code: "TERMINAL_REQUIRED" });
  assert.equal(answers, 0);
});

test("cancellation is invoked before a stalled optional queue read completes", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  let finish!: (value: unknown) => void, aborted = false;
  const snapshot = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.queue = { pendingItems: () => snapshot };
  f.session.abort = async () => { aborted = true; };
  const command = f.runtime.execute({ type: "abort" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invokedBeforeSnapshot = aborted;
  finish({ items: [{ messageId: "queued-before-abort" }] });
  const receipt = await command;
  assert.equal(invokedBeforeSnapshot, true);
  assert.equal(receipt.status, "cancel_requested");
  assert.equal(receipt.result?.stopped, false);
  assert.deepEqual(receipt.result?.cancelledMessageIds, ["queued-before-abort"]);
});

test("enumNames requires the original client for all otherwise supported form layouts", async (t) => {
  const f = await capabilityFixture(t);
  f.session.rpc.ui = { handlePendingElicitation: async () => { assert.fail("Unmapped labels must never be submitted."); } };
  await f.runtime.connect();
  const fields = [
    { choice: { type: "string", enum: ["a", "b"], enumNames: [] } },
    { choice: { type: "string", enum: ["a", "b"], enumNames: ["One"] } },
    { choice: { type: "string", enumNames: ["Meaningful label"] } },
    {
      choice: { type: "string", enum: ["One", "Other"] },
      custom: { type: "string", enumNames: ["Meaningful label"] },
    },
  ];
  for (const [index, properties] of fields.entries()) {
    const requestId = `enum-names-${index}`;
    f.emit("elicitation.requested", { requestId, message: "Choose", requestedSchema: { type: "object", properties, required: ["choice"] } });
    const item = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === requestId);
    assert.equal(item?.type, "terminal");
    assert.equal(item.supported, false);
    await assert.rejects(f.runtime.execute({ type: "answer", requestId, answer: "a" }), { code: "TERMINAL_REQUIRED" });
  }
});

test("cancellation dispatches the queue read first without waiting and retains immediate snapshot evidence", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  let items = [{ messageId: "queued-before-cancel" }];
  const calls: string[] = [];
  f.session.rpc.queue = {
    pendingItems: async () => { calls.push("queue"); return { items: [...items] }; },
  };
  f.session.abort = async function () {
    assert.equal(this, f.session);
    calls.push("abort");
    items = [];
    f.emit("session.idle", { aborted: true });
  };
  const result = await f.runtime.execute({ type: "abort" });
  assert.deepEqual(calls, ["queue", "abort"]);
  assert.deepEqual(result.result?.cancelledMessageIds, ["queued-before-cancel"]);
  assert.equal(result.status, "cancel_requested");
  assert.equal(result.result?.stopped, false);
  assert.ok(f.events.some((event) => event.kind === "runtime.state" && event.data.state === "idle" && event.data.aborted));
});

test("a timed-out queue read does not postpone cancellation or invent cleared message IDs", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  let aborted = false, acknowledged = false;
  const stalled = new Promise<unknown>(() => {});
  f.session.rpc.queue = { pendingItems: () => stalled };
  f.session.abort = async () => { aborted = true; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const command = f.runtime.execute({ type: "abort" }).then((result) => { acknowledged = true; return result; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(aborted, true);
  assert.equal(acknowledged, false);
  t.mock.timers.tick(5000);
  const result = await command;
  assert.equal(result.status, "cancel_requested");
  assert.deepEqual(result.result?.cancelledMessageIds, []);
  assert.equal(result.result?.acknowledged, true);
});

test("queue failures cannot suppress abort or hide an invalid abort acknowledgement", async (t) => {
  const f = await capabilityFixture(t);
  await f.runtime.connect();
  let aborts = 0;
  f.session.rpc.queue = { pendingItems: async () => { throw new Error("Queue unavailable"); } };
  f.session.abort = async () => { aborts++; };
  const result = await f.runtime.execute({ type: "abort" });
  assert.equal(aborts, 1);
  assert.equal(result.result?.acknowledged, true);
  assert.deepEqual(result.result?.cancelledMessageIds, []);
  f.session.abort = async () => { aborts++; return { confirmationRequired: true }; };
  await assert.rejects(f.runtime.execute({ type: "abort" }), { name: "ZodError" });
  assert.equal(aborts, 2);
});

test("conflicting target aliases cannot disguise a different paired permission subject", async (t) => {
  const f = await capabilityFixture(t);
  const original = { kind: "read", fileName: "safe.txt", path: "first.txt" };
  const prompt = { kind: "read", fileName: "safe.txt", path: "second.txt" };
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [{ requestId: "conflict", request: prompt }] });
  let decisions = 0;
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  await f.runtime.connect();
  f.emit("permission.requested", { requestId: "conflict", permissionRequest: original, promptRequest: prompt });
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "conflict");
  assert.equal(request?.supported, false);
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "conflict", decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
  assert.equal(decisions, 0);
});

test("every accepted elicitation schema field is present in the displayed form definition", async (t) => {
  const f = await capabilityFixture(t), answers: unknown[] = [];
  f.session.rpc.ui = { handlePendingElicitation: async (input) => { answers.push(input); return { success: true }; } };
  await f.runtime.connect();
  const schema = {
    type: "object", title: "Form-level title", description: "Important form-level description",
    properties: {
      choice: { type: "string", title: "Choice", description: "Choose or enter a value", enum: ["One", "Other"], default: "One" },
      detail: { type: "string", title: "Custom detail", description: "Explain this choice", default: "Suggested value", minLength: 2, maxLength: 40 },
    }, required: ["choice"], additionalProperties: false,
  };
  f.emit("elicitation.requested", { requestId: "described-form", message: "Choose an option", requestedSchema: schema });
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "described-form");
  assert.equal(request?.supported, true);
  const rendered = request.detail.split("Form definition (defaults are informational):\n")[1];
  assert.ok(rendered, "Accepted schema-level and alternate-field semantics must not disappear.");
  assert.deepEqual(JSON.parse(rendered), schema);
  assert.deepEqual(answers, []);
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "described-form", answer: "My value" })).status, "completed");
  assert.deepEqual(answers, [{ requestId: "described-form", result: { action: "accept", content: { choice: "Other", detail: "My value" } } }]);
});

test("non-equivalent permission aliases fail closed in snapshots and live envelopes", async (t) => {
  const requests = [
    { kind: "shell", fullCommandText: "echo safe", command: "echo different" },
    { kind: "commands", fullCommandText: "echo safe", args: { command: "echo different" } },
    { kind: "commands", command: "echo safe", arguments: { command: "echo different" } },
    { kind: "shell", fullCommandText: "echo safe", args: { command: "echo safe" }, arguments: { command: "echo different" } },
    { kind: "read", fileName: "safe.txt", path: "different.txt" },
    { kind: "read", path: "safe.txt", args: { path: "different.txt" } },
    { kind: "write", fileName: "safe.txt", arguments: { path: "different.txt" }, diff: "+change" },
    { kind: "write", fileName: "safe.txt", args: { path: "safe.txt" }, arguments: { path: "different.txt" }, diff: "+change" },
    { kind: "url", url: "https://safe.test", args: { url: "https://different.test" } },
    { kind: "url", args: { url: "https://safe.test" }, arguments: { url: "https://different.test" } },
    { kind: "mcp", serverName: "safe", mcpServerName: "different", toolName: "read", args: {} },
    { kind: "mcp", serverName: "safe", toolName: "read", args: { value: "safe" }, arguments: { value: "different" } },
    { kind: "custom-tool", toolName: "read", args: { nested: { value: ["safe"] } }, arguments: { nested: { value: ["different"] } } },
    { kind: "read", fileName: "safe.txt", args: {}, arguments: { path: "different.txt" } },
  ];
  const f = await capabilityFixture(t);
  let decisions = 0;
  f.session.rpc.permissions!.pendingRequests = async () => ({
    items: requests.map((request, index) => ({ requestId: `conflict-${index}`, request })),
  });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  await f.runtime.connect();
  assert.ok(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.every((item) => !item.supported));
  for (const [index, request] of requests.entries()) {
    const requestId = `conflict-${index}`;
    await assert.rejects(f.runtime.execute({ type: "permission", requestId, decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
    f.emit("permission.requested", { requestId, permissionRequest: request, promptRequest: request });
    await assert.rejects(f.runtime.execute({ type: "permission", requestId, decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
  }
  assert.equal(decisions, 0);
  UserEvent.array().parse(f.events);
});

test("equivalent permission aliases preserve known dialect compatibility", async (t) => {
  const requests = [
    { kind: "shell", fullCommandText: "echo safe", command: "echo safe", args: { command: "echo safe" }, arguments: { command: "echo safe" } },
    { kind: "commands", fullCommandText: "echo safe", command: "echo safe", arguments: { command: "echo safe" } },
    { kind: "read", fileName: "safe.txt", path: "safe.txt", args: { path: "safe.txt" }, arguments: { path: "safe.txt" } },
    { kind: "write", fileName: "safe.txt", path: "safe.txt", args: { path: "safe.txt" }, diff: "+change" },
    { kind: "url", url: "https://safe.test", args: { url: "https://safe.test" }, arguments: { url: "https://safe.test" } },
    { kind: "mcp", serverName: "safe", mcpServerName: "safe", toolName: "read",
      args: { first: "one", nested: { second: [1, null, true] } }, arguments: { nested: { second: [1, null, true] }, first: "one" } },
    { kind: "custom-tool", toolName: "read", args: { value: "same" }, arguments: { value: "same" } },
  ];
  const f = await capabilityFixture(t);
  let decisions = 0;
  f.session.rpc.permissions!.pendingRequests = async () => ({
    items: requests.map((request, index) => ({ requestId: `equivalent-${index}`, request })),
  });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  await f.runtime.connect();
  for (const [index, request] of requests.entries()) {
    const requestId = `equivalent-${index}`;
    f.emit("permission.requested", { requestId, permissionRequest: request, promptRequest: request });
    assert.equal((await f.runtime.execute({ type: "permission", requestId, decision: "reject" })).status, "completed");
  }
  assert.equal(decisions, requests.length);
});

test("unrenderable form metadata cannot be hidden to make a request answerable", async (t) => {
  const f = await capabilityFixture(t);
  let answers = 0;
  f.session.rpc.ui = { handlePendingElicitation: async () => { answers++; return { success: true }; } };
  await f.runtime.connect();
  const schemas = [
    { type: "object", description: "x".repeat(12_000), properties: { label: { type: "string" } } },
    { type: "object", title: "ghp_SYNTHETIC_FIXTURE", properties: { label: { type: "string" } } },
    { type: "object", properties: { label: { type: "string", default: "ghp_SYNTHETIC_FIXTURE" } } },
    { type: "object", properties: {
      choice: { type: "string", enum: ["One", "Other"] },
      detail: { type: "string", description: "ghp_SYNTHETIC_FIXTURE" },
    } },
  ];
  for (const [index, schema] of schemas.entries()) {
    const requestId = `hidden-metadata-${index}`;
    f.emit("elicitation.requested", { requestId, message: "Choose", requestedSchema: schema });
    const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === requestId);
    assert.equal(request?.type, "terminal");
    assert.equal(request.supported, false);
    assert.ok(!JSON.stringify(request).includes("SYNTHETIC_FIXTURE"));
    assert.ok(request.detail.length <= 12_000);
    await assert.rejects(f.runtime.execute({ type: "answer", requestId, answer: "One" }), { code: "TERMINAL_REQUIRED" });
  }
  assert.equal(answers, 0);
});

test("duplicate permission IDs disable ambiguous snapshots before any decision", async (t) => {
  const f = await capabilityFixture(t);
  let decisions = 0;
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [
    { requestId: "duplicate", request: { kind: "read", path: "first.txt" } },
    { requestId: "duplicate", request: { kind: "read", path: "second.txt" } },
  ] });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => { decisions++; return { success: true }; };
  const summary = await f.runtime.connect();
  assert.equal(summary.capabilities.permissions, false);
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "duplicate", decision: "approve-once" }), { code: "UNSUPPORTED" });
  assert.equal(decisions, 0);
});

test("duplicate model IDs disable ambiguous catalogues before selection", async (t) => {
  const f = await capabilityFixture(t);
  let switches = 0;
  f.session.rpc.model!.list = async () => ({ list: [
    { id: "duplicate", policy: { state: "enabled" } },
    { id: "duplicate", policy: { state: "disabled" } },
  ] });
  f.session.rpc.model!.switchTo = async () => { switches++; return { modelId: "duplicate" }; };
  const summary = await f.runtime.connect();
  assert.equal(summary.capabilities.models, false);
  await assert.rejects(f.runtime.execute({ type: "model.set", modelId: "duplicate" }), { code: "UNSUPPORTED" });
  assert.equal(switches, 0);
});

test("a snapshot-removed permission ID cannot reuse cached live evidence", async (t) => {
  const f = await capabilityFixture(t);
  let pending: unknown[] = [{ requestId: "reused", request: { kind: "read", path: "old.txt" } }];
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: pending });
  f.session.rpc.permissions!.handlePendingPermissionRequest = async () => ({ success: true });
  await f.runtime.connect();
  f.emit("permission.requested", {
    requestId: "reused", permissionRequest: { kind: "read", path: "old.txt" }, unknownConstraint: true,
  });
  await f.runtime.refresh();
  assert.equal(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items[0]?.supported, false);
  pending = [];
  await f.runtime.refresh();
  assert.deepEqual(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items, []);
  pending = [{ requestId: "reused", request: { kind: "read", path: "new.txt" } }];
  await f.runtime.refresh();
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items[0];
  assert.equal(request?.supported, true);
  assert.ok(request.detail.includes("new.txt"));
  assert.equal((await f.runtime.execute({ type: "permission", requestId: "reused", decision: "reject" })).status, "completed");
});

test("a single-field Other enum remains an exact choice rather than free text", async (t) => {
  const f = await capabilityFixture(t), answers: unknown[] = [];
  f.session.rpc.ui = { handlePendingElicitation: async (input) => { answers.push(input); return { success: true }; } };
  await f.runtime.connect();
  f.emit("elicitation.requested", {
    requestId: "literal-other", message: "Choose",
    requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["One", "Other"] } }, required: ["choice"] },
  });
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === "literal-other");
  assert.equal(request?.supported, true);
  assert.deepEqual(request.choices, ["One", "Other"]);
  assert.equal(request.allowFreeform, false);
  await assert.rejects(f.runtime.execute({ type: "answer", requestId: "literal-other", answer: "not an enum value" }), { code: "INVALID_CHOICE" });
  assert.equal((await f.runtime.execute({ type: "answer", requestId: "literal-other", answer: "Other" })).status, "completed");
  assert.deepEqual(answers, [{ requestId: "literal-other", result: { action: "accept", content: { choice: "Other" } } }]);
});

test("identical duplicate request and model IDs remain unsupported until unique evidence returns", async (t) => {
  const f = await capabilityFixture(t);
  const permissions = f.session.rpc.permissions!, models = f.session.rpc.model!;
  const pending = permissions.pendingRequests!, catalogue = models.list!;
  await f.runtime.connect();
  permissions.pendingRequests = async () => {
    const request = { requestId: "duplicate", request: { kind: "read", path: "same.txt" } };
    return { items: [request, request] };
  };
  models.list = async () => {
    const model = { id: "duplicate", policy: { state: "enabled" } };
    return { list: [model, model] };
  };
  const unavailable = await f.runtime.refresh();
  assert.deepEqual(unavailable.capabilities, { ...allCapabilities, permissions: false, models: false });
  assert.ok(unavailable.warnings.some((warning) => warning.includes("Pending permissions returned an unsupported response shape")));
  assert.ok(unavailable.warnings.some((warning) => warning.includes("Model catalogue returned an unsupported response shape")));
  await assert.rejects(f.runtime.execute({ type: "models" }), { code: "UNSUPPORTED" });
  assert.ok(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.every((item) => !item.supported));
  permissions.pendingRequests = pending;
  models.list = catalogue;
  const recovered = await f.runtime.refresh();
  assert.deepEqual(recovered.capabilities, allCapabilities);
  assert.ok(!recovered.warnings.some((warning) => warning.includes("unsupported response shape")));
});

test("invalid snapshots do not retire live restrictions but confirmed removals do", async (t) => {
  const f = await capabilityFixture(t);
  let pending: unknown = { items: [{ requestId: "tracked", request: { kind: "read", path: "example.txt" } }] };
  f.session.rpc.permissions!.pendingRequests = async () => pending;
  await f.runtime.connect();
  f.emit("permission.requested", {
    requestId: "tracked", permissionRequest: { kind: "read", path: "example.txt" }, unknownConstraint: true,
  });
  pending = { items: "not-a-snapshot" };
  assert.equal((await f.runtime.refresh()).capabilities.permissions, false);
  pending = { items: [{ requestId: "tracked", request: { kind: "read", path: "example.txt" } }] };
  await f.runtime.refresh();
  assert.equal(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items[0]?.supported, false);
  pending = { items: [] };
  await f.runtime.refresh();
  pending = { items: [{ requestId: "tracked", request: { kind: "read", path: "example.txt" } }] };
  await f.runtime.refresh();
  assert.equal(f.events.filter((event) => event.kind === "requests").at(-1)?.data.items[0]?.supported, true);
});

test("a newly received live permission survives snapshot removal with its full evidence", async (t) => {
  const f = await capabilityFixture(t);
  f.session.rpc.permissions!.pendingRequests = async () => ({ items: [] });
  await f.runtime.connect();
  let finish!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => { finish = resolve; });
  f.session.rpc.permissions!.pendingRequests = () => pending;
  const refreshing = f.runtime.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.emit("permission.requested", {
    requestId: "live-after-read", permissionRequest: { kind: "read", path: "example.txt" }, unknownConstraint: true,
  });
  finish({ items: [] });
  await refreshing;
  const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items[0];
  assert.equal(request?.requestId, "live-after-read");
  assert.equal(request.supported, false);
  f.session.rpc.permissions!.pendingRequests = async () => ({
    items: [{ requestId: "live-after-read", request: { kind: "read", path: "example.txt" } }],
  });
  await assert.rejects(f.runtime.execute({ type: "permission", requestId: "live-after-read", decision: "approve-once" }), { code: "TERMINAL_REQUIRED" });
});

test("single-field Other variants are literal and do not disable valid choices", async (t) => {
  const f = await capabilityFixture(t), answers: unknown[] = [];
  f.session.rpc.ui = { handlePendingElicitation: async (input) => { answers.push(input); return { success: true }; } };
  await f.runtime.connect();
  for (const [index, choice] of ["Other", "Other (specify)", "\u5176\u4ed6", "\u5176\u5b83"].entries()) {
    const requestId = `literal-${index}`;
    f.emit("elicitation.requested", {
      requestId, message: "Choose",
      requestedSchema: { type: "object", properties: { choice: { type: "string", enum: [choice] } }, required: ["choice"] },
    });
    const request = f.events.filter((event) => event.kind === "requests").at(-1)?.data.items.find((item) => item.requestId === requestId);
    assert.deepEqual(request?.choices, [choice]);
    assert.equal(request.allowFreeform, false);
    assert.equal((await f.runtime.execute({ type: "answer", requestId, answer: choice })).status, "completed");
    assert.deepEqual(answers.at(-1), { requestId, result: { action: "accept", content: { choice } } });
  }
});
