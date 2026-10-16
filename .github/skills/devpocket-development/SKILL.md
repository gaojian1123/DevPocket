---
name: devpocket-development
description: Implement DevPocket features and bug fixes with current-session implementation, source-bound verification and independent review. Use for new implementation requests, same-task repairs, authorized commit/PR delivery and missing verification evidence. Dispatched agents perform only their assigned phase.
---

# DevPocket development

Use this recipe for skill-led development, not discussion or documentation-only
work. Paths below are repository-relative. Read `AGENTS.md` and the relevant
implementation first; use `README.md` for setup and `VALIDATION.md` for known gaps.
The skill coordinates existing tools; it is not a durable workflow controller.

## 1. Establish the task

State the goal, observable acceptance criteria and non-goals before implementation.
Reuse the user's decisions; ask only about unresolved behavior, scope or authority.
Keep that contract fixed while repairing the task.

Record the delivery target separately from the implementation goal:

- **Working-tree implementation** is the default for a request to implement or
  fix something. Deliver reviewed changes without assuming permission to commit.
- **PR delivery** applies when the user requests a pull request. Reuse the
  authorization already given and resolve only missing scope before final
  verification. Track local commit, push and PR creation authorization separately;
  a development request alone does not authorize those actions.

If the user requests only a local commit, use the candidate-commit ordering below
but stop at that local deliverable. Do not expand it into PR publication.

For a continuation, recover the existing workspace, base commit, edits, reports
and review outcome from the task's session. Resume from the actual source state;
missing or stale evidence requires fresh verification, not a new task or base.
A dispatched implementer or reviewer completes only its assigned phase.
An existing registered workflow stays with its recorded owner and run.

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
  have that session implement directly, not call the workflow starter.
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

Before execution, inspect the protected-policy diff read-only using the trusted
`isVerificationPolicyPath` rules in `scripts\development-policy.mjs`. Do not run
a modified planner to decide whether its own policy needs approval.
**Require explicit human approval of the actual changed execution or dependency
policy before executing it.** This includes focused checks, dependency restoration
and its install/lifecycle hooks, and Git commit hooks. Changed agent instructions
also need approval before adopting them as execution policy.

Record the human decision, approved policy diff or content hashes, and permitted
command scope with the task. General task/workflow authorization, implementer
self-review and an AI review are not approval of newly changed policy.
Any further change to the approved policy or hook inputs invalidates that
approval; obtain renewed human approval before the next affected execution,
including during repairs.

If approval is missing or its scope cannot be established, report `needs_human`.
Inspection and editing may continue. Run unchanged, already approved checks only
after establishing that they cannot load the modified policy or hooks; otherwise
stop before execution. The standalone verifier does not enforce this approval.

After this gate, use the existing checks for focused feedback.
Restore missing dependencies from lockfiles only after an actual missing-dependency
failure. Runtime experiments, installation/reload, enrollment, cloud operations
and publication still require their specific authorization.

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

If the user later changes a working-tree task into a delivery request, continue
the same task and base through this step. Its earlier working-tree evidence does
not become evidence for the new commit by changing report fields.

## 5. Obtain source-bound verification

Confirm Step 3's pre-execution human approval before invoking changed verification
or dependency policy, including a modified planner.
Follow the Verification section of `docs\DEVELOPMENT-WORKFLOW.md`:

```powershell
npm run verify -- -Base BASE_COMMIT
```

Read the newly produced report. Require `status: passed`, `complete: true` and
every required check; a plan, focused test, build-only result or partial shard
is not completed verification. Combine CI shards through the existing verifier.
Required Android device evidence remains mandatory. Keep the report path, base,
`source.head` and `source.fingerprint` with the task.
For candidate-commit delivery, require `source.head` to equal `CANDIDATE_COMMIT`.

Evaluate the local `developmentReviewRequirements(plan.changedFiles)` from the
trusted `scripts\development-policy.mjs` against the actual changed-path list.
Retain its `requiresHumanReview`, protected paths and the plan's source identity
as `policyReview` for review and handoff. CI reports do not supply this decision;
an absent decision is not `false` or permission to publish. Neither the local
requirement nor a passing report supplies the human approval required before
executing changed policy.
Missing tools, failed checks, changed source and unavailable evidence remain
blockers; use the guide's relevant diagnostics rather than weakening the gate.

## 6. Request independent review

Invoke the configured read/search-only `devpocket-reviewer` in a separate context.
Supply the fixed task contract, base, actual diff, all added/untracked changed
paths, delivery target, current verification report, local policy requirements
and recorded human decisions, and the source identity.
For candidate-commit delivery, identify the candidate SHA as well. Ask it to
inspect the files rather than rely on the implementer's summary.

Request `verdict: pass | changes_requested | needs_human` and findings containing
`severity: blocking | advisory`, repository-relative `file`, `line`, `impact` and
`reproduction`. Have the reviewer identify the reviewed source head/fingerprint.
Use the independent agent's actual response as the review outcome, not an
implementer-written approval file. An invalid or inconsistent result is blocked:
`pass` cannot contain blockers, and `changes_requested` must identify a blocker.

If the reviewer is unavailable or its read-only profile cannot be established,
stop and request the specific profile setup/loading needed. Self-review cannot
replace it. The development workflow extension is not needed for this step.

## 7. Repair and recheck

Investigate blocking findings in the same workspace under the same contract.
Return to Step 3's approval gate before executing repaired policy or hooks.
Allow at most two repair rounds unless the user chooses a different bound.
For candidate-commit delivery, put a repair into a new authorized follow-up commit
before final verification; amend only if the user explicitly requests it. Keep
the original base and update the candidate SHA. Each source-changing repair needs
fresh applicable verification and independent review of the new source; old
approval does not carry forward. Unresolved product decisions, permissions or
exhausted repairs require human input.

After a passing review, revalidate the report against the current source without
rerunning checks solely to compare identities:

```powershell
node scripts\verify.mjs --base BASE_COMMIT --combine `
  --input VERIFICATION_REPORT --report .data\verification\NEW_ID\reviewed.json
```

Use a new report destination and the actual retained report path. Require a
complete passing aggregate whose source identity matches the review. Any edit,
including a commit/ref change, invalidates mismatched verification and review.
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
unchanged source. Use `blocked` for missing/failed evidence and `needs_human` for
unresolved decisions or `policyReview.requiresHumanReview`; preserve those qualifications.

For working-tree implementation, stop at reviewed working-tree changes and state
that they are not final-commit PR evidence. For local-commit-only delivery, stop
at the verified local commit. For PR delivery, publish the unchanged verified
candidate only within the user's authorized scope, using the host's normal
push/PR tools. Pending human policy review still blocks publication.

An unchanged push does not invalidate local source evidence; do not repeat local
verification merely because it was pushed. Required remote CI and checks of a
different PR/merge ref still apply. Report an opened PR only after creation
actually succeeds; a verified candidate alone is not a published PR.
Merge, installation and deployment remain separately authorized actions.

Call this skill-led development, not a registered workflow run. Only when the
user explicitly selects the optional `devpocket-development` workflow, follow
its entry/activation requirements in `docs\DEVELOPMENT-WORKFLOW.md`. Preserve an
existing task rather than silently migrating it to that route.
