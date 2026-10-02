# Frozen real-release import and activation — review before execution

**Local planning grants no execution permission.** This path is separate from the completed synthetic probe and from the exhausted Blob-upload path. The probe CLI is still synthetic-only. No real VM key, encrypted real package, VM command, data-disk bootstrap, Docker installation, service start or certificate request is performed by local planning.

**Execution checkpoint (2026-10-02):** the separately approved real-release-001 completed authenticated transfer, protected bootstrap/import, exact transfer cleanup, image build, activation and visible-log audits. Public CA-trusted TLS/health, HTTP-to-HTTPS redirect and unauthorized HTTP/WSS rejection passed; direct-IP requests with correct SNI/Host returned the same trusted certificate. The frozen package, application version, sealed Android build and Azure network/identity/resource configuration were not changed. Private receipts record the actual target, hashes and limitations; this checkpoint does not authorize another run or establish authenticated phone/original-CLI acceptance.

## Separate the business package from the transport/control revision

The real plan reads only the unique frozen package identified in the preserved recovery execution receipt. It checks its exact size/SHA-256, per-file manifest, manifest hash, version and target binding without executing or rewriting the package. It records:

- **Frozen business archive SHA and size**, its original recovery plan and original deployment source fingerprint.
- **Current transport/control source fingerprint and new real plan hash**, independently of that frozen package.
- The accepted synthetic probe and its measured **36,369-byte JSON Action request** ceiling.

The original package has no detached digital signature that can honestly be claimed. The new interface verifies the **AES-GCM authentication tag**, the independently approved complete archive SHA and frozen manifest/member hashes. `authenticatedLocalArchive` describes that evidence; it does not fabricate a prior Blob upload or an old package signature.

No `--archive`, `--vm`, arbitrary script, alternate source URL or Blob-upload command exists. A candidate not matching the recorded frozen package is refused before execution. Preparing another business archive requires a separate decision.

## Independent authority and immutable identity

Private inputs and evidence live in `.data\azure\<environment>\real-release-001`; original environment, recovery and probe evidence are not overwritten.

`scope.local.json` pins the recorded original package, origin fingerprint, exact VM/owner, and the already-recovered public endpoint. `init-plan` verifies them against the preserved recovery plan/baseline/execution record and successful, cleaned probe evidence.

The new plan has a new transfer ID and distinct root-only temporary path:

`/var/lib/devpocket-real-transfers/<transfer-id>`

A new VM-local RSA-3072 key is generated **only after** `real-key` authorization. It is never the probe key or SSH key. Only its public key/fingerprint is returned over the authenticated ARM response. AES-GCM AAD binds protocol, new plan hash, VM, transfer, frozen package/manifest hashes, expiry, new control-code fingerprint, recipient fingerprint and chunk size. The private key and bare AES key never enter an ARM request or ordinary output.

Current operator identity remains the explicit tenant-scoped **azd** identity. The VM owner, managed identity, size, disk profile, existing NIC/Storage state and real public DNS are rechecked before each management action. No new infrastructure or firewall/RBAC grant is proposed.

## Exactly staged execution

Each stage has its own `real-*` permission and a distinct VM/local success receipt. The UI/CLI cannot treat ARM acceptance or an unrelated status marker as proof of another stage.

