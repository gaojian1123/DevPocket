# DevPocket: azd + Bicep on one Azure Linux VM

**Status (2026-10-02):** separately authorized initial provisioning, [staged ingress recovery](AZURE-RECOVERY.md), and [encrypted frozen-release deployment](REAL-RELEASE.md) have executed. The relay image is running on the existing VM/data disk with a publicly trusted certificate; HTTPS health and unauthenticated HTTP/WSS rejection passed, including strict TLS checks against the assigned IP. Private Blob upload still failed and its retry budget remains exhausted. A later, separately scoped [test Dev Box onboarding](ONBOARDING.md) delivered a protected host credential and verified a dedicated ordinary CLI using a temporary simulated controller; physical-phone pairing remains pending. A confirmed subscription/region or successful what-if is **not** permission to create billable resources or repeat completed deployment actions.

This preserves DevPocket's existing architecture: **one Ubuntu VM, Docker Compose, Caddy HTTPS, SQLite on a local ext4 managed disk**. It is not Container Apps, AKS, shared-file SQLite or a multi-replica relay. No MobileTalk infrastructure/configuration is used. The Android app, relay version `0.1.0`, versionCode `1`, and sealed Android build 002 are unchanged.

For an already-created scoped Public IP that cannot resolve, use the separately reviewed [staged recovery procedure](AZURE-RECOVERY.md). It creates a new ordinary PIP in a separate phase, requires exact live DNS success before NIC/single-upload-IP replacement, preserves the old PIP/data, and never inherits the initial provisioning approval. The original large-template CLI path is blocked when a numbered recovery directory exists.

The initial hook/Blob workflow below remains its original contract, not an instruction to restart an exhausted upload or reprovision this environment. The executed real-release path used separate approval, standard encryption, authenticated local import and independent bootstrap/build/activation receipts. It added no Azure infrastructure or firewall/RBAC grants.

## Why there is Bicep, but no `host: vm`

`azure.yaml` points to subscription-scoped `infra/main.bicep`. It intentionally **omits `services`**, rather than declaring an unsupported `host: vm` or an empty `services: {}`. The VM application deployment is implemented by the official **project-level hooks**.

The installed **azd 1.25.5** is supported; no global upgrade is needed. Source verification at that exact azd commit establishes that service-free deployment work is an empty successful graph, while root `predeploy`/`postdeploy` hooks still run. `azd up` wires provision and deployment hooks in order. This is a source/schema compatibility check, not a claim that we have run a real provisioning command. [1–4]

The hooks are:

| Command | Hook/operation | What it establishes |
| --- | --- | --- |
| `azd provision` | `preprovision` | Validates an unexpired exact-plan approval, explicitly tenant-scoped azd identity, registered providers, and group ownership. No automatic provider registration. |
| `azd provision` | Native Bicep provision | Creates/updates the isolated resources listed below. **Billable mutation; not executed in preparation.** |
| `azd provision` | `postprovision` | Reads back expected VM/managed identity/data disk/Public IP. Records infrastructure evidence only; does not install/start the relay. |
| `azd deploy --all` | `predeploy` | Requires separate `upload`, `deploy` and `start` approvals for the exact source/target. |
| `azd deploy --all` | `postdeploy` | Packages a source allowlist, privately uploads it, bootstraps the VM, builds an immutable image, backs up local data and activates it. Separately reports each phase. |
| `node deployment\azure\cli.mjs public-check` | Public validation | Uses normal CA validation to check HTTPS health and unauthenticated HTTP/WSS rejection. **Not** paired-device or original-CLI acceptance. |
| `azd down` | `predown` | Always exits nonzero. Destructive teardown is intentionally not an automatic operation. |

Post-hooks are **not** `finally` handlers. A failed pre-hook/native action prevents its normal post-hook. The supported explicit fallback, if environment/native-command prerequisites cause a problem, is `azd hooks run predeploy` followed by `azd hooks run postdeploy` **only after the first succeeds**. Use the full configured hook names; an unknown name can print “No hooks found” and still return zero. [2–4]

## Planned resource inventory and cost decision

