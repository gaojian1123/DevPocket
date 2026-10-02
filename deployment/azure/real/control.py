"""Small verified-local importer/controller. Frozen business code stays on VM."""
import base64
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import time
import urllib.request

DATA = Path("/srv/devpocket")
TRANSFERS = Path("/var/lib/devpocket-real-transfers")
LOCK_FILE = Path("/run/lock/devpocket-real-release.lock")
LOG_DIRECTORY = Path("/var/lib/devpocket-real-operation-logs")
PROTOCOL = "DevPocketEncryptedRelease/1"


class ControlError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ControlError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def transfer(plan):
    require(re.fullmatch(r"[a-f0-9-]{36}", plan["transferId"]), "TRANSFER_SCOPE")
    path = TRANSFERS / plan["transferId"]
    require(not path.is_symlink() and not TRANSFERS.is_symlink(), "TRANSFER_LINK")
    return path


def release(plan):
    require(re.fullmatch(r"[a-f0-9]{64}", plan["business"]["archiveSha256"]), "RELEASE_SCOPE")
    return DATA / "releases" / plan["business"]["archiveSha256"]


def state_dir(plan):
    require(re.fullmatch(r"[a-f0-9]{64}", plan["planHash"]), "PLAN_SCOPE")
    return DATA / "real-release-receipts" / plan["planHash"]


def binding(plan):
    return {"planHash": plan["planHash"], "vmId": plan["vmId"], "transferId": plan["transferId"],
            "packageSha256": plan["business"]["archiveSha256"], "manifestSha256": plan["business"]["manifestSha256"],
            "originSourceHash": plan["business"]["originSourceHash"], "transportSourceHash": plan["transportSourceHash"]}


def record(plan, phase, details):
    root = state_dir(plan)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(not root.is_symlink(), "STATE_LINK")
    value = {**binding(plan), "phase": phase, "status": "succeeded", **details}
    file = root / (phase + ".json")
    if file.exists():
        require(json.loads(file.read_text()) == value, "RECEIPT_CONFLICT")
        return value
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(value, output)
    return value


def required_receipt(plan, phase):
    file = state_dir(plan) / (phase + ".json")
    require(file.is_file() and not file.is_symlink(), "SUCCESS_RECEIPT_REQUIRED")
    value = json.loads(file.read_text())
    require(value["status"] == "succeeded" and all(value.get(k) == v for k, v in binding(plan).items()), "RECEIPT_BINDING")
    return value


def verified_quarantine(plan):
    root = transfer(plan)
    require(json.loads((root / "owner.json").read_text()) == plan, "TRANSFER_OWNER")
    receipt = json.loads((root / "authenticated.json").read_text())
    require(receipt["authenticatedGcm"] is True and receipt["planHash"] == plan["planHash"] and
            receipt["sha256"] == plan["business"]["archiveSha256"] and
            receipt["manifestSha256"] == plan["business"]["manifestSha256"], "AUTHENTICATED_IMPORT_REQUIRED")
    path = root / "quarantine"
    verify_files(plan, path)
    return path


def verify_files(plan, root):
    require(root.is_dir() and not root.is_symlink(), "VERIFIED_RELEASE_REQUIRED")
    manifest = root / "release-manifest.json"
    require(sha(manifest.read_bytes()) == plan["business"]["manifestSha256"], "MANIFEST_HASH")
    entries = json.loads(manifest.read_text())["files"]
    require(len(entries) == plan["business"]["fileCount"], "MANIFEST_COUNT")
    for file in root.rglob("*"):
        require(not file.is_symlink(), "RELEASE_LINK")
    for item in entries:
        require(re.fullmatch(r"[A-Za-z0-9_./-]+", item["name"]) and
                all(p not in ["", ".", ".."] for p in item["name"].split("/")), "MEMBER_PATH")
        file = root / item["name"]
        require(file.is_file() and sha(file.read_bytes()) == item["sha256"], "MEMBER_HASH")