| Action | Permission | Preconditions / evidence |
| --- | --- | --- |
| Inspect | `real-inspect` | Same VM and existing Python/cryptography; no installation |
| Fresh recipient key | `real-key` | New root-only 0700 directory/0600 private key, pinned public-key fingerprint |
| Envelope/chunks | `real-transfer` | Approved package SHA/size and same-recipient authenticated envelope; no source in plaintext/Base64 plaintext |
| Authenticate/quarantine | `real-authenticate` | GCM authentication, whole frozen SHA, manifest/member hashes and safe path/type/link/size checks before private staging |
| Original bootstrap | `real-bootstrap` | Successful authenticated quarantine, fixed generic-control file hash; invoke the frozen original owner/empty-or-owned LUN0 32-GiB checks and Docker bootstrap |
| Local release import | `real-import` | Successful bootstrap receipt and real mounted data owner; verified quarantine copied via a transfer-specific staging directory into `/srv/devpocket/releases/<frozen-sha>` |
| Transfer log audit | `real-audit` | Selected handler/script/output logs checked for private key, unwrapped key, plaintext archive/encoding and sampled source fragments; no raw log export |
| Transfer cleanup | `real-cleanup` | Remove only the exact transfer key/plaintext/ciphertext/quarantine directory; imported immutable business release remains |
| Image build | `real-build` | Matching successful import receipt and revalidated local files; no Blob path exists |
| Activate/autostart/ACME | `real-activate` | Matching build/image receipt; original consistent backup, failure rollback and no automatic SQLite rewind |
| Control log audit | `real-audit` | Selected ordinary handler/stdout/stderr files; protected detailed build logs are not exported |
| Public check | Explicit plan scope | Platform-validated HTTPS health and unauthorized HTTP/WSS rejection; not phone/original-CLI pairing |

The current archive uses eleven **4,096-byte ciphertext chunks** (the final chunk is shorter). The normal path has 22 sequential management actions; the plan allows at most 24 so limited cleanup capacity remains. Every rendered JSON Action body must be **at most 36,369 bytes**, not the probe's unproven 96-KiB client budget. `sizes` uses only synthetic ciphertext-shaped data, never encrypts/transmits the real package, and measures **all** transfer/control action formats. A larger future receiver/request is refused and needs an independently authorized non-sensitive capacity check.

Transport/import/audit/cleanup scripts have 30-second internal limits. Reviewed long control limits are bootstrap 1,200 seconds, build 1,800 seconds and activation 300 seconds. The outer `timeout` adds 15 seconds plus a 10-second forced-termination grace. These longer bootstrap/build executions are **not** covered by the synthetic probe's short-script success; actual remote package manager/Docker behavior remains untested until authorized.

Azure Action Run Command cannot be externally cancelled. The client records operation ID, target, exact request hash/size and single POST count before submission, then records/polls Azure's operation URI. A local exclusive in-flight marker and unsettled-receipt check prevent concurrency or blind POST replay. Ambiguous results permit **read-only status inspection only**; no timeout is re-labelled as a successful build.

In the recorded execution, the final ciphertext-chunk Action completed in Azure but its result GET encountered a client credential-read error. The recorded operation was reconciled by `status`, not reposted. After verifying every prior receipt and the exact final chunk index, the remaining original phase APIs were explicitly continued under the unchanged approval/source/expiry, with separate continuation evidence. The complete execution still used 22 one-POST Actions. Do not replay `run`, manufacture an import receipt, or advance from an unresolved result. A settled status alone is not an automatic resume command.

## Preserve the original data/rollback controls

The frozen archive already contains `deployment/azure/vm/control.py`. Its file hash is separately pinned in the new plan. The new small controller loads that verified file **on the VM only**, after archive authentication; local preparation does not execute the frozen package.

- Bootstrap delegates to the original checks/behavior: existing owner refusal, expected data disk LUN/size, partition/in-use/filesystem checks, refusal to reformat a previously initialized disk, empty/owned data directory, local ext4 mount/owner and Docker installation. No data-disk mutation occurs during local preparation or mere transfer.
- The original bootstrap performs package installation as part of that authorized stage. A later disk precondition failure may leave installed packages but must not format/adopt an invalid disk. Partial VM state requires explicit inspection, not automatic destructive reversal.
- Successful import has its own receipt under `/srv/devpocket/real-release-receipts/<plan-hash>`. It never invents a Blob URL or “upload succeeded” result.
- Build invokes the original `prepare_release` only after the immutable local release exists and verifies correctly. Its download function is explicitly replaced by a fail-closed `BLOB_PATH_FORBIDDEN` guard. No exhausted Blob permission or retry budget is reused.
- Activation invokes the frozen original backup/rollback/ownership/schema controls. It preserves SQLite state rather than restoring old deduplication data silently. A failed new start attempts the existing defined image rollback and reports failure.
- An interrupted import only removes the specific staging directory created for its own transfer; it never deletes another release, database, old IP, VM, disk or unrelated project.

