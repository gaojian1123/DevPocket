"""Root-only DevPocket VM operations. Configuration contains no credentials."""
import base64
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path("/srv/devpocket")
STATE = Path("/var/lib/devpocket")
LOG = Path("/var/log/devpocket-operations.log")


def run(args, capture=False, check=True):
    with LOG.open("ab") as log:
        result = subprocess.run(args, stdout=subprocess.PIPE if capture else log, stderr=log,
                                timeout=1800, check=False)
    if check and result.returncode:
        raise RuntimeError("Local command failed; inspect the root-only operations log.")
    return result.stdout.decode().strip() if capture else result.returncode


def validate(config):
    if os.geteuid() != 0:
        raise RuntimeError("ARM Run Command must run as root.")
    if not re.fullmatch(r"[a-f0-9-]{36}", config["deploymentId"]):
        raise ValueError("Invalid deployment owner.")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]", config["host"]):
        raise ValueError("Invalid public host.")
    if config["dataDiskGiB"] not in [32, 64, 128, 256]:
        raise ValueError("Invalid data disk size.")
    if re.search(r"[\r\n\x00]", config["tlsEmail"]):
        raise ValueError("Invalid TLS email.")
    return config


def write_json(file, value):
    temporary = file.with_suffix(file.suffix + ".new")
    temporary.write_text(json.dumps(value, indent=2))
    os.chmod(temporary, 0o600)
    temporary.replace(file)


def assert_owner(config):
    if not ROOT.is_mount():
        raise RuntimeError("The local data disk is not mounted; refusing to use the OS disk as a fallback.")
    if (ROOT / ".owner").read_text().strip() != config["deploymentId"]:
        raise RuntimeError("Existing DevPocket data belongs to a different deployment.")


def bootstrap(config):
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    owner = STATE / "owner"
    if owner.exists() and owner.read_text().strip() != config["deploymentId"]:
        raise RuntimeError("VM was initialized for a different deployment; refusing adoption.")
    run(["apt-get", "update"])
    run(["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "--no-install-recommends",
         "ca-certificates", "docker.io", "docker-compose-v2", "e2fsprogs", "util-linux"])
    run(["systemctl", "start", "docker"])
    candidates = [Path("/dev/disk/azure/scsi1/lun0"), Path("/dev/disk/azure/data/by-lun/0")]
    disk = next((p.resolve() for p in candidates if p.exists()), None)
    if disk is None:
        raise RuntimeError("Expected Azure data disk LUN 0 is not present.")
    if int(run(["blockdev", "--getsize64", str(disk)], capture=True)) != config["dataDiskGiB"] * 1024**3:
        raise RuntimeError("Data disk size differs from the approved plan.")
    listing = json.loads(run(["lsblk", "-J", "-o", "NAME,TYPE,MOUNTPOINT,FSTYPE", str(disk)], capture=True))
    device = listing["blockdevices"][0]
    if device["type"] != "disk" or device.get("children") or device.get("mountpoint") not in [None, str(ROOT)]:
        raise RuntimeError("Refusing to format a partitioned, in-use, or unexpected disk.")
    if not device.get("fstype"):
        if owner.exists():
            raise RuntimeError("Previously initialized disk has lost its filesystem; refusing to reformat.")
        run(["mkfs.ext4", "-L", "devpocket-data", str(disk)])
    elif device["fstype"] != "ext4":
        raise RuntimeError("Existing data filesystem is not ext4; refusing to format.")
    ROOT.mkdir(parents=True, exist_ok=True)
    if not ROOT.is_mount():
        if any(ROOT.iterdir()):
            raise RuntimeError("Mount point is not empty; refusing to cover existing files.")
        run(["mount", str(disk), str(ROOT)])
    marker = ROOT / ".owner"
    if not marker.exists():
        if any(p.name != "lost+found" for p in ROOT.iterdir()):
            raise RuntimeError("Data disk contains unowned files; refusing adoption.")
        marker.write_text(config["deploymentId"])
    assert_owner(config)
    owner.write_text(config["deploymentId"])
    os.chmod(ROOT, 0o700)
    for name in ["relay", "releases", "backups", "caddy-data", "caddy-config", "private"]:
        (ROOT / name).mkdir(mode=0o700, exist_ok=True)
    os.chown(ROOT / "relay", 1000, 1000)
    disk_uuid = run(["blkid", "-s", "UUID", "-o", "value", str(disk)], capture=True)
    fstab = Path("/etc/fstab")
    marker_line = f"UUID={disk_uuid} {ROOT} ext4 defaults,nofail 0 2 # devpocket:{config['deploymentId']}"
    existing = fstab.read_text()
    if str(ROOT) in existing and marker_line not in existing:
        raise RuntimeError("Existing fstab entry differs from the approved disk.")
    if marker_line not in existing:
        with fstab.open("a") as file:
            file.write("\n" + marker_line + "\n")
    write_json(STATE / "config.json", config)
    print("DEVPOCKET_PHASE=bootstrap_complete")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Redirected private artifact download was refused.")


