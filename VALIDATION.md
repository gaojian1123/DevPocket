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

## User extension distribution checkpoint (2026-10-02)

This source-worktree change adds user-wide installation and a standalone extension
distribution. It does not alter the original runtime adapter, wire protocol,
Android sources, sealed build 002 or the frozen cloud release.

The following checks passed with Node 24.18.0 and PowerShell 7:

```powershell
npm run typecheck
node --import tsx --test backend\tests\install-user.test.ts
npm run build
node --test scripts\tests\extension-package.test.mjs
npm test
npm run package:extension
```

The backend suite passed **29 tests**, including **9 installer checks**. These
cover credential pointers without credential copies, isolated user directories,
managed updates, unrelated-file preservation, incomplete bundles, absolute private
paths, linked/unmanaged targets, installation locks, rollback and retained recovery
files when rollback itself fails.

The standalone package check passed outside the source checkout in a fresh
temporary directory. It verified the ZIP checksum, per-file manifest and exact
archive allowlist, refused package overwrites, ran the bundled CLI with no npm
installation, checked explicit install consent and scope conflicts, and exercised
user installation/update plus the existing project/plugin modes.

After deleting the extracted distribution, two processes launched the installed
extension from different project directories without project extension files.
Both original fixture session IDs registered with a real loopback relay, one
paired fixture phone could see both, earlier history was projected, and a phone
message completed only in the intended session. **The SDK boundary was simulated**:
this demonstrates packaged bridge/relay operation, not actual CLI discovery,
extension trust prompts or live attachment to a user's session.

The generated development artifacts are:

- `dist\packages\DevPocket-extension-0.1.0.zip`
- `dist\packages\DevPocket-extension-0.1.0.zip.sha256`

No user's global extension directory, running CLI or private host configuration
was changed. No real host/device was enrolled, no extension was hot-loaded, and no
cloud or Android operation occurred. Temporary fixture processes and data were
cleaned up. The new GitHub Actions workflow has not been run remotely and no tag
or GitHub release was created; its tag-triggered publication target is a draft
extension release, separate from APK distribution.

## Standalone Azure setup checkpoint (2026-10-03, UTC+08:00)

This checkpoint and its review follow-ups use local UTC+08:00 dates. The
overnight October 3 runs occurred on October 2 in UTC.

This fork was fast-forwarded to the merged user-extension change before adding
setup. The inherited files matched that merged source byte-for-byte; no duplicate
installation change is included in the new work.

The following local checks passed with Node 24.18.0, PowerShell 7 and Python 3.12:

```powershell
npm run test:setup
node --test scripts\tests\extension-package.test.mjs
npm test
node --test deployment\onboarding\tests\action.test.mjs deployment\onboarding\tests\handoff.test.mjs deployment\onboarding\tests\registration.test.mjs deployment\onboarding\tests\acl.test.mjs deployment\azure\tests\package.test.mjs
```

`test:setup` includes the production TypeScript build and standalone bundles,
**20 JavaScript tests** and **3 Python guest-discovery tests**. The backend suite
passed **29 tests**, standalone extension distribution passed its integration
check, and the selected legacy onboarding/deployment packaging checks passed
**7 tests**.

Setup checks exercise target selection and scoping, confirmation refusal,
host-name collisions, private Windows ACLs, encrypted handoff, authentication
against a real loopback relay, installation under an isolated `COPILOT_HOME`,
and repeated setup without a second host identity. The actual extracted ZIP
also completed setup outside the source checkout using its own bundled command
and helper assets. The distribution still supports the prior project/plugin
installations and multiple original fixture sessions.

Failure coverage includes execution followed by a lost ARM response, GET-only
reconciliation of an accepted asynchronous operation, mutated immutable request
bodies, expired approval, changed Azure identity/VM/helper files, local host
authentication failure, install failure after finalization, and changed saved
credentials or installed files. A lost response without a saved Azure operation
URL remains visibly uncertain and blocks replay. The original encryption,
pre-commit registration recovery and legacy request-size checks still pass.

