import { z } from "zod";

export const COMPONENT_VERSION = 1;
export const MAX_COMPONENT_BYTES = 256 * 1024;
export const MAX_TABLE_ROWS = 1000;
export const MAX_TABLE_COLUMNS = 20;
export const MAX_CHART_POINTS = 1000;

export type ComponentFailure = "COMPONENT_UNSUPPORTED" | "COMPONENT_INVALID" | "COMPONENT_TOO_LARGE";

export class ComponentError extends Error {
  constructor(readonly code: ComponentFailure, message: string) {
    super(message);
    this.name = "ComponentError";
  }
}

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const field = z.string().min(1).max(120)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value) &&
    !["__proto__", "prototype", "constructor"].includes(value), "Unsupported field name.");
const scalar = z.union([z.string().max(8000), z.number().finite(), z.boolean(), z.null()]);
const row = z.record(field, scalar);
const metadata = {
  title: z.string().max(200).optional(),
  source: z.string().max(2000).optional(),
  query: z.string().max(12_000).optional(),
};
const chart = {
  ...metadata,
  xAxisKey: field,
  yAxisLabel: z.string().max(200).optional(),
  data: z.array(row).max(MAX_CHART_POINTS),
  series: z.array(z.object({
    dataKey: field,
    name: z.string().min(1).max(200),
    color: z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i).optional(),
  }).strict()).min(1).max(MAX_CHART_POINTS),
};

const column = z.object({
  key: field,
  label: z.string().min(1).max(200),
  type: z.enum(["string", "number", "date", "link"]).optional(),
  align: z.enum(["left", "right", "center"]).optional(),
  hrefKey: field.optional(),
  href: z.string().max(2000).optional(),
}).strict();

const shape = z.discriminatedUnion("type", [
  z.object({ type: z.literal("line"), ...chart }).strict(),
  z.object({ type: z.literal("bar"), ...chart }).strict(),
  z.object({
    type: z.literal("datagrid"),
    ...metadata,
    columns: z.array(column).min(1).max(MAX_TABLE_COLUMNS),
    rows: z.array(row).max(MAX_TABLE_ROWS),
    pageSize: z.number().int().min(1).max(100).optional(),
  }).strict(),
  z.object({
    type: z.literal("markdown"),
    title: metadata.title,
    content: z.string().max(MAX_COMPONENT_BYTES),
  }).strict(),
]);

export type ComponentSpec = z.infer<typeof shape>;
export type ChartSpec = Extract<ComponentSpec, { type: "line" | "bar" }>;
export type TableSpec = Extract<ComponentSpec, { type: "datagrid" }>;
export type TableColumn = TableSpec["columns"][number];
export type CellValue = z.infer<typeof scalar>;

export function sortableDate(value: CellValue): number | null {
  if (typeof value !== "number" && (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))) return null;
  if (typeof value === "string") {
    const calendar = value.slice(0, 10), midnight = new Date(`${calendar}T00:00:00Z`);
    if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== calendar) return null;
  }
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15 ? timestamp : null;
}

const encoder = new TextEncoder();
export const componentBytes = (spec: ComponentSpec): number =>
  encoder.encode(JSON.stringify(spec)).byteLength;