def download(config):
    url = urllib.parse.urlparse(config["packageUrl"])
    if url.scheme != "https" or url.hostname != config["storageAccount"] + ".blob.core.windows.net" or url.query or url.fragment:
        raise ValueError("Private package URL is outside the approved storage account.")
    if url.path != "/releases/packages/" + config["releaseId"] + ".tar.gz":
        raise ValueError("Artifact identity is not the approved immutable digest.")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    for attempt in range(18):
        try:
            imds = "http://169.254.169.254/metadata/identity/oauth2/token?" + urllib.parse.urlencode({
                "api-version": "2018-02-01", "resource": "https://storage.azure.com/"})
            with opener.open(urllib.request.Request(imds, headers={"Metadata": "true"}), timeout=10) as response:
                token = json.load(response)["access_token"]
            request = urllib.request.Request(config["packageUrl"], headers={
                "Authorization": "Bearer " + token, "x-ms-version": "2023-11-03"})
            with opener.open(request, timeout=60) as response:
                body = response.read(25 * 1024 * 1024 + 1)
            if len(body) > 25 * 1024 * 1024 or hashlib.sha256(body).hexdigest() != config["releaseId"]:
                raise RuntimeError("Private artifact exceeded its bound or failed its SHA-256 check.")
            return body
        except urllib.error.HTTPError as error:
            if error.code not in [401, 403, 429, 500, 502, 503] or attempt == 17:
                raise RuntimeError("Managed identity artifact download failed; verify RBAC and storage network rules.") from None
            time.sleep(10)
    raise RuntimeError("Private download retry limit reached.")


def extract(body, destination):
    with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as archive:
        members = archive.getmembers()
        if len(members) > 252 or sum(p.size for p in members) > 21 * 1024 * 1024:
            raise ValueError("Archive exceeds the source budget.")
        names = set()
        for member in members:
            name = PurePosixPath(member.name)
            if not member.isfile() or name.is_absolute() or ".." in name.parts or "\\" in member.name or member.name in names:
                raise ValueError("Archive contains unsafe paths, duplicate entries, or links.")
            names.add(member.name)
        manifest = json.load(archive.extractfile("release-manifest.json"))
        expected = {item["name"]: item["sha256"] for item in manifest["files"]}
        if names != set(expected) | {"release-manifest.json"}:
            raise ValueError("Archive file list differs from its manifest.")
        destination.mkdir(mode=0o700)
        for member in members:
            content = archive.extractfile(member).read()
            if member.name in expected and hashlib.sha256(content).hexdigest() != expected[member.name]:
                raise ValueError("Source file integrity check failed.")
            file = destination / member.name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(content)
            os.chmod(file, 0o700 if file.suffix == ".sh" else 0o600)