**Azure management responses and Linux guest environment discovery were
simulated.** Encryption, SQLite, the loopback relay, filesystem operations,
Windows ACL checks, archive construction and user installation were real but
isolated. These checks are not live Azure Run Command, public HTTPS, actual CLI
discovery/consent, or new phone acceptance. The new interactive enrollment still
needs a separately authorized real-target acceptance.

No Azure login/token retrieval, resource mutation, real host/device enrollment,
public endpoint request, global extension installation or existing-session reload
was performed. Setup does not change the relay wire contract or Android sources.
The previously sealed APK and running/frozen cloud release remain unchanged.
Temporary fixture processes and directories were cleaned up; no tag or extension
release was published by these local checks.

### Setup review follow-up (2026-10-03, UTC+08:00)

Focused regressions first reproduced both review findings: the token adapter
rejected azd's default raw-token output, and setup printed a pairing command
relative to the caller instead of the extracted package. Token acquisition now
explicitly requests JSON. Pairing instructions use absolute, PowerShell
literal-quoted paths for both the package CLI and the private configuration.

`npm run test:setup` passed **21 JavaScript tests** and **3 Python tests** after
the fixes. The extracted-ZIP check uses a directory containing spaces, an
apostrophe and a dollar sign, executes the printed command with `--help` from
its parent directory, and verifies the same command after completed-setup
re-entry. The standalone distribution check and all **29 backend tests** also
passed. The azd command adapter was simulated; a local `azd auth token --output
json --help` check did not request a token. No Azure credential retrieval,
real enrollment, device pairing or live extension loading occurred.

The next review identified that failures before dispatch and definitive Azure
401/403 rejections were incorrectly retained as uncertain submissions. The ARM
adapter now supplies typed non-admission evidence for those cases. The journal
records `not-admitted` and allows a subsequent run to retry the same body, scope
and hash after the cause is corrected. Transport/5xx failures, unreadable
responses and uncertain checkpoints still cannot authorize a replay.

The new regressions reproduced the lockout before the fix and now pass for
login failure, changed principal, request serialization and HTTP 401/403.
They verify no pre-dispatch fetch, no prematurely created host, and exactly one
host after a permitted retry. `npm run test:setup` now passes **28 JavaScript
tests** and **3 Python tests**; standalone distribution, **29 backend tests**
and **5 selected legacy onboarding checks** also pass. Azure responses remain
simulated, with no real management or credential operations performed.

A later review found that a partial configuration write could strand local
recovery, and that invoking the relay store constructor could create schema
objects before rejecting an incompatible database. Configuration publication
now uses the atomic JSON writer in exclusive mode: incomplete writes never
appear at the final path and concurrently created files are preserved. Host
registration opens the existing database without any schema-creation path,
validates the host-table contract, and shares only host-record insertion with
the relay.

Both configuration regressions failed before the fix and pass afterward.
Database checks verify missing files are not created, incompatible schemas retain
identical bytes, and a compatible host-only database gains no tables/indexes or
schema-version change when registering a host. `npm run test:setup` passes
**33 JavaScript tests** and **3 Python tests**; all **29 backend tests** and the
**5 selected legacy onboarding checks**, including the actual guest-bundle byte
limit, pass. These remain isolated local checks, not live Azure acceptance.

## Runtime capability evidence checkpoint (2026-10-06)

This is a separate source-worktree check of capability discovery without a CLI
version allowlist. The earlier real-CLI and sealed-build acceptance records are
unchanged; they do not qualify this adapter against every runtime build.

- `npm test`: **74 tests passed**, including recorded old, future, custom and
  missing versions; read-only discovery; independently disabled controls;
  missing SDK RPC trees, malformed and stalled probes; recovery; and rejection of stale capability
  grants before execution.