export const ComponentSpecSchema = shape.superRefine((spec, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (componentBytes(spec) > MAX_COMPONENT_BYTES) issue("Component data exceeds 256 KiB.");
  if (spec.type === "line" || spec.type === "bar") {
    if (spec.data.length * spec.series.length > MAX_CHART_POINTS)
      issue("The chart exceeds 1,000 values across its series.");
    const keys = spec.series.map((series) => series.dataKey);
    if (new Set(keys).size !== keys.length || keys.includes(spec.xAxisKey))
      issue("Chart fields must be distinct.");
    const referenced = new Set([spec.xAxisKey, ...keys]);
    for (const value of spec.data) {
      if (!own(value, spec.xAxisKey) || !["string", "number"].includes(typeof value[spec.xAxisKey]))
        issue("Every chart row needs a string or number category.");
      if (keys.some((key) => !own(value, key) || (value[key] !== null && typeof value[key] !== "number")))
        issue("Every chart series needs a finite number or an explicit null in each row.");
      if (Object.keys(value).some((key) => !referenced.has(key)))
        issue("Chart rows contain fields not described by the supported configuration.");
    }
  }
  if (spec.type === "datagrid") {
    const keys = spec.columns.map((item) => item.key);
    if (new Set(keys).size !== keys.length) issue("Table column keys must be unique.");
    const referenced = new Set([...keys, ...spec.columns.flatMap((item) => item.hrefKey ? [item.hrefKey] : [])]);
    for (const item of spec.columns) {
      if ((item.href || item.hrefKey) && item.type !== "link") issue("Link targets require a link column.");
      if (item.href && item.hrefKey) issue("A link column cannot have two target definitions.");
      if (item.href) {
        const placeholders = [...item.href.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!);
        for (const name of placeholders) {
          if (name !== "value" && !field.safeParse(name).success) issue("Invalid link placeholder.");
          if (name !== "value") referenced.add(name);
        }
      }
    }
    for (const value of spec.rows) {
      if (Object.keys(value).some((key) => !referenced.has(key)))
        issue("Table rows contain fields not described by the supported columns.");
      for (const item of spec.columns) {
        const cell = value[item.key];
        if (item.type === "number" && cell !== undefined && cell !== null && typeof cell !== "number")
          issue("Numeric columns require finite numbers or null.");
        if (item.type === "date" && cell !== undefined && cell !== null && sortableDate(cell) === null)
          issue("Date columns require an ISO date, an offset-qualified timestamp or epoch milliseconds.");
        if (item.hrefKey && own(value, item.hrefKey) && value[item.hrefKey] !== null &&
            typeof value[item.hrefKey] !== "string") issue("Link targets must be strings.");
      }
    }
  }
});

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseComponentSpec(input: unknown): ComponentSpec {
  if (!object(input)) throw new ComponentError("COMPONENT_INVALID", "Component data must be an object.");
  if (!["line", "bar", "datagrid", "markdown"].includes(String(input.type)))
    throw new ComponentError("COMPONENT_UNSUPPORTED", "This component type is not supported on this client.");
  const oversized = (value: unknown, limit: number) => Array.isArray(value) && value.length > limit;
  if (oversized(input.rows, MAX_TABLE_ROWS) || oversized(input.columns, MAX_TABLE_COLUMNS) ||
      oversized(input.data, MAX_CHART_POINTS) || oversized(input.series, MAX_CHART_POINTS) ||
      (Array.isArray(input.data) && Array.isArray(input.series) &&
        input.data.length * input.series.length > MAX_CHART_POINTS) ||
      (typeof input.content === "string" && input.content.length > MAX_COMPONENT_BYTES))
    throw new ComponentError("COMPONENT_TOO_LARGE", "Component data exceeds this client's display limits.");
  const parsed = shape.safeParse(input);
  if (!parsed.success) throw new ComponentError("COMPONENT_INVALID", "Component fields are invalid or unsupported.");
  if (componentBytes(parsed.data) > MAX_COMPONENT_BYTES)
    throw new ComponentError("COMPONENT_TOO_LARGE", "Component data exceeds 256 KiB.");
  const validated = ComponentSpecSchema.safeParse(parsed.data);
  if (!validated.success) throw new ComponentError("COMPONENT_INVALID", "Component data does not match its configuration.");
  return validated.data;
}

export function safeLink(value: string): string | null {
  if (value.length > 2000 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href : null;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return null;
  }
}

export function tableLink(item: TableColumn, value: Record<string, CellValue>): string | null {
  if (item.type !== "link") return null;
  if (item.hrefKey || !item.href) {
    const target = value[item.hrefKey ?? item.key];
    return typeof target === "string" ? safeLink(target) : null;
  }
  let missing = false;
  const target = item.href.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    const fieldName = key === "value" ? item.key : key;
    if (!own(value, fieldName) || value[fieldName] === null) { missing = true; return ""; }
    return encodeURIComponent(String(value[fieldName]));
  });
  return missing ? null : safeLink(target);
}
