import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  Json, PendingRequest, SessionSummary, UserEvent,
  type Action, type Receipt,
} from "./protocol.js";
import { Fault, hash, redact } from "./security.js";
import { ProjectFiles } from "./files.js";

type RpcRead = () => Promise<unknown>;
export type LocalAttachment = { type: "file"; path: string; displayName: string };
export interface JoinedSession {
  sessionId: string;
  getEvents(): Promise<unknown[]>;
  on(handler: (event: unknown) => void): () => void;
  send(options: { prompt: string; mode: "enqueue"; source: "user"; attachments?: LocalAttachment[] }): Promise<string>;
  abort(): Promise<void>;
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

function permission(item: unknown): PendingRequest {
  const raw = record(item), request = record(raw.request ?? raw.permissionRequest);
  const args = record(request.args ?? request.arguments);
  const kind = text(request.kind);
  const known = ["shell", "commands", "read", "write", "mcp", "url", "custom-tool"].includes(kind);
  const detail = JSON.stringify({
    kind, tool: request.toolName, intention: request.intention,
    command: request.fullCommandText ?? args.command ?? request.command,
    path: request.fileName ?? request.path ?? args.path,
    url: request.url ?? args.url, server: request.serverName ?? request.mcpServerName,
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
    supported: known && detail.length <= 12_000 && !projected.includes("[REDACTED]") &&
      request.requestSandboxBypass !== true && request.requestSandboxPermissive !== true,
  });
}

type ModelItem = { id: string; name: string; reasoningEfforts: string[]; reasoningManual: boolean; enabled: boolean };
export class CopilotRuntime {
  private readonly requests = new Map<string, PendingRequest>();
  private readonly permissionIds = new Set<string>();
  private readonly elicitationFields = new Map<string, { field: string; alternateField?: string; alternateChoice?: string; maxLength: number }>();
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
  private readonly warnings = new Set<string>();

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

  private async probe(label: string, read: RpcRead | undefined): Promise<unknown> {
    if (!read) { this.warnings.add(`${label} is unavailable; use the terminal.`); return undefined; }
    try { return await read(); }
    catch (error) {
      this.warnings.add(`${label} probe failed (${error instanceof Error ? error.name : "runtime error"}); use the terminal.`);
      return undefined;
    }
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
        version = text(data.copilotVersion) || version;
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
    this.warnings.add("Version is recorded at session creation; controls also require live API probes. Unknown versions are read-only.");
    this.warnings.add("Questions already open before first attachment may require the terminal; this CLI has no pending-question snapshot.");
    return await this.refresh();
  }

  async refresh(): Promise<SessionSummary> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.refreshNow();
    this.refreshInFlight = pending;
    try { return await pending; } finally { this.refreshInFlight = undefined; }
  }

  private async refreshNow(): Promise<SessionSummary> {
    const rpc = this.session.rpc;
    const [paths, activity, mode, pending, model, name] = await Promise.all([
      this.probe("Working directory", rpc.permissions?.paths?.list),
      this.probe("Runtime activity", rpc.metadata?.activity),
      this.probe("Permission mode", rpc.permissions?.getMode),
      this.probe("Pending permissions", rpc.permissions?.pendingRequests),
      this.probe("Current model", rpc.model?.getCurrent),
      this.probe("Session name", rpc.name?.get),
    ]);
    const primary = text(record(paths).primary);
    if (primary) this.root = primary;
    const knownVersion = this.summary.cliVersion === "1.0.90-0";
    const active = record(activity);
    const supported = knownVersion && typeof active.hasActiveWork === "boolean" && !!primary;
    const checkPaths = rpc.contentExclusion?.checkPaths;
    const policy = checkPaths && primary
      ? await this.probe("Content exclusion", () => checkPaths({ paths: [primary] })) : undefined;
    const fileAccess = supported && record(policy).available === true && !!checkPaths;
    this.files = fileAccess ? new ProjectFiles(primary, (paths) => checkPaths({ paths })) : undefined;
    if (!fileAccess) this.warnings.add("File and Git views are disabled until the runtime can evaluate content-exclusion policy.");
    if (!knownVersion) this.warnings.add(`Unsupported recorded CLI version: ${this.summary.cliVersion}. Validated version: 1.0.90-0.`);
    if (Array.isArray(record(pending).items)) {
      for (const id of this.permissionIds) this.requests.delete(id);
      this.permissionIds.clear();
      for (const item of record(pending).items as unknown[]) {
        try {
          const projected = permission(item);
          this.requests.set(projected.requestId, projected);
          this.permissionIds.add(projected.requestId);
        } catch {
          this.warnings.add("A permission request could not be projected safely; review the terminal.");
        }
      }
    }
    const modelState = record(model), nameState = record(name);
    this.current = SessionSummary.parse({
      ...this.summary,
      projectId: this.root ? hash(process.platform === "win32" ? this.root.toLowerCase() : this.root) : "unavailable",
      projectName: this.root ? path.basename(this.root) || this.root : "Unknown project",
      title: redact(text(nameState.name) || this.summary.title, 160),
      state: !supported ? "unsupported" : this.cancelRequested ? "cancel_requested" :
        this.requests.size ? "waiting" : active.hasActiveWork ? "running" : "idle",
      permissionMode: text(record(mode).mode) || "unknown",
      modelId: text(modelState.modelId), reasoningEffort: text(modelState.reasoningEffort),
      capabilities: {
        messages: supported, abort: supported,
        permissions: supported && Array.isArray(record(pending).items) && !!rpc.permissions?.handlePendingPermissionRequest,
        questions: supported && (!!rpc.ui?.handlePendingUserInput || !!rpc.ui?.handlePendingElicitation),
        models: supported && model !== undefined && !!rpc.model?.list && !!rpc.model?.switchTo,
        files: fileAccess, git: fileAccess,
      },
      warnings: [...this.warnings].slice(0, 20),
    });
    this.emitRequests();
    return this.summary;
  }

