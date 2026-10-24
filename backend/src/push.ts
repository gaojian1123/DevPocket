import { createPrivateKey, createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Fault } from "./security.js";
import type { PushTarget } from "./protocol.js";

const serviceAccount = z.object({
  type: z.literal("service_account"),
  project_id: z.string().regex(/^[a-z][a-z0-9-]{4,62}[a-z0-9]$/),
  client_email: z.string().email().endsWith(".iam.gserviceaccount.com"),
  private_key: z.string().min(100),
});
type ServiceAccount = z.infer<typeof serviceAccount>;
export type PushNotice = { hostId: string; sessionId: string; eventId: string; kind: "attention" | "status" };
export interface PushSender { send(target: PushTarget, notice: PushNotice): Promise<"sent" | "unregistered"> }
const base64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

export class FcmPush implements PushSender {
  private access?: { token: string; expiresAt: number };
  private tokenRequest?: Promise<string>;
  private constructor(private readonly config: ServiceAccount) {}

  static async fromFile(file: string): Promise<FcmPush> {
    const config = serviceAccount.parse(JSON.parse(await readFile(file, "utf8")));
    createPrivateKey(config.private_key);
    return new FcmPush(config);
  }

  private async token(): Promise<string> {
    if (this.access && this.access.expiresAt > Date.now() + 60_000) return this.access.token;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = this.fetchToken();
    try { return await this.tokenRequest; } finally { this.tokenRequest = undefined; }
  }

  private async fetchToken(): Promise<string> {
    const seconds = Math.floor(Date.now() / 1000);
    const body = `${base64({ alg: "RS256", typ: "JWT" })}.${base64({
      iss: this.config.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token", iat: seconds, exp: seconds + 3600,
    })}`;
    const signature = createSign("RSA-SHA256").update(body).sign(this.config.private_key).toString("base64url");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${body}.${signature}` }),
    });
    if (!response.ok) throw new Fault("FCM_AUTH_FAILED", `FCM authentication failed (${response.status}); inspect server configuration.`, 503);
    const result = z.object({ access_token: z.string().min(1), expires_in: z.number() }).parse(await response.json());
    this.access = { token: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
    return result.access_token;
  }

  async send(target: PushTarget, notice: PushNotice): Promise<"sent" | "unregistered"> {
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${this.config.project_id}/messages:send`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: {
        ...(target.kind === "fid" ? { fid: target.value } : { token: target.value }), data: notice,
        notification: { title: "DevPocket", body: notice.kind === "attention" ? "Your GitHub Copilot session needs attention." : "Your GitHub Copilot session has an update." },
        android: { priority: notice.kind === "attention" ? "high" : "normal", ttl: "300s",
          notification: { channel_id: "devpocket_attention", tag: `${notice.hostId}:${notice.sessionId}`,
            visibility: "PRIVATE", default_sound: true } },
      } }),
    });
    if (response.ok) return "sent";
    const value: unknown = await response.json();
    const parsed = z.object({ error: z.object({ details: z.array(z.object({ errorCode: z.string().optional() }).passthrough()).optional() }).passthrough() })
      .safeParse(value);
    if (parsed.success && parsed.data.error.details?.some((item) => item.errorCode === "UNREGISTERED")) return "unregistered";
    if (response.status === 401) this.access = undefined;
    throw new Fault("FCM_DELIVERY_FAILED", `FCM rejected notification (${response.status}).`, 503);
  }
}
