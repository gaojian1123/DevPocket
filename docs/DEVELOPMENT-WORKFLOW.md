# Development workflow

## Default: skill-led development

`AGENTS.md` routes ordinary implementation requests to the **devpocket-development
skill** at `.github\skills\devpocket-development\SKILL.md`. That file is the
authoritative recipe for the task contract, workspace selection, implementation,
verification, independent review, bounded repair and recovery. Invoke the skill
when available; otherwise read the same file directly. A clean linked worktree
stays in the current session. Follow-ups retain their task/workspace and evidence.

The skill distinguishes working-tree implementation from authorized commit/PR
delivery. Its candidate-commit step precedes final verification and independent
review; the task's original base remains unchanged. This ordering does not grant
publication permission or relax evidence identity. The optional controller below
still stops at reviewed changes and does not acquire a commit phase.

This route does not require extension loading, the starter tool or Dynamic
Workflows. It uses the existing verifier and read/search-only
`devpocket-reviewer`; unavailable required checks or independent review still
block completion. The skill is agent guidance, not a durable controller or a
guarantee that an agent cannot skip a step. Verification remains executable;
appropriately configured protected CI and human review must guard publication
and changes to the checks. Adding the skill does not configure repository rules.

An in-conversation task contract is sufficient; the AI task issue template is
optional. Issue text alone does not start work or authorize privileged operations.
Discussion, planning, read-only review and documentation-only work do not start
the implementation pipeline. Dispatched agents perform only their assigned phase.

## Optional: registered workflow

Use this route only when the user explicitly selects controller-managed
execution, or to continue an already recorded workflow run. Ordinary requests
to implement a feature or fix a bug do not opt in. Pre-existing skill-led work
stays with its current owner unless the user chooses to migrate it; preserve its
contract, changes and evidence rather than starting from a base that omits them.

The **devpocket-development** GitHub Copilot extension is development tooling,
not the shipped phone/runtime extension. It uses the host's bundled SDK and
`joinSession()` to register tools and a workflow. It does not replace the current
runtime, change its permission handler, or request credentials.

State the goal, observable acceptance criteria and non-goals before dispatch.
Reuse decisions already made; ask only about unresolved scope, behavior or
authority. An implementation request alone does not select this optional route.

### Choose the entry point: current session first

After explicitly authorizing this repository's development extension to load in
the current session, freshly inspect the starting checkout before dispatch.
Use bounded read-only Git inspection, as the starter does through the existing
Git helper: confirm the repository root, compare the resolved `--git-dir` and
`--git-common-dir`, and inspect
`git --no-optional-locks status --porcelain --untracked-files=all --ignore-submodules=none`.
Check staged, unstaged and non-ignored untracked changes; ignored artifacts do
not make a checkout dirty. Session names and the presence of a `.git` file alone
do not establish linked-worktree identity.

- **Clean linked worktree:** prefer `run_dynamic_workflow` in the **current
  session**, using the invocation below. There is no need for a child session.
  Calling `devpocket_start_development` here also invokes that workflow exactly
  once through the App's native tool boundary, without `create_session`.
- **Clean primary checkout:** use `devpocket_start_development`, passing only
  the `args` object below. It uses the App's native `create_session` with
  `workspace_type: "worktree"` to isolate the task; that child invokes the
  workflow directly. The controller still refuses the primary checkout.
- **Dirty checkout or failed inspection:** stop and preserve the checkout.
  The starter dispatches neither a workflow nor a child. Resolve any dependency
  on existing changes before choosing a clean workspace; do not silently
  start from a base that drops them. Dependencies on a particular in-progress
  branch also require an explicit choice before dispatch, even when clean.

Direct invocation of `run_dynamic_workflow` in an eligible current worktree:

```json
{
  "name": "devpocket-development",
  "args": {
    "goal": "Describe the user-visible change",
    "acceptance": ["An observable success case", "An observable failure case"],
    "nonGoals": ["Behavior that must remain unchanged"],
    "maxRepairRounds": 2
  }
}
```

Discover the available native tool names; the starter supports both unqualified
names and the existing `functions.`-qualified forms. It forwards the validated
task arguments without adding model overrides or guessed workflow limits.
If current-session workflow invocation is unavailable, rejected, fails or has an
uncertain outcome, preserve/report that result. Never fall back to creating a
child or dispatch the task a second time. Inspect an uncertain run before
choosing a continuation.

Loading/reloading the extension and the repository's read/search-only
`devpocket-reviewer` profile is explicit. Reloading extensions may also reload
other extensions in that session. Merely adding these files does not activate
them in an already-running session. The GitHub Copilot host (desktop app or CLI)
must support Dynamic Workflows and eligible execution credentials. The preferred
direct entry does not require the starter, but still requires the native workflow
tool, loaded workflow and read-only reviewer. For missing prerequisites, including
session creation when isolation is needed, report the blocker and request the
specific setup/loading authorization needed before proceeding. Silently switching
an opted-in run to skill-led work or implementer self-review is not a substitute.
The user can choose a different route explicitly. Honor the App's per-run
approval and credit/time controls; opting in does not bypass them or authorize
a replacement runtime.

