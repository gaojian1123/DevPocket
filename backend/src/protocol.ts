import { z } from "zod";
import { COMPONENT_VERSION, MAX_COMPONENT_BYTES, ComponentError, parseComponentSpec, utf16String, type ComponentSpec } from "@devpocket/components";
import { hash } from "./security.js";

export { utf16String };

export const VERSION = "0.1.0";
export const PROTOCOL = 1;
export const MAX_UPLOAD = 2 * 1024 * 1024;
export const MAX_PREVIEW = 256 * 1024;
// Protocol v1 accepts UUID-shaped IDs without restricting version or variant bits.
export const Id = z.guid();
export const RequestId = utf16String(200).min(1);
export const ErrorInfo = z.object({ code: utf16String(80), message: utf16String(2000) }).strict();
export const FirebaseInstallationId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const PushRegistration = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("fcm"), token: utf16String(4096).min(20).nullable() }).strict(),
  z.object({ provider: z.literal("fcm-fid"), fid: FirebaseInstallationId.nullable() }).strict(),
]);
export type PushRegistration = z.infer<typeof PushRegistration>;
export type PushTarget = { kind: "token" | "fid"; value: string };
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const Json: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(Json), z.record(z.string(), Json),
]));
export const JsonObject = z.record(z.string(), Json);
export const Capabilities = z.object({
  messages: z.boolean(), abort: z.boolean(), permissions: z.boolean(), questions: z.boolean(),
  models: z.boolean(), files: z.boolean(), git: z.boolean(),
}).strict();
export const RuntimeState = z.enum(["idle", "running", "waiting", "cancel_requested", "unsupported", "offline"]);
export const Workspace = z.object({
  name: utf16String(120).min(1),
  branch: utf16String(200),
}).strict();
export const SessionSummary = z.object({
  sessionId: Id,
  projectId: utf16String(120).min(1),
  projectName: utf16String(120).min(1),
  workspace: Workspace.optional(),
  title: utf16String(160),
  cliVersion: utf16String(80),
  state: RuntimeState,
  permissionMode: utf16String(80),
  modelId: utf16String(200),
  reasoningEffort: utf16String(60),
  capabilities: Capabilities,
  warnings: z.array(utf16String(500)).max(20),
  registeredAt: z.number().int().nonnegative(),
  componentVersion: z.literal(COMPONENT_VERSION).optional(),
}).strict();
export type SessionSummary = z.infer<typeof SessionSummary>;
export type SessionInfo = SessionSummary & {
  hostId: string; online: boolean; pinned: boolean; archived: boolean; lastSeen: number;
};
export const RelayReady = z.object({
  type: z.literal("ready"), protocol: z.literal(PROTOCOL), hostId: Id, sessionId: Id,
  workspaceMetadata: z.literal(true).optional(),
  questionHistory: z.literal(true).optional(),
  components: z.literal(true).optional(),
}).strict();

export const PendingRequest = z.object({
  requestId: RequestId,
  type: z.enum(["permission", "question", "terminal"]),
  title: utf16String(500),
  detail: utf16String(12_000),
  permissionKind: utf16String(80).optional(),
  choices: z.array(utf16String(1000)).max(50),
  allowFreeform: z.boolean(),
  supported: z.boolean(),
}).strict();
export type PendingRequest = z.infer<typeof PendingRequest>;

const questionBase = {
  questionId: RequestId,
  request: PendingRequest.extend({ type: z.literal("question") }),
};
export const QuestionRecord = z.discriminatedUnion("status", [
  z.object({ ...questionBase, status: z.literal("pending") }).strict(),
  z.object({ ...questionBase, status: z.literal("unknown") }).strict(),
  z.object({ ...questionBase, status: z.literal("confirmed"), answer: utf16String(8000).min(1),
    commandId: Id.optional() }).strict(),
]);
export type QuestionRecord = z.infer<typeof QuestionRecord>;

export const ComponentReference = z.object({
  componentId: RequestId,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ComponentReference = z.infer<typeof ComponentReference>;
export const MAX_COMPONENT_PAYLOAD = Math.ceil(MAX_COMPONENT_BYTES / 3) * 4;

// Preserve the exact JSON bytes across native decoders without reserializing numbers or Unicode for the digest.
export function decodeComponentPayload(payload: string, sha256: string): ComponentSpec {
  if (payload.length > MAX_COMPONENT_PAYLOAD) throw new ComponentError("COMPONENT_TOO_LARGE", "Component payload is too large.");
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length > MAX_COMPONENT_BYTES || bytes.toString("base64") !== payload || hash(bytes) !== sha256)
    throw new ComponentError("COMPONENT_INVALID", "Component bytes do not match their declared identity.");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
    throw new ComponentError("COMPONENT_INVALID", "Component payload is not valid UTF-8 JSON.");
  }
  return parseComponentSpec(value);
}

