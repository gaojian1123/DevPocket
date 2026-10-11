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

### Android failure diagnostics

The Android CI job runs `scripts\android-diagnostics.mjs` after a failure and
publishes only these two explicitly named files:

- `.data\ci\android\report.json`: the original source-bound machine report.
- `.data\ci\android\android-diagnostics.json`: diagnostic metadata, **not**
  verification evidence or a replacement for the report.

The exporter also prints the same projection to the job log. It reads only
`android-build.log` in the selected run directory. It samples at most 256 KiB
(both ends of a larger log), emits at most 24 findings and 16 KiB, and marks
truncation. Allowlisted fields include known failure categories, failed app
tasks, JVM test counts/identifiers, exception types/source positions, compiler
source positions/error categories and lint issue IDs/source positions. Messages,
assertion values, source excerpts, environment values, absolute paths, URLs and
unrecognized text are omitted; credential-like identifiers are rejected too.
Raw Gradle logs, JVM XML/HTML reports, lint reports and the rest of `.data` are
never uploaded by this step. An unsupported error may require an explicitly
authorized local reproduction or further reviewed diagnostic projection.

The exporter refuses linked directories/log files and existing output files.
Missing logs are reported as missing, never as passing. Its success only means
diagnostics were exported: it cannot turn a failed build green. CI still
propagates the verifier's exit code, preserves `report.json`, and requires actual
device evidence. An absent/disabled runner remains blocked/incomplete; the
aggregate source/policy checks are unchanged.

Public component checks (no real CLI or device):

```powershell
node --test scripts\tests\android-build.test.mjs scripts\tests\android-diagnostics.test.mjs
node scripts\android-diagnostics.mjs --directory .data\ci\android
```

The tests invoke the actual PowerShell build script with fixture toolchains and
a recording Gradle boundary, and the actual diagnostic CLI with private fixture
logs. They do not claim to run Gradle or satisfy the device gate. The exporter
can also target a new run beneath `.data\verification`; it never overwrites
prior diagnostics or machine reports.

