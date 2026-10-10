import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import net from "node:net";
import { test } from "node:test";
import { authenticatedProofFetch } from "../src/local-proof.js";

test("proof authentication and bearer delivery stay on one socket even after its listening port is replaced", async (t) => {
  const key = randomBytes(32).toString("hex"), token = "fixture-bearer-only";
  let replacementContacts = 0, deliveredToOriginal = false, closing: Promise<void> | undefined;
  const sockets = new Set<net.Socket>();
  const replacement = net.createServer((socket) => { replacementContacts++; socket.destroy(); });
  const original = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    let first = true, text = "";
    socket.on("data", (bytes) => {
      text += bytes.toString();
      if (!text.includes("\r\n\r\n")) return;
      if (first) {
        first = false;
        const nonce = /^GET \/__devpocket-proof\/([a-f0-9]{64}) HTTP\/1\.1/.exec(text)?.[1];
        assert.ok(nonce);
        assert.ok(!text.toLowerCase().includes("authorization"));
        text = "";
        closing = new Promise<void>((resolve) => original.close(() => resolve()));
        replacement.listen(port, "127.0.0.1", () => {
          const mac = createHmac("sha256", key).update(`devpocket-proof-v1:${nonce}`).digest("hex");
          socket.write(`HTTP/1.1 200 OK\r\nContent-Length: 64\r\nConnection: keep-alive\r\n\r\n${mac}`);
        });
      } else {
        deliveredToOriginal = text.includes(token);
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
      }
    });
  });
  await new Promise<void>((resolve) => original.listen(0, "127.0.0.1", resolve));
  const address = original.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (closing) await closing;
    else await new Promise<void>((resolve) => original.close(() => resolve()));
    if (replacement.listening) await new Promise<void>((resolve) => replacement.close(() => resolve()));
  });
  const response = await authenticatedProofFetch(`http://127.0.0.1:${port}/v1/catalog`, key, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.deepEqual(await response.json(), {});
  assert.equal(deliveredToOriginal, true);
  assert.equal(replacementContacts, 0);
});

test("a well-formed HTTP challenge response with the wrong owner signature never receives credentials", async (t) => {
  const key = randomBytes(32).toString("hex"), token = "must-not-leave-the-client";
  let received = "";
  let closed: Promise<void> = Promise.resolve();
  const server = net.createServer((socket) => {
    closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("error", () => socket.destroy());
    socket.on("data", (bytes) => {
      received += bytes.toString();
      if (received.includes("\r\n\r\n")) socket.write(
        `HTTP/1.1 200 OK\r\nContent-Length: 64\r\nConnection: keep-alive\r\n\r\n${"0".repeat(64)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await assert.rejects(authenticatedProofFetch(`http://127.0.0.1:${address.port}/v1/catalog`, key,
    { headers: { Authorization: `Bearer ${token}` } }), /authenticate/);
  await closed;
  assert.ok(!received.includes(token));
  assert.ok(!received.toLowerCase().includes("authorization:"));
});
