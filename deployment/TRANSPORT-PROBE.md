# Synthetic-only encrypted transport probe

`deployment\azure\probe.mjs` validates a possible **future** ciphertext-only Action Run Command transport. It is not a replacement upload/deploy command. It accepts neither a source-archive path nor an arbitrary VM, and it has no package-install, disk mount/format, Docker, relay, systemd, firewall, role or CA operation.

The probe creates new non-sensitive random synthetic files locally, packs exactly `synthetic.bin` and a purpose-marked manifest, and freezes their hashes. The small fixture has 512 bytes of content; the same-scale fixture has 44,993 bytes of content (the compressed archive is measured separately). No existing application source tar is read as fixture input.

## Scope and identity

A private `transport-probe-001\scope.local.json` must identify the explicitly approved VM/owner and preserved recovery plan. The CLI derives the target from the existing recovery/baseline and rejects disagreement. Every VM action rechecks the resource-group owner, VM identity, size and disk profile through the same explicitly tenant-scoped azd credential. The receiver also checks the exact VM resource ID through only IMDS `compute/resourceId`.

Probe approval is separate and bound to its plan hash, source fingerprint, immutable fixture hashes, unique transfer ID, target and expiry. Original provisioning/upload/deploy approvals cannot authorize it. All actions use the Action API, never a Managed Run Command resource.

## Bounded sequence

1. `inspect`: root Linux, existing Python/OpenSSL/`cryptography` availability only. Missing dependencies stop the test. Nothing is installed on the VM.
2. `init`: create only `/var/lib/devpocket-transport-probes/<unique-transfer-id>`, permissions 0700; a dedicated RSA-3072 private key is 0600. Return only public key and its SHA-256 fingerprint.
3. `small`: AES-256-GCM archive encrypted locally using Node's standard crypto; fresh AES key wrapped with RSA-OAEP-SHA256 to the authenticated VM public key. Python `cryptography` decrypts and verifies the approved SHA/manifest/synthetic file.
4. `begin-scale`, bounded `chunk` actions, `finish-scale`: repeat for the same-scale synthetic archive in at most eight 8-KiB ciphertext chunks. Repeated identical chunk/finalize actions must be idempotent; conflicting bytes are rejected without overwriting accepted content.
5. `negative`: modified GCM tag, wrong VM target and expired metadata are rejected. No candidate plaintext is written before authentication; no failed plaintext temporary file remains.
6. `audit`: selected visible VM handler/script/stdout/stderr/status logs are checked for the synthetic sentinels, private-key representations and unwrapped content-key representations. Only counts, scopes and bytes scanned are returned.
7. `cleanup`: remove only the exact owned transfer subdirectory and confirm its absence. Local synthetic fixtures are removed; memory-held sender content keys are cleared. Plan/digest/status receipts remain.

AAD binds protocol, probe-plan hash, VM ID, transfer ID, fixture identity/hash/size, expiry, recipient public-key fingerprint, algorithm and chunk size. The only ARM payload beyond a generic non-sensitive receiver is public metadata, authenticated ciphertext, GCM nonce/tag and an RSA-wrapped key. No plaintext source, Base64 plaintext source, private key, unwrapped AES key, full environment dump or raw decryption exception is sent to ARM output.

Each receiver has a 30-second internal alarm and 45-second outer process timeout, disables its own core dump, and returns at most 3,200 bytes. The reviewed client input budget is 96 KiB per Action request. These are **our probe bounds**, not claims about undocumented Azure input limits. Actual JSON request bytes are measured in each receipt. At most 20 Action submissions are allowed, one at a time.

Before each POST the client saves request hash, target, action and a local operation ID. It saves Azure operation/result URLs once returned, then polls read-only. A timeout/unknown response prevents another POST; `status` only inspects the known operation. A positively settled but unverified result may be cleaned up under the same cleanup-only authority. No blind long-command resubmission is performed.

## Tests and isolated local dependencies

The VM must already have the necessary libraries; there is no automatic `apt`/`pip` fallback.

Local cross-language tests require `cryptography` in an isolated test environment:

