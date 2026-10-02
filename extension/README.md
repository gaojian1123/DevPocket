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

You need Node.js **24.x** and a compatible Copilot CLI. The current
runtime adapter supports CLI **1.0.90-0**; other recorded versions remain
read-only. No npm install, source checkout, Android build or local relay is needed.

Download `DevPocket-extension-VERSION.zip` and its `.zip.sha256` file from the
same trusted GitHub release. Repository access is still required for private
releases. Do not execute an installer downloaded from an untrusted source.

In PowerShell, replace the version below:

```powershell
$zip = '.\DevPocket-extension-0.1.0.zip'
$expected = ((Get-Content -LiteralPath "$zip.sha256" -Raw).Trim() -split '\s+')[0]
if ($expected -notmatch '^[0-9a-fA-F]{64}$' -or
    (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expected) {
    throw 'Extension package checksum mismatch.'
}
Expand-Archive -LiteralPath $zip -DestinationPath .\devpocket-extension
```

### Existing Azure relay: one-command setup

Run this on the new Windows Dev Box, in an interactive terminal:

```powershell
node .\devpocket-extension\devpocket.mjs setup
```

Azure Developer CLI (`azd`) must already be installed and signed in to the intended
directory. Setup does not log in, switch a global account, install tools, change
RBAC or create Azure resources. If needed, sign in explicitly first:

```powershell
azd auth login --tenant-id YOUR_TENANT_GUID
```

Select your directory/subscription when offered, the running DevPocket relay VM,
and a unique Dev Box name. A single confirmation names the exact Azure target,
private directory and user extension before Run Command or installation. You can
skip discovery questions by providing hints; they do not bypass confirmation:

```powershell
node .\devpocket-extension\devpocket.mjs setup `
  --tenant-id YOUR_TENANT_GUID --vm-id 'YOUR_FULL_AZURE_VM_RESOURCE_ID' --name 'My Dev Box'
```

The account needs subscription/resource-group/VM read access and permission for
Azure VM Run Command. Only the existing public-Azure deployment layout is supported:
tagged DevPocket Linux VM, owned mounted data disk, healthy `devpocket-azure` relay
container, and existing SQLite database. No old source checkout or release evidence
is required, and the running relay is not rebuilt or restarted.

Setup creates `%LOCALAPPDATA%\DevPocket\setup\host.local.json` with Windows access
limited to the current user and SYSTEM, verifies host authentication over HTTPS,
then installs the user extension. Configuration publication is atomic and refuses
to replace an existing file. Registration validates the existing host schema
without running the relay's schema-creating constructor.
The host token and recipient private key never
appear in Azure requests or ordinary output. The one-time private key is removed
after local authentication; the private host configuration and bridge data remain.

It prints the relay origin and a PowerShell `pair --config` command with absolute,
literal-quoted package/configuration paths, independent of the current directory.
Run that command when
the Android pairing screen is ready; setup does not pre-generate an expiring code.
Only loading the extension in a CLI session makes that session available.

### Already have a host configuration

An administrator can still provide this Dev Box's own private `host.local.json`.
Install directly without Azure tooling:

```powershell
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
The installed bridge does not depend on the extracted distribution, but the
printed `pair`, `devices` and `revoke` commands do. Keep the extraction at the
same path through phone pairing and for later device management. If you remove
it afterward, verify and re-extract the ZIP before using those commands again:
restore the printed path, or use the new absolute `devpocket.mjs` path with the
retained host configuration. Do not register another host just to restore these
commands. Keep the original package for any interrupted setup, which is bound
to its exact helper files.

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

## Interrupted setup

Run `setup` again from the same package. It uses the same saved target, Azure
principal, recipient and request bodies. Accepted operations resume by polling
their saved Azure URLs; an accepted or uncertain operation is never posted again.
Failures before dispatch and definitive Azure HTTP 401/403 rejections are saved
as `not-admitted`. After correcting the login or authorization problem, rerun
setup to retry that same immutable request. Transport errors, server failures
and unreadable responses remain uncertain, not safe retries. A locally saved
response can be completed without any cloud retry. Installation failures after
registration reuse the saved host configuration.

If Azure accepted a command but its result/polling URL was lost, setup reports
an uncertain outcome and stops. Expired approval (four hours), failed guest
verification, a changed VM/relay, missing keys or a host-name collision also need
operator inspection; do not delete state and create another host as a retry.
This first version manages one setup target per Windows user, not a host-switching
or host-reset interface.

A forcibly stopped process can leave
`%LOCALAPPDATA%\DevPocket\setup\setup.lock`. Verify no setup process is still using
it before removing only that lock; retain `state.json`, the recipient key if
present, and `host.local.json`. Setup does not silently remove another process's
lock or its credentials. A completed setup checks its saved configuration and
installed files rather than registering again; use `install --user` for upgrades.

## Package contents

The archive contains standalone `devpocket.mjs` and `setup.mjs` commands, fixed
onboarding helpers in `setup-assets`, the extension entry and bundled bridge,
this guide, dependency license notices, and a per-file SHA-256 manifest.
It contains no host/device credentials, local connection
pointer, runtime evidence, Node.js executable or Copilot SDK. The CLI provides its
own SDK when it launches the installed extension.
