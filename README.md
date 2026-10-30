# DevPocket 0.1.0 (development)

DevPocket is a **native Android app written in Kotlin and Jetpack Compose** for **GitHub Copilot** sessions on a Windows Dev Box, in either **GitHub Copilot CLI** or the **GitHub Copilot desktop app (Copilot App)**.

The phone joins a **registered, already-running GitHub Copilot runtime** through an opt-in extension calling `joinSession()` from the runtime's bundled extension SDK, preserving the original process and session identity.

The **original client** means the CLI terminal or desktop app hosting that session. Compatibility depends on extension loading, the bundled SDK and live capability evidence, not the client name alone. This does not imply support for every GitHub Copilot surface or build; the historical CLI checks below are not desktop-app acceptance evidence.

```text
Native Android (Kotlin / Compose / OkHttp / Keystore)
        | HTTPS commands + WSS user-facing events
DevPocket relay (Node 26 / TypeScript / SQLite)
        ^
        | outbound authenticated WSS only
Dev Box extension -> joinSession() -> original GitHub Copilot runtime (CLI or desktop app)
```

## What is implemented

| Area | Behavior |
| --- | --- |
| Native adaptive UI | Material 3; compact single-pane list/detail and bottom navigation; medium navigation rail; expanded list/detail panes; light/dark/system theme, dynamic color, edge-to-edge/IME insets, system Back, preserved drafts and reading position |
| Pairing | Offline administrator-provisioned hosts; five-minute, 256-bit, one-use pairing; independent phone credentials; multiple hosts/relays; host-specific device revocation |
| Extension installation | Install once for the OS user; all projects' GitHub Copilot sessions that load the extension register automatically, without per-project switches; standalone ZIP distribution, no source checkout or npm dependencies on the target |
| Azure setup | One interactive command uses an existing azd login to register a new Dev Box with a verified running relay, encrypt the credential handoff, and install the user extension; no old deployment checkout, new public endpoint or relay restart |
| Sessions | Registered original runtime only; same-repository worktrees share a project group, with per-session branch/worktree labels and search; pin/rename/archive metadata; explicit offline/unsupported state |
| Chat | Earlier visible history, live assistant/tool output, bidirectional original-client/phone messages, durable command IDs, queued/admitted/processing/completed/uncertain delivery, offline drafts and replay |
| Human decisions | Known permission forms: approve once or reject; actual permission mode is read-only; questions with exact choices/free text; confirmed question/answer history is read-only; stale results are errors; unsupported forms visibly require the original client |
| Stop | Sends `session.abort()` to the original runtime; shows **cancellation requested**, not stopped, until runtime idle evidence. Detached/background child processes must still be checked in the original client |
| Models | Lists the original GitHub Copilot runtime's models/reasoning levels; validates the selection; does not override organization policies or automatically approve model-switch compaction |
| Files/attachments | Policy-aware project browsing; text/image previews, bounded downloads, PDF save/open through a trusted external app; <=2 MiB upload, <=4 per message, session-scoped IDs/checksums |
| Git | Read-only status, branch, staged/unstaged per-path diffs; no commit, staging, checkout or push; no shell interpolation |
| Notifications | Opt-in foreground-service background monitoring of all paired hosts' unarchived sessions, generic local reminders and a Stop notification; optional FCM remains separate and **unconfigured** until provisioned |

Error messages keep their text, normal display duration and dismiss action, but
reserve space below the page content rather than covering it. Session cards
remain reachable by normal scrolling and tapping while an error is visible,
including in landscape and short windows. The error area is height-bounded;
long messages scroll within it without truncating their text, while the dismiss
action remains outside the scrolling text. The session toolbar, search and
filters scroll with the cards, so those controls cannot consume the entire
session viewport in a short window.

Current limitations:

- Only registered live sessions can be controlled. No automatic scan/resume of unregistered GitHub Copilot history; no "create GitHub Copilot session" command.
- The recorded runtime version is diagnostic only, not an allowlist. Each control requires its own live evidence and supported response/request shapes through the runtime-bundled SDK. Missing or incompatible evidence disables only the affected controls; an unfamiliar or missing version does not disable otherwise supported controls. GitHub Copilot CLI **1.0.90-0** remains a historical acceptance target, not proof of compatibility for every build or client.
- Pending tool permissions can be reconstructed at attachment. The adapter has no pending-question snapshot; a question already open at *first* attachment may require the original client. Live questions and simple string/choice elicitation forms are supported. Complex elicitation, URL redirects, sandbox-bypass, plan-exit, limit and unknown permission forms require the original client.
- Incoming messages use the runtime SDK's `mode: "enqueue"`. Sending during a tool does **not** immediately change or kill that tool. `queued` is reported only when observed in the runtime's public queue; `admitted` alone means delivery is acknowledged but execution has not been confirmed. The runtime's plain abort also clears queued input; the confirmation dialog warns about this and known cleared messages become cancelled after runtime idle evidence. Text and attachment metadata can be manually restored as a new draft.
- The composer has one primary Send/Stop button. Nonblank draft text always selects Send, including while work is running. With no text, running, waiting and cancellation-requested sessions show Stop in that same position; idle sessions never show Stop. Offline/capability/upload restrictions still govern availability, and Stop opens the existing confirmation before requesting cancellation.
- Renaming/pinning/archiving changes DevPocket metadata, not GitHub Copilot storage or running work.
- Git and files fail closed if the runtime cannot evaluate content exclusion (observed in this non-Git disposable runtime). Secrets/private configuration, `.git`, runtime directories, symlinks and junctions are not exposed. Text preview <=256 KiB; image/PDF <=2 MiB; 200 directory entries/300 Git entries per response.
- Reasoning choices come from each model's live catalog, including the native runtime's `capabilities.supports.reasoning_effort` array and supported SDK/legacy field variants. Only when no levels are enumerated does the app offer explicit text entry **validated by the original runtime** rather than inventing a supported list; malformed lists disable model controls instead of becoming manual input.
- History imports the latest 15,000 runtime events; relay keeps the latest 20,000 visible events per session. Replay pages are byte-bounded (512 KiB). Android stores the latest 6,000 events and bounds decoded history text to 8 MiB. Cursor reset is shown when retention changes. Original history remains in the original client.
- Android hides completed assistant messages with no visible text after merging their events, including cached history. Tool-only turns no longer leave empty GitHub Copilot bubbles; streaming placeholders, normal replies and separate tool cards remain. The underlying events and delivery bookkeeping are retained, so late deltas cannot revive a completed empty message.
- Attachments expire after seven days, with a 20 MiB per-session relay quota. Private Dev Box attachment staging remains until the operator removes its isolated bridge data; do not remove attachments while GitHub Copilot is using them.
- The separately authorized Azure relay is running with publicly trusted HTTPS. Public checks, a temporary simulated controller, and the sealed native Android build's actual pairing/message roundtrip on a visible isolated emulator passed against the same ordinary CLI. The emulator login is retained for user trial; physical-phone/cellular acceptance is still pending. FCM, release signing and store distribution remain unprovisioned. Opt-in background monitoring is best-effort, **not** a system-push or vehicle-wake guarantee, and is not part of sealed build 002's acceptance.

## Component cards and response groups

The current development implementation receives the validated `line`, `bar`,
`datagrid` and `markdown` subset from the installed
`plugin:agenticdeck-gh-app-extensions:agenticdeck-canvas` provider. The adapter
uses runtime canvas identity records and successful tool completions, not a
matching action name alone. Root-agent output follows the existing bridge
visibility policy; unsupported or unavailable output stays in the original client.
This is not generic Canvas, nested-agent, CLI-visualization or iOS acceptance.

The independently authored `packages\components` package contains the data
contract and offline web renderer. Android keeps its native Compose shell and
loads bundled assets in a restricted WebView. Cards appear in the conversation
and open into a full-screen detail view; there is no prototype layout switcher,
fixed turn-navigation bar or generated suggestion row. Markdown does not execute
HTML or load images. External links require a native confirmation.