The controller dispatches implementation, executes verification itself, and
dispatches a separate read-only reviewer against the actual diff and added files.
It accepts neither implementer-written approval nor an editable workspace result
as the authoritative review. The SDK's durable step journal holds the final
controller result. Each repair gets a fresh review invocation and source-bound
evidence. Runtime credit/time limits are chosen at invocation; the workflow does
not guess them or override model preferences.
Registration uses only Node built-ins and the runtime-bundled SDK, so a fresh
worktree can load it before restoring application dependencies. Provision the
runner toolchain once; normal missing repository dependencies can be restored
from their lockfiles after an actual missing-dependency failure.

For an existing run, route feedback to its current owner or inspect/resume its
recorded run. Dispatched implementers/reviewers perform their assigned phase,
rather than calling the starter recursively.

The automatic endpoint is **ready for a PR**, with changes in the worktree and
`handoff.json` under `.data\development\<run-id>`. It does not commit, push, open a
PR, merge or deploy. Use the App's normal PR creation path when publication is
authorized. Commit/merge-ref changes require fresh applicable verification; old
reports are not re-labelled as evidence for a new revision.
Report the actual run/worktree and outcome when dispatched. Say that a workflow
has started only after an invocation returns its run identity; a proposed plan
or manually performed equivalent steps are not a registered workflow run.

## Verification

Run from the checkout with Node 24 and PowerShell 7. The complete workflow
regression suite also needs Git, Python 3.12 (standard-library checks), the
root npm dependencies (including TypeScript/tsx), and the existing Windows
owned-command compiler support. It uses synthetic toolchains, not an Android
SDK/JDK or emulator. Operational fixture checks additionally need the pinned
`deployment\azure\probe\requirements-test.txt` dependencies; use an isolated
environment rather than changing the machine's Python packages.

```powershell
npm run verify -- -Base BASE_COMMIT -Plan
npm run verify -- -Base BASE_COMMIT
```

The base is explicit; it is not guessed from a branch name. Planning is not
acceptance. The source fingerprint includes tracked and non-ignored untracked
inputs, including deletions. Required checks come from the actual diff, not an
agent's risk label. The planner and `scripts\verification-policy.mjs` catalogue
are shared by local verification, the development controller and CI. Each
selected check defines its group; `requiredGroups` is derived from those
definitions, never from "non-Android means backend."

Impact rules are explicit and ordered:

- `README.md`, `VALIDATION.md` and `docs/**/*.md` select no checks.
- Exactly `scripts/workflow-extension.mjs` and
  `scripts/tests/development-workflow.test.mjs` select `workflow-tests`, in the
  independent `tooling` group. These are task-start/session-routing tooling and
  its regressions, not the shipped runtime extension or verification controller.
- `AGENTS.md` selects the same tooling regressions and retains protected human
  review, without automatically selecting application checks. Thus the five-path
  PR #10 change set (these three paths, README and the workflow guide) selects
  only `workflow-tests`; either tooling path also does so independently.
- Verification policy/engine, CI definitions, build tooling, shared execution
  and cleanup infrastructure, and dependency configuration select **all** checks,
  layouts and human review. This includes `scripts/verification-policy.mjs`,
  `scripts/verification.mjs`, `scripts/verify.mjs`,
  `scripts/development-workflow.mjs`, other scripts/tests, `.github` definitions,
  package/lock/npm/TypeScript/Python dependency inputs and Android build inputs.
  There is no scripts-directory exemption.
- Existing backend, runtime-extension, operations, shared wire/fixture and
  Android rules retain their downstream coverage. Backend checks still include
  workflow regressions, now in the tooling lane. Runtime/wire changes still
  require native compatibility evidence; Android UI/resource changes select
  layouts. Unclassified paths select the full set, layouts and human review.

Mixed changes take the union; no narrow rule cancels another path's requirements.
`--all` explicitly selects every check. Plan JSON and CLI output include
`requiredChecks`, `requiredGroups`, `requiresHumanReview`, `layouts`, and
`selectionReasons`: fixed rule descriptions, selected checks/groups and sorted
changed-path examples (at most 16 paths of 240 characters per rule, with
`omittedPaths` for unsampled/unsupported names). Omission affects explanations
only, not selection. Diagnostic projections rebuild fixed descriptions and
allow at most 16 current source-indexed path examples overall; raw/private log
fields cannot become explanation text.