```powershell
python -m venv .tools\probe-python
.\.tools\probe-python\Scripts\python.exe -m pip install --isolated --no-cache-dir `
  -r deployment\azure\probe\requirements-test.txt
node --test deployment\azure\tests\probe.test.mjs
$env:PYTHONPYCACHEPREFIX = Join-Path $PWD '.data\probe-local-tests\pycache'
.\.tools\probe-python\Scripts\python.exe -m unittest discover `
  -s deployment\azure\probe -p 'test_*.py' -v
```

The tests use standard Node/OpenSSL and Python cryptographic implementations, including actual Node-to-Python interoperability. They also test forbidden archive arguments, output secret detection, duplicate handling, rejected mutations, and cleanup ownership.

## CLI

Only after the separately authorized private scope exists:

```powershell
$probe = '.data\azure\YOUR_ENV\transport-probe-001'
node deployment\azure\probe.mjs init-plan --directory $probe
# Review the new exact probe hash. This is not a relay/source-transfer approval.
node deployment\azure\probe.mjs approve --directory $probe --confirm $ProbeHash
node deployment\azure\probe.mjs run --directory $probe
```

`run-started.json` prevents starting the same probe afresh. Following any uncertain result, inspect with `status` rather than re-running; cleanup has a distinct phase. There is no `deploy`, `start`, real archive option, arbitrary script option, VM selector or restart-budget reset.

## Logging boundary and future real-source plan

The audit covers only the selected, bounded **visible guest logs** and the actual ARM results returned to this client. It cannot prove secrecy against Azure administrators, another root command, inaccessible Azure backend logs, arbitrary encodings, heap/swap inspection or every future build tool. A missing/incomplete visible-log scope or a match is a failed probe, not a success-shaped warning. Private-key protection relies on encryption, VM-local ownership and no plaintext export—not `protectedParameters`.

Even a successful synthetic probe does **not** authorize real source transfer or service installation. A new reviewed plan must freeze a real archive digest, keep the same recipient-key/target/expiry/authentication checks, add a separately audited safe import into the existing release/build procedure, verify build-error output handling, and explicitly authorize that source/activation scope. Its source fingerprint will differ. No current probe phase can be reused to send a real application package.

## Recorded synthetic acceptance (2026-10-02)

The separately approved probe actually completed **16 strictly sequential Action submissions**, each with one POST and a distinct Azure operation ID. Existing VM Python 3.12.3, OpenSSL and `cryptography` 41.0.7 were used; no VM dependency was installed.

- Authenticated, manifest-checked synthetic archives: **837 bytes** and **45,461 bytes**. The larger fixture carried 44,993 bytes of random synthetic content, transferred in six ciphertext chunks.
- Largest **actually accepted** JSON Action request: **36,369 bytes**, including the generic receiver and ciphertext encoding. The 96-KiB client budget is not a demonstrated Azure capacity.
- Wrong GCM tag, wrong target, expired metadata and conflicting duplicate content were rejected. Identical repeated chunk and finalize operations were idempotent.
- The guest audit read the selected visible handler, script, stdout/stderr, status and private probe-operation logs: 446,291 bytes with no oversize-file skips. No tested sentinel/private-key/content-key representations matched.
- Audit timing matters: visible guest logs were scanned immediately before cleanup; all 16 returned ARM results were also checked by the client. This does not inspect Azure backend logs, every possible encoding or every future cleanup/build handler log.
- The exact temporary guest transfer directory was removed and absence was checked in the settled cleanup action. Local synthetic archives/fixture metadata were removed and sender key buffers cleared. Generic Azure-agent-managed script/log caches may retain encrypted synthetic inputs; they were not broadly deleted, and no remaining recipient private key is claimed there.
- Read-only before/after comparison found VM identity/disks, both Public IP configurations, NIC and Storage configuration unchanged. The sealed native Android build 002 remains unchanged.

Private plan, fixture hashes, individual operation IDs/request hashes/results, log-scope counts, cleanup evidence and the **unapproved** real-transfer handoff draft are in the corresponding `.data\azure\<environment>\transport-probe-001` directory. No real source archive was transmitted, no data disk was mounted/formatted, and no Docker/relay/systemd/CA operation was performed.
