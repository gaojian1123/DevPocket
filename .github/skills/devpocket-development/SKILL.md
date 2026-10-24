---
name: devpocket-development
description: Implement DevPocket features and bug fixes in the owning session. Use for new implementation, same-task repairs, authorized commit/PR delivery and missing verification evidence. Dispatched agents perform only their assigned phase.
---

# DevPocket development

Read `AGENTS.md` and the relevant implementation first; use `README.md` for setup
and `VALIDATION.md` for known gaps, not current acceptance. This skill is the
short route through the authoritative [development guide](../../../docs/DEVELOPMENT-WORKFLOW.md).
Use the owning session's original tools and existing CI. Discussion, planning,
read-only review and documentation-only work do not start this pipeline.

## 1. Establish the task

State the goal, observable acceptance criteria and non-goals; reuse the user's
decisions. Stating the contract is not another plan-approval checkpoint.
Record **working-tree implementation** (default), **local-commit** or **PR delivery**
separately from the goal. Track local commit, push and PR creation authorization
separately; one explicit task grant may cover them without separate questions.

Read [Task-scoped autonomy](../../../docs/DEVELOPMENT-WORKFLOW.md#task-scoped-autonomy)
for repair/stop decisions and user limits. For autopilot/unattended work, also read
[Unattended execution](../../../docs/DEVELOPMENT-WORKFLOW.md#unattended-execution):
ordinary CI needs repository/branch-bound authority; missing scope is
`needs_human`, not inferred consent or an unattended question.

**Complete when:** the fixed contract, delivery target, actual authority and
user-selected limits are retained. A follow-up keeps its original task and base.

## 2. Select the workspace

Confirm root, HEAD and resolved `--git-dir` / `--git-common-dir`; equal directories
identify the primary checkout. Inspect staged, unstaged and non-ignored files:

```powershell
git --no-optional-locks -c core.fsmonitor=false status --porcelain --untracked-files=all --ignore-submodules=none
```

In a clean linked worktree, implement in the current session. For a new task in
a clean primary checkout, use native `create_session` once for an isolated
worktree and pass the contract. Continue an existing task in its own worktree.
Preserve pre-existing edits; resolve ownership before moving or including them.
Inspection failures remain blockers rather than a reason to silently relocate.

**Complete when:** the actual workspace/branch and explicit `BASE_COMMIT` are
recorded before the first edit. Follow-ups never replace that baseline.

## 3. Implement in the owning session

Implement the contract, regression coverage and directly related documentation.
Keep pre-edit trusted local control stable. Inspect actual command, dependency,
data, destination and shared-resource effects, not filenames alone.

Read [Scoped development approvals](../../../docs/DEVELOPMENT-WORKFLOW.md#scoped-development-approvals)
when evaluating or recovering authority. Use trusted `inspectDevelopmentPolicy`
and `developmentReviewRequirements`, retaining source-bound `policyReview` and
actual decisions. Evaluate `developmentExecutionAuthorization` for the actual
target: hosted execution is not local tool/instruction/hook adoption.
For missing prerequisites or changed manifests, read
[Workspace-local prerequisites](../../../docs/DEVELOPMENT-WORKFLOW.md#workspace-local-prerequisites).
For a missing interactive approval, follow
[Approval requests](../../../docs/DEVELOPMENT-WORKFLOW.md#approval-requests);
use a concise behavior summary and retain immutable on-demand details.

**Complete when:** all intended surfaces are updated and focused checks permitted
by the applicable execution scope pass. Unresolved authority remains explicit.

## 4. Freeze the verification target

Read [Delivery targets and candidate preparation](../../../docs/DEVELOPMENT-WORKFLOW.md#delivery-targets-and-candidate-preparation).
Working-tree implementation retains the edits without creating a commit.
Authorized commit delivery creates the native candidate after focused checks,
before final verification/review, only with matching commit and hook authority.
Include every intended input; require a clean tracked and non-ignored working
tree and record `CANDIDATE_COMMIT`. Keep `BASE_COMMIT` unchanged.

For PR delivery, read [CI-first delivery and live qualification](../../../docs/DEVELOPMENT-WORKFLOW.md#ci-first-delivery-and-live-qualification)
before the authorized push/Draft PR. A pending draft is `ci-pending`, not `ready`.
For already verified working-tree evidence, read
[Working-tree evidence to an authorized candidate](../../../docs/DEVELOPMENT-WORKFLOW.md#working-tree-evidence-to-an-authorized-candidate);
conversion needs the original run and native request/receipt, never a HEAD edit.

**Complete when:** the retained working-tree snapshot or clean candidate matches
the intended delivery target and original base; any draft is explicitly pending.

## 5. Obtain source-bound verification

**CI-first:** follow the live-qualification section above after the actual
`Required verification` success. If qualifier inputs changed, use its read-only
`ci-inspection` procedure instead of adopting candidate control.

**Local delivery or explicitly selected fallback:** read
[Local verification and acceptance](../../../docs/DEVELOPMENT-WORKFLOW.md#local-verification-and-acceptance)
and run `npm run verify -- -Base BASE_COMMIT`. For a cleanup-confirmed environment
failure, read [Selected-group preflight and explicit recovery](../../../docs/DEVELOPMENT-WORKFLOW.md#selected-group-preflight-and-explicit-recovery)
before `-Resume`; preflight or recovered partial groups are not acceptance.

**Complete when:** the actual version-6 report is complete and passing with every
required check, shard origin and selected platform/device result. Local candidate
evidence binds `source.head` to `CANDIDATE_COMMIT`; CI keeps candidate and tested
merge ref distinct. Retain original-client-only evidence when required.
CI reports do not supply local policy decisions or independent review.

## 6. Request independent review

Only after complete evidence, follow
[Independent review and delivery freshness](../../../docs/DEVELOPMENT-WORKFLOW.md#independent-review-and-delivery-freshness).
Invoke the configured read/search-only `devpocket-reviewer` in a separate context
with the fixed contract, actual full diff and added files, base/source/candidate,
delivery target, underlying verification and recorded policy/authority evidence.
The reviewer inspects the files; self-review is not independent review.

**Complete when:** the agent's actual source-bound verdict is
`pass | changes_requested | needs_human` with reproducible findings. `pass` has
no blockers. Missing read-only profile or inconsistent evidence blocks acceptance.

## 7. Repair and recheck

Repair in this workspace under the same contract and still-applicable authority.
Return to Step 3 before executing changed controls. Source-changing repairs need
fresh applicable evidence and review; authorized delivery uses a new follow-up
commit, with amendment only when explicitly requested. Preserve earlier failures.
For repeated failure, use Task-scoped autonomy; for interruption, read
[Stops and recovery](../../../docs/DEVELOPMENT-WORKFLOW.md#stops-and-recovery).
Honor the user's budget/cancellation; there is no project-default repair cap.

After a passing review, perform the guide's route-specific freshness check:
live CI qualification/inspection, or local source-bound reaggregation (explicit
candidate-evidence validation for conversion). Recompute local policy requirements.

**Complete when:** the current source identity matches the review and complete
evidence, hooks/authority remain applicable, and a candidate is still clean at
`CANDIDATE_COMMIT`. Changed bindings return to verification/review, not relabelling.

## 8. Hand off or publish

Report the delivery target, workspace, original base, exact candidate if any,
evidence paths and independent verdict. Use `ready` only for complete unchanged
acceptance and satisfied decisions; use `blocked` for technical/evidence gaps
and `needs_human` for specific missing authority or product decisions.
Working-tree evidence is not final-commit evidence. For PR delivery, mark the
same authorized draft ready only after freshness; report publication only after
it succeeds. Merge, deployment and local control adoption remain separate.

**Complete when:** the requested deliverable actually exists in its reported
state, within the user's scope, with no unresolved required check or decision.