const componentBase = {
  componentId: RequestId,
  toolCallId: RequestId,
  version: z.literal(COMPONENT_VERSION),
  originatingMessageId: RequestId.optional(),
};
export const ComponentRecord = z.discriminatedUnion("status", [
  z.object({
    ...componentBase, status: z.literal("ready"), sha256: ComponentReference.shape.sha256,
    encoding: z.literal("base64-json"), payload: utf16String(MAX_COMPONENT_PAYLOAD), redacted: z.boolean(),
  }).strict(),
  z.object({
    ...componentBase, status: z.literal("unavailable"), error: ErrorInfo,
  }).strict(),
]).superRefine((value, context) => {
  if (value.status !== "ready") return;
  try { decodeComponentPayload(value.payload, value.sha256); }
  catch (error) {
    if (!(error instanceof ComponentError)) throw error;
    context.addIssue({ code: z.ZodIssueCode.custom, message: error.message });
  }
});
export type ComponentRecord = z.infer<typeof ComponentRecord>;

const filePath = utf16String(1000);
export const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), text: utf16String(32_000).min(1),
    attachmentIds: z.array(Id).max(4).default([]), componentReference: ComponentReference.optional() }).strict(),
  z.object({ type: z.literal("abort") }).strict(),
  z.object({ type: z.literal("permission"), requestId: RequestId,
    decision: z.enum(["approve-once", "reject"]) }).strict(),
  z.object({ type: z.literal("answer"), requestId: RequestId, answer: utf16String(8000).min(1) }).strict(),
  z.object({ type: z.literal("models") }).strict(),
  z.object({ type: z.literal("model.set"), modelId: utf16String(200).min(1),
    reasoningEffort: utf16String(60).min(1).nullable().optional() }).strict(),
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
    messageId: RequestId, content: utf16String(64_000),
    attachments: z.array(utf16String(200)).max(20),
  }).strict() }).strict(),
  z.object({ ...eventBase, kind: z.literal("assistant.message"), data: z.object({
    messageId: RequestId, content: utf16String(64_000), originatingMessageId: RequestId.optional(),
    toolCallIds: z.array(RequestId).max(128).optional(),
  }).strict() }).strict(),
  z.object({ ...eventBase, kind: z.literal("assistant.delta"), data: z.object({
    messageId: RequestId, content: utf16String(16_000),
  }).strict() }).strict(),
  z.object({ ...eventBase, kind: z.literal("tool.start"), data: z.object({
    toolCallId: RequestId, name: utf16String(200), text: utf16String(12_000),
    originatingMessageId: RequestId.optional(),
  }).strict() }).strict(),
  z.object({ ...eventBase, kind: z.literal("tool.output"), data: z.object({
    toolCallId: RequestId, text: utf16String(32_000), complete: z.boolean(), success: z.boolean().optional(),
    originatingMessageId: RequestId.optional(),
  }).strict() }).strict(),
  z.object({ ...eventBase, kind: z.literal("requests"), data: z.object({
    items: z.array(PendingRequest).max(100),
  }).strict() }).strict(),
  z.object({ ...eventBase, kind: z.literal("question"), data: QuestionRecord }).strict(),
  z.object({ ...eventBase, kind: z.literal("component"), data: ComponentRecord }).strict(),
  z.object({ ...eventBase, kind: z.literal("runtime.state"), data: z.object({
    state: RuntimeState, aborted: z.boolean().optional(),
  }).strict() }).strict(),
  z.object({ ...eventBase, kind: z.literal("delivery"), data: Receipt }).strict(),
  z.object({ ...eventBase, kind: z.literal("notice"), data: z.object({
    code: utf16String(80), message: utf16String(2000),
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
  title: utf16String(160, z.string().trim()).min(1).optional(),
  pinned: z.boolean().optional(), archived: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
export const allowedMime = new Set(["text/plain", "application/json", "application/pdf", "image/png", "image/jpeg", "image/webp"]);
export const finalStatus = (status: DeliveryStatus): boolean =>
  ["completed", "failed", "uncertain", "cancelled"].includes(status);
