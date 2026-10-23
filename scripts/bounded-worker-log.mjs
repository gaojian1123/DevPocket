import { createWriteStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";

export const WORKER_LOG_BUDGET = 1024 * 1024;
const marker = Buffer.from("\n[DevPocket private worker log truncated; beginning and end retained]\n");
const headBudget = Math.floor((WORKER_LOG_BUDGET - marker.length) / 2);
const tailBudget = WORKER_LOG_BUDGET - marker.length - headBudget;

export function boundedDiagnosticBytes(value) {
  const bytes = Buffer.from(value);
  if (bytes.length <= WORKER_LOG_BUDGET) return { bytes, truncated: false };
  const separator = Buffer.from("\n[Private diagnostic log truncated; beginning and end retained]\n");
  const half = Math.floor((WORKER_LOG_BUDGET - separator.length) / 2);
  return { bytes: Buffer.concat([bytes.subarray(0, half), separator,
    bytes.subarray(bytes.length - (WORKER_LOG_BUDGET - separator.length - half))]), truncated: true };
}

export async function readWorkerLogTail(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > WORKER_LOG_BUDGET) {
    throw new Error("Worker failure log is not a bounded regular file.");
  }
  const same = (left, right) => ["dev", "ino", "mode", "size", "mtimeMs"].every((key) => left[key] === right[key]);
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (!same(info, opened)) throw new Error("Worker failure log changed during inspection.");
    const bytes = Buffer.alloc(Math.min(opened.size, 16384 + 3));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, opened.size - bytes.length + offset);
      if (!result.bytesRead) throw new Error("Worker failure log changed during inspection.");
      offset += result.bytesRead;
    }
    if (!same(opened, await handle.stat()) || !same(opened, await lstat(file))) {
      throw new Error("Worker failure log changed during inspection.");
    }
    const text = Buffer.from(bytes.toString("utf8"), "utf8");
    let start = Math.max(0, text.length - 16384);
    while (start < text.length && (text[start] & 0xc0) === 0x80) start++;
    return text.subarray(start).toString("utf8");
  } finally { await handle.close(); }
}

export function createBoundedWorkerLog(file) {
  const destination = createWriteStream(file, { flags: "wx", mode: 0o600 });
  let seen = 0, headWritten = 0, tail = Buffer.alloc(0), status = "pending";
  const output = new Writable({
    write(value, encoding, callback) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, encoding);
      seen += bytes.length;
      tail = Buffer.concat([tail, bytes.subarray(Math.max(0, bytes.length - tailBudget))]).subarray(-tailBudget);
      const head = bytes.subarray(0, Math.max(0, headBudget - headWritten));
      headWritten += head.length;
      if (head.length) destination.write(head, callback);
      else callback();
    },
    final(callback) {
      const remaining = Math.min(Math.max(0, seen - headWritten), tail.length);
      const end = Buffer.concat([
        ...(seen > headBudget + tailBudget ? [marker] : []),
        ...(remaining ? [tail.subarray(tail.length - remaining)] : []),
      ]);
      destination.end(end, (error) => {
        if (error) status = "unavailable";
        else if (status !== "unavailable") status = "retained";
        callback(error);
      });
    },
    destroy(error, callback) {
      if (error) status = "unavailable";
      destination.destroy();
      callback(error);
    },
  });
  destination.on("error", (error) => { status = "unavailable"; output.destroy(error); });
  output.on("error", () => { status = "unavailable"; });
  output.logInfo = () => ({
    status,
    truncated: seen > headBudget + tailBudget,
    retainedBytes: status === "retained" ? Math.min(seen, headBudget + tailBudget) +
      (seen > headBudget + tailBudget ? marker.length : 0) : "unknown",
  });
  return output;
}

export async function writeBoundedWorkerLog(file, value) {
  const output = createBoundedWorkerLog(file);
  const done = finished(output);
  output.end(value);
  await done;
  return output.logInfo();
}
