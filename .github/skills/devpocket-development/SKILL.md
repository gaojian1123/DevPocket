---
name: devpocket-development
description: Implement DevPocket features and bug fixes with current-session implementation, source-bound verification and independent review. Use for new implementation requests, same-task repairs, authorized commit/PR delivery and missing verification evidence. Dispatched agents perform only their assigned phase.
---

# DevPocket development

Use this recipe for skill-led development, not discussion or documentation-only
work. Paths below are repository-relative. Read `AGENTS.md` and the relevant
implementation first; use `README.md` for setup and `VALIDATION.md` for known gaps.
The skill coordinates the owning session's existing tools.

## 1. Establish the task

State the goal, observable acceptance criteria and non-goals before implementation.
Reuse the user's decisions; ask only about unresolved behavior, scope or authority.
Once those are clear, proceed; stating the contract is not another plan-approval
checkpoint. Keep that contract fixed while repairing the task.
In explicitly selected autopilot/unattended mode, use established conventions for
reversible implementation details. Retain an unresolved product/scope/authority
decision as `needs_human` without opening a question or guessing consent. Preparation
of a new authorization scope is a separately requested interactive step.
Retain any user-selected limits and the original client's time/credit controls.
Do not add a project-default budget or repair cap, or require a budget question
when the user has not requested one. See **Task-scoped autonomy** in
`docs\DEVELOPMENT-WORKFLOW.md` for progress and stop decisions.

Record the delivery target separately from the implementation goal:

- **Working-tree implementation** is the default for a request to implement or
  fix something. Deliver reviewed changes without assuming permission to commit.
- **PR delivery** applies when the user requests a pull request. Reuse the
  authorization already given and resolve only missing scope before final
  verification. Track local commit, push and PR creation authorization separately;
  a development request alone does not authorize those actions. Prefer **CI-first**
  delivery: approved focused local checks, an authorized candidate/Draft PR, then
  complete CI evidence and independent review. A pending draft is not `ready`.

Separate action records do not require separate questions. Reuse a user's explicit
task-scoped grant covering commit, push, Draft PR, selected CI and ready delivery;
ask once for the missing combined scope in interactive preparation. A mode switch,
issue text, agent-written JSON or the goal alone is not such a grant. Follow
**Unattended execution** in the guide for hosted candidate dependencies/tools.

Before any push or PR creation, retain repository/branch-bound `ordinary-ci`
authority for automatic checks, even when verification is local. Candidate
dependencies and tools run in the ordinary disposable runner environment, not an
adversarial sandbox. Use the guide's combined task grant, and retain missing
authority without publishing or prompting in unattended mode.

If the user requests only a local commit, use the candidate-commit ordering below
but stop at that local deliverable. Do not expand it into PR publication.

For a continuation, recover the existing workspace, base commit, edits, reports
and review outcome from the task's session. Resume from the actual source state;
missing or stale evidence requires fresh verification, not a new task or base.
A dispatched implementer or reviewer completes only its assigned phase.
For historical task records, follow **Stops and recovery** in the guide; preserve
the original baseline and evidence rather than treating an old handoff as current readiness.

## 2. Select the workspace

Freshly confirm the repository root, HEAD and the resolved `--git-dir` and
`--git-common-dir` before editing. Equal Git directories identify the primary
checkout; a linked worktree has a separate Git directory. Session names or a
`.git` file alone do not establish that identity. Inspect staged, unstaged and
non-ignored untracked changes without refreshing the index or invoking fsmonitor:

```powershell
git --no-optional-locks -c core.fsmonitor=false status --porcelain --untracked-files=all --ignore-submodules=none
```

- In a clean linked worktree, implement in the current session and worktree.
- For a new task in a clean primary checkout, use the App's native `create_session`
  once to create an isolated worktree. Pass the contract and this skill's path;
  have that session implement directly.
- Continue an existing task in its own worktree, preserving its in-progress edits.
  For a new task with pre-existing edits, resolve ownership and dependencies with
  the user before editing or moving work. Preserve unrelated changes.
- If checkout inspection or session creation fails, report the blocker. Ask for
  an appropriate workspace or an explicit alternative; creating another session
  must not conceal a failed check or omit required uncommitted work.

Record an explicit base commit before the first edit. For a continuation, retain
the original base. Use a particular branch only when the user chose it or the
task depends on it; never silently omit that dependency.

## 3. Implement in the owning session

Make the agreed change, relevant regression coverage and documentation updates.
The current session owns implementation and repairs; another implementation
session is not a prerequisite.

