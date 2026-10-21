import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  actionCapability, Id, Json, PendingRequest, RequestId, SessionSummary, UserEvent,
  type Action, type ComponentReference, type QuestionRecord, type Receipt,
} from "./protocol.js";
import { Fault, hash, redact } from "./security.js";
import { contentExclusionDecisions, ProjectFiles } from "./files.js";
import { ComponentProjection, componentToolLinks } from "./components.js";

type RpcRead = () => Promise<unknown>;
const PROBE_TIMEOUT_MS = 5000;
export type LocalAttachment = { type: "file"; path: string; displayName: string };
export type ReferencedComponentAttachment = { reference: ComponentReference; file: LocalAttachment };
export interface JoinedSession {
  sessionId: string;
  readonly openCanvases?: unknown;
  getEvents(): Promise<unknown[]>;
  on(handler: (event: unknown) => void): () => void;
  send?(options: { prompt: string; mode: "enqueue"; source: "user"; attachments?: LocalAttachment[] }): Promise<unknown>;
  abort?(): Promise<unknown>;
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
type ContentExclusion = NonNullable<JoinedSession["rpc"]["contentExclusion"]>;

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const runtimeEvent = z.object({ id: z.string(), type: z.string(), timestamp: z.string(),
  agentId: z.string().optional(), data: z.record(z.unknown()) });
const workingDirectory = z.object({
  primary: z.string().min(1).refine((value) => path.isAbsolute(value) && !value.includes("\0")),
});
const projectIdentity = SessionSummary.pick({ projectId: true, projectName: true, workspace: true }).nullable();
const runtimeActivity = z.object({ hasActiveWork: z.boolean(), abortable: z.unknown().optional() });
const permissionMode = z.object({ mode: z.string().min(1).max(80) });
const pendingPermissions = z.object({ items: z.array(z.object({
  requestId: RequestId, request: z.record(z.unknown()).optional(), permissionRequest: z.record(z.unknown()).optional(),
  recoveryEpisodeId: RequestId.optional(),
}).strict().refine((item) => (item.request !== undefined) !== (item.permissionRequest !== undefined))) })
  .refine(({ items }) => new Set(items.map((item) => item.requestId)).size === items.length, "Permission request IDs must be unique.");
const currentModel = z.object({
  modelId: z.string().min(1).max(200), reasoningEffort: z.string().max(60).nullish(),
});
const sessionName = z.object({ name: z.string() });
const reasoningEfforts = z.array(z.string().min(1).max(60));
const modelCatalogue = z.object({ list: z.array(z.object({
  id: z.string().min(1).max(200), name: z.string().optional(),
  supportedReasoningEfforts: reasoningEfforts.optional(), supported_reasoning_efforts: reasoningEfforts.optional(),
  capabilities: z.object({ supports: z.object({
    reasoning_effort: reasoningEfforts.optional(), reasoning_efforts: reasoningEfforts.optional(),
  }).optional() }).optional(),
  policy: z.object({ state: z.enum(["enabled", "disabled", "unconfigured"]) }).optional(),
  disabled: z.boolean().optional(), isDisabled: z.boolean().optional(), model_picker_enabled: z.boolean().optional(),
})).min(1) })
  .refine(({ list }) => new Set(list.map((model) => model.id)).size === list.length, "Model IDs must be unique.")
  .transform(({ list }) => list.map((model) => {
  const efforts = model.supportedReasoningEfforts ?? model.supported_reasoning_efforts ??
    model.capabilities?.supports?.reasoning_effort ?? model.capabilities?.supports?.reasoning_efforts ?? [];
  return {
    id: model.id, name: redact(model.name || model.id, 200), reasoningEfforts: efforts,
    reasoningManual: efforts.length === 0,
    enabled: (model.policy === undefined || model.policy.state === "enabled") &&
      model.disabled !== true && model.isDisabled !== true && model.model_picker_enabled !== false,
  };
}));
const messageQueue = z.object({
  items: z.array(z.object({ messageId: RequestId.optional() })),
  withdrawableTurnMessageId: RequestId.nullish(),
});
const requestResolution = z.object({ success: z.boolean() }).strict();
const userQuestion = z.object({
  requestId: RequestId, toolCallId: RequestId.optional(),
  question: z.string().trim().min(1).max(12_000),
  choices: z.array(z.string().min(1).max(1000)).max(50).optional(),
  allowFreeform: z.boolean().optional(),
}).strict();
const elicitationField = z.object({
  type: z.literal("string"), title: z.string().max(500).optional(), description: z.string().max(10_000).optional(),
  enum: z.array(z.string().min(1).max(1000)).min(1).max(50).optional(),
  minLength: z.number().int().min(0).max(8000).optional(),
  maxLength: z.number().int().min(1).optional(), default: z.string().optional(),
}).strict().refine((field) => (field.minLength ?? 0) <= (field.maxLength ?? 8000));
const elicitationSchema = z.object({
  type: z.literal("object"), properties: z.record(elicitationField),
  required: z.array(z.string()).optional(), title: z.string().optional(), description: z.string().optional(),
  additionalProperties: z.boolean().optional(),
}).strict();
const elicitationRequest = z.object({
  requestId: RequestId, toolCallId: RequestId.optional(),
  elicitationSource: z.string().min(1).max(200).optional(),
  message: z.string().min(1).max(12_000).refine((value) => !!value.trim()),
  mode: z.literal("form").optional(),
  requestedSchema: elicitationSchema,
}).strict();
const modelSelection = z.object({
  modelId: z.string().min(1).max(200).optional(), deferred: z.boolean().optional(),
  confirmation: z.object({
    targetModelDisplayName: z.string().min(1), currentTokens: z.number().int().nonnegative(),
    targetLimit: z.number().int().nonnegative(),
  }).strict().optional(),
  message: z.string().optional(),
}).strict().refine((value) => !!value.modelId || value.deferred === true || !!value.confirmation);

const permissionFields = {
  toolCallId: RequestId.optional(), toolName: z.string().optional(), intention: z.string().optional(),
  warning: z.string().optional(), managedApprovalRequired: z.boolean().optional(),
};
const sandboxFields = {
  requestSandboxBypass: z.boolean().optional(), requestSandboxBypassReason: z.string().optional(),
};
const commandArguments = z.object({ command: z.string().optional() }).strict();
const pathArguments = z.object({ path: z.string().optional() }).strict();
const urlArguments = z.object({ url: z.string().optional() }).strict();
const commandFields = {
  ...permissionFields, ...sandboxFields,
  fullCommandText: z.string().optional(), command: z.string().optional(),
  args: commandArguments.optional(), arguments: commandArguments.optional(),
  canOfferSessionApproval: z.boolean().optional(), requestSandboxPermissive: z.boolean().optional(),
};
const pathFields = {
  ...permissionFields, ...sandboxFields,
  path: z.string().optional(), fileName: z.string().optional(), resolvedPath: z.string().optional(),
  args: pathArguments.optional(), arguments: pathArguments.optional(),
};
const toolFields = {
  ...permissionFields, args: z.record(Json).optional(), arguments: z.record(Json).optional(),
};
const aliasesAgree = (...values: unknown[]): boolean => {
  const present = values.filter((value) => value !== undefined);
  return present.every((value) => isDeepStrictEqual(value, present[0]));
};
const permissionRequest = z.discriminatedUnion("kind", [
  z.object({
    ...commandFields, kind: z.literal("shell"),
    commands: z.array(z.object({ identifier: z.string(), readOnly: z.boolean() }).strict()).optional(),
    commandSegments: z.array(z.object({ identifier: z.string(), fullCommandText: z.string() }).strict()).optional(),
    hasWriteFileRedirection: z.boolean().optional(), possiblePaths: z.array(z.string()).optional(),
    possibleUrls: z.array(z.object({ url: z.string() }).strict()).optional(),
    resolvedPaths: z.record(z.string()).optional(), resolvedWorkingDirectory: z.string().optional(),
  }).strict(),
  z.object({ ...commandFields, kind: z.literal("commands"), commandIdentifiers: z.array(z.string()).optional() }).strict(),
  z.object({ ...pathFields, kind: z.literal("read") }).strict(),
  z.object({
    ...pathFields, kind: z.literal("write"), diff: z.string().optional(), newFileContents: z.string().optional(),
    canOfferSessionApproval: z.boolean().optional(),
  }).strict(),
  z.object({
    ...permissionFields, ...sandboxFields, kind: z.literal("url"), url: z.string().optional(), redirectedFrom: z.string().optional(),
    args: urlArguments.optional(), arguments: urlArguments.optional(),
  }).strict(),
  z.object({
    ...toolFields, kind: z.literal("mcp"), serverName: z.string().optional(), mcpServerName: z.string().optional(),
    toolTitle: z.string().optional(), readOnly: z.boolean().optional(), canOfferServerWideApproval: z.boolean().optional(),
  }).strict(),
  z.object({
    ...toolFields, kind: z.literal("custom-tool"), toolDescription: z.string().optional(), skipPermission: z.boolean().optional(),
  }).strict(),
]).refine((request) => {
  if (!aliasesAgree(request.args, request.arguments)) return false;
  const args = record(request.args ?? request.arguments);
  switch (request.kind) {
    case "shell":
    case "commands": return aliasesAgree(request.fullCommandText, request.command, args.command);
    case "read":
    case "write": return aliasesAgree(request.fileName, request.path, args.path);
    case "url": return aliasesAgree(request.url, args.url);
    case "mcp": return aliasesAgree(request.serverName, request.mcpServerName);
    case "custom-tool": return true;
  }
}, "Permission aliases must describe the same value.");
// SDK correlation/canonicalization metadata is not part of the user-facing approval.
const permissionMetadata = new Set(["toolCallId", "resolvedPath", "resolvedPaths", "resolvedWorkingDirectory"]);
const livePermissionEnvelope = z.object({
  requestId: RequestId, recoveryEpisodeId: RequestId.optional(),
  agentMode: z.enum(["interactive", "plan", "autopilot"]).optional(),
  permissionMode: z.enum(["manual", "assisted", "allow-all"]).optional(),
  resolvedByHook: z.boolean().optional(),
  permissionRequest: permissionRequest.optional(), promptRequest: permissionRequest.optional(),
  request: permissionRequest.optional(),
}).strict().refine((value) => value.request !== undefined
  ? value.permissionRequest === undefined && value.promptRequest === undefined
  : value.permissionRequest !== undefined || value.promptRequest !== undefined);

function permissionSubject(value: unknown): unknown {
  const request = record(value), args = record(request.args ?? request.arguments);
  switch (request.kind) {
    case "shell":
    case "commands":
      return { kind: "commands", command: request.fullCommandText ?? args.command ?? request.command };
    case "read":
      return { kind: "read", path: request.fileName ?? request.path ?? args.path };
    case "write":
      return { kind: "write", path: request.fileName ?? request.path ?? args.path, diff: request.diff, contents: request.newFileContents };
    case "url":
      return { kind: "url", url: request.url ?? args.url, redirectedFrom: request.redirectedFrom };
    case "mcp":
    case "custom-tool":
      return { kind: request.kind, server: request.serverName ?? request.mcpServerName, tool: request.toolName,
        arguments: request.args ?? request.arguments };
    default: return undefined;
  }
}

function livePermission(value: unknown): { request: PendingRequest; subject: unknown } {
  const requestId = RequestId.parse(record(value).requestId);
  const parsed = livePermissionEnvelope.safeParse(value);
  const terminal: PendingRequest = {
    requestId, type: "terminal", title: "Review permission in the original client",
    detail: "This permission envelope is unsupported or already handled. Review it in the original client.",
    choices: [], allowFreeform: false, supported: false,
  };
  if (!parsed.success || parsed.data.resolvedByHook === true) return { request: terminal, subject: undefined };
  const envelope = parsed.data;
  const original = envelope.permissionRequest ?? envelope.request ?? envelope.promptRequest;
  const projected = permission({ requestId, request: original });
  const subject = permissionSubject(original);
  const prompt = envelope.permissionRequest && envelope.promptRequest
    ? permission({ requestId, request: envelope.promptRequest }) : undefined;
  if (prompt && !isDeepStrictEqual(subject, permissionSubject(envelope.promptRequest)))
    return { request: terminal, subject: undefined };
  const detail = [
    envelope.agentMode === undefined ? undefined : `Agent mode: ${envelope.agentMode}`,
    envelope.permissionMode === undefined ? undefined : `Permission mode: ${envelope.permissionMode}`,
    projected.detail, prompt ? `Prompt details:\n${prompt.detail}` : undefined,
  ].filter((item) => item !== undefined).join("\n");
  return { subject, request: {
    ...projected, detail: redact(detail, 12_000),
    supported: projected.supported && (!prompt || prompt.supported) && detail.length <= 12_000,
  } };
}

function permission(item: unknown): PendingRequest {
  const raw = record(item), parsed = permissionRequest.safeParse(raw.request ?? raw.permissionRequest);
  const request = record(parsed.success ? parsed.data : raw.request ?? raw.permissionRequest);
  const args = record(request.args ?? request.arguments);
  const kind = text(request.kind);
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
  const detail = parsed.success
    ? JSON.stringify(Object.fromEntries(Object.entries(request).filter(([key]) => !permissionMetadata.has(key))), null, 2)
    : "This permission form is unsupported. Review and answer it in the original client.";
  const projected = redact(detail, 12_000);
  return PendingRequest.parse({
    requestId: raw.requestId,
    type: parsed.success ? "permission" : "terminal",
    title: redact(text(request.intention) || text(request.toolName) || `Permission: ${kind || "unknown"}`, 500),
    detail: projected,
    permissionKind: kind, choices: [], allowFreeform: false,
    supported: parsed.success && complete && detail.length <= 12_000 && projected === detail && !projected.includes("[REDACTED]") &&
      request.requestSandboxBypass !== true && request.requestSandboxPermissive !== true,
  });
}

type ModelItem = z.infer<typeof modelCatalogue>[number];
type Capability = keyof SessionSummary["capabilities"];
type ProbeGroup = "activity" | "permissions" | "models" | "files" | "project" | "metadata";
const capabilityGroup = {
  messages: "activity", abort: "activity", questions: "activity", permissions: "permissions",
  models: "models", files: "files", git: "files",
} as const satisfies Record<Capability, ProbeGroup>;
export class CopilotRuntime {
  private readonly requests = new Map<string, PendingRequest>();
  private readonly questions = new Map<string, Extract<QuestionRecord, { status: "pending" }>>();
  private readonly permissionIds = new Set<string>();
  private readonly livePermissions = new Map<string, ReturnType<typeof livePermission>>();
  private permissionSnapshotChanges?: Set<string>;
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
  private filePolicy?: { owner: ContentExclusion; check: NonNullable<ContentExclusion["checkPaths"]> };
  private closed = false;
  private activity?: z.infer<typeof runtimeActivity>;
  private observedActiveWork?: boolean;
  private activityRevision = 0;
  private projectAbort?: AbortController;
  private readonly refreshInFlight = new Map<ProbeGroup, Promise<void>>();
  private readonly warnings = new Map<string, string>();
  private readonly components: ComponentProjection;

