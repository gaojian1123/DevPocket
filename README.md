# DevPocket 0.1.0 (development)

DevPocket is a **native Android app written in Kotlin and Jetpack Compose** for a GitHub Copilot CLI terminal on a Windows Dev Box.

The phone joins a **registered, already-running CLI runtime** through an opt-in extension calling the CLI's bundled `joinSession()`, preserving the original terminal and session identity.

```text
Native Android (Kotlin / Compose / OkHttp / Keystore)
        | HTTPS commands + WSS user-facing events
DevPocket relay (Node 24 / TypeScript / SQLite)
        ^
        | outbound authenticated WSS only
Dev Box extension -> joinSession() -> original Copilot terminal
```

## What is implemented

| Area | Behavior |
| --- | --- |
| Native adaptive UI | Material 3; compact single-pane list/detail and bottom navigation; medium navigation rail; expanded list/detail panes; light/dark/system theme, dynamic color, edge-to-edge/IME insets, system Back, preserved drafts and reading position |
| Pairing | Offline administrator-provisioned hosts; five-minute, 256-bit, one-use pairing; independent phone credentials; multiple hosts/relays; host-specific device revocation |
| Extension installation | Install once for the OS user; all projects' CLI sessions that load the extension register automatically, without per-project switches; standalone ZIP distribution, no source checkout or npm dependencies on the target |
| Azure setup | One interactive command uses an existing azd login to register a new Dev Box with a verified running relay, encrypt the credential handoff, and install the user extension; no old deployment checkout, new public endpoint or relay restart |
| Sessions | Registered original runtime only; same-repository worktrees share a project group, with per-session branch/worktree labels and search; pin/rename/archive metadata; explicit offline/unsupported state |
| Chat | Earlier visible history, live assistant/tool output, terminal-to-phone and phone-to-terminal messages, durable command IDs, queued/admitted/processing/completed/uncertain delivery, offline drafts and replay |
| Human decisions | Known permission forms: approve once or reject; actual permission mode is read-only; questions with exact choices/free text; stale results are errors; unsupported forms visibly require the terminal |
| Stop | Sends `session.abort()` to the original runtime; shows **cancellation requested**, not stopped, until runtime idle evidence. Detached/background child processes must still be checked in the terminal |
| Models | Lists the current CLI's models/reasoning levels; validates the selection; does not override organization policies or automatically approve model-switch compaction |
| Files/attachments | Policy-aware project browsing; text/image previews, bounded downloads, PDF save/open through a trusted external app; <=2 MiB upload, <=4 per message, session-scoped IDs/checksums |
| Git | Read-only status, branch, staged/unstaged per-path diffs; no commit, staging, checkout or push; no shell interpolation |
| Notifications | Opt-in foreground-service background monitoring of all paired hosts' unarchived sessions, generic local reminders and a Stop notification; optional FCM remains separate and **unconfigured** until provisioned |

Current limitations:

- Only registered live sessions can be controlled. No automatic scan/resume of unregistered CLI history; no "create CLI session" command.
- The recorded CLI version is diagnostic only, not an allowlist. Each control requires its own live evidence and supported response/request shapes through the CLI-bundled SDK. Missing or incompatible evidence disables only the affected controls; an unfamiliar or missing version does not disable otherwise supported controls. CLI **1.0.90-0** remains a historical acceptance target, not proof of compatibility for every build.
- Pending tool permissions can be reconstructed at attachment. The bundled CLI does not expose a pending-question snapshot; a question already open at *first* attachment may require the terminal. Live questions and simple string/choice elicitation forms are supported. Complex elicitation, URL redirects, sandbox-bypass, plan-exit, limit and unknown permission forms require the terminal.
- Incoming messages use CLI `mode: "enqueue"`. Sending during a tool does **not** immediately change or kill that tool. `queued` is reported only when observed in the runtime's public queue; `admitted` alone means delivery is acknowledged but execution has not been confirmed. The CLI's plain abort also clears queued input; the confirmation dialog warns about this and known cleared messages become cancelled after runtime idle evidence. Text and attachment metadata can be manually restored as a new draft.
- Renaming/pinning/archiving changes DevPocket metadata, not CLI storage or running work.
- Git and files fail closed if the runtime cannot evaluate content exclusion (observed in this non-Git disposable runtime). Secrets/private configuration, `.git`, runtime directories, symlinks and junctions are not exposed. Text preview <=256 KiB; image/PDF <=2 MiB; 200 directory entries/300 Git entries per response.
- Some CLI model catalogs do not enumerate reasoning levels. The app then offers explicit text entry **validated by the original runtime** rather than inventing a supported list; rejected values remain errors.
- History imports the latest 15,000 runtime events; relay keeps the latest 20,000 visible events per session. Replay pages are byte-bounded (512 KiB). Android stores the latest 6,000 events and bounds decoded history text to 8 MiB. Cursor reset is shown when retention changes. Original history remains in the terminal.
- Attachments expire after seven days, with a 20 MiB per-session relay quota. Private Dev Box attachment staging remains until the operator removes its isolated bridge data; do not remove attachments while the CLI is using them.
- The separately authorized Azure relay is running with publicly trusted HTTPS. Public checks, a temporary simulated controller, and the sealed native Android build's actual pairing/message roundtrip on a visible isolated emulator passed against the same ordinary CLI. The emulator login is retained for user trial; physical-phone/cellular acceptance is still pending. FCM, release signing and store distribution remain unprovisioned. Opt-in background monitoring is best-effort, **not** a system-push or vehicle-wake guarantee, and is not part of sealed build 002's acceptance.

