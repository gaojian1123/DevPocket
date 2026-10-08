import { z } from "zod";

export const VERSION = "0.1.0";
export const PROTOCOL = 1;
export const MAX_UPLOAD = 2 * 1024 * 1024;
export const MAX_PREVIEW = 256 * 1024;
export const Id = z.string().uuid();
export const RequestId = z.string().min(1).max(200);
export const ErrorInfo = z.object({ code: z.string().max(80), message: z.string().max(2000) }).strict();
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const Json: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(Json), z.record(Json),
]));
export const JsonObject = z.record(Json);
export const Capabilities = z.object({
  messages: z.boolean(), abort: z.boolean(), permissions: z.boolean(), questions: z.boolean(),
  models: z.boolean(), files: z.boolean(), git: z.boolean(),
}).strict();
export const RuntimeState = z.enum(["idle", "running", "waiting", "cancel_requested", "unsupported", "offline"]);
export const Workspace = z.object({
  name: z.string().min(1).max(120),
  branch: z.string().max(200),
}).strict();
export const SessionSummary = z.object({
  sessionId: Id,
  projectId: z.string().min(1).max(120),
  projectName: z.string().min(1).max(120),
  workspace: Workspace.optional(),
  title: z.string().max(160),
  cliVersion: z.string().max(80),
  state: RuntimeState,
  permissionMode: z.string().max(80),
  modelId: z.string().max(200),
  reasoningEffort: z.string().max(60),
  capabilities: Capabilities,
  warnings: z.array(z.string().max(500)).max(20),
  registeredAt: z.number().int().nonnegative(),
}).strict();
export type SessionSummary = z.infer<typeof SessionSummary>;
export type SessionInfo = SessionSummary & {
  hostId: string; online: boolean; pinned: boolean; archived: boolean; lastSeen: number;
};
export const RelayReady = z.object({
  type: z.literal("ready"), protocol: z.literal(PROTOCOL), hostId: Id, sessionId: Id,
  workspaceMetadata: z.literal(true).optional(),
}).strict();

export const PendingRequest = z.object({
  requestId: RequestId,
  type: z.enum(["permission", "question", "terminal"]),
  title: z.string().max(500),
  detail: z.string().max(12_000),
  permissionKind: z.string().max(80).optional(),
  choices: z.array(z.string().max(1000)).max(50),
  allowFreeform: z.boolean(),
  supported: z.boolean(),
}).strict();
export type PendingRequest = z.infer<typeof PendingRequest>;

const filePath = z.string().max(1000);
export const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), text: z.string().min(1).max(32_000),
    attachmentIds: z.array(Id).max(4).default([]) }).strict(),
  z.object({ type: z.literal("abort") }).strict(),
  z.object({ type: z.literal("permission"), requestId: RequestId,
    decision: z.enum(["approve-once", "reject"]) }).strict(),
  z.object({ type: z.literal("answer"), requestId: RequestId, answer: z.string().min(1).max(8000) }).strict(),
  z.object({ type: z.literal("models") }).strict(),
  z.object({ type: z.literal("model.set"), modelId: z.string().min(1).max(200),
    reasoningEffort: z.string().min(1).max(60).nullable().optional() }).strict(),
  z.object({ type: z.literal("files.list"), path: filePath }).strict(),
  z.object({ type: z.literal("files.read"), path: filePath.min(1) }).strict(),
  z.object({ type: z.literal("git.status") }).strict(),
  z.object({ type: z.literal("git.diff"), path: filePath.min(1), staged: z.boolean() }).strict(),
  z.object({ type: z.literal("refresh") }).strict(),
]);
export type Action = z.infer<typeof Action>;
export const actionCapability = {
  message: "messages", abort: "abort", permission: "permissions", answer: "questions",
  models: "models", "model.set": "models",
  "files.list": "files", "files.read": "files", "git.status": "git", "git.diff": "git",
  refresh: undefined,
} as const satisfies Record<Action["type"], keyof z.infer<typeof Capabilities> | undefined>;
export const Command = z.object({ commandId: Id, action: Action }).strict();
export type Command = z.infer<typeof Command>;
export const DeliveryStatus = z.enum([
  "dispatched", "admitted", "queued", "processing", "cancel_requested", "completed", "failed", "uncertain", "cancelled",
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;
export const Receipt = z.object({
  commandId: Id, status: DeliveryStatus, result: JsonObject.optional(), error: ErrorInfo.optional(),
}).strict();
export type Receipt = z.infer<typeof Receipt>;

const eventBase = { id: RequestId, at: z.string().datetime() };
export const UserEvent = z.discriminatedUnion("kind", [
  z.object({ ...eventBase, kind: z.literal("user.message"), data: z.object({
    messageId: RequestId, content: z.string().max(64_000),
    attachments: z.array(z.string().max(200)).max(20),
  }).strict() }).strict(),
  z.object({ ...eventBase, kind: z.literal("assistant.message"), data: z.object({
    messageId: RequestId, content: z.string().max(64_000), originatingMessageId: RequestId.optional(),
  }).strict() }).strict(),
  z.object({ ...eventBase, kind: z.literal("assistant.delta"), data: z.object({
    messageId: RequestId, content: z.string().max(16_000),
  }).strict() }).strict(),
  z.object({ ...eventBase, kind: z.literal("tool.start"), data: z.object({
    toolCallId: RequestId, name: z.string().max(200), text: z.string().max(12_000),
  }).strict() }).strict(),
  z.object({ ...eventBase, kind: z.literal("tool.output"), data: z.object({
    toolCallId: RequestId, text: z.string().max(32_000), complete: z.boolean(), success: z.boolean().optional(),
  }).strict() }).strict(),
  z.object({ ...eventBase, kind: z.literal("requests"), data: z.object({
    items: z.array(PendingRequest).max(100),
  }).strict() }).strict(),
  z.object({ ...eventBase, kind: z.literal("runtime.state"), data: z.object({
    state: RuntimeState, aborted: z.boolean().optional(),
  }).strict() }).strict(),
  z.object({ ...eventBase, kind: z.literal("delivery"), data: Receipt }).strict(),
  z.object({ ...eventBase, kind: z.literal("notice"), data: z.object({
    code: z.string().max(80), message: z.string().max(2000),
  }).strict() }).strict(),
]);
export type UserEvent = z.infer<typeof UserEvent>;
export type WireEvent = UserEvent & { cursor: number; hostId: string; sessionId: string };
export type EventPage = { events: WireEvent[]; cursor: number; hasMore: boolean; reset: boolean };
export const HostFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), protocol: z.literal(PROTOCOL), summary: SessionSummary }).strict(),
  z.object({ type: z.literal("summary"), summary: SessionSummary }).strict(),
  z.object({ type: z.literal("events"), items: z.array(UserEvent).max(200) }).strict(),
  z.object({ type: z.literal("result"), ...Receipt.shape }).strict(),
]);
export const MetadataPatch = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  pinned: z.boolean().optional(), archived: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
export const allowedMime = new Set(["text/plain", "application/json", "application/pdf", "image/png", "image/jpeg", "image/webp"]);
export const finalStatus = (status: DeliveryStatus): boolean =>
  ["completed", "failed", "uncertain", "cancelled"].includes(status);
