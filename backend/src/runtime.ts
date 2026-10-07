import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  actionCapability, Json, PendingRequest, RequestId, SessionSummary, UserEvent,
  type Action, type Receipt,
} from "./protocol.js";
import { Fault, hash, redact } from "./security.js";
import { contentExclusionDecisions, ProjectFiles } from "./files.js";

type RpcRead = () => Promise<unknown>;
const PROBE_TIMEOUT_MS = 5000;
export type LocalAttachment = { type: "file"; path: string; displayName: string };
export interface JoinedSession {
  sessionId: string;
  getEvents(): Promise<unknown[]>;
  on(handler: (event: unknown) => void): () => void;
  send?(options: { prompt: string; mode: "enqueue"; source: "user"; attachments?: LocalAttachment[] }): Promise<unknown>;
  abort?(): Promise<void>;
  rpc: {
    permissions?: {
      getMode?: RpcRead; pendingRequests?: RpcRead;
      handlePendingPermissionRequest?: (input: { requestId: string; result: { kind: "approve-once" | "reject" } }) => Promise<unknown>;
      paths?: { list?: RpcRead };
    };
    metadata?: { activity?: RpcRead };
    queue?: { pendingItems?: RpcRead };
    name?: { get?: RpcRead };
    model?: {
      getCurrent?: RpcRead; list?: RpcRead;
      switchTo?: (input: { modelId: string; reasoningEffort?: string | null; requireAvailable: boolean;
        runCompactionPreflight: boolean; deferIfModelChangeQueued: boolean }) => Promise<unknown>;
    };
    ui?: {
      handlePendingUserInput?: (input: { requestId: string; response: { answer: string; wasFreeform: boolean } }) => Promise<unknown>;
      handlePendingElicitation?: (input: { requestId: string; result: { action: "accept"; content: Record<string, string> } }) => Promise<unknown>;
    };
    contentExclusion?: { checkPaths?: (input: { paths: string[] }) => Promise<unknown> };
  };
}

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const runtimeEvent = z.object({ id: z.string(), type: z.string(), timestamp: z.string(),
  agentId: z.string().optional(), data: z.record(z.unknown()) });
const workingDirectory = z.object({
  primary: z.string().min(1).refine((value) => path.isAbsolute(value) && !value.includes("\0")),
});
const runtimeActivity = z.object({ hasActiveWork: z.boolean(), abortable: z.unknown().optional() });
const permissionMode = z.object({ mode: z.string().min(1).max(80) });
const pendingPermissions = z.object({ items: z.array(z.object({
  requestId: RequestId, request: z.record(z.unknown()).optional(), permissionRequest: z.record(z.unknown()).optional(),
}).refine((item) => item.request !== undefined || item.permissionRequest !== undefined)) });
const currentModel = z.object({
  modelId: z.string().min(1).max(200), reasoningEffort: z.string().max(60).nullish(),
});
const sessionName = z.object({ name: z.string() });
const reasoningEfforts = z.array(z.string().min(1).max(60));
const modelCatalogue = z.object({ list: z.array(z.object({
  id: z.string().min(1).max(200), name: z.string().optional(),
  supportedReasoningEfforts: reasoningEfforts.optional(), supported_reasoning_efforts: reasoningEfforts.optional(),
  capabilities: z.object({ supports: z.object({ reasoning_efforts: reasoningEfforts.optional() }).optional() }).optional(),
  policy: z.object({ state: z.string().optional() }).optional(),
  disabled: z.boolean().optional(), isDisabled: z.boolean().optional(), model_picker_enabled: z.boolean().optional(),
})).min(1) }).transform(({ list }) => list.map((model) => {
  const efforts = model.supportedReasoningEfforts ?? model.supported_reasoning_efforts ??
    model.capabilities?.supports?.reasoning_efforts ?? [];
  return {
    id: model.id, name: redact(model.name || model.id, 200), reasoningEfforts: efforts,
    reasoningManual: efforts.length === 0,
    enabled: model.policy?.state !== "disabled" && model.disabled !== true && model.isDisabled !== true && model.model_picker_enabled !== false,
  };
}));
const messageQueue = z.object({
  items: z.array(z.object({ messageId: RequestId.optional() })),
  withdrawableTurnMessageId: RequestId.nullish(),
});
const requestResolution = z.object({ success: z.boolean() });
const userQuestion = z.object({
  question: z.string().trim().min(1).max(12_000),
  choices: z.array(z.string().min(1).max(1000)).max(50).optional(),
  allowFreeform: z.boolean().optional(),
});
const elicitationField = z.object({
  type: z.literal("string"), title: z.string().max(500).optional(), description: z.string().max(10_000).optional(),
  enum: z.array(z.string().min(1).max(1000)).min(1).max(50).optional(),
  enumNames: z.array(z.string().max(1000)).max(50).optional(),
  minLength: z.number().int().min(0).max(8000).optional(),
  maxLength: z.number().int().min(1).optional(), default: z.string().optional(),
}).strict().refine((field) => (field.minLength ?? 0) <= (field.maxLength ?? 8000));
const elicitationSchema = z.object({
  type: z.literal("object"), properties: z.record(elicitationField),
  required: z.array(z.string()).optional(), title: z.string().optional(), description: z.string().optional(),
  additionalProperties: z.boolean().optional(),
}).strict();
const modelSelection = z.object({
  modelId: z.string().min(1).max(200).optional(), deferred: z.boolean().optional(),
  confirmation: z.unknown().optional(), message: z.string().optional(),
}).refine((value) => !!value.modelId || value.deferred === true || !!value.confirmation);

