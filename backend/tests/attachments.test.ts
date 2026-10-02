import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, newId, sessionPath, wireHost } from "./harness.js";

test("attachments are bounded, session scoped, and cannot be referenced from another session", async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const phone = await f.pair(host.token);
  const first = newId(), second = newId();
  await wireHost(f.socket(`/v1/host/stream?sessionId=${first}`, host.token), first);
  await wireHost(f.socket(`/v1/host/stream?sessionId=${second}`, host.token), second);
  const upload = (name: string, content: Uint8Array) => fetch(f.url + sessionPath(host.hostId, first) + "/attachments", {
    method: "POST", headers: { Authorization: `Bearer ${phone.token}`, "Content-Type": "text/plain", "X-File-Name": encodeURIComponent(name) },
    body: content,
  });
  assert.equal((await upload("..\\secret.txt", Buffer.from("no"))).status, 400);
  assert.equal((await upload("large.txt", Buffer.alloc(2 * 1024 * 1024 + 1))).status, 413);
  const uploaded = await upload("note.txt", Buffer.from("A safe attachment"));
  assert.equal(uploaded.status, 201);
  const file = await uploaded.json() as { id: string; size: number; sha256: string };
  assert.equal(file.size, 17);
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  const fetched = await fetch(f.url + sessionPath(host.hostId, first) + `/attachments/${file.id}`, {
    headers: { Authorization: `Bearer ${phone.token}` },
  });
  assert.equal(await fetched.text(), "A safe attachment");
  assert.equal((await f.request(sessionPath(host.hostId, second) + `/attachments/${file.id}`, phone.token)).status, 404);
  assert.equal((await f.request(sessionPath(host.hostId, second) + "/commands", phone.token, {
    commandId: newId(), action: { type: "message", text: "Attach", attachmentIds: [file.id] },
  })).status, 404);
  const hostRead = await f.request(`/v1/host/sessions/${first}/attachments/${file.id}`, host.token);
  assert.equal(await hostRead.text(), "A safe attachment");
});