The verifier reuses the commands in `package.json`. Android changes and affected
runtime/wire changes require JVM/build checks **and** native emulator evidence.
Protection is separate from impact selection. The controller's existing
`isVerificationPolicyPath` stop still covers **all** scripts, `.github` and
`AGENTS.md`, including tooling-only changes. The optional workflow pauses before
executing modified gate/dependency policy; review that policy explicitly before
another run. Skill-led development also retains explicit policy review and the
plan's human-review requirement. A change implementing these planner/CI rules itself has full
impact and does not bypass that stop. Targeted synthetic regressions are not a
completed source-bound gate or independent-review approval.

For CI shards, use `-Group tooling`, `-Group backend`, `-Group android` or
`-Group device` with a separate `-Report` for each. The tooling check remains
the **complete** `npm run test:workflow` suite, not a per-test-file selection.
A successful shard is `partial` unless it covers the whole plan. For a full
plan, aggregate all four reports using:

```powershell
node scripts\verify.mjs --base BASE_COMMIT --combine `
  --input .data\verification\tooling\report.json `
  --input .data\verification\backend\report.json --input .data\verification\android\report.json `
  --input .data\verification\device\report.json --report .data\verification\combined\report.json
```

Supply only the selected reports for narrower plans. For example, after
protected-policy review, a tooling-only plan can use:

```powershell
npm run verify -- -Base BASE_COMMIT -Group tooling -Report .data\verification\tooling\report.json
node scripts\verify.mjs --base BASE_COMMIT --combine `
  --input .data\verification\tooling\report.json `
  --report .data\verification\combined\report.json