| Resource | Configuration/purpose |
| --- | --- |
| New resource group | `rg-devpocket-*`; tagged with application, azd environment and an independent deployment-owner UUID |
| One x64 Linux VM | Ubuntu 24.04 LTS, Trusted Launch; VM size must be explicitly supplied |
| OS managed disk | 32 GiB `StandardSSD_LRS`, `Detach` rather than implicit deletion |
| Data managed disk | 32 GiB by default, optionally 64/128/256; `StandardSSD_LRS`, LUN 0, ext4, `Detach`, `CanNotDelete` lock |
| Public IPv4 | Standard, static, regional; unique independent DNS label with `ResourceGroupReuse` protection |
| VNet/subnet/NSG/NIC | Explicit Public IP supplies outbound access; public inbound **TCP 80/443 only**; all other inbound denied, including SSH 22 and relay 8787 |
| Storage account/container | `StorageV2`, `Standard_LRS`, private `releases` Blob container; no anonymous access, no shared-key auth; TLS 1.2 minimum |
| Artifact network rules | Deny by default; permit only one explicitly approved operator public upload IPv4 and the new VM subnet's Storage service endpoint |
| Managed identity/RBAC | VM system identity: Blob Data Reader on **that container only**. Operator: Blob Data Contributor on **that container only**. No subscription-wide VM identity grants. |
| Artifact retention | Release blobs expire after 14 days; seven-day Blob/container soft deletion remains. VM release images/source directories are not automatically pruned. |

There is **no** ACR, Bastion, Load Balancer, NAT Gateway, Key Vault, Log Analytics workspace, Recovery Services/Backup vault or FCM project in this template. Managed boot diagnostics is enabled; the platform manages that diagnostic storage.

**Sizing:** the authorized `Standard_B2als_v2` (2 vCPU / 4 GiB) completed the frozen image build and initial activation. Images are built privately on the VM, and an update can build while the old relay still runs. `Standard_B1ms` (1 vCPU / 2 GiB) remains a lower-cost experiment, **not a tested minimum-memory promise**. Initial deployment is not a load-capacity benchmark; check current regional SKU restrictions, quota and capacity for any future provisioning. Do not silently resize after a failure.

Obtain a current Azure price/credit estimate for **VM + two disks + public IP + Blob capacity/requests + disk operations + outbound bandwidth**, including subscription-specific credits, taxes and currency. Published retail prices are not the subscription bill, and VM deallocation does not eliminate disk/IP/storage charges. No live price is hard-coded in the deployment.

## Identity, permissions and private transfer

The Node helper explicitly constructs:

```javascript
new AzureDeveloperCliCredential({
  tenantId: explicitlySelectedTenant,
  processTimeoutInMs: 30_000
});
```

This uses the user's **azd login**, not `az login`, `az account set` or `DefaultAzureCredential` fallback. The selected tenant matters: a personal account's default-tenant token can return no subscriptions even when a tenant-scoped token has the confirmed subscription. The helper validates token tenant/object claims in memory against the approved principal, without printing or persisting the bearer. [5]

The initial provisioner needs permission to create the resource group and the listed resources, plus the scoped RBAC assignments and data-disk lock. Subscription Owner is not the only possible arrangement: an administrator can provide an appropriately scoped deployment role and role-assignment permission. The runtime VM identity needs only container-level Blob read. Subsequent application operators need ARM VM read/Run Command plus the container upload role, not a VM-held subscription credential. Do not weaken organization policy to make deployment succeed.

The release is an **allowlist snapshot**, not a zip of the workspace. It contains the relay source/build files and cloud Compose/control files, never Android APKs, `.data`, `.azure`, `.env`, SQLite, uploaded content, host/device configurations, SDK paths or signing keys. Links and likely embedded private credentials are refused. The tarball has a manifest, per-file hashes and an immutable SHA-256 name.

Upload uses `AzureDeveloperCliCredential` over HTTPS into the private Blob container. The VM retrieves the object with its **system-managed identity via IMDS**, checks its SHA-256, rejects redirects, and validates archive paths/types/duplicate entries/file hashes before extraction. No SAS, account key, public GitHub repository or gist is used. Identity does not bypass storage network rules, and RBAC propagation can require a bounded wait. [6–8]

`DEVPOCKET_UPLOAD_IPV4` must be the actual public NAT/proxy egress address of the uploading host. A VM in the **same Azure region as the storage account** may use Azure-private source addressing that public IP rules do not match; in that case obtain an explicitly approved private/service-endpoint connectivity design or use an approved external uploading machine. The helper does not open the storage firewall broadly as a fallback.