function permission(item: unknown): PendingRequest {
  const raw = record(item), request = record(raw.request ?? raw.permissionRequest);
  const args = record(request.args ?? request.arguments);
  const kind = text(request.kind);
  const known = ["shell", "commands", "read", "write", "mcp", "url", "custom-tool"].includes(kind);
  const command = request.fullCommandText ?? args.command ?? request.command;
  const file = request.fileName ?? request.path ?? args.path;
  const url = request.url ?? args.url;
  const server = request.serverName ?? request.mcpServerName;
  const complete = ["shell", "commands"].includes(kind) ? !!text(command).trim() :
    kind === "read" ? !!text(file).trim() :
      kind === "write" ? !!text(file).trim() && (typeof request.diff === "string" || typeof request.newFileContents === "string") :
        kind === "url" ? !!text(url).trim() :
          ["mcp", "custom-tool"].includes(kind) && !!text(request.toolName).trim() &&
          (kind !== "mcp" || !!text(server).trim()) && z.record(z.unknown()).safeParse(request.args ?? request.arguments).success;
  const knownFlags = ["requestSandboxBypass", "requestSandboxPermissive", "managedApprovalRequired"]
    .every((key) => request[key] === undefined || typeof request[key] === "boolean");
  const detail = JSON.stringify({
    kind, tool: request.toolName, intention: request.intention,
    command, path: file, url, server,
    diff: request.diff, newFileContents: request.newFileContents, warning: request.warning,
    redirectedFrom: request.redirectedFrom, managedApprovalRequired: request.managedApprovalRequired,
    requestSandboxBypass: request.requestSandboxBypass, requestSandboxBypassReason: request.requestSandboxBypassReason,
    requestSandboxPermissive: request.requestSandboxPermissive,
    arguments: ["mcp", "custom-tool"].includes(kind) ? request.args ?? request.arguments : undefined,
  }, null, 2);
  const projected = redact(detail, 12_000);
  return PendingRequest.parse({
    requestId: raw.requestId,
    type: known ? "permission" : "terminal",
    title: redact(text(request.intention) || text(request.toolName) || `Permission: ${kind || "unknown"}`, 500),
    detail: known ? projected : "This permission form is unsupported. Review and answer it in the original terminal.",
    permissionKind: kind, choices: [], allowFreeform: false,
    supported: known && complete && knownFlags && detail.length <= 12_000 && !projected.includes("[REDACTED]") &&
      request.requestSandboxBypass !== true && request.requestSandboxPermissive !== true,
  });
}

type ModelItem = z.infer<typeof modelCatalogue>[number];
export class CopilotRuntime {
  private readonly requests = new Map<string, PendingRequest>();
  private readonly permissionIds = new Set<string>();
  private readonly elicitationFields = new Map<string, {
    field: string; minLength: number; maxLength: number;
    alternateField?: string; alternateChoice?: string; alternateMinLength?: number; alternateMaxLength?: number;
  }>();
  private readonly tools = new Map<string, string>();
  private readonly partialMessages = new Map<string, string>();
  private readonly partialTools = new Map<string, string>();
  private unsubscribe?: () => void;
  private cancelRequested = false;
  private root = "";
  private current?: SessionSummary;
  private requestsHash = "";
  private modelItems: ModelItem[] = [];
  private files?: ProjectFiles;
  private closed = false;
  private refreshInFlight?: Promise<SessionSummary>;
  private readonly warnings = new Map<string, string>();