- `npm run typecheck` and `npm run test:extension-package`: backend compilation,
  extension bundling and standalone-package checks passed. The final package
  fixture was rerun with `node --test scripts\tests\extension-package.test.mjs`
  using an unfamiliar recorded version. Both isolated projects retained their
  original simulated SDK session identities and accepted scoped messages.
- `npm run schema`: regenerated the same protocol-v1 schema, with no contract
  diff. Backend and Android decoding preserve independent capability booleans
  without interpreting the diagnostic version.
- `scripts\build-android.ps1 -Jdk C:\Projects\DevPocket\.tools\jdk-21 -Sdk C:\Projects\DevPocket\.tools\android-sdk -Lint`:
  debug assembly, **67 JVM tests** and lint passed, with zero test failures,
  errors or skips and zero lint errors (**24 warnings**).

Additional regressions keep incomplete permission/question forms and excluded
or incompletely evaluated file paths unavailable. Unknown mutation
acknowledgements produce durable **uncertain** receipts; retrying the same
command does not repeat the operation. Cancellation still remains requested
until runtime evidence arrives. Android request cards and open confirmation
dialogs follow the relevant current capability rather than the messaging flag
or recorded version.

The SDK peers and standalone installation targets in these tests are isolated
fixtures. No real CLI was started, attached, reloaded or mutated; no real user
extension installation, host/device enrollment or cloud operation was performed.
The Android output was not installed, sealed or distributed. Real compatibility
checks still require separate opt-in for a disposable terminal.

## Runtime capability review follow-up (2026-10-07)

Two minimal regressions reproduced the review findings before the fix:
`node --import tsx --test --test-name-pattern 'unknown semantic fields|sending does not wait' backend\tests\runtime.test.ts`.
A known permission kind with an unknown execution-scope field was still
approvable, and sending waited for an unrelated stalled model catalogue.
Both regressions now pass.

Permission payloads use strict per-kind and nested schemas, preserving supported
live/snapshot dialects while rejecting unknown semantics. Every accepted
semantic field is displayed; documented SDK correlation/canonicalization
metadata is typed but not exported. Commands refresh only their prerequisite
probe group, sharing that group's in-flight read rather than a whole refresh.
Concurrent regressions verify unrelated model/policy/request probes cannot hold
up messages or answers, and a late unrelated response cannot restore a capability
rejected by a newer action probe.

`npm test` passes **105 tests**. `npm run typecheck` and
`npm run test:extension-package` also pass, including the production bundle and
standalone unfamiliar-version fixture. No wire, Android or deployment code
changed in this follow-up. No real runtime control, extension installation/reload,
emulator reinstall or Azure operation was performed for these review fixes;
earlier installed-build acceptance does not cover this new source revision.

### Question-envelope review follow-up (2026-10-07)

The targeted command
`node --import tsx --test --test-name-pattern 'unknown top-level|simple elicitation forms enforce' backend\tests\runtime.test.ts`
reproduced both unknown-envelope-field findings and the inaccurate short-answer
error before the fix. All three cases now pass.

Native questions and elicitation forms validate their complete payloads against
strict schemas before becoming answerable. Documented tool-call correlation
metadata remains typed and private; elicitation sources are shown to the user.
Unknown semantics, unsupported modes and malformed metadata require the original
client. Invalid request IDs produce a notice without poisoning pending wire
state, and replacement requests cannot retain stale form routing. Both short
and long answers now report that they are outside the supported length range.

`npm test` passes **111 tests**. `npm run typecheck` and
`npm run test:extension-package` pass as well. Positive regressions retain native
choices, free text, explicit form mode and legacy forms without a mode field.
The wire contract and Android sources are unchanged. No installed extension,
emulator app, original runtime or Azure deployment was updated for this follow-up.

### Mutation, live permission and Unicode review follow-up (2026-10-07)