Use the trusted, pre-edit `scripts\development-policy.mjs` for local authorization,
independently of CI selection. `inspectDevelopmentPolicy` uses the actual paths,
base and current inputs; `developmentReviewRequirements` explains each remaining
execution or review decision. Read the **Scoped development approvals** section
of `docs\DEVELOPMENT-WORKFLOW.md` when a decision is needed or recovered.
Sensitive and unclassified paths are independent-review subjects, not automatic
human checkpoints. Inspect their actual effects before selecting an execution route.

An implementation request covers ordinary code/test edits, existing local checks
and agreed repairs in this task's worktree. Reuse that scope without another
project approval for each file, repair or retry. Path classification is a screening
rule, not proof that arbitrary test code is safe: inspect changes to commands,
dependencies, accessed data, destinations and shared resources. An additional
effect or unresolved execution scope needs a concrete decision.

For **local execution or adoption**, require explicit human approval of actual
changed execution-core, dependency or instruction inputs, including active Git
hooks. For **ordinary CI**, use `developmentExecutionAuthorization` with target `ci`
and the actual repository/branch-bound task grant. Candidate dependencies, install
scripts and modified tools may run there without per-revision project approval.
CI execution does not authorize adopting changed local instructions or control.
Keep approved local tools stable until their changed inputs are explicitly
authorized. The owning session handles CI-first delivery using the existing CI.

Present the action, reason, exact target, effects, exclusions and validity using
`formatDevelopmentApproval`; add a plain-language description of the actual behavior
change and include the hash-validated, immutable diff/contents in the native question
itself (or an immutable authenticated attachment). A mutable local file is only a
reference copy, never the approval source. Ask only for missing scope. A manifest
filename or hash alone is not an approval request. Record the actual user answer, task/target,
actions and relevant input versions in the session. An agent-written JSON record
or AI review alone is not human approval.

Ordinary source changes require applicable new verification/review, not renewed
authority. Reuse a human decision only while its task, target, allowed effects and
relevant trusted policy/hook inputs still match. Candidate revisions within an
ordinary-CI grant need new evidence, not new authority. Changed local control
inputs, execution targets or expanded effects require a decision showing the delta. Rejection
or cancellation does not authorize a retry; retain one pending item, without
repeated prompts. Inspect uncertain side effects before considering another attempt.

When a decision remains unresolved, report `needs_human` with that specific item.
Inspection/editing may continue, and unaffected trusted checks may run. Use existing
checks for focused feedback; restore unchanged locked dependencies only after a real
missing-dependency failure and within the authorized environment. Local installation,
runtime experiments, extension reload, enrollment, cloud administration and publication
retain their target-specific authorization. The hosted grant covers only the stated
worker setup and candidate execution. The verifier does not enforce consent.

## 4. Freeze the verification target

**Working-tree implementation:** retain the edits without creating a commit.
Complete the required verification and independent review against that snapshot;
qualify the result as reviewed working-tree changes, not a verified final commit.

**Authorized commit/PR delivery:** after focused checks and once local commit
authorization is established, confirm that Step 3's human approval gate covers
any changed commit hooks before invoking Git. Commit authorization alone does
not approve changed hooks, and disabling hooks is not a substitute for approval.
Then create the candidate commit before final verification and independent
review. Include every intended task input, including new files and tests.
Preserve unrelated changes; resolve any remaining edits with the user rather
than deleting, moving or committing them implicitly.

Require a clean tracked and non-ignored working tree for candidate-commit
verification. Check again after commit hooks, and record the resulting HEAD as
`CANDIDATE_COMMIT`. Keep `BASE_COMMIT` at the original task baseline; never replace
it with the candidate HEAD, which could hide the task's changes from selection.
Missing authorization or an unresolved dirty candidate pauses this delivery path.

For **CI-first PR delivery**, follow **CI-first delivery and live qualification**
in `docs\DEVELOPMENT-WORKFLOW.md`. After approved focused checks and the native
candidate commit, separately authorized push/Draft PR creation may precede full
acceptance. First ensure execution consent covers the exact CI policy, hosted
setup, repository and branch; local-only consent does not cover that target.
Record the draft as `ci-pending`, with its candidate and original base. This is
permission to publish pending work, not permission to claim verification, mark
ready or merge. Do not run the full local gate merely to reach this draft step,
then repeat it in CI. Missing CI/publication authority needs a specific decision
or an explicitly chosen local route.

If the user later changes a working-tree task into a delivery request, continue
the same task and base through this step. Its earlier working-tree evidence does
not become evidence for the new commit by changing report fields.
For an unchanged, completely verified working tree, follow **Working-tree
evidence to an authorized candidate** in `docs\DEVELOPMENT-WORKFLOW.md`: use the
verified run's workspace/hook snapshot with the existing native candidate helper,
retain its successful hash-bound request/receipt, then explicitly `-Promote`
the old run. This can reuse only proven content-only checks. Missing proof or
an unsupported transition requires fresh candidate verification; it never
permits a plain HEAD substitution or an unapproved commit.