  private emitRequests(id: string = randomUUID(), at = new Date().toISOString()): void {
    if (this.closed) return;
    let items = [...this.requests.values()].slice(0, 100);
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
          const item = PendingRequest.parse({
            requestId: data.requestId, type: "question", title: "The CLI needs your answer",
            detail: redact(text(data.question), 12_000),
            choices: Array.isArray(data.choices) ? data.choices : [],
            allowFreeform: data.allowFreeform === true || !Array.isArray(data.choices) || data.choices.length === 0,
            supported: text(data.question).length <= 12_000,
          });
          this.requests.set(item.requestId, item);
          if (!historical) this.emitRequests(event.id, event.timestamp);
          break;
        }
        case "elicitation.requested": {
          if (historical) break;
          const schema = record(data.requestedSchema), properties = record(schema.properties);
          const fields = Object.entries(properties);
          const required = Array.isArray(schema.required) ? schema.required : [];
          const candidates = fields.filter(([, value]) => record(value).type === "string" && Array.isArray(record(value).enum));
          const primary = fields.length === 1 ? fields[0] : candidates.length === 1 ? candidates[0] : undefined;
          const field = primary ? record(primary[1]) : {};
          const choices = Array.isArray(field.enum) && field.enum.every((item) => typeof item === "string") ? field.enum as string[] : [];
          const alternate = primary ? fields.find(([name, value]) => name !== primary[0] && record(value).type === "string") : undefined;
          const alternateChoice = choices.find((choice) => /^(other|other \(.*\)|其他|其它)$/i.test(choice));
          const knownFieldKeys = new Set(["type", "title", "description", "enum", "enumNames", "oneOf", "minLength", "maxLength", "default"]);
          const simple = primary && field.type === "string" && (fields.length === 1 ||
            (fields.length === 2 && alternate && alternateChoice && !required.includes(alternate[0]))) &&
            Object.keys(field).every((key) => knownFieldKeys.has(key)) && !field.oneOf &&
            (!data.mode || data.mode === "form") && !data.url &&
            required.every((name) => name === primary[0]) &&
            text(data.message).length <= 10_000 && choices.length <= 50;
          if (simple) {
            const maxLength = typeof field.maxLength === "number" ? Math.min(8000, field.maxLength) : 8000;
            this.elicitationFields.set(text(data.requestId), { field: primary[0], maxLength,
              ...(alternate && alternateChoice ? { alternateField: alternate[0], alternateChoice } : {}) });
            this.requests.set(text(data.requestId), PendingRequest.parse({
              requestId: data.requestId, type: "question", title: text(field.title) || "The CLI needs your answer",
              detail: redact([text(data.message), text(field.description)].filter(Boolean).join("\n"), 12_000),
              choices: alternateChoice ? choices.filter((choice) => choice !== alternateChoice) : choices,
              allowFreeform: choices.length === 0 || !!alternateChoice, supported: !!this.session.rpc.ui?.handlePendingElicitation,
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
    const fn = this.session.rpc.model?.list;
    if (!fn) throw new Fault("UNSUPPORTED", "Model listing is unavailable. Use the terminal.", 409);
    const response = record(await fn());
    if (!Array.isArray(response.list)) throw new Fault("UNSUPPORTED", "Unknown model catalogue format. Use the terminal.", 409);
    this.modelItems = response.list.flatMap((raw) => {
      const model = record(raw), policy = record(model.policy);
      const id = text(model.id);
      if (!id) return [];
      const support = record(record(model.capabilities).supports);
      const advertised = model.supportedReasoningEfforts ?? model.supported_reasoning_efforts ?? support.reasoning_efforts;
      const efforts = Array.isArray(advertised)
        ? advertised.filter((item): item is string => typeof item === "string") : [];
      return [{ id, name: text(model.name) || id, reasoningEfforts: efforts,
        reasoningManual: efforts.length === 0,
        enabled: policy.state !== "disabled" && model.disabled !== true && model.isDisabled !== true && model.model_picker_enabled !== false }];
    });
    if (!this.modelItems.length) throw new Fault("MODEL_CATALOG_EMPTY", "No supported model choices were returned by this runtime.", 409);
    return this.modelItems;
  }

  async execute(action: Action, attachments: LocalAttachment[] = []): Promise<Omit<Receipt, "commandId">> {
    const rpc = this.session.rpc;
    if (!this.summary.capabilities.messages && action.type !== "refresh")
      throw new Fault("UNSUPPORTED", "This runtime is read-only or unsupported. Use the original terminal.", 409);
    switch (action.type) {
      case "message": {
        if (!action.text.trim()) throw new Fault("EMPTY_MESSAGE", "Message cannot be blank.");
        if (attachments.length !== action.attachmentIds.length) throw new Fault("ATTACHMENT_MISSING", "Resolve every attachment before sending.");
        const messageId = await this.session.send({ prompt: action.text, mode: "enqueue", source: "user", attachments });
        const queue = record(await this.probe("Message queue", rpc.queue?.pendingItems));
        const queued = Array.isArray(queue.items) && queue.items.some((item) => record(item).messageId === messageId);
        const status = queued ? "queued" : queue.withdrawableTurnMessageId === messageId ? "processing" : "admitted";
        return { status, result: { messageId, delivery: "enqueue" } };
      }
      case "abort": {
        const queue = record(await this.probe("Message queue", rpc.queue?.pendingItems));
        const cancelledMessageIds = Array.isArray(queue.items)
          ? queue.items.map((item) => text(record(item).messageId)).filter(Boolean) : [];
        this.cancelRequested = true;
        this.emit({ id: randomUUID(), at: new Date().toISOString(), kind: "runtime.state", data: { state: "cancel_requested" } });
        await this.session.abort();
        return { status: "cancel_requested", result: { acknowledged: true, stopped: false, cancelledMessageIds } };
      }
      case "permission": {
        await this.refresh();
        const item = this.requests.get(action.requestId);
        if (!item) throw new Fault("REQUEST_STALE", "The request was already answered or is no longer pending.", 409);
        if (!item.supported || item.type !== "permission" || !rpc.permissions?.handlePendingPermissionRequest)
          throw new Fault("TERMINAL_REQUIRED", "Review this permission in the original terminal.", 409);
        const result = record(await rpc.permissions.handlePendingPermissionRequest({
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
        if (item.type !== "question" || !item.supported || (!form && !rpc.ui?.handlePendingUserInput))
          throw new Fault("TERMINAL_REQUIRED", "This request must be answered in the terminal.", 409);
        if (!item.allowFreeform && !item.choices.includes(action.answer))
          throw new Fault("INVALID_CHOICE", "Choose an exact answer offered by the runtime.");
        let raw: unknown;
        if (form) {
          if (!rpc.ui?.handlePendingElicitation || action.answer.length > form.maxLength)
            throw new Fault("INVALID_ANSWER", "The answer exceeds this form's supported limits.");
          const content = !item.choices.includes(action.answer) && form.alternateField && form.alternateChoice
            ? { [form.field]: form.alternateChoice, [form.alternateField]: action.answer } : { [form.field]: action.answer };
          raw = await rpc.ui.handlePendingElicitation({ requestId: action.requestId, result: { action: "accept", content } });
        } else {
          raw = await rpc.ui!.handlePendingUserInput!({ requestId: action.requestId,
            response: { answer: action.answer, wasFreeform: !item.choices.includes(action.answer) } });
        }
        const result = record(raw);
        if (result.success !== true) throw new Fault("REQUEST_STALE", "Another client already answered this question.", 409);
        this.requests.delete(action.requestId); this.emitRequests();
        this.elicitationFields.delete(action.requestId);
        return { status: "completed", result: { resolved: true } };
      }
      case "models":
        return { status: "completed", result: { models: await this.models(), current: {
          modelId: this.summary.modelId, reasoningEffort: this.summary.reasoningEffort,
        } } };
      case "model.set": {
        const model = (await this.models()).find((item) => item.id === action.modelId);
        if (!model?.enabled || !rpc.model?.switchTo) throw new Fault("MODEL_UNAVAILABLE", "The CLI does not allow this model.", 409);
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
        const result = record(raw);
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
        return { status: "completed", result: { summary: Json.parse(this.summary), requests: Json.parse([...this.requests.values()]) } };
      case "files.list":
        return { status: "completed", result: await (await this.projectFiles()).list(action.path) };
      case "files.read":
        return { status: "completed", result: await (await this.projectFiles()).read(action.path) };
      case "git.status":
        return { status: "completed", result: await (await this.projectFiles()).gitStatus() };
      case "git.diff":
        return { status: "completed", result: await (await this.projectFiles()).gitDiff(action.path, action.staged) };
    }
  }

  private async projectFiles(): Promise<ProjectFiles> {
    await this.refresh();
    if (!this.files) throw new Fault("POLICY_UNAVAILABLE", "Project files require live content-exclusion policy evaluation.", 409);
    return this.files;
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
