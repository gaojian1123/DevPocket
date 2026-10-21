import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

export function localPipe(name) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(name)) throw new Error("Invalid local pipe name.");
  if (process.platform === "win32") return `\\\\.\\pipe\\${name}`;
  const directory = path.join(realpathSync("/tmp"), `devpocket-ipc-${process.getuid()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error("Local IPC requires an unlinked private directory owned by this user.");
  }
  return path.join(directory, `${createHash("sha256").update(name).digest("hex").slice(0, 40)}.sock`);
}