def compose(release, args):
    directory = ROOT / "releases" / release
    config = json.loads((directory / "deployment-state.json").read_text())
    env = directory / "runtime.env"
    env.write_text("\n".join([
        "DEVPOCKET_RELEASE_ID=" + release, "DEVPOCKET_RELEASE_DIR=" + str(ROOT / "releases" / release),
        "DEVPOCKET_DOMAIN=" + config["host"], "DEVPOCKET_TLS_EMAIL=" + config["tlsEmail"],
        "DEVPOCKET_CADDY_IMAGE=" + config["caddyImage"], ""]))
    os.chmod(env, 0o600)
    return ["docker", "compose", "--project-name", "devpocket-azure", "--env-file", str(env),
            "-f", str(ROOT / "releases" / release / "deployment/azure/compose.yaml")] + args


def current():
    file = ROOT / "current.json"
    return json.loads(file.read_text()) if file.exists() else None


def backup():
    stamp = str(time.time_ns())
    target = ROOT / "backups" / stamp
    target.mkdir(mode=0o700)
    database = ROOT / "relay" / "relay.sqlite"
    if database.exists():
        with contextlib.closing(sqlite3.connect(f"file:{database}?mode=ro", uri=True)) as source:
            with contextlib.closing(sqlite3.connect(target / "relay.sqlite")) as dest:
                source.backup(dest)
    for name in ["caddy-data", "caddy-config", "private"]:
        shutil.copytree(ROOT / name, target / name)
    for name in ["config.json", "current.json"]:
        if (ROOT / name).exists():
            shutil.copy2(ROOT / name, target / name)
    print("DEVPOCKET_PHASE=backup_complete")
    return stamp


def prepare_release(config):
    assert_owner(config)
    release = config["releaseId"]
    if not re.fullmatch(r"[a-f0-9]{64}", release):
        raise ValueError("Invalid immutable release ID.")
    dest = ROOT / "releases" / release
    if not dest.exists():
        stage = ROOT / "releases" / (".preparing-" + release + "-" + str(os.getpid()))
        try:
            extract(download(config), stage)
            stage.rename(dest)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    binding = json.loads((dest / "deployment-target.json").read_text())
    if any(binding.get(key) != config.get(key) for key in ["deploymentId", "host", "tlsEmail", "autostart"]):
        raise RuntimeError("Release endpoint/owner configuration differs from the immutable package binding.")
    old = current()
    if old:
        previous_store = ROOT / "releases" / old["releaseId"] / "backend/src/store.ts"
        if previous_store.read_bytes() != (dest / "backend/src/store.ts").read_bytes():
            raise RuntimeError("SQLite schema implementation changed. A separately reviewed migration/rollback procedure is required.")
    image = "devpocket-relay:" + release
    exists = run(["docker", "image", "ls", "--quiet", image], capture=True)
    if not exists:
        run(["docker", "build", "--pull", "--label", "devpocket.source=" + release,
             "--label", "devpocket.owner=" + config["deploymentId"], "-t", image,
             "-f", str(dest / "deployment/Dockerfile"), str(dest)])
    image_info = json.loads(run(["docker", "image", "inspect", image], capture=True))[0]
    labels = image_info["Config"].get("Labels", {})
    if labels.get("devpocket.source") != release or labels.get("devpocket.owner") != config["deploymentId"]:
        raise RuntimeError("Existing image tag is not owned by this exact immutable release.")
    state_file = dest / "deployment-state.json"
    if state_file.exists():
        state = json.loads(state_file.read_text())
        if state["host"] != config["host"] or state["tlsEmail"] != config["tlsEmail"]:
            raise RuntimeError("Existing release uses different endpoint configuration; choose a new release source snapshot.")
        if state["imageId"] != image_info["Id"]:
            raise RuntimeError("Previously recorded immutable image ID changed. An explicit image recovery review is required.")
    else:
        run(["docker", "pull", "caddy:2.10.2-alpine"])
        caddy = json.loads(run(["docker", "image", "inspect", "caddy:2.10.2-alpine"], capture=True))[0]
        state = {**config, "imageId": image_info["Id"], "caddyImage": caddy["RepoDigests"][0]}
        write_json(state_file, state)
    run(compose(release, ["config", "--quiet"]))
    write_json(ROOT / "prepared.json", {"releaseId": release, "at": time.time()})
    print("DEVPOCKET_PHASE=release_prepared")


