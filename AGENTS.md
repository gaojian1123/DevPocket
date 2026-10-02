# AGENTS.md

Use `README.md` for setup and build instructions. Consult `VALIDATION.md` for recorded acceptance and known gaps; historical results do not validate new changes.

## Change boundaries

- Preserve the already-running CLI's process/session identity through `joinSession()` and the CLI-bundled SDK. Rename, pin and archive affect DevPocket metadata.
- Gate runtime controls on version checks and live capability probes. Unsupported or incomplete permission/question forms belong in the original terminal.
- Keep command IDs and bodies immutable across retries. Distinguish admission, queueing, execution and completion; confirm cancellation only from runtime evidence. An uncertain outcome must remain visible.
- Keep authorization scoped to device, host and session. File/Git access is read-only and fails closed when content-exclusion evaluation is unavailable. Only projected user-facing events belong on the wire.
- When changing the wire contract, keep `backend\src\protocol.ts` and `android\app\src\main\java\dev\devpocket\app\data\Wire.kt` aligned, then regenerate `protocol.schema.json` with `npm run schema`.

## Checks and operations

- Use the relevant checks in `package.json` for backend changes and `scripts\build-android.ps1 -Lint` for Android changes. Documentation-only edits need no application build.
- Real CLI checks use explicitly opted-in disposable terminals. Extension installation/reload, host/device enrollment and cloud operations require authorization for the specific target; previous trial approvals are not standing permission.
- Before deployment or onboarding, read the matching runbook in `deployment\`. Keep credentials and private runtime evidence in ignored storage; preserve sealed artifacts and record new acceptance separately.