Cards are append-only history. Clearing the desktop AgenticDeck panel does not
delete mobile conversation history. The existing relay/phone retention windows
still apply. Component JSON is limited to 256 KiB, tables to 1,000 rows and 20
columns, and charts to 1,000 values across their series. Invalid or oversized
content is reported rather than silently truncated. Canonical JSON bytes travel
as bounded base64 with a SHA256 digest, so native clients can verify their exact
content without reserializing numbers or Unicode.
Conventional credential-field aliases, including `client_secret`, `clientSecret`
and `secret_key`, are masked before encoding and reference retention, not merely
hidden in the displayed cell. The same classification applies to table labels
and URL query names, including labels such as `API key (production)`; assigned
credential values in text use the shared redactor.
Sensitive table columns with a static or templated `href` are rejected before
transport and reference retention; masking only the displayed value cannot make
those link targets safe. Ordinary links remain supported.
Credential-bearing templates, including credentials revealed only after
substituting ordinary row fields, are also rejected: masking the URL alone
must not leave its source values in the transported or retained component.
Unresolvable templates stay in the original client with an explicit unavailable
card, rather than exporting row data whose link context cannot be checked.
Sensitive URLs with ambiguous raw quote or angle delimiters also remain in
the original client; partial URL masking must not expose a credential suffix.
Ordinary quoted URLs and fully encoded private values retain their normal
preservation or redaction behavior.
URL inspection covers HTTP(S) spellings accepted by the renderer and repeats
after control-character cleanup. Unicode whitespace that remains part of a
URL value is inspected with that value, not split into an exposed suffix.
Column sensitivity considers both original and cleaned labels, and template
links are checked again against the final projected rows.
Markdown inspection shares the renderer's
parser, including decoded destinations, text and reference definitions; escaped
content that would reveal credentials stays in the original client.
Inline text is also checked across formatting such as bold and code spans.
Separate blocks, table cells and non-text placeholders are not joined into
invented assignments.
Recognized assignments mask complete quoted values, including escaped quotes;
unterminated quotes fail closed. Dash-qualified names support hyphens and en/em
dashes. Ordinary bare values end at a line, comma or semicolon; dash-qualified
assignments, Cookie/Set-Cookie headers and unquoted authorization headers are
masked through their line. Known token patterns consume the full base64url
body, including hyphens, rather than leaving a reconstructable suffix.

Ordinary assistant segments, tools and cards share response styling only when
runtime origin/tool-request evidence establishes their relationship. Model
`turnId` is not a session-global response key. Unrelated or unproven entries remain
independent; queued user input and pending decisions are not moved or hidden.

Referencing a successfully rendered card preserves the draft and creates a removable explicit reference.
It does not send a message. On Send, the bridge resolves the same-session card
and its digest and stages its safe contents as a private JSON attachment for the
original runtime. This consumes one of the four attachment positions and leaves
the user's question text unchanged. A missing, changed or evicted reference is
an explicit failure, not a title-only substitute.
Concurrent references to the same card wait for one complete staging write;
their command IDs and runtime deliveries remain independent, and later uses
still verify the completed attachment's integrity. The bridge retains at most
32 MiB of reference records; private staging follows the existing attachment
cleanup rules. Failed message records retain their reference and can be restored
as a deliberately new draft.

Protocol v1 negotiates `components=1` per bridge connection before transmitting
component events and extra tool-link metadata. Legacy relays receive a visible
fallback and unchanged ordinary-message shapes. Android cache version 2 preserves
version-1 data on upgrade; downgrading an existing cache is intentionally refused
so an older client cannot drop a reference field and retry a changed command.

These implementation notes do not replace fresh source-bound verification or
real original-client/device acceptance; see `VALIDATION.md` for recorded evidence.
The Android asset task runs the complete component package build, so standalone
native checks also have the exported Node contract needed by their relay fixture.
It does not depend on a previous backend build or a cached `dist` directory.
The manual `ConnectedFlowTest` component path requires `components=true` and
separate authorization for its actual App session, local bridge/relay, owned
device, pairing and three messages (echo, four-card rendering, and reference).
It checks exact card data, origin association, native rendering, preserved drafts
and an SDK-visible reference attachment. It cannot be combined with the older
`extended=true` permission/cancellation experiments. Automatic device verification
continues to exclude this real-runtime test rather than silently opting into it.

## Question history

Supported choice questions, free-text questions and simple elicitation forms
keep their full safe question details and confirmed answer in the conversation.
Completed records have no answer buttons or editable fields. Tool cards remain
separate; an assistant does not have to repeat the answer for it to be retained.
Permission approvals and unsupported/complex forms are unchanged.
Question snapshots omit unavailable optional workspace metadata; this does
not enable file access or relax live question-capability checks.
History positions are applied on the next layout pass instead of forcing a
nested measurement during cache replay. Live and cached updates preserve an
ongoing drag or fling; selecting Latest during a fling returns to the new tail
after that motion finishes. A final question taller than the chat viewport
aligns to its measured bottom instead of jumping back to its header when the
reader reaches the answer controls.
Following also reacts when an earlier question gains a longer confirmed answer,
even if the last message and number of rows have not changed.

Android durably stages an answer with its original command ID, immutable body,
question snapshot and account/host/session scope before submitting. Submitting,
awaiting confirmation, failed and uncertain attempts remain distinguishable from
a confirmed answer. A sent command, a generic delivery completion or a vanished
pending card is not proof of the chosen answer. Confirmation requires the
original runtime's validated success for that operation, or its corresponding
scoped full receipt. Recovery queries that same command; an explicit transport
retry reuses its ID and body rather than submitting a fresh answer.
After validated success, the bridge atomically retains the completed receipt
and its safe confirmation before projecting events. A full event queue cannot
turn that accepted operation into a deterministic failure: confirmed history
waits for capacity and survives bridge restart until acknowledged. If that
confirmation transaction itself cannot persist, the outcome stays uncertain
and the same operation is not executed again.

The bridge publishes only validated, redacted question projections, not raw
SDK events, tool arguments or tool results. If the original client answers and
the bridge cannot establish the actual answer, history says that the answer is
unknown; it never substitutes the phone's attempted selection.
If a runtime-confirmed answer contains only stripped control sequences and whitespace, history
uses the explicit `[REDACTED]` marker instead of losing that confirmation.
This safe display projection never changes the answer submitted to the runtime.
Receipt-only Android recovery applies the same display sanitization without
rewriting the stored immutable command. A marker never supplies missing
confirmation or another client's unknown answer.
Command recovery loads all of the latest 100 scoped outbox records, including
large question snapshots, without applying the separate event-display text
budget. A newer large snapshot cannot hide an older retained unresolved command.
Question reconstruction uses SQLite's actual retained cursor boundary, not the
first event in a byte-limited display slice, so a still-retained answer attempt
cannot disappear and re-enable a new submission. Actual resets and pruning still
retire old history.
Question records use the existing relay event retention and Android SQLite
cache, including replay, scope checks, cache reset, account removal and backup
exclusion. Reopening a session or rebuilding the Activity does not remove them.
The existing history limits still apply; this is not an unlimited archive.

Protocol v1 negotiates `questionHistory=1` on each bridge connection before
sending the optional `question` event kind. Updated relays acknowledge
`questionHistory: true` only when requested, preserving strict legacy ready
frames. Older Android clients ignore that event kind. A new bridge connected
to an old relay sends legacy-compatible notices instead and warns that shared
confirmed question history needs a relay update; commands and their scoped
receipts remain compatible.

Old bridges and persisted records still decode without a database migration.
Android can retain question text from old request snapshots, but cannot invent
an answer that was never recorded. Pre-upgrade answers without a saved,
confirmed operation, questions predating first attachment without a live
snapshot, and history outside the retention window cannot be recovered by this
fix. Before downgrading a relay to a strict decoder that does not recognize
question events, restore its matching pre-upgrade database backup. Installation,
reload, deployment and real-client acceptance remain separately authorized
operations; a source change does not update an installed client.

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

Unavailable workspace metadata is omitted from summaries and refresh receipts.
Pending-request synchronization remains available when file/Git policy or
repository identity cannot be verified. File/Git access still requires its own
live capability and policy checks.

Existing persisted sessions remain readable without a migration. Old bridges
and offline records keep their previous grouping until the original runtime
registers through an updated bridge; DevPocket does not scan or resume them.
The updated Android app, bridge and relay are needed for the complete display.
Before downgrading a relay to a build that rejects workspace metadata, restore
its matching pre-upgrade database backup rather than opening newer summaries
with the old strict decoder. Installation, reload and deployment remain separate
operator-authorized actions.

