import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, lstat, writeFile, readFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

function sshString(bytes) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  return Buffer.concat([size, bytes]);
}

export function rsaPublicKey(pem) {
  const jwk = createPublicKey(pem).export({ format: "jwk" });
  let modulus = Buffer.from(jwk.n, "base64url");
  if (modulus[0] & 0x80) modulus = Buffer.concat([Buffer.from([0]), modulus]);
  const key = Buffer.concat([sshString(Buffer.from("ssh-rsa")), sshString(Buffer.from(jwk.e, "base64url")), sshString(modulus)]);
  return `ssh-rsa ${key.toString("base64")} devpocket-vm-provisioning`;
}

export async function prepareLocal(root, input) {
  const name = input.AZURE_ENV_NAME;
  if (!/^devpocket-[a-z0-9][a-z0-9-]{0,28}$/.test(name ?? "")) throw new Error("Choose a new independent devpocket-* environment name.");
  const directory = path.join(root, ".data", "azure", name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Private configuration directory must not be a link.");
  if (process.platform === "win32") {
    const identity = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    const sid = identity.match(/S-1-[0-9-]+/)?.[0];
    if (!sid) throw new Error("Unable to identify current user SID; private key was not generated.");
    execFileSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"],
      { stdio: "pipe", windowsHide: true });
  } else await chmod(directory, 0o700);
  const privateFile = path.join(directory, "vm-admin.ssh-key");
  const configFile = path.join(directory, "input.local.json");
  for (const file of [privateFile, configFile]) {
    try { await lstat(file); throw new Error("Local key/config already exists; refusing overwrite. Edit non-secret inputs explicitly instead."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const owner = randomUUID(), suffix = owner.replaceAll("-", "").slice(0, 12);
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const publicKey = rsaPublicKey(pair.publicKey);
  await writeFile(privateFile, pair.privateKey, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(directory, "vm-admin.pub"), publicKey + "\n", { flag: "wx", mode: 0o600 });
  const config = {
    ...input, AZURE_RESOURCE_GROUP: input.AZURE_RESOURCE_GROUP || `rg-devpocket-${input.AZURE_LOCATION}-${suffix.slice(0, 6)}`,
    DEVPOCKET_DEPLOYMENT_ID: owner, DEVPOCKET_DNS_LABEL: input.DEVPOCKET_DNS_LABEL || `devpocket-${suffix}`,
    DEVPOCKET_SSH_PUBLIC_KEY: publicKey,
  };
  await writeFile(configFile, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { directory, configFile, publicKeyFile: path.join(directory, "vm-admin.pub"), privateFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputFile = process.argv[2];
  if (!inputFile) throw new Error("Supply an ignored private choices JSON file. No Azure login, environment or approval will be created.");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const result = await prepareLocal(root, JSON.parse(await readFile(path.resolve(inputFile), "utf8")));
  console.log(`Private local inputs and new RSA provisioning key prepared under ${result.directory}.`);
  console.log("No azd environment, deployment approval, Azure resources or certificate requests were created.");
}