No GitHub token is needed on the VM/relay. **Host pairing credentials are not created or transferred by provisioning/deploy hooks.** Commissioning a Dev Box remains a separate authorized step. Never retrieve a plaintext `host.local.json` using Run Command stdout, Bicep outputs, deployment logs or public Blob access. Use a separately approved encrypted handoff to the Dev Box (or an explicitly approved private management channel); keep plaintext only in protected local files on its endpoints. The current scripts do not enable SSH simply to transfer a secret.

## Project-local setup and parameters

Prerequisites: Node 26.12.1 or newer within 26.x, npm 12.2.1, azd 1.25.5+, PowerShell 7 on Windows, Python 3 for local script tests, and an explicit azd login for the target tenant. **az CLI authentication is not required.** Local Docker is optional: this path builds the relay image on the VM after deployment approval. The current machine had no Docker, so no local container execution is claimed.

From `C:\Projects\DevPocket`:

```powershell
npm --prefix deployment\azure ci --ignore-scripts
.\deployment\azure\prepare-tools.ps1
npm --prefix deployment\azure run validate
npm --prefix deployment\azure test
$env:PYTHONPYCACHEPREFIX = Join-Path $PWD '.data\azure-validation\pycache'
python -m unittest discover -s deployment\azure\tests -p '*_test.py' -v
```

Preparation downloads a checksum-verified standalone Bicep compiler and the official azd 1.25.5 schema/reference into ignored `.tools\bicep`, not a global installation. `validate` writes only local `.data\azure-validation` artifacts. On POSIX, provide a standalone compiler in `DEVPOCKET_BICEP` and the pinned schemas in the same project-local cache.

Use `deployment\azure\.env.example` as the parameter contract. Real values belong in the **project-local** azd environment or a private ignored JSON input file, not the public template:

| Setting | Required decision/value |
| --- | --- |
| `AZURE_ENV_NAME` | Independent name beginning `devpocket-` |
| `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` | Explicitly confirmed directory and subscription UUIDs |
| `AZURE_LOCATION` | Confirmed region; no regional default is embedded |
| `AZURE_RESOURCE_GROUP` | New `rg-devpocket-*` group; not another application's group |
| `DEVPOCKET_DEPLOYMENT_ID` | New independent owner UUID, stable for this one environment |
| `DEVPOCKET_DEPLOYER_OBJECT_ID` | Selected tenant's operator object ID, not an email and not an ID from another directory |
| `DEVPOCKET_VM_SIZE` | Explicitly approved x64 size and budget |
| `DEVPOCKET_DATA_DISK_GIB` | 32 default; allowed alternatives 64, 128 or 256 |
| `DEVPOCKET_DNS_LABEL` | Unique `devpocket-*` label; exact assigned FQDN comes from Azure |
| `DEVPOCKET_DOMAIN` | Empty for Azure-provided hostname; optionally an owned DNS hostname |
| `DEVPOCKET_TLS_EMAIL` | Explicitly approved certificate contact; can be the user's chosen account email |
| `DEVPOCKET_UPLOAD_IPV4` | Approved upload host's public egress IPv4; not `0.0.0.0/0` |
| `DEVPOCKET_SSH_PUBLIC_KEY` | Public RSA key required for VM creation; private key stays local; SSH is still closed |
| `DEVPOCKET_VM_AUTOSTART` | `false` default; opt in to this **new VM's** mount-aware systemd autostart separately; never touches Dev Box autostart |

After the operator confirms the values, example local configuration commands are:

```powershell
azd env new devpocket-YOUR_ENV
azd env set AZURE_TENANT_ID $ConfirmedTenantId
azd env set AZURE_SUBSCRIPTION_ID $ConfirmedSubscriptionId
azd env set AZURE_LOCATION $ConfirmedLocation
azd env set AZURE_RESOURCE_GROUP $NewDevPocketResourceGroup
# Set the remaining exact fields from the contract above in this environment.
# Do not run az account set, and do not copy another project's .azure directory.
node .\deployment\azure\cli.mjs plan
```

`azd env set` writes this project's `.azure` settings; it is not a request to change the global az CLI account. The standalone helper reads the current project's values with `azd env get-values --output json`; hook processes receive the values from azd. A local-only alternate is `--config .data\azure-input.local.json`, containing the same string-valued settings. It does not create an azd environment or perform a cloud call.