## Apple native offline milestone

`apple/DevPocket/DevPocket.xcodeproj` is a native SwiftUI app targeting
**iOS/iPadOS 27.0 and macOS 27.0**. Duo-specific reserved-region APIs are used
only when available on iOS 27.1 or later. Its first milestone uses only explicitly labeled,
fictional, resettable local fixtures. It has no relay pairing, runtime connection,
host/device credentials, push registration or production account support.
The session-list actions menu includes an **Add computer** entry that opens
a native pairing page explicitly marked as not yet connected. This offline
entry does not collect pairing credentials, request camera access or pretend
that a computer has been paired.

The workbench, navigation, conversation, composer, decisions and read-only
file/change examples are SwiftUI. Only component contents use a restricted
WKWebView with the existing `packages/components` renderer and its `line`, `bar`,
`datagrid` and `markdown` contract. The HTML design prototype is not bundled.
Component bytes retain their base64 and SHA256 identity; renderer success gates
native references. Later replies append cards rather than replacing old ones.
Native controls keep their platform styles with an adaptive blue accent. The
Apple WK host uses Glass Workbench's neutral surfaces and blue links in both
appearances, without changing Android's component theme or supplied series colors.
All Apple layouts share a session library: all sessions, pinned, attention,
archived, projects and computers. Project and computer filters can be combined
with native search across titles, projects, computers and branches. Pin, rename,
archive and restore change local metadata only; archiving does not confirm or
cancel work, and unresolved items remain reachable through Attention.
One native navigation hierarchy presents the session list and conversation:
compact windows navigate between them, while wider windows show adjacent panes.
The list's scope menu switches collections; projects and computers are filters,
not an additional permanent navigation column.
iPad has no additional app-level tab/sidebar hierarchy. Files and read-only
changes belong to the selected conversation, not separate app destinations.
Two persistent native toolbar toggles open, switch and close their inspector.
Its compact sheet has a Files/Changes picker and Close action; a wide inspector
has no duplicate toolbar. The conversation remains visible beneath the shared
toolbar, with a leading native inline-large title on iOS and the native window
title/subtitle on Mac. Component readers are modal on every layout and have
one Close action; closing preserves the draft and original reading context.
Text and public tool activity remain in a continuous reply, with separate native component cards.
The small decision-form fixture threads keep their rows mounted during keyboard
resizing; other timelines retain lazy mounting for component content.
The native card summary derives the fictional task total from the validated
component data; it does not add fields to the component transport.
Reader range and chart/data controls change only local viewing state, preserving
the original card and its payload when closing, reopening or resizing the reader.

On a Mac with Xcode 27.1, Node 26.12.1+ and npm 12.2.1:

```sh
npm ci --registry=https://packagefeedproxy.microsoft.io/npm/
node apple/prepare-components.mjs
open apple/DevPocket/DevPocket.xcodeproj
```

Select the shared **DevPocket** scheme and an eligible Mac or simulator, then
Run or Test in Xcode (or the explicitly bound Xcode MCP workspace). The preparation
command invokes the existing component build, validates `apple/Fixtures/components.json`
and writes ignored `apple/DevPocket/Renderer` assets, including dependency notices.
Run it again after renderer or fixture changes. Missing resources fail explicitly.
No Swift package download, development team or distribution signing is required
for the local Mac/simulator build; physical installation is separate.

Settings has one primary entry: the native Mac Settings menu,
or the mobile session-list actions menu. Its shared form exposes appearance,
offline fixtures, the next simulated receipt and a confirmed reset; conversations
and readers do not repeat a settings button. Mac keeps its native search field
and filter menu above the session list, with Command-K to reveal and focus search.
Library scope, search, filters, drafts and fictional history persist in the app's
own backup-excluded Application Support `DevPocketFixtures/state-v1.json`; interrupted operations
become uncertain, never automatically resubmitted. View-only chart/table state is
retained by the in-process renderer while navigating and resizing, not after a
fixture reset or app termination. The renderer cache retains recent surfaces
(16 cached views, evicting detached views first and never evicting attached views);
eviction discards only view state, never historical card data or draft references.
Component references preserve draft text and
consume one attachment position in the existing contract; there is no real
attachment staging or runtime delivery in this milestone.
The current fixtures span two fictional projects and two fictional computers.
Updated fixtures do not overwrite existing saved sessions, cards, colors or drafts;
use the confirmed local-example reset to load the revised set. Older saved stores
without library preferences remain readable.
Unrelated message or decision receipts cannot clear an outstanding cancellation
or enable a duplicate Stop. Its own confirmed or explicitly failed outcome resolves
the request; an uncertain cancellation remains visibly unconfirmed after relaunch,
without replaying the abort or enabling another Stop.

NavigationSplitView and system toolbars adapt the session list, conversation
and inspector to available space. Component readers remain native modal sheets
at every window width, rather than replacing or narrowing the conversation.
iOS 27.1
`GeometryProxy.reservedRegions(kind:)` informs split sizing when available without
hardcoded hinge dimensions; iOS 27.0 uses normal native width and safe-area
adaptation. Native containers handle the reserved regions. Every reader
has one Close action, and local chart/table viewing state survives resizing.
Closing restores the conversation's reading anchor and draft. This is not
physical folding, touch, performance or every device/window configuration acceptance.
The installed simulator runtime must actually support the chosen device.
Use an eligible iOS 27.0 runtime for ordinary iPhone/iPad and iOS 27.1 for Duo;
each result must retain its actual device and runtime identity.

On macOS the App Sandbox outgoing-network capability is needed by the observed
WebKit helper startup path, even for offline resources. It permits the **whole Mac
app sandbox** to make outbound connections; it is not a helper-only entitlement.
The milestone remains offline through its implementation: no native networking
client, a five-resource custom-scheme allowlist, WK resource-blocking rules, CSP,
navigation denial and a narrowly validated presentation bridge. External links
require a native confirmation. Do not treat the entitlement as permission to
connect a real service, or the UI restrictions as an OS-level network prohibition.