The targeted command
`node --import tsx --test --test-name-pattern 'unknown mutation fields|unknown live permission envelope|competing live permission|limits count Unicode' backend\tests\runtime.test.ts backend\tests\bridge.test.ts`
failed before the fix: extra mutation fields produced completed receipts,
unknown/competing live permission envelopes remained approvable, and a valid
one-code-point supplementary character was rejected by a one-character form.
All four regressions now pass.

Mutation acknowledgements and model-switch confirmations now reject unknown
fields. The real relay/bridge journal tests cover native answers, elicitation,
permissions and model switches, keeping incompatible results uncertain and
immutable retries non-repeating. Known supported acknowledgement variants remain
accepted; this does not claim compatibility with unmodeled runtime result fields.

Complete live permission envelopes are validated before payload selection.
The documented original-request/prompt pair remains supported when both describe
the same operation, with both sets of details visible. Unknown outer constraints,
unsupported risk metadata, conflicting aliases and hook-resolved requests cannot
be approved remotely. Snapshot refreshes preserve stricter live evidence, including
late responses and reattachment from history; invalid IDs never poison wire
frames. Primary and alternate form lengths use Unicode code points while the
existing protocol-v1 answer size ceiling remains unchanged.

`npm test` passes **129 tests**. `npm run typecheck` and
`npm run test:extension-package` also pass. Android, the serialized protocol and
deployment sources are unchanged. These are source/isolated-fixture checks; no
installed extension, original runtime, emulator app or Azure service was changed.

### Live cancellation and snapshot-order review follow-up (2026-10-07)

The focused runtime/bridge regressions reproduced active non-abortable work
advertising Stop, discarded abort result objects being acknowledged, stale
permission snapshots removing new requests or resurrecting completed ones, and
unknown model policy states becoming enabled. These regressions now pass.

Active work requires an explicit `abortable: true`; idle runtimes retain support
when the field is a valid boolean. Only the known `undefined` SDK abort result
acknowledges cancellation. Unknown result objects remain durable uncertain
receipts and are not re-executed on immutable retries.

Each permission read tracks the request IDs changed while it is in flight.
Late snapshot entries/removals cannot override those events or confirmed
responses, while untouched IDs still reconcile normally. The guard is released
on failed reads. Provided model policy states are restricted to the SDK's
documented `enabled`, `disabled` and `unconfigured` values; only `enabled` is
selectable, and unknown/incomplete policy objects fail closed.

`npm test` passes **138 tests**. `npm run typecheck` and
`npm run test:extension-package` pass, including the production bundle and
isolated unfamiliar-version fixture. Wire, Android and deployment sources are
unchanged. No installed extension, real runtime, emulator or Azure service was
updated for this review iteration.

### Form labels and prompt cancellation review follow-up (2026-10-07)

`node --import tsx --test --test-name-pattern 'unmapped enumNames|cancellation is invoked before' backend\tests\runtime.test.ts`
reproduced discarded enum labels and a stalled queue read delaying the actual
abort call. Both tests now pass.

Forms containing `enumNames` are terminal-only until the wire/UI supports an
explicit label/value mapping. Ordinary enum choices remain supported.
Cancellation dispatches the optional queue read first, then calls the original
runtime's abort without waiting for that read. The bounded result still supplies
available queue evidence; timeout/failure cannot suppress cancellation or invent
cleared message IDs. Strict abort-result validation and runtime-confirmed
completion remain unchanged.

`npm test` passes **144 tests**. `npm run test:extension-package` passes, including
production TypeScript compilation, bundling and the isolated installed-package
fixture. Tests cover ordinary enums and unsupported labelled layouts, dispatch ordering,
SDK method binding, queue timeout/failure and unknown abort results. No wire,
Android or deployment sources changed, and no real runtime/extension reload,
emulator reinstall or Azure operation was performed.

### Permission aliases and complete form definitions (2026-10-07)

