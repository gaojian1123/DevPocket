# Development workflow

The **devpocket-development** Copilot extension is development tooling,
not the shipped phone/runtime extension. It uses the host's bundled SDK and
`joinSession()` to register tools and a workflow. It does not replace the current
runtime, change its permission handler, or request credentials. `AGENTS.md`
defines when agents use this workflow by default. This is an agent routing rule,
not a background message listener or automatic extension activation.

## Start a task

Form a task contract from the user's implementation request: goal, observable
acceptance criteria and non-goals. Reuse decisions already made and state the
criteria before dispatch. Ask only for unresolved scope, behavior or acceptance
decisions; a clear implementation request does not need an additional question
about whether to use the default workflow. An in-conversation contract is
sufficient; the AI development issue template is optional. Issue text alone
does not start work or authorize privileged operations.

First distinguish a new task from a continuation. For an existing workflow,
route feedback to its current owner or resume its recorded run; preserve its
workspace, task contract and evidence. A dispatched implementation/review agent
performs only that assigned phase. Neither case calls the starter recursively.
Pre-existing direct work stays in its current workspace unless the user chooses
to migrate it; report that it is outside the registered workflow. Explicit
requests for a different route still retain applicable checks and authorization
boundaries and must not be labelled as workflow runs.

After explicitly authorizing this repository's development extension to load in
the current session, use `devpocket_start_development` for a new task with:

```json
{
  "goal": "Describe the user-visible change",
  "acceptance": ["An observable success case", "An observable failure case"],
  "nonGoals": ["Behavior that must remain unchanged"],
  "maxRepairRounds": 2
}
```

The tool uses the App's native `create_session` tool to create a new worktree
session, preserving the parent. The child invokes `run_dynamic_workflow` with
name `devpocket-development` and those arguments. A task already in a clean linked
worktree can invoke that workflow directly. The primary checkout and dirty
starting worktrees are refused. The App/CLI must support Dynamic Workflows and
eligible execution credentials; an unavailable capability is a blocker, not
permission to substitute a different runtime.
If the task depends on uncommitted work or a particular in-progress branch,
resolve that dependency before dispatch rather than silently starting from a
base that omits it. Preserve the current checkout's changes.

Loading/reloading the extension and the repository's read/search-only
`devpocket-reviewer` profile is explicit. Reloading extensions may also reload
other extensions in that session. Merely adding these files does not activate
them in an already-running session. If the starter, workflow or read-only
reviewer is unavailable, report the missing prerequisite and request the
specific setup/loading authorization needed before proceeding. An explicit
eligible-worktree entry point above may replace an unavailable starter, but
direct coding or implementer self-review is not a substitute for the workflow.
Honor the App's per-run approval and credit/time controls; default routing does
not bypass them.

The controller dispatches implementation, executes verification itself, and
dispatches a separate read-only reviewer against the actual diff and added files.
It accepts neither implementer-written approval nor an editable workspace result
as the authoritative review. The SDK's durable step journal holds the final
controller result. Each repair gets a fresh review invocation and source-bound
evidence. Runtime credit/time limits are chosen at invocation; the workflow does
not guess them or override model preferences.
Registration uses only Node built-ins and the CLI-bundled SDK, so a fresh
worktree can load it before restoring application dependencies. Provision the
runner toolchain once; normal missing repository dependencies can be restored
from their lockfiles after an actual missing-dependency failure.

The automatic endpoint is **ready for a PR**, with changes in the worktree and
`handoff.json` under `.data\development\<run-id>`. It does not commit, push, open a
PR, merge or deploy. Use the App's normal PR creation path when publication is
authorized. Commit/merge-ref changes require fresh applicable verification; old
reports are not re-labelled as evidence for a new revision.
Report the actual run/worktree and outcome when dispatched. Say that a workflow
has started only after an invocation returns its run identity; a proposed plan
or manually performed equivalent steps are not a registered workflow run.

## Verification

