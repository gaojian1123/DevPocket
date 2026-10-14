# Scoped Dev Box onboarding

Onboarding registers a host in the **running cloud relay's existing database**, then gives only that Dev Box its private host configuration. Creating a local relay database is not cloud registration. The Android app needs its own revocable device grant, not a GitHub login or the host's long-term credential.

## One-command setup for the existing Azure relay

The standalone extension package now includes `setup`. It is separate from the
historical trial commands below and does not require their `.data` release records
or a checkout whose source matches the frozen deployment.

On the **new Windows Dev Box**, verify/extract the ZIP using its included README,
have Node 24 and Azure Developer CLI installed, and sign in to the intended Azure
directory if needed. From the extracted package:

```powershell
node .\devpocket.mjs setup
```

The interactive flow lists Azure directories, enabled subscriptions and tagged
DevPocket VMs, then asks for a unique Dev Box name. Optional `--tenant-id`,
`--vm-id` (full ARM ID) and `--name` hints skip those selections, not the final
confirmation. The selected identity needs subscription/resource-group/VM reads
and VM Run Command authority. No login, global account selection or permission
grant is performed by setup. Non-interactive execution is refused rather than
assuming consent.

After one target-specific confirmation, it:

- Records the Azure tenant/principal, VM resource and immutable instance IDs,
  deployment-owner tag and data disk identity; rechecks them before each command.
- Discovers the live release/image, HTTPS origin and exact healthy relay
  container through Azure Run Command. IMDS, both owner markers, the mounted data
  disk, Compose labels, non-root relay command and existing database must match.
- Reuses encrypted, crash-recoverable host registration through a non-migrating
  connection to the existing `hosts` table. Read-only compatibility checks precede
  writable access; host-record insertion is shared with the relay, but its
  schema-creating `RelayStore` constructor is never invoked. Schema, service,
  image, network and other host/device records are unchanged.
- Saves a protected local configuration, authenticates it over public HTTPS,
  removes the one-time recipient key and finalizes the encrypted cloud handoff.
- Installs the user extension with no per-project switches and prints the relay
  origin, the exact phone-pairing command and existing-session hot-load guidance.

The supported target is this project's public-Azure Linux VM deployment:
`DevPocket` ownership tags, `devpocket-azure` Compose project and owned
`/srv/devpocket` data mount. Other topologies, sovereign clouds and altered relay
commands are rejected; there is no heuristic fallback to a different container or
database. No SSH port, Blob upload, deployment approval or additional public relay
endpoint is involved.

Setup's private files live at `%LOCALAPPDATA%\DevPocket\setup`, independently of
the package/checkouts. Only the current Windows user and SYSTEM receive access.
The host configuration is synced to a sibling temporary file and published
atomically without replacing an existing file. An interrupted write therefore
retains the encrypted handoff and key for recovery instead of exposing a partial
configuration. Keep `host.local.json` and `bridge` there. Configure `COPILOT_HOME` before setup if
the intended GitHub Copilot runtime uses a custom user directory. Old project extensions still
shadow a same-named user extension and are never removed automatically.

Each management phase is journaled and synced **before** dispatch, with
the exact body, scope and hash. Rerunning the same package resumes saved responses
or polls the already-recorded ARM operation; it never repeats an uncertain POST.
Pre-dispatch failures and definitive HTTP 401/403 rejections are recorded as
`not-admitted`, allowing a subsequent run to retry the same body and scope after
the cause is corrected. Transport failures, other HTTP errors and unreadable
responses do not establish non-admission and remain blocked against replay.
The authorization window is four hours, guest execution is bounded by the
existing timeout, request bytes stay under 36,369, and output must match the
scoped result schema. Changed helper files, identity or targets stop recovery.
An unknown result without a saved polling URL, an expired handoff or a definite
failed guest phase needs operator inspection, not a new enrollment attempt.

If a process is forcibly terminated, inspect its `setup.lock` and verify the
recorded process is not running before removing only that lock. Do not delete
the state, key or configuration to get past an uncertain operation. This first
version has one persistent setup target per Windows user; host replacement/reset
remains an explicit operator task. For a completed enrollment, use the regular
`install --user --config ... --confirm-install` command to upgrade the extension,
not another registration.