  constructor(readonly session: JoinedSession, private readonly emit: (event: UserEvent) => void,
    private readonly persistConfirmedAnswer?: (commandId: string, event: UserEvent | undefined) => void) {
    this.components = new ComponentProjection(session.sessionId);
  }

  get summary(): SessionSummary {
    if (!this.current) throw new Fault("NOT_ATTACHED", "The original runtime has not finished registering.", 503);
    const { workspace, ...summary } = this.current;
    return {
      ...summary,
      componentVersion: 1,
      ...(workspace === undefined ? {} : { workspace }),
      state: this.cancelRequested ? "cancel_requested" : this.observedActiveWork === undefined ? "unsupported" :
        this.requests.size ? "waiting" : this.observedActiveWork ? "running" : "idle",
    };
  }

  get workingDirectory(): string { return this.root; }

  componentReferenceContent(reference: ComponentReference): { content: string; displayName: string } {
    return this.components.referenceContent(reference);
  }

  private notice(code: string, message: string): void {
    if (this.closed) return;
    this.emit({ id: randomUUID(), at: new Date().toISOString(), kind: "notice", data: { code, message: redact(message, 2000) } });
  }

  private async probe<T>(label: string, read: () => Promise<unknown> | undefined, parse: (value: unknown) => T,
    cancel?: () => void): Promise<T | undefined> {
    let response: unknown;
    let timer: NodeJS.Timeout | undefined;
    const operation = Promise.resolve().then(read);
    try {
      response = await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Fault("CAPABILITY_TIMEOUT", "Read-only capability probe timed out.")), PROBE_TIMEOUT_MS);
        }),
      ]);
    }
    catch (error) {
      if (cancel) {
        cancel();
        await operation.catch(() => undefined);
      }
      this.warnings.set(label, error instanceof Fault && error.code === "CAPABILITY_TIMEOUT"
        ? `${label} probe timed out; use the original client.`
        : `${label} probe failed (${redact(error instanceof Error ? error.name : "runtime error", 80)}); use the original client.`);
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (response === undefined) {
      this.warnings.set(label, `${label} is unavailable; use the original client.`);
      return undefined;
    }
    try {
      const result = parse(response);
      this.warnings.delete(label);
      return result;
    } catch {
      this.warnings.set(label, `${label} returned an unsupported response shape; use the original client.`);
      return undefined;
    }
  }

  private hasMethod(label: string, ...methods: unknown[]): boolean {
    const available = methods.some((method) => typeof method === "function");
    if (available) this.warnings.delete(label);
    else this.warnings.set(label, `${label} is unavailable in the bundled SDK; use the original client.`);
    return available;
  }

  async connect(): Promise<SessionSummary> {
    const buffered: unknown[] = [];
    const initialCanvases = await this.probe("Canvas identity",
      async () => this.session.openCanvases, (value) => this.components.snapshot(value));
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
      title: "GitHub Copilot", cliVersion: version, state: "unsupported", permissionMode: "unknown",
      modelId: "", reasoningEffort: "", registeredAt: Date.now(), warnings: [],
      capabilities: { messages: false, abort: false, permissions: false, questions: false, models: false, files: false, git: false },
    };
    if (history.length > 15_000) this.notice("HISTORY_WINDOW", "The bridge imports the latest 15,000 runtime events. Older history remains in the original client.");
    for (const event of history.slice(-15_000)) this.consume(event, true);
    if (!this.components.beginLive(initialCanvases ?? []))
      this.warnings.set("Canvas identity", "Canvas identities conflict or exceed the supported limit. Unconfirmed cards remain in the original client.");
    hydrating = false;
    for (const event of buffered) this.consume(event);
    this.warnings.set("Recorded version", "GitHub Copilot runtime version is recorded at session creation and is informational only; controls require live capability evidence.");
    this.warnings.set("Pending questions", "Questions already open before first attachment may require the original client; no pending-question snapshot is available.");
    return await this.refresh();
  }

  async refresh(): Promise<SessionSummary> {
    await Promise.all((["activity", "permissions", "models", "files", "metadata"] as const)
      .map(async (group) => {
        await this.refreshGroup(group);
        if (group === "files") await this.refreshGroup("project");
      }));
    return this.summary;
  }

  private folderProject(): Pick<SessionSummary, "projectId" | "projectName" | "workspace"> {
    return {
      projectId: this.root ? hash(process.platform === "win32" ? this.root.toLowerCase() : this.root) : "unavailable",
      projectName: this.root ? redact(path.basename(this.root), 120).replace(/\s+/g, " ").trim() || "Folder project" : "Unknown project",
      workspace: undefined,
    };
  }

  private async refreshGroup(group: ProbeGroup): Promise<void> {
    const existing = this.refreshInFlight.get(group);
    if (existing) return existing;
    const pending = this.refreshNow(group);
    this.refreshInFlight.set(group, pending);
    try { await pending; } finally { this.refreshInFlight.delete(group); }
  }

  private async refreshNow(group: ProbeGroup): Promise<void> {
    const rpc = this.session.rpc ?? {};
    let changes: Partial<SessionSummary> = {};
    let capabilities: Partial<SessionSummary["capabilities"]> = {};
    switch (group) {
      case "activity": {
        const revision = this.activityRevision;
        this.activity = await this.probe("Runtime activity", () => rpc.metadata?.activity?.(), runtimeActivity.parse);
        if (this.activity && revision === this.activityRevision) this.observedActiveWork = this.activity.hasActiveWork;
        const send = this.hasMethod("Message sending", this.session.send);
        const abort = this.hasMethod("Cancellation", this.session.abort);
        const questions = this.hasMethod("Question responses", rpc.ui?.handlePendingUserInput, rpc.ui?.handlePendingElicitation);
        if (this.activity && typeof this.activity.abortable !== "boolean")
          this.warnings.set("Abort evidence", "Runtime activity does not expose a supported cancellation shape; use the original client.");
        else if (this.activity?.hasActiveWork && !this.activity.abortable)
          this.warnings.set("Abort evidence", "The runtime's current work is not abortable; use the original client.");
        else this.warnings.delete("Abort evidence");
        capabilities = {
          messages: this.activity !== undefined && send,
          abort: typeof this.activity?.abortable === "boolean" && abort &&
            (!this.activity.hasActiveWork || this.activity.abortable),
          questions: this.activity !== undefined && questions,
        };
        break;
      }
      case "permissions": {
        const changed = new Set<string>();
        this.permissionSnapshotChanges = changed;
        let pending: z.infer<typeof pendingPermissions> | undefined;
        try {
          pending = await this.probe("Pending permissions", () => rpc.permissions?.pendingRequests?.(), pendingPermissions.parse);
        } finally {
          this.permissionSnapshotChanges = undefined;
        }
        if (pending) {
          const pendingIds = new Set(pending.items.map((item) => item.requestId));
          // Live changes after this read started take precedence, including completions.
          for (const id of new Set([...this.permissionIds, ...this.livePermissions.keys()])) {
            if (changed.has(id)) continue;
            this.requests.delete(id);
            this.permissionIds.delete(id);
            if (!pendingIds.has(id)) this.livePermissions.delete(id);
          }
          this.warnings.delete("Permission projection");
          for (const item of pending.items) {
            if (changed.has(item.requestId)) continue;
            try {
              const projected = permission(item);
              const live = this.livePermissions.get(projected.requestId);
              this.requests.set(projected.requestId, live ? {
                ...live.request, supported: live.request.supported && projected.supported &&
                  isDeepStrictEqual(live.subject, permissionSubject(item.request ?? item.permissionRequest)),
              } : projected);
              this.permissionIds.add(projected.requestId);
            } catch {
              this.warnings.set("Permission projection", "A permission request could not be projected safely; review the original client.");
            }
          }
        }
        const handler = this.hasMethod("Permission responses", rpc.permissions?.handlePendingPermissionRequest);
        capabilities = { permissions: pending !== undefined && handler };
        break;
      }
      case "models": {
        const [model, catalogue] = await Promise.all([
          this.probe("Current model", () => rpc.model?.getCurrent?.(), currentModel.parse),
          this.probe("Model catalogue", () => rpc.model?.list?.(), modelCatalogue.parse),
        ]);
        const handler = this.hasMethod("Model selection", rpc.model?.switchTo);
        this.modelItems = catalogue ?? [];
        changes = { modelId: model?.modelId ?? "", reasoningEffort: model?.reasoningEffort ?? "" };
        capabilities = { models: model !== undefined && catalogue !== undefined && handler };
        break;
      }
      case "files": {
        const previousRoot = this.root;
        const paths = await this.probe("Working directory", () => rpc.permissions?.paths?.list?.(), workingDirectory.parse);
        const primary = paths?.primary;
        if (primary) this.root = primary;
        const contentExclusion = rpc.contentExclusion, checkPaths = contentExclusion?.checkPaths;
        const policy = primary
          ? await this.probe("Content exclusion", () => checkPaths?.call(contentExclusion, { paths: [primary] }),
            (value) => contentExclusionDecisions(value, [primary])) : undefined;
        if (!primary) this.warnings.delete("Content exclusion");
        if (primary && policy?.[0] === true && contentExclusion && typeof checkPaths === "function") {
          if (!this.files || previousRoot !== primary || this.filePolicy?.owner !== contentExclusion || this.filePolicy.check !== checkPaths)
            this.files = new ProjectFiles(primary, (paths) => checkPaths.call(contentExclusion, { paths }));
          this.filePolicy = { owner: contentExclusion, check: checkPaths };
        } else {
          this.files = undefined;
          this.filePolicy = undefined;
        }
        if (this.files) this.warnings.delete("File views");
        else this.warnings.set("File views", "File and Git views require explicit content-exclusion allowance for the live working directory.");
        if (!this.files || previousRoot !== this.root || !this.summary.workspace) changes = this.folderProject();
        if (!this.files) this.warnings.delete("Project grouping");
        capabilities = { files: this.files !== undefined, git: this.files !== undefined };
        break;
      }
      case "project": {
        const files = this.files, root = this.root;
        if (!files || this.closed) break;
        const cancellation = new AbortController();
        this.projectAbort = cancellation;
        let project: z.infer<typeof projectIdentity> | undefined;
        try {
          project = await this.probe("Project grouping", () => files.project(cancellation.signal),
            projectIdentity.parse, () => cancellation.abort());
        } finally { this.projectAbort = undefined; }
        if (this.closed || files !== this.files || root !== this.root) {
          this.warnings.delete("Project grouping");
          return;
        }
        changes = project ?? this.folderProject();
        if (project === undefined) this.warnings.set("Project grouping",
          "Repository grouping could not be verified; this session is grouped by its working directory.");
        break;
      }
      case "metadata": {
        const [mode, name] = await Promise.all([
          this.probe("Permission mode", () => rpc.permissions?.getMode?.(), permissionMode.parse),
          this.probe("Session name", () => rpc.name?.get?.(), sessionName.parse),
        ]);
        changes = { permissionMode: mode?.mode ?? "unknown", title: redact(name?.name || this.summary.title, 160) };
        break;
      }
    }
    this.current = SessionSummary.parse({
      ...this.summary, ...changes,
      capabilities: { ...this.summary.capabilities, ...capabilities },
      warnings: [...this.warnings.values()].slice(0, 20),
    });
    this.emitRequests();
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
      requestId: "terminal-overflow", type: "terminal", title: "Review pending requests in the original client",
      detail: "Pending request details exceed the mobile-safe display budget. No mobile approval is available.",
      choices: [], allowFreeform: false, supported: false,
    }];
    const digest = hash(JSON.stringify(items));
    if (digest === this.requestsHash) return;
    this.requestsHash = digest;
    this.emit({ id, at, kind: "requests", data: { items } });
  }

  private questionEvent(data: QuestionRecord, id: string = randomUUID(), at = new Date().toISOString()): void {
    if (!this.closed) this.emit(UserEvent.parse({ id, at, kind: "question", data }));
  }

  private rememberQuestion(request: PendingRequest, event: { id: string; timestamp: string }): void {
    const previous = this.questions.get(request.requestId);
    const questionId = `question:${hash(event.id)}`;
    if (previous?.questionId === questionId) return;
    if (previous) this.questionEvent({ ...previous, status: "unknown" });
    this.questions.delete(request.requestId);
    if (request.type !== "question" || !request.supported) return;
    const question = { questionId, request: { ...request, type: "question" as const }, status: "pending" as const };
    this.questions.set(request.requestId, question);
    this.questionEvent(question, questionId, event.timestamp);
  }

  private forgetQuestion(requestId: string, id?: string, at?: string): void {
    const question = this.questions.get(requestId);
    if (question) {
      this.questionEvent({ ...question, status: "unknown" }, id, at);
      this.questions.delete(requestId);
    }
  }

  private consume(raw: unknown, historical = false): void {
    if (this.closed) return;
    const parsed = runtimeEvent.safeParse(raw);
    if (!parsed.success) {
      this.notice("EVENT_UNSUPPORTED", "A runtime event could not be read; details remain in the original client.");
      return;
    }
    const event = parsed.data;
    if (event.agentId || event.data.parentToolCallId) return;
    const { data } = event, base = { id: event.id, at: event.timestamp };
    try {
      const components = this.components.observe(event);
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
          const toolCallIds = componentToolLinks(data);
          this.partialMessages.delete(messageId);
          this.emit(UserEvent.parse({ ...base, kind: "assistant.message", data: {
            messageId, content: redact(text(data.content)),
            ...(text(data.originatingMessageId) ? { originatingMessageId: text(data.originatingMessageId) } : {}),
            ...(toolCallIds === undefined ? {} : { toolCallIds }),
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
          const originatingMessageId = this.components.toolOrigin(toolCallId);
          this.tools.set(toolCallId, name);
          this.emit(UserEvent.parse({ ...base, kind: "tool.start", data: { toolCallId, name: redact(name, 200),
            ...(originatingMessageId ? { originatingMessageId } : {}),
            text: "Tool arguments remain in the original client; review permission requests before approving." } }));
          break;
        }
        case "tool.execution_partial_result":
        case "tool.execution_complete": {
          const toolCallId = text(data.toolCallId);
          const originatingMessageId = this.components.toolOrigin(toolCallId);
          const name = (this.tools.get(toolCallId) ?? "").split(/[.:]/).at(-1) ?? "";
          const visible = ["powershell", "bash", "shell", "read_powershell", "read_bash", "rg", "glob", "view", "read_file"].includes(name);
          const complete = event.type === "tool.execution_complete";
          const result = record(data.result), error = record(data.error);
          const chunk = complete ? text(result.detailedContent ?? result.content) || text(error.message) : text(data.partialOutput);
          const whole = complete ? chunk : ((this.partialTools.get(toolCallId) ?? "") + chunk).slice(-32_000);
          if (complete) this.partialTools.delete(toolCallId); else this.partialTools.set(toolCallId, whole);
          this.emit(UserEvent.parse({ ...base, kind: "tool.output", data: {
            toolCallId, text: visible ? redact(whole, 32_000) : "Tool details remain in the original client.",
            ...(originatingMessageId ? { originatingMessageId } : {}),
            complete, ...(typeof data.success === "boolean" ? { success: data.success } : {}),
          } }));
          break;
        }
        case "permission.requested": {
          const projected = livePermission(data);
          this.permissionSnapshotChanges?.add(projected.request.requestId);
          this.livePermissions.set(projected.request.requestId, projected);
          this.requests.set(projected.request.requestId, projected.request);
          this.permissionIds.add(projected.request.requestId);
          if (!historical) this.emitRequests(event.id, event.timestamp);
          break;
        }
        case "permission.completed":
        case "user_input.completed":
        case "elicitation.completed":
          if (!historical && event.type !== "permission.completed")
            this.forgetQuestion(text(data.requestId), `question:${hash(event.id)}`, event.timestamp);
          this.permissionSnapshotChanges?.add(text(data.requestId));
          this.requests.delete(text(data.requestId));
          this.permissionIds.delete(text(data.requestId));
          this.livePermissions.delete(text(data.requestId));
          this.elicitationFields.delete(text(data.requestId));
          if (!historical) this.emitRequests(event.id, event.timestamp);
          break;
        case "user_input.requested": {
          if (historical) break;
          const requestId = RequestId.parse(data.requestId);
          this.elicitationFields.delete(requestId);
          const parsed = userQuestion.safeParse(data);
          const question = parsed.success ? parsed.data : undefined;
          const detail = question ? redact(question.question, 12_000) : "This unsupported or incomplete question requires the original client.";
          const choices = (question?.choices ?? []).map((choice) => redact(choice, 1000));
          const allowFreeform = question !== undefined && (question.allowFreeform ?? choices.length === 0);
          const item = PendingRequest.parse({
            requestId, type: question ? "question" : "terminal", title: "GitHub Copilot needs your answer",
            detail, choices, allowFreeform,
            supported: question !== undefined && detail === question.question && (allowFreeform || choices.length > 0) &&
              choices.every((choice, index) => choice === question.choices?.[index]),
          });
          this.requests.set(item.requestId, item);
          this.rememberQuestion(item, event);
          if (!historical) this.emitRequests(event.id, event.timestamp);
          break;
        }
        case "elicitation.requested": {
          if (historical) break;
          const requestId = RequestId.parse(data.requestId);
          this.elicitationFields.delete(requestId);
          const parsed = elicitationRequest.safeParse(data);
          const form = parsed.success ? parsed.data : undefined;
          const schema = form?.requestedSchema;
          const fields = Object.entries(schema?.properties ?? {});
          const required = schema?.required ?? [];
          const candidates = fields.filter(([, value]) => value.enum !== undefined);
          const primary = fields.length === 1 ? fields[0] : candidates.length === 1 ? candidates[0] : undefined;
          const field = primary?.[1];
          const choices = field?.enum ?? [];
          const alternate = primary ? fields.find(([name, value]) => name !== primary[0] && !value.enum) : undefined;
          const alternateChoice = alternate ? choices.find((choice) => /^(other|other \(.*\)|其他|其它)$/i.test(choice)) : undefined;
          const detail = [form?.elicitationSource ? `Source: ${form.elicitationSource}` : undefined,
            form?.message, schema ? `Form definition (defaults are informational):\n${JSON.stringify(schema, null, 2)}` : undefined]
            .filter(Boolean).join("\n");
          const simple = form && schema && primary && field && (fields.length === 1 ||
            (fields.length === 2 && alternate && alternateChoice && !required.includes(alternate[0]))) &&
            required.every((name) => name === primary[0]) && detail.length <= 12_000 &&
            redact(detail, 12_000) === detail && choices.every((choice) => redact(choice, 1000) === choice);
          if (simple) {
            const item = PendingRequest.parse({
              requestId, type: "question", title: redact(field.title || "GitHub Copilot needs your answer", 500),
              detail,
              choices: alternateChoice ? choices.filter((choice) => choice !== alternateChoice) : choices,
              allowFreeform: choices.length === 0 || !!alternateChoice, supported: typeof this.session.rpc?.ui?.handlePendingElicitation === "function",
            });
            this.elicitationFields.set(requestId, {
              field: primary[0], minLength: field.minLength ?? 0, maxLength: Math.min(8000, field.maxLength ?? 8000),
              ...(alternate && alternateChoice ? {
                alternateField: alternate[0], alternateChoice,
                alternateMinLength: alternate[1].minLength ?? 0, alternateMaxLength: Math.min(8000, alternate[1].maxLength ?? 8000),
              } : {}),
            });
            this.requests.set(requestId, item);
          } else {
            this.requests.set(requestId, {
              requestId, type: "terminal", title: "Structured request",
              detail: "This form or URL request requires the original client. It will not be auto-accepted.",
              choices: [], allowFreeform: false, supported: false,
            });
          }
          this.rememberQuestion(this.requests.get(requestId)!, event);
          this.emitRequests(event.id, event.timestamp);
          break;
        }
        case "exit_plan_mode.requested":
        case "session_limits_exhausted.requested":
          if (historical) break;
          this.requests.set(text(data.requestId), {
            requestId: text(data.requestId), type: "terminal", title: event.type,
            detail: "This structured request requires the original client. DevPocket will not auto-accept it.",
            choices: [], allowFreeform: false, supported: false,
          });
          if (!historical) this.emitRequests(event.id, event.timestamp);
          break;
        case "session.idle":
          if (!historical) {
            this.cancelRequested = false;
            this.observedActiveWork = false;
            this.activityRevision++;
          }
          this.emit({ ...base, kind: "runtime.state", data: {
            state: "idle", ...(typeof data.aborted === "boolean" ? { aborted: data.aborted } : {}),
          } });
          break;
        case "assistant.turn_start":
          if (!historical) {
            // Lifecycle events update display state, not probe-gated control capabilities.
            this.observedActiveWork = true;
            this.activityRevision++;
          }
          this.emit({ ...base, kind: "runtime.state", data: {
            state: this.cancelRequested && !historical ? "cancel_requested" : "running",
          } });
          break;
        case "session.error":
          this.notice("RUNTIME_ERROR", text(data.message) || "GitHub Copilot reported an error. Inspect the original client.");
          break;
        default:
          if (!historical && event.type.endsWith(".requested") && text(data.requestId)) {
            this.requests.set(text(data.requestId), {
              requestId: text(data.requestId), type: "terminal", title: event.type,
              detail: "This runtime request is not supported on the phone. Review it in the original client.",
              choices: [], allowFreeform: false, supported: false,
            });
            this.emitRequests(event.id, event.timestamp);
          } else if (!historical && event.type.endsWith(".completed") && text(data.requestId)) {
            this.requests.delete(text(data.requestId));
            this.emitRequests(event.id, event.timestamp);
          }
      }
      for (const component of components) this.emit(UserEvent.parse(component));
    } catch {
      this.notice("EVENT_UNSUPPORTED", `Unsupported ${event.type} data. Review the original client.`);
    }
  }

  async models(): Promise<ModelItem[]> {
    await this.refreshGroup("models");
    if (!this.summary.capabilities.models)
      throw new Fault("UNSUPPORTED", "Model controls require a supported live model state and catalogue. Use the original client.", 409);
    return this.modelItems;
  }

  async execute(action: Action, attachments: LocalAttachment[] = [], commandId?: string,
    componentAttachment?: ReferencedComponentAttachment): Promise<Omit<Receipt, "commandId">> {
    if (commandId !== undefined) Id.parse(commandId);
    const rpc = this.session.rpc ?? {};
    const capability = actionCapability[action.type];
    if (capability) {
      await this.refreshGroup(capabilityGroup[capability]);
      if (!this.summary.capabilities[capability])
        throw new Fault("UNSUPPORTED", `This runtime does not expose the required ${capability} capability. Use the original client.`, 409);
    }
    switch (action.type) {
      case "message": {
        if (!action.text.trim()) throw new Fault("EMPTY_MESSAGE", "Message cannot be blank.");
        if (attachments.length !== action.attachmentIds.length) throw new Fault("ATTACHMENT_MISSING", "Resolve every attachment before sending.");
        if (typeof this.session.send !== "function") throw new Fault("UNSUPPORTED", "Message sending is unavailable.", 409);
        const files = [...attachments];
        if (action.componentReference) {
          this.components.referenceContent(action.componentReference);
          if (!componentAttachment || componentAttachment.reference.componentId !== action.componentReference.componentId ||
              componentAttachment.reference.sha256 !== action.componentReference.sha256)
            throw new Fault("COMPONENT_REFERENCE_NOT_STAGED", "The exact referenced component must be staged before sending.");
          if (files.length >= 4) throw new Fault("TOO_MANY_ATTACHMENTS", "A message supports four attachments including its referenced component.");
          files.push(componentAttachment.file);
        } else if (componentAttachment) throw new Fault("COMPONENT_REFERENCE_MISMATCH", "An unrequested component attachment cannot be sent.");
        const messageId = RequestId.parse(await this.session.send({ prompt: action.text, mode: "enqueue", source: "user", attachments: files }));
        const queue = await this.probe("Message queue", () => rpc.queue?.pendingItems?.(), messageQueue.parse);
        const queued = queue?.items.some((item) => item.messageId === messageId);
        const status = queued ? "queued" : queue?.withdrawableTurnMessageId === messageId ? "processing" : "admitted";
        return { status, result: { messageId, delivery: "enqueue" } };
      }
      case "abort": {
        const abort = this.session.abort;
        if (typeof abort !== "function") throw new Fault("UNSUPPORTED", "Cancellation is unavailable.", 409);
        this.cancelRequested = true;
        this.emit({ id: randomUUID(), at: new Date().toISOString(), kind: "runtime.state", data: { state: "cancel_requested" } });
        const [queue] = await Promise.all([
          this.probe("Message queue", () => rpc.queue?.pendingItems?.(), messageQueue.parse),
          Promise.resolve().then(() => abort.call(this.session)).then((result) => z.undefined().parse(result)),
        ]);
        const cancelledMessageIds = queue?.items.flatMap((item) => item.messageId ? [item.messageId] : []) ?? [];
        return { status: "cancel_requested", result: { acknowledged: true, stopped: false, cancelledMessageIds } };
      }
      case "permission": {
        const item = this.requests.get(action.requestId);
        if (!item) throw new Fault("REQUEST_STALE", "The request was already answered or is no longer pending.", 409);
        if (!item.supported || item.type !== "permission" || typeof rpc.permissions?.handlePendingPermissionRequest !== "function")
          throw new Fault("TERMINAL_REQUIRED", "Review this permission in the original client.", 409);
        const result = requestResolution.parse(await rpc.permissions.handlePendingPermissionRequest({
          requestId: action.requestId, result: { kind: action.decision },
        }));
        if (result.success !== true) throw new Fault("REQUEST_STALE", "Another client already resolved this request.", 409);
        this.permissionSnapshotChanges?.add(action.requestId);
        this.requests.delete(action.requestId);
        this.permissionIds.delete(action.requestId);
        this.livePermissions.delete(action.requestId);
        this.emitRequests();
        return { status: "completed", result: { resolved: true } };
      }
      case "answer": {
        const item = this.requests.get(action.requestId);
        if (!item) throw new Fault("REQUEST_STALE", "Question is no longer pending or predates attachment. Use the original client.", 409);
        const form = this.elicitationFields.get(action.requestId);
        if (item.type !== "question" || !item.supported || (!form && typeof rpc.ui?.handlePendingUserInput !== "function"))
          throw new Fault("TERMINAL_REQUIRED", "This request must be answered in the original client.", 409);
        if (!item.allowFreeform && !item.choices.includes(action.answer))
          throw new Fault("INVALID_CHOICE", "Choose an exact answer offered by the runtime.");
        const question = this.questions.get(action.requestId);
        const visibleAnswer = redact(action.answer, 8000);
        const confirmedEvent = question ? UserEvent.parse({
          id: randomUUID(), at: new Date().toISOString(), kind: "question", data: {
            ...question, status: "confirmed", answer: visibleAnswer.trim() ? visibleAnswer : "[REDACTED]",
            ...(commandId ? { commandId } : {}),
          },
        }) : undefined;
        let raw: unknown;
        if (form) {
          if (typeof rpc.ui?.handlePendingElicitation !== "function")
            throw new Fault("TERMINAL_REQUIRED", "This request must be answered in the original client.", 409);
          const alternate = !item.choices.includes(action.answer) && form.alternateField && form.alternateChoice;
          const minLength = alternate ? form.alternateMinLength ?? 0 : form.minLength;
          const maxLength = alternate ? form.alternateMaxLength ?? 8000 : form.maxLength;
          const answerLength = Array.from(action.answer).length;
          if (answerLength < minLength || answerLength > maxLength)
            throw new Fault("INVALID_ANSWER", "The answer is outside this form's supported length range.");
          const content = alternate && form.alternateField && form.alternateChoice
            ? { [form.field]: form.alternateChoice, [form.alternateField]: action.answer } : { [form.field]: action.answer };
          raw = await rpc.ui.handlePendingElicitation({ requestId: action.requestId, result: { action: "accept", content } });
        } else {
          raw = await rpc.ui!.handlePendingUserInput!({ requestId: action.requestId,
            response: { answer: action.answer, wasFreeform: !item.choices.includes(action.answer) } });
        }
        const result = requestResolution.parse(raw);
        if (result.success !== true) {
          if (this.requests.get(action.requestId) === item) {
            this.forgetQuestion(action.requestId);
            this.requests.delete(action.requestId);
            this.elicitationFields.delete(action.requestId);
            this.emitRequests();
          }
          throw new Fault("REQUEST_STALE", "Another client already answered this question.", 409);
        }
        // A completion or a replacement request may arrive while the RPC is in flight.
        if (this.questions.get(action.requestId) === question) this.questions.delete(action.requestId);
        if (this.requests.get(action.requestId) === item) {
          this.requests.delete(action.requestId);
          this.elicitationFields.delete(action.requestId);
        }
        try {
          if (commandId) this.persistConfirmedAnswer?.(commandId, confirmedEvent);
          if (confirmedEvent && !this.closed) this.emit(confirmedEvent);
          this.emitRequests();
        } catch (error) {
          throw new Error("The runtime confirmed the answer, but its history projection could not complete.", { cause: error });
        }
        return { status: "completed", result: { resolved: true } };
      }
      case "models":
        return { status: "completed", result: { models: this.modelItems, current: {
          modelId: this.summary.modelId, reasoningEffort: this.summary.reasoningEffort,
        } } };
      case "model.set": {
        const model = this.modelItems.find((item) => item.id === action.modelId);
        if (!model?.enabled || typeof rpc.model?.switchTo !== "function") throw new Fault("MODEL_UNAVAILABLE", "GitHub Copilot does not allow this model.", 409);
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
        if (result.confirmation) throw new Fault("TERMINAL_REQUIRED", "Model switch needs compaction confirmation in the original client.", 409);
        // A read started during switchTo may still contain the previous model.
        await this.refreshInFlight.get("models");
        await this.refreshGroup("models");
        if (result.deferred) this.notice("MODEL_SWITCH_DEFERRED",
          "The original runtime queued this model switch. The displayed model changes only after a live read confirms it.");
        return { status: "completed", result: {
          modelId: text(result.modelId) || this.summary.modelId, deferred: result.deferred === true,
          message: redact(text(result.message), 2000), reasoningEffort: this.summary.reasoningEffort,
        } };
      }
      case "refresh": {
        await this.refresh();
        this.requestsHash = "";
        this.emitRequests();
        return { status: "completed", result: { summary: Json.parse(this.summary), requests: Json.parse(this.visibleRequests()) } };
      }
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
    this.projectAbort?.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
