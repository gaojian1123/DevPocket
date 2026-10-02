# DevPocket user extension

Install once for the current OS user. Every Copilot CLI session that loads this
extension automatically registers with the configured Dev Box host. There are no
project allowlists or DevPocket enable switches. Already-paired phones can access
all registered sessions on that host, including their synchronized earlier
visible history.

This is not a disk-wide repository scan. Closed/unregistered sessions are not
resumed. The original CLI's session identity, permission mode, organization
policies, version checks and live capability checks are preserved.

## Install on a new Dev Box

You need Node.js **24.x**, a compatible Copilot CLI, and this Dev Box's private
`host.local.json`, provisioned by the existing relay's administrator. The current
runtime adapter supports CLI **1.0.90-0**; other recorded versions remain
read-only. No npm install, source checkout, Android build or local relay is needed.

Download `DevPocket-extension-VERSION.zip` and its `.zip.sha256` file from the
same trusted GitHub release. Repository access is still required for private
releases. Do not execute an installer downloaded from an untrusted source.

In PowerShell, replace the version and private configuration path below:

```powershell
$zip = '.\DevPocket-extension-0.1.0.zip'
$expected = ((Get-Content -LiteralPath "$zip.sha256" -Raw).Trim() -split '\s+')[0]
if ($expected -notmatch '^[0-9a-fA-F]{64}$' -or
    (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expected) {
    throw 'Extension package checksum mismatch.'
}
Expand-Archive -LiteralPath $zip -DestinationPath .\devpocket-extension
node .\devpocket-extension\devpocket.mjs install --user `
  --config C:\DevPocketPrivate\host.local.json --confirm-install
```

The installer uses `%USERPROFILE%\.copilot\extensions\devpocket` by default.
If your CLI uses `COPILOT_HOME`, set the same environment variable for installation;
use an absolute path. Installation does not alter CLI settings or environment
variables. The SHA-256 file detects corruption; it is not a publisher signature.

Keep `host.local.json` protected by a Windows ACL for the intended user and
SYSTEM. Its `dataDir` must be absolute and outside the extension directory.
The installer writes an absolute path pointer, not a copy of the host credential.
Keep the original configuration and private bridge data after installation.
The extracted distribution can be removed after any pairing/device-management
commands you need; the installed bridge does not depend on it.

New CLI sessions discover the user extension automatically, subject to the CLI's
normal trust and permission-handler consent. The installer does not bypass these
prompts or select allow-all. In each already-running session you want to attach,
explicitly ask its built-in `extensions_reload` tool to reload extensions. Do not
restart, clone or resume that session as a substitute.

Project extensions named `devpocket` shadow the user extension. The installer
does not inspect, remove or overwrite them. Explicitly retire an old project
installation if you want that project to use this user installation instead.

## Pair a phone

Generate a fresh one-use code when the phone is ready:

```powershell
node .\devpocket-extension\devpocket.mjs pair --config C:\DevPocketPrivate\host.local.json
```

Enter the relay origin, code and device name in Android. A phone already paired
with this host does not need to pair again for each project. A new Dev Box needs
its own host configuration and host-specific phone grant.

The same bundled command supports `devices` and `revoke --device DEVICE_UUID`,
both with `--config`. Revocation stops future access, not already-executed
operations or copies of history previously downloaded. The relay can read
synchronized content; HTTPS/WSS is not end-to-end encryption.

## Update

Download and verify the new version, then repeat the same install command.
Managed user installations are replaced using a prepared directory; unrelated
extensions, host credentials and runtime data are not changed. Unmanaged targets,
additional files/links and concurrent installations are refused rather than
overwritten. A failed swap restores the previous files or reports the exact
recovery location. An interrupted installation may leave a
`.devpocket-install.lock`; inspect the reported installation/recovery directories
and ensure no installer is running before removing that specific lock.

Running extension processes are not reloaded by an update. They continue using
the version already loaded until an explicit reload or a future CLI session.

## Package contents

The archive contains a standalone `devpocket.mjs` command, the extension entry
and bundled bridge, this guide, dependency license notices, and a per-file
SHA-256 manifest. It contains no host/device credentials, local connection
pointer, runtime evidence, Node.js executable or Copilot SDK. The CLI provides its
own SDK when it launches the installed extension.
