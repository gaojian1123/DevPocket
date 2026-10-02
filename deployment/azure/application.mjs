import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { packageRelease } from "./package.mjs";

const json = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });

export async function prepareApplication(ctx, operations, authorize, { start = false } = {}) {
  await authorize(start ? ["upload", "deploy", "start"] : ["upload", "deploy"]);
  const actual = await operations.vmContext();
  const artifact = await packageRelease(ctx.root, path.join(ctx.directory, "packages"), actual);
  console.log(`PACKAGE verified (${artifact.size} bytes; SHA256 ${artifact.sha256}); no runtime data or credentials.`);
  await authorize(["upload"]);
  const packageUrl = await operations.upload(artifact);
  console.log("UPLOAD complete: immutable private Blob using tenant-scoped azd OAuth, no SAS.");
  const config = { ...actual, releaseId: artifact.sha256, packageUrl };
  const source = await readFile(path.join(ctx.root, "deployment", "azure", "vm", "control.py"), "utf8");
  await authorize(["deploy"]);
  await operations.runVm("bootstrap", config, source);
  console.log("VM bootstrap complete: separate ext4 disk and Docker. No application activation yet.");
  await authorize(["deploy"]);
  await operations.runVm("deploy", config, source);
  await json(path.join(ctx.directory, "prepared.local.json"), {
    planHash: ctx.plan.planHash, config, artifact: { sha256: artifact.sha256, size: artifact.size }, at: new Date().toISOString(),
  });
  console.log("DEPLOY prepared: image built on the VM; old image/data retained. This is not public TLS acceptance.");
  if (start) await startApplication(ctx, operations, authorize);
}

export async function startApplication(ctx, operations, authorize, { phase = "start", release } = {}) {
  await authorize([phase]);
  const saved = JSON.parse(await readFile(path.join(ctx.directory, "prepared.local.json"), "utf8"));
  if (saved.planHash !== ctx.plan.planHash) throw new Error("Prepared release target/source differs from the approved plan.");
  const actual = await operations.vmContext();
  if (actual.host !== saved.config.host) throw new Error("Public endpoint changed since preparation; obtain a new approval.");
  const releaseId = phase === "rollback" ? release : saved.config.releaseId;
  if (!/^[a-f0-9]{64}$/.test(releaseId ?? "")) throw new Error("A valid immutable release digest is required.");
  const source = await readFile(path.join(ctx.root, "deployment", "azure", "vm", "control.py"), "utf8");
  await authorize([phase]);
  await operations.runVm(phase, { ...saved.config, ...actual, releaseId }, source);
  await json(path.join(ctx.directory, "activation.local.json"), {
    planHash: ctx.plan.planHash, phase, releaseId, url: `https://${actual.host}`, at: new Date().toISOString(),
    internalHealth: "passed", publicTls: "not-checked", pairedCli: "not-checked",
  });
  console.log(`${phase.toUpperCase()}: VM internal health passed. Public TLS/WSS and paired original-CLI checks remain separate.`);
}

export async function publicCheck(ctx) {
  const active = JSON.parse(await readFile(path.join(ctx.directory, "activation.local.json"), "utf8"));
  if (active.planHash !== ctx.plan.planHash) throw new Error("Active endpoint is not for this plan.");
  const url = new URL(active.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Public validation requires platform-validated HTTPS.");
  const health = await fetch(new URL("/healthz", url), { redirect: "error", signal: AbortSignal.timeout(20_000) });
  const data = await health.json();
  if (!health.ok || data.protocol !== 1) throw new Error("Public HTTPS health did not return protocol 1.");
  const denied = await fetch(new URL("/v1/catalog", url), { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (denied.status !== 401) throw new Error("Public device authorization did not reject an unauthenticated request.");
  await new Promise((resolve, reject) => {
    const request = https.request(new URL(`/v1/host/stream?sessionId=${randomUUID()}`, url), {
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
      timeout: 20_000,
    }, (response) => {
      response.resume();
      response.statusCode === 401 ? resolve() : reject(new Error("WSS path did not reject an unauthenticated host."));
    });
    request.on("upgrade", (_response, socket) => { socket.destroy(); reject(new Error("Unauthenticated WSS was accepted.")); });
    request.on("timeout", () => request.destroy(new Error("WSS TLS check timed out.")));
    request.on("error", reject);
    request.end();
  });
  await json(path.join(ctx.directory, "public-check.json"), {
    url: active.url, at: new Date().toISOString(), https: "passed", wssAuthRejection: "passed",
    pairedOriginalCli: "NOT TESTED", fcm: "NOT CONFIGURED",
  });
  console.log("Public HTTPS and WSS routing/auth rejection passed. Device pairing, original-CLI attachment and FCM are not implied.");
}
