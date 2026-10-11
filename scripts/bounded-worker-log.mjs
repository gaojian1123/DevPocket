import { createWriteStream } from "node:fs";
import { Writable } from "node:stream";

const budget = 1024 * 1024;
const marker = Buffer.from("\n[DevPocket private worker log truncated; beginning and end retained]\n");
const headBudget = Math.floor((budget - marker.length) / 2);
const tailBudget = budget - marker.length - headBudget;

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