The Swift Testing suite covers combined library filters, metadata-only actions,
attention navigation, old-store compatibility, exact bytes, host-message/resource
boundaries, immutable operations, references, stop/decision confirmation,
persistence and real WK rendering. XCTest UI cases exercise native library,
settings and conversation controls. Dynamic Type
is checked against UIKit's actual font metrics in every standard and
accessibility size category, including wrapped metadata and reachable composer
controls; native accessibility audits separately check hit regions and descriptions.
Retain actual
results and platform gaps; a successful build or a skipped/unrun UI test is not
acceptance. Use the source-selected Apple platform gate with the actual
native qualification request passed through `-AppleEvidence`. Shared changes in
the fixed-base cumulative diff still retain their affected-platform checks.
Hosted CI runs the Apple roles independently and retains the real WK loading,
presentation and security checks. The separate Mac chart-pixel assertion remains
part of same-candidate complete native acceptance, not a deleted test or a hosted
pass. Follow the [hosted Apple coverage contract](docs/DEVELOPMENT-WORKFLOW.md#hosted-apple-ci)
before treating a green CI matrix as ready for delivery.

Local Mac UI automation needs an unlocked, interactive desktop. It keeps the
user's input source: the input helper sends the first real key, waits for the
transient input-source hint to disappear, then types and commits the remaining
fixture text. Chinese language launch arguments do not select the keyboard input
source. Do not switch that source, bypass native permissions, or treat ASCII
fixture checks under Pinyin as complete Chinese/third-party input-method acceptance.

The selected Glass Workbench requirements remain in
[docs/APPLE-CLIENT.md](docs/APPLE-CLIENT.md). Preserve the self-contained visual
reference in `docs/prototypes/apple-client`: `node serve.mjs` starts its loopback
preview without a build. Its device frames and simulation toolbar are design
tools, not the native application. Custom transitions remain deferred.

## Layout

```text
android\             Native app, Kotlin state/storage/network, Compose UI, tests
apple\               Native SwiftUI offline fixtures, restricted WK host and tests
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

## AI development workflow

The repository's **devpocket-development skill** is the default agent route for
feature implementation and bug fixes under `AGENTS.md`. The
[short recipe](.github/skills/devpocket-development/SKILL.md) keeps the owning
session in its linked worktree and points to the
[authoritative development guide](docs/DEVELOPMENT-WORKFLOW.md).
Discussion, planning, read-only review and documentation-only tasks do not start
the implementation pipeline. Use the original client's tools and existing CI.

**Choose the delivery route:** reviewed working-tree changes are the default.
[Local delivery](docs/DEVELOPMENT-WORKFLOW.md#delivery-targets-and-candidate-preparation)
does not acquire upload authority. [CI-first PR delivery](docs/DEVELOPMENT-WORKFLOW.md#ci-first-delivery-and-live-qualification)
uses permitted focused checks, an authorized candidate and pending Draft PR,
then the complete hosted gate, independent review and live freshness before ready.
The original task base stays fixed. Neither route authorizes merge or deployment.

**Execution scope:** [Scoped approvals](docs/DEVELOPMENT-WORKFLOW.md#scoped-development-approvals)
separate local control adoption from ordinary hosted CI and publication.
[Workspace-local setup](docs/DEVELOPMENT-WORKFLOW.md#workspace-local-prerequisites)
covers required locked dependencies/tools after a manifest change or actual
missing-prerequisite failure, not global installation or changed control adoption.
[Unattended execution](docs/DEVELOPMENT-WORKFLOW.md#unattended-execution) reuses an
explicit task grant; autopilot does not create one. The
[autonomy rules](docs/DEVELOPMENT-WORKFLOW.md#task-scoped-autonomy) preserve user
limits/cancellation without a project-default time, credit or repair-round cap.

Apple-only feature changes use the [Apple platform gate](docs/DEVELOPMENT-WORKFLOW.md#apple-platform-verification)
locally and in CI. Shared renderer/protocol/infrastructure changes retain their
cross-platform requirements; this is not a blanket directory-based execution grant.
For a full local suite that exceeds one Xcode MCP call, use
[Complete local batches](docs/DEVELOPMENT-WORKFLOW.md#complete-local-batches):
fresh native catalogues and complete RunSomeTests coverage, without dropping a
role, changing the scheme or counting a timeout as success.
When explicitly selected, [local xcodebuild acceptance](docs/DEVELOPMENT-WORKFLOW.md#local-xcodebuild-acceptance)
uses owned native commands and isolated artifacts for the same full matrix;
development and previews remain in Xcode MCP. Adopting and executing that route
requires its exact local control/target scope, not a rewritten MCP or CI receipt.
For local Apple presentation follow-ups after a fully accepted checkpoint, use
[Local Apple refinement](docs/DEVELOPMENT-WORKFLOW.md#local-apple-refinement).
It keeps Xcode MCP execution in the owning session and avoids unrelated full-stack
reruns only for eligible local revisions; ordinary platform gates remain.

**Checks:** use `npm run verify -- -Base BASE_COMMIT` for the diff-selected gate;
`-Plan` explains [impact selection](docs/DEVELOPMENT-WORKFLOW.md#responsibility-based-impact)
without acceptance. Shared execution, CI/dependencies and unknown paths retain
conservative coverage; mixed changes take the union. Preflight reports independent
missing prerequisites together and distinguishes safely unrun dependent probes.
For failed runs or verified edits becoming a commit, follow the guide's
[recovery](docs/DEVELOPMENT-WORKFLOW.md#selected-group-preflight-and-explicit-recovery)
or [conversion](docs/DEVELOPMENT-WORKFLOW.md#working-tree-evidence-to-an-authorized-candidate)
route without rewriting old evidence.

For lightweight approval feedback:

```powershell
node --test scripts/tests/development-approval.test.mjs
```

This pure Node entry is also part of the complete `npm run test:tooling`
catalogue and existing `candidate` shard. Git/signing/hooks/candidate fixtures
remain in `development-tools.test.mjs`. The fast entry cannot substitute for
`tooling-tests` or Required verification; every formal shard and its actual
execution origin remain mandatory. See
[tooling regression scheduling](docs/DEVELOPMENT-WORKFLOW.md#tooling-regression-scheduling).

Required Android evidence includes emulator instrumentation, not just APK build.
The ordinary hosted Ubuntu/KVM device route and Windows/macOS coverage are
described in [CI activation and trust](docs/DEVELOPMENT-WORKFLOW.md#ci-activation-and-trust);
missing reports or acceleration remain blockers, and historical failures remain
history. Repository files do not configure branch protection or grant runtime,
cloud, publication or installation authority outside the stated setup scope.
Local heavy verification uses [host admission](docs/DEVELOPMENT-WORKFLOW.md#host-wide-local-admission);
queueing does not consume command deadlines or justify removing retained owners.

Automatic and manual emulator entry points share an account-wide resource pool
across worktrees (one emulator by default). Use `npm run emulator:status` to
inspect it; manual layout/stop commands require the run directory printed by
`scripts\start-test-emulator.ps1`, never a fixed ADB port or retained AVD name.

### Command ownership

Windows command deadlines include supervisor startup, ownership-helper
preparation, execution and shutdown. A late zero exit or `completed` output
does not turn a timeout into success. The owner checks the original deadline
and received cancellation before creating or resuming a target, assigns its
Job atomically while suspended, and confirms actual tree exit before returning
a command-specific cleanup receipt. Managed device cleanup requires that
receipt; an ownership-start marker or target-written output is not enough.
Preparation accumulates bounded control lines across partial pipe reads and
carries an unfinished line into the native owner rather than dropping its prefix.
The Windows bootstrap rejects unsupported control lines even before a helper
process exists; later cancellation, EOF or a zero child exit cannot erase that
input failure.
Windows control frames are bound to a fresh per-command nonce withheld from
the target. Only those frames are consumed: literal marker-like target stderr,
UTF-8 split across chunks, original newlines and unterminated text are retained.
Frames are removed from the bounded byte stream before UTF-8 decoding, including
when cancellation or a deadline interrupts a character's bytes.

To avoid PowerShell startup and compilation on every command, Windows uses a
source- and .NET-toolchain-bound native owner under ignored
`.tools\command-owner-native-v1`. It requires the already-installed 64-bit
.NET Framework compiler/runtime; missing tools are errors, not downloads.
Cold preparation runs the compiler in a Job through the PowerShell owner,
whose own source- and PowerShell/.NET-bound helper is cached under
`.tools\command-owner-v1`. Concurrent callers share bounded preparation, and
publication is atomic. Cold compilation and cache waits remain inside the
caller's original deadline. Incomplete, linked, mismatched or corrupted
artifacts fail closed instead of executing stale code or silently falling
back to compilation. A new source/toolchain identity prepares a separate
artifact; interrupted preparation directories are not executable cache entries.
No global installation, concurrency limit or configuration is changed.

Windows directory publication allows at most three additional 100 ms waits for
`EPERM` or `EBUSY`, with the original staging identity and an absent destination
checked before every attempt. It does not overwrite another destination or fall
back to a partial copy; the command owner's cancellation and original deadline
still apply. Ordinary pre-launch failure remains nonzero and reports a cleanup
receipt only when both compiler shutdown and owned scratch cleanup are confirmed.
Missing process evidence, changed staging ownership or failed scratch cleanup
remain unconfirmed, not successful command execution.

## Optional project-local Xcode MCP on macOS

`config/xcode-mcp.example.json` is a template, not an automatically loaded MCP
configuration. Windows and Linux checkouts do not configure or launch Xcode.
On a Mac with Node 26 and Xcode providing `mcpbridge`, review
`scripts/setup-xcode-mcp.mjs` and the template, then opt in once per local clone:

```sh
node scripts/setup-xcode-mcp.mjs install
```

The installer checks `/usr/bin/xcrun --find mcpbridge` without starting the MCP
server. Unsupported platforms and an unavailable bridge produce an explicit
skip without writing configuration or hooks. On a supported Mac it merges only
`xcode` into the current checkout's root `.mcp.json`, preserving other servers.
Existing wrapped (`mcpServers`) and bare server maps are supported. Invalid JSON,
a different existing `xcode` definition, tracked `.mcp.json` files and symlinks
are refused rather than overwritten. Both the configuration and its temporary
lock must be effectively ignored before either is written. A conflicting
`.gitignore` negation stops initialization without rewriting the user's rules.
Shared servers can remain in
`.github/mcp.json`; the local `xcode` definition takes precedence only for that
name. Existing user-level disablement is respected; this does not enable tools
that you have explicitly disabled in GitHub Copilot.

Installation writes a `post-checkout` hook, a copy of the reviewed script and
template under `devpocket-xcode-mcp/`, and root-only ignore entries in
`info/exclude`, all inside this clone's shared Git directory. It does not modify
global Git/Copilot settings, `core.hooksPath`, tracked project settings, or other
worktrees' working files. An existing hook or configured hooks path is preserved
and blocks installation; integrate the `sync` command with its owner instead of
replacing that hook. Reinstalling identical inputs is safe; a changed installed
snapshot requires explicit review and replacement, not an automatic upgrade.

Ordinary `git worktree add` runs the shared hook, so future worktrees on this
Mac receive the ignored local configuration automatically, even when their
branch has no setup script. The installed copy does not depend on retaining
the worktree used for installation. Other clones, including Windows clones,
do not receive `.git` metadata or `.mcp.json` through Git.

Existing worktrees are not visited or changed during installation. Initialize
one when needed with the installed script, from that worktree:

```sh
node "$(git rev-parse --path-format=absolute --git-common-dir)/devpocket-xcode-mcp/scripts/setup-xcode-mcp.mjs" sync
```

`git worktree add --no-checkout`, clients that suppress Git hooks, and sessions
already running before initialization are not automatic-load guarantees.
Verify a newly created Copilot App worktree before relying on its hook behavior;
Git's standard hook behavior alone does not prove the app's creation path.
Hook errors can be reported after Git has already created the worktree; fix the
reported conflict and run `sync` there rather than assuming Git rolled it back.
The installer does not restart Copilot or Xcode. If Xcode is later removed,
remove the local `xcode` entry explicitly; initialization never deletes existing
server definitions. A moved Node executable or clone requires reviewing and
reinstalling the hook's absolute paths. To uninstall, remove only the installed
`post-checkout` after reviewing that it is still the unmodified generated hook,
then remove its `devpocket-xcode-mcp/` snapshot; local MCP definitions remain yours.

Focused checks use `node --test scripts/tests/xcode-mcp.test.mjs`. On a supported
Mac they exercise real Git worktree creation and read-only Xcode lookup, not an
MCP connection or an App session. They also cover simulated unsupported
platforms, missing Xcode, configuration preservation and hook conflicts.
The same file runs as a peer in the complete `npm run test:tooling` list, in its
own Node test process. Its Git fixtures still restore and check their inherited
environment. The named initializer/template/tests and root ignore policy
select tooling checks, not application builds; shared dependencies and unknown
paths remain conservatively classified.

## Backend build and local development

Use Node 26.12.1 or newer within 26.x, npm 12.2.1, and PowerShell 7 (`pwsh`).
Commands are run from the DevPocket folder.

On Windows, use `npm.cmd` when forwarding arguments after `--`, for
example `npm.cmd run verify -- -Base BASE_COMMIT`. The `npm.ps1` launcher consumes
that separator before npm 12 can forward the arguments.

Follow the npm source/version rule in `AGENTS.md` when selecting or restoring
dependencies. Keep npm's canonical `registry.npmjs.org` tarball URLs in the
lockfiles: npm maps these to the configured registry. Microsoft's metadata can
return a different backing host, which npm 12 otherwise rejects as a remote URL.
The current baseline uses TypeScript 7 and Zod 4. TypeScript's native compiler
uses platform-specific optional packages, so do not omit optional dependencies
when restoring the lockfile. Schema export uses Zod's built-in Draft-7 input
projection; explicit UTF-16 text bounds, protocol-v1 ID shapes, message defaults
and JSON validation remain compatible. This checkout does not upgrade an
installed extension or running relay.

TypeScript 7 supplies the native compiler. Bounded test diagnostics use
`@babel/parser` for syntax-only declaration locations; they do not load a
TypeScript project, follow imports or evaluate test source.
The older content-only compiler-reuse contract is not assumed to cover this
native compiler; unbound toolchains run fresh verification instead.

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

For a real installation use an independent **HTTPS** origin, omit `--dev-loopback`, transfer the host configuration **privately** to the Dev Box and restrict its Windows ACL to the authorized user. Do not store a host secret on the phone. A user-level extension installation opts in all GitHub Copilot sessions that load it; keep a separate host identity per Dev Box/user.

On the Android pairing screen enter the independent relay origin, one-time code and device name. A debug emulator reaches the loopback relay as `http://10.0.2.2:8787`. This is an explicit **debug-only** exception; release builds reject HTTP. No trust-all certificate code is used.

## Install once for all projects

Use the standalone ZIP and checksum from an extension release; follow
[`extension\README.md`](extension/README.md) to verify and extract them. The target
needs Node 26.12.1 or newer within 26.x and a compatible GitHub Copilot runtime in the CLI or desktop app
that can load the extension and provide its bundled SDK. It does not need this
repository, npm dependencies, the Android toolchain or a local relay.

For an existing Azure relay managed by this project, have PowerShell 7 (`pwsh`) on
`PATH`, install Azure Developer CLI (`azd`) and sign in to its directory if not already authenticated. Run this from
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
`COPILOT_HOME\extensions\devpocket` when the runtime's custom configuration directory
is set. Host configuration and its absolute private `dataDir` remain outside
that directory. The extracted package is not needed to run the installed bridge.
It is still needed by the printed pairing/device-management commands: keep it
through pairing, or verify and re-extract the ZIP before later `pair`, `devices`
or `revoke` use, retaining the existing host configuration.
Repeat the install command from a newer package to update a managed installation.

**There are no per-project allowlists or runtime enable switches.** New GitHub Copilot
sessions that load the extension automatically register and synchronize visible
history, including earlier messages. Every phone paired with that host can access
all registered sessions. This does not scan the disk or resume closed sessions.
Normal GitHub Copilot trust/permission-handler consent, permission mode, organization policy,
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
2. Inspect the existing GitHub Copilot runtime's live capabilities and extension-loading support. For GitHub Copilot CLI specifically, `--no-auto-update` may select an older bundled executable; do not use its banner as the only evidence. This machine's isolated CLI check used `$env:COPILOT_AUTO_UPDATE='false'` plus `--prefer-version 1.0.90-0`.
3. Install **only to the intended existing Git root**, with explicit opt-in:

```powershell
node .\dist\cli.js install --config .data\my-box.local.json `
  --project C:\YourExistingRepository --confirm-install
```

4. In the **already-running GitHub Copilot session's original client**, explicitly ask its built-in `extensions_reload` tool to hot-load the new project extension. This is a human trust decision: inspect the extension first. Loading/reloading other extensions may have their own lifecycle effects. DevPocket does **not** perform this action on your behalf.
5. Verify the original process/session ID remains unchanged and earlier answers appear on the phone. Only then is attachment established. If the original client cannot discover/hot-load the extension, continue there; never claim that a newly spawned/resumed session is the existing runtime.

For a folder-only disposable GitHub Copilot CLI test, the installer can prepare a **local, uninstalled plugin** with `--plugin-dir C:\AnIsolatedPluginFolder --confirm-install`. An ordinary CLI terminal started with `--plugin-dir` may discover extensions added to that directory later on an explicit hot-load. A running terminal that was not started with this flag cannot retroactively acquire it. This is not a reason to restart the user's working terminal.

The extension imports `@github/copilot-sdk/extension` supplied by the original runtime. It does **not** install an arbitrary newer SDK, request GitHub secrets, change permission mode, enable allow-all, or create a local control listener.

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
  definition cannot fit safely without redaction, the form requires the original client.
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
  reads cannot overwrite them. Missing, failed or invalid activity probes retain
  the last known display state while disabling the controls that require that
  evidence; only a successful newer read can reconcile it. Lifecycle events do
  not grant control capabilities.
  Socket backpressure leaves unsent event batches eligible for the next flush
  instead of waiting for an acknowledgement that cannot arrive.
  Command, periodic and reconnect summaries capture a snapshot, a fixed event
  sequence boundary and the pending receipt IDs. Only that event prefix and its
  acknowledgements must drain before the snapshot and receipts are sent; later
  events cannot extend the wait. The active snapshot stays fixed while at most
  one successor is coalesced. Receipt delivery resumes in place after
  backpressure, and reconnect rebuilds the boundary from the durable journal
  without repeating operations.
  The relay publishes an ordered `runtime.state` correction when a summary
  changes the stored display state. Existing mobile viewers and later page
  replay receive the correction; unchanged summaries do not repeat idle events.
  Immediate summaries use the same negotiated workspace projection as periodic
  summaries, so legacy relays do not receive unsupported fields.
  These changes reuse protocol-v1 frames and persisted formats. Update Android
  for the picker, the installed bridge for snapshot delivery, and the relay for
  mobile state corrections; no schema migration is needed.
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

Protocol-v1 names such as `cliVersion`, request type `terminal` and error code
`TERMINAL_REQUIRED` remain unchanged for compatibility. They describe runtime
metadata and original-client fallbacks, not a CLI-only product restriction.

These checks establish adapter support, not end-to-end acceptance of an arbitrary
runtime build. Real mutation/cancellation compatibility checks still require an
explicitly opted-in disposable session in the intended client; the CLI harness
below uses a disposable terminal. Discovery never performs these checks.

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

Revocation closes live subscriptions and blocks new commands/uploads/downloads for that host. Already-admitted GitHub Copilot actions are not silently undone. A phone can also revoke its own host grant in Settings. "Remove relay/cache" is local deletion, **not** server-side revocation.

## Native Android build

Requirements: Node.js 26 with the repository's locked npm dependencies restored,
JDK 25, Android SDK platform 37.2/build-tools 37.0.0, and Gradle 9.8.2 (the wrapper
is pinned and checksum-verified). The native build compiles the portable
component package; on a clean checkout, run `npm ci` from the repository root
after the dependency-policy decision and before the Android build.
AGP 9 uses built-in Kotlin with Kotlin/Compose compiler 2.4.21. The app retains
minSdk 26 and Java/Kotlin bytecode target 17, and targets Android 17 (API 37).
Lint and Kotlin compiler warnings fail the project checks; release builds shrink
unused resources as well as code.
CI uses Temurin JDK 25. An existing Android Studio JBR 25 can be selected explicitly with `-Jdk`.
Builds and JVM tests require stable JDK 25; the direct build entry and verification
preflight reject other versions. Java 17 bytecode remains the application target,
not the host build/test-JVM requirement.
Native access is enabled only for the Gradle launcher/daemon and forked JVM
tests that use their native libraries, not through global Java settings.
API-37 Robolectric shared-memory initialization also needs the
`java.base/jdk.internal.access` export in forked test JVMs only, not in the app
or Gradle daemon.
Compose tests use the v2 rule factories and their standard test dispatcher.
Both JVM and instrumentation test scopes explicitly select the current AndroidX
test stack; Compose's transitive minimum versions do not suffice for API 37.
Native keyboard checks request hiding through `WindowInsetsControllerCompat`
and wait for observed IME insets, rather than relying on the deprecated result
callback.
The two packaged AndroidX JNI libraries are already stripped; packaging keeps
those exact vendor binaries rather than attempting an unnecessary NDK strip.
One upstream Gradle deprecation warning remains with AGP 9.4.1 and Gradle 9.8.2: AGP's
`BasePlugin.createAndroidJdkImageConfiguration` calls the deprecated
`Configuration.setVisible(boolean)`. It is not suppressed or worked around by
patching dependencies; update AGP when an upstream fix is released.

If the SDK components/JDK are missing, the supplied preparation script downloads official packages only to `.tools`, verifies published checksums, and reuses an **already accepted** Android SDK license. It does not silently accept licenses, install system packages or change global environment variables.
The JDK download and native entry points use `.tools\jdk-25` by default. Existing
older JDK installations are not removed or silently used as a fallback.
New SDK packages must have one unambiguous `channel-0` entry without a preview
revision; metadata ordering never makes a preview the default.

```powershell
.\scripts\prepare-android.ps1 -DownloadJdk
.\scripts\build-android.ps1 -Lint
```

Or pass existing installations:

```powershell
.\scripts\build-android.ps1 -Jdk C:\YourJdk25 -Sdk C:\YourAndroidSdk -Lint
```

The entrypoint selects `JAVA_HOME` and **both** `ANDROID_HOME` and
`ANDROID_SDK_ROOT` for its Gradle child. An inherited SDK root cannot disagree
with `-Sdk`. The Gradle cache stays worktree-local under `.tools\gradle-cache`,
even when `GRADLE_USER_HOME` was inherited. The caller's environment and working
directory are restored after success or failure; no machine/user environment or
other SDK installation is changed. Add `-Instrumentation` to assemble the test
APK as well; assembly is not device acceptance.
On Linux and macOS, PowerShell 7 invokes the same pinned wrapper JAR through the selected
`bin/java`; Windows keeps `gradlew.bat`. The Linux CI job uses its existing SDK
and stable packages with already accepted runner licenses, not the Windows
preparation script or automatic license acceptance.

### Complete local verification on macOS

Use Node 26, npm 12.2.1, PowerShell 7, Python 3.12 or newer, Git with SSH signing support,
JDK 25 and an Android SDK with platform 37.2, build-tools 37.0.0, platform-tools
and the emulator. Accept the SDK and system-image licenses yourself. Use Android
Studio or Google's SDK manager on Mac; `prepare-android.ps1` is the Windows
bootstrap, not a macOS installer. No Xcode simulator is involved.

Apple Silicon uses `system-images;android-37.0;google_apis;arm64-v8a`; Intel Macs
use `system-images;android-37.0;google_apis;x86_64`. The device gate requires a
successful `emulator -accel-check` with Hypervisor.Framework. It creates a
disposable AVD, private ADB server and loopback fixture, runs instrumentation and
the selected layouts, and confirms owned-process cleanup before releasing them.
It does not select an existing emulator, phone, GitHub Copilot session or cloud relay.

After restoring the root and `deployment/azure` lockfiles, use a private Python
environment with `deployment/azure/probe/requirements-test.txt`. Put that
environment's `bin` directory on the current shell's `PATH` so both `python` and
`python3` resolve to it. Point `DEVPOCKET_PROBE_PYTHON` at its `python` executable.
PowerShell and Node must also be on `PATH`; no global configuration is required.
With JDK and SDK stored under the ignored `.tools` defaults:

```sh
npm run verify -- -Base BASE_COMMIT -All
```

Pass `-Jdk /absolute/jdk/home` and `-Sdk /absolute/android/sdk` for other locations.
The same entry runs tooling, backend, Android build/unit/lint and actual device
checks. Platform-specific Windows/Linux tests retain their native hosts; a Mac
run is not evidence that those OS implementations were exercised.

Hosted CI uses the same planner's `ciMacos` decision to select the rolling ARM64
`macos-latest` image for shared verification infrastructure and relevant native changes.
It reruns the existing `native` tooling shard, including macOS process cleanup,
registry locks, IPC/admission and Python-path regressions. `Required verification`
requires its successful job result and separate source-bound macOS evidence;
Windows tooling cannot substitute for that evidence. Unrelated application or
ordinary documentation changes do not start the Mac job. This is targeted host
coverage, not a second complete Android gate: emulator instrumentation and
layouts remain on Ubuntu/KVM, and the local macOS HVF path still needs Mac
hardware acceptance.

The Apple acceptance-contract regressions use separate Node test files for
batch/command, checkpoint/source and native-result evidence. All cases remain
in the native shard; each file keeps serial tests and its own isolated process.

The macOS command owner uses kernel responsibility scopes and PID-version-bound
signals, including nested command ownership; missing native APIs fail closed.
Command-level environment overrides cannot discard the inherited supervision
link. Unstable process observations are retried within the existing command and
cleanup deadlines. Exhausting one snapshot attempt does not permanently fail
cleanup if later observations stabilize; persistent uncertainty still cannot
be treated as an empty process tree.
Kernel inspection refusals get bounded retries, not an assumed process exit.
Empty-tree confirmation requires consecutive stable scans, including after a
parent disappears or becomes a zombie. Unconfirmed nested cleanup still triggers
cleanup of other verifiably owned processes, but never a successful receipt.
A failed target launch stays nonzero; its diagnostic precedes the terminal
cleanup receipt so confirmed cleanup is not confused with command success.
CI diagnostics project fixed macOS owner error categories from the existing
private log, not raw exception messages, paths or receipt tokens. These hints
do not prove a leaf cause or establish successful cleanup.
If the native test controller crashes while its supervising verifier is alive,
the verifier automatically releases that run's lease only after the exact
command's process-tree cleanup is confirmed, its heartbeat is gone and its
ports are free. Copied reports or another command's successful cleanup cannot
supply that proof. If the supervising verifier also crashes or cleanup is
unconfirmed, the lease stays blocked for inspection; a dead PID and free ports
alone are insufficient. Do not delete the shared registry or claim a blocked
run passed.

Registry mutations use a private file lock released by the kernel when its
controller exits; this does not itself release any emulator lease. The macOS
registry format is version 2. An idle version-1 registry upgrades under both
locks, preserving its configured limit. Existing leases/waiters or an abandoned
legacy migration socket block the upgrade for inspection; unknown locks and
retained records are never deleted automatically. Windows keeps version 1.

Android CI retains the machine report and a bounded, allowlisted diagnostic
projection on failure, not the raw build/JVM/lint log. See
[Android failure diagnostics](docs/DEVELOPMENT-WORKFLOW.md#android-failure-diagnostics)
for the public regression commands, limits and the distinction between the local
SDK-conflict reproduction and PR #7's still-unconfirmed remote Gradle cause.

Output: `android\app\build\outputs\apk\debug\app-debug.apk`, application ID `dev.devpocket.app.debug`, versionName **0.1.0**, versionCode **1**. It is a development debug build, not a signed release or authorization to distribute.

The accepted local handoff is immutable **build 002** at `.data\artifacts\build-002\DevPocket-0.1.0-build002-debug.apk`. Its manifest, source-input hashes and native acceptance results are beside it. Earlier unnumbered copies are retained only as earlier development artifacts; use build 002 for the verified handoff. `scripts\save-debug-artifact.ps1` refuses to overwrite a sealed build or seal an APK whose installed acceptance hash does not match.

Unit checks cover release TLS rules and late-ack draft/delivery invariants. `androidTest` adds native Compose pairing/Keystore checks and an optional real-runtime connected flow. Build success is distinct from emulator/device, cellular TLS, policy-specific runtime and FCM delivery verification; see `VALIDATION.md` for actual observed outcomes.

### Reproduce the opt-in real CLI checks

These checks are an **on-demand compatibility check**, not part of the automatic
PR gate. They use a new disposable ordinary Windows terminal, not the SDK's
create/resume client. Real CLI launch, extension staging/reload and runtime
mutations each need authorization for this exact run. Historical approvals and
the flags below do not grant standing permission to an agent.

From the DevPocket checkout, build the extension and start a dedicated local
relay in one terminal:

```powershell
npm run build
$proof = '.data\cli-proofs\' + [guid]::NewGuid().ToString()
npm run test:cli:start -- --directory $proof
```

Keep that terminal open. The relay binds `127.0.0.1` with **port zero**, letting
the OS allocate and bind an available port atomically. It prints a public run
summary, not credentials. In subsequent terminals set `$proof` to its printed
absolute directory. Every command requires that directory; there is no global
"active proof", fixed relay port or automatic reuse of old evidence. Proof
commands and the proof-configured bridge authenticate a fresh per-run owner
challenge on the **same TCP connection** before sending credentials, including
every bridge reconnect and attachment download. This does not trust a separate
port/liveness check or change normal production relay/bridge behavior.

1. Select an already-installed CLI by its absolute executable/shim path, then run
   `.\scripts\launch-cli-proof.ps1 -RunDirectory $proof -CliPath 'C:\Path\To\Installed\copilot.exe' -ConfirmLaunch`
   in a second ordinary terminal. The launcher does not install/update a CLI or
   pass a historical `--prefer-version`; it disables auto-update/allow-all in this
   process and restores the caller's environment afterward. `launch.json` records
   the selected file/hash, not a claimed runtime version or PID. Select folder
   trust for this session only and wait for the exact initial marker reply.
2. Before staging the extension, identify the actual CLI process for the printed
   `--session-id`, not the PowerShell launcher. Record its observed PID using
   `npm run test:cli:proof -- capture --directory $proof --runtime-pid ACTUAL_CLI_PID`.
   This read-only OS observation uses Windows argument parsing, rejects shell
   wrappers/quoted lookalikes, and checks the exact session argument and creation
   time, and creates `before-attachment.evidence.json` once. It never fabricates
   identity from the launcher or a post-attachment registration.
3. With explicit staging authorization, run
   `npm run test:cli:proof -- install --directory $proof --confirm-install`.
   Ask the **same** running CLI to invoke its built-in `extensions_reload` once.
   Authorize that reload and the extension's ability to **handle** permission
   requests, once; reject requests to **skip** permission prompts. Finish reload
   and return to an idle, Manual-permission CLI before running checks.
4. Select a model and effort explicitly for this disposable runtime, then run
   `npm run test:cli -- --directory $proof --confirm-runtime-checks --model LIVE_MODEL_ID --reasoning LIVE_EFFORT`.
   This verifies original process/session and earlier history, sends its own
   relay roundtrip, checks the live model catalog and actual selection, tests
   phone-first/stale permission handling, a supported question and terminal-first
   approval. Inspect and approve the single expected `Write-Output` command in
   the original terminal when requested. Unsupported/incomplete or changed
   permission/question details fail the check and remain for the original terminal.
   Both approval cases require a correlated successful built-in shell completion
   with the expected output, not just a disappearing request or completed turn;
   unavailable models/efforts are not silently skipped.
   The automated question scenario accepts only the exact literal question and
   choices with no freeform answer. Elicitation display strings combine optional
   source, message and schema without unambiguous field boundaries, so the harness
   leaves those forms unanswered in the original terminal and records incomplete
   acceptance instead of reconstructing fields or claiming a question pass. This
   does not change mobile form support or the wire protocol.
5. Separately authorize and run
   `npm run test:cli:cancel -- --directory $proof --confirm-runtime-checks`.
   It runs the bounded helper through the real built-in PowerShell tool, observes
   both helper PIDs and actual queue admission, requests abort, then requires an
   aborted-idle event, both process exits, a cancelled queued receipt and a
   follow-up reply from the same original CLI. Abort admission is not completion.
6. End the disposable CLI normally with `/exit`, then run
   `npm run test:cli:proof -- stop --directory $proof` or press Ctrl+C in its
   relay terminal. Stop acknowledges closure/credential-file cleanup only for
   this proof's relay. It does **not** terminate the CLI, any other relay or an
   emulator. Private diagnostic evidence remains in the run directory.

`inspect`, `catalog`, `events`, `state` and `receipt COMMAND_UUID` are read-only
proof commands. To obtain a live model list before choosing one, explicitly
authorize `send '{"type":"models"}' --directory $proof --command-id COMMAND_UUID
--confirm-runtime-checks`, then read that receipt. A manual `send` always needs
an operator-chosen command UUID; preserve the UUID **and action body** for a
retry, and inspect uncertain receipts rather than resubmitting with a new ID.
Live/cancellation checks persist dispatch IDs and receipts and never auto-retry
unknown outcomes. Each check runs once per proof and rejects concurrent checks
or overwriting prior evidence, including failed evidence.

The separately authorized `android --directory $proof --confirm-runtime-checks`
proof command saves a five-minute pairing in a new `android-*.local.json` inside
this run, using the actual relay port with the emulator's `10.0.2.2` host alias.
It does not start an emulator or enroll a device itself. These private files
are not shareable reports.
The ordinary Android debug HTTP client does not implement the harness's owner
challenge; this opt-in pairing is not a protected or production TLS transport.
End that disposable client/CLI use before stopping the relay.

Closed, altered, foreign-worktree and dead-owner handles are refused, even if
another process has acquired their old TCP port. A crashed check leaves its
ownership lock visible: inspect the original CLI and finish it explicitly; do
not clear locks to replay an uncertain operation. Start a new proof for another
acceptance attempt. Legacy global-pointer runs are deliberately not migrated.
`npm run test:cli:harness` exercises local relay isolation, authenticated
connection/reconnect races, real bridge projections from a fake SDK, and fake CLI programs
only (Windows launch/process cases require Windows); `npm run typecheck` also
checks these entry points. Neither command is real CLI compatibility acceptance.

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
  again explicitly. Stopping the mode never aborts or restarts the original GitHub Copilot runtime.
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
remote GitHub Copilot session monitoring that waits for human decisions and runtime updates, with
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
Only interact with approvals or session controls while safely parked.

### Android 17 local network access

On Android 17, connections to a local-network relay require the system's
`ACCESS_LOCAL_NETWORK` permission. Pairing and Settings expose an explicit
permission action and a system-settings recovery path; public internet relays
do not require it. Denial does not discard pairing input or silently retry an
uncertain operation. The app refreshes permission state when it returns to the
foreground, and never scans the LAN or prompts for this permission at startup.
For a separately authorized real-client test against a local relay, grant it
through the app before starting that opt-in test. Automated fixture tests grant
it only on their disposable API-37 device.

### Optional FCM

1. An authorized operator must create/select an **independent** Firebase project, enable the HTTP v1 FCM API, and register the Android package (`dev.devpocket.app.debug` for debug; `dev.devpocket.app` for release). Cloud/account actions are not performed by this project.
2. Populate the public Android Firebase fields shown in `config\push.properties.example` through private Gradle properties or `-P` arguments. These are not GitHub credentials and not a server service-account private key.
3. Store the server service-account JSON outside source, grant only the needed FCM sending role, and pass `--fcm-credentials <private-path>` or `DEVPOCKET_FCM_CREDENTIALS` to the relay.
4. Upgrade the relay before registering a new Android client. Grant Android notification permission, then use Settings -> re-register. The relay must report `pushConfigured=true`. Test foreground, background, Doze and lock-screen delivery on the actual target Android distribution/network; Google Play Services is required for this FCM path.

New clients use Firebase Installation IDs through `register()` and
`onRegistered()`. Automatic Firebase initialization remains disabled; the
existing explicit, configured application initialization is retained. The
authenticated `PUT /v1/push-token` path remains unchanged: new clients send
`{"provider":"fcm-fid","fid":"..."}` (or an explicit `null` to clear it).
The relay also accepts legacy `{"provider":"fcm","token":"..."}` registrations
and sends them through FCM's legacy `token` field, never guessing the identifier
kind from its contents. FIDs use the FCM `fid` field. An old relay rejects the
new request visibly; the client does not silently fall back to deprecated APIs.
The FID service narrowly suppresses `MissingFirebaseInstanceTokenRefresh`:
Android Lint still requires the obsolete `onNewToken()` callback instead of
recognizing `onRegistered()`. Other lint checks remain enabled.

Opening an existing relay database adds nullable `push_fid` and a registration
revision to device records in one transaction, retaining existing tokens,
device identities and grants. This migration happens in the relay, not in the
read-only-schema onboarding helper. Do not downgrade a relay with FID records
to an older binary that cannot manage them.

Push payloads contain opaque routing IDs and a generic update/attention notice, not chat, tool commands, approvals or GitHub secrets. Push is best-effort, is not proof of task success, and opening the app re-authorizes/synchronizes from the relay. An `UNREGISTERED` response removes only the exact registration revision that was sent, so a late failure cannot erase a newer registration, even for the same FID. Revoked devices are not selected for later notifications.

## Deployment

**Azure with azd/Bicep:** see [`deployment\AZURE.md`](deployment/AZURE.md). `azure.yaml` and `infra\main.bicep` preserve the single-Linux-VM/Compose/Caddy/local-SQLite architecture using official project hooks compatible with azd 1.25.5. After separately authorized infrastructure provisioning, staged DNS recovery and encrypted frozen-release import, the relay is running and public HTTPS/health/unauthenticated HTTP-WSS checks passed. Private Blob upload remains failed with its retry budget exhausted; it was not opened broadly or represented as successful. The accepted Android build 002 and app/relay version remain unchanged.

If infrastructure already exists and needs a separately authorized endpoint recovery, [`deployment\AZURE-RECOVERY.md`](deployment/AZURE-RECOVERY.md) describes the new-IP → DNS verification → NIC/single-IP firewall switch gates. Original resources and approval evidence are preserved; preparing or previewing recovery is not permission to execute it.

The successful non-sensitive encrypted-transport probe is documented in [`deployment\TRANSPORT-PROBE.md`](deployment/TRANSPORT-PROBE.md). The separately authorized and executed frozen real-release path is documented in [`deployment\REAL-RELEASE.md`](deployment/REAL-RELEASE.md): it preserves the business archive/origin, uses separate transport/control hashes and explicit phases, and cannot inherit probe or exhausted Blob-upload authorization. Actual endpoint/resource IDs and private receipts stay in the ignored environment directory. Public relay acceptance does not install a user's GitHub Copilot extension, provision host credentials or pair a phone.

The subsequent scoped [Dev Box onboarding](deployment/ONBOARDING.md) registered a named test host in that live cloud database, encrypted its credential to a protected Windows recipient, and connected a dedicated ordinary CLI using only a private local plugin. A temporary simulated public controller verified history, command delivery and live WSS, then had its grant revoked. The host configuration and history were retained when the user ended the dedicated local trial; an actual-phone pairing code is generated only when the user is ready.

A later user-selected visible emulator installed the exact sealed build 002, paired through its real native controls, and sent a no-side-effect message to that unchanged ordinary CLI over the public relay. Both the terminal and native app displayed the response, and the completed receipt was acknowledged by the relay. This emulator's device grant/Keystore remain retained, unlike the earlier temporary API controller; its window/process was closed after the user finished testing. No Android code or APK was rebuilt.

`deployment\compose.yaml` and `deployment\Caddyfile` are templates only. **Do not run them without authorization for the target infrastructure and its costs.**

- Use a new domain, DNS records, certificates, volumes and credentials; do not reuse another project's endpoints or data.
- Caddy and the relay share a container network namespace; Caddy terminates TLS and connects to relay loopback. Only ports 80/443 are published. No plaintext relay/runtime-control port is published.
- The relay requires an exact trusted-proxy socket address plus HTTPS forwarding metadata in production. Do not configure a wildcard or trust client-supplied forwarded headers from arbitrary sources.
- The supplied deployment is a **single relay replica** with SQLite WAL and private persistent volumes. Multiple replicas need a coordinated datastore and routing implementation; load-balancing this template as if it were stateless is unsupported.
- Back up encrypted/private relay volumes under your infrastructure access policy; secure filesystem permissions, disk encryption, domain ownership, TLS renewal, monitoring and secret rotation remain operator responsibilities.
- Container definitions use `restart: "no"`. The specifically authorized Azure VM uses a mount-aware systemd autostart unit; no Dev Box/Copilot autostart was configured, and a cloud-VM reboot was not performed as a test. FCM private key mounts are intentionally not preconfigured.

## Security and delivery semantics

- Every controller operation and stream is authorized to a **device -> host -> registered session** grant. Opaque attachment IDs are checked against that scope. URL paths are not accepted as arbitrary RPC/shell requests.
- Relay credentials are stored hashed; the only plaintext phone secret is Keystore-encrypted on Android. GitHub auth stays with the original GitHub Copilot runtime. Sensitive environment access is not requested by the extension.
- The relay **can see** user-visible messages and uploaded content. TLS is transport encryption, not end-to-end encryption. Use only a relay and administrative operators you trust.
- The bridge explicitly projects allowed user events. System/developer prompts, `model.messages_snapshot`, reasoning internals, auth state and full RPC snapshots never enter the wire schema. Known token formats are redacted, but redaction cannot make arbitrary user/runtime text secret-free: do not paste secrets into conversations.
- Durable command IDs are immutable and retained as deduplication tombstones. Crash windows after recording intent but before an RPC result are **uncertain**, never blindly retried. A duplicate payload with another ID is a new user action. Monitor database growth and retain tombstones when archiving.
- One-time decisions use the runtime's atomic `success` result. Original-client-first/phone-first races have one winner; a stale response is not success.
- Approvals whose safe display is incomplete, redacted or unknown route back to the original client. Do not approve model-generated command text without reviewing it.
- Project file/Git operations are local and read-only, deny sensitive paths and links, bound output/time, and consult the runtime's content-exclusion evaluator on each operation.
- Android renders untrusted content as selectable native text. Links and attachment previews remain non-executable; opening a saved document in a trusted external app is an explicit user action.
