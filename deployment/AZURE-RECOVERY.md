# Staged Azure ingress/upload recovery

This recovery is for an **already-owned DevPocket resource group**, not a second application deployment. Its only proposed infrastructure differences are:

- A **new** ordinary Standard static IPv4 Public IP with a new independent DNS label and **no** `domainNameLabelScope`.
- After the new IP's real Azure-returned DNS name resolves correctly, change the existing NIC's Public IP reference and replace the Storage account's **one exact public upload IPv4**. Do not add a range or a second rule.

The original scoped Public IP, its address/label/scope, VM, OS/data disks, deletion lock, network/subnet/NSG, storage contents and container-scoped identities are retained. No data migration, VM resize/restart/deallocation, old-PIP deletion, GitHub credential, phone pairing, FCM or Android release is part of these phases.

**Preparation and ARM What-if are not change authorization.** This workflow requires a separately approved recovery plan. An older `provision` approval is not accepted.

**Recorded execution:** recovery-001 subsequently completed its separately authorized new-PIP, dual-DNS and NIC/single-upload-IP switch stages. Both PIPs were retained. The actual private Blob upload still returned 403 after its allowed attempts; that budget is exhausted and must not be reset. The later [real-release path](REAL-RELEASE.md) delivered the frozen business package with independent encrypted transport/approval, without widening Storage access.

## Why two templates and a DNS gate