`node --import tsx --test --test-name-pattern 'conflicting target aliases|every accepted elicitation schema field' backend\tests\runtime.test.ts`
reproduced contradictory aliases comparing as the same permission subject and
accepted form metadata disappearing from the display. Both regressions now pass.

Command, path, URL, server and argument aliases must agree before either a
snapshot or a live permission payload can be approved. Equivalent aliases,
including reordered object arguments, remain supported. Forms now display their
complete validated definition, including schema-level and alternate-field
titles/descriptions/defaults and constraints. Defaults do not supply automatic
answers. Definitions that exceed the display budget or require redaction remain
in the original client, as do unsupported `enumNames` forms.

`npm test` passes **149 tests**. `npm run test:extension-package` passes,
including production TypeScript compilation, bundling and the standalone
fixture. The PR evidence is updated to the commit containing these results.
No serialized protocol, Android or deployment sources changed; this validation
does not extend earlier installed-extension or emulator acceptance.

### Unique identities, retired requests and literal enum choices (2026-10-07)

`node --import tsx --test --test-name-pattern 'duplicate permission IDs|duplicate model IDs|snapshot-removed permission ID|single-field Other' backend\tests\runtime.test.ts`
reproduced ambiguous duplicate identities, cached evidence surviving a confirmed
request removal, and `Other` being hidden from a single-field enum. All four
regressions now pass.

Snapshots/catalogues with duplicate IDs are rejected, even if duplicate entries
look identical. Valid snapshots retire live evidence only for removed IDs that
were not changed during the read; still-pending restrictions remain intact.
Single-field enums preserve literal `Other` choices and do not accept arbitrary
text. An alternate field is required before enabling the custom-answer route.

`npm test` passes **157 tests**. `npm run test:extension-package` passes,
including production TypeScript compilation and the isolated package fixture.
Additional regressions cover evidence recovery, invalid versus authoritative
snapshots, concurrent live requests, and localized literal enum choices. The PR
Evidence section is refreshed for this revision. Wire, Android and deployment
sources are unchanged, and no installed runtime or application was updated.

### Relay capability recovery follow-up (2026-10-07)

`node --import tsx --test --test-name-pattern 'cached relay capabilities' backend\tests\bridge.test.ts`
reproduced the relay returning HTTP 409 from its cached false capability while
the original runtime had recovered and an unrelated model probe was stalled.
The real local relay/bridge/SQLite regression now passes: the authorized command
reaches the bridge's action-specific check and completes once. A subsequent
currently unsupported action gets a failed receipt without invoking the runtime.

Relay capability booleans now advertise UI state rather than veto fresh commands.
Authentication, device/host/session ownership, immutable retry handling and
offline refusal remain enforced. Readiness additionally requires an open socket:
the existing disconnect regression exposed the closing-socket race, and now
passes without changing its assertions or timing.

`npm test` passes **158 tests**. `npm run typecheck` and
`npm run test:extension-package` pass, covering production compilation/bundling
and the isolated installed-package fixture. The wire and database formats and
Android sources are unchanged.

Unlike the earlier extension-only version-gate removal, this follow-up changes
relay behavior. Existing protocol-v1 relays remain compatible but retain their
cached veto until upgraded. Deploy the updated relay to obtain this recovery
improvement; no Azure deployment, installed extension reload, device enrollment
or emulator reinstall was performed here.

## Model picker and immediate model synchronization (2026-10-08)

The following focused regressions reproduced the reported symptoms before the
fix:

- `node --import tsx --test --test-name-pattern 'confirmed model switch' .\backend\tests\bridge.test.ts`
  observed a completed switch to `new-model` in the SDK peer while the phone's
  real HTTP catalogue still returned `old-model`.
- `node --import tsx --test --test-name-pattern 'model switch confirmation|deferred model switches' .\backend\tests\runtime.test.ts`
  reproduced reuse of a model probe started before the switch, and the absence
  of a visible queued-switch notice.
