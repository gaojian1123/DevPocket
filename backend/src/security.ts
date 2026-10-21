import { createHash, randomBytes } from "node:crypto";

export class Fault extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "Fault";
  }
}

export const hash = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export const secret = (prefix: string): string =>
  `${prefix}_${randomBytes(32).toString("base64url")}`;

export function fileName(value: string): string {
  if (!value || value.length > 120 || /[\\/:*?"<>|\x00-\x1f]/.test(value) ||
    value === "." || value === ".." || /[. ]$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value)) {
    throw new Fault("INVALID_FILE_NAME", "Use a simple file name, not a path or a reserved device name.");
  }
  return value;
}

export function bearer(value: string | undefined): string {
  if (!value || !/^Bearer [A-Za-z0-9_-]{40,160}$/.test(value)) {
    throw new Fault("UNAUTHORIZED", "A valid device or host credential is required.", 401);
  }
  return value.slice(7);
}

export function relayUrl(value: string, allowInsecureLoopback = false): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Fault("INVALID_RELAY_URL", "Use a relay origin without credentials, path, query or fragment.");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLoopback && loopback && url.protocol === "http:")) {
    throw new Fault("TLS_REQUIRED", "The relay must use HTTPS. Only an explicitly enabled loopback test may use HTTP.");
  }
  return url;
}

export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; reset: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  take(key: string, limit: number, windowMs = 60_000): void {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      if (this.buckets.size >= 10_000) {
        for (const [id, item] of this.buckets) if (item.reset <= now) this.buckets.delete(id);
        if (this.buckets.size >= 10_000) throw new Fault("RATE_LIMITED", "Try again later.", 429);
      }
      bucket = { count: 0, reset: now + windowMs };
      this.buckets.set(key, bucket);
    }
    if (++bucket.count > limit) throw new Fault("RATE_LIMITED", "Too many requests. Try again later.", 429);
  }
}

export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof Fault) return { code: error.code, message: error.message };
  return { code: "INTERNAL_ERROR", message: "The operation failed. Inspect the local DevPocket log." };
}

const credentialName = "(?:(?<![a-z0-9])auth(?:orization)?|password|passwd|secret(?:[\\s_.-]*(?:key|value|string|binary))?|" +
  "(?:api|private|access|signing|encryption)[\\s_.-]*key(?:[\\s_.-]*id)?|token|cookie|credentials?)";
const credentialQualifier = "(?=\\s*(?:\\(|\\[|\\{|:)|\\s+[-\\u2013\\u2014]\\s+)";
const credentialField = new RegExp(`${credentialName}(?:$|${credentialQualifier})`, "i");
const credentialAnnotations = "(?:\\s*(?:\\([^\\r\\n()]*\\)|\\[[^\\r\\n\\[\\]]*\\]|\\{[^\\r\\n{}]*\\}))*";
const credentialAssignment = new RegExp(`(${credentialName})${credentialAnnotations}\\s*(?:["']\\s*)?[:=]\\s*`, "gi");

export function isSensitiveFieldName(name: string): boolean {
  const normalized = name.replace(/[\s_.-]/g, "");
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
  return credentialField.test(normalized) || credentialField.test(name.trim()) ||
    /(?:^|[^a-z0-9])(?:password|passwd|secret|credentials?)(?:$|[^a-z0-9])/i.test(words);
}

function redactCredentialAssignments(value: string): string {
  const parts: string[] = [];
  let retainedFrom = 0;
  credentialAssignment.lastIndex = 0;
  for (let match = credentialAssignment.exec(value); match !== null; match = credentialAssignment.exec(value)) {
    const start = credentialAssignment.lastIndex, quote = value[start];
    let end = start, replacement = "[REDACTED]";
    if (quote === '"' || quote === "'") {
      end++;
      let closed = false;
      while (end < value.length) {
        if (value[end] === "\\") { end = Math.min(end + 2, value.length); continue; }
        if (value[end] === quote) {
          if (value[end + 1] === quote) { end += 2; continue; }
          end++;
          closed = true;
          break;
        }
        end++;
      }
      // An unterminated quoted credential must not expose its remaining tail.
      replacement = quote + replacement + (closed ? quote : "");
    } else {
      const terminator = /^auth(?:orization)?$/i.test(match[1]!) ? /[\r\n]/ : /[\r\n,;]/;
      while (end < value.length && !terminator.test(value[end]!)) end++;
    }
    parts.push(value.slice(retainedFrom, start), replacement);
    retainedFrom = end;
    credentialAssignment.lastIndex = end;
  }
  return parts.length ? parts.join("") + value.slice(retainedFrom) : value;
}

export function redact(value: string, limit = 64_000): string {
  const clean = redactCredentialAssignments(value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/(?:github_pat_|gh[pousr]_|dp[hdp]_)[A-Za-z0-9_]*/g, "[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]"));
  const suffix = "\n[truncated; see original client]";
  return clean.length <= limit ? clean : clean.slice(0, Math.max(0, limit - suffix.length)) + suffix;
}
