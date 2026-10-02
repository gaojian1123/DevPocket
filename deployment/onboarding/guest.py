"""Fixed-image host onboarding; no service restart, disk bootstrap or network change."""
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import time
import urllib.parse
import urllib.request


def require(value, code):
    if not value:
        raise RuntimeError(code)


def command(args, data=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40)
    require(result.returncode == 0, "GUEST_COMMAND_FAILED")
    require(len(result.stdout) <= 256 * 1024, "GUEST_OUTPUT_BOUND")
    return result.stdout


def context(scope, discovering=False):
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(urllib.request.Request(
        "http://169.254.169.254/metadata/instance/compute/resourceId?api-version=2021-02-01&format=text",
        headers={"Metadata": "true"}), timeout=2) as response:
        require(response.read(2048).decode().strip().lower() == scope["vmId"].lower(), "VM_TARGET_MISMATCH")
    if scope.get("vmUniqueId"):
        with opener.open(urllib.request.Request(
            "http://169.254.169.254/metadata/instance/compute/vmId?api-version=2021-02-01&format=text",
            headers={"Metadata": "true"}), timeout=2) as response:
            require(response.read(2048).decode().strip().lower() == scope["vmUniqueId"].lower(), "VM_INSTANCE_CHANGED")
    root = Path("/srv/devpocket")
    require(root.is_mount() and not root.is_symlink(), "OWNED_DATA_MOUNT_REQUIRED")
    require((root / ".owner").read_text().strip() == scope["deploymentId"] and
            Path("/var/lib/devpocket/owner").read_text().strip() == scope["deploymentId"], "OWNER_MISMATCH")
    release_id = json.loads((root / "current.json").read_text())["releaseId"]
    require(re.fullmatch(r"[a-f0-9]{64}", release_id), "RELEASE_ID_INVALID")
    require(discovering or release_id == scope["releaseId"], "RELEASE_CHANGED")
    ids = command(["docker", "ps", "--filter", "label=com.docker.compose.project=devpocket-azure",
                   "--filter", "label=com.docker.compose.service=relay", "--format", "{{.ID}}"]).decode().split()
    require(len(ids) == 1 and re.fullmatch(r"[a-f0-9]{12,64}", ids[0]), "EXACT_RELAY_CONTAINER_REQUIRED")
    container = json.loads(command(["docker", "inspect", ids[0]]))[0]
    require((discovering or container["Image"] == scope["imageId"]) and container["State"]["Running"] and
            container["State"].get("Health", {}).get("Status") == "healthy", "LIVE_IMAGE_OR_HEALTH_CHANGED")
    require(not scope.get("containerId") or ids[0] == scope["containerId"], "RELAY_CONTAINER_CHANGED")
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", container["Image"]), "RELAY_IMAGE_INVALID")
    if discovering:
        require(container["Config"]["Image"] == "devpocket-relay:" + release_id, "RELAY_RELEASE_IMAGE_MISMATCH")
        args = container["Config"]["Cmd"]
        require(isinstance(args, list) and len(args) == 9, "RELAY_COMMAND_CHANGED")
        relay_url = args[6]
        parsed = urllib.parse.urlsplit(relay_url)
        require(parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password and
                not parsed.query and not parsed.fragment and parsed.path == "", "RELAY_URL_INVALID")
    else:
        relay_url = scope["relayUrl"]
    expected = ["node", "dist/cli.js", "relay", "--data", "/data", "--url", relay_url,
                "--trusted-proxy", "127.0.0.1"]
    require(container["Config"]["Cmd"] == expected and container["Config"]["User"] == "1000:1000", "RELAY_COMMAND_CHANGED")
    mounts = [m for m in container["Mounts"] if m["Destination"] == "/data"]
    require(len(mounts) == 1 and mounts[0]["Type"] == "bind" and
            mounts[0]["Source"] == "/srv/devpocket/relay" and mounts[0]["RW"], "DATABASE_MOUNT_CHANGED")
    database = root / "relay" / "relay.sqlite"
    require(database.is_file() and not database.is_symlink(), "EXISTING_DATABASE_REQUIRED")
    target = {"vmVerified": True, "ownerVerified": True, "releaseId": release_id,
              "imageId": container["Image"], "containerId": ids[0], "databasePath": str(database)}
    return (target, relay_url) if discovering else target