## Projects and worktrees

The session list groups a repository's main checkout and linked worktrees under
one project **on the same host**. The project identity is a hash of the canonical
Git common directory, not the worktree name, branch or remote URL. Independent
clones remain separate even when they share a name or remote. The project name
comes from Git's primary working-tree entry; each session shows its own branch
and worktree name. Detached HEAD uses the worktree name and an explicit detached
label. Search includes both branch and worktree names.

Discovery uses bounded, read-only Git queries only after the original runtime
explicitly allows content access to its live working directory. Non-Git folders
keep directory-based grouping. If policy or Git identity cannot be verified,
the session keeps directory-based grouping, clears stale workspace labels and
shows the applicable warning. Absolute repository/Git paths are not sent to the
phone; display names are redacted and bounded.

Grouping is presentation metadata only. It never changes the original runtime
or session ID, working directory, permission policy, file/Git browsing boundary,
command routing, drafts, or pin/rename/archive metadata. A session started in a
repository subdirectory keeps that subdirectory as its file-access boundary.

Protocol v1 adds optional `workspace: { name, branch }` summary metadata (an
empty branch means detached HEAD). Updated bridges request `workspaceMetadata=1`
on the host WebSocket URL and send a legacy-shaped hello. They include workspace
metadata only after an updated relay acknowledges `workspaceMetadata: true` in
its ready frame; negotiation restarts on every connection. Legacy bridges still
receive the original ready shape, and old Android clients ignore the optional
summary field. A new bridge on an old relay still groups by repository but warns
that workspace labels require a relay update.

Existing persisted sessions remain readable without a migration. Old bridges
and offline records keep their previous grouping until the original runtime
registers through an updated bridge; DevPocket does not scan or resume them.
The updated Android app, bridge and relay are needed for the complete display.
Before downgrading a relay to a build that rejects workspace metadata, restore
its matching pre-upgrade database backup rather than opening newer summaries
with the old strict decoder. Installation, reload and deployment remain separate
operator-authorized actions.

## Layout

```text
android\             Native app, Kotlin state/storage/network, Compose UI, tests
backend\src\         Protocol, independent relay, Copilot adapter and outbound bridge
backend\tests\       Real HTTP/WSS contract tests and focused runtime-adapter tests
backend\integration\ New ordinary CLI integration harness (opt-in, local only)
extension\           Bundled-SDK joinSession entry and standalone installation guide
scripts\             Build, extension packaging and isolated validation
deployment\          Independent Caddy TLS, containers and guarded Azure operations
config\              Placeholder-only host/push examples
```

All host/device credentials, SQLite data, copied attachments, SDK/JDK downloads, emulator state, build outputs and private deployment evidence go in ignored paths. The original implementation and sealed build 002 were created in a local folder **before Git initialization**. This source repository does not retroactively assign a commit to those artifacts or authorize deployments, credential access, APK distribution or a release.

After the user finished the trial, its dedicated local emulator, ADB server and ordinary CLI were shut down normally. Their app/Keystore data, host configuration and history were retained. The cloud relay remains running by explicit user choice; restarting or enrolling a local runtime still requires the relevant opt-in setup.

## Backend build and local development

Use Node 24.x and PowerShell. Commands are run from the DevPocket folder.

```powershell
npm ci
npm test
npm run build
npm run schema
node .\dist\cli.js --help
```

