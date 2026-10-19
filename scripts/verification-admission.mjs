import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { diagnosticError } from "./diagnostic-errors.mjs";

export const admissionVariable = "DEVPOCKET_VERIFIER_ADMISSION";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const canonical = (value) => process.platform === "win32" ? value.toLowerCase() : value;
const fail = (cause) => diagnosticError("admission-unconfirmed", cause);

async function registryDirectory(directory) {
  const parent = process.platform === "win32" ? process.env.LOCALAPPDATA : path.join(homedir(), ".cache");
  if (!directory && !parent) throw diagnosticError("resource-unavailable");
  const root = path.resolve(directory ?? path.join(parent, "DevPocket", "verification", "admission"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (canonical(await realpath(root)) !== canonical(root)) throw fail();
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      process.platform !== "win32" && (info.uid !== process.getuid() || (info.mode & 0o077))) throw fail();
  return root;
}

async function readOwner(file) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 16384) throw fail();
  const input = await open(file, "r");
  try {
    const start = await input.stat();
    if (start.size > 16384 || ["dev", "ino", "size", "mode", "nlink", "mtimeMs"].some((key) => before[key] !== start[key])) throw fail();
    const bytes = Buffer.alloc(start.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await input.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw fail();
      offset += result.bytesRead;
    }
    for (const info of [before, await input.stat(), await lstat(file)]) {
      if (["dev", "ino", "size", "mode", "nlink", "mtimeMs"].some((key) => info[key] !== start[key])) throw fail();
    }
    const owner = JSON.parse(bytes);
    if (owner.version !== 1 || !uuid.test(owner.id ?? "") || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
        typeof owner.workspace !== "string" || !path.isAbsolute(owner.workspace)) throw fail();
    return { owner, bytes };
  } finally { await input.close(); }
}

function address(root) {
  const key = createHash("sha256").update(canonical(root)).digest("hex").slice(0, 24);
  return process.platform === "win32" ? `\\\\.\\pipe\\devpocket-verification-${key}`
    : path.join(root, "owner.sock");
}

async function probe(socketPath, request, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let content = "", settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal.reason);
    const incomplete = () => finish(fail({ code: "ERR_STREAM_PREMATURE_CLOSE" }));
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(5000, () => finish(fail()));
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (bytes) => {
      content += bytes.toString("utf8");
      if (content.length > 1024) { finish(fail()); return; }
      if (content.includes("\n")) {
        try { finish(null, JSON.parse(content)); }
        catch (error) { finish(fail(error)); }
      }
    });
    socket.once("error", (error) => finish(fail(error)));
    socket.once("close", incomplete);
    socket.once("end", incomplete);
  });
}

async function serve(socketPath, owner, token) {
  const sockets = new Set();
  let ready = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let content = "", responded = false;
    socket.setTimeout(5000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.on("data", (bytes) => {
      if (responded) return;
      content += bytes.toString("utf8");
      if (content.length > 2048) { socket.destroy(); return; }
      if (!content.includes("\n")) return;
      responded = true;
      let request;
      try { request = JSON.parse(content); }
      catch { socket.destroy(); return; }
      if (!request || typeof request !== "object" || Array.isArray(request)) { socket.destroy(); return; }
      const borrowed = request.id === owner.id && /^[a-f0-9]{64}$/.test(request.token ?? "") &&
        timingSafeEqual(Buffer.from(request.token, "hex"), token);
      socket.end(JSON.stringify({ version: 1, id: owner.id, ready, borrowed: ready && borrowed }) + "\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: socketPath, exclusive: true }, () => { server.off("error", reject); resolve(); });
  });
  return {
    ready(value) { ready = value; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export async function acquireHostVerificationSlot(workspace, options = {}) {
  const root = await registryDirectory(options.directory), file = path.join(root, "owner.json");
  const started = performance.now(), inherited = options.inherited ?? process.env[admissionVariable];
  let ticket, notified = false, handoffs = 0, initializingAt;
  if (inherited) {
    try { ticket = JSON.parse(inherited); }
    catch (error) { throw fail(error); }
    if (ticket.version !== 1 || !uuid.test(ticket.id ?? "") || typeof ticket.directory !== "string" ||
        !/^[a-f0-9]{64}$/.test(ticket.token ?? "")) throw fail();
    if (canonical(ticket.directory) !== canonical(root)) {
      if (!options.directory) throw fail();
      ticket = undefined;
    }
  }
  while (true) {
    options.signal?.throwIfAborted();
    let server;
    const owner = { version: 1, id: randomUUID(), pid: process.pid, workspace: await realpath(workspace) };
    const bytes = Buffer.from(JSON.stringify(owner) + "\n"), token = randomBytes(32);
    if (!ticket) {
      try { server = await serve(address(root), owner, token); }
      catch (error) { if (!["EADDRINUSE", "EACCES"].includes(error.code)) throw fail(error); }
    }
    if (server) {
      try {
        const handle = await open(file, "wx", 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
      } catch (error) {
        await server.close();
        throw fail(error);
      }
      server.ready(true);
      const environment = { [admissionVariable]: JSON.stringify({
        version: 1, directory: root, id: owner.id, token: token.toString("hex"),
      }) };
      let released = false;
      const lease = {
        evidence: { scope: "user-host", mode: "owned", waitedMs: Math.ceil(performance.now() - started) },
        environment,
        async release(safe) {
          if (released) return;
          released = true;
          server.ready(false);
          try {
            if (safe) {
              if (!(await readOwner(file)).bytes.equals(bytes)) throw fail();
              await unlink(file);
            }
          } finally { await server.close(); }
        },
      };
      if (options.signal?.aborted) { await lease.release(true); options.signal.throwIfAborted(); }
      return lease;
    }
    let response;
    try { response = await probe(address(root), ticket ?? {}, options.signal); }
    catch (error) {
      options.signal?.throwIfAborted();
      if (!ticket && ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE"]
        .includes(error.cause?.code) && handoffs++ < 3) {
        try { await readOwner(file); }
        catch (ownerError) {
          if (ownerError.code === "ENOENT") {
            await delay(25, undefined, { signal: options.signal });
            continue;
          }
          throw fail(ownerError);
        }
      }
      throw error;
    }
    if (response?.version !== 1 || !uuid.test(response.id ?? "") || typeof response.ready !== "boolean") throw fail();
    if (!response.ready) {
      initializingAt ??= performance.now();
      if (performance.now() - initializingAt > 5000) throw fail();
      if (!notified) { notified = true; options.onWait?.(); }
      await delay(25, undefined, { signal: options.signal });
      continue;
    }
    initializingAt = undefined;
    let observed;
    try { observed = await readOwner(file); }
    catch (error) {
      if (error.code === "ENOENT" && !ticket) continue;
      throw fail(error);
    }
    if (ticket && ticket.id !== observed.owner.id) throw fail();
    if (response.id !== observed.owner.id) {
      if (ticket || handoffs++ >= 3) throw fail();
      await delay(25, undefined, { signal: options.signal });
      continue;
    }
    handoffs = 0;
    if (ticket) {
      if (response.borrowed !== true) throw fail();
      return {
        evidence: { scope: "user-host", mode: "inherited", waitedMs: Math.ceil(performance.now() - started) },
        environment: { [admissionVariable]: inherited },
        async release() {},
      };
    }
    if (!notified) { notified = true; options.onWait?.(); }
    await delay(250, undefined, { signal: options.signal });
  }
}
