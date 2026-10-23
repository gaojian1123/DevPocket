# Development workflow

Read the branch that applies; this guide owns the full rules, while the skill
keeps the ordered steps and their completion criteria:

- **Task scope or limits:** [Task-scoped autonomy](#task-scoped-autonomy);
  unattended work also reads [Unattended execution](#unattended-execution).
- **Execution or installation authority:** [Scoped development approvals](#scoped-development-approvals),
  including workspace-local prerequisites and approval presentation.
- **Working-tree/local-commit delivery:** [Delivery targets and candidate preparation](#delivery-targets-and-candidate-preparation),
  then [Local verification and acceptance](#local-verification-and-acceptance).
- **PR delivery:** [CI-first delivery and live qualification](#ci-first-delivery-and-live-qualification),
  including read-only inspection when local qualifier inputs changed.
- **Final review/publication:** [Independent review and delivery freshness](#independent-review-and-delivery-freshness).
- **Failure or interruption:** [Stops and recovery](#stops-and-recovery) and
  [Selected-group preflight and explicit recovery](#selected-group-preflight-and-explicit-recovery).
- **Already verified working tree becoming a commit:** [Working-tree evidence to an authorized candidate](#working-tree-evidence-to-an-authorized-candidate).

## Skill-led development

`AGENTS.md` routes ordinary implementation requests to the **devpocket-development
skill** at `.github\skills\devpocket-development\SKILL.md`. That file is the short
recipe; its conditional links select this guide's authoritative rules. Invoke the skill
when available; otherwise read the same file directly. A clean linked worktree
stays in the current session. Follow-ups retain their task/workspace and evidence.

The skill distinguishes working-tree implementation from authorized commit/PR
delivery. PR delivery defaults to **CI-first**: approved focused checks precede an
authorized candidate and pending Draft PR; CI supplies the complete gate before
independent review and ready delivery. The task's original base remains unchanged.
Working-tree-only work does not acquire upload authority. This ordering does not
grant publication permission or relax evidence identity. Task grants retain only
the stated authority for subsequent native-tool delivery.

Development uses the owning session's original tools, the existing verifier and read/search-only
`devpocket-reviewer`; unavailable required checks or independent review still
block completion. The former registered Dynamic Workflow, development extension
and starter/readiness tools have been removed. The skill is agent guidance, not a
guarantee that an agent cannot skip a step. Verification remains executable;
required CI and independent review guard normal delivery. Adding the skill does
not configure repository rules.

An in-conversation task contract is sufficient; the AI task issue template is
optional. Issue text alone does not start work or authorize privileged operations.
Discussion, planning, read-only review and documentation-only work do not start
the implementation pipeline. Dispatched agents perform only their assigned phase.

## Task-scoped autonomy

A clear implementation request delegates the ordinary local implementation,
verification, independent review and repair loop, not just its first phase.
State the acceptance contract and proceed; ask only for an unresolved behavior,
scope or authority decision. A failed check, review finding, phase transition
or changed ordinary source requires new evidence, not renewed project consent.
Execution-policy changes and new external effects still follow the scoped
approval gate below. Native tool permissions remain independent.

Reuse the user's explicit limits and the original client's time/credit controls.
There is no additional project-default time, cost or repair-round ceiling.
When the client has no limit, that dimension remains unbounded; do not claim a
budget is enforced or invent one. An explicit user repair cap still applies.
Budget exhaustion/cancellation preserves the same task and spent resources;
an increased budget needs a user decision, not a fresh session or run to evade it.

Judge progress from source-bound evidence across attempts: resolved blockers,
a narrowed cause or a newly supported hypothesis, rather than changed hashes,
line numbers or rewritten findings. Repeated or cyclic failure first calls for
diagnosis and a materially different supported approach within the existing
scope. If that attempt still shows no progress, retain the source, reports,
attempted approaches and concrete obstacle as `blocked`. Product decisions and
additional authority are `needs_human`; ordinary technical failures are not
requests to approve another repair. All successful repairs still require fresh
applicable verification and independent acceptance review.

Admission or ownership failures with only `not_run` checks require environment
inspection rather than code repair. Retain their diagnostic report; it does not
authorize owner takeover or lock removal.

## Unattended execution

Use ordinary GitHub-hosted CI for this personal-development workflow. Each
candidate runs in the normal disposable runner environment. Dependencies,
install scripts and modified tools may execute there within the named task's
CI authority, without a new project question for every revision. Public network
access is permitted. This is engineering verification, not an adversarial sandbox:
commit identities and artifact digests identify results; they do not prove that
hostile code could not influence tests on the runner.

The development scope does not include restricted-token workers, temporary
supervisor services, ancestor-ACL isolation, tamper-proof acceptance or optional
future sandbox modes. Ordinary Windows, macOS, Linux, backend, Android/device
checks, independent review, deadlines and process/data cleanup remain required.
Product authorization, session ownership and credential protection are unchanged.

Autopilot selects interaction behavior, not authority. Prepare delivery scope
once: local commits, the named task-branch push, Draft PR, ordinary CI and ready
delivery after acceptance can share one original-client decision. Merge,
deployment, production access, installation outside workspace-local prerequisite
setup and extension activation remain separate. Required workspace-local setup
does not need another project approval, including in unattended mode. A missing
scope is retained as a specific blocker without opening a question in unattended
mode. Native permissions and user-selected limits remain.

Keep production credentials and publication permissions out of candidate
execution. CI uses read-only repository permissions and checkouts without
persistent credentials. Treat reports, logs and build artifacts as data; do not
execute downloaded scripts in the original client or a privileged publishing job.
Do not claim that a separate collector job makes candidate-produced results
unforgeable. Cache use is ordinary CI behavior, not an authority or release proof.

Prefer the owning-session skill's **CI-first delivery and live qualification**
route below. Reuse the existing pipeline rather than creating another dispatcher
or execution framework. Required check selection, actual job outcomes, source
identity and independent review still determine readiness.

`developmentTaskApprovalRequest` records task actions. Before push/PR creation,
require `ordinary-ci` for the actual repository/ref, checking both origin and
every effective push destination. `developmentExecutionAuthorization` checks
local execution by default; pass target `ci` to check the same grant's ordinary
hosted execution scope. A CI grant does not approve changed tools locally.
Sensitive/unclassified paths focus independent review rather than blanket human
sign-off. Legacy isolated-execution requests are rejected rather than reinterpreted.

## Scoped development approvals

Local authorization is separate from verification selection, independent review
and the original client's tool permissions. `scripts\development-policy.mjs`
is the shared decision/description module, not a sandbox or a source of consent.
An implementation request covers ordinary edits, existing local checks, agreed
repairs and required workspace-local prerequisite setup. A request for a local
commit or PR adds only its stated delivery scope; installation outside that setup
scope, runtime control, cloud operations and merging remain separate actions.

`developmentReviewRequirements` returns protected execution paths, sensitive review
paths and concrete reasons. Ordinary test scripts, routine business code, issue
templates and deployment-template edits are not human decisions merely because of
their directory. Executing a deployment template is a different action. Known
execution/acceptance inputs, agent instructions, dependencies/build configuration,
active hooks retain execution protection. Sensitive and unknown paths require
independent inspection rather than an invented low-risk label or blanket human
signature. `inspectDevelopmentPolicy`
reads actual input identities and exempts a package manifest's metadata-only change
only when complete original/current execution settings compare equal. Invalid,
missing or newly introduced manifests retain the dependency decision.
Standard `.github\copilot-instructions.md` and path-specific
`.github\instructions\*.instructions.md` are execution instructions, not ordinary
GitHub Markdown documentation.

Retain the actual requirements as source-bound `policyReview`: `requiresHumanReview`,
protected/review paths, reasons, input identities and source head/fingerprint,
alongside original-client decisions and the task grant. Use the trusted pre-edit
implementation, not candidate policy, for local authorization. Recompute this
record for the current source before publication; CI does not supply it.

Path classification screens code roles; it cannot prove the effects of arbitrary
programs. Before using task authorization, inspect changed commands, execution
sources, data access, network destinations and shared-resource effects. Newly
introduced effects or unresolved scope need a concrete decision, including when
the code is named a test. Use existing tools and locked dependencies only within
the authorized environment. This module does not grant an allow-all permission.

### Workspace-local prerequisites

Restore declared dependencies and install task-required tools in the worktree
without another project approval, including in unattended work. Do this after a
relevant dependency-manifest change or an actual missing-prerequisite failure,
not speculatively. Preserve lockfiles; use pinned, integrity-verified releases for
standalone tools. Installation destinations are workspace-local, such as
`node_modules`, `.tools` or a private virtual environment. Reuse configured
package-manager caches and keep task-specific environment changes command-scoped.

Inspect package sources and installer/lifecycle effects before running them.
An installation directory alone does not establish scope: global or user-profile
installation, administrator privileges, persistent PATH/system/shared settings,
Git hooks and extension activation retain separate authorization. Native tool
permission prompts remain enforced. This setup scope does not approve changed
dependency/build inputs, agent instructions or execution policy; their applicable
local execution/adoption decisions still apply. It does not authorize deployment,
runtime control, enrollment or publication.

### Approval requests

An approval request contains:

- **Action and reason:** what is newly requested and why existing scope is insufficient.
- **Target:** actual task, worktree/branch or external resource, not just a filename.
- **Effects and exclusions:** what happens after acceptance, including which delivery
  actions remain unauthorized.
- **Validity:** task, target, allowed effects and relevant input versions; identify
  changes since a prior decision instead of asking again about unchanged scope.
- **Summary:** the actual behavior change, impact and risks in plain language.
  Keep the full diff or original/proposed contents and command scope available
  on request; hashes identify those details but do not replace the explanation.

`formatDevelopmentApproval` requires a nonblank behavior summary unless full
details are explicitly requested. Use a plain-language description of the actual
behavioral change and the original client's question tool for the real user
decision. The default question shows the
summary and scope, not the full diff/contents. A user may approve that exact request
directly or ask to inspect its full details first. Retain the hash-validated
snapshot even when it is not displayed; the request remains bound to those exact
input versions. On demand, present that snapshot as immutable text using the
formatter's `showDetails` argument, then obtain an explicit approval or rejection
of the same request. Viewing details grants no authority. Local files are reference
copies, not an approval source, and Markdown fences cannot escape the snapshot
block. Independent review still inspects the full actual changes.
Retain the actual approval response in session evidence. A copied JSON file,
implementer assertion or AI review does not authenticate approval. GitHub's
separately configured required human reviews still apply; independent review
does not bypass repository rules.

For CI-first policy decisions, `scope.ci` names the exact GitHub repository and
the task's attached branch. It adds the reviewed workflow's hosted setup/checks,
including its PR merge ref, to the stated execution effects. The request identity
changes with that target; a local-only decision cannot satisfy it. Commit,
push/Draft PR creation, merge and deployment authority remain separately recorded.
Retain the actual original-client decision and compare its task, target, hooks
and input versions before reuse. A policy-bound manifest remains a review subject
when restored to the task base; pass those retained paths to policy inspection.
Ordinary source repairs need fresh evidence, not a new decision for unchanged
scope. Changed executable inputs or expanded effects need a decision showing the
delta. Rejection or cancellation is not permission to retry.

Readiness requires current source-bound verification, independent review and
every applicable actual decision. `requiresHumanReview` describes a requirement,
not a permanent stop after it is satisfied. Session records do not authenticate
consent or configure GitHub rulesets.

## Delivery targets and candidate preparation

An implementation request defaults to reviewed **working-tree changes**, without
commit or upload authority. A **local-commit** request stops at the verified
local candidate. **PR delivery** adds only the explicitly granted commit,
push, Draft PR, ordinary CI and ready actions; reuse a matching combined decision
rather than asking at every phase. A goal, mode switch, issue or agent-written
record is not that decision. Publication always needs the actual repository and
every effective push destination to match the grant.

Before the first edit, retain an explicit task base and actual workspace identity:
root, HEAD, resolved Git/common directories and branch. Equal Git directories
mean the primary checkout; a `.git` file or session label alone is insufficient.
Use the clean linked worktree in the owning session. A new task in a clean primary
checkout uses native `create_session` once; include an explicitly requested branch
or in-progress dependency. Preserve unrelated edits and resolve ownership or
failed inspection before changing workspaces. Follow-ups retain the original base,
even after commits or when local work becomes a publication request.

For working-tree delivery, freeze the intended tracked and non-ignored inputs
without committing. Verification and independent review bind that snapshot, not
a claimed final commit.

For authorized commit delivery, run permitted focused checks first. Confirm
separate commit authority and matching active hook inputs before invoking Git;
commit permission does not approve changed hooks, and disabling hooks is not a
substitute. Use existing `inspectWorktree`, `activeHookSnapshot`,
`captureCandidateImplementation`, `prepareCandidate` and `nativeCandidateCommand`
APIs to retain the exact native request/receipt. Keep the pre-edit trusted helper
copy stable when candidate control changes are destined for ordinary CI.
Include every intended file and test; preserve unrelated changes rather than
committing, moving or deleting them implicitly. Check again after hooks: require
a clean tracked and non-ignored working tree, then record `CANDIDATE_COMMIT`.
Create this candidate before final verification and independent review.
Keep `BASE_COMMIT` at the original task baseline; replacing it with candidate
HEAD could hide all task changes from selection.

A missing decision or unresolved dirty candidate pauses that delivery path.
The [CI-first route](#ci-first-delivery-and-live-qualification) permits an
authorized pending draft before the full gate, not a claim of acceptance.
If already verified working-tree evidence is to be reused, follow the explicit
[conversion route](#working-tree-evidence-to-an-authorized-candidate).
Otherwise verify the new candidate normally; an earlier working-tree report
cannot be converted by changing its source fields.

## CI-first delivery and live qualification

Use this route for authorized PR delivery, not as an implicit upload of a
working-tree-only task. Keep implementation, commits, GitHub operations and
recovery in the owning session. The existing CI workflow remains the executor;
there is no new scheduling service or registered workflow.

After approved focused local checks, freeze the native candidate with all intended
inputs and retain its request/receipt. Confirm a clean index/worktree, the original
task base, execution-policy consent for the CI target, and separate commit/push/PR
authorization. Push that candidate and create a **Draft PR**, explicitly
`ci-pending`. Full verification and independent review need not precede this
authorized pending draft. Missing execution consent still blocks CI-triggering
publication; a draft never supplies acceptance or merge authority.

The PR-triggered workflow runs the selected complete checks on its actual merge
ref. Prefer that single formal run over a full local gate followed by CI, or a
manual branch run followed by another PR run. Checks that require the user's
original client or host still need their explicitly authorized local evidence.
CI releases local CPU/memory but can still queue, spend runner minutes, prepare
dependencies or time out. Existing deadlines and required coverage are unchanged.

The same plan emits `ciMacos` for relevant shared/native infrastructure, its
regressions, CI policy and shared dependency changes; `--all` also selects it.
The ARM64 `macos-latest` job depends on that decision and reruns the existing
`native` tooling shard without provisioning an Android emulator. Its
`verification-macos-attempt-N` artifact is additional platform evidence, not
a replacement for the Windows native shard. Collection requires both a
successful selected Mac upstream and its current-source, Darwin/ARM64 report
with confirmed command cleanup. The CI envelope retains a bounded Mac report
projection and its original execution times, source and input-attempt digest.
Missing, failed, cancelled, unexpectedly skipped or wrong-platform coverage
cannot qualify; an unselected Mac job may skip. Live qualification also
preserves any Mac requirement from the original task base when the PR base is
narrower. Local unsharded verification still covers its current host, not every
CI platform. Device instrumentation and layouts remain on Ubuntu/KVM; this Mac
job does not claim the local HVF emulator path has been exercised.

Sealing and collecting CI evidence accepts fork PR heads for eligible checks,
while retaining the base-repository identity and exact merge-parent checks.
This lets documentation/tooling-only fork PRs reach their normal gate. It does
not enable device jobs for forks or relax live qualification's same-repository
restriction.

After **Required verification** succeeds, qualify it from the clean local
candidate, using its actual repository, PR and run identifiers:

```powershell
node scripts\verification-ci.mjs --qualify --repository OWNER/REPO `
  --pr PR_NUMBER --run RUN_ID --base BASE_COMMIT `
  --report .data\verification\CI_QUALIFIED\qualification.json
```

This read-only GitHub.com adapter uses the existing authenticated `gh` CLI; it
does not dispatch a run, push, open a PR, approve or merge anything. Every
invocation needs a new local destination. It checks the open same-repository PR,
candidate HEAD, run/attempt, real successful gate job and unexpired artifact.
The archive must match GitHub's authenticated SHA256 digest and contain only the
expected bounded JSON entries; it is read without extracting paths.

The requested `--report PATH` contains the qualification result. Its downloaded
ZIP and authenticated envelope are retained separately in `PATH.evidence`;
keep that sidecar with the result. Internal artifact names therefore cannot
collide with a requested filename such as `ci-report.json` or `ci-evidence.zip`.
CI output and collected-input directories use the same verification/CI/development
storage boundaries as local verification. CLI and direct qualification reject
retained-ledger destinations before writing or contacting GitHub; CI sealing and
collection cannot create input directories inside those ledgers either.
`run.json` remains reserved for ledger manifests, including in the CI CLI.
Collection also reserves the sibling `gate.json` for its raw aggregate; choose a
different `--collect --report` filename for the CI envelope. Collisions, including
Windows case aliases, are rejected before reading inputs or creating output.

The CI envelope retains the actual report, producer/run/attempt, candidate,
PR base, tested merge commit/tree, workflow revision and selected input receipts.
The tested commit must have the current PR base and candidate as its exact parents.
The qualifier reads the authenticated live base-branch ref before and after
validation: the PR API's `base.sha` snapshot can lag the branch tip. A changed
live base blocks qualification even when that snapshot still matches old CI;
the original CI envelope is never relabelled to the newer base.
Protected execution inputs must agree between the candidate, tested tree and
workflow revision. A changed base policy requires review/reconciliation rather
than silently trusting different executable inputs. The CI report must cover all
checks/layouts required by the original local task plan, even if its comparison
base differs from the task's retained baseline. Final live PR/run and local
source/index/branch/config checks refuse concurrent changes.

`kind: ci-qualification`, `status: verified` means **CI checks qualified**.
It is not independent review, a human decision or permission to publish ready work.
The local `candidate` and actual CI `tested` source remain separate: a PR merge
SHA or LF checkout fingerprint is never rewritten to look like execution on the
local branch/CRLF checkout. The referenced envelope and ZIP remain evidence
records; an editable qualification JSON is not an offline readiness credential.

When the qualifier's own execution inputs or test catalogue changed, keep the
approved local tools fixed. The owning-session skill may instead inspect
the same live GitHub facts with the original client's read-only Git/GitHub/archive
tools, without executing candidate policy locally. Retain a `ci-inspection`
record with the actual API responses, bounded authenticated archive, complete
report and local source/index/configuration snapshot. Check every relationship
above, including live base/merge parents, workflow and protected-input identity,
run attempt, successful gate, artifact digest and coverage from the original
task base. Inspect every required check's origin and selected platform/device
result; a successful gate label alone is insufficient.

This is an agent inspection, not a machine `ci-qualification`.
It never excuses failed, partial or unavailable evidence.
The independent reviewer must inspect those underlying records, not accept the
implementer's verdict. Repeat the same live read-only checks after review;
an unchecked or changed binding remains pending. This alternative is limited to
skill-led ordinary CI and does not add an executor or activate candidate control.

Give the configured independent reviewer the actual live qualification or inspection, CI envelope,
artifact digest, original task base, candidate/tested refs, actual PR diff and
scoped policy decisions. After its passing conclusion, repeat live qualification
or inspection into a new directory, without rerunning checks merely to compare identities.
Require the same source/ref/attempt bindings covered by the review before marking
the existing draft ready within the user's delivery authorization. Changed,
missing or incomplete evidence remains pending; do not create a duplicate PR or
turn old review/test records into a new source by editing their fields.

## Independent review and delivery freshness

Request final acceptance only after complete source-bound verification.
Use the configured read/search-only `devpocket-reviewer` in a separate context;
an unavailable agent or unestablished read-only profile is a specific setup/loading
blocker. Self-review does not replace it. Repair diagnosis may inspect incomplete
evidence when a concrete diagnostic question needs independent assessment;
that mode is not final acceptance.

Supply the fixed contract and non-goals, original base, delivery target, actual
diff and all added/untracked changed paths, current source identity, full
verification evidence, `policyReview` and actual user decisions. The reviewer
must inspect the files, not accept the implementation summary. For committed
delivery include the exact candidate SHA and clean index/worktree. For CI-first
delivery include the live qualification or documented inspection, underlying
API/archive/source records, envelope/digest, run attempt, candidate/tested merge
ref/base, actual PR diff and every execution origin. For converted evidence,
also include the immutable original run, native request/receipt and transition.

Request `verdict: pass | changes_requested | needs_human`, reviewed source
head/fingerprint, and findings with `severity: blocking | advisory`,
repository-relative `file`, `line`, `impact` and `reproduction`. Retain the agent's
actual conclusion. A `pass` with blockers, `changes_requested` without a blocker,
missing identity or inconsistent evidence is not valid acceptance.
An earlier working-tree verdict, execution consent or human approval is not
automatically a review of the final candidate.

Use the ordinary-CI trust model from this guide. Sensitive/unclassified paths
need inspection of actual effects, not blanket human signatures or an adversarial
sandbox. Execution authority and independent code review remain distinct; one
human decision satisfies both only when its stated scope covers both.

Repair blockers in the same task/workspace. Recheck execution scope before using
repaired control or hooks; reuse matching hosted scope, not old test/review results.
A source-changing repair requires fresh applicable verification and independent
review. Authorized candidate repairs use a new follow-up commit; amend only if
the user explicitly requests it. Follow Task-scoped autonomy for cycling, budgets
and cancellation, preserving earlier failures and attempted approaches.

After a passing review, compare identities without rerunning tests just for
comparison. **CI-first:** repeat live qualification or read-only inspection into
a new directory; require the same candidate, live PR base/tested ref, run attempt,
artifact and complete evidence covered by the review. **Local:** reaggregate:

```powershell
node scripts\verify.mjs --base BASE_COMMIT --combine `
  --input VERIFICATION_REPORT --report .data\verification\NEW_ID\reviewed.json
```

Require a complete passing aggregate whose source identity matches the review.
Converted reports also need `--candidate-evidence` and the same applicable tool
settings, as described in the conversion section. This authenticates neither an
AI verdict nor new human authority. Any edit or commit/ref change invalidates
mismatched evidence; obtain applicable new evidence/review rather than relabelling.
Recompute `policyReview` and recheck decisions, hooks, clean index/worktree and
HEAD at `CANDIDATE_COMMIT` before publishing.

Hand off the requested target, workspace, original base, exact candidate, evidence
paths and actual verdict. `ready` requires complete unchanged acceptance and all
applicable decisions; technical/evidence gaps are `blocked`, specific unresolved
product/authority decisions are `needs_human`. A satisfied requirement is not a
pending blocker merely because `requiresHumanReview` remains true.
Stop at reviewed edits or the local commit when that is the target. For PR delivery,
mark the same authorized draft ready only after freshness; do not create a duplicate.
Missing execution consent blocks CI-triggering publication; pending final review
blocks ready delivery, not an otherwise authorized pending draft.
An unchanged push does not invalidate local source evidence. Required remote CI
and checks of a different PR/merge ref still apply. Report an opened PR only after
creation succeeds. Merge, deployment, external installation and local control
adoption remain separately authorized.

## Verification

Run from the checkout with Node 26, npm 12.2.1 and PowerShell 7. The complete workflow
regression suite also needs Git with SSH signing support (`ssh-keygen` for
disposable signing fixtures), Python 3.12 (standard-library checks), the
root npm dependencies (including TypeScript/tsx), and, on Windows, the existing
owned-command compiler support. It uses synthetic toolchains, not an Android
SDK/JDK or emulator. Operational fixture checks additionally need the pinned
`deployment\azure\probe\requirements-test.txt` dependencies; use an isolated
environment rather than changing the machine's Python packages.

On macOS, the native command owner uses Python and Darwin responsibility scopes
instead of the Windows compiler. Each live scope remains responsible for its
detached descendants until cleanup; nested scopes register with their parent
before executing a target and must acknowledge cleanup. Signals use the kernel's
PID-version check. The supervisor preserves the inherited ownership link
separately from command-level environment overrides. Unstable process snapshots
are retried within the original command and cleanup deadlines; an exhausted
snapshot attempt is not a permanent failure if later observations stabilize.
Persistent uncertainty cannot qualify an empty-tree cleanup acknowledgement.
Inspection, signalling and nested acknowledgement failures remain failures.
Fork/exit and zombie transitions require a new observation; two stable empty
scans confirm completion. Nested cleanup failures are retained while the
supervisor attempts to stop all other verifiably owned processes.
The in-process emulator recovery dependency is included in both the captured
candidate/verification implementation and the verifier execution-policy fingerprint.
Unsupported native APIs, unbound parents or missing nested
cleanup remain failures, not plain process-group fallbacks. Control receipts
are per-command and are not supplied to the target process.
Failed target launches remain nonzero and emit their diagnostic before the
terminal cleanup receipt; confirmed cleanup does not make a failed command pass.

The complete local gate also supports macOS Android builds and native tests.
Apple Silicon selects the ARM64 API-37 image; Intel Macs select x86_64. Device
evidence retains macOS, host architecture and usable HVF acceleration, alongside
the existing source/APK identities, instrumentation cases and cleanup evidence.
The account-local emulator pool keeps its default single slot. After a native
controller crash, the surviving verifier can recover exactly that run's lease
using the in-memory, command-bound cleanup outcome from its native supervisor.
Recovery also requires a dead lease heartbeat and free ports. Serialized or
forged outcomes, another command/run and unconfirmed cleanup cannot recover a
lease. If the verifier itself is lost, missing process/port observations alone
still leave the lease blocked. macOS registry mutation uses a kernel-released
file lock whose open description stays with the controller, not a persistent
helper process. The version-2 registry prevents older socket-only writers from
mutating it. Migration holds both locks and requires an empty version-1 registry;
it preserves the configured limit and refuses retained leases/waiters or an
unknown legacy lock rather than removing them. A crash before migration commits
may therefore require inspection, while version-2 controller crashes release
the registry lock without discarding lease records.
Windows reclamation and the separate hosted
Linux/KVM path are unchanged. See
[macOS setup](../README.md#complete-local-verification-on-macos) for prerequisites.
Local macOS acceptance does not replace Windows/Linux-specific CI coverage.

Before executing changed verification or dependency policy, resolve the
applicable authority in Step 3 of `.github\skills\devpocket-development\SKILL.md`.
Local execution/adoption needs exact-input approval; ordinary CI uses the
recorded repository/branch-bound task grant. Active hooks and local control
adoption still require their applicable authority. Self-review or AI review cannot
create authority; the standalone verifier checks evidence, not consent.

### Local verification and acceptance

For local delivery or an explicitly selected local fallback, use the prerequisites
and execution-authority rules in [Verification](#verification), then:

```powershell
npm run verify -- -Base BASE_COMMIT -Plan
npm run verify -- -Base BASE_COMMIT
```

The base is explicit; it is not guessed from a branch name. Planning is not
acceptance. The source fingerprint includes tracked and non-ignored untracked
inputs, including deletions. Required checks come from the actual diff, not an
agent's risk label. The planner and `scripts\verification-policy.mjs` catalogue
are shared by local verification and CI. Each
selected check defines its group; `requiredGroups` is derived from those
definitions, never from "non-Android means backend."

Read the new report: require `status: passed`, `complete: true` and every required
check, platform/device result and per-shard execution origin. A plan, focused
check, build-only result, preflight or partial shard is not completed verification.
Retain the report path, original base, `source.head` and `source.fingerprint`.
Local candidate evidence must have `source.head === CANDIDATE_COMMIT`; CI uses
its separate qualification of the tested merge ref instead.
For cleanup-confirmed environment failures on unchanged source, use the explicit
recovery route below. For missing tools, use workspace-local prerequisite scope.
Unconfirmed owners and uncertain outcomes need inspection, not automatic retry.

### Responsibility-based impact

`scripts\verification-policy.mjs` contains the ordered impact rules and the
declarative `CHECKS` catalogue (`id` and `group`, not executable commands).
There is no per-PR exemption, diff-size heuristic or dynamic dependency graph.
The exact named script/instruction/regression paths are deliberate interfaces;
adding a new file does not silently inherit a tooling exemption.

| Responsibility | Representative inputs | Required checks |
| --- | --- | --- |
| Documentation | `README.md`, `VALIDATION.md`, `docs/**/*.md` | None |
| Development tooling | `development-paths.mjs`, `development-policy.mjs`, `candidate-commit.mjs`, `native-candidate.mjs`, `setup-xcode-mcp.mjs`, `config/xcode-mcp.example.json`, `test-workflow.mjs` | Complete `workflow-tests` in `tooling` |
| Agent instructions | `AGENTS.md`, the DevPocket skill/reviewer and AI task template | Complete `workflow-tests` |
| Source/verification contracts | Root `.gitignore`, `git-state.mjs`, `verification.mjs`, `verification-policy.mjs`, `verify.mjs`, `verify.ps1`; named diagnostic/evidence projections and workflow regressions | Complete `workflow-tests` |
| Backend execution/build | `verification-backend.mjs`, extension bundle/package helpers, CLI-proof launcher, backend TypeScript configs, extension distribution workflow | Tooling and backend checks; no Android provisioning |
| Native execution/build | `verification-android.mjs`, Android runner/build/emulator helpers, owned device cleanup, Gradle inputs/wrappers, native preparation action | Tooling, Android build, device cases and all layouts |
| Shared execution | `verification-executor.mjs`, `process.mjs`, `owned-command*`, bounded command logs, shared backend/native diagnostic preflight | Every check and layouts |
| Cross-lane infrastructure | `ci.yml`, root npm/lock inputs, shared or unclassified dependency policy | Every check and layouts |
| Operations | `deployment/`, `infra/`, `azure.yaml`, including their own npm/Python inputs | Backend and operational fixtures, not native execution |
| Unknown | Any path not classified by the preceding rules | Every check and layouts |

The shared backend diagnostics module is used both by backend execution and the
hosted native preparation's Linux process tests; it is not a backend-only input.
Root Node dependencies are shared with the native relay fixture. Android Gradle
inputs and device-specific cleanup, on the other hand, do not select backend
product checks just because they are protected policy.

The optional Xcode MCP initializer and its named template/regression are local
development tooling. Root `.gitignore` participates in source selection and is
covered by the workflow/source-identity contracts. The Xcode regression is a peer
in the explicit `test-workflow.mjs` list, not an import from another test file.
Root npm/lock changes (including changes to test script commands), unknown MCP files,
nested ignore files and mixed application changes still retain their existing
conservative coverage; there is no general MCP or dependency exemption.

Existing backend source, runtime integration, runtime-extension and wire/fixture
rules retain their downstream coverage. Runtime/wire changes (including the
schema generator) still require native compatibility evidence; Android product
changes require build and device checks, with layouts for UI/resource changes.
Named synthetic workflow tests run the whole existing suite, not a selected
subset. The separate Linux process regression belongs to hosted native
preparation and continues to select native execution.

### Verification modules and compatibility

`scripts\verification.mjs` retains `verificationPlan(root, base, all)`,
`executeVerification(root, plan, options)`, `combineVerification(plan, reports)`,
`verificationFailure`, `verificationFault` and `requirePlanCollection`, plus
the `git`/`readOnlyGit`/`sourceSnapshot` compatibility exports from `git-state.mjs`.
Planning and aggregation do not load the execution adapters. The execution
entry loads `verification-executor.mjs`, which owns sequencing, process
ownership, bounded logs, stopping after failure and the final source check.
The two concrete adapters own actual backend npm commands and native
PowerShell commands/arguments respectively, including diagnostic preparation
and device evidence/cleanup. No caller-supplied executable or plugin registry
is introduced. Keep actual command, timeout, build and device changes in these
execution modules, not in the tooling-classified facade or catalogue.

The source contract still returns `{ head, fingerprint }`. The fingerprint
uses tracked and non-ignored worktree bytes, indexed Git modes, link identity
and tracked deletions, without newline normalization or absolute checkout paths.
Staging identical bytes does not change it; a different HEAD is checked
separately, and an unmerged index refuses evidence. It is not a replacement for
a native candidate helper's separate index, tree, parent, branch and hook/config
freshness checks.
Read-only index probes use `readOnlyGit` (or `readOnlyGitArgs` when retaining
private-index/Trace2 context), which disables optional locks and fsmonitor for
that command only. Raw `git` remains available for unchanged configuration
evidence and authorized mutations; probe overrides do not rewrite user settings.

Mixed changes take the union; no narrow rule cancels another path's requirements.
`--all` explicitly selects every check. Plan JSON and CLI output include
`requiredChecks`, `requiredGroups`, `layouts`, and
`selectionReasons`: fixed rule descriptions, selected checks/groups and sorted
changed-path examples (at most 16 paths of 240 characters per rule, with
`omittedPaths` for unsampled/unsupported names). Omission affects explanations
only, not selection. Diagnostic projections rebuild fixed descriptions and
allow at most 16 current source-indexed path examples overall; raw/private log
fields cannot become explanation text.

The verifier reuses the commands in `package.json`. Android changes and affected
runtime/wire changes require JVM/build checks **and** native emulator evidence.
Protection is separate from impact selection. `scripts\development-policy.mjs`
owns `developmentReviewRequirements(changedFiles)`, actual-input inspection and
approval requests/presentation. The pure `scripts\development-paths.mjs` owns
`classifyDevelopmentPath` and `isVerificationPolicyPath`; the policy module
re-exports the latter for existing callers. CI qualification imports only that
classification interface, so it does not evaluate candidate approval code.
Both modules remain protected execution inputs, captured by the native helper
and included in the verifier execution fingerprint. Candidate/tested/workflow
tree identity checks still bind both; splitting the implementation is not an
authority exemption. The scoped approvals above replace directory-wide
script/backend stops, without changing any selected checks. Execution-core,
instruction and dependency/build authorization remains explicit. Sensitive
review paths focus independent review rather than a human signature.
Skill-led delivery retains source-bound `policyReview` requirements and actual scoped
decisions separately from test evidence. Satisfied requirements permit `ready`;
specific pending requirements yield `needs_human`. Missing local evidence is
never interpreted as approval.

CI planning, lane selection and aggregation do not decide Agent or GitHub
approval. GitHub merge review belongs to externally configured rulesets,
required reviews and CODEOWNERS, not a plan flag; these changes do not create or
modify that configuration. Local and hosted execution retain the applicable pre-execution
authority described above. A planner-only change selects contract
regressions; a cross-lane CI or shared-executor change selects full impact.
Neither bypasses the protected-policy stop. Targeted synthetic regressions
are not a completed source-bound gate or independent-review approval.

For CI shards, use `-Group tooling`, `-Group backend`, `-Group android` or
`-Group device` with a separate `-Report` for each. The tooling check remains
the **complete** `npm run test:workflow` suite. Its CI parts are derived from the
same explicit catalogue; individual parts never substitute for the whole check.
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
Verification reports are now **version 5**. Every directly executed passing check
requires its actual `execution.source`, `startedAt` and `completedAt`. A complete
tooling aggregate instead carries `execution.kind: tooling-shards` and every
part's original execution. It does not invent one full-suite start/end interval.
Aggregates preserve these fields through subsequent aggregation. Removing origins,
reversing timestamps or changing only an aggregate's HEAD cannot qualify.
`requiredGroups` must match the catalogue and there is no `requiresHumanReview`
decision. Version-1/2/3/4 reports, absent origin/group policy and reports that place
`workflow-tests` in backend cannot qualify; rerun rather than relabel old evidence.
Non-acceptance diagnostic exporters still read historical versions: version 1
retains its backend workflow-test group, versions 2/3 retain tooling, and version
3 retains its selection explanations. Historical check selections remain intact.
Version 4 retains its historical direct execution origins for diagnostics.
An old version-1/2 review flag is projected only under
`legacyAgentReview`, with `approval: "not-established"` even when the old flag
was false. Current diagnostics ignore injected review/approval fields.
Device/startup evidence formats are unchanged. A required check
that did not run is never equivalent to passing. Schema generation that changes
source also invalidates that run; review the generated change and verify again.
Detailed logs remain private in ignored run directories. Share only the
allowlisted machine reports and explicitly selected candidate artifacts.
Report destinations must be new files beneath `.data\verification` or `.data\ci`;
existing reports and sealed/operational evidence cannot be overwritten.

### Host-wide local admission

Updated verifier entrypoints share one heavy-execution slot per OS user across
worktrees. The registry is under
`%LOCALAPPDATA%\DevPocket\verification\admission` on Windows and
`~/.cache/DevPocket/verification/admission` on other supported hosts. It is runtime
state, not a changed Git/system setting. A live IPC owner and private inherited
ticket let owned nested verifier fixtures share the parent's allocation without
deadlocking it; a borrowed ticket cannot release the parent.

Host capacity follows confirmed process-tree shutdown, independently of device
file cleanup. A failed or unconfirmed device-data cleanup keeps that workspace's
ownership lock and run unqualified, but does not reserve host capacity once all
owned processes and probes are confirmed stopped. Missing process-cleanup proof
still retains the host owner; a file-cleanup failure is never changed into
successful verification or permission to resume.

Queue waiting is reported separately as `admission.waitedMs`; command deadlines
start only when their actual execution begins. Cancellation while waiting does
not run a check or release another owner. A stale, damaged or unconfirmed owner
is an explicit stop, not automatic PID-based takeover. Inspect its retained
`owner.json` and resource cleanup before any operator recovery. This scheduling
record never grants runtime permission or resolves a workspace's interrupted
verification evidence.

An ordinary waiter may rediscover the slot after an interrupted IPC reply only
when the owner record is gone, or when a completed probe and the subsequent
record read observe different owners. These handoff retries are bounded; the
next live response must match its ownership record. Retained/corrupt records,
malformed complete responses and unverifiable owners still block. An inherited
ticket cannot transfer to a replacement owner or retry through a lost probe.

Admission is cooperative: old loaded verifiers, direct focused commands and
unrelated programs do not participate. No other workload is terminated or
reconfigured. Hosted CI jobs already run on separate machines; this slot also
keeps nested execution in each job within its owning allocation.

### Selected-group preflight and explicit recovery

Declared npm workspaces use bounded, literal repository-relative paths; globs,
external paths, redirected workspace directories and undeclared directory links
are not accepted. Workspace package identities and dependency maps must agree
with the lockfile and the installed links. Their implementation bytes are hashed
separately from installed third-party packages. A declared `dist` output is
excluded from the workspace input tree only because backend/native artifact
qualification binds that generated directory separately. Other directory links
remain rejected. This support does not reduce selected checks, grant dependency
execution consent or substitute for the task's source fingerprint.

Every execution first checks the groups selected by the planner and `--group`.
The read-only probes cover Node 26, PowerShell 7 and command ownership; selected
Node checks also inspect npm, declared installed dependencies and effective npm
configuration. Tooling adds Git/SSH and standard-library Python prerequisites,
not Java, an Android SDK, an emulator or operational Python packages. Backend
operational entries additionally inspect their own npm/Python dependencies.
Python version and pinned-package checks use explicit error paths, so
`PYTHONOPTIMIZE` cannot remove them.
Native entries inspect their selected JDK, platform/build tools, existing
license, wrapper and writable output/cache paths; device entries add the
installed image, ADB, emulator and acceleration. No dependency installation,
license acceptance, cache reset, Git/config change or real Copilot runtime
startup is a preflight operation. The existing owned-command helper may prepare
its source-bound local executable cache.

Independent checks continue after an unrelated failure: missing PowerShell or
root dependencies no longer hide the selected Python/Git/SSH requirements.
The version-1 preflight report retains actual failures in `issues` and adds
`notProbed` entries with a prerequisite name and its `blockedBy` dependencies.
An unrun probe is neither passed nor a confirmed missing tool. npm discovery
needs Node and PowerShell, not installed project dependencies; compiler-input
probing also needs the dependency and launcher checks. All executable probes
need command ownership. Unconfirmed process cleanup prevents later commands,
including in other selected groups, while independent file inspections continue.
Blocked groups have no reusable environment fingerprint. Existing failure,
terminal qualification and recovery invalidation rules apply to the whole group.

Android-build qualification also binds the portable renderer's installed Node
dependencies and npm/environment inputs. The Gradle task's actual `npm.cmd`
lookup (including the working directory) and CMD interpreter are bound separately
to the recognized adjacent npm implementation and prefix result.
An unknown native launcher cannot supply reusable evidence even if a different
PowerShell launcher looks familiar; discovery does not execute a project-local
shadow merely to identify it. Ignored dependency or npm configuration
changes invalidate a previously qualified native result. Local npm configuration
uses the physical checkout root for its identity, so equivalent checkout aliases
agree without hiding changes to the configuration bytes.
Native groups with declared workspaces deliberately do not reuse prior results:
workspace lifecycle PATH entries, intermediate package resolution and compiler
inputs do not yet have a closed applicability contract. Fresh checks remain
required even when source and generated artifacts are unchanged. `ESBUILD_*`
overrides are also included in Node environment identity and disable reuse.

The SDK preparation script writes local `package.xml` records from the selected
repository metadata only when the installed `source.properties` revision matches.
It preserves existing matching package records and already accepted license
files; it does not accept licenses. Native preflight requires platform/build-tool
metadata before executing a build. This prevents the SDK's legacy loader from
creating package records during a first build and invalidating that run's inputs.

Hosted Ubuntu's JDK cache is an alias to an installed JDK whose trust store can
live outside that directory. Native CI prepares a job-local JDK copy in
`RUNNER_TEMP` and materializes its selected `lib/security/cacerts` there, without
changing the original JDK, trust store or Java version. Other links stay subject
to the unchanged bounded-tree preflight rules; they are not blindly dereferenced.

Emulator probe identity uses an unambiguous usable-acceleration description and
validated version, not incidental log prefixes, process IDs or crash-log paths.
The executable and complete installation tree remain content-hashed. Missing,
unsupported or conflicting probe facts still block before device execution.

An emulator applicability failure also retains bounded input-difference
diagnostics: changed fact digests and up to 32 relative installation-file names,
sizes, modes and hashes. Unsafe or credential-shaped names are represented only
by a path hash; absolute paths, link targets and file contents are not published.
These observations come from the same guarded reads as the acceptance identity.
They never qualify a blocked run or suppress a changed input.

A failed final prerequisite probe is `environment-unconfirmed`, retaining its
original bounded failure (including the exit code); it is not evidence that a
file hash changed. Only a completed probe with a different identity reports
`environment-changed`. Both outcomes block qualification and reuse.

Preflight failures identify a fixed prerequisite and safe diagnostic reason
before any expensive selected check starts. A passing preflight is not
acceptance: later downloads, fixtures, device execution, artifact validation and
owned cleanup can still fail. The executor rechecks successful groups'
environment identities before qualifying the attempt. Environment fingerprints
include applicable versions/executables, installed Node package bytes, npm and
Gradle configuration, Python packages where required, JDK/SDK inputs and image
file identities. Toolchain, image and package/artifact bytes are hashed with
their modes and bounded link identities; inode/timestamps guard each read but do
not invalidate identical input bytes between reads. Selected native groups
therefore read their large installed images as well; tooling-only checks do not.
Per-prerequisite digests locate observed drift without exposing configuration
values or private paths, and a changed prerequisite still blocks qualification.
The execution identity also binds the canonical tooling entry, shard/admission
and CI helpers, including the shared path classifier and development policy. This is local applicability
evidence, not protection from an administrator able to alter the verifier and
its private storage together.

Unbound Node/TypeScript, Python or Java startup paths, custom npm script shells
and Gradle initialization hooks disable reuse for the affected groups. JVM
arguments supplied in project or cache properties also disable native reuse
unless every argument is an explicitly recognized memory/UTF-8 flag. An external
`-javaagent`, native agent, custom class path or unknown JVM switch cannot inherit
a prior success just because the properties text is unchanged. Source
links also disable reuse: the Git link identity does not bind an external target.
Commands can still execute normally; an unchanged option string is not proof
that an external preload or init script's bytes stayed unchanged.
Native preflight binds ignored SDK/JVM properties too, refusing conflicting
overrides or unsupported daemon-JVM criteria instead of inspecting the wrong
toolchain. Environment-provided `ORG_GRADLE_PROJECT_*` values are hashed into
native applicability without exposing their contents; changing them cannot reuse
an APK built with different effective project properties. Successful native groups
retain hashes of all regular files in their Gradle wrapper distributions and
dependency caches alongside the APKs, including AAR archives, transformed
resources and extensionless inputs. A filename or extension does not establish
that an input is irrelevant: cache bookkeeping changes conservatively invalidate
reuse too. Linked/special files and oversized inventories block binding rather
than yielding a partial identity. Cleaned, disposable hosted
device caches cannot seed native reuse. Small immutable-file reads are bounded
in batches without omitting checks. Tooling has a 60-minute watchdog; backend,
native build and device commands retain their 30-minute deadlines.
A late result is still a timeout,
and neither a timeout nor a passing subset qualifies acceptance.

The regression suite tests data contracts through the same planner, signed-ledger
and evidence-validation functions used by the verifier. Corrupt-record and
qualification matrices use explicitly synthetic reports in disposable repositories,
not a fresh expensive verification run merely to create input data. They are not
application acceptance evidence. Representative CLI failures and real end-to-end
recovery/conversion retain their actual commands and execution-count assertions;
native startup, hooks, signing, index, source-change and cleanup cases still use
real processes. Test scheduling and required check selection are unchanged.
Per-path impact matrices call the production classifier directly instead of
creating a repository and CLI process for every name. Representative CLI plans,
public projections and raw Git-state cases still exercise those boundaries.
Compiler/shim recognition tests use a genuine control and reject both altered
forms at the production preflight boundary without executing their payloads.
Real candidate conversion, commit-sensitive commands, npm-prefix and Windows
launcher cases retain end-to-end coverage of qualification consumption and native
execution; recognition alone does not need another complete candidate lifecycle.
Environment/artifact decision matrices exercise signed record, terminal
qualification and reopening directly, including adoption of the new environment
checkpoint. Real preflight still checks TZ changes and unrelated-side isolation;
the copied-policy refusal still uses the CLI after proving the copy matches its
seed. Actual environment-drift and candidate-artifact recovery cases retain their
process execution and command-count assertions.
Dependency discovery uses directory entries instead of a redundant sequential
metadata query for every ordinary file; each file still receives the same opened
descriptor, identity, before/after metadata and content-hash checks.

The report prints a `run.json` path. Use that exact run, the original base,
selection flags and a **new** report directory:

```powershell
npm run verify -- -Base BASE_COMMIT -Resume .data\verification\FIRST\run\run.json `
  -Report .data\verification\RETRY\report.json
```

Run format **2** is separate from verification report version **5**. Each
attempt writes new start, group and finish receipts; original reports, logs,
execution HEAD/fingerprint/timestamps and failures remain unchanged. A successful
group is recorded directly when its commands finish, not extracted by rewriting
a failed report as `partial`. Recovery validates the original base, source,
required checks/groups/layouts, execution policy, diagnostics mode and applicable
environment/artifact identities. It reuses only complete successful groups.
Changed environment or missing artifacts explicitly invalidate the affected
groups; source, base, scope or policy changes require a new run. A failed group
reruns in full, including its earlier successful checks. There is no automatic
retry loop, permission-denial retry or external wait/wake mechanism.
The terminal receipt records which complete groups passed their post-execution
environment check. A successful command without that qualification is permanently
invalidated for reuse in that run, even if earlier environment bytes are restored.
Unaffected qualified groups remain reusable; the affected group must execute again.
An initial preflight failure or observed fingerprint change also invalidates
that group's earlier receipt when no check ran in the new attempt. Restoring
the old inputs cannot erase this recorded observation. Cancellation after a
command finishes but before terminal qualification blocks partial groups and
tooling shards as well as complete runs; their passed checks cannot be aggregated
as qualified results.
Version-1 runs without this terminal qualification cannot resume or seed candidate
conversion; keep them as history and start a new run rather than adding fields.

Receipts are locally authenticated with an ignored checkout-local key at
`.data\verification\local\receipt.key`; never upload or copy that key. Imported
reports, older runs without receipts, missing/corrupt records and altered
signatures cannot seed recovery. Reports remain portable for ordinary CI
aggregation, but recovery is deliberately not portable between checkouts.
An authenticated private run tip detects missing/truncated attempt history;
only that control index advances atomically, never the original evidence.
Paths must remain under the owning checkout's verification/CI/development
storage, without linked parents; readers never execute paths from a record.
Each storage root itself is a valid run directory, not just its descendants.
CLI report destinations remain limited to verification/CI storage; historical
development storage remains recognized for retained records, not as an additional CLI destination.
Report/output directories cannot be a retained ledger directory or anything
beneath it. The pure CLI path guard checks this before creating directories or
opening a report, including planning/aggregation; direct execution and run APIs
apply the same guard before acquiring ownership or writing attempt records.
`run.json` is reserved for ledger manifests, not a CLI report filename. Invalid
destinations produce an explicit entry error without adding files to old evidence.
The `.data\verification\local` control directory is reserved too, including its
descendants and an attempt to use the directory path itself as a report filename.
Only the internal key, lock and run-tip operations write there. Report/directory
guards reject these targets before creating files, so a planned report cannot
poison a future lock or signing key. Windows trailing-dot/space components and
alternate-data-stream syntax are refused rather than resolving to a protected
name; existing parent directories must retain their canonical identity.
A supported checkout-root alias resolves to the same physical storage owner;
links inside evidence storage still fail closed, and native workspace identity
continues to retain the caller's original checkout path.
One exclusive `.data\verification\local\execution.lock` protects shared outputs
in this worktree. Another attempt is refused, not queued or silently taken over.
If the owner was killed, inspect its exact process family, original logs and
owned device cleanup before an operator removes the specific stale lock.
An attempt missing its terminal receipt or confirmed cleanup is not resumable;
after inspection, start a new run rather than manufacturing a finish receipt.
Process-tree termination alone does not prove device-data cleanup: an unknown
or failed owned-data cleanup retains the lock and records a non-resumable finish.
Gracefully cancelled attempts require both cleanup confirmations before explicit
recovery.

`--plan` still performs no execution/preflight; `--group` still returns a
partial shard unless it covers all required checks. Ordinary `--combine` still
rejects failed reports, missing checks, source mismatches and conflicting
evidence. A partial shard or preflight result never completes the final gate.
Resuming verification neither supplies independent review nor authorizes publication.

### Working-tree evidence to an authorized candidate

Use `--promote` only after a complete passing working-tree run in a linked
worktree and a separately authorized candidate commit. This is one direct
parent-to-child conversion, not a cache across arbitrary commits. The existing
native candidate helper must produce the commit through the original session's
native permission pipeline. Its new optional, locally authenticated receipt
binds the approved request bytes and completed candidate result; older unsigned,
missing, blocked or uncertain commit receipts cannot qualify conversion.
Neither the receipt nor the verifier grants commit authority or human approval.
When a local verification key exists, the native path validates and snapshots
it before any Git mutation. A truncated or unreadable key therefore cannot
advance HEAD and then turn a successful commit into a failed-commit receipt.
Proof generation uses that snapshot, not a fallible post-commit key read. If a
hook changes the key, the committed outcome is retained but its old-key proof
cannot validate against the changed store. Missing keys preserve the existing
unsigned-commit path; those receipts still cannot qualify promotion.

For skill-led delivery, retain the run's signed `promotionContext` and use the
existing `prepareCandidate`, `captureCandidateImplementation` and
`nativeCandidateCommand` APIs. Prepare the request with the verified workspace
snapshot, exact `changedPaths(root, oldHead)`, original session ID, task goal and
unchanged hook snapshot. Write that request once beneath this task's
`.data\verification` or `.data\development` directory. Execute the returned
hash-bound native command only after commit/hook authorization, require the
native tool's successful result and retain `REQUEST.json.result.json`.
This reuses the existing candidate staging, index lock, reference-transaction,
hook-exit, signature/config and closed-loader protections; plain `git commit`
without that receipt is not a conversion proof.

```powershell
npm run verify -- -Base BASE_COMMIT `
  -Promote .data\verification\WORKTREE\run\run.json `
  -CandidateRequest .data\verification\CANDIDATE\request.json `
  -Report .data\verification\QUALIFIED\report.json
```

The converter checks the original base, exact one-commit ancestry, unchanged
branch/config/hooks and captured implementation, request/receipt signature,
clean final index/worktree and actual candidate tree. The complete verified
execution inventory still compares byte-for-byte with the post-commit worktree,
including modes, links and added/deleted inputs. A separate captured
`commitSourceProjection` binds effective Git text attributes/configuration to
the allowed stored blob representation. Supported `core.autocrlf` and text/eol
rules can account for CRLF-to-LF storage conversion without rewriting the raw
execution fingerprint. Automatic conversion is limited to unambiguous UTF-8
text; binary/ambiguous inputs remain byte-exact.

Projection collection reads attributes but never invokes clean filters. Effective
filter, encoding, ident or legacy crlf attributes are explicitly unsupported.
Any different bytes beyond the proved text transformation, changed effective
policy, modes/links, partial commit, extra history or changed hooks refuses reuse.
Transition version 2 requires this captured projection; older proofs are not
upgraded. Equality of displayed text, `git diff` or a single fingerprint remains
insufficient.
Ordinary verification also supports primary and detached linked checkouts:
their reports explicitly mark candidate conversion unavailable. Unsupported
candidate-only hook/index inspection does not silently approve conversion or
prevent otherwise valid ordinary verification.
A dangling hook link likewise disables conversion eligibility and retains its
`ENOENT` diagnostic without blocking otherwise valid ordinary verification.
Native candidate preparation and promotion still reject unavailable hook snapshots.

Only explicitly proven content-only command contracts can reuse execution.
Initially this is `typecheck` under the recognized Windows/default-npm launcher:
the fixed command, TypeScript compiler implementation, npm shim, package metadata
and two configuration files must match inspected content, without pre/post hooks,
shadowing executables or injected startup options. Read-only `--listFilesOnly`
probes must resolve every compilation input to the verified source inventory or
the fingerprinted local dependency tree. Version strings and unchanged custom
shim bytes do not establish HEAD independence.
The npm launcher and entire npm implementation are also attested against the
inspected Windows npm 11.16.0 distribution. The verified adjacent prefix helper
is queried with its colocated trusted Node executable; if it would redirect the
genuine launcher to a different prefix package, reuse is disabled. The verifier
does not confuse an attested adjacent package with the effective implementation.
Custom wrappers, altered npm code, unknown launcher locations, startup injection
and unproven prefix redirection disable both same-source group reuse and candidate
typecheck reuse. They do not qualify merely by reporting a version or keeping
configuration strings unchanged. Such environments can still run fresh checks;
the verifier neither installs a different npm nor rewrites prefix configuration.
Other platforms, changed compilers/configuration, unresolved inputs and unknown
launchers rerun normally. Backend builds/schema generation, workflow regressions,
backend/operational tests, packaging, Android JVM tests/lint and device checks
remain conservatively unproven or commit-sensitive and rerun.
The original selected checks are never reduced. Current environment and retained
build artifacts must also qualify; changing those reruns the applicable checks.
Extending the content-only contracts is an execution-policy change requiring
fresh human approval and regression evidence, not an automatic classifier.

On Windows, preflight separately resolves native Node lookup (COM before EXE)
and npm's default CMD lookup (the actual `PATHEXT` order). Both use the verification
directory for relative PATH entries, recognize quoted entries and account for
current-directory search suppression. The selected executables and search
environment are bound; an unrecognized `node.com`, batch launcher or other
selected Node path disables both reuse routes, even if its version is unchanged.
PowerShell's external-script precedence is also bound in the Node environment:
an earlier `node.ps1` cannot hide behind a later executable seen by CMD or native
lookup. Discovery fingerprints an unknown script without executing it, and its
presence disables reuse while ordinary authorized execution remains available.
The selected locator, physical target and invocation kind remain distinct:
resolving a script/batch alias to the Node executable does not turn it into a
direct executable launch. Such aliases cannot seed reuse and are not executed
as version probes. Classification tests use real PowerShell discovery and a
narrow simulated alias resolution, not a claimed OS-level alias execution test.
Ambiguous PATH syntax or an unavailable selected command blocks preflight rather
than silently attesting a later executable. These probes do not modify PATH,
PATHEXT or operating-system configuration.

The resulting report's `source` is the candidate being qualified. A reused
check retains its actual old `execution.source`, start/end time and command
result, with an explicit `candidateReuse` reference. `transition` links the
immutable old run and native request. It says that **old execution qualifies
for this candidate**, not that the check executed on the new HEAD. A failed
candidate attempt can subsequently use `--resume` on its own new run; its proof
is revalidated before further reuse.

Ordinary aggregation rejects conversion fields and missing/mismatched execution
origins, including origin-less historical aggregates. Explicit conversion
validation compares reused checks with authenticated originals without removing
or substituting their execution sources.
After independent review of the final candidate, explicitly revalidate a
converted report using its local receipts and the same applicable tool settings:

```powershell
node scripts\verify.mjs --base BASE_COMMIT --combine --candidate-evidence `
  --input .data\verification\QUALIFIED\report.json `
  --report .data\verification\REVIEWED\report.json
```

This reads the signed terminal report, validates the conversion and current
applicability, and checks full coverage without rerunning test commands. It
does not authenticate an AI review. The reviewer must issue an actual conclusion
for the final candidate, examining the transition, rerun checks and applicability
of its earlier findings; changing an old review's HEAD is never a new review.
Human policy review, runtime permissions, push/PR authority and remote CI remain
independent. CI does not receive the private local receipt key and continues to
execute its selected lanes and aggregate their ordinary reports.

Controller and publication consumers import local authorization helpers from
`scripts\development-policy.mjs`; pure protected-path checks can import
`scripts\development-paths.mjs`. The policy module retains its compatible
`isVerificationPolicyPath` re-export. The former exports
from the verification modules are removed, so an unmigrated named import fails
explicitly rather than silently dropping protection. Replace reads of
`plan.requiresHumanReview` in **both** final-status and publication-freshness
guards with `developmentReviewRequirements(plan.changedFiles)`, retain the
decision with the exact source identity, and reject missing/stale local evidence.
Current consumers also inspect actual inputs and match the scoped native decisions;
a true requirement is resolved by its applicable human decision, not by changing
the requirement to false or copying an approval flag into a CI report.
Changing imports alone is not sufficient. This migration does not grant commit
or publication authority, replace recorded human decisions, or weaken candidate
identity, hook approval, independent review or source-bound evidence checks.

### Tooling regression scheduling

`npm run test:workflow` remains the complete default regression gate. Its dedicated
entry, `scripts/test-workflow.mjs`, exports the explicit `WORKFLOW_TEST_FILES`
catalogue and passes that full list to a child `node --test` invocation. Tests and
CI contracts read the same catalogue rather than parse a package script. The
impact policy independently names the approved tooling paths; unknown tests and
runner lookalikes still require all checks.
The command, `workflow-tests` check ID, catalogue exports and shard IDs remain
compatible verification interfaces; none registers or launches a Dynamic Workflow.

For lightweight approval-contract feedback, run:

```powershell
node --test scripts/tests/development-approval.test.mjs
```

This pure Node entry covers path policy, approval summaries/details, invalid
summaries, native decision identity and task/CI authority without Git repositories,
signing, hooks, PowerShell or candidate execution fixtures. It is a peer in
`WORKFLOW_TEST_FILES`, in the existing `candidate` shard beside
`development-tools.test.mjs`. The latter retains filesystem, Git, signing, hook,
candidate and documentation contracts. Every old and new test remains in
`npm run test:workflow` and Required verification. The fast entry is focused
feedback, never a replacement for that complete gate or local execution authority.

The tooling command has a 60-minute watchdog for both the complete entry and
each formal shard. The expanded candidate suite can exceed the former
30-minute bound on local Windows hosts even without assertion failures.
Backend and native command deadlines remain unchanged at 30 minutes.
This is a per-command bound, not a task budget or permission to skip scenarios;
queue waiting stays separate and cancellation still requires owned cleanup.

`WORKFLOW_TEST_SHARDS` is derived from that catalogue, not a second list. CI runs
the candidate, verification, diagnostics and native parts independently with
`--tooling-shard PART` on the verifier. The verifier calls the same npm entry with
`--workflow-shard PART`; this mode rejects additional filters. The canonical
runner identity and catalogue are bound, and unknown startup/lifecycle settings
cannot qualify formal shard execution. A replacement package script does not
become a complete CI tooling gate.

Each part reports `partial`, including on a tooling-only plan. Aggregation needs
every exact part once, with matching source, base, catalogue and execution origins.
Missing, failed, duplicated or mismatched parts block `workflow-tests`. Parts
cannot seed a successful local group receipt; normal full-group recovery keeps
its positive terminal qualification rule. The CI matrix disables fail-fast so
one failure does not discard unrelated successful jobs.

Each listed file runs in its own process with Node's default file concurrency.
The wrapper adds no concurrency, isolation, reporter or filtering flags by default,
inherits standard input/output/error, propagates exit codes and termination signals,
and reports launch failures as failures. Node test options can be passed after
`npm run test:workflow --`; filtered runs are focused feedback, not the complete
verification gate. No test-directory glob is used: extension packaging and the
separate Linux process regression remain outside this list. Xcode setup is an
ordinary peer entry, with fixture environment restoration asserted in that file.

Within `scripts\tests\development-tools.test.mjs`, selected scenario groups use
Node's built-in test scheduler with a fixed limit of **two** subtests. Each
such subtest creates and cleans up its own temporary repository and linked
worktree; all scheduled subtests are awaited. This overlaps independent
Git/PowerShell work without replacing native execution or sharing a candidate,
index, hook directory, receipt or verification result.

Top-level tests within each file remain serial. Scenarios sharing a fixture and
tests that write `process.env` (filesystem-monitor configuration and optional-lock probes) remain
serial too. Do not enable file-wide concurrency or apply the subtest option to
a shared-state group. Shared-tool assertions and command deadlines remain in
force; only retired orchestration scenarios were removed. The default entry and
responsibility-based selection remain; there is no fast-only gate or cross-source
acceptance cache.

Measure the complete entry on the same machine and toolchain, retaining its exit
status, total elapsed time and per-test output. Compare completed scenario names
and counts as well as duration; summing concurrent child durations is not wall
time. Keep failed attempts visible, and use a fresh source-bound `npm run verify`
report for final acceptance rather than treating benchmark output as verification.

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
- `native-platform-diagnostics-attempt-N`: the protected fixed-suite report, retained separately for each CI attempt.
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

The clean-release packaging regression separately records a fixed
`install`/`build`/`prune` stage and an allowlisted failure code for its npm child.
On backend failure, CI emits only distinct stage/code pairs from the bounded
private Azure-test log; missing markers are explicitly unavailable. Raw child
output remains private, and the original test failure and cleanup requirements
are unchanged.
The fixture owns a fresh npm cache: it first requires an uncached offline install
to fail, then restores the locked dependencies with lifecycle scripts disabled.
It repeats the offline clean install before building and pruning the standalone
runtime. This does not rely on, clear or change the runner's shared cache; only
the fixture's child processes use its temporary cache, and their original
deadlines and confirmed-cleanup requirements still apply.
The runtime fixture deliberately uses an owned directory alias. Within the
controlled Node probe, the resolved module must be the exact owned `dist/spec.js`
file: both regular-file observations require matching device and nonzero inode
identities. A second probe must reject a different file containing identical
bytes. URL spelling or a matching directory suffix cannot establish ownership.
Only the probe's own module resolver selects its observed file; stdout never
selects a filesystem lookup. Its private result has only the URL and an exact
boolean identity result; paths and identifiers are not published.
If the identity comparison fails, a `resolve` diagnostic classifies only case
differences, installed-package/workspace path suffixes, other file URLs or
non-URL output. These fixed categories do not disclose the child output or
assertion operands, perform no lookup of its path, and never establish runtime
ownership or replace the failing assertion.

The workflow suite's schema newline regression compiles the actual portable
contract in its own isolated package fixture. It verifies the missing-export
failure before compilation and then compares the regenerated schema bytes;
parent-worktree build outputs cannot satisfy that prerequisite.

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
exporter and CI artifact wiring require the applicable execution authority
before running the changed verification policy.

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
JDK 21/25, SDK platform 37.2/build-tools 37.0.0, platform-tools, and an installed x86_64
system image. Licenses must already be accepted by the operator. The runner does
not install tools, silently accept terms or change host virtualization settings.
Explicit setup can use `scripts\prepare-android.ps1 -Emulator`; this downloads
checksum-verified tools and the API-37 image into `.tools`, reusing an already
accepted SDK license. Hosted Linux CI setup is described below and does not
change this local Windows installation.

Set process/runner environment variables to the provisioned paths:

- `DEVPOCKET_JDK`: JDK directory.
- `DEVPOCKET_ANDROID_SDK`: SDK containing platform 37.2/build-tools 37.0.0.
- `DEVPOCKET_ANDROID_IMAGE`: relative system-image directory, normally
  `system-images\android-37.0\google_apis\x86_64`.
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
The job selects Node 26, npm 12.2.1 and Temurin JDK 25 and uses the image's PowerShell 7,
Python 3 and Android command-line tools. The
[runner image inventory](https://github.com/actions/runner-images/blob/8197087fc536320d1441203fdb5da9ae1b44b863/images/ubuntu/Ubuntu2404-Readme.md)
is a snapshot, not proof of any future job's installed versions.

Setup requires `/dev/kvm` and a GitHub-hosted runner. An invocation-specific udev
rule keeps that device owned by the job's UID with mode `0600` across add/change
events, instead of relying on a one-time ACL that can disappear during the run.
The rule is applied before verification and disappears with the disposable VM.
Setup does not grant world access, modify local developer virtualization or
install a self-hosted runner. Failed post-run access is never silently repaired
by the verifier or accepted as a successful environment check.
`sdkmanager --channel=0` installs the required stable platform/build tools,
emulator and API-37 Google APIs x86_64 image into the disposable VM's existing
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

Add `-Visible` for an interactive emulator window. This is an explicit manual
opt-in; automated checks and omitted switches remain headless. Port leases,
private AVD/ADB data, live ownership checks and scoped shutdown are unchanged.
Use `-Sdk`, `-Jdk` and `-Image` to select existing shared tools without copying
or updating them.

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
Project toolchains use Node 26, npm 12.2.1, Temurin JDK 25 and Python 3.12. The Windows
Android job passes its explicit project-local SDK; the Linux device job passes
the explicit hosted SDK path after the required stable packages are available.

The upload keeps explicit file lists and archived, non-overwriting behavior.
Names include the run attempt, preserving earlier failed reports. Each producer
adds a `ci-report.json` envelope without rewriting its raw `report.json`.
The downloader retains separate artifact directories when multiple artifacts
match; the collector also handles a single archive extracted into the destination. Keep
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

The always-run **Required verification** job depends on plan and all
four lanes, downloads `verification-*` artifacts, and gives every lane's
actual outcome to the source-bound CI collector. It selects the newest attempt
for each required producer unit, validates context and then invokes the ordinary
strict combiner. An older passing unit cannot hide a newer failed one; older
failed artifacts remain immutable rather than being relabelled or overwritten.
GitHub's same-run failed-job rerun can therefore reuse unchanged successful
units without re-executing them. Required lanes come only from
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
collector validates the selected envelopes and rejects incomplete, duplicate,
failed or mismatched reports. Prior gate summaries are history, not input units.

An administrator should still require **Required verification**, appropriate
approvals, code-owner review for protected paths and dismissal of stale
approvals in the repository ruleset. `CODEOWNERS` alone does not enforce these.
Runner migration does not configure branch protection or enable automatic merge.

CI, skill instructions and reviewer profiles in a PR are themselves changeable
code. Skill-led development is not a sandbox or a cryptographic attestation
service. A protected review
process (or an organization-controlled required workflow) must guard changes to
the checks themselves. Skill-led development relies on the agent to request independent review.
The verifier checks source-bound test evidence, not the authenticity of an AI
review. CI-first live qualification authenticates existing Actions artifacts;
it does not create another GitHub review/check publisher or replace those review
and ruleset protections.

The device job uploads only its tested candidate APKs and device report. A
candidate is not a signed release, full real-CLI/physical-device acceptance, or
authority to distribute. The existing extension distribution workflow remains
separate. `save-debug-artifact.ps1`, sealed build 002 and frozen release evidence
are not repurposed for CI candidates.

## Stops and recovery

Follow `.github\skills\devpocket-development\SKILL.md` in the same owning session.
Preserve the task contract, original base, edits, actual decisions and evidence.
Missing checks, uncertain commit outcomes, concurrent source/index/history/
branch/configuration changes or unresolved authority remain explicit blockers.
Native cancellation and user-selected limits retain their original accounting.

After an interrupted commit, inspect the candidate request/receipt, current
index and history before deciding whether any new operation is needed. Preserve
failed commits and reports; never replay an uncertain mutation. Inspect the
recorded owner before recovering a retained lock. Existing or replaced locks
are not removed automatically.

Historical Dynamic Workflow records and snapshots are retained in ignored
storage, not executed or upgraded by this route. Before reloading a session with
an old in-flight run, finish or stop that run through the original client.
For unfinished work, inspect its original task/base, actual Git state, decisions
and process ownership, then continue in its owning session using the skill.
Re-establish verification and independent review for the current source.
Old handoffs and manifests containing retired modules are not current readiness
or candidate-conversion proof; never rewrite their version, HEAD or input list
to make them pass. The separate shipped phone/runtime extension is not retired
by this change.
