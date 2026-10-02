"""Authenticated real-release quarantine only; no Blob, mount, build or start."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import sys
import tarfile
import time
import urllib.request

PROTOCOL = "DevPocketEncryptedRelease/1"
BASE = Path("/var/lib/devpocket-real-transfers")
CHUNK = 4096


class ReleaseError(Exception):
    pass


def require(value, code):
    if not value:
        raise ReleaseError(code)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def decode(value):
    return base64.b64decode(value, validate=True)


def directory(plan, owner=True):
    require(plan["protocol"] == PROTOCOL and re.fullmatch(r"[a-f0-9-]{36}", plan["transferId"]), "PROTOCOL_SCOPE")
    root = BASE / plan["transferId"]
    require(root.parent == BASE and not BASE.is_symlink() and not root.is_symlink(), "DIRECTORY_SCOPE")
    if owner:
        require(json.loads((root / "owner.json").read_text()) == plan, "OWNER_MISMATCH")
    return root


def write_private(file, body):
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(body)


def deadline(plan):
    require(int(time.time() * 1000) < plan["expiresAt"], "EXPIRED")


def environment(plan):
    require(sys.platform == "linux" and os.geteuid() == 0, "ROOT_LINUX_REQUIRED")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(
        "http://169.254.169.254/metadata/instance/compute/resourceId?api-version=2021-02-01&format=text",
        headers={"Metadata": "true"})
    with opener.open(request, timeout=2) as response:
        target = response.read(2048).decode().strip()
    require(target.lower() == plan["vmId"].lower(), "VM_TARGET_MISMATCH")
    require(importlib.util.find_spec("cryptography") is not None, "CRYPTO_DEPENDENCY_MISSING")
    return {"status": "ready", "targetVerified": True, "dependenciesInstalled": False}


def public_key(plan):
    from cryptography.hazmat.primitives import serialization
    root = directory(plan)
    pem = (root / "public.pem").read_bytes()
    key = serialization.load_pem_public_key(pem)
    require(os.name == "nt" or (stat.S_IMODE(root.stat().st_mode) == 0o700 and
            stat.S_IMODE((root / "private.pem").stat().st_mode) == 0o600), "KEY_PERMISSIONS")
    return {"status": "recipient_ready", "publicKeyPem": pem.decode(),
            "publicKeySha256": digest(key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)),
            "rsaBits": key.key_size, "rootOnly": True}


def initialize(plan):
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization
    deadline(plan)
    root = directory(plan, False)
    if root.exists():
        return public_key(plan)
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.mkdir(mode=0o700)
    write_private(root / "owner.json", json.dumps(plan).encode())
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    write_private(root / "private.pem", key.private_bytes(serialization.Encoding.PEM,
                  serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    write_private(root / "public.pem", key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    return public_key(plan)


def validate_envelope(plan, envelope):
    deadline(plan)
    metadata = envelope["metadata"]
    require(metadata["vmId"].lower() == plan["vmId"].lower(), "VM_TARGET_MISMATCH")
    require(metadata["expiresAt"] > int(time.time() * 1000), "EXPIRED")
    expected = {"protocol": PROTOCOL, "planHash": plan["planHash"], "vmId": plan["vmId"],
                "transferId": plan["transferId"], "packageSha256": plan["business"]["archiveSha256"],
                "manifestSha256": plan["business"]["manifestSha256"], "expiresAt": plan["expiresAt"],
                "transportSourceHash": plan["transportSourceHash"], "archiveBytes": plan["business"]["archiveBytes"],
                "publicKeySha256": public_key(plan)["publicKeySha256"],
                "algorithm": "RSA-OAEP-SHA256+A256GCM", "chunkBytes": CHUNK}
    require(metadata == expected, "AAD_MISMATCH")
    require(0 < metadata["archiveBytes"] <= 65536, "PACKAGE_LIMIT")
    require(len(decode(envelope["nonce"])) == 12 and len(decode(envelope["tag"])) == 16 and
            len(decode(envelope["wrappedKey"])) == 384, "CRYPTO_FORMAT")
    count = (metadata["archiveBytes"] + CHUNK - 1) // CHUNK
    require(len(envelope["chunks"]) == count and count <= 16, "CHUNK_COUNT")
    for index, item in enumerate(envelope["chunks"]):
        require(item["bytes"] == min(CHUNK, metadata["archiveBytes"] - index * CHUNK) and
                re.fullmatch(r"[a-f0-9]{64}", item["sha256"]), "CHUNK_MANIFEST")


def begin(plan, envelope):
    validate_envelope(plan, envelope)
    file = directory(plan) / "envelope.json"
    encoded = canonical(envelope)
    if file.exists():
        require(file.read_bytes() == encoded, "ENVELOPE_CONFLICT")
        return {"status": "duplicate_envelope"}
    write_private(file, encoded)
    return {"status": "envelope_accepted", "chunkCount": len(envelope["chunks"])}


def chunk(plan, index, encoded):
    root = directory(plan)
    envelope = json.loads((root / "envelope.json").read_text())
    validate_envelope(plan, envelope)
    require(type(index) is int and 0 <= index < len(envelope["chunks"]) and len(encoded) <= 5500, "CHUNK_SCOPE")
    data = decode(encoded)
    file = root / ("cipher-%02d" % index)
    if file.exists():
        require(not file.is_symlink() and file.read_bytes() == data, "CHUNK_CONFLICT")
        return {"status": "duplicate_chunk", "index": index, "sha256": digest(data)}
    expected = envelope["chunks"][index]
    require(len(data) == expected["bytes"] and digest(data) == expected["sha256"], "CHUNK_HASH")
    write_private(file, data)
    return {"status": "chunk_accepted", "index": index, "sha256": digest(data)}


def content_key(plan, envelope):
    from cryptography.hazmat.primitives import serialization, hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    key = serialization.load_pem_private_key((directory(plan) / "private.pem").read_bytes(), password=None)
    result = key.decrypt(decode(envelope["wrappedKey"]), padding.OAEP(
        mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    require(len(result) == 32, "KEY_SIZE")
    return result


def safe_name(name):
    return (bool(re.fullmatch(r"[A-Za-z0-9_./-]+", name)) and not PurePosixPath(name).is_absolute()
            and all(part not in ["", ".", ".."] for part in name.split("/"))
            and not re.search(r"(^|/)(\.data|\.azure|\.git|node_modules)(/|$)|\.local\.|\.pem$|\.key$|\.sqlite|\.jks$|\.keystore", name))


def inspect_archive(plan, plaintext):
    require(len(plaintext) == plan["business"]["archiveBytes"] and
            digest(plaintext) == plan["business"]["archiveSha256"], "FROZEN_PACKAGE_HASH")
    with tarfile.open(fileobj=io.BytesIO(plaintext), mode="r:gz") as archive:
        members = archive.getmembers()
        require(1 < len(members) <= 251 and sum(item.size for item in members) <= 20 * 1024 * 1024, "EXPANDED_LIMIT")
        names = set()
        for member in members:
            require(member.isfile() and safe_name(member.name) and member.name.lower() not in names and
                    member.size <= 4 * 1024 * 1024, "UNSAFE_MEMBER")
            names.add(member.name.lower())
        manifest_bytes = archive.extractfile("release-manifest.json").read()
        require(digest(manifest_bytes) == plan["business"]["manifestSha256"], "FROZEN_MANIFEST_HASH")
        manifest = json.loads(manifest_bytes)
        require(manifest["schemaVersion"] == 1 and len(manifest["files"]) == plan["business"]["fileCount"], "MANIFEST_COUNT")
        expected = {item["name"]: item["sha256"] for item in manifest["files"]}
        require(len(expected) == len(manifest["files"]) and
                {item.name for item in members} == set(expected) | {"release-manifest.json"}, "MANIFEST_MEMBERS")
        contents = {}
        for member in members:
            contents[member.name] = archive.extractfile(member).read()
            if member.name in expected:
                require(digest(contents[member.name]) == expected[member.name], "MEMBER_HASH")
    require(digest(contents["deployment/azure/vm/control.py"]) == plan["business"]["controlSha256"], "CONTROL_HASH")
    binding = json.loads(contents["deployment-target.json"])
    require(binding == {"schemaVersion": 1, **plan["serviceBinding"]}, "SERVICE_BINDING")
    require(json.loads(contents["package.json"])["version"] == "0.1.0", "BUSINESS_VERSION")
    return contents


def verify_tree(plan, root):
    require(root.is_dir() and not root.is_symlink(), "QUARANTINE_MISSING")
    manifest_bytes = (root / "release-manifest.json").read_bytes()
    require(digest(manifest_bytes) == plan["business"]["manifestSha256"], "MANIFEST_HASH")
    manifest = json.loads(manifest_bytes)
    for file in root.rglob("*"):
        require(not file.is_symlink(), "VERIFIED_TREE_LINK")
    for item in manifest["files"]:
        file = root / item["name"]
        require(safe_name(item["name"]) and not file.is_symlink() and file.is_file() and
                digest(file.read_bytes()) == item["sha256"], "VERIFIED_TREE_CHANGED")
    return manifest


def authenticate(plan):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.exceptions import InvalidTag
    root = directory(plan)
    envelope = json.loads((root / "envelope.json").read_text())
    validate_envelope(plan, envelope)
    cipher = b"".join((root / ("cipher-%02d" % index)).read_bytes() for index in range(len(envelope["chunks"])))
    require(len(cipher) <= 65536 and digest(cipher) == envelope["ciphertextSha256"], "CIPHERTEXT_HASH")
    try:
        plaintext = AESGCM(content_key(plan, envelope)).decrypt(decode(envelope["nonce"]),
                    cipher + decode(envelope["tag"]), canonical(envelope["metadata"]))
    except InvalidTag:
        raise ReleaseError("AUTHENTICATION_FAILED") from None
    contents = inspect_archive(plan, plaintext)
    quarantine = root / "quarantine"
    receipt = root / "authenticated.json"
    if receipt.exists():
        require(json.loads(receipt.read_text())["planHash"] == plan["planHash"], "AUTH_RECEIPT")
        verify_tree(plan, quarantine)
        return {"status": "archive_authenticated", "sha256": digest(plaintext), "duplicate": True}
    require(not quarantine.exists(), "UNSETTLED_QUARANTINE")
    quarantine.mkdir(mode=0o700)
    try:
        for name, data in contents.items():
            file = quarantine / name
            file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            write_private(file, data)
        write_private(root / "verified.tar.gz", plaintext)
        write_private(receipt, json.dumps({"planHash": plan["planHash"], "sha256": digest(plaintext),
            "manifestSha256": plan["business"]["manifestSha256"], "authenticatedGcm": True,
            "originSourceHash": plan["business"]["originSourceHash"], "transportSourceHash": plan["transportSourceHash"]}).encode())
    except BaseException:
        shutil.rmtree(quarantine)
        (root / "verified.tar.gz").unlink(missing_ok=True)
        receipt.unlink(missing_ok=True)
        raise
    return {"status": "archive_authenticated", "sha256": digest(plaintext), "fileCount": len(contents) - 1, "duplicate": False}


def audit(plan):
    root = directory(plan)
    envelope = json.loads((root / "envelope.json").read_text())
    private_pem = (root / "private.pem").read_bytes()
    lines = private_pem.splitlines()[1:-1]
    aes = content_key(plan, envelope)
    plaintext = (root / "verified.tar.gz").read_bytes()
    needles = {"privateKey": [private_pem, lines[len(lines) * 3 // 4]], "contentKey": [aes, base64.b64encode(aes), aes.hex().encode()],
               "archive": [plaintext, base64.b64encode(plaintext)]}
    needles["sourceFragments"] = []
    for name, content in inspect_archive(plan, plaintext).items():
        if name.endswith((".ts", ".mjs", ".py")) and len(content) >= 192:
            for offset in [0, max(0, len(content) // 2 - 96), len(content) - 192]:
                needles["sourceFragments"].append(content[offset:offset + 192])
    files = [("handler", Path("/var/log/azure/run-command/handler.log"))]
    downloads = Path("/var/lib/waagent/run-command/download")
    if downloads.exists():
        for child in list(downloads.iterdir())[:128]:
            if child.is_dir() and not child.is_symlink() and re.fullmatch(r"\d+", child.name):
                files += [("scripts", child / "script.sh"), ("output", child / "stdout"), ("output", child / "stderr")]
    counts = {key: 0 for key in needles}
    scopes = {"handler": 0, "scripts": 0, "output": 0}
    scanned = total = skipped = 0
    for scope, file in files:
        if not file.is_file() or file.is_symlink():
            continue
        size = file.stat().st_size
        if size > 1024 * 1024 or total + size > 8 * 1024 * 1024:
            skipped += 1
            continue
        body = file.read_bytes()
        scanned += 1
        scopes[scope] += 1
        total += size
        for key, values in needles.items():
            counts[key] += sum(body.count(value) for value in values if value)
    return {"status": "transfer_log_audit", "files": scanned, "bytes": total, "skipped": skipped, "matches": counts,
            "scopeFiles": scopes, "completeForVisibleScope": all(scopes.values()) and skipped == 0,
            "boundary": "Selected guest handler/script/stdout/stderr; no guarantee for Azure backend, admins or all encodings"}


def cleanup(plan):
    root = directory(plan, False)
    if not root.exists():
        return {"status": "transfer_cleaned", "directoryAbsent": True}
    directory(plan)
    require(root.parent.resolve() == BASE.resolve() and root.name == plan["transferId"], "CLEANUP_SCOPE")
    shutil.rmtree(root)
    require(not root.exists(), "CLEANUP_FAILED")
    return {"status": "transfer_cleaned", "directoryAbsent": True}


def dispatch(payload):
    plan, action = payload["plan"], payload["action"]
    directory(plan, False)
    result = environment(plan)
    if action == "inspect":
        return result
    if action == "cleanup-transfer":
        return cleanup(plan)
    deadline(plan)
    if action == "init":
        return initialize(plan)
    if action == "begin":
        return begin(plan, payload["envelope"])
    if action == "chunk":
        return chunk(plan, payload["index"], payload["data"])
    if action == "authenticate":
        return authenticate(plan)
    if action == "transfer-audit":
        return audit(plan)
    raise ReleaseError("ACTION_DENIED")


def main(payload):
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(ReleaseError("TIME_LIMIT")))
    signal.alarm(30)
    try:
        result = dispatch(payload)
    except BaseException as error:
        result = {"status": "failed", "code": str(error) if isinstance(error, ReleaseError) else type(error).__name__}
        try:
            result["cleanup"] = cleanup(payload["plan"])
        except BaseException:
            result["cleanup"] = {"status": "requires-settled-explicit-cleanup"}
    encoded = json.dumps(result, separators=(",", ":"))
    require(len(encoded.encode()) <= 3200, "OUTPUT_LIMIT")
    print("DEVPOCKET_REAL_RESULT=" + encoded, flush=True)
    signal.alarm(0)


if __name__ == "__main__":
    main(json.loads(base64.b64decode("__DEVPOCKET_REAL_PAYLOAD__")))