  constructor(readonly session: JoinedSession, private readonly emit: (event: UserEvent) => void) {}

  get summary(): SessionSummary {
    if (!this.current) throw new Fault("NOT_ATTACHED", "The original runtime has not finished registering.", 503);
    return this.current;
  }

  get workingDirectory(): string { return this.root; }

  private notice(code: string, message: string): void {
    if (this.closed) return;
    this.emit({ id: randomUUID(), at: new Date().toISOString(), kind: "notice", data: { code, message: redact(message, 2000) } });
  }

  private async probe<T>(label: string, read: () => Promise<unknown> | undefined, parse: (value: unknown) => T): Promise<T | undefined> {
    let response: unknown;
    let timer: NodeJS.Timeout | undefined;
    try {
      response = await Promise.race([
        Promise.resolve().then(read),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Fault("CAPABILITY_TIMEOUT", "Read-only capability probe timed out.")), PROBE_TIMEOUT_MS);
        }),
      ]);
    }
    catch (error) {
      this.warnings.set(label, error instanceof Fault && error.code === "CAPABILITY_TIMEOUT"
        ? `${label} probe timed out; use the terminal.`
        : `${label} probe failed (${redact(error instanceof Error ? error.name : "runtime error", 80)}); use the terminal.`);
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (response === undefined) {
      this.warnings.set(label, `${label} is unavailable; use the terminal.`);
      return undefined;
    }
    try {
      const result = parse(response);
      this.warnings.delete(label);
      return result;
    } catch {
      this.warnings.set(label, `${label} returned an unsupported response shape; use the terminal.`);
      return undefined;
    }
  }

  private hasMethod(label: string, ...methods: unknown[]): boolean {
    const available = methods.some((method) => typeof method === "function");
    if (available) this.warnings.delete(label);
    else this.warnings.set(label, `${label} is unavailable in the bundled SDK; use the terminal.`);
    return available;
  }

  async connect(): Promise<SessionSummary> {
    const buffered: unknown[] = [];
    let hydrating = true;
    this.unsubscribe = this.session.on((event) => {
      if (hydrating) buffered.push(event); else this.consume(event);
    });
    let history: unknown[];
    try { history = await this.session.getEvents(); }
    catch (error) { this.close(); throw error; }
    let version = "unknown";
    for (const raw of history) {
      const event = record(raw), data = record(event.data);
      if (event.type === "session.start") {
        version = redact(text(data.copilotVersion), 80) || version;
        this.root = text(record(data.context).cwd);
      }
    }
    this.current = {
      sessionId: this.session.sessionId, projectId: "unavailable", projectName: "Unknown project",
      title: "Copilot CLI", cliVersion: version, state: "unsupported", permissionMode: "unknown",
      modelId: "", reasoningEffort: "", registeredAt: Date.now(), warnings: [],
      capabilities: { messages: false, abort: false, permissions: false, questions: false, models: false, files: false, git: false },
    };
    if (history.length > 15_000) this.notice("HISTORY_WINDOW", "The bridge imports the latest 15,000 runtime events. Older history remains in the terminal.");
    for (const event of history.slice(-15_000)) this.consume(event, true);
    hydrating = false;
    for (const event of buffered) this.consume(event);
    this.warnings.set("Recorded version", "CLI version is recorded at session creation and is informational only; controls require live capability evidence.");
    this.warnings.set("Pending questions", "Questions already open before first attachment may require the terminal; no pending-question snapshot is available.");
    return await this.refresh();
  }

  async refresh(): Promise<SessionSummary> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.refreshNow();
    this.refreshInFlight = pending;
    try { return await pending; } finally { this.refreshInFlight = undefined; }
  }

  private async refreshNow(): Promise<SessionSummary> {
    const rpc = this.session.rpc ?? {};
    const [paths, activity, mode, pending, model, catalogue, name] = await Promise.all([
      this.probe("Working directory", () => rpc.permissions?.paths?.list?.(), workingDirectory.parse),
      this.probe("Runtime activity", () => rpc.metadata?.activity?.(), runtimeActivity.parse),
      this.probe("Permission mode", () => rpc.permissions?.getMode?.(), permissionMode.parse),
      this.probe("Pending permissions", () => rpc.permissions?.pendingRequests?.(), pendingPermissions.parse),
      this.probe("Current model", () => rpc.model?.getCurrent?.(), currentModel.parse),
      this.probe("Model catalogue", () => rpc.model?.list?.(), modelCatalogue.parse),
      this.probe("Session name", () => rpc.name?.get?.(), sessionName.parse),
    ]);
    const primary = paths?.primary;
    if (primary) this.root = primary;
    const checkPaths = rpc.contentExclusion?.checkPaths;
    const policy = primary
      ? await this.probe("Content exclusion", () => rpc.contentExclusion?.checkPaths?.({ paths: [primary] }),
        (value) => contentExclusionDecisions(value, [primary])) : undefined;
    if (!primary) this.warnings.delete("Content exclusion");
    this.files = primary && policy?.[0] === true && typeof checkPaths === "function"
      ? new ProjectFiles(primary, (paths) => checkPaths.call(rpc.contentExclusion, { paths })) : undefined;
    if (this.files) this.warnings.delete("File views");
    else this.warnings.set("File views", "File and Git views require explicit content-exclusion allowance for the live working directory.");
    if (pending) {
      for (const id of this.permissionIds) this.requests.delete(id);
      this.permissionIds.clear();
      this.warnings.delete("Permission projection");
      for (const item of pending.items) {
        try {
          const projected = permission(item);
          this.requests.set(projected.requestId, projected);
          this.permissionIds.add(projected.requestId);
        } catch {
          this.warnings.set("Permission projection", "A permission request could not be projected safely; review the terminal.");
        }
      }
    }
    const send = this.hasMethod("Message sending", this.session.send);
    const abort = this.hasMethod("Cancellation", this.session.abort);
    const permissions = this.hasMethod("Permission responses", rpc.permissions?.handlePendingPermissionRequest);
    const questions = this.hasMethod("Question responses", rpc.ui?.handlePendingUserInput, rpc.ui?.handlePendingElicitation);
    const models = this.hasMethod("Model selection", rpc.model?.switchTo);
    if (activity && typeof activity.abortable !== "boolean")
      this.warnings.set("Abort evidence", "Runtime activity does not expose a supported cancellation shape; use the terminal.");
    else this.warnings.delete("Abort evidence");
    this.modelItems = catalogue ?? [];
    this.current = SessionSummary.parse({
      ...this.summary,
      projectId: this.root ? hash(process.platform === "win32" ? this.root.toLowerCase() : this.root) : "unavailable",
      projectName: this.root ? path.basename(this.root) || this.root : "Unknown project",
      title: redact(name?.name || this.summary.title, 160),
      state: this.cancelRequested ? "cancel_requested" : !activity ? "unsupported" :
        this.requests.size ? "waiting" : activity.hasActiveWork ? "running" : "idle",
      permissionMode: mode?.mode ?? "unknown",
      modelId: model?.modelId ?? "", reasoningEffort: model?.reasoningEffort ?? "",
      capabilities: {
        messages: activity !== undefined && send,
        abort: typeof activity?.abortable === "boolean" && abort,
        permissions: pending !== undefined && permissions,
        questions: activity !== undefined && questions,
        models: model !== undefined && catalogue !== undefined && models,
        files: this.files !== undefined, git: this.files !== undefined,
      },
      warnings: [...this.warnings.values()].slice(0, 20),
    });
    this.emitRequests();
    return this.summary;
  }

  private visibleRequests(): PendingRequest[] {
    const capabilities = this.summary.capabilities, ui = this.session.rpc?.ui;
    return [...this.requests.values()].map((item) => ({
      ...item,
      supported: item.supported && (item.type === "permission" ? capabilities.permissions :
        item.type === "question" && capabilities.questions &&
          typeof (this.elicitationFields.has(item.requestId) ? ui?.handlePendingElicitation : ui?.handlePendingUserInput) === "function"),
    }));
  }

  private emitRequests(id: string = randomUUID(), at = new Date().toISOString()): void {
    if (this.closed) return;
    let items = this.visibleRequests().slice(0, 100);
    if (Buffer.byteLength(JSON.stringify(items)) > 450 * 1024) items = [{
      requestId: "terminal-overflow", type: "terminal", title: "Review pending requests in the terminal",
      detail: "Pending request details exceed the mobile-safe display budget. No mobile approval is available.",
      choices: [], allowFreeform: false, supported: false,
    }];
    const digest = hash(JSON.stringify(items));
    if (digest === this.requestsHash) return;
    this.requestsHash = digest;
    this.emit({ id, at, kind: "requests", data: { items } });
  }

  private consume(raw: unknown, historical = false): void {
    if (this.closed) return;
    const parsed = runtimeEvent.safeParse(raw);
    if (!parsed.success) {
      this.notice("EVENT_UNSUPPORTED", "A runtime event could not be read; details remain in the terminal.");
      return;
    }
    const event = parsed.data;
    if (event.agentId || event.data.parentToolCallId) return;
    const { data } = event, base = { id: event.id, at: event.timestamp };
    try {
      switch (event.type) {
        case "user.message":
          this.emit(UserEvent.parse({ ...base, kind: "user.message", data: {
            messageId: text(data.messageId) || event.id, content: redact(text(data.content)),
            attachments: Array.isArray(data.attachments) ? data.attachments.slice(0, 20).map((file) => {
              const item = record(file);
              return redact(text(item.displayName) || text(item.name) || "Attachment", 200);
            }) : [],
          } }));
          break;
        case "assistant.message": {
          if (["analysis", "thinking", "reasoning"].includes(text(data.phase))) break;
          const messageId = text(data.messageId);
          this.partialMessages.delete(messageId);
          this.emit(UserEvent.parse({ ...base, kind: "assistant.message", data: {
            messageId, content: redact(text(data.content)),
            ...(text(data.originatingMessageId) ? { originatingMessageId: text(data.originatingMessageId) } : {}),
          } }));
          break;
        }
        case "assistant.message_delta": {
          if (historical) break;
          const messageId = text(data.messageId);
          const whole = ((this.partialMessages.get(messageId) ?? "") + text(data.deltaContent)).slice(0, 64_000);
          this.partialMessages.set(messageId, whole);
          this.emit(UserEvent.parse({ ...base, kind: "assistant.delta", data: { messageId, content: redact(whole, 16_000) } }));
          break;
        }
        case "tool.execution_start": {
          const toolCallId = text(data.toolCallId), name = text(data.toolName);
          this.tools.set(toolCallId, name);
          this.emit(UserEvent.parse({ ...base, kind: "tool.start", data: { toolCallId, name: redact(name, 200),
            text: "Tool arguments remain in the terminal; review permission requests before approving." } }));
          break;
        }
        case "tool.execution_partial_result":
        case "tool.execution_complete": {
          const toolCallId = text(data.toolCallId);
          const name = (this.tools.get(toolCallId) ?? "").split(/[.:]/).at(-1) ?? "";
          const visible = ["powershell", "bash", "shell", "read_powershell", "read_bash", "rg", "glob", "view", "read_file"].includes(name);
          const complete = event.type === "tool.execution_complete";
          const result = record(data.result), error = record(data.error);
          const chunk = complete ? text(result.detailedContent ?? result.content) || text(error.message) : text(data.partialOutput);
          const whole = complete ? chunk : ((this.partialTools.get(toolCallId) ?? "") + chunk).slice(-32_000);
          if (complete) this.partialTools.delete(toolCallId); else this.partialTools.set(toolCallId, whole);
          this.emit(UserEvent.parse({ ...base, kind: "tool.output", data: {
            toolCallId, text: visible ? redact(whole, 32_000) : "Tool details remain in the original terminal.",
            complete, ...(typeof data.success === "boolean" ? { success: data.success } : {}),
          } }));
          break;
        }
        case "permission.requested": {
          const projected = permission({ requestId: data.requestId, request: data.promptRequest ?? data.permissionRequest ?? data.request });
          this.requests.set(projected.requestId, projected);
          this.permissionIds.add(projected.requestId);
          if (!historical) this.emitRequests(event.id, event.timestamp);
          break;
        }
        case "permission.completed":
        case "user_input.completed":
        case "elicitation.completed":
          this.requests.delete(text(data.requestId));
          this.permissionIds.delete(text(data.requestId));
          this.elicitationFields.delete(text(data.requestId));
          if (!historical) this.emitRequests(event.id, event.timestamp);
          break;
        case "user_input.requested": {
          if (historical) break;
          const parsed = userQuestion.safeParse(data);
          const question = parsed.success ? parsed.data : undefined;
          const detail = question ? redact(question.question, 12_000) : "This incomplete question requires the original terminal.";
          const choices = (question?.choices ?? []).map((choice) => redact(choice, 1000));
          const allowFreeform = question !== undefined && (question.allowFreeform ?? choices.length === 0);
          const item = PendingRequest.parse({
            requestId: data.requestId, type: question ? "question" : "terminal", title: "The CLI needs your answer",
            detail, choices, allowFreeform,
            supported: question !== undefined && detail === question.question && (allowFreeform || choices.length > 0) &&
              choices.every((choice, index) => choice === question.choices?.[index]),
          });
          this.requests.set(item.requestId, item);
          if (!historical) this.emitRequests(event.id, event.timestamp);
          break;
        }
        case "elicitation.requested": {
          if (historical) break;
          const parsed = elicitationSchema.safeParse(data.requestedSchema);
          const schema = parsed.success ? parsed.data : undefined;
          const fields = Object.entries(schema?.properties ?? {});
          const required = schema?.required ?? [];
          const candidates = fields.filter(([, value]) => value.enum !== undefined);
          const primary = fields.length === 1 ? fields[0] : candidates.length === 1 ? candidates[0] : undefined;
          const field = primary?.[1];
          const choices = field?.enum ?? [];
          const alternate = primary ? fields.find(([name, value]) => name !== primary[0] && !value.enum) : undefined;
          const alternateChoice = choices.find((choice) => /^(other|other \(.*\)|其他|其它)$/i.test(choice));
          const detail = [text(data.message), field?.description].filter(Boolean).join("\n");
          const simple = schema && primary && field && (fields.length === 1 ||
            (fields.length === 2 && alternate && alternateChoice && !required.includes(alternate[0]))) &&
            (data.mode === undefined || data.mode === "form") && data.url === undefined &&
            required.every((name) => name === primary[0]) &&
            typeof data.message === "string" && !!data.message.trim() && detail.length <= 12_000 &&
            redact(detail, 12_000) === detail && choices.every((choice) => redact(choice, 1000) === choice);
          if (simple) {
            this.elicitationFields.set(text(data.requestId), {
              field: primary[0], minLength: field.minLength ?? 0, maxLength: Math.min(8000, field.maxLength ?? 8000),
              ...(alternate && alternateChoice ? {
                alternateField: alternate[0], alternateChoice,
                alternateMinLength: alternate[1].minLength ?? 0, alternateMaxLength: Math.min(8000, alternate[1].maxLength ?? 8000),
              } : {}),
            });
            this.requests.set(text(data.requestId), PendingRequest.parse({
              requestId: data.requestId, type: "question", title: redact(field.title || "The CLI needs your answer", 500),
              detail,
              choices: alternateChoice ? choices.filter((choice) => choice !== alternateChoice) : choices,
              allowFreeform: choices.length === 0 || !!alternateChoice, supported: typeof this.session.rpc?.ui?.handlePendingElicitation === "function",
            }));
          } else {
            this.requests.set(text(data.requestId), {
              requestId: text(data.requestId), type: "terminal", title: "Structured request",
              detail: "This form or URL request requires the original terminal. It will not be auto-accepted.",
              choices: [], allowFreeform: false, supported: false,
            });
          }
          this.emitRequests(event.id, event.timestamp);
          break;
        }
        case "exit_plan_mode.requested":
        case "session_limits_exhausted.requested":
          if (historical) break;
          this.requests.set(text(data.requestId), {
            requestId: text(data.requestId), type: "terminal", title: event.type,
            detail: "This structured request requires the original terminal. DevPocket will not auto-accept it.",
            choices: [], allowFreeform: false, supported: false,
          });
          if (!historical) this.emitRequests(event.id, event.timestamp);
          break;
        case "session.idle":
          if (!historical) this.cancelRequested = false;
          this.emit({ ...base, kind: "runtime.state", data: {
            state: "idle", ...(typeof data.aborted === "boolean" ? { aborted: data.aborted } : {}),
          } });
          break;
        case "assistant.turn_start":
          this.emit({ ...base, kind: "runtime.state", data: { state: "running" } });
          break;
        case "session.error":
          this.notice("RUNTIME_ERROR", text(data.message) || "The CLI reported an error. Inspect the terminal.");
          break;
        default:
          if (!historical && event.type.endsWith(".requested") && text(data.requestId)) {
            this.requests.set(text(data.requestId), {
              requestId: text(data.requestId), type: "terminal", title: event.type,
              detail: "This runtime request is not supported on the phone. Review it in the original terminal.",
              choices: [], allowFreeform: false, supported: false,
            });
            this.emitRequests(event.id, event.timestamp);
          } else if (!historical && event.type.endsWith(".completed") && text(data.requestId)) {
            this.requests.delete(text(data.requestId));
            this.emitRequests(event.id, event.timestamp);
          }
      }
    } catch {
      this.notice("EVENT_UNSUPPORTED", `Unsupported ${event.type} data. Review the original terminal.`);
    }
  }

  async models(): Promise<ModelItem[]> {
    await this.refresh();
    if (!this.summary.capabilities.models)
      throw new Fault("UNSUPPORTED", "Model controls require a supported live model state and catalogue. Use the terminal.", 409);
    return this.modelItems;
  }

  async execute(action: Action, attachments: LocalAttachment[] = []): Promise<Omit<Receipt, "commandId">> {
    const rpc = this.session.rpc ?? {};
    const capability = actionCapability[action.type];
    if (capability) {
      await this.refresh();
      if (!this.summary.capabilities[capability])
        throw new Fault("UNSUPPORTED", `This runtime does not expose the required ${capability} capability. Use the original terminal.`, 409);
    }
    switch (action.type) {
      case "message": {
        if (!action.text.trim()) throw new Fault("EMPTY_MESSAGE", "Message cannot be blank.");
        if (attachments.length !== action.attachmentIds.length) throw new Fault("ATTACHMENT_MISSING", "Resolve every attachment before sending.");
        if (typeof this.session.send !== "function") throw new Fault("UNSUPPORTED", "Message sending is unavailable.", 409);
        const messageId = RequestId.parse(await this.session.send({ prompt: action.text, mode: "enqueue", source: "user", attachments }));
        const queue = await this.probe("Message queue", () => rpc.queue?.pendingItems?.(), messageQueue.parse);
        const queued = queue?.items.some((item) => item.messageId === messageId);
        const status = queued ? "queued" : queue?.withdrawableTurnMessageId === messageId ? "processing" : "admitted";
        return { status, result: { messageId, delivery: "enqueue" } };
      }
      case "abort": {
        if (typeof this.session.abort !== "function") throw new Fault("UNSUPPORTED", "Cancellation is unavailable.", 409);
        const queue = await this.probe("Message queue", () => rpc.queue?.pendingItems?.(), messageQueue.parse);
        const cancelledMessageIds = queue?.items.flatMap((item) => item.messageId ? [item.messageId] : []) ?? [];
        this.cancelRequested = true;
        this.emit({ id: randomUUID(), at: new Date().toISOString(), kind: "runtime.state", data: { state: "cancel_requested" } });
        await this.session.abort();
        return { status: "cancel_requested", result: { acknowledged: true, stopped: false, cancelledMessageIds } };
      }
      case "permission": {
        const item = this.requests.get(action.requestId);
        if (!item) throw new Fault("REQUEST_STALE", "The request was already answered or is no longer pending.", 409);
        if (!item.supported || item.type !== "permission" || typeof rpc.permissions?.handlePendingPermissionRequest !== "function")
          throw new Fault("TERMINAL_REQUIRED", "Review this permission in the original terminal.", 409);
        const result = requestResolution.parse(await rpc.permissions.handlePendingPermissionRequest({
          requestId: action.requestId, result: { kind: action.decision },
        }));
        if (result.success !== true) throw new Fault("REQUEST_STALE", "Another client already resolved this request.", 409);
        this.requests.delete(action.requestId); this.emitRequests();
        return { status: "completed", result: { resolved: true } };
      }
      case "answer": {
        const item = this.requests.get(action.requestId);
        if (!item) throw new Fault("REQUEST_STALE", "Question is no longer pending or predates attachment. Use the terminal.", 409);
        const form = this.elicitationFields.get(action.requestId);
        if (item.type !== "question" || !item.supported || (!form && typeof rpc.ui?.handlePendingUserInput !== "function"))
          throw new Fault("TERMINAL_REQUIRED", "This request must be answered in the terminal.", 409);
        if (!item.allowFreeform && !item.choices.includes(action.answer))
          throw new Fault("INVALID_CHOICE", "Choose an exact answer offered by the runtime.");
        let raw: unknown;
        if (form) {
          if (typeof rpc.ui?.handlePendingElicitation !== "function")
            throw new Fault("TERMINAL_REQUIRED", "This request must be answered in the terminal.", 409);
          const alternate = !item.choices.includes(action.answer) && form.alternateField && form.alternateChoice;
          const minLength = alternate ? form.alternateMinLength ?? 0 : form.minLength;
          const maxLength = alternate ? form.alternateMaxLength ?? 8000 : form.maxLength;
          if (action.answer.length < minLength || action.answer.length > maxLength)
            throw new Fault("INVALID_ANSWER", "The answer exceeds this form's supported limits.");
          const content = alternate && form.alternateField && form.alternateChoice
            ? { [form.field]: form.alternateChoice, [form.alternateField]: action.answer } : { [form.field]: action.answer };
          raw = await rpc.ui.handlePendingElicitation({ requestId: action.requestId, result: { action: "accept", content } });
        } else {
          raw = await rpc.ui!.handlePendingUserInput!({ requestId: action.requestId,
            response: { answer: action.answer, wasFreeform: !item.choices.includes(action.answer) } });
        }
        const result = requestResolution.parse(raw);
        if (result.success !== true) throw new Fault("REQUEST_STALE", "Another client already answered this question.", 409);
        this.requests.delete(action.requestId); this.emitRequests();
        this.elicitationFields.delete(action.requestId);
        return { status: "completed", result: { resolved: true } };
      }
      case "models":
        return { status: "completed", result: { models: this.modelItems, current: {
          modelId: this.summary.modelId, reasoningEffort: this.summary.reasoningEffort,
        } } };
      case "model.set": {
        const model = this.modelItems.find((item) => item.id === action.modelId);
        if (!model?.enabled || typeof rpc.model?.switchTo !== "function") throw new Fault("MODEL_UNAVAILABLE", "The CLI does not allow this model.", 409);
        if (action.reasoningEffort && model.reasoningEfforts.length && !model.reasoningEfforts.includes(action.reasoningEffort))
          throw new Fault("REASONING_UNSUPPORTED", "This reasoning level is not supported by the selected model.", 409);
        let raw: unknown;
        try {
          raw = await rpc.model.switchTo({
            modelId: action.modelId, ...(action.reasoningEffort !== undefined ? { reasoningEffort: action.reasoningEffort } : {}),
            requireAvailable: true, runCompactionPreflight: true, deferIfModelChangeQueued: true,
          });
        } catch (error) {
          if (error instanceof Error && /reasoning|not supported|not available|not allowed|unknown model/i.test(error.message))
            throw new Fault("MODEL_SELECTION_REJECTED", redact(error.message, 2000), 409);
          throw error;
        }
        const result = modelSelection.parse(raw);
        if (result.confirmation) throw new Fault("TERMINAL_REQUIRED", "Model switch needs compaction confirmation in the terminal.", 409);
        await this.refresh();
        return { status: "completed", result: {
          modelId: text(result.modelId) || this.summary.modelId, deferred: result.deferred === true,
          message: redact(text(result.message), 2000), reasoningEffort: this.summary.reasoningEffort,
        } };
      }
      case "refresh":
        await this.refresh();
        this.requestsHash = "";
        this.emitRequests();
        return { status: "completed", result: { summary: Json.parse(this.summary), requests: Json.parse(this.visibleRequests()) } };
      case "files.list":
        return { status: "completed", result: await this.projectFiles().list(action.path) };
      case "files.read":
        return { status: "completed", result: await this.projectFiles().read(action.path) };
      case "git.status":
        return { status: "completed", result: await this.projectFiles().gitStatus() };
      case "git.diff":
        return { status: "completed", result: await this.projectFiles().gitDiff(action.path, action.staged) };
    }
  }

  private projectFiles(): ProjectFiles {
    if (!this.files) throw new Fault("POLICY_UNAVAILABLE", "Project files require live content-exclusion policy evaluation.", 409);
    return this.files;
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