Generate an SSH public key only after authorization, using a new path under `.data\azure\<environment>` and never overwriting `%USERPROFILE%\.ssh` files. The key is a VM provisioning requirement, not an opened management route. Run Command remains the default management path.

For an explicitly authorized **local preparation only**, `node deployment\azure\init-local.mjs .data\azure-choices.local.json` creates a new owner UUID and dedicated 3072-bit RSA key in that environment's private `.data` directory. On Windows it restricts that new directory's ACL to the current user and SYSTEM before writing; it does not touch global SSH/az/azd configuration. It refuses existing keys/config rather than overwriting them, creates **no approval**, and performs no Azure/CA requests. The resulting `input.local.json` works with `cli.mjs plan --config <path>` before an azd environment is created.

## Azure-provided hostname instead of purchasing a domain

Azure Public IP supports a regional DNS hostname. With `domainNameLabelScope` it includes an extra protection hash, so **use Azure's returned `dnsSettings.fqdn`**. Do not concatenate a guessed `<label>.<region>.cloudapp.azure.com` string. The template's non-secret outputs include `DEVPOCKET_AZURE_FQDN` and `DEVPOCKET_PUBLIC_URL`. [9]

Caddy's documented automatic HTTPS/HTTP-01 requirements are a publicly resolvable hostname, inbound TCP 80/443, and persistent writable certificate storage. This supports using the Azure-provided hostname in principle and does not require purchasing a custom domain. Certificate issuance still depends on real DNS routing, CA policy and rate limits; **nothing has been requested from a CA during preparation**. [10–11]

## Approval, preview, provision and activation are distinct

`plan` prints the exact resource/configuration plan and a `planHash`. The hash includes target tenant/subscription/group, owner, VM/disks/network/DNS/contact, and the relevant local source files. A local approval is phase-specific, expires in at most four hours, and becomes invalid after source/config changes.

**Do not run these commands during preparation or before explicit user permission:**

```powershell
# Read-only ARM what-if, only after permission to access this confirmed target:
node .\deployment\azure\cli.mjs approve --phases preview --confirm $ReviewedPlanHash
node .\deployment\azure\cli.mjs preview

# After reviewing all resources/costs and explicitly authorizing provisioning:
node .\deployment\azure\cli.mjs approve --phases provision --confirm $ReviewedPlanHash --minutes 60
azd provision

# After explicitly authorizing private upload, VM installation and application start:
node .\deployment\azure\cli.mjs approve --phases upload,deploy,start --confirm $ReviewedPlanHash --minutes 120
azd deploy --all

# Or one combined approval and azd up, only when ALL phases are explicitly authorized.
```

The custom preview uses ARM what-if only and prints resource IDs/change types. It does not deploy resources. Native `azd provision --preview` also exists, but **azd 1.25.5 skips provisioning hooks for that flag**, so it does not run this helper's identity/ownership checks; prefer the guarded preview here. [1]

Read-only preflight records the selected tenant/principal match, enabled subscription, provider registration states, candidate RG existence/ownership and visible direct subscription roles. Direct roles are **not** a full effective-authorization proof (group assignments, conditions and policy can matter); ARM what-if authorizes the actual template. A denied role-discovery read is reported explicitly, not treated as proof of deployment permission. A blocked preview still saves its preflight/error evidence without registering providers or creating a partial deployment.

Application phase alternatives:

```powershell
# Requires upload + deploy approval; builds but does not start/restart the application:
node .\deployment\azure\cli.mjs prepare-deploy

# Requires start approval for the unchanged prepared plan:
node .\deployment\azure\cli.mjs start

# Separate network smoke check, using normal platform certificate validation:
node .\deployment\azure\cli.mjs public-check
```

Run Command executes as root through the Azure VM agent; it needs Azure outbound connectivity, but no public SSH port. The helper uses official Compute SDK Action Run Command polling, sets a 40-minute client limit, does not automatically resubmit an ambiguous command, and requires a phase-specific success marker from the script. HTTP 200/202 or a native “deployment succeeded” message alone is not enough. If the client times out, **execution may continue on the VM**: inspect it before retrying. The script also takes an exclusive operations lock. [6–7]

Logs are root-only at `/var/log/devpocket-operations.log`; normal local/ARM output is phase evidence, not full logs, bearer tokens, SQLite content or host credentials. No `set -x` or credential values are embedded in cloud-init—there is **no cloud-init payload** in this template.