Start a local-only test relay (leave the terminal open):

```powershell
node .\dist\cli.js relay --data .data\relay --dev-loopback --port 8787
```

In another terminal, create an independent host **on the relay machine**. This is an offline administrator operation: the network does not accept unauthenticated host enrollment.

```powershell
node .\dist\cli.js host create --data .data\relay --name "My Dev Box" `
  --url http://127.0.0.1:8787 --dev-loopback `
  --out .data\my-box.local.json --bridge-data C:\DevPocketPrivate\bridge
node .\dist\cli.js pair --config .data\my-box.local.json
```

For a real installation use an independent **HTTPS** origin, omit `--dev-loopback`, transfer the host configuration **privately** to the Dev Box and restrict its Windows ACL to the authorized user. Do not store a host secret on the phone. A user-level extension installation opts in all CLI sessions that load it; keep a separate host identity per Dev Box/user.

On the Android pairing screen enter the independent relay origin, one-time code and device name. A debug emulator reaches the loopback relay as `http://10.0.2.2:8787`. This is an explicit **debug-only** exception; release builds reject HTTP. No trust-all certificate code is used.

## Install once for all projects

Use the standalone ZIP and checksum from an extension release; follow
[`extension\README.md`](extension/README.md) to verify and extract them. The target
needs Node 24.x and a compatible Copilot CLI. It does not need this repository,
npm dependencies, the Android toolchain or a local relay.

For an existing Azure relay managed by this project, install Azure Developer CLI
(`azd`) and sign in to its directory if not already authenticated. Run this from
the extracted package **on the new Windows Dev Box**:

```powershell
node .\devpocket.mjs setup
```

Choose the Azure directory/subscription if necessary, the running DevPocket VM,
and a unique Dev Box name. Review one explicit confirmation covering that target's
host registration and this user's global extension installation. The account
needs Azure read access to the selected subscription/resource group/VM and VM
Run Command authority. Setup neither logs in for you nor grants itself permissions.

Setup discovers the running relay and its existing database, saves
`%LOCALAPPDATA%\DevPocket\setup\host.local.json` in a protected directory,
authenticates it, and installs the extension. It prints the relay URL and the
exact pairing command to use when Android is ready. It does not generate a code
before the phone is ready. Re-running setup resumes recorded progress without
repeating an uncertain cloud submission. See the [setup runbook](deployment/ONBOARDING.md)
for prerequisites, optional target hints, recovery limits and the fixed supported
Azure deployment layout.

If an administrator has already provided this Dev Box's private configuration,
the existing offline-install path remains available:

```powershell
node .\devpocket.mjs install --user --config C:\DevPocketPrivate\host.local.json --confirm-install
node .\devpocket.mjs pair --config C:\DevPocketPrivate\host.local.json
```

Installation targets `%USERPROFILE%\.copilot\extensions\devpocket`, or
`COPILOT_HOME\extensions\devpocket` when the CLI's custom configuration directory
is set. Host configuration and its absolute private `dataDir` remain outside
that directory. The extracted package is not needed to run the installed bridge.
It is still needed by the printed pairing/device-management commands: keep it
through pairing, or verify and re-extract the ZIP before later `pair`, `devices`
or `revoke` use, retaining the existing host configuration.
Repeat the install command from a newer package to update a managed installation.

**There are no per-project allowlists or runtime enable switches.** New CLI
sessions that load the extension automatically register and synchronize visible
history, including earlier messages. Every phone paired with that host can access
all registered sessions. This does not scan the disk or resume closed sessions.
Normal CLI trust/permission-handler consent, permission mode, organization policy,
live capability gates and file-content exclusion remain in effect.

Installation and updates never reload existing sessions. Explicitly ask each
already-running session's built-in `extensions_reload` tool to attach the
extension, preserving its original identity. Project extensions named
`devpocket` shadow the user installation; they are not removed automatically.

### Build and distribute the extension

On the development machine, with dependencies restored:

```powershell
npm run test:extension-package
npm run test:setup
npm run package:extension
```

The package command creates `dist\packages\DevPocket-extension-0.1.0.zip` and
its `.zip.sha256` file. It refuses to overwrite an existing package. For a separate
development artifact, use
`npm run package:extension -- -OutputDirectory .data\extension-candidate`.
The archive is an explicit file allowlist: bundled command, setup and fixed
onboarding helpers, bridge/entry, installation guide, dependency licenses and a
per-file manifest; never a copy of the workspace, SDK or private host configuration.