def configure_autostart(config):
    helper = STATE / "start-current.sh"
    helper.write_text("""#!/bin/sh
set -eu
mountpoint -q /srv/devpocket
release=$(python3 -c 'import json; print(json.load(open("/srv/devpocket/current.json"))["releaseId"])')
exec docker compose --project-name devpocket-azure --env-file "/srv/devpocket/releases/$release/runtime.env" -f "/srv/devpocket/releases/$release/deployment/azure/compose.yaml" up -d --wait --wait-timeout 150
""")
    os.chmod(helper, 0o700)
    unit = Path("/etc/systemd/system/devpocket.service")
    unit.write_text("""[Unit]
Description=DevPocket isolated relay
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
RequiresMountsFor=/srv/devpocket
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/var/lib/devpocket/start-current.sh
TimeoutStartSec=180
[Install]
WantedBy=multi-user.target
""")
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable" if config.get("autostart") else "disable", "devpocket.service"])


def activate(config, rollback=False):
    assert_owner(config)
    release = config["releaseId"]
    prepared = json.loads((ROOT / "prepared.json").read_text())
    old = current()
    if not re.fullmatch(r"[a-f0-9]{64}", release):
        raise ValueError("Invalid release ID.")
    if not rollback and prepared["releaseId"] != release:
        raise RuntimeError("Requested release was not built and prepared.")
    if rollback and (not old or old.get("previousReleaseId") != release):
        raise RuntimeError("Rollback target must be the recorded previous release, not an arbitrary directory.")
    backup_id = backup()
    if old:
        run(compose(old["releaseId"], ["down", "--timeout", "30"]))
    try:
        run(compose(release, ["up", "-d", "--wait", "--wait-timeout", "150"]))
        run(compose(release, ["exec", "-T", "relay", "node", "-e",
            "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]))
    except Exception:
        run(compose(release, ["down", "--timeout", "20"]), check=False)
        if old:
            run(compose(old["releaseId"], ["up", "-d", "--wait", "--wait-timeout", "150"]))
        raise RuntimeError("Activation failed; previous release restart attempted. Database was not rolled back.") from None
    write_json(ROOT / "current.json", {"releaseId": release, "previousReleaseId": old["releaseId"] if old else None,
                                     "backup": backup_id, "at": time.time()})
    write_json(ROOT / "config.json", json.loads((ROOT / "releases" / release / "deployment-state.json").read_text()))
    configure_autostart(config)
    print("DEVPOCKET_PHASE=internal_health_passed")
    print("Public HTTPS/WSS and paired original-CLI acceptance are separate checks; not certified by this phase.")


def main(config):
    import fcntl
    validate(config)
    LOG.touch(mode=0o600, exist_ok=True)
    os.chmod(LOG, 0o600)
    with Path("/run/lock/devpocket-operations.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        phase = config["phase"]
        if phase == "bootstrap":
            bootstrap(config)
        elif phase == "deploy":
            prepare_release(config)
        elif phase in ["start", "rollback"]:
            activate(config, phase == "rollback")
        elif phase == "backup":
            assert_owner(config)
            backup()
        else:
            raise ValueError("Unsupported VM operation.")


if __name__ == "__main__":
    try:
        main(json.loads(base64.b64decode("__DEVPOCKET_PAYLOAD__")))
    except Exception as error:
        print("DEVPOCKET_PHASE=failed")
        print(type(error).__name__ + ": " + str(error)[:400])
        sys.exit(1)
