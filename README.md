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
| Sessions | Registered original runtime only; project grouping, search, pin/rename/archive metadata; explicit offline/unsupported state |
| Chat | Earlier visible history, live assistant/tool output, terminal-to-phone and phone-to-terminal messages, durable command IDs, queued/admitted/processing/completed/uncertain delivery, offline drafts and replay |
| Human decisions | Known permission forms: approve once or reject; actual permission mode is read-only; questions with exact choices/free text; stale results are errors; unsupported forms visibly require the terminal |
| Stop | Sends `session.abort()` to the original runtime; shows **cancellation requested**, not stopped, until runtime idle evidence. Detached/background child processes must still be checked in the terminal |
| Models | Lists the current CLI's models/reasoning levels; validates the selection; does not override organization policies or automatically approve model-switch compaction |
| Files/attachments | Policy-aware project browsing; text/image previews, bounded downloads, PDF save/open through a trusted external app; <=2 MiB upload, <=4 per message, session-scoped IDs/checksums |
| Git | Read-only status, branch, staged/unstaged per-path diffs; no commit, staging, checkout or push; no shell interpolation |
| Notifications | Opt-in foreground-service background monitoring of all paired hosts' unarchived sessions, generic local reminders and a Stop notification; optional FCM remains separate and **unconfigured** until provisioned |

Current limitations:

- Only registered live sessions can be controlled. No automatic scan/resume of unregistered CLI history; no "create CLI session" command.
- CLI **1.0.90-0** is the validated adapter target. Recorded session version **and live capability probes** gate actions; unknown versions are read-only. The recorded version is not presented as proof that an upgraded/resumed process has the same build.
- Pending tool permissions can be reconstructed at attachment. The bundled CLI does not expose a pending-question snapshot; a question already open at *first* attachment may require the terminal. Live questions and simple string/choice elicitation forms are supported. Complex elicitation, URL redirects, sandbox-bypass, plan-exit, limit and unknown permission forms require the terminal.
- Incoming messages use CLI `mode: "enqueue"`. Sending during a tool does **not** immediately change or kill that tool. `queued` is reported only when observed in the runtime's public queue; `admitted` alone means delivery is acknowledged but execution has not been confirmed. The CLI's plain abort also clears queued input; the confirmation dialog warns about this and known cleared messages become cancelled after runtime idle evidence. Text and attachment metadata can be manually restored as a new draft.
- Renaming/pinning/archiving changes DevPocket metadata, not CLI storage or running work.
- Git and files fail closed if the runtime cannot evaluate content exclusion (observed in this non-Git disposable runtime). Secrets/private configuration, `.git`, runtime directories, symlinks and junctions are not exposed. Text preview <=256 KiB; image/PDF <=2 MiB; 200 directory entries/300 Git entries per response.
- Some CLI model catalogs do not enumerate reasoning levels. The app then offers explicit text entry **validated by the original runtime** rather than inventing a supported list; rejected values remain errors.
- History imports the latest 15,000 runtime events; relay keeps the latest 20,000 visible events per session. Replay pages are byte-bounded (512 KiB). Android stores the latest 6,000 events and bounds decoded history text to 8 MiB. Cursor reset is shown when retention changes. Original history remains in the terminal.
- Attachments expire after seven days, with a 20 MiB per-session relay quota. Private Dev Box attachment staging remains until the operator removes its isolated bridge data; do not remove attachments while the CLI is using them.
- The separately authorized Azure relay is running with publicly trusted HTTPS. Public checks, a temporary simulated controller, and the sealed native Android build's actual pairing/message roundtrip on a visible isolated emulator passed against the same ordinary CLI. The emulator login is retained for user trial; physical-phone/cellular acceptance is still pending. FCM, release signing and store distribution remain unprovisioned. Opt-in background monitoring is best-effort, **not** a system-push or vehicle-wake guarantee, and is not part of sealed build 002's acceptance.

## Layout

```text
android\             Native app, Kotlin state/storage/network, Compose UI, tests
backend\src\         Protocol, independent relay, Copilot adapter and outbound bridge
backend\tests\       Real HTTP/WSS contract tests and focused runtime-adapter tests
backend\integration\ New ordinary CLI integration harness (opt-in, local only)
extension\           Bundled-SDK joinSession entry, never loaded automatically here
scripts\             Build, opt-in install preparation and isolated validation
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

For a real installation use an independent **HTTPS** origin, omit `--dev-loopback`, transfer the host configuration **privately** to the Dev Box and restrict its Windows ACL to the authorized user. Do not store a host secret on the phone. One offline host credential can register that Dev Box's explicitly opted-in sessions; do not share it among unrelated users.

On the Android pairing screen enter the independent relay origin, one-time code and device name. A debug emulator reaches the loopback relay as `http://10.0.2.2:8787`. This is an explicit **debug-only** exception; release builds reject HTTP. No trust-all certificate code is used.

## Opt in an existing terminal

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