The **Extension distribution** GitHub Actions workflow can build downloadable
artifacts manually. Pushing an `extension-vVERSION` tag matching `package.json`
builds and checks the package, then creates a **draft** GitHub release with the ZIP
and checksum. Review and publish that draft to make it available through Releases.
The workflow does not install extensions, enroll hosts, deploy the relay or change
APK releases. No release is created merely by building locally.

## Project-scoped installation (compatibility)

1. Build this project's bridge with `npm run build`.
2. Inspect the existing CLI's version/capabilities. `--no-auto-update` may select an older bundled executable; do not use its banner as the only evidence. This machine's isolated check used `$env:COPILOT_AUTO_UPDATE='false'` plus `--prefer-version 1.0.90-0`.
3. Install **only to the intended existing Git root**, with explicit opt-in:

```powershell
node .\dist\cli.js install --config .data\my-box.local.json `
  --project C:\YourExistingRepository --confirm-install
```

4. In the **already-running ordinary CLI terminal**, explicitly ask its built-in `extensions_reload` tool to hot-load the new project extension. This is a human trust decision: inspect the extension first. Loading/reloading other extensions may have their own lifecycle effects. DevPocket does **not** perform this action on your behalf.
5. Verify the original terminal/session ID remains unchanged and earlier answers appear on the phone. Only then is attachment established. If the current CLI cannot discover/hot-load the extension, use the terminal; never claim that a newly spawned/resumed session is the existing runtime.

For a folder-only disposable test, the installer can prepare a **local, uninstalled plugin** with `--plugin-dir C:\AnIsolatedPluginFolder --confirm-install`. An ordinary terminal started with `--plugin-dir` may discover extensions added to that directory later on an explicit hot-load. A running terminal that was not started with this flag cannot retroactively acquire it. This is not a reason to restart the user's working terminal.

The extension imports `@github/copilot-sdk/extension` supplied by the CLI. It does **not** install an arbitrary newer SDK, request GitHub secrets, change permission mode, enable allow-all, or create a local control listener.

### Runtime capability evidence

Attachment and refresh use read-only probes with a five-second deadline per probe;
discovery never sends a test message,
aborts work, answers a request or switches a model. Before executing a command the
bridge refreshes only that command's prerequisite evidence and checks its
capability, independently of the relay's last advertised snapshot. The relay
authenticates/scopes commands and requires a registered host with an open socket,
but cached capability booleans are UI advertisements, not a veto on forwarding
fresh commands. A
currently unsupported operation returns the bridge's failed receipt without
invoking that runtime control. Unrelated
model, permission, file-policy and display probes cannot delay a message or
answer, even during a periodic full refresh. Concurrent consumers share only
their required probe group; each group updates only its own evidence:

- Messages require a callable bundled-SDK `send` and a valid live activity response.
  Cancellation additionally requires the activity response's boolean `abortable`
  field and a callable `abort`; `abortable: false` while idle does not mean the
  operation is unsupported, but active work must explicitly be abortable.
  Only the bundled SDK's known `undefined` abort result acknowledges the request;
  an unfamiliar result remains uncertain, and acknowledgement is not completion.
  Queue evidence is optional: without a valid queue
  snapshot, sending is only **admitted**, never assumed queued or processing.
  Cancellation starts the queue read before dispatching `abort` without awaiting
  that read; a slow or failed queue query cannot delay the cancellation request.
  The bounded snapshot is used only to report known queued message IDs.
- Permissions require a valid live pending-permission snapshot and its response
  handler; duplicate request IDs invalidate the snapshot. Questions require live
  activity and a corresponding response handler;
  individual controls also require a supported, complete live request. Permission
  forms use per-kind allowlisted shapes, including nested shell/path/URL fields;
  live envelopes are validated before any payload is selected. A documented
  original-request/prompt pair must describe the same operation, and both are
  displayed. Unknown outer constraints, unsupported risk metadata, competing
  payload aliases and hook-resolved requests cannot be approved remotely.
  Multiple command/path/URL/server/argument aliases must have equivalent values
  before any paired-subject comparison; precedence never hides a contradiction.
  Snapshot refresh cannot discard stricter live evidence or change the approved
  subject. Request IDs changed by a live event or confirmed response after a
  snapshot read started are not overwritten or removed by that late snapshot.
  Valid removals also retire cached live evidence; still-pending requests retain
  their stricter live details.
  All accepted semantic fields are displayed, while known SDK
  correlation/canonicalization metadata is omitted. Arbitrary MCP/custom-tool
  arguments are displayed in full or denied
  when they exceed the display budget or require redaction. Question and
  elicitation payloads also validate their complete outer fields, not just the
  question text or nested form schema. Documented tool-call correlation IDs are
  typed but not exported; a declared elicitation source is shown with the form.
  Unknown outer fields, URL forms, historical questions and incomplete details
  remain in the original client. Forms with `enumNames` labels also remain there
  until label/value mapping is supported end to end; labels are never silently
  replaced by opaque values. Supported forms display their complete validated
  schema, including form-level and alternate-field descriptions, defaults and
  constraints. Defaults are informational, not automatic answers. If the full
  definition cannot fit safely without redaction, the form is terminal-only.
  `Other` is a literal enum choice unless the form actually declares a supported
  alternate field for custom text.
  Form length constraints count Unicode code
  points, including supplementary characters, without changing protocol-v1 size
  limits.
- Models require valid current-model and nonempty catalogue responses plus a
  callable switch handler. Duplicate model IDs invalidate the catalogue instead
  of selecting a policy by list order. Provided policy states must be `enabled`, `disabled`
  or `unconfigured`; the latter two cannot be selected, and unknown/incomplete
  policy shapes disable model controls. Missing model evidence does not disable
  chat or files. Android preselects the observed model and reasoning level; a
  compact, scrollable model menu leaves the reasoning controls in the dialog
  rather than below the entire catalogue. Changing models resets edited
  reasoning, and unavailable selections cannot be applied.
  After switching, the bridge reads current model state again without reusing a
  probe started before the switch. It publishes the observed session summary
  before returning model/refresh command receipts, so the phone's completion-triggered
  catalogue refresh does not wait for the periodic bridge update. Deferred
  switches produce a queued notice and retain the active model until confirmed
  by a live read. Live turn-start/idle events also update the summary's display
  state, including after delivery is acknowledged; older in-flight activity
  reads cannot overwrite them. These events do not grant control capabilities.
  Socket backpressure leaves unsent event batches eligible for the next flush
  instead of waiting for an acknowledgement that cannot arrive.
  Immediate summaries use the same negotiated workspace projection as periodic
  summaries, so legacy relays do not receive unsupported fields.
  These changes reuse protocol-v1 frames; the Android app and
  installed bridge need updating, but no relay/schema migration is needed.
- File/Git views require a live absolute working directory and a complete,
  path-matched content-exclusion response explicitly allowing that directory.
  Every subsequent path is still evaluated; recorded history is never a substitute
  for live policy evidence.

Capabilities and their warnings recover when valid evidence returns. The existing
wire booleans are unchanged; neither the relay nor Android infers support from
`cliVersion` or treats `messages` as a master control switch. Shape validation
accepts additive probe metadata but does not guess new request forms or acknowledge
unknown mutation results as successful. Mutation acknowledgement schemas reject
additional fields instead of stripping them. An incompatible response after a
mutation is reported as **uncertain**, without automatically repeating the
operation.

These checks establish adapter support, not end-to-end acceptance of an arbitrary
runtime build. Real mutation/cancellation compatibility checks still require an
explicitly opted-in disposable terminal; discovery never performs them.

Earlier protocol-v1 relays remain compatible with the updated extension and app,
but their cached-capability veto can delay recovery until a new summary arrives.
The final review follow-up changes relay command admission to remove that veto.
Deploy the updated relay as well to obtain this recovery improvement; updating
or reloading the user extension alone does not update an already-running Azure
relay. No wire/database migration is required. UI capability advertisements
continue to refresh periodically, and this source change does not authorize a
cloud deployment.

### List and revoke phones

```powershell
node .\dist\cli.js devices --config .data\my-box.local.json
node .\dist\cli.js revoke --config .data\my-box.local.json --device DEVICE_UUID
```

Revocation closes live subscriptions and blocks new commands/uploads/downloads for that host. Already-admitted CLI actions are not silently undone. A phone can also revoke its own host grant in Settings. "Remove relay/cache" is local deletion, **not** server-side revocation.

## Native Android build

Requirements: JDK 17 or 21, Android SDK platform/build-tools 35, and Gradle 8.11.1 (the wrapper is pinned and checksum-verified). Existing Studio JBR 25 is not selected for this build.

If the SDK components/JDK are missing, the supplied preparation script downloads official packages only to `.tools`, verifies published checksums, and reuses an **already accepted** Android SDK license. It does not silently accept licenses, install system packages or change global environment variables.

```powershell
.\scripts\prepare-android.ps1 -DownloadJdk
.\scripts\build-android.ps1 -Lint
```

Or pass existing installations:

```powershell
.\scripts\build-android.ps1 -Jdk C:\YourJdk21 -Sdk C:\YourAndroidSdk -Lint
```

Output: `android\app\build\outputs\apk\debug\app-debug.apk`, application ID `dev.devpocket.app.debug`, versionName **0.1.0**, versionCode **1**. It is a development debug build, not a signed release or authorization to distribute.

The accepted local handoff is immutable **build 002** at `.data\artifacts\build-002\DevPocket-0.1.0-build002-debug.apk`. Its manifest, source-input hashes and native acceptance results are beside it. Earlier unnumbered copies are retained only as earlier development artifacts; use build 002 for the verified handoff. `scripts\save-debug-artifact.ps1` refuses to overwrite a sealed build or seal an APK whose installed acceptance hash does not match.

Unit checks cover release TLS rules and late-ack draft/delivery invariants. `androidTest` adds native Compose pairing/Keystore checks and an optional real-runtime connected flow. Build success is distinct from emulator/device, cellular TLS, policy-specific runtime and FCM delivery verification; see `VALIDATION.md` for actual observed outcomes.

### Reproduce the opt-in real CLI checks

These tests use a **new disposable ordinary terminal**, not the SDK's create/resume client. They require interactive trust decisions and an already-authorized CLI. Do not point them at a working user session.

1. In the DevPocket folder run `npm run build`, then `npm run test:cli:start` in a dedicated terminal. It binds local port 18879 and creates ignored, independent test credentials.
2. In a second ordinary PowerShell terminal run `.\scripts\launch-cli-proof.ps1`. Only this test process's app-routing/terminal-host environment is adjusted, and it is restored afterward. Select the first folder-trust **Yes** for this session only; do not remember a grant or enable allow-all. Wait until the initial marker is actually answered.
3. Run `node --import tsx backend\integration\canvas-proof.ts install` from the project folder. Ask the **same** running CLI to invoke its built-in `extensions_reload` once. Approve that reload and the DevPocket extension's ability to **handle** permission requests, once. Reject unrelated requests to **skip** permission prompts. On a TUI use the selection keys and Enter; Escape may abort the entire current tool rather than only reject one extension.
4. Run `npm run test:cli`. It verifies original parent PID/session identity, the earlier marker timestamp, model/reasoning controls, phone-first approval/stale rejection, a live question, and terminal-first approval/stale rejection. It pauses for the harmless terminal-first `Write-Output` approval: inspect and approve that single command in the original terminal.
5. Run `npm run test:cli:cancel` to run a bounded in-workspace Node helper through the real built-in PowerShell tool. It observes actual parent/child PIDs, queues another message, requests abort, requires runtime idle and both process exits, checks the cleared queue's delivery state, and sends a new prompt to the **same** runtime afterward.
6. End the disposable CLI with `/exit` and stop the dedicated relay with Ctrl+C. Remove its raw test credentials; preserve only the ignored diagnostic evidence you need. Do not restart or modify unrelated CLI sessions.

The tested terminal host was the app's native **Terminal canvas**, used as a terminal display/PTY for an ordinary Copilot CLI. Direct terminal input works too. A generic piped-stdin/raw-PTY harness is not shipped as a claimed replacement; it did not reliably drive this machine's startup/trust UI. Tests fail rather than fabricating an attachment.

## Notifications and human setup

The app builds **without** `google-services.json` and without a private Google account file.

### Background mode without Google services

In Settings, grant notification permission and enable **background mode** while
the app is visible. This starts an ongoing connection notification with a Stop
action. It monitors every authorized, unarchived session on every paired relay,
even when no session is selected or the Activity moves to the background.
The relay must be reachable from the device's actual network; no Firebase setup
or new relay endpoint is needed.

- The default is off. The mode does not start at boot or automatically restart
  after process loss, force-stop or a device restart. Reopening the app reports
  an interrupted previous run rather than claiming it is connected; enable it
  again explicitly. Stopping the mode never aborts or restarts the original CLI.
- Catalog refresh discovers new sessions and removes archived or unauthorized
  ones. Local pairing, archive, revoke and forget actions refresh subscriptions
  immediately. Invalid credentials stop the affected subscriptions and remain
  visible as errors; another relay or host can continue independently.
- Refreshing subscriptions, pairing another relay or unarchiving a session
  preserves existing unread reminders. Archiving clears only that session's
  card; revoking a host clears only its cards in the paired account; removing a
  relay clears only that account's cards. Unrelated unread cards are retained
  even when their notification delivery has already been checkpointed.
- The existing relay permits eight concurrent viewers per device. Background
  monitoring shares a budget of seven realtime streams across that relay/device,
  reserving a viewer for the foreground UI. Other sessions remain monitored by
  paged HTTP replay every 15 seconds, with at most two replay requests in flight
  per relay/device. Settings and the ongoing notification distinguish realtime
  connections from periodic synchronization; periodic reminders can be delayed.
  Polling sessions can take a freed stream slot. If the relay rejects a stream
  with HTTP 429, that session polls during a cooldown before retrying realtime
  reception. No viewer limit is raised and no relay upgrade is required.
- The first paged history import does not announce old completions. It can
  announce a request that is still pending at the end of that import. Later
  pending decisions and transitions to idle generate generic reminders.
  Idle is a runtime update, not proof that a task succeeded.
- Background reminder checkpoints are independent of the UI's history cursor
  and command outbox. Reconnect uses paged replay, coalesces catch-up reminders
  per session and deduplicates already-consumed events. Interrupted notification
  delivery remains pending for retry. A retention reset is surfaced because
  events outside the relay's retention window cannot be recovered.
- Notifications contain no chat, command or approval details. Opening a
  reminder rechecks the account's current catalog authorization before opening
  that session. Each session has its own notification card; replay of the same
  notice does not alert again while that card is still present. FCM is a separate,
  optional channel; enabling both can produce reminders from both channels.

The Android foreground service declares `specialUse` for ongoing, user-started
remote CLI monitoring that waits for human decisions and runtime updates, with
an explicit manifest subtype explanation. It does not misuse `dataSync` as an
unlimited keepalive, request a system exemption, take a wake lock or silently
change battery settings. Future store distribution still requires the applicable
foreground-service policy review; declaring a type is not approval.
See the [Android foreground-service type requirements](https://developer.android.com/about/versions/14/changes/fgs-types-required#special-use).

Notification permission and both notification channels must remain enabled.
Network loss, Doze, OEM process management, vehicle sleep and power loss can
interrupt reception even with a foreground service. Real BYD/DiLink behavior,
notification presentation and unattended runtime have not been accepted.
This mode targets a powered-on, connected head unit, not waking a parked vehicle.
Only interact with approvals or terminal controls while safely parked.

### Optional FCM

1. An authorized operator must create/select an **independent** Firebase project, enable the HTTP v1 FCM API, and register the Android package (`dev.devpocket.app.debug` for debug; `dev.devpocket.app` for release). Cloud/account actions are not performed by this project.
2. Populate the public Android Firebase fields shown in `config\push.properties.example` through private Gradle properties or `-P` arguments. These are not GitHub credentials and not a server service-account private key.
3. Store the server service-account JSON outside source, grant only the needed FCM sending role, and pass `--fcm-credentials <private-path>` or `DEVPOCKET_FCM_CREDENTIALS` to the relay.
4. Grant Android notification permission, then use Settings -> re-register. The relay must report `pushConfigured=true`. Test foreground, background, Doze and lock-screen delivery on the actual target Android distribution/network; Google Play Services is required for this FCM path.

Push payloads contain opaque routing IDs and a generic update/attention notice, not chat, tool commands, approvals or GitHub secrets. Push is best-effort, is not proof of task success, and opening the app re-authorizes/synchronizes from the relay. Stale tokens are removed when FCM reports `UNREGISTERED`. Revoked devices are not selected for later notifications.

## Deployment

**Azure with azd/Bicep:** see [`deployment\AZURE.md`](deployment/AZURE.md). `azure.yaml` and `infra\main.bicep` preserve the single-Linux-VM/Compose/Caddy/local-SQLite architecture using official project hooks compatible with azd 1.25.5. After separately authorized infrastructure provisioning, staged DNS recovery and encrypted frozen-release import, the relay is running and public HTTPS/health/unauthenticated HTTP-WSS checks passed. Private Blob upload remains failed with its retry budget exhausted; it was not opened broadly or represented as successful. The accepted Android build 002 and app/relay version remain unchanged.

If infrastructure already exists and needs a separately authorized endpoint recovery, [`deployment\AZURE-RECOVERY.md`](deployment/AZURE-RECOVERY.md) describes the new-IP → DNS verification → NIC/single-IP firewall switch gates. Original resources and approval evidence are preserved; preparing or previewing recovery is not permission to execute it.

The successful non-sensitive encrypted-transport probe is documented in [`deployment\TRANSPORT-PROBE.md`](deployment/TRANSPORT-PROBE.md). The separately authorized and executed frozen real-release path is documented in [`deployment\REAL-RELEASE.md`](deployment/REAL-RELEASE.md): it preserves the business archive/origin, uses separate transport/control hashes and explicit phases, and cannot inherit probe or exhausted Blob-upload authorization. Actual endpoint/resource IDs and private receipts stay in the ignored environment directory. Public relay acceptance does not install a user's CLI extension, provision host credentials or pair a phone.

The subsequent scoped [Dev Box onboarding](deployment/ONBOARDING.md) registered a named test host in that live cloud database, encrypted its credential to a protected Windows recipient, and connected a dedicated ordinary CLI using only a private local plugin. A temporary simulated public controller verified history, command delivery and live WSS, then had its grant revoked. The host configuration and history were retained when the user ended the dedicated local trial; an actual-phone pairing code is generated only when the user is ready.

A later user-selected visible emulator installed the exact sealed build 002, paired through its real native controls, and sent a no-side-effect message to that unchanged ordinary CLI over the public relay. Both the terminal and native app displayed the response, and the completed receipt was acknowledged by the relay. This emulator's device grant/Keystore remain retained, unlike the earlier temporary API controller; its window/process was closed after the user finished testing. No Android code or APK was rebuilt.

`deployment\compose.yaml` and `deployment\Caddyfile` are templates only. **Do not run them without authorization for the target infrastructure and its costs.**

- Use a new domain, DNS records, certificates, volumes and credentials; do not reuse another project's endpoints or data.
- Caddy and the relay share a container network namespace; Caddy terminates TLS and connects to relay loopback. Only ports 80/443 are published. No plaintext relay/CLI port is published.
- The relay requires an exact trusted-proxy socket address plus HTTPS forwarding metadata in production. Do not configure a wildcard or trust client-supplied forwarded headers from arbitrary sources.
- The supplied deployment is a **single relay replica** with SQLite WAL and private persistent volumes. Multiple replicas need a coordinated datastore and routing implementation; load-balancing this template as if it were stateless is unsupported.
- Back up encrypted/private relay volumes under your infrastructure access policy; secure filesystem permissions, disk encryption, domain ownership, TLS renewal, monitoring and secret rotation remain operator responsibilities.
- Container definitions use `restart: "no"`. The specifically authorized Azure VM uses a mount-aware systemd autostart unit; no Dev Box/Copilot autostart was configured, and a cloud-VM reboot was not performed as a test. FCM private key mounts are intentionally not preconfigured.

## Security and delivery semantics

- Every controller operation and stream is authorized to a **device -> host -> registered session** grant. Opaque attachment IDs are checked against that scope. URL paths are not accepted as arbitrary RPC/shell requests.
- Relay credentials are stored hashed; the only plaintext phone secret is Keystore-encrypted on Android. GitHub auth stays with the CLI. Sensitive environment access is not requested by the extension.
- The relay **can see** user-visible messages and uploaded content. TLS is transport encryption, not end-to-end encryption. Use only a relay and administrative operators you trust.
- The bridge explicitly projects allowed user events. System/developer prompts, `model.messages_snapshot`, reasoning internals, auth state and full RPC snapshots never enter the wire schema. Known token formats are redacted, but redaction cannot make arbitrary user/CLI text secret-free: do not paste secrets into conversations.
- Durable command IDs are immutable and retained as deduplication tombstones. Crash windows after recording intent but before an RPC result are **uncertain**, never blindly retried. A duplicate payload with another ID is a new user action. Monitor database growth and retain tombstones when archiving.
- One-time decisions use the runtime's atomic `success` result. Terminal-first/phone-first races have one winner; a stale response is not success.
- Approvals whose safe display is incomplete, redacted or unknown route back to the terminal. Do not approve model-generated command text without reviewing it.
- Project file/Git operations are local and read-only, deny sensitive paths and links, bound output/time, and consult the CLI's content-exclusion evaluator on each operation.
- Android renders untrusted content as selectable native text. Links and attachment previews remain non-executable; opening a saved document in a trusted external app is an explicit user action.