## VM persistence, updates, backups and rollback

`/srv/devpocket` is the separate data disk. The bootstrap only recognizes approved LUN 0 and disk size, refuses partitioned/in-use/unowned disks, never reformats a previously initialized filesystem, checks ownership, and requires the mount before operating. It does not silently use an OS directory if the data disk is absent.

Persistent paths:

- `relay`: SQLite/WAL and bounded uploaded content, owned by container UID 1000.
- `caddy-data` / `caddy-config`: private ACME account/certificate state.
- `releases`: immutable source snapshots named by package SHA-256.
- `backups`: local snapshots; SQLite uses its consistent backup interface.
- `private`: reserved root-only operator material; no host credentials are generated automatically.

The cloud Compose project is specifically `devpocket-azure`. The relay is non-root, read-only, drops capabilities and keeps 8787 on container loopback. Caddy shares that network namespace and is the only public 80/443 listener. Logs rotate. Docker's restart policy remains `no`; optional systemd autostart is mount-aware and only enabled when the approved plan requests it.

An update builds the new image before taking the old application down. Startup backs up the local data, restarts Compose and checks internal health; a failed new startup attempts to restart the recorded previous release and returns failure. **It never rewinds SQLite automatically**, which could resurrect command IDs or lose accepted tasks. A change to `backend/src/store.ts` is refused as a possible schema migration until a separately reviewed migration/rollback design is provided.

Images/configuration are tied to the immutable release: the application image gets owner/source labels and is not rebuilt over an existing identical release tag; Caddy's first approved pull is resolved to a digest and saved with its image ID. Each release has its own environment file. Merely preparing a release cannot change what the existing release or the autostart unit starts on reboot.

The uploaded archive also binds the non-secret deployment owner, resolved hostname, ACME contact and VM-autostart choice. A reviewed endpoint/configuration change therefore creates a different release digest without inventing a new Android version. The local-only `package`/validation archive omits this live binding and is not by itself an approved upload/activation receipt.

```powershell
# After separately approving backup:
node .\deployment\azure\cli.mjs backup

# After separately approving rollback:
node .\deployment\azure\cli.mjs rollback --release $RecordedPreviousPackageSha256
```

Rollback only accepts the recorded previous release, not an arbitrary directory. It is application rollback, not rollback of Azure infrastructure, DNS, configuration or user data. Local backup is **not off-VM disaster recovery**. Off-VM encrypted backup/snapshot policy requires a separate cost/access decision; it is not silently provisioned here. Monitor OS/data space and explicitly prune old DevPocket images/backups only after confirming rollback/retention needs—no broad Docker prune or volume deletion is automated.

The data disk has a delete lock. `azd down` is deliberately blocked even with `--force`; an authorized operator must review exact resources, backups and the lock before any manual teardown. Native Azure access by an owner is not made impossible by these local guardrails.

## Validation completed in preparation

Local validation covers the official **azd 1.25.5** schema (including its referenced schema at the same commit), Bicep compile/resource contracts, no customData/secrets, only 80/443 ingress, immutable private package whitelist and link denial, approval expiry/phase/source binding, real unapproved hook entry-point rejection, existing-resource ownership, and Run Command evidence checks. Python tests exercise safe extraction and failure rollback with a real local SQLite database; Docker/ARM/IMDS are simulated at the external interface.

Original preparation results: **8 Node deployment tests and 4 Python tests passed**, official-schema validation and Bicep **0.47.16** compilation passed, deployment dependency audit reported no advisories, and the existing 20 backend regressions/typecheck passed. The accepted Android APK hash and all 32 recorded Android source/build-input hashes were unchanged. At that preparation checkpoint no mutation approval or `.azure` environment existed; later user-authorized initial provisioning is recorded separately, and original receipts/approvals are preserved rather than rewritten by recovery.

After explicit read-only authorization, tenant-scoped Azure preflight and official ARM what-if succeeded for the private candidate plan. The candidate RG was absent; Compute/Network/Storage providers were already registered; the selected principal's subscription Owner assignment was visible. What-if returned only **Create** changes, with no Modify/Delete. This is not provisioning or a capacity guarantee. The exact private resource IDs, plan hash, timestamps and preflight results are preserved in that environment's `plan.json` and `what-if.json`, not hard-coded here. Azure's implicit OS disk is configured under the VM and is a billable second disk even though it is not separately enumerated in the explicit what-if change list.