def audit():
    files = [Path("/var/log/azure/run-command/handler.log")]
    downloads = Path("/var/lib/waagent/run-command/download")
    children = list(downloads.iterdir()) if downloads.exists() else []
    require(len(children) <= 128, "AUDIT_SCOPE_OVERFLOW")
    for child in children:
        if child.is_dir() and not child.is_symlink() and re.fullmatch(r"\d+", child.name):
            files += [child / "script.sh", child / "stdout", child / "stderr"]
    count = total = skipped = tokens = keys = 0
    for file in files:
        if not file.is_file() or file.is_symlink():
            continue
        size = file.stat().st_size
        if size > 1024 * 1024 or total + size > 8 * 1024 * 1024:
            skipped += 1
            continue
        body = file.read_bytes()
        count += 1
        total += len(body)
        tokens += len(re.findall(rb"dph_[A-Za-z0-9_-]{43}", body))
        keys += len(re.findall(rb"-----BEGIN (?:RSA )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{32}", body))
    require(count > 0 and skipped == 0 and tokens == 0 and keys == 0, "VISIBLE_LOG_AUDIT_FAILED")
    return {"files": count, "bytes": total, "skipped": skipped,
            "hostTokenMatches": tokens, "privateKeyMatches": keys, "complete": True}


def main(payload):
    scope, action = payload["scope"], payload["action"]
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(RuntimeError("ACTION_TIME_LIMIT")))
    signal.alarm(60)
    try:
        require(action in ["discover", "inspect", "register", "finalize"], "HOST_ACTION_DENIED")
        require(int(time.time() * 1000) < scope["expiresAt"], "HOST_APPROVAL_EXPIRED")
        require(re.fullmatch(r"[a-f0-9-]{36}", scope["operationId"]), "OPERATION_ID")
        with Path("/run/lock/devpocket-onboarding.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if action == "discover":
                target, relay_url = context(scope, discovering=True)
            else:
                target = context(scope)
            if action in ["register", "finalize"]:
                parent = Path("/srv/devpocket/relay/.devpocket-onboarding")
                require(not parent.is_symlink(), "JOURNAL_PARENT_LINK")
                if not parent.exists():
                    parent.mkdir(mode=0o700)
                    os.chown(parent, 1000, 1000)
                require(parent.stat().st_uid == 1000 and (parent.stat().st_mode & 0o777) == 0o700, "JOURNAL_PARENT_PERMISSIONS")
            node_input = {"scope": scope, "publicKeyPem": payload["publicKeyPem"],
                          "action": "inspect" if action == "discover" else action,
                          "acknowledgement": payload.get("acknowledgement")}
            suffix = """
try {
  const result = await guestMain(JSON.parse(Buffer.from("__INPUT__", "base64")));
  const encoded = JSON.stringify(result);
  if (/dph_[A-Za-z0-9_-]{43}|-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(encoded)) throw new Error("SECRET_OUTPUT");
  console.log(encoded);
} catch (error) {
  const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : "HOST_OPERATION_FAILED";
  console.log(JSON.stringify({status:"failed",code}));
}
"""
            suffix = suffix.replace("__INPUT__", base64.b64encode(json.dumps(node_input).encode()).decode())
            result = json.loads(command(["docker", "exec", "-i", "--user", "1000:1000", target["containerId"],
                                         "node", "--no-warnings", "--input-type=module", "-"],
                                        (payload["nodeBundle"] + suffix).encode()))
            result["scopeHash"] = scope["scopeHash"]
            if result["status"] != "failed":
                result["target"] = target
                if action == "discover":
                    result["status"] = "relay_discovered"
                    result["relayUrl"] = relay_url
                if action == "finalize":
                    result["logAudit"] = audit()
    except BaseException as error:
        code = str(error) if re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", str(error)) else "GUEST_CHECK_FAILED"
        result = {"scopeHash": scope["scopeHash"], "status": "failed", "code": code}
    encoded = json.dumps(result, separators=(",", ":"))
    require(len(encoded.encode()) <= 3700, "RESULT_BOUND")
    print("DEVPOCKET_HOST_RESULT=" + encoded, flush=True)
    signal.alarm(0)


if __name__ == "__main__":
    main(json.loads(base64.b64decode("__DEVPOCKET_HOST_PAYLOAD__")))