def service_config(plan):
    return {**plan["serviceBinding"], "dataDiskGiB": plan["dataDiskGiB"],
            "releaseId": plan["business"]["archiveSha256"]}


def no_blob(*_args, **_kwargs):
    raise ControlError("BLOB_PATH_FORBIDDEN")


def load_frozen_control(plan, root):
    verify_files(plan, root)
    file = root / "deployment" / "azure" / "vm" / "control.py"
    require(sha(file.read_bytes()) == plan["business"]["controlSha256"], "FROZEN_CONTROL_HASH")
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("devpocket_frozen_control", file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    require(module.ROOT == DATA and module.STATE == Path("/var/lib/devpocket"), "FROZEN_CONTROL_PATHS")
    module.download = no_blob
    require(not module.LOG.is_symlink(), "CONTROL_LOG_LINK")
    module.LOG.touch(mode=0o600, exist_ok=True)
    os.chmod(module.LOG, 0o600)
    return module


def bootstrap(plan):
    root = verified_quarantine(plan)
    module = load_frozen_control(plan, root)
    module.bootstrap(service_config(plan))
    module.assert_owner(service_config(plan))
    require(DATA.is_mount(), "LOCAL_DISK_MOUNT_REQUIRED")
    record(plan, "bootstrap", {"dataDiskGiB": plan["dataDiskGiB"], "ownerVerified": True})
    return {"status": "bootstrap_verified", "dataDiskGiB": plan["dataDiskGiB"], "ownerVerified": True}


def import_release(plan):
    required_receipt(plan, "bootstrap")
    source = verified_quarantine(plan)
    module = load_frozen_control(plan, source)
    module.assert_owner(service_config(plan))
    target = release(plan)
    staging = DATA / "releases" / (".incoming-" + plan["transferId"])
    require(staging.parent == DATA / "releases" and not staging.is_symlink(), "IMPORT_SCOPE")
    if not target.exists():
        require(not staging.exists(), "UNSETTLED_IMPORT_REQUIRES_INSPECTION")
        try:
            shutil.copytree(source, staging)
            verify_files(plan, staging)
            staging.rename(target)
        except BaseException:
            if staging.exists() and not staging.is_symlink():
                shutil.rmtree(staging)
            raise
    verify_files(plan, target)
    record(plan, "import", {"authenticatedLocalArchive": True, "blobUploadReceipt": False})
    return {"status": "release_imported", "packageSha256": plan["business"]["archiveSha256"],
            "authenticatedLocalArchive": True, "blobUsed": False}


def build(plan):
    required_receipt(plan, "bootstrap")
    required_receipt(plan, "import")
    target = release(plan)
    module = load_frozen_control(plan, target)
    module.assert_owner(service_config(plan))
    module.prepare_release(service_config(plan))
    prepared = json.loads((DATA / "prepared.json").read_text())
    require(prepared["releaseId"] == plan["business"]["archiveSha256"], "BUILD_RECEIPT_MISMATCH")
    state = json.loads((target / "deployment-state.json").read_text())
    require(state["deploymentId"] == plan["serviceBinding"]["deploymentId"] and
            state["releaseId"] == plan["business"]["archiveSha256"], "IMAGE_OWNER")
    details = {"imageId": state["imageId"], "caddyImage": state["caddyImage"], "blobUsed": False}
    record(plan, "build", details)
    return {"status": "image_built", **details}


def activate(plan):
    required_receipt(plan, "bootstrap")
    required_receipt(plan, "import")
    built = required_receipt(plan, "build")
    target = release(plan)
    module = load_frozen_control(plan, target)
    module.assert_owner(service_config(plan))
    state = json.loads((target / "deployment-state.json").read_text())
    require(state["imageId"] == built["imageId"] and state["caddyImage"] == built["caddyImage"], "IMAGE_CHANGED")
    module.activate(service_config(plan))
    current = json.loads((DATA / "current.json").read_text())
    require(current["releaseId"] == plan["business"]["archiveSha256"], "ACTIVATION_RECEIPT")
    record(plan, "activate", {"internalHealth": True, "autostart": plan["serviceBinding"]["autostart"]})
    return {"status": "service_activated", "internalHealth": True, "autostart": plan["serviceBinding"]["autostart"],
            "publicTlsVerified": False, "phonePairingVerified": False}


def control_audit(plan):
    required_receipt(plan, "import")
    root = release(plan)
    verify_files(plan, root)
    fragments = []
    for item in json.loads((root / "release-manifest.json").read_text())["files"]:
        if item["name"].endswith((".ts", ".mjs", ".py")):
            body = (root / item["name"]).read_bytes()
            if len(body) >= 192:
                fragments += [body[:192], body[max(0, len(body) // 2 - 96):max(0, len(body) // 2 - 96) + 192], body[-192:]]
    files = [("handler", Path("/var/log/azure/run-command/handler.log"))]
    downloads = Path("/var/lib/waagent/run-command/download")
    if downloads.exists():
        for child in list(downloads.iterdir())[:128]:
            if child.is_dir() and not child.is_symlink() and re.fullmatch(r"\d+", child.name):
                files += [("output", child / "stdout"), ("output", child / "stderr")]
    scopes = {"handler": 0, "output": 0}
    count = size = matches = skipped = 0
    for scope, file in files:
        if not file.is_file() or file.is_symlink():
            continue
        length = file.stat().st_size
        if length > 1024 * 1024 or size + length > 8 * 1024 * 1024:
            skipped += 1
            continue
        body = file.read_bytes()
        count += 1
        scopes[scope] += 1
        size += length
        matches += sum(body.count(fragment) for fragment in fragments)
    return {"status": "control_log_audit", "files": count, "bytes": size, "sourceFragmentMatches": matches,
            "skipped": skipped, "scopeFiles": scopes, "completeForVisibleScope": all(scopes.values()) and skipped == 0,
            "protectedBuildLogsExported": False,
            "boundary": "Selected handler/stdout/stderr only; not all Azure/backend/future logs or administrator secrecy"}


def main(payload):
    import fcntl
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    plan, action = payload["plan"], payload["action"]
    limits = {"bootstrap": 1200, "import": 30, "build": 1800, "activate": 300, "control-audit": 30}
    try:
        require(plan["protocol"] == PROTOCOL and action in limits and os.geteuid() == 0, "ACTION_SCOPE")
        require(int(time.time() * 1000) < plan["expiresAt"], "EXPIRED")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(urllib.request.Request(
                "http://169.254.169.254/metadata/instance/compute/resourceId?api-version=2021-02-01&format=text",
                headers={"Metadata": "true"}), timeout=2) as response:
            require(response.read(2048).decode().strip().lower() == plan["vmId"].lower(), "VM_TARGET_MISMATCH")
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(ControlError("PHASE_TIME_LIMIT")))
        signal.alarm(limits[action])
        with LOCK_FILE.open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            log_root = LOG_DIRECTORY
            log_root.mkdir(mode=0o700, exist_ok=True)
            require(not log_root.is_symlink() and re.fullmatch(r"[a-f0-9]{64}", plan["planHash"]), "LOG_SCOPE")
            file = log_root / (plan["planHash"] + "-" + action + ".log")
            fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "w") as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                if action == "bootstrap":
                    result = bootstrap(plan)
                elif action == "import":
                    result = import_release(plan)
                elif action == "build":
                    result = build(plan)
                elif action == "activate":
                    result = activate(plan)
                else:
                    result = control_audit(plan)
    except BaseException as error:
        result = {"status": "failed", "code": str(error) if isinstance(error, ControlError) else type(error).__name__,
                  "databaseRolledBack": False, "unrelatedResourcesRemoved": False}
    encoded = json.dumps(result, separators=(",", ":"))
    require(len(encoded.encode()) <= 3200, "OUTPUT_LIMIT")
    print("DEVPOCKET_REAL_RESULT=" + encoded, flush=True)
    signal.alarm(0)


if __name__ == "__main__":
    main(json.loads(base64.b64decode("__DEVPOCKET_REAL_PAYLOAD__")))
