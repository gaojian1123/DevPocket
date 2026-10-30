---
name: devpocket-development
description: Implement DevPocket features and bug fixes in the owning session. Use for new implementation, same-task repairs, PR review feedback, authorized commit/PR delivery and missing verification evidence. Dispatched agents perform only their assigned phase.
---

# DevPocket development

Read `AGENTS.md` and the relevant implementation first; use `README.md` for setup
and `VALIDATION.md` for known gaps, not current acceptance. Read the guide's
[Completion contract](../../../docs/DEVELOPMENT-WORKFLOW.md#completion-contract)
for the shared acceptance definition. This skill supplies the sequence, not a
second contract. Use the owning session's original tools and existing CI.
Discussion, planning, read-only review and documentation-only work use no pipeline.

## 1. Establish the task and workspace

State the task contract and delivery target, reusing the user's decisions.
Working-tree implementation is the default. This is not another plan-approval
checkpoint. Retain the
[task authorization record](../../../docs/DEVELOPMENT-WORKFLOW.md#task-authorization-record).
For unattended work, read
[Unattended execution](../../../docs/DEVELOPMENT-WORKFLOW.md#unattended-execution).

Confirm root, HEAD and resolved `--git-dir` / `--git-common-dir`; equal directories
identify the primary checkout. Inspect all existing changes:

```powershell
git --no-optional-locks -c core.fsmonitor=false status --porcelain --untracked-files=all --ignore-submodules=none
```

Use the current clean linked worktree. A new task in a clean primary checkout
uses native `create_session` once, carrying the contract. Follow-ups stay in
their owning workspace. Resolve existing-edit ownership and inspection failures
before proceeding.

**Complete when:** the task/source and authority records required by the
Completion contract exist, including `BASE_COMMIT` before the first edit.

## 2. Implement and run focused checks

Implement the contract, regression coverage and related documentation. Before
executing changed control, read
[Scoped development approvals](../../../docs/DEVELOPMENT-WORKFLOW.md#scoped-development-approvals).
Use trusted pre-edit `inspectDevelopmentPolicy` and `developmentReviewRequirements`;
retain current `policyReview` and actual native-client decisions in the task
record. Inspect command/data/destination effects, not filenames alone.

For missing prerequisites or changed manifests, follow
[Workspace-local prerequisites](../../../docs/DEVELOPMENT-WORKFLOW.md#workspace-local-prerequisites).
For a missing interactive decision, use
[Approval requests](../../../docs/DEVELOPMENT-WORKFLOW.md#approval-requests).
Run focused checks within that scope.

**Complete when:** all intended surfaces and regressions are implemented and
permitted focused checks pass; unresolved authority is explicit.

## 3. Freeze the delivery target

Read [Delivery targets and candidate preparation](../../../docs/DEVELOPMENT-WORKFLOW.md#delivery-targets-and-candidate-preparation).
Retain the working-tree snapshot, or create the authorized candidate after
focused checks and before formal verification. Keep `BASE_COMMIT` unchanged.
If a previously verified working tree later becomes a commit, verify that
candidate normally rather than converting the old report.

For PR delivery, read [CI-first delivery and live qualification](../../../docs/DEVELOPMENT-WORKFLOW.md#ci-first-delivery-and-live-qualification)
before the authorized push/Draft PR.

**Complete when:** the Completion contract's source/delivery bindings are fixed;
an authorized draft awaiting acceptance is `ci-pending`, not `ready`.

## 4. Verify and collect independent feedback

On the frozen source, independent code inspection can run alongside CI. Use the
read/search-only `devpocket-reviewer` in a separate context and follow
[Independent review and delivery freshness](../../../docs/DEVELOPMENT-WORKFLOW.md#independent-review-and-delivery-freshness)
for its inputs and final evidence handoff. Code-only feedback is not final acceptance.

For PR delivery and review-comment follow-ups, follow
[Parallel PR feedback](../../../docs/DEVELOPMENT-WORKFLOW.md#parallel-pr-feedback):
collect online feedback alongside CI and independent inspection, and send
confirmed findings to the same owning-session repair loop.

For CI-first, qualify the actual `Required verification` success using the
guide's live route; changed qualifier inputs use read-only `ci-inspection`
instead of local adoption. For local delivery/fallback, read
[Local verification and acceptance](../../../docs/DEVELOPMENT-WORKFLOW.md#local-verification-and-acceptance)
and run `npm run verify -- -Base BASE_COMMIT`. For recovery, read
[Selected-group preflight and explicit recovery](../../../docs/DEVELOPMENT-WORKFLOW.md#selected-group-preflight-and-explicit-recovery)
before `-Resume`.

**Complete when:** the Completion contract's verification, PR-feedback and
independent-review conditions are satisfied for the same frozen target.

## 5. Repair, check freshness and deliver

Repair in this workspace under
[Task-scoped autonomy](../../../docs/DEVELOPMENT-WORKFLOW.md#task-scoped-autonomy),
returning to Step 2 before using changed controls. Preserve earlier failures and
the original base; obtain applicable new evidence/review after repairs.
For interruption or uncertain outcomes, follow
[Stops and recovery](../../../docs/DEVELOPMENT-WORKFLOW.md#stops-and-recovery).

After passing review, perform the guide's route-specific freshness check and
finish at the requested delivery target.

**Complete when:** every condition in the Completion contract holds and the
actual handoff records its evidence and delivery state.