## 5. Obtain source-bound verification

Confirm Step 3's applicable execution authority before invoking changed verification
or dependency policy. Local execution needs exact-input approval; hosted execution
needs its scoped grant and the unchanged trusted control, not candidate self-approval.

**CI-first:** require the candidate's actual `Required verification` success and
run the guide's live `verification-ci.mjs --qualify` command from the clean
candidate checkout. Use the original task base, exact repository/PR/run and a new
output directory. Require `kind: ci-qualification`, `status: verified`, and the
same local candidate source. Read its referenced CI envelope: the actual report
must be complete and passing with every required check and per-shard origin.
Keep the branch candidate, tested PR merge ref, PR base, artifact digest and run
attempt distinct. The qualifier authenticates their relationship; do not rewrite
CI `source.head` or compare its checkout fingerprint to local CRLF bytes as if
they were the same execution. A saved qualification is a record, not authority
to reuse it later without a live check. Retain any specifically required
original-client-only evidence separately.

If the local qualifier's own inputs changed, use the guide's read-only
`ci-inspection` procedure instead of adopting candidate control or reopening a
per-revision approval. It requires the same complete CI coverage and live
identities, retained underlying records, independent review and final freshness;
it is not a machine qualification.

**Local route:** for working-tree/local-commit delivery or an explicitly selected
fallback, follow the Verification section of the guide:

```powershell
npm run verify -- -Base BASE_COMMIT
```

For a cleanup-confirmed environment failure on the same source, use the guide's
explicit `-Resume RUN_JSON` operation with a new report directory and unchanged
base/selection. Check its invalidation and execution records. Interrupted or
unconfirmed owners require inspection, not automatic retry or lock removal.
Preflight and recovered partial groups are not final acceptance.

Read the newly produced report. Require `status: passed`, `complete: true` and
every required check; a plan, focused test, build-only result or partial shard
is not completed verification. Combine CI shards through the existing verifier.
Use current version-5 reports with retained execution origins. Earlier aggregates
without origins must be reverified, not upgraded by editing their version or HEAD.
Required Android device evidence remains mandatory. Keep the report path, base,
`source.head` and `source.fingerprint` with the task.
For local candidate-commit evidence, require `source.head` to equal
`CANDIDATE_COMMIT`. CI evidence uses the explicit qualification above instead.

Evaluate the local `inspectDevelopmentPolicy` / `developmentReviewRequirements`
from the trusted `scripts\development-policy.mjs` against the actual base, changed
paths and relevant inputs. Retain `requiresHumanReview`, protected/review paths,
reasons, input identities and source identity as `policyReview`, alongside actual
human decisions and any task-scoped execution grant. `requiresHumanReview` describes
the local-execution requirement; evaluate `developmentExecutionAuthorization`
for the actual target before treating it as a pending decision. Pass retained policy-subject paths through inspection and later
repairs/readiness; a policy-bound manifest stays bound when its execution settings
return to the task base. Metadata-only exemptions apply only to never-bound manifests.
The requirement describes what must be satisfied, not a permanent
stop after it is satisfied. CI reports do not supply these decisions; absent or
stale evidence is not permission to publish. Execution consent and code review
remain distinct; reuse one decision for both only if its stated scope covers both.
Missing tools, failed checks, changed source and unavailable evidence remain
blockers; use the guide's relevant diagnostics rather than weakening the gate.

## 6. Request independent review

Invoke the configured read/search-only `devpocket-reviewer` in a separate context.
Supply the fixed task contract, base, actual diff, all added/untracked changed
paths, delivery target, current verification report, local policy requirements
and recorded human decisions, and the source identity.
For candidate-commit delivery, identify the candidate SHA as well. Ask it to
inspect the files rather than rely on the implementer's summary.
For CI-first delivery, supply the actual live-qualification result or documented
read-only inspection, authenticated
CI envelope/digest/run attempt, candidate and tested merge ref/base, actual PR
diff, policy decisions and all execution origins. The reviewer must assess that
candidate and its qualified CI evidence, not treat an unverified draft as ready
or reuse an earlier working-tree verdict.
Use the agreed ordinary-CI trust model. Review every sensitive/unclassified path
for actual effects, but do not add an adversarial sandbox or tamper-proof
execution requirement. Source-bound reports identify what ran; they are not
cryptographic proof that hostile candidate code could not influence its tests.
For converted evidence, also supply the immutable original run, native request
and receipt, transition record and each check's actual execution origin. Obtain
the reviewer's real conclusion for the final candidate; an earlier working-tree
review, human approval or permission is not automatically inherited.