Run from the checkout with Node 24 and PowerShell 7. Operational fixture checks
also need Python 3.12 and the existing pinned
`deployment\azure\probe\requirements-test.txt` dependencies; use an isolated
environment rather than changing the machine's Python packages.

```powershell
npm run verify -- -Base BASE_COMMIT -Plan
npm run verify -- -Base BASE_COMMIT
```

The base is explicit; it is not guessed from a branch name. Planning is not
acceptance. The source fingerprint includes tracked and non-ignored untracked
inputs, including deletions. Required checks come from the actual diff, not an
agent's risk label. Unclassified paths select the full check set and human
review. Documentation-only changes select no application build.

The verifier reuses the commands in `package.json`. Android changes and affected
runtime/wire changes require JVM/build checks **and** native emulator evidence.
Changes to control tooling select its regressions and conservative downstream
checks. The workflow pauses before executing modified gate/dependency policy;
review that policy explicitly before another run.

For CI shards, use `-Group backend`, `-Group android` or `-Group device` with a
separate `-Report` for each. A successful shard is `partial` unless it covers the
whole plan. Aggregate the reports using:

```powershell
node scripts\verify.mjs --base BASE_COMMIT --combine `
  --input .data\verification\backend\report.json --input .data\verification\android\report.json `
  --input .data\verification\device\report.json --report .data\verification\combined\report.json
```

Aggregation rejects missing checks, failed/blocked/planned evidence, duplicate
results, mismatched policy, and stale base/source identities. A required check
that did not run is never equivalent to passing. Schema generation that changes
source also invalidates that run; review the generated change and verify again.
Detailed logs remain private in ignored run directories. Share only the
allowlisted machine reports and explicitly selected candidate artifacts.
Report destinations must be new files beneath `.data\verification` or `.data\ci`;
existing reports and sealed/operational evidence cannot be overwritten.

## Android execution environment

Provision an isolated Windows executor with hardware-accelerated emulation,
JDK 17/21, SDK platform/build-tools 35, platform-tools, and an installed x86_64
system image. Licenses must already be accepted by the operator. The runner does
not install tools, silently accept terms or change host virtualization settings.
Explicit setup can use `scripts\prepare-android.ps1 -Emulator`; this downloads
checksum-verified tools and the API-35 image into `.tools`, reusing an already
accepted SDK license. Provision a separate, credential-free executor for CI.

Set process/runner environment variables to the provisioned paths:

- `DEVPOCKET_JDK`: JDK directory.
- `DEVPOCKET_ANDROID_SDK`: SDK containing platform/build-tools 35.
- `DEVPOCKET_ANDROID_IMAGE`: relative system-image directory, normally
  `system-images\android-35\google_apis\x86_64`.
- `DEVPOCKET_EMULATOR_SDK`: optional separate SDK containing emulator,
  platform-tools and the image, when the build SDK is separate.

The selected image is recorded as evidence; a pass on one API level does not
qualify all supported devices. Run directly with:

```powershell
npm run test:android -- -Layouts
```

Each run owns a new directory, AVD, ADB server and port pair. It checks the live
AVD identity before installation, builds both APKs, and runs `NativeFlowTest`,
`AdaptiveLayoutTest`, and `FixtureFlowTest`. The layout matrix includes compact,
medium, expanded, landscape and large-font cases when selected. APK discovery
also selects additional instrumentation classes, so newly added regression
tests cannot silently remain compiled-but-unexecuted. Only the separately
authorized `ConnectedFlowTest` is excluded. App data is reset between cases on
this owned AVD, and the offline layout fixture dismisses its expected connection
snackbar before interacting with the list. Nonzero
instrumentation results, empty suites, skips and missing completion markers fail
the gate. Reports include source and APK hashes, observed tests and cleanup.

The fixture uses the real App, HTTP/WSS relay, bridge, SQLite and runtime adapter,
with a deterministic `JoinedSession` test adapter. It is not a real Copilot
runtime and does not execute user tools. `ConnectedFlowTest` remains the separate,
opt-in real-CLI path; its skipped opt-in invocation cannot satisfy this gate.
Shared `test-fixtures\protocol\v1.json` is consumed by both TypeScript and Kotlin
tests, preserving intentional strict-server/forward-compatible-client decoding.

