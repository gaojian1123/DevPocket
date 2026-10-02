import {
  constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  privateDecrypt, publicEncrypt, randomBytes,
} from "node:crypto";

export const PROTOCOL = "DevPocketHostHandoff/1";
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function requireValue(value, code) { if (!value) throw new Error(code); }
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
export function publicFingerprint(pem) {
  const key = createPublicKey(pem);
  requireValue(key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails.modulusLength === 3072, "HANDOFF_RECIPIENT");
  return sha(key.export({ type: "spki", format: "der" }));
}
export function validConfig(config, scope) {
  requireValue(config && Object.keys(config).sort().join(",") === "allowInsecureLoopback,dataDir,hostId,relayUrl,token" &&
    /^[a-f0-9-]{36}$/.test(config.hostId) && /^dph_[A-Za-z0-9_-]{43}$/.test(config.token) &&
    config.relayUrl === scope.relayUrl && config.dataDir === scope.bridgeDataDir &&
    config.allowInsecureLoopback === false, "HANDOFF_CONFIG");
  const url = new URL(config.relayUrl);
  requireValue(url.protocol === "https:" && !url.username && !url.password &&
    !url.search && !url.hash && url.pathname === "/", "HANDOFF_ORIGIN");
  return config;
}
function bound(scope, hostId, configSha256) {
  return { protocol: PROTOCOL, scopeHash: scope.scopeHash, vmId: scope.vmId, operationId: scope.operationId,
    nonce: scope.nonce, recipientSha256: scope.recipientSha256, expiresAt: scope.expiresAt, hostId, configSha256 };
}
export function sealHost(config, scope, publicPem, now = Date.now()) {
  requireValue(now < scope.expiresAt, "HANDOFF_EXPIRED");
  requireValue(publicFingerprint(publicPem) === scope.recipientSha256, "HANDOFF_RECIPIENT");
  validConfig(config, scope);
  const plaintext = Buffer.from(JSON.stringify(config));
  requireValue(plaintext.length <= 1500, "HANDOFF_SIZE");
  const metadata = bound(scope, config.hostId, sha(plaintext));
  const key = randomBytes(32), iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(canonical(metadata)));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { metadata, nonce: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
      wrappedKey: publicEncrypt({ key: publicPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key).toString("base64"),
      ciphertext: ciphertext.toString("base64") };
  } finally { key.fill(0); plaintext.fill(0); }
}
export function openHost(envelope, scope, privatePem, now = Date.now()) {
  requireValue(now < scope.expiresAt, "HANDOFF_EXPIRED");
  requireValue(envelope && Object.keys(envelope).sort().join(",") === "ciphertext,metadata,nonce,tag,wrappedKey", "HANDOFF_ENVELOPE");
  const metadata = envelope.metadata;
  requireValue(metadata && /^[a-f0-9-]{36}$/.test(metadata.hostId) && /^[a-f0-9]{64}$/.test(metadata.configSha256) &&
    canonical(metadata) === canonical(bound(scope, metadata.hostId, metadata.configSha256)), "HANDOFF_BINDING");
  requireValue(publicFingerprint(createPrivateKey(privatePem)) === scope.recipientSha256, "HANDOFF_RECIPIENT");
  const decode = (value, size) => {
    requireValue(typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length <= 4096, "HANDOFF_ENCODING");
    const bytes = Buffer.from(value, "base64");
    requireValue(bytes.toString("base64") === value && (!size || bytes.length === size), "HANDOFF_ENCODING");
    return bytes;
  };
  let key, plaintext;
  try {
    key = privateDecrypt({ key: privatePem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, decode(envelope.wrappedKey, 384));
    requireValue(key.length === 32, "HANDOFF_KEY_SIZE");
    const decipher = createDecipheriv("aes-256-gcm", key, decode(envelope.nonce, 12));
    decipher.setAAD(Buffer.from(canonical(metadata)));
    decipher.setAuthTag(decode(envelope.tag, 16));
    plaintext = Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]);
    requireValue(plaintext.length <= 1500 && sha(plaintext) === metadata.configSha256, "HANDOFF_INTEGRITY");
    const config = validConfig(JSON.parse(plaintext), scope);
    requireValue(config.hostId === metadata.hostId, "HANDOFF_HOST");
    return config;
  } catch { throw new Error("HANDOFF_AUTHENTICATION"); }
  finally { key?.fill(0); plaintext?.fill(0); }
}
