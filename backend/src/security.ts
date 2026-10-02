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

export function redact(value: string, limit = 64_000): string {
  const clean = value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/(?:github_pat_|gh[pousr]_|dp[hdp]_)[A-Za-z0-9_]*/g, "[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token|cookie)\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1[REDACTED]");
  return clean.length <= limit ? clean : clean.slice(0, Math.max(0, limit - 28)) + "\n[truncated; use terminal]";
}
