# Development workflow

The optional **devpocket-development** Copilot extension is development tooling,
not the shipped phone/runtime extension. It uses the host's bundled SDK and
`joinSession()` to register tools and a workflow. It does not replace the current
runtime, change its permission handler, or request credentials.

## Start a task

Use the AI development issue template to define a goal, observable acceptance
criteria and non-goals. Issue text alone never starts privileged work.

After explicitly authorizing this repository's development extension to load in
the current session, invoke `devpocket_start_development` with:

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

Loading/reloading the extension and the repository's read/search-only
`devpocket-reviewer` profile is explicit. Reloading extensions may also reload
other extensions in that session. Merely adding these files does not activate
them in an already-running session.

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

The automated runner does not use the historical `DevPocketProof` AVD or the
fixed-port manual scripts. Owned credential/data/AVD subdirectories are removed
after process shutdown; reports and private diagnostics remain. Windows job
objects retain descendant ownership after a launcher exits. Normal controller
cancellation requests graceful cleanup first; after process exit the controller
also cleans only directories bearing that invocation's owner nonce. A forced
host termination can leave a run directory. Inspect its owner/process record
before targeted cleanup; never delete another run or a retained trial AVD.

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