No pairing code is generated before the phone is ready. Use the printed `pair`
command at that time. An existing GitHub Copilot session is never restarted or
silently reloaded: explicitly invoke its `extensions_reload` tool in the original
client (CLI or desktop app) and retain that client's normal consent.

## Historical scoped trial

The dedicated folder-only trial completed cloud registration, protected credential handoff and an authenticated public HTTPS/WSS roundtrip using a named temporary simulated device. That device's host grant and local credential were removed. The permanent test host and ordinary CLI were initially left available; after the user finished testing, the dedicated local processes were stopped normally while host configuration and history were retained. A physical Android phone and its pairing remain separate.

The subsequent user-selected **visible native Android emulator** installed byte-identical sealed build 002, paired through the actual app form, and completed a public message roundtrip to the same CLI/session/PIDs. Its device grant, app login and Keystore are deliberately retained for the user even though its local process and dedicated ADB server were subsequently stopped. It is not the temporary API controller above and must not be revoked during ordinary process cleanup. Its isolated AVD, dedicated ADB port/serial, process handles and credential-free screenshots remain in ignored local evidence.

## Independent scope and protected handoff

`deployment\onboarding` is operational tooling, not a relay/Android version or protocol change. Its separate scope records the completed release, exact VM/owner/image/database, operation nonce, recipient public-key fingerprint, helper source hash and expiry. It cannot reopen a completed real-release approval or use the exhausted Blob budget.

Only these management phases exist:

- `host-inspect`: check the VM via IMDS, owned mounted data, current immutable release, exact healthy relay container/image/command, and existing `/srv/devpocket/relay/relay.sqlite`. Report a same-name collision rather than overwriting it.
- `host-register`: use the existing host-record administrator contract through a non-migrating database connection. No database schema or running service change is made.
- `host-finalize`: require successful local public-HTTPS host authentication, remove only that operation's encrypted handoff journal, retain the permanent host and a non-sensitive closing receipt, and audit bounded visible guest logs.

The Dev Box creates a one-time RSA-3072 recipient key under a new `%LOCALAPPDATA%\DevPocket\trial-<operation-id>` directory. Inheritance is disabled; only the current user and SYSTEM have access. Windows PowerShell's ACL helper receives its own default module search path, avoiding incompatible PowerShell 7 module-path inheritance. No global environment setting is changed.

The VM receives **only the public key**. Standard Node crypto produces RSA-OAEP-SHA256/AES-256-GCM encrypted configuration. AAD binds the scope, VM, host, operation nonce, recipient fingerprint, expiry and configuration digest. The plaintext host token, private key and bare AES key never enter management requests or ordinary outputs.

The cloud journal contains ciphertext plus identity/hash metadata, not a plaintext host configuration. It uses 0700/0600 permissions and the existing relay UID 1000, inside the existing private data mount. The administrator Action executes the fixed helper as that same UID within the exact container; it does not add capabilities or broaden data permissions.

Before committing a new host row, the transaction durably saves its encrypted identity. If interrupted before commit, it can recover **that exact ID/token hash** from the journal rather than mint another host. If the row already exists, identity/name/hash must match and the same envelope is returned. Another operation cannot overwrite a same-name host. A closed handoff cannot register again.

After local decryption, the configuration is written exclusively as `host.local.json` in the protected directory. Public HTTPS host authentication must pass before the one-time private key is removed and cloud finalization is allowed. The permanent configuration is never printed. The plugin contains only a path pointer.

This protects transport and ordinary logs, not against administrators of the VM/Dev Box, inaccessible Azure backend logs, arbitrary future tools or memory/swap inspection. Visible-log audits explicitly report their limited scope. Ciphertext may remain in platform-managed script/result caches; those caches are not deleted.

## Local preparation and explicit execution

Node 24, the project's existing dependencies and the existing tenant-scoped azd identity are used. No new cloud service, package installation or global CLI extension is required.

```powershell
npm run build
node --test deployment\onboarding\tests\*.test.mjs

$onboarding = '.data\onboarding\devbox-trial-NEW'
node deployment\onboarding\commission.mjs init --directory $onboarding `
  --release-directory .data\azure\YOUR_ENV\real-release-001 `
  --name 'DevPocket test Dev Box'
```

Use a new three-digit trial suffix, such as `002`; `NEW` is a placeholder. `init` creates a new protected recipient key and a public scope but no cloud host. Existing directories/configuration are not overwritten. The completed release/owner must already match.

After scoped user authorization:

```powershell
node deployment\onboarding\commission.mjs approve --directory $onboarding --confirm $ReviewedScopeHash
node deployment\onboarding\commission.mjs inspect --directory $onboarding
node deployment\onboarding\commission.mjs register --directory $onboarding
node deployment\onboarding\commission.mjs adopt --directory $onboarding
node deployment\onboarding\commission.mjs finalize --directory $onboarding
```

Each Action is single-POST, serialized, source/scope-bound and recorded before submission. The script has a 60-second internal limit and a 75-second outer timeout with a ten-second kill grace. Every encoded request must stay below the already measured 36,369-byte ceiling. An unknown result retains the in-flight barrier; use `status` to read the recorded Azure operation, not a new registration POST. Only read-only credential/result retrieval may retry once.

The dedicated commissioning used three settled Actions and no POST replay. After completion, the operator archived its independent approval and removed the active approval file. The old real-release evidence remained untouched.

## Dedicated ordinary CLI, not a copied runtime

For a folder without Git, use the existing installer's private local plugin mode:

```powershell
node deployment\onboarding\commission.mjs install --directory $onboarding
node deployment\onboarding\trial-client.mjs prepare --directory $onboarding

# Run in a real visible terminal, not a headless raw-PTY bridge:
pwsh -NoProfile -File deployment\onboarding\launch-trial.ps1 -Directory $onboarding
```

The launcher uses a new UUID, this project as cwd, explicit cached CLI `1.0.90-0`, `--experimental`, `--mode interactive`, and only that private `--plugin-dir`. It refuses an existing local session ID rather than resuming/copying another session. It does not initialize Git, install globally, restart another terminal or create a runtime through the SDK.

Only this child process has app-trampoline/Windows-Terminal identity markers cleared and `COPILOT_ALLOW_ALL=false`. GitHub authentication, subscription and organization policy remain the CLI's. Choose one-session folder trust and one-session DevPocket permission-handler consent; deny unrelated extensions requesting skip-prompts. Do not choose allow-all.

The extension calls bundled-SDK `joinSession()` in the original parent process. Its protected bridge directory records the session ID, extension/parent PIDs, recorded CLI version and live capabilities. Match these with the terminal and an earlier marker response before claiming a remote session works. The public trial additionally confirmed actual Manual permission state, unchanged original PIDs, a completed routed command, recalled earlier marker, and live authenticated WSS response.

File/Git controls stay disabled when this non-Git runtime cannot evaluate content-exclusion policy. Do not initialize Git or bypass policy merely to make the UI appear enabled.

## Temporary simulated device and actual phone

`trial-client.mjs smoke --directory $onboarding` creates a clearly named temporary controller using a one-use pairing code entirely in memory. It uses the real public relay for catalog/history/message/WSS, then revokes only that temporary host grant and deletes its protected local device credential. An interrupted test retains a recoverable credential only in the protected directory; use `cleanup-device` before creating another test device.

This is not a physical Android test. It does not generate the user's phone pairing code. Once the user has installed the sealed APK and opened the pairing page, generate a fresh code for that host using the existing authenticated `pair` contract and securely show it only for that immediate pairing. The code expires after approximately five minutes and is single-use. Never show or copy `host.local.json` to the phone.

The user enters the existing HTTPS relay origin, fresh code and a device name. They should see the named test Dev Box, the DevPocket project and dedicated CLI session. No phone GitHub sign-in is required. Keep the dedicated terminal alive while trying it; `/exit` ends that session's bridge and makes it offline without revoking the permanent host.

## Evidence and boundaries

The ignored onboarding directory contains scope/source hashes, target and Action receipts, public-key metadata/encrypted envelope, protected-config path/ACL evidence, plugin hashes, process identity, roundtrip and temporary-device cleanup results. It does not contain the plaintext host/device credential or recipient private key.

Persistent state intentionally includes the cloud host row, protected Dev Box host/bridge files, private plugin and test chat history, not a requirement to keep the trial processes running indefinitely. No actual user repository was enrolled globally, no cloud resource or firewall/role was changed, no Azure relay restart was needed, and Android build 002, app version 0.1.0, FCM and MobileTalk were not changed. Revoke a phone's access through the existing scoped device-grant operation. Removing or rotating the host identity itself needs a reviewed cloud-administrator operation, not deletion of arbitrary databases or other hosts.