Microsoft documents Domain Name Label Scope as a **create-time-only public-preview** property. It must not be removed in place on an existing PIP as a purported repair. A returned hostname is used as-is; the workflow never substitutes a guessed suffix. See [the official Public IP documentation](https://learn.microsoft.com/azure/virtual-network/ip-services/public-ip-addresses#domain-name-label-scope-preview).

`infra\recovery\create-ingress.bicep` contains **only the new PIP**. It has no NIC or Storage declaration.

`infra\recovery\switch-ingress.bicep` contains **only the existing NIC and Storage account**. It is a later phase, never deployed by the new-PIP phase. Its runtime gate:

1. Reads the exact owned new resource and checks `Standard`, `Static`, `IPv4`, `Succeeded`, the approved label and absence of scope.
2. Takes the FQDN and IP **from Azure**, rather than synthesizing a hostname.
3. Requires Google and Cloudflare public DNS A answers to contain **only that new IP**. NXDOMAIN, mismatches, unavailable resolvers, stale evidence or another resource/ETag fail closed.
4. Binds evidence to the recovery plan/resource/ETag/FQDN/IP and a maximum 15-minute age.
5. Runs a fresh small-phase What-if and checks both resource IDs/change types and leaf-level property deltas before submitting any change.

Without successful DNS evidence the workflow cannot switch the NIC, produce the deployment's URL-bound release package, upload source, execute VM commands, start Caddy or request a certificate. Application operations additionally require the completed network-switch receipt and recheck live NIC/Storage/DNS state.

Local archive unit tests may use fixture packages. Use `validate --no-package` during recovery preparation to avoid producing any real application archive before the live gate.

## Independent state and approvals

Create a new ignored directory `.data\azure\<existing-environment>\recovery-NNN`. Preserve—not overwrite—the original plan, input, approval, resource receipts, failed-upload evidence and original package.

Files in the recovery directory:

- `base-plan.json`: immutable original plan with its original hash.
- `base-input.local.json`: preserved original non-secret parameter snapshot; the original private key is **not regenerated**.
- `baseline.json`: read-only live original PIP/NIC/Storage/VM/VNet snapshot.
- `input.local.json`: only recovery number, original plan hash, expected new PIP name, new DNS label and replacement single IPv4.
- `plan.json`: separate recovery hash and current deployment source fingerprint; retains the original owner, environment, VM and permissions.
- `approval.local.json`: **recovery-only** phases/expiry/hash. `original-approval.evidence.json` is evidence, never an active grant.
- `what-if-create-ingress.json` / `what-if-switch-ingress.json`: separate official ARM predictions, templates and exact parameters.

The new resource name is constrained to `<original-pip-name>-rNNN`; arbitrary resource-group/subscription/size/role changes cannot be smuggled into recovery input. Other changes require another reviewed design.

Once a recovery directory exists, the old initial `cli.mjs`/large `azd provision` and unselected `azd deploy` path refuse to overwrite original evidence or reapply the original ingress configuration. Recovery uses the same **explicitly tenant-scoped azd identity** and official ARM deployments, not az CLI login or an invented `host: vm`. After the infrastructure stages and explicit activation authorization, a project-local `DEVPOCKET_RECOVERY_ID=001` routes the existing azd application hooks through the recovery gates.

## Local preparation and read-only previews

```powershell
npm --prefix deployment\azure test
npm --prefix deployment\azure run validate -- --no-package
$env:PYTHONPYCACHEPREFIX = Join-Path $PWD '.data\azure-validation\pycache'
python -m unittest discover -s deployment\azure\tests -p '*_test.py' -v

$recovery = '.data\azure\YOUR_ENV\recovery-001'
node deployment\azure\recovery.mjs plan --directory $recovery

# Only after explicit read-only preview authorization:
node deployment\azure\recovery.mjs approve --directory $recovery `
  --phases preview --confirm $ReviewedRecoveryHash --minutes 90
node deployment\azure\recovery.mjs preview --directory $recovery
```

The later switch preview can be computed before a PIP exists. It is **hypothetical, not ready to execute**; the preview does not create the PIP or supply a fake DNS success receipt.

Expected resource changes:

| Phase | Create | Modify | Delete |
| --- | --- | --- | --- |
| New ingress | New ordinary PIP only | None | None |
| Later switch | None | Existing NIC's `publicIPAddress.id`; Storage's sole `ipRules[0].value` | None |

The guard also rejects changes to unrelated properties such as IP forwarding, shared-key access, permissive firewall defaults, storage identities or VM/disks. Read-only `Ignore` resources from incremental What-if are not mutations.

### Provider-returned NIC metadata

The actual NIC exposes `kind: Regular` and `allowPort25Out: false`, even though those fields are absent from the consulted published NIC type schema. Omitting them caused ARM What-if to display unrelated removals. The switch template deliberately preserves those exact reviewed values, as well as `disableTcpStateTracking`, `auxiliaryMode`, `auxiliarySku`, private IP and DNS settings.

Bicep reports **BCP187 for `kind`**; this known schema mismatch is **not suppressed**, and is not represented as a warning-free compile. Official ARM What-if must show no change to either metadata value. The authorized recovery-001 update accepted the reviewed preserved fields. Future API/update acceptance is not implied: if Azure rejects a later operation, stop and inspect partial phase state rather than stripping fields, weakening validation or blindly retrying.

## Future separately authorized mutations

The following are **not** authorized merely by preparing the plan or passing What-if.

```powershell
# User approves only new PIP creation:
node deployment\azure\recovery.mjs approve --directory $recovery `
  --phases preview,create-ingress --confirm $ReviewedRecoveryHash
node deployment\azure\recovery.mjs create-ingress --directory $recovery
node deployment\azure\recovery.mjs check-dns --directory $recovery

# Only with new-DNS success and explicit NIC/firewall switch authorization:
node deployment\azure\recovery.mjs approve --directory $recovery `
  --phases preview,switch-ingress --confirm $ReviewedRecoveryHash
node deployment\azure\recovery.mjs switch-ingress --directory $recovery

# Only with the completed switch and explicit private upload/runtime activation approval:
node deployment\azure\recovery.mjs approve --directory $recovery `
  --phases upload,deploy,start --confirm $ReviewedRecoveryHash --minutes 120
node deployment\azure\recovery.mjs deploy --directory $recovery
node deployment\azure\recovery.mjs public-check --directory $recovery
```

For the azd application-deployment path after the same approvals/gates, set only the project environment selection and invoke the existing custom hooks:

```powershell
azd env set DEVPOCKET_RECOVERY_ID 001
azd deploy --all
```

This selection does not approve any operation and does not re-run the initial large infrastructure template. It dispatches `predeploy`/`postdeploy` to the exact recovery directory; all independent recovery receipts and approvals remain required. Do not use `azd up` or `azd provision` to skip the new-IP/DNS sequencing.

`prepare-deploy` needs only `upload,deploy` and leaves startup for the separately approved `start` command. All approvals are exact-plan/source-bound and expire in at most four hours.

There is no automatic IP-rule chasing. Recovery upload has **one initial attempt plus at most one retry**, with SDK transport retries disabled for this path, the identical immutable object/digest and bounded timeouts. Persistent 403/network failure stops. An external IP echo does not prove which source Azure Blob sees; the actual private Blob operation is the acceptance check. No CIDR, public access, shared key, SAS or new VM write role is a fallback.

An ambiguous ARM deployment response is recorded `failed-or-uncertain`; execution may continue. Inspect its recorded deployment URI/status before retrying. No rollback/deletion of the old PIP is implemented or authorized.

## Cost and security differences

The old and new Standard public IPv4 resources coexist. The additional new IPv4 has the publicly quoted reference charge **USD 0.005/hour**, approximately **USD 3.65 per 730-hour month** while both are retained, in addition to the previous VM/disks/IP/storage/IO/egress costs. This is not a tax-inclusive subscription bill, hard budget cap or future price guarantee.

The ordinary label avoids reliance on the scoped preview DNS behavior but **does not have scope-based dangling-name reuse protection**. Keep the PIP/label while referenced; remove stale DNS/client references before any future separately approved deletion. The actual new address and FQDN are unknown until Azure allocates them; allocation, capacity and certificate issuance are not guaranteed by What-if.

NIC transition changes the public endpoint and can interrupt existing connections. Here, original-CLI/phone commissioning remains separate and no working user session is to be restarted. Keep the old PIP untouched and chargeable until its cleanup is explicitly authorized.

Android/relay remain `0.1.0`; sealed Android build 002 is unchanged. Infrastructure/operation revisions are identified by the independent recovery plan hash, source fingerprint, phase receipts and subsequent URL-bound package SHA, not a fabricated Git commit or Android version bump.