Request `verdict: pass | changes_requested | needs_human` and findings containing
`severity: blocking | advisory`, repository-relative `file`, `line`, `impact` and
`reproduction`. Have the reviewer identify the reviewed source head/fingerprint.
Use the independent agent's actual response as the review outcome, not an
implementer-written approval file. An invalid or inconsistent result is blocked:
`pass` cannot contain blockers, and `changes_requested` must identify a blocker.

If the reviewer is unavailable or its read-only profile cannot be established,
stop and request the specific profile setup/loading needed. Self-review cannot
replace it.

## 7. Repair and recheck

Investigate blocking findings in the same workspace under the same contract.
Return to Step 3's authorization check before executing repaired policy or hooks;
reuse still-matching hosted/task scope rather than asking for each ordinary repair.
Continue same-scope implementation, checks and review without renewed project
approval. There is no implicit two-round limit: honor an explicit user-selected
repair cap and the original client's budget/cancellation instead.

Compare source-bound failures and attempted approaches across repairs. Resolved
blockers, a narrowed cause or a newly supported hypothesis establish progress;
source churn or rewritten findings do not. When a failure repeats or cycles,
inspect the actual diagnostics and try a materially different supported approach
within the existing scope. Use the read-only reviewer for repair diagnosis when
the evidence needs an independent assessment; diagnosis is not acceptance review.
If that changed approach still produces no demonstrated progress, retain the task
and report `blocked` with the failed approaches, evidence and concrete obstacle,
not a generic request to approve another round. A productive repair does not
consume a project-defined default round allowance.

For candidate-commit delivery, put a repair into a new authorized follow-up commit
before final verification; amend only if the user explicitly requests it. Keep
the original base and update the candidate SHA. Each source-changing repair needs
fresh applicable verification and independent review of the new source. Reuse
only still-applicable scoped human authorization, not old test/review evidence.
Only unresolved product decisions, missing authority or a requested budget/limit
extension require human input. Preserve the same task, base and spent budget;
starting another session or run does not authorize further work.

After a passing review, revalidate without rerunning checks solely to compare
identities. For CI-first delivery, repeat the live qualification or documented inspection into a new
directory and require the unchanged candidate, PR base/tested ref, run attempt
and full evidence covered by the review. A changed or unavailable binding needs
new applicable evidence/review, not a relabelled record.

For local evidence, revalidate the report against the current source:

```powershell
node scripts\verify.mjs --base BASE_COMMIT --combine `
  --input VERIFICATION_REPORT --report .data\verification\NEW_ID\reviewed.json
```

Use a new report destination and the actual retained report path. Require a
complete passing aggregate whose source identity matches the review. Any edit,
including a commit/ref change, invalidates mismatched verification and review.
For an explicitly converted candidate report, add `--candidate-evidence` and
retain the same applicable tool settings; this revalidates its local proof and
old execution origins rather than treating them as fresh execution.
For candidate-commit delivery, also require the working tree to remain clean and
HEAD to remain `CANDIDATE_COMMIT` before publishing.
Recompute the local review requirement for the unchanged source before any
authorized publication; a missing or stale `policyReview` cannot establish
readiness.
This aggregate validates test evidence; it does not authenticate an AI review.

## 8. Hand off or publish

Report the delivery target, workspace, base, evidence path and independent review
outcome. Identify a verified candidate by its exact commit SHA.
Use `ready` only when acceptance, verification and review are complete for the
unchanged source and every required human decision is satisfied. Use `blocked`
for missing/failed evidence and `needs_human` for specific unsatisfied decisions;
`policyReview.requiresHumanReview` alone does not mean an approved decision is
still pending. Preserve these qualifications and identify the next permitted action.

For working-tree implementation, stop at reviewed working-tree changes and state
that they are not final-commit PR evidence. For local-commit-only delivery, stop
at the verified local commit. For PR delivery, publish the unchanged verified
candidate only within the user's authorized scope, using the host's normal
push/PR tools. If Step 4 already published its authorized pending draft, update
that same PR to ready only after complete evidence, actual independent review,
applicable human decisions and freshness. Do not create a duplicate PR. Missing
execution consent blocks CI-triggering publication; unresolved final-review
requirements block ready delivery, not an otherwise authorized pending draft.

An unchanged push does not invalidate local source evidence; do not repeat local
verification merely because it was pushed. Required remote CI and checks of a
different PR/merge ref still apply. Report an opened PR only after creation
actually succeeds; a verified candidate alone is not a published PR.
Merge, local installation, control-policy adoption and deployment remain separately
authorized actions. Hosted installation stays inside its explicit worker grant.

This is skill-led development in the owning session. Preserve the same task,
baseline and evidence across follow-ups.