```

CI additionally supplies `--upstream group:outcome` for each lane, for example
`--upstream tooling:success --upstream backend:skipped` only when those are
the actual job outcomes, not invented attestations. When any
job outcomes are supplied, every selected group needs `success`; missing,
failed, cancelled, skipped or unknown selected jobs block acceptance even with
passing check reports. Unselected skipped lanes do not block tooling-only or
documentation-only plans. Local aggregation can omit upstream outcomes; it
still requires all selected checks. A documentation-only plan needs no shards.

Aggregation rejects missing checks, failed/blocked/planned evidence, duplicate
results, wrong-group checks, mismatched policy, and stale base/source identities.
Verification reports are now **version 2**, with required `requiredGroups`
matching the current catalogue. Version-1 reports, absent group policy and
reports that place `workflow-tests` in backend cannot qualify; rerun rather
than relabel old evidence. Non-acceptance diagnostic exporters can still read
version-1 reports, using their legacy workflow-test group. Device/startup
evidence formats are unchanged. A required check
that did not run is never equivalent to passing. Schema generation that changes
source also invalidates that run; review the generated change and verify again.
Detailed logs remain private in ignored run directories. Share only the
allowlisted machine reports and explicitly selected candidate artifacts.
Report destinations must be new files beneath `.data\verification` or `.data\ci`;
existing reports and sealed/operational evidence cannot be overwritten.

### End-to-end failure information

Controlled failures retain separate **execution**, **evidence validation** and
**diagnostic collection** outcomes. A failed collector or cleanup must not replace
the original test failure. Conversely, a successful command is not accepted when
its required report, source, APK or cleanup evidence is missing. The controller
records fixed reason codes for invalid/missing reports, source/policy mismatches,
missing/duplicate checks, APK identity, cancellation, deadlines and process exits.
Final source-inspection exceptions retain the already collected checks and add a
separate source-validation failure. Aggregation republishes only explicit
acceptance fields, never arbitrary fields from an input shard. Baseline native
class identifiers are fixed; additional public class identifiers must match
current Android test-source declarations. An unrecognized additional identity
blocks evidence publication rather than exposing its raw value or skipping it.
Observed process exit values identify the owned command supervisor; they are not
invented exit values for an unobserved descendant.

Every job with available checkout/runtime can publish a bounded
`verification-diagnostics.json` and a GitHub step summary. These include the
job/check/phase, selected groups and bounded plan causes, original exit facts, collection availability and safe source-aware
hints from failed private check logs. Hints are not a proved root cause. A required
upstream job failure also prevents a passing aggregate, even when an earlier
check report survived a later exporter or artifact failure; that does not relabel
the original tests as failed.

The failure-surface audit and validation contract are:

| Surface | Failure information and verification |
| --- | --- |
| Checkout, Node/JDK/Python setup and their post steps | Keep the named official Action's native error log and platform outcome; no duplicate wrapper. Current workflow contracts retain versions, read permissions and credential isolation. |
| npm/Python dependency restoration | Keep direct command errors and exit status. The summary distinguishes an unstarted verifier and an unproduced report; it does not invent a check pass. |
| Plan and explicit base resolution | Native Git/PowerShell errors identify base resolution; controller planning/report errors emit fixed structured reasons. Invalid-base and illegal-destination CLI cases remain nonzero. |
| `workflow-tests` | Exact check/exit, private-log availability and bounded source-indexed declaration hints. Controlled predecessor, log-init, cancellation and collector regressions exercise the real controller. |
| `typecheck`, `backend-build` | Exact check/exit plus bounded compiler codes and existing repository source positions. A real synthetic TypeScript compilation checks that private values are excluded. |
| `backend-tests` | Existing protected source-mapped Node reporter, catalogue/nonce binding and guarded artifact, plus the common check summary. Original invocation/default concurrency and preflight privacy regressions remain. |
| `schema` | Separate command failure and source-changed outcome. Source mutation cannot be accepted as an unchanged green result. |
| `extension-package`, `setup`, `azure-tests`, `operations-tests` | Exact check/exit and fixed exception/error codes or trusted relative source frames where recognized. No archive/request/credential/assertion bodies are exported. Unsupported details remain unknown. |
| Android build/JVM/lint | Bounded Android projection with declared test/source identities and fixed task/exception/lint identifiers; real compiler/Gradle output is not uploaded. Preserve incremental-task qualifications. |
| Shared KVM/SDK/license preparation | Same resources and policy, with explicit fixed missing-device/access/license/package/tool/image reasons. SDK command failures preserve their exit. No new license acceptance or fallback acceleration. |
| Shared Linux platform tests | Same fixed test list and default scheduling behind owned bounded capture and the protected Node reporter. Raw assertion/stdout events stay private; actual Node-failure counterexamples retain nonzero exits. |
| Emulator loader preparation | Distinguish initial probe, package-index update, approved package installation and reprobe. Only the already-approved observed missing `libpulse.so.0` permits installation. |
| Device execution and standalone startup | Owned phases, attempted cases, primary failure and secondary collection/cleanup facts survive runner/CLI/controller boundaries. Real boundary tests use synthetic failures, not only parser samples. |
| Exporters and file/summary publication | Explicit missing/invalid/linked/oversized/foreign evidence; exclusive output creation. A readiness output is written only after the current safe JSON is created. Refused existing files are not uploaded. |
| Artifact upload/download | Keep official Action errors and strict digest/missing-file behavior. Required upstream failures and missing shards remain blockers. |
| Aggregate/source/policy/APK validation | Distinct safe reason codes and known check/input/artifact-role context, not a single generic exception. CLI regressions cover missing, invalid, mismatched and failed evidence. |

Private check/build/case/crash logs retain at most 1 MiB of their beginning and
end; the owned command capture has a separate bounded input budget. Summary
sampling reads at most 256 KiB per failed check. Public check summaries are at
most 64 KiB. Only current Git-indexed source paths and fixed error/compiler
identifiers become general log hints; runtime error text is never copied.

**Platform limit:** an unassigned runner, lost VM, forced process termination or
unavailable checkout/runtime can prevent all finalization. Native GitHub job/step
termination is then authoritative. A missing report is `not-produced` or
`unavailable`, never a successful check. Old runs whose private logs were not
retained cannot be reconstructed by new diagnostics.

### Device failure diagnostics

The device recorder tracks preparation/resources/lease/build/AVD/acceleration,
ADB/boot/ownership, installation/discovery, native/layout/additional/fixture
cases, source/APK validation and cleanup. A case is recorded when attempted,
not only after a successful await. The first execution failure is retained
while logcat, private-log, report and cleanup issues are recorded separately.
Timeout/cancel/worker-exit and missing-report states remain explicit.
Managed ADB/emulator/fixture log-write exceptions are collection failures, not
failed native assertions or failed resource cleanup. Actual I/O exceptions on
the dedicated native-lifecycle pipe also latch failed collection, with a fixed
role/channel and allowlisted OS code, even when worker logs remain healthy.
Incomplete or bounded-truncated telemetry alone is not an I/O exception.
Startup capacity sampling similarly preserves unexpected filesystem exceptions
as separate before/after-preparation collection failures; a later healthy sample
cannot clear them. Explicitly unsupported or non-representable capacity remains
unknown rather than an invented I/O failure.
An otherwise passing native sequence retains `executionStatus: passed` and passed cases, but
verification becomes blocked; diagnostic collectors exit nonzero after cleanup.
The success-only APK artifact cannot qualify that run.
Private case/crash logs use the `case-<id>` prefix so they cannot collide with
the live fixture worker's `fixture.log`. In the automated run, a case-log write
failure keeps a passed instrumentation result intact and latches failed
collection instead; its secondary record retains the trusted phase/case.
Other native checks and cleanup still run, but the final qualification remains
blocked and existing files are never overwritten. Standalone/manual callers
without a run-level recorder retain immediate error propagation.

Instrumentation projection reads only bounded output from the owned invocation.
It matches class/method identities and relative source frames against the
current Android source catalogue. Strings/comments are excluded from declaration
scanning; unsupported declarations or mismatched catalogues stay unknown.
Nested Kotlin interpolation is skipped as part of its enclosing literal, so
inner strings cannot manufacture trusted declarations. Device/startup CLI
argument errors are handled before any raw argument or stack can be printed.
Java declarations are not inferred with the Kotlin scanner. Java files may
provide known file locations, but class/method identity remains unsupported
rather than approximating Java Unicode/comment/string semantics. Unknown
additional classes cannot qualify through a missing class field or an
unexpected case name.
Only fixed exception types/status codes and trusted source references are public:
no assertion operands, UI/session text, pairing codes, SDK events, argv/env,
private absolute paths, credentials, URLs or whole logcat.

The source catalogue is bounded to 128 files, 512 KiB per file and 4 MiB overall.
Build diagnostics also index the standard debug/release resource source sets,
including the debug network-security resource, without copying resource values.
Instrumentation sampling is at most 128 KiB; long messages can still retain a
known exception prefix without publishing their bodies. Case/history/secondary
lists and stack frames are bounded. The device snapshot is at most 32 KiB;
the final source-bound exporter envelope is at most 64 KiB. Unknown, truncated
or unavailable collection does not erase known phase facts.

The actual device CLI emits the safe final snapshot as well as retaining it in
the private report. The verifier reprojects it, binds it to its originating
device invocation, and can recover known facts from the safe CLI frame if the
private report could not be written. Neither fallback qualifies missing formal
native evidence. The raw private `device-report.json` is never made an
unconditional failure artifact.

Artifacts are explicit and separate:

- `verification-tooling`, `verification-backend`, `verification-android`, `verification-device`: the
  original `report.json` only; `verification-summary`: `gate.json`.
- `check-diagnostics-plan/tooling/backend/android/device/gate`: their bounded
  `verification-diagnostics.json`.
- `backend-test-diagnostics`, `android-test-diagnostics`,
  `device-test-diagnostics`, `owned-worker-diagnostics`: only their corresponding
  projected JSON. Android and worker projections require successful current
  creation; the readiness marker prevents publishing refused/pre-existing files.
- `native-platform-diagnostics`: the protected fixed-suite report.
- The existing tested-APK artifact remains **success-only** and still contains
  exactly the app APK, instrumentation APK and qualifying device report.

Collectors do not use `continue-on-error`. A collector may publish a validated
failure/unavailable descriptor and still exit nonzero: its error stays visible,
and the original check outcome remains distinct. GitHub file-command writes are
explicitly enabled by `--github` and restricted to the runner's file-command
directory; synthetic tests use their own file-command fixtures.
Unexpected source-index and private-log read exceptions are collector failures,
not successful collection. Expected unproduced evidence and bounded truncation
remain explicitly distinguished. Startup outer recovery cleanup similarly
preserves the original owned command exit alongside a separate cleanup result.
If the startup report itself cannot be written, its bounded failure snapshot
travels through the owned CLI entry and an owner-validated entry fallback;
report publication failure stays separate from the original preparation exit.
The coordinator publishes a fresh invocation ID before launching the child.
The startup collector requires that ID, rejects foreign/stale ready-shaped
files, and prefers the validated current entry fallback when publication was
refused. No invocation ID means no attributed startup report.
Cancellation before/while waiting for a lease and lease deadlines have explicit
categories without invented process exit codes.
Actual recorder and controller collection exceptions are latched for the run;
a later healthy catalogue read cannot clear them. This does not turn expected
bounded truncation or explicitly unsupported declaration syntax into an
execution failure.
That latch also applies to planning, standalone readiness qualification and
protected backend reporter frames. Successful test exits/readiness remain
separate facts; a later catalogue recovery cannot requalify an earlier
collection exception. Contradictory passed shards carrying collection-failed
markers cannot satisfy aggregation.

### Backend failure diagnostics

CI retains the normal owned PowerShell `npm test` invocation, test discovery,
default concurrency and selected predecessor checks. `--backend-diagnostics` (or
`-BackendDiagnostics` through PowerShell) adds a check-scoped Node test reporter
through npm's lifecycle `node-options`; it does not replace the command with a
selected-test proxy. Before any predecessor runs, diagnostic preflight checks
inherited Node/npm options and reads effective project/user npm `node-options`
with a bounded owned `npm config get node-options` command. Conflicting
reporter settings are refused before they can affect predecessors, including
workflow regressions in a local all-group run. CI runs those regressions in
the independent tooling job; the backend job no longer executes them.
For the backend check only, the effective benign options are retained and the
reporter is appended through npm's own configuration channel, so npm cannot
silently replace the protected child configuration. The npm parent's original
Node options remain unchanged. Other caller flags remain, and conflicting reporter options, including
Node's underscore aliases, are refused. Source maps are explicitly enabled;
caller options that disable them are refused rather than silently overridden.
Option tokenization follows Node's `NODE_OPTIONS` grammar: double quotes group
values, spaces separate unquoted arguments, and apostrophes remain literal.
Interpolation-bearing option strings (`${...}`, including escaped forms) are
unsupported and explicitly block diagnostic preflight. They are not expanded,
discarded or copied into a channel where npm could reinterpret validated tokens.
Instrumentation can affect timing; a non-reproducing diagnostic run is not a fix.

The reporter builds a catalogue from current `backend/tests/*.test.ts` source
declarations using the existing TypeScript dependency. Source-mapped runner
coordinates must exactly match a catalogue declaration before its repository
file and original line/column can be emitted. Names are never used for lookup,
so a dynamic name cannot borrow a static test's identity. Runtime names, dynamic
labels and unmatched transformed `tsx` locations are never exported. Missing
matches retain a known file where available and an unknown declaration.
A catalogue digest and per-check invocation ID prevent stale
observation from being relabelled against a different source or invocation.

Only fixed runner failure types, allowlisted error categories and bounded counts
are retained. Messages, assertion operands, stacks, SDK events, stdout/stderr
events, argv, environment values, absolute paths, URLs and credentials are omitted.
The catalogue is limited to 64 files, 512 KiB per file, 4 MiB total source and
2048 declarations; observation retains at most 10000 events and 32 findings.
Observation still drains the runner after reaching its budget and marks itself
incomplete. The private backend log retains at most 1 MiB of beginning/end data.
Neither complete diagnostic collection nor exporter success means tests passed.

The exporter revalidates identities/categories, reads only the selected
`report.json` (at most 512 KiB) and `backend-tests.log` (at most 1 MiB), and emits
at most 16 KiB. Linked inputs/directories and existing output files are refused.
Missing, mismatched, ambiguous or unsupported evidence remains explicit.
The original `verification-backend` artifact still contains only `report.json`.
A separate `backend-test-diagnostics` artifact contains `backend-diagnostics.json`
only after the current exporter creates validated output. A safe failed-collection
descriptor may be published while the exporter exits nonzero; refused/pre-existing output is never
published by that step; raw logs and the rest of `.data` are not published.
The original failed check,
unexecuted later checks and source-bound aggregate remain authoritative.

For a reviewed investigation, manual `backend_diagnostic: true` reuses the
normal Windows backend job and toolchain/setup/entry chain, without starting
tooling or unrelated Android/device jobs. Native-startup diagnostics use a separate workflow.
**Required verification deliberately fails in this mode**, even if all backend
checks pass. Normal PR/full manual mode still requires current native/source/APK
evidence and every other selected check. Record the new question before each run;
do not repeat an unchanged run merely to obtain green.

### Android failure diagnostics

The Android CI job runs `scripts\android-diagnostics.mjs` after a failure and
keeps these explicitly named files in separate artifacts:

- `.data\ci\android\report.json`: the original source-bound machine report.
- `.data\ci\android\android-diagnostics.json`: diagnostic metadata, **not**
  verification evidence or a replacement for the report; published only after
  the current exporter creates a validated output.

The exporter also prints the same projection to the job log. It reads only
`android-build.log` in the selected run directory. It samples at most 256 KiB
(both ends of a larger log), emits at most 24 findings and 16 KiB, and marks
truncation. Allowlisted fields include known failure categories, failed app
tasks, JVM test counts/identifiers, exception types/source positions, compiler
source positions/error categories and lint issue IDs/source positions. Messages,
assertion values, source excerpts, environment values, absolute paths, URLs and
unrecognized text are omitted. Test identities and source positions must match
the current Android source catalogue; dynamic invocation suffixes become bounded
numeric indices. Task/exception/lint names use fixed allowlists, not arbitrary
names that merely look harmless.
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

### Owned-worker exit diagnostics

The managed `adb` and `emulator` roles retain bounded exit diagnostics independently
of the required test result. Roles come from the controller's fixed call sites,
not from log text. Exit codes and signals come from the existing owned-command
supervisor's process handle. They are explicitly labelled
`observedProcess: owned-command-supervisor`, not inferred native exits. On Linux,
a separate supervisor-only pipe also records `nativeLifecycle` for the directly
launched command: initialization/spawn phases, numeric spawn errno, actual
`Popen`/`waitpid` return code and signal, stop reason, native liveness at that
observation and cleanup-induced exit. The pipe is closed in the native child;
stdout cannot forge this provenance. A launcher that creates another descendant
still does not establish that unobserved descendant's exit code. Missing events
or unsupported values remain `unknown`, never zero or success.

The context is frozen when the exit is observed: unexpected, during requested
cleanup, or during caller cancellation. Later cleanup cannot relabel an earlier
unexpected exit. These labels describe observation timing, not proof that a
cancellation request caused a concurrent failure. Cleanup confirmation and
resource ownership checks are unchanged.

Only the first and last halves of at most 32 KiB **per stream** of each owned
worker's stdout and stderr are sampled separately. A fixed category allowlist can identify loader, acceleration,
option, graphics, port, AVD, disk, memory or process-signal patterns. A category
is a diagnostic hint, not a proved root cause; missing information stays
explicitly unknown and truncation is reported. Raw messages, argv, environments, absolute paths, URLs,
tokens, process-ID inventories and unrelated session data are never included
in this projection. Original detailed failures remain in private run logs.
For the trusted emulator role, the exact upstream `Not enough space to create
userdata partition` template can additionally project `userdataCapacity`:
stdout/stderr provenance and bounded numeric available/required capacity.
The upstream values labelled MB are calculated in MiB; the private path and
entire original message are discarded. Missing, malformed or conflicting values
remain `unknown`. This is reported output, not a substitute for observed native
exit/readiness evidence or permission to change disk/AVD policy.
See the [upstream capacity check](https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/android-qemu2-glue/main.cpp#2447).
Each private managed-worker log retains at most 1 MiB, preserving its beginning
and end with an explicit truncation marker while excess output is still drained.
Log-write failure is reported separately and cannot prevent owned-process cleanup.
The native lifecycle pipe has a 16 KiB input budget and at most twelve fixed
phase records. It is nonblocking; incomplete/malformed transport is reported
instead of converting missing native status to a successful wrapper status.
Native statuses reaped during cleanup are retained rather than lost to a later
`Popen.poll()` call. Cleanup/owner monitoring and their time bounds remain active.
Conflicting before/during-cleanup exit records are incomplete evidence with an
unknown summary, never a confidently relabelled natural exit.

The source-bound machine report includes the allowlisted projection on both
success and failure. The CI exporter reads only that run's `report.json`
(at most 512 KiB) and creates a separate, at-most-8-KiB
`.data/ci/device/worker-diagnostics.json`. Missing input is reported as missing;
linked inputs/directories and existing output files are refused. The device
verification artifact selects only `report.json`; the separately guarded
`owned-worker-diagnostics` artifact selects only `worker-diagnostics.json`.
The tested-APK artifact's existing success-only list is unchanged. The combiner
continues to read only `report.json`. Diagnostic output can neither satisfy a
missing required check nor turn a blocked/failed device result into a pass.

### Focused native-startup CI

For a source-reviewed startup investigation, **Native startup diagnostics**
(`.github/workflows/native-startup-diagnostics.yml`) is a separate,
`workflow_dispatch`-only workflow. Select an explicit `base` and `variant`:
`same-build` (default) or `without-build`. The base resolves to its merge base
with the selected workflow ref before shared preparation starts. This workflow
does not run on pushes or pull requests, and the main **DevPocket verification**
workflow has no native-startup diagnostic input or job. The existing backend-only
diagnostic mode remains in the main workflow.

The standalone job runs on hosted Ubuntu without waiting for backend/Windows
build jobs. Both full verification and this diagnostic reuse
`.github/actions/prepare-native` and the same build preparation, emulator
configuration, KVM checks, resource ownership and cleanup implementation.
The diagnostic keeps the owned PowerShell-to-Node entry chain used by the device
runner, including its command deadline, cancellation forwarding and owner nonce.

`same-build` preserves the normal Linux build-before-launch path.
`without-build` changes only that explicitly selected preparation factor; it is
not a replacement acceptance mode. Each diagnostic records source/base,
emulator/ADB binary hashes, selected toolchain/image, available bytes on the owned
run filesystem before/after preparation, readiness and bounded worker/native
lifecycle metadata and known execution phases. Its `startup-report.json`
artifact is a reprojected copy from the run's `public` subdirectory, at most
16 KiB, containing no raw output or private paths. A separate
`check-diagnostics-startup` summary records preparation/entry/report availability.
Neither is uploaded merely because an unvalidated destination already exists.

A ready startup probe does not install/run the native test suite and cannot
satisfy **Required verification**. The standalone workflow succeeds or fails
according to the actual probe and required report publication; it has no
deliberately failing verification job. Its report remains `acceptance: false`,
and its artifact name is outside `verification-*`, so the combiner cannot treat
it as a shard. Normal PR and full manual verification still require every
original check and native case.

GitHub requires a manual workflow to exist on the default branch before it can
be dispatched. If that blocks pre-merge execution of a newly added workflow,
retain static/entry-contract results separately from the new candidate's full
verification. Do not add automatic triggers or change the default branch to
bypass registration. Run an actual `same-build` manual check after the exact
reviewed commit is merged and the workflow becomes available; do not label the
new standalone entry runtime-tested beforehand.

Record a falsifiable prediction and the changed factor before each experiment;
do not repeat an unchanged failure without new information. Once startup is
repaired, run full verification against the actual candidate.

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

On Windows, `sys.boot_completed=1` is not sufficient input readiness. The same
600-second boot budget also covers read-only confirmation that the resolved
HOME activity is resumed, visible, fully drawn, and owns the focused window.
The runner sends no unlock input or application operations before that evidence.
This prevents MENU input racing a first-boot Launcher whose activity has been
created but whose first frame is still pending. Missing or unfamiliar evidence
does not pass. A visible or recorded HOME ANR stops admission without dismissing
the dialog; the owned run retains its fixed readiness status and bounded
system-ANR/window diagnostics before cleanup. No image, renderer, host limit or
Launcher enablement is changed, and Linux keeps its existing boot path.
Transient read-probe failures with no cleanup uncertainty remain unavailable
evidence and are retried within that same absolute deadline. Cancellation,
unconfirmed process cleanup and an observed ANR still stop admission immediately.

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
On the disposable hosted Linux job, native preparation passes a fresh
`<owned-run>/gradle-cache` through the build script's explicit `-GradleUserHome`
argument. The full APK/JVM build still runs. After the successful owned build
reports its process-tree cleanup receipt, preparation removes only that cache
before emulator startup, preserving APKs, build outputs and source identities.
Early cache-only cleanup rechecks the run nonce and canonical directory; it
cannot remove the remaining run data or follow a cache link into another directory.
This prevents build-only dependencies from occupying the free space required
to create userdata; it does not reduce the AVD or bypass its capacity check.
Windows and ordinary local builds keep their default worktree cache. An explicit
cache argument, like the selected SDK/JDK, is process-scoped and restored afterward.
Failed/cancelled builds keep their result and use nonce-checked post-shutdown
cache cleanup. An unconfirmed owned-command cleanup retains private data and the
lease record with a failed cleanup result; only this controller's temporary
socket reservations are closed so it can exit for outer-owner recovery.
Readiness polling immediately propagates explicit command-cleanup uncertainty
instead of retrying it into success or erasing it in a timeout. The run also
retains ADB command-cleanup uncertainty across later error handling.
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
An empty download cannot satisfy a nonempty required-check plan; a
documentation-only plan legitimately needs no check artifacts.
These compatibility checks do not prove a remote Actions run succeeded or that
its warnings disappeared. The separate extension-release workflow is unchanged.

`ci.yml` plans every PR and runs selected tooling, backend and Android checks
in separate hosted Windows jobs. The tooling job installs only Node/root npm
dependencies and Python; it uses the hosted PowerShell/Git/compiler support,
does not run application builds, and does not provision JDK/SDK/emulators or
operational Python/deployment npm dependencies. The required device job uses hosted Ubuntu for same-repository
PRs or explicit dispatch. It no longer depends on `DEVPOCKET_ANDROID_RUNNER_ENABLED`,
self-hosted labels or the `devpocket-android-ci` environment. Fork PRs do not
gain device execution through an unsafe checkout. When device checks are
selected, missing or failed evidence still blocks **Required verification**,
never counts as skipped success.

The unchanged, always-run **Required verification** job depends on plan and all
four lanes, downloads `verification-*` artifacts, and forwards every lane's
actual outcome to the source-bound combiner. Required lanes come only from
the current planner. Tooling-only changes run plan/tooling/gate and skip
backend/android/device; documentation-only changes run plan/gate; full-impact
changes require all four lanes. Artifact/collector failure in a selected job
cannot be hidden by an earlier passing check report.

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

CI, skill instructions and reviewer profiles in a PR are themselves changeable
code. Neither development route is a sandbox or a cryptographic attestation
service. A protected review
process (or an organization-controlled required workflow) must guard changes to
the checks themselves. The optional workflow enforces independent review through
its controller; skill-led development relies on the agent to request that review.
The verifier checks source-bound test evidence, not the authenticity of an AI
review. Neither route creates a separately authenticated GitHub review/check
publisher for PRs.

The device job uploads only its tested candidate APKs and device report. A
candidate is not a signed release, full real-CLI/physical-device acceptance, or
authority to distribute. The existing extension distribution workflow remains
separate. `save-debug-artifact.ps1`, sealed build 002 and frozen release evidence
are not repurposed for CI candidates.

## Stops and recovery

For skill-led work, follow the recovery steps in
`.github\skills\devpocket-development\SKILL.md`. The remaining rules apply to
recorded runs of the optional workflow.

The controller stops for missing prerequisites, agent failure, inconsistent
review results, changed source during verification/review, protected policy
changes, high-risk final review, or exhaustion of the chosen repair count.
Uncertain external side effects remain outside the automatic workflow.

An interrupted implementation is not automatically replayed. Inspect
`state.json`, the runtime's durable workflow record, and any retained lock. A
completed journaled run may be read again only while its task/workspace/source
still match; edited files invalidate its readiness. Start further work from an
explicitly reviewed state rather than deleting evidence to bypass a stop.