Automated and manual emulator commands share the same resource pool. They do
not reuse the historical `DevPocketProof` AVD or any retained user emulator.
Owned credential/data/AVD subdirectories are removed
after process shutdown; reports and private diagnostics remain. Windows job
objects retain descendant ownership after a launcher exits. Normal controller
cancellation requests graceful cleanup first; after process exit the controller
also cleans only directories bearing that invocation's owner nonce. A forced
host termination can leave a run directory. Inspect its owner/process record
before targeted cleanup; never delete another run or a retained trial AVD.

### Concurrent worktrees and manual runs

All participating worktrees of the same Windows account coordinate through
`%LOCALAPPDATA%\DevPocket\verification\emulator-pool`, not a per-worktree lock.
An OS-owned named-pipe mutex serializes admission. The default limit is one;
excess requests wait, and cancellation removes only that request. Port leases
cover the emulator console/guest-ADB pair, the dedicated ADB server and the
authenticated emulator gRPC listener. TCP reservations are held until process
startup; the shared lease remains held through shutdown. Listener process
ownership and the live AVD identity are checked before application operations.
Every allocation is checked against the complete live-lease port set, including
the handoff-to-listener startup interval. Reservations cover both loopback address
families; reclamation also checks all addresses in Windows' TCP listener table.

```powershell
npm run emulator:status
npm run emulator:limit -- --max 2
```

Changing the account limit is explicit and applies to future admission; it
does not stop existing runs. Even at a higher limit, a second emulator run in
the same checkout waits so participating builds do not overwrite each other's
APKs. Build commands run outside these entry points still need coordination.
CPU/RAM and SDK installation remain host resources: only share immutable
toolchains, do not update them while tests use them, and choose a limit the
machine can actually support.

The manual entry points no longer use fixed ports or select a global "last"
device. Run the starter in one terminal and keep it open:

```powershell
.\scripts\start-test-emulator.ps1
```

It prints a new owned run directory after readiness. From the same checkout
in another terminal, supply that exact directory:

```powershell
.\scripts\test-native-layouts.ps1 -RunDirectory 'PRINTED_RUN_DIRECTORY'
.\scripts\stop-test-emulator.ps1 -RunDirectory 'PRINTED_RUN_DIRECTORY'
```

Layout and stop requests go to that live run's scoped local controller, not
directly to a guessed serial/ADB server. A different worktree or stale handle
is refused. Owned worker exit invalidates the handle; manual operations check
the listener owners and AVD again before installation rather than adopting a
new process at an old port. The stop response is sent only after cleanup. Manual layout
results are recorded separately and cannot stand in for the automatic
fixture-backed device gate. The previous parameterless layout invocation is
intentionally unsupported rather than silently selecting a retained AVD.

Both starters accept `-QueueTimeoutSeconds` (default 900). A crashed owner is
reclaimed only when its liveness endpoint, process and direct owned launchers
are gone and every leased port is unoccupied. Job owners monitor the initiating
process through a held Windows process handle, so an interrupted starter cannot
leave its build running while a replacement run is admitted. A dead owner with
surviving work or occupied ports stays visible and blocks reuse;
inspect it rather than killing an unknown process or deleting the registry.
Older scripts/checkouts and unrelated applications do not participate in this
pool. Occupied external ports are skipped, startup races fail ownership checks,
and retained emulators are never adopted or stopped.

### Local relays and opt-in CLI compatibility

The automatic Android fixture binds its local relay with `port: 0` and keeps
its database, credentials and SDK fixture in its owned run. The opt-in real-CLI
harness now does the same for each explicit `.data\cli-proofs\<run>` directory.
The OS allocates and binds relay ports atomically; relays do not consume emulator
slots and do not share a global database, pairing output or "current proof"
pointer. The ordinary `npm run relay` service still has its documented default
port; it is not one of these disposable acceptance relays.

