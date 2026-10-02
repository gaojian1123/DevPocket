import { readFile, lstat } from "node:fs/promises";
import { createHash, createCipheriv, createPublicKey, publicEncrypt, randomBytes, constants } from "node:crypto";
import { parseArgs } from "node:util";
import * as tar from "tar";
import { canonical } from "./probe-crypto.mjs";

export const REAL_PROTOCOL = "DevPocketEncryptedRelease/1";
export const REAL_MAX_REQUEST_BYTES = 36369;
export const REAL_CHUNK_BYTES = 4096;
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateRealArguments(args) {
  return parseArgs({ args, allowPositionals: true, options: {
    directory: { type: "string" }, confirm: { type: "string" }, phases: { type: "string" },
  } });
}

const safeName = (name) => typeof name === "string" && /^[A-Za-z0-9_./-]+$/.test(name) &&
  !name.startsWith("/") && name.split("/").every((part) => part && part !== "." && part !== "..") &&
  !/(^|\/)(\.data|\.azure|\.git|node_modules)(\/|$)|\.local\.|\.pem$|\.key$|\.sqlite|\.keystore|\.jks$/.test(name);

export async function inspectFrozenArchive(file, expected) {
  if ((await lstat(file)).isSymbolicLink()) throw new Error("FROZEN_LINK");
  const bytes = await readFile(file);
  if (bytes.length !== expected.bytes || bytes.length > 65536) throw new Error("FROZEN_SIZE");
  if (sha(bytes) !== expected.sha256) throw new Error("FROZEN_HASH");
  const contents = new Map();
  let expanded = 0, failure;
  await tar.t({
    file, strict: true,
    onReadEntry(entry) {
      if (!safeName(entry.path) || entry.type !== "File" || contents.has(entry.path) ||
          contents.size >= 250 || entry.size > 4 * 1024 * 1024 || expanded + entry.size > 20 * 1024 * 1024) {
        failure = new Error("UNSAFE_ARCHIVE_MEMBER");
        entry.resume();
        return;
      }
      expanded += entry.size;
      const chunks = [];
      contents.set(entry.path, chunks);
      entry.on("data", (chunk) => chunks.push(chunk));
    },
  });
  if (failure) throw failure;
  const get = (name) => {
    if (!contents.has(name)) throw new Error("MISSING_FROZEN_MEMBER");
    return Buffer.concat(contents.get(name));
  };
  const manifestBytes = get("release-manifest.json"), manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== contents.size - 1)
    throw new Error("FROZEN_MANIFEST");
  const names = new Set();
  for (const entry of manifest.files) {
    if (!safeName(entry.name) || entry.name === "release-manifest.json" || names.has(entry.name.toLowerCase()) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || sha(get(entry.name)) !== entry.sha256) throw new Error("FROZEN_MEMBER_HASH");
    names.add(entry.name.toLowerCase());
  }
  const pkg = JSON.parse(get("package.json")), binding = JSON.parse(get("deployment-target.json"));
  if (pkg.version !== "0.1.0" || binding.schemaVersion !== 1) throw new Error("FROZEN_VERSION_OR_BINDING");
  return {
    archiveSha256: expected.sha256, archiveBytes: expected.bytes, manifestSha256: sha(manifestBytes),
    fileCount: manifest.files.length, expandedBytes: expanded, version: pkg.version,
    controlSha256: sha(get("deployment/azure/vm/control.py")), binding,
  };
}

export function sealFrozenBytes(bytes, expected, publicPem, metadata) {
  if (bytes.length !== expected.archiveBytes || sha(bytes) !== expected.archiveSha256) throw new Error("FROZEN_HASH");
  const pub = createPublicKey(publicPem);
  if (pub.asymmetricKeyType !== "rsa" || pub.asymmetricKeyDetails.modulusLength !== 3072) throw new Error("RECIPIENT_KEY");
  const publicKeySha256 = sha(pub.export({ type: "spki", format: "der" }));
  const key = randomBytes(32), nonce = randomBytes(12);
  const bound = { ...metadata, protocol: REAL_PROTOCOL, archiveBytes: bytes.length,
    publicKeySha256, algorithm: "RSA-OAEP-SHA256+A256GCM", chunkBytes: REAL_CHUNK_BYTES };
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(canonical(bound)));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const chunks = [];
  for (let offset = 0; offset < ciphertext.length; offset += REAL_CHUNK_BYTES) chunks.push(ciphertext.subarray(offset, offset + REAL_CHUNK_BYTES));
  return {
    key, chunks,
    envelope: {
      metadata: bound, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
      wrappedKey: publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key).toString("base64"),
      ciphertextSha256: sha(ciphertext), chunks: chunks.map((chunk) => ({ bytes: chunk.length, sha256: sha(chunk) })),
    },
  };
}