**Actual deployment evidence:** the separate real-release operation verified the frozen archive/GCM/manifest, initialized and mounted the owned data disk under the original safeguards, installed Docker, imported the immutable release, removed its temporary transfer keys/files, built the image and activated the relay/Caddy. Public DNS, trusted ACME TLS, health and unauthorized HTTP/WSS rejection passed. One completed ciphertext-chunk Action required read-only result reconciliation after a client credential-read interruption; it was not posted again. Original failure evidence and explicit continuation receipts are retained.

**Still incomplete/excluded:** successful Blob upload, physical-phone pairing/acceptance, configured FCM, off-VM disaster recovery and a real VM-reboot recovery test. The later test-host commissioning establishes only its named Dev Box/dedicated ordinary CLI and simulated-device roundtrip, not access to all user repositories. Autostart is configured only on the new cloud VM. Local Docker remains unnecessary. Passing public smoke checks does not establish the excluded end-to-end access or operational tests.

The new deployment dependency manifest is isolated in `deployment\azure`; no Android version bump or new APK is needed for IaC-only work. Track deployment revisions by `schemaVersion: 1`, `planHash` and immutable package SHA-256. Any future relay protocol/schema behavior change needs its own relay/client compatibility/version review; actual deployment is not authorization for APK distribution or release signing.

## Primary sources

1. [azd 1.25.5 provisioning hooks and preview exemption](https://github.com/Azure/azure-dev/blob/5516392dfb9e3e07567ae23e3109f81c33d78606/cli/azd/cmd/root.go#L310-L333).
2. [Exact-version root hook middleware](https://github.com/Azure/azure-dev/blob/5516392dfb9e3e07567ae23e3109f81c33d78606/cli/azd/cmd/middleware/hooks.go#L76-L114), [empty execution graph](https://github.com/Azure/azure-dev/blob/5516392dfb9e3e07567ae23e3109f81c33d78606/cli/azd/pkg/exegraph/scheduler.go#L90-L113), and [zero-service `up` branch](https://github.com/Azure/azure-dev/blob/5516392dfb9e3e07567ae23e3109f81c33d78606/cli/azd/internal/cmd/up_graph.go#L432-L465).
3. [Official schema at the installed version](https://github.com/Azure/azure-dev/blob/5516392dfb9e3e07567ae23e3109f81c33d78606/schemas/v1.0/azure.yaml.json), [hook documentation](https://learn.microsoft.com/azure/developer/azure-developer-cli/azd-extensibility).
4. [Exact-version `azd hooks run`](https://github.com/Azure/azure-dev/blob/5516392dfb9e3e07567ae23e3109f81c33d78606/cli/azd/cmd/hooks.go#L208-L238), [pre-hook failure blocks action](https://github.com/Azure/azure-dev/blob/5516392dfb9e3e07567ae23e3109f81c33d78606/cli/azd/pkg/ext/hooks_runner.go#L75-L94).
5. [AzureDeveloperCliCredential](https://learn.microsoft.com/javascript/api/@azure/identity/azuredeveloperclicredential?view=azure-node-latest), [implementation using azd and tenant options](https://github.com/Azure/azure-sdk-for-js/blob/main/sdk/identity/identity/src/credentials/azureDeveloperCliCredential.ts).
6. [Linux Action Run Command and restrictions](https://learn.microsoft.com/azure/virtual-machines/linux/run-command), [REST contract](https://learn.microsoft.com/rest/api/compute/virtual-machines/run-command?view=rest-compute-2025-04-01).
7. [Compute permission reference](https://learn.microsoft.com/azure/role-based-access-control/permissions/compute#microsoftcompute).
8. [Blob data roles](https://learn.microsoft.com/azure/storage/blobs/assign-azure-role-data-access), [network restrictions](https://learn.microsoft.com/azure/storage/common/storage-network-security), [managed-identity authorization](https://learn.microsoft.com/azure/storage/common/storage-use-azcopy-authorize-managed-identity).
9. [Azure Public IP DNS label and scope](https://learn.microsoft.com/azure/virtual-network/ip-services/public-ip-addresses#domain-name-label).
10. [Caddy automatic HTTPS requirements](https://caddyserver.com/docs/automatic-https#overview).
11. [Let's Encrypt HTTP-01 validation](https://letsencrypt.org/docs/challenge-types/#http-01-challenge).
