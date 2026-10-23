# AGENTS.md

Use `README.md` for setup and build instructions. Consult `VALIDATION.md` for recorded acceptance and known gaps; historical results do not validate new changes.

## Default development routing

For new user requests to implement a feature or fix a bug, use the repository's
`devpocket-development` skill by default. Its source of truth is
`.github\skills\devpocket-development\SKILL.md`: invoke the skill when available,
otherwise read that file directly. It defines workspace selection, the task
contract, verification, independent review and same-task recovery.

Continue the existing task and workspace for follow-ups. Dispatched implementers
and reviewers perform their assigned step, rather than starting another pipeline.
Follow `docs\DEVELOPMENT-WORKFLOW.md` for verification, delivery authorization
and recovery. Development uses the owning session's original tools, not a
registered Dynamic Workflow or development extension.
Advice, explanations, planning, read-only reviews and documentation-only edits
do not start an implementation pipeline. Development retains required verification,
independent review and scoped authorization; self-review is not independent review.

For unattended development, follow **Unattended execution** in
`docs\DEVELOPMENT-WORKFLOW.md`: use ordinary hosted CI within explicit task-scoped
authority, retaining tests, independent review and process cleanup. This workflow
does not require an adversarial sandbox or tamper-proof test execution. Keep local
control adoption and publication authority separate; retain missing scope instead
of opening unattended questions. Product security requirements below are unchanged.

## Terminology

Use **GitHub Copilot** for shared product/session behavior. The **original client**
is GitHub Copilot CLI or the GitHub Copilot desktop app (Copilot App); use it for
fallback instructions that apply to both. Keep client-specific names for actual
commands, SDK packaging, startup flags and historical acceptance evidence.
Preserve protocol identifiers such as `cliVersion`, `terminal` and
`TERMINAL_REQUIRED`; wording changes do not rename wire or persisted fields.

## Change boundaries

- Preserve the original process/session identity when attaching to an already-running GitHub Copilot runtime in either original client. Use `joinSession()` and the runtime-bundled SDK, rather than starting, cloning or resuming a replacement session.
- Rename, pin and archive affect DevPocket metadata only; they do not rename, stop, delete or archive the original runtime session.
- Keep command IDs and bodies immutable across retries of the same operation. A deliberately new operation uses a new ID, even when its content is identical.
- Distinguish runtime admission, queueing, execution and completion. Show cancellation as requested until confirmed by runtime evidence, and keep uncertain outcomes visible.
- Gate individual runtime controls on live capability evidence and validated protocol shapes. Capability discovery uses read-only probes; mutating compatibility checks follow the opt-in validation rules below.
- Handle unsupported or incomplete permission/question forms in the original client, without automatic acceptance or approval from incomplete mobile details.
- Validate device-to-host authorization and host/session ownership for each scoped request. Command IDs and receipts remain bound to their originating device, host and session.
- Keep DevPocket's file browsing and Git inspection endpoints read-only. Chat-initiated changes run through the original runtime's permission policy. File/Git content requires an explicit allow decision from content-exclusion evaluation; unavailable or incomplete evaluation denies access.
- Send only allowlisted projections of user-facing events, with sensitive fields redacted or omitted. Keep raw SDK events, internal prompts, credentials and private reasoning off the wire.
- When changing the wire contract, keep `backend\src\protocol.ts` and `android\app\src\main\java\dev\devpocket\app\data\Wire.kt` aligned, then regenerate `protocol.schema.json` with `npm run schema`. Verify decoding on both ends and preserve compatibility with existing clients, bridges and persisted records, or handle incompatibility explicitly.

## Checks and operations

- Use `npm run verify -- -Base BASE_COMMIT` for the diff-selected gate; planning, partial shards and skipped required tests are not completed verification. For authorized commit delivery, create the candidate after focused checks and before final verification and independent review.
- Use the relevant checks in `package.json` for backend changes and `scripts\build-android.ps1 -Lint` for Android changes. Documentation-only edits need no application build.
- Real GitHub Copilot checks use explicitly opted-in disposable sessions in the intended client; CLI checks use disposable terminals. Extension installation/reload, host/device enrollment and cloud operations require authorization for the specific target; previous trial approvals are not standing permission.
- Before deployment or onboarding, read the matching runbook in `deployment\`. Keep credentials and private runtime evidence in ignored storage; preserve sealed artifacts and record new acceptance separately.
