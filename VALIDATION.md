# DevPocket 0.1.0 development validation

Validation date: 2026-10-02. This is a **development-build validation record**, not an APK release or physical-device acceptance. The original local checkpoint is followed below by later, separately authorized public-emulator acceptance and shutdown.

## Build artifacts

- Native Android: `android\app\build\outputs\apk\debug\app-debug.apk`.
- Instrumentation: `android\app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk`.
- Relay/bridge JavaScript and declarations: `dist\`.
- Opt-in extension: `dist\extension\extension.mjs` and `bridge.mjs`; the CLI supplies its own extension SDK.
- Machine-readable incoming protocol definitions: `protocol.schema.json`; complete typed envelopes are in `backend\src\protocol.ts` and Android `data\Wire.kt`.
- Source versions: application/package/extension **0.1.0**, Android versionCode **1**, protocol **1**.

The build used an isolated project-local JDK 21, Android SDK platform/build-tools 35 and Gradle 8.11.1. It did not require private Firebase configuration or release signing.

### Accepted immutable build 002

Final accepted APK:

`.data\artifacts\build-002\DevPocket-0.1.0-build002-debug.apk`

SHA-256:

`2E3959AFCD119C393073D4D114C62C92F0441B3D7DABBC9E9AEEB15EE8B6EDF0`

The installed emulator APK was pulled back and hashed. Its bytes, the final Gradle output and the sealed delivery copy are identical. `build-002\build.json`, `installed-acceptance.json`, `android-sources.json` and the acceptance reports record the internal build number, timestamp, instrumentation hash and hashes of 32 Android source/build-input files. **002 is an internal development artifact number**, not a release or Git commit; versionName remains 0.1.0 and versionCode remains 1. The earlier unnumbered APK/manifest was preserved and is **not** the final accepted build.

## Commands and observed results

| Check | Actual command / mechanism | Observed result |
| --- | --- | --- |
| Backend regression suite | `npm test` | 20 passing tests |
| Production typecheck + extension bundle | `npm run build` | Passed |
| Wire schema export | `npm run schema` | Generated from validated TypeScript input definitions |
| Runtime dependency advisories | `npm audit --omit=dev --audit-level=high` | Zero advisories after updating `ws` to 8.21.3; not a substitute for a full security audit |
| Native build/unit checks/lint | `scripts\build-android.ps1 -Lint`; also Gradle `:app:assembleDebug :app:assembleDebugAndroidTest :app:testDebugUnitTest :app:lintDebug` | Build passed; 5 JVM tests passed; lint has no errors (dependency/KTX suggestions remain) |
| Native platform checks | Instrumented `NativeFlowTest` on the owned API-37 emulator | 2 tests passed: real Compose pairing controls, Keystore encryption roundtrip and backup disabled |
| Window/font layouts | `scripts\test-native-layouts.ps1` | Compact, medium, expanded, landscape, and 2x font cases passed with Chinese draft/selected-session retention and no task re-submission |
| Native phone controls to actual CLI | Instrumented `ConnectedFlowTest` with `extended=true` against the independent local relay and original ordinary CLI | Passed in 85.581 seconds: pairing, earlier history, message/reply and exact single submission over paged history, immediate new draft and Activity recreation, native permission confirmation, native question selection, Stop and same-runtime follow-up |
| Original-runtime identity/history | `backend\integration\live-checks.ts`, observed terminal screen, original PID and registration evidence | Same original CLI parent process/session; exact earlier response and event timestamp predate extension attachment |
| Runtime approvals/questions/models | `npm run test:cli` against that original CLI | Model list, model/reasoning selection, phone-first and terminal-first approval races, stale rejections, and simple native question form roundtrip passed; permission mode remained Manual |
| Real built-in shell cancellation | `npm run test:cli:cancel` | Actual PowerShell-launched Node parent **and child** were alive, both exited after abort, runtime emitted aborted idle, known queued input became cancelled, and the same CLI accepted another prompt |
| Reconnect | Restarted only the disposable relay against its existing SQLite data | The original CLI bridge reconnected without a cloned runtime or re-submitted tasks; regression coverage also prevents stale offline history from overriding a new authenticated live registration |
| Lost response after execution | Real relay + bridge + SQLite behind a fault-injecting local HTTP proxy, plus the actual OkHttp client regression | First operation was already completed and invocation count was 1 before the response socket was destroyed. Same host/session/commandId/body retry returned the saved result; invocation count stayed 1 |

The backend suite exercises real local HTTP/WSS and SQLite at the public protocol interface. Simulated host/SDK adapters used in some focused tests are **not** counted as proof of real CLI attachment. The separate original-terminal and native Android roundtrips provide that evidence.

The final APK was used for the extended native flow, the two native platform/Keystore tests and all five window/font cases. The permission confirmation was activated through its real Compose accessibility/semantic `OnClick`; other message, choice and Stop controls used normal Compose test clicks. This proves the native control callbacks and end-to-end operation, not physical-device touch acceptance. Safe command retries preserve the entire immutable command request and are bounded by the OkHttp **35-second call timeout**; pairing and uploads remain non-retrying and explicitly report uncertain outcomes.

### Regression findings fixed during validation

- The CLI emits live shell permissions with one shape and reconstructs pending permissions with `kind: "commands"`. Both official forms now project safely; unknown/bypass forms remain terminal-only.
- This CLI's native `ask_user` used an elicitation form rather than only `user_input.requested`. Simple string/choice forms are supported, and permission refresh no longer removes unrelated pending questions.
- The model catalog exposed no enumerated reasoning levels. The app does not invent a list: it supports explicit entry validated by the original runtime; a real `low` selection was observed.
- Queued inputs removed by abort no longer remain falsely labelled as waiting. Stop still waits for runtime evidence and does not claim all arbitrary detached processes are killed.
- Replay is bounded by bytes as well as event count. Native and test clients follow `hasMore`/cursor rather than incorrectly looking only at the first page of a long session.
- A fast user typing immediately after Send exposed a composer race: clearing only after asynchronous local persistence could append new text to the old prompt. The composer now clears synchronously while the immutable command is durably staged **before** network submission; storage failure is surfaced without overwriting a newer draft.
- Phone input explicitly sets the SDK's user provenance. Visible `user.message` history is not discarded merely because an older SDK send used system provenance; actual system/developer events and model snapshots remain excluded by event type.
- A reused idle HTTP connection could close just as a control POST began. Native control requests now retry only their **same immutable command ID/body**, backed by relay/bridge deduplication; one-time pairing and uploads are not blindly retried. This was reproduced with the real OkHttp client before fixing it.
- The originally selected WebSocket library had subsequently published high-severity advisories. It was updated precisely to the patched version rather than running a blanket forced dependency upgrade.

## Limits of the original local checkpoint

- **No public HTTPS/WSS/cellular deployment was activated.** Local emulator traffic used the explicit debug-only loopback exception. Release URL validation and network-security resources reject cleartext; actual DNS/certificate/firewall/carrier validation remains an operator step.
- **No FCM credentials or real push delivery were provisioned.** The native channel, permission flow, registration and server integration exist. Tests verify unconfigured/error and scoped-payload behavior, not Google/Doze/lock-screen delivery. Physical devices with the intended Google Play Services/network configuration still need testing.
- **File/Git positive CLI integration was blocked by unavailable content-exclusion evaluation in the disposable non-Git runtime.** The UI disables these operations instead of bypassing policy. Real filesystem traversal/symlink/exclusion tests passed through the file interface; positive Git status/diff in an authorized real repository remains unverified. No repository was initialized just to manufacture that result.
- **Multiple physical Dev Boxes** were not available. Multi-host/session authorization and routing were tested with separate authenticated wire peers.
- **First attachment in arbitrary existing user work**, including a shell already running before any bridge is present, was not exercised. The tested opt-in attachment happened after the original terminal had answered and while its explicit reload tool was in progress.
- **Real OS split-screen/freeform, every Android version, physical keyboards/devices and all accessibility services** were not fully qualified. Tested window sizes came from the emulator's actual display configuration; this is stronger than a design preview but not identical to every manufacturer multi-window implementation.
- The installed API-37 emulator periodically showed **Pixel Launcher/System UI ANRs unrelated to the app**. Initial instrumentation also used an older Espresso reflection path incompatible with API 37; upgrading the test libraries resolved that test-runner failure. Passing Compose assertions/roundtrips are not represented as a clean physical-device acceptance.
- Complex/URL elicitation, pre-attachment questions without a live snapshot, sandbox-bypass requests and unknown forms deliberately require the original terminal.

## Isolation and side effects

All implementation files were new under this DevPocket folder. No MobileTalk source, worktree, endpoint, credentials, device registry or deployment configuration was used. At the original local-validation checkpoint, no Git repository/branch/commit/tag/PR had been created, no cloud infrastructure had been deployed, no global extension was installed, and no real working CLI was restarted.

The successful probe used a new ordinary CLI in a native terminal, an empty local plugin mounted for that test, and an extension installed **after** its earlier answer. Its original PID/session identity was rechecked after hot-loads. Real session identifiers, PIDs, logs and credentials were scoped to ignored `.data` evidence, not embedded in source.

One failed early raw-PTY experiment inherited terminal-host markers. The **CLI itself** altered Windows Terminal settings and wrote a backup:

`%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json.2026-10-01T18-37-40-675Z.backup`

A read-only comparison found changes in the **actions, keybindings and profiles** categories: `actions.length`, `keybindings.length`, the existing `keybindings[0..2].id/keys` entries, and `profiles.list[6..7].guid`. No values or complete user configuration were copied into this report. The original backup was preserved; current settings were **not automatically restored**, because that could overwrite concurrent user changes and needs explicit user approval. Subsequent test processes removed the relevant inherited terminal-host/app-routing variables, without changing global environment configuration. The raw-PTY experiment was removed from the shipped test path.

## Evidence and cleanup

Ignored evidence includes `.data\android-native-tests.txt`, `layout-*.txt`, `android-connected-extended.txt`, Gradle logs/reports, and the disposable `canvas-proof-*` folder's original registration, visible-event, live-check and cancellation records. These are local proof artifacts, not release assets.

Cleanup was verified before handoff: all 11 temporary device grants were revoked; the recorded bridge was stopped independently; the original terminal answered `DP_ORIGINAL_ALIVE_AFTER_BRIDGE_STOP` and then exited normally with `/exit`. The owned relay, emulator, obsolete raw-PTY helper and two test-started ADB servers were stopped. Ports 18879, 5580, 5581, 5038 and 5037 were closed, and the named raw test credentials/connection pointers were removed. `build-002\cleanup.json` records this verification. Diagnostic evidence and the Windows Terminal backup remain; the project/session was not archived or deleted.

Public deployment and push activation required separate, explicit operator authorization; the subsequent public deployment is recorded below, while FCM remains unconfigured.

## Later authorized native public-emulator trial (2026-10-02)

The earlier local-only limits above describe that original acceptance checkpoint. Subsequent separately authorized Azure deployment and Dev Box commissioning enabled a real public native-client trial without rebuilding or changing the sealed APK.

The exact build 002 was installed on a new visible, isolated AVD using the only already-installed system image (API 37, x86_64). Its installed base APK was pulled back and matched the sealed SHA-256 byte for byte; certificate verification passed. The trial used an independent loopback ADB server and explicit emulator serial, WHPX, software rendering and a larger dedicated RAM/CPU profile. No new image/SDK download, user-AVD wipe, global ADB shutdown or host-virtualization change was performed.

Once the native pairing UI was ready, one five-minute code was generated in memory and submitted once through the real fields/button. The app displayed the actual cloud test host, project and existing ordinary CLI. Its runtime dialog showed real-time connection, CLI 1.0.90-0, Manual permission state and the unchanged session ID. No access token was extracted or injected into Android storage.

The native composer sent the requested harmless message. The original terminal and app both displayed `DevPocket emulator connected.`; the app displayed its completed-delivery label. A read-only lookup of that exact Dev Box bridge command confirmed a single completed receipt acknowledged by the relay, with the original parent/extension PIDs unchanged. This is native Android/public-HTTPS-WSS acceptance, not just a health check or an API-client simulation.

At acceptance, the emulator, dedicated ADB server, app login/Keystore, device grant, original CLI and cloud relay were left available for user trial. Safe screenshots and exact runtime/identity/receipt records remain in ignored local evidence. The startup/input issues encountered by the tooling were handled before pairing: the installed ADB required its supported `tcp:<port>` server syntax, and paced native key events were needed to avoid dropping part of a long URI. Neither required an app change.

This does not qualify a physical phone, cellular network, background/lock-screen FCM or all future API-37 system behavior. File/Git controls remain fail-closed for the folder-only runtime. The earlier API-37 platform instability is not erased by this successful foreground trial.

## Trial shutdown and source repository

After the user finished testing, the dedicated ordinary CLI exited normally, the identified emulator shut down without a wipe, and only its dedicated ADB server was stopped. The recorded processes and local listening ports were confirmed gone. App/Keystore/AVD data, host configuration, grants, source and private historical evidence were retained. The user explicitly chose to leave the existing cloud VM/relay and retained resources running; no cloud shutdown or deletion was performed.

Git initialization and the initial source commit were authorized only afterward. Build 002 and the frozen cloud business archive remain the original byte-identical artifacts, with their original no-Git provenance; their metadata is not rewritten to claim the new repository commit. Private parameters, credentials, user-session identifiers and runtime evidence are excluded from the source index.

## Background mode development checkpoint (2026-10-02)

This is a separate source-worktree check, **not** an extension of build 002's
installed acceptance. No sealed APK, installed device, existing CLI session or
cloud relay was changed.

The following command passed using the existing isolated JDK and Android SDK:

```powershell
.\scripts\build-android.ps1 -Jdk C:\Projects\DevPocket\.tools\jdk-21 -Sdk C:\Projects\DevPocket\.tools\android-sdk -Lint
```

Observed result: debug APK assembly, **42 JVM tests** (zero failures, errors or
skips), and Android lint passed. The current development output is
`android\app\build\outputs\apk\debug\app-debug.apk`; it has not been installed,
sealed, assigned a new accepted-build number or distributed.

The added checks cover:

- Initial paged-history suppression, outstanding requests, idle transitions,
  independent reminder cursors, reconnect coalescing, duplicate events,
  retention resets and rejection of events belonging to another session.
- All authorized unarchived sessions across multiple hosts/relays, discovery
  and removal, scoped revocation, cancellation, storage failures and retry of
  interrupted notification delivery or checkpoint cleanup.
- A real loopback HTTP/WebSocket exchange through the existing OkHttp client:
  authenticated, scope-specific subscriptions, reconnect and replay, with only
  GET requests and no CLI commands.
- Robolectric Android API 26 and 35 checks for explicit opt-in, non-sticky
  foreground lifetime, Stop notification action, stale service destruction,
  notification/channel denial, generic scoped notification cards and private
  checkpoint persistence. The `specialUse` manifest declaration is checked on
  API 35. Robolectric is test-only; it is not a hardware acceptance substitute.

Real BYD/DiLink notification presentation, OEM background policy, screen-off
or Doze operation, vehicle power transitions, mobile networking and sustained
background delivery remain **unverified**. No emulator/instrumentation or
real-CLI check was run for this change, and no Google Play policy approval is
claimed. FCM configuration and its earlier delivery gaps are unchanged.

## Background viewer-budget review checkpoint (2026-10-02)

Review identified that background subscriptions shared the relay's existing
eight-viewer device quota with the foreground UI. The original monitor opened
one stream per session without reserving a UI viewer.

The targeted regression command, run from `android` with the same isolated
JDK/SDK and Gradle cache, reproduced the boundary before the fix:

```powershell
.\gradlew.bat --no-daemon --console=plain :app:testDebugUnitTest --tests 'dev.devpocket.app.BackgroundMonitorTest.foregroundViewer*'
```

Seven background sessions allowed the foreground viewer to connect; eight and
twelve produced `TOO_MANY_STREAMS` instead. Those cases now pass. Background
subscriptions share seven realtime slots per relay/device, leaving one for the
foreground UI. Overflow uses bounded, authorized paged HTTP replay with an
explicit periodic-sync status, without raising the relay limit or changing the
wire protocol.

The full `scripts\build-android.ps1` command from the preceding checkpoint
passed again: debug APK assembly, **57 tests** with zero failures/errors/skips,
and lint with zero errors (24 warnings). Additional coverage includes:

- Foreground-before-background and background-before-foreground startup,
  shared device budgets, independent devices, and notifications/deduplication
  for overflow sessions.
- Reusing a released stream permit, scoped polling revocation, bounded replay
  concurrency, HTTP 429 polling/cooldown/recovery, and visible periodic status.
- Real OkHttp HTTP/WebSocket connections against a loopback fixture enforcing
  the relay's eight-viewer rule: twelve background sessions still receive
  reminders while a foreground viewer connects, with no rejected upgrades.

This remains local development evidence, not real relay deployment, device
installation, or BYD/DiLink acceptance. The earlier checkpoints and sealed
artifacts remain unchanged.

## Unread-reminder preservation checkpoint (2026-10-02)

A follow-up review identified that `configurationChanged()` canceled every
background reminder card even though posted notices already had their pending
delivery cleared from the checkpoint. Restarting subscriptions therefore did
not restore unrelated unread cards.

The following targeted regression reproduced that loss on both Robolectric
API 26 and 35 before the fix, using posted notifications and durable checkpoints
with `pending = null`:

```powershell
.\gradlew.bat --no-daemon --console=plain :app:testDebugUnitTest --tests 'dev.devpocket.app.BackgroundModeTest.configurationRefreshPreservesUnreadCardsAfterDeliveryWasCheckpointed*'
```

Ordinary configuration refresh now preserves notification cards. Successful
archive, revoke and forget operations invalidate only the corresponding
session, host/account or account. Added checks verify that unrelated sessions,
hosts and relays retain their original unread cards, similar identifier
prefixes do not broaden cleanup, and the ongoing connection notification
remains present.

The full `scripts\build-android.ps1` command recorded above passed again:
debug APK assembly, **65 tests** with zero failures/errors/skips, and lint with
zero errors. The original reproduction now passes on both platform models.
No backend or wire changes, device installation, real-CLI operation or cloud
deployment were performed. Earlier acceptance and sealed artifacts are unchanged.
