import { createHash, randomBytes, createCipheriv, createPublicKey, publicEncrypt, constants } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import * as tar from "tar";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const canonical = (value) => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])));
export const PROBE_PROTOCOL = "DevPocketSyntheticProbe/1";
export const CHUNK_BYTES = 8192;
export const MAX_ARCHIVE_BYTES = 65536;

export function validateProbeArguments(args) {
  return parseArgs({ args, allowPositionals: true, options: {
    directory: { type: "string" }, confirm: { type: "string" },
  } });
}

export async function createSyntheticFixture(directory, id, contentBytes) {
  if (!["small", "scale"].includes(id) || ![512, 44993].includes(contentBytes)) throw new Error("Only the two fixed non-sensitive fixture sizes are allowed.");
  const fixtures = path.join(directory, "synthetic");
  const stage = path.join(fixtures, `${id}-stage`);
  await mkdir(stage, { recursive: true, mode: 0o700 });
  const sentinel = `DPSYN-${randomBytes(32).toString("hex")}`;
  const prefix = Buffer.from(sentinel + "\n");
  const content = Buffer.concat([prefix, randomBytes(contentBytes - prefix.length)]);
  const manifest = { schemaVersion: 1, purpose: "devpocket.synthetic.fixture.v1",
    files: [{ name: "synthetic.bin", sha256: sha256(content), bytes: content.length }] };
  const file = path.join(fixtures, `${id}.synthetic.tar.gz`);
  try {
    await writeFile(path.join(stage, "synthetic.bin"), content, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(stage, "release-manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    await tar.c({ cwd: stage, file, gzip: true, portable: true, mtime: new Date(0), noDirRecurse: true },
      ["synthetic.bin", "release-manifest.json"]);
    const archive = await readFile(file);
    if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("Synthetic archive exceeded the fixed probe limit.");
    return { id, file, archiveSha256: sha256(archive), archiveBytes: archive.length,
      contentSha256: sha256(content), contentBytes: content.length, sentinel };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function encryptFixture(directory, fixture, publicPem, metadata) {
  const expected = path.resolve(directory, "synthetic", `${fixture.id}.synthetic.tar.gz`);
  if (!["small", "scale"].includes(fixture.id) || path.resolve(fixture.file) !== expected)
    throw new Error("A probe cannot read any real source archive or external package path.");
  const bytes = await readFile(expected);
  if (bytes.length !== fixture.archiveBytes || bytes.length > MAX_ARCHIVE_BYTES || sha256(bytes) !== fixture.archiveSha256)
    throw new Error("Immutable synthetic fixture changed.");
  const publicKey = createPublicKey(publicPem);
  if (publicKey.asymmetricKeyType !== "rsa" || publicKey.asymmetricKeyDetails.modulusLength !== 3072)
    throw new Error("The VM must supply a dedicated RSA-3072 public key.");
  const publicKeySha256 = sha256(publicKey.export({ type: "spki", format: "der" }));
  const key = randomBytes(32), nonce = randomBytes(12);
  const bound = { ...metadata, archiveBytes: bytes.length, publicKeySha256, algorithm: "RSA-OAEP-SHA256+A256GCM", chunkBytes: CHUNK_BYTES };
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(canonical(bound)));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const chunks = [];
  for (let offset = 0; offset < ciphertext.length; offset += CHUNK_BYTES) chunks.push(ciphertext.subarray(offset, offset + CHUNK_BYTES));
  const envelope = {
    metadata: bound, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
    wrappedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key).toString("base64"),
    ciphertextSha256: sha256(ciphertext), chunks: chunks.map((chunk) => ({ bytes: chunk.length, sha256: sha256(chunk) })),
  };
  return { envelope, chunks, ciphertext, key };
}