See the README's opt-in CLI procedure for explicit launch, pre-attachment
process capture, staging/reload and runtime-check authorization. The launcher
uses an explicitly selected installed CLI, not a hard-coded historical version.
Subsequent checks verify the original process creation time, session ID and
bridge registration. A failed or closed proof is not a reason to start, resume
or clone a replacement runtime under its old identity.

Checks against one proof are mutually exclusive, preserve command IDs and
failed/uncertain evidence, and cannot overwrite an earlier check. Stop targets
the exact live controller and waits for that relay's cleanup, without stopping
the original CLI. A dead controller or changed handle is refused. An opt-in
`proofOwnerKey` in this disposable host configuration binds script requests and
all bridge connections/downloads to a fresh HMAC challenge on the same socket,
preventing credentials from crossing a check/connect or reconnect port-reuse
race. The key stays in ignored local metadata and never enters wire events,
Android models or public run summaries. Normal host configurations omit it;
deployed transport behavior and protocol-v1 frames are unchanged. Separate
proofs/worktrees can keep their own relays running independently.

`npm run test:cli:harness` and the normal backend suite exercise only local
relays and fake CLI executables. They do not install/reload extensions or run
real model, permission, question or cancellation scenarios. Fake SDK events are
passed through the actual bridge/relay to check that changed question semantics,
terminal rejection and failed tools cannot produce a false acceptance pass.
Only literal, exact non-freeform questions can be answered automatically by the
harness. The existing display-only elicitation projection can represent different
original messages identically; these forms stay in the original terminal and
cannot count as passed compatibility checks. Product mobile form support remains
unchanged.
A green fixture gate
does not qualify a new real CLI build; that remains a separately authorized,
disposable-terminal compatibility check, not an automatic per-PR operation.

## CI activation and trust

`ci.yml` plans every PR and runs selected backend and Android checks. The device
job runs only for same-repository PRs or explicit dispatch, when repository
variable `DEVPOCKET_ANDROID_RUNNER_ENABLED` is `true`. It requires an isolated
runner labelled `self-hosted`, `Windows`, `X64`, `devpocket-android-ci`, plus the
`devpocket-android-ci` environment. An absent/disabled device runner leaves the
**Required verification** gate failing for changes that require device evidence.
It is not a successful skipped check.

Before enabling that variable, an administrator must configure:

- A disposable runner without production, host/device or personal CLI
  credentials. Restrict who can send same-repository code to it. Fork PRs must
  not run on a credentialed or shared development machine.
- Environment restrictions/required reviewers appropriate to that runner.
- A repository ruleset requiring **Required verification**, appropriate
  approvals, code-owner review for protected paths and dismissal of stale
  approvals. `CODEOWNERS` lists the current maintainer; the file alone does not
  enforce anything. Do not enable automatic merging before these controls exist.

CI and reviewer profiles in a PR are themselves changeable code. This workflow
is not a sandbox or a cryptographic attestation service. A protected review
process (or an organization-controlled required workflow) must guard changes to
the checks themselves. The local AI workflow's independent review is enforced by
its controller; this commit does not create a separately authenticated GitHub
review/check publisher for PRs that bypass that workflow.

The device job uploads only its tested candidate APKs and device report. A
candidate is not a signed release, full real-CLI/physical-device acceptance, or
authority to distribute. The existing extension distribution workflow remains
separate. `save-debug-artifact.ps1`, sealed build 002 and frozen release evidence
are not repurposed for CI candidates.

## Stops and recovery

The controller stops for missing prerequisites, agent failure, inconsistent
review results, changed source during verification/review, protected policy
changes, high-risk final review, or exhaustion of the chosen repair count.
Uncertain external side effects remain outside the automatic workflow.

An interrupted implementation is not automatically replayed. Inspect
`state.json`, the runtime's durable workflow record, and any retained lock. A
completed journaled run may be read again only while its task/workspace/source
still match; edited files invalidate its readiness. Start further work from an
explicitly reviewed state rather than deleting evidence to bypass a stop.