## Output and secrecy limits

VM ordinary output is an allowlisted status/hash/count/boolean/image-digest contract, plus the public key at key creation. Unknown fields/statuses, raw exception text, private-key markers and known key/archive representations are rejected before normal ARM-result persistence. Control stdout/stderr and package-manager/build diagnostics are redirected to root-only VM-local files; there is no indiscriminate log-fetch feature.

Detailed protected logs are at `/var/lib/devpocket-real-operation-logs/<plan-hash>-<phase>.log` and the frozen core's root-only `/var/log/devpocket-operations.log`. Persistent source in the immutable release and those protected diagnostic files is intentional after authorized import/build, not an ephemeral transport key. Cleanup does not erase evidence or user data.

The visible-log audits are bounded by file/byte budgets. Missing scopes, skipped oversized files or matches fail rather than claim secrecy. They are **not** guarantees against Azure/VM administrators/root, inaccessible Azure backend logs, arbitrary encodings, all heap/swap copies or every future tool. Azure-agent-managed script caches may retain ciphertext and generic receiver code. The recipient key is removed before build/activation on the normal path.

## Local preparation and tests

```powershell
npm --prefix deployment\azure test
npm --prefix deployment\azure run validate -- --no-package
$env:PYTHONPYCACHEPREFIX = Join-Path $PWD '.data\real-local-tests\pycache'
.\.tools\probe-python\Scripts\python.exe -m unittest discover `
  -s deployment\azure\real -p 'test_*.py' -v

$real = '.data\azure\YOUR_ENV\real-release-001'
node deployment\azure\real-release.mjs init-plan --directory $real
node deployment\azure\real-release.mjs sizes --directory $real
```

Local tests use harmless fixture packages, including scripts that must never execute. They cover wrong package/manifest/member hashes, traversal, link/type bounds, wrong target/expiry/tag, identical/conflicting duplicate delivery, exact cleanup, no-import-no-build/start, immutable import provenance, fail-closed no-Blob access, unsafe output/error rejection and capture of untrusted build output into protected logs.

Local preparation alone does **not** prove a frozen business package will build/run successfully on Linux or that apt/Docker/registries/CA are available. The recorded deployment established those outcomes only for its exact package/plan and execution window. Future releases require their own evidence. Do not modify/repackage a frozen business archive silently if a later build fails.

## Future formal approval, not permission granted here

After the user reviews the new plan/source/package provenance and explicitly authorizes these stages:

```powershell
node deployment\azure\real-release.mjs approve --directory $real `
  --confirm $ReviewedRealPlanHash `
  --phases real-inspect,real-key,real-transfer,real-authenticate,real-bootstrap,real-import,real-build,real-activate,real-audit,real-cleanup

# Either directly or via the explicitly selected project-local azd application hooks:
node deployment\azure\real-release.mjs run --directory $real
node deployment\azure\real-release.mjs public-check --directory $real

# Equivalent application hook selection, only after the same new approval:
azd env set DEVPOCKET_REAL_RELEASE_ID 001
azd deploy --all
```

An approval lasts at most four hours and cannot silently replace an existing transfer's expiry binding. `run-started.json` refuses a fresh replay; use `status` for an unsettled action. After a settled failure, `cleanup-transfer` still needs its explicit cleanup phase. Do not run the initial `azd up/provision`, restart the exhausted Blob recovery command, reuse probe authority, or delete retained billable resources.

Source/authority is rechecked immediately before the one POST, after request rendering and receipt preparation. Failure at that check is recorded `not-submitted` with POST count zero. A separately approved **cleanup-only** renewal can retain the original expired transfer identity to destroy its exact temporary files; it cannot extend transfer/decrypt/bootstrap/build/start authority or silently rewrite the old expiry binding.

The existing VM/two PIPs/disks/Storage, region, SKU, firewall, roles, business version `0.1.0` and sealed Android build 002 remain unchanged by this proposal. No new paid infrastructure is requested; existing VM time/storage/IO/egress charges continue. Dev Box credentials, CLI extension installation, phone pairing, FCM and APK/store distribution remain outside this deployment plan.