- From `android`, `.\gradlew.bat --no-daemon --console=plain :app:testDebugUnitTest --tests 'dev.devpocket.app.ModelDialogTest'`
  reproduced missing reasoning controls on opening the dialog and after model
  selection with a long catalogue in a phone-sized Compose layout.

The causes were the unselected initial model, reasoning controls placed after
the entire model list, delayed bridge summary publication, and coalescing a
post-switch read with older in-flight evidence. The picker now preselects the
observed model/reasoning, uses a bounded model menu, and keeps reasoning controls
in its independently scrollable form. Enumerated levels come only from live
runtime evidence; manual entry remains runtime-validated. The editable form has
an explicitly bounded adaptive dialog window: its regression also caught
non-settling wrap-content measurement when the manual field became visible.

Model and explicit-refresh commands publish their observed summary before
receipts; pending summary delivery survives socket backpressure. This does not
publish stale snapshots for unrelated controls. A coupled regression verifies
that a later Stop still displays `cancel_requested`, not the preceding
`running` snapshot. Post-switch probes cannot reuse a pre-switch read, and a
deferred switch retains the active model with a queued notice until live
evidence confirms the new state.

`npm test` passes **161 tests**, and `npm run build` passes production TypeScript
compilation and bridge/standalone-command bundling.

```powershell
.\scripts\build-android.ps1 -Jdk C:\Projects\DevPocket\.tools\jdk-21 -Sdk C:\Projects\DevPocket\.tools\android-sdk -Lint
```

The Android command passes debug APK assembly, **76 JVM tests** with no
failures/errors/skips, and lint with zero errors (24 warnings). The nine new
Compose regressions cover current-model preselection, reasoning visibility,
exact selection callbacks, manual input/default reset, asynchronous catalogue
loading, capability/policy changes, state restoration, and landscape with
doubled font size. Temporary diagnostic tests were removed.

These are isolated source-worktree checks using simulated SDK peers with real
local HTTP/WSS/SQLite and Robolectric Compose UI. They are not acceptance of a
physical phone or a live Copilot build. The development APK is
`android\app\build\outputs\apk\debug\app-debug.apk`; no APK was installed,
distributed or sealed, and no existing runtime, installed extension, device
grant or cloud relay was changed. Both the APK and bridge need updating for the
complete fix. Protocol-v1 shapes and persisted formats are unchanged; no relay
or schema migration is required.

### Model synchronization review follow-up (2026-10-08)

The review identified two boundary failures in immediate summary publication:

```powershell
node --import tsx --test --test-name-pattern 'socket backpressure threshold|live turn start already' .\backend\tests\bridge.test.ts
```

Both tests failed before correction. A summary crossing the 2 MiB socket-buffer
threshold marked the next unsent event batch in flight, so its nonexistent
acknowledgement stranded subsequent delivery. Separately, a turn-start event
already delivered and acknowledged changed the relay to `running`, but a model
command published an `idle` summary derived from the older activity cache.

The bridge now marks a batch in flight only after a successful send. Runtime
summaries use live activity observations independently of probe-gated control
capabilities. Activity reads remember the observation revision at their start,
so a late read cannot erase a newer turn-start/idle event; a subsequent fresh
read can still reconcile state. Cancellation remains requested across a
turn-start event until live idle evidence confirms completion.

The original real local HTTP/WSS/SQLite regressions now pass without reconnecting
the bridge. Additional runtime regressions cover both live activity directions,
newer versus older reads, absent control evidence, and cancellation ordering.
`npm test` passes **168 tests**; `npm run typecheck`, `npm run build`, and
`node --test .\scripts\tests\extension-package.test.mjs` also pass. The package
test uses isolated simulated sessions, not an installed working CLI.

Android and wire formats are unchanged by this follow-up; the earlier Android
acceptance remains a separate record and was not rerun here. No live runtime,
device installation/enrollment, extension reload or cloud operation was
performed.