**PR #7 investigation, 2026-10-10:** read-only inspection of Actions runs
[38045477183](https://github.com/gaojian1123/DevPocket/actions/runs/38045477183)
and [38040577037](https://github.com/gaojian1123/DevPocket/actions/runs/38040577037)
found `android-build` exiting 1. Each Android artifact contained only
`report.json`, referring to the unavailable private `android-build.log`; the
remote Gradle cause therefore remains unknown. The latest inspected PR head was
`dc691a326a97b720841bf03d066fda20d5f7309d`, with base
`78e3886f57d276b02059c6889d09f90ce0b12733`.

On an isolated worktree of that base, the pre-fix command below failed with
`Several environment variables and/or system properties contain different paths
to the SDK.` The minimal extra condition was an inherited `ANDROID_SDK_ROOT`
pointing to a different existing directory; `-Jdk` and `-Sdk` selected the valid,
already-provisioned toolchains:

```powershell
pwsh -NoProfile -NonInteractive -File scripts\build-android.ps1 `
  -Jdk C:\Projects\DevPocket\.tools\jdk-21 `
  -Sdk C:\Projects\DevPocket\.tools\android-sdk -Lint -Instrumentation
```

Removing only the conflicting variable removed that SDK error. The fix sets
both SDK variables to the resolved selection and restores the caller's prior
environment, including absent variables. The same command with conflicting
inherited SDK/JDK values subsequently built both APKs, passed 80 JVM tests
(zero failures/errors/skips), and passed lint (24 warnings, zero errors).
An initially overlong, worktree-owned scratch path separately caused SQLite
test failures; using a short owned scratch path resolved those without changing
app code or tests. These are targeted local observations, **not** mandatory
source-bound acceptance, independent-review approval or evidence that #7's CI
has recovered. Changes to the build script, test registration, diagnostic
exporter and CI artifact wiring require the workflow's human policy review
before the controller executes the changed verification policy.

## Android execution environment

For local Windows runs, provision an isolated executor with hardware-accelerated emulation,
JDK 17/21, SDK platform/build-tools 35, platform-tools, and an installed x86_64
system image. Licenses must already be accepted by the operator. The runner does
not install tools, silently accept terms or change host virtualization settings.
Explicit setup can use `scripts\prepare-android.ps1 -Emulator`; this downloads
checksum-verified tools and the API-35 image into `.tools`, reusing an already
accepted SDK license. Hosted Linux CI setup is described below and does not
change this local Windows installation.

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

Windows automated and manual emulator commands share the same resource pool. They do
not reuse the historical `DevPocketProof` AVD or any retained user emulator.
Owned credential/data/AVD subdirectories are removed
after process shutdown; reports and private diagnostics remain. Windows job
objects retain descendant ownership after a launcher exits. Normal controller
cancellation requests graceful cleanup first; after process exit the controller
also cleans only directories bearing that invocation's owner nonce. A forced
host termination can leave a run directory. Inspect its owner/process record
before targeted cleanup; never delete another run or a retained trial AVD.

### Hosted Ubuntu device execution

The CI `device` job uses the standard x64 `ubuntu-24.04` VM, not `ubuntu-slim`,
ARM or a job container. GitHub supports
[hardware-accelerated Android testing on standard Linux runners](https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/).
The job selects Node 24 and Temurin JDK 21 and uses the image's PowerShell 7,
Python 3 and Android command-line tools. The
[runner image inventory](https://github.com/actions/runner-images/blob/8197087fc536320d1441203fdb5da9ae1b44b863/images/ubuntu/Ubuntu2404-Readme.md)
is a snapshot, not proof of any future job's installed versions.

Setup requires `/dev/kvm` and, only when necessary, grants this job's UID
read/write access with `setfacl`. It does not grant world access, change the
developer machine's virtualization or install a self-hosted runner.
`sdkmanager --channel=0` installs the required stable platform/build tools,
emulator and API-35 Google APIs x86_64 image into the disposable VM's existing
SDK. Stdin is closed: no `yes`, `--licenses` or invented acceptance hash is used.
Existing license records must suffice, and required files are checked afterward
because a refused package may be skipped. Missing licenses, SDK tools or
acceleration fail the job rather than silently falling back.

A hosted-only loader preflight runs `emulator -version` with bounded private
output. It installs nothing when the probe works. Only an observed exit 127
naming `libpulse.so.0` permits installation of
[Ubuntu Noble's `libpulse0`](https://packages.ubuntu.com/noble/amd64/libpulse0/filelist)
from the VM's already configured signed APT repositories, followed by one new
probe. No new repository, key or speculative package list is used. Other loader
failures emit only a bounded library identifier/category and remain blocked.
This optional VM-local dependency preparation never runs on the Windows host.
The installer elevates the reviewed command supervisor with non-interactive
`sudo`, not merely its APT child, so it can stop and reap privileged descendants.
Real Linux timeout/cancellation regressions cover both privilege modes before
the job reaches dependency installation.

The same `android-runner.mjs` builds and runs the shared discovered test classes,
layout matrix and real App/relay/bridge fixture. The Linux build uses the selected
`bin/java` and the checked-in wrapper JAR directly through `build-android.ps1`;
it does not require a generated Unix wrapper or executable-mode changes.
The emulator requires `-accel on` and explicit usable KVM output from
`-accel-check`; software GPU rendering is separate from VM acceleration.
Successful Linux evidence includes `platform: linux` and
`acceleration: { provider: KVM, usable: true }`, which the combiner validates.
Windows evidence and its existing command entry points remain supported.

Ordinary Linux commands use an unprivileged Python standard-library supervisor. It
confirms `PR_SET_CHILD_SUBREAPER` before spawning, holds a pidfd for the owner,
and kills/reaps only validated descendant pidfds, including orphaned detached
children. Dead owners, cancellation and timeouts trigger bounded cleanup.
This is lifecycle ownership, not a sandbox: forcibly killing the supervisor or
delegating work outside its ancestry remains outside that guarantee. The
disposable hosted VM is discarded after the job.

Each Linux invocation reserves its own loopback ports and exclusive
`.data/linux-emulator.lock`, verifies listener inode ownership through `/proc`
and checks the live AVD name. The lock stays through startup/cleanup and an
unreclaimed lock fails closed. This is a single-checkout, job-isolated path,
not a replacement for the Windows account-wide concurrent-worktree pool.
AVD, local credentials and fixture data are removed only after owned processes
stop; raw logs stay private. The authenticated emulator gRPC listener uses the
Linux token option; no unauthenticated listener is enabled.

The job also runs `scripts/tests/linux-process.test.mjs` against real Linux
processes and the actual PowerShell build interface. Portable lease/ownership
parsing checks run in the existing Windows workflow suite as well. Neither
those tests nor a Windows emulator pass substitutes for the actual Ubuntu/KVM
native gate. An incremental Gradle invocation may reuse JVM/lint outputs;
`UP-TO-DATE` is not a claim those tests executed again.

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

The verification workflow uses the maintained Node-24-native Actions:
`checkout@v7`, `setup-node@v7`, `setup-java@v6`, `setup-python@v7`,
`upload-artifact@v7` and `download-artifact@v8`. Their runtime requires
[Actions Runner 2.327.1 or newer](https://github.com/actions/checkout/releases/tag/v5.0.0).
GitHub provisions the hosted VM; this does not install a local runner. The
[checkout container credential requirement](https://github.com/actions/checkout/blob/v7.0.1/README.md)
is 2.329.0 or newer for authenticated Git inside Docker container actions; this
workflow has no job container and keeps `persist-credentials: false`.
Project toolchains remain Node 24, Temurin JDK 21 and Python 3.12. The Windows
Android job passes its explicit project-local SDK; the Linux device job passes
the explicit hosted SDK path after the required stable packages are available.

The upload keeps its explicit file lists and default archived, non-overwriting
behavior. The downloader retains separate artifact directories when multiple
artifacts match; recursive `report.json` discovery also handles a single match
extracted directly into the destination. Keep
[v8's failing digest-mismatch default](https://github.com/actions/download-artifact/releases/tag/v8.0.0):
do not merge same-named reports or downgrade integrity failures to warnings.
An empty download still cannot satisfy the source-bound combiner.
These compatibility checks do not prove a remote Actions run succeeded or that
its warnings disappeared. The separate extension-release workflow is unchanged.

`ci.yml` plans every PR and runs selected backend and Android checks on hosted
Windows runners. The required device job uses hosted Ubuntu for same-repository
PRs or explicit dispatch. It no longer depends on `DEVPOCKET_ANDROID_RUNNER_ENABLED`,
self-hosted labels or the `devpocket-android-ci` environment. Fork PRs do not
gain device execution through an unsafe checkout. Missing or failed device
evidence still blocks **Required verification**, never counts as skipped success.

The backend job binds `DEVPOCKET_PROBE_PYTHON` to the first Python application
selected on PATH. Command discovery may return multiple installations; the
probe requires one executable path, not a concatenated list or PATH alone.

All jobs retain `contents: read`, full-history checkout with
`persist-credentials: false`, and pre-checkout `core.autocrlf=false`. Source
identity hashes tracked bytes and Git index modes, not absolute checkout paths;
cross-platform reports must match rather than normalize away discrepancies.
Device reports and tested APKs use explicit Linux artifact paths. The Windows
combiner still recursively finds only `report.json` and rejects incomplete,
duplicate, failed or mismatched reports.

An administrator should still require **Required verification**, appropriate
approvals, code-owner review for protected paths and dismissal of stale
approvals in the repository ruleset. `CODEOWNERS` alone does not enforce these.
Runner migration does not configure branch protection or enable automatic merge.

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
