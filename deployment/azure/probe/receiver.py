"""Synthetic-only receiver. No application deployment or arbitrary file inputs."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request

PROTOCOL = "DevPocketSyntheticProbe/1"
BASE = Path("/var/lib/devpocket-transport-probes")
MAX_ARCHIVE = 65536
CHUNK_BYTES = 8192


class ProbeError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ProbeError(code)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def b64(value):
    return base64.b64decode(value, validate=True)


def root_path(plan):
    require(plan["protocol"] == PROTOCOL, "PROTOCOL")
    require(re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", plan["transferId"]), "TRANSFER_ID")
    root = BASE / plan["transferId"]
    require(not BASE.is_symlink() and not root.is_symlink(), "LINK_DENIED")
    require(root.parent == BASE and root.name == plan["transferId"], "DIRECTORY_SCOPE")
    return root


def owned(plan):
    root = root_path(plan)
    owner = json.loads((root / "owner.json").read_text())
    require(owner == plan, "OWNER_MISMATCH")
    for item in root.iterdir():
        require(not item.is_symlink(), "LINK_DENIED")
    return root


def private_write(file, data):
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)


def check_deadline(plan):
    require(int(time.time() * 1000) < plan["expiresAt"], "EXPIRED")


def capabilities(plan):
    require(sys.platform == "linux" and os.geteuid() == 0, "ROOT_LINUX_REQUIRED")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    url = "http://169.254.169.254/metadata/instance/compute/resourceId?api-version=2021-02-01&format=text"
    with opener.open(urllib.request.Request(url, headers={"Metadata": "true"}), timeout=2) as response:
        vm_id = response.read(2048).decode().strip()
    require(vm_id.lower() == plan["vmId"].lower(), "VM_TARGET_MISMATCH")
    openssl = shutil.which("openssl")
    available = importlib.util.find_spec("cryptography") is not None
    result = {"status": "ready" if available and openssl else "dependencies_missing", "targetVerified": True,
              "python": ".".join(map(str, sys.version_info[:3])), "opensslAvailable": bool(openssl),
              "cryptographyAvailable": available}
    if openssl:
        proc = subprocess.run([openssl, "version"], capture_output=True, timeout=3, check=False)
        require(proc.returncode == 0, "OPENSSL_UNAVAILABLE")
        result["opensslVersion"] = proc.stdout.decode().strip()[:120]
    if available:
        import cryptography
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.asymmetric import rsa
        result["cryptographyVersion"] = cryptography.__version__
        result["standardAlgorithmsAvailable"] = AESGCM is not None and rsa is not None
    return result


def initialize(plan):
    check_deadline(plan)
    root = root_path(plan)
    if root.exists():
        owned(plan)
        return public_key(plan, reused=True)
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.mkdir(mode=0o700)
    private_write(root / "owner.json", json.dumps(plan).encode())
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption())
    private_write(root / "private.pem", pem)
    private_write(root / "public.pem", key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    private_write(root / "operations.log", b"probe initialized\n")
    return public_key(plan, reused=False)


def public_key(plan, reused=False):
    from cryptography.hazmat.primitives import serialization
    root = owned(plan)
    pem = (root / "public.pem").read_bytes()
    key = serialization.load_pem_public_key(pem)
    permissions = os.name == "nt" or (
        stat.S_IMODE(root.stat().st_mode) == 0o700 and stat.S_IMODE((root / "private.pem").stat().st_mode) == 0o600)
    require(permissions, "KEY_PERMISSIONS")
    return {"status": "key_ready", "publicKeyPem": pem.decode(),
            "publicKeySha256": digest(key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)),
            "rsaBits": key.key_size, "rootOnlyPermissions": permissions, "reused": reused}


def check_envelope(plan, envelope):
    check_deadline(plan)
    metadata = envelope["metadata"]
    require(metadata["vmId"].lower() == plan["vmId"].lower(), "VM_TARGET_MISMATCH")
    require(metadata["expiresAt"] > int(time.time() * 1000), "EXPIRED")
    fixture_id = metadata["fixtureId"]
    require(fixture_id in ["small", "scale"], "SYNTHETIC_ONLY")
    fixture = plan["fixtures"][fixture_id]
    expected = {"protocol": PROTOCOL, "probePlanHash": plan["planHash"], "vmId": plan["vmId"],
                "transferId": plan["transferId"], "fixtureId": fixture_id,
                "fixtureSha256": fixture["archiveSha256"], "expiresAt": plan["expiresAt"],
                "archiveBytes": fixture["archiveBytes"], "algorithm": "RSA-OAEP-SHA256+A256GCM",
                "chunkBytes": CHUNK_BYTES, "publicKeySha256": public_key(plan)["publicKeySha256"]}
    require(metadata == expected, "AAD_METADATA_MISMATCH")
    require(0 < fixture["archiveBytes"] <= MAX_ARCHIVE, "ARCHIVE_LIMIT")
    require(len(b64(envelope["nonce"])) == 12 and len(b64(envelope["tag"])) == 16 and
            len(b64(envelope["wrappedKey"])) == 384, "CRYPTO_FORMAT")
    expected_chunks = (fixture["archiveBytes"] + CHUNK_BYTES - 1) // CHUNK_BYTES
    require(len(envelope["chunks"]) == expected_chunks and expected_chunks <= 8, "CHUNK_COUNT")
    for i, chunk in enumerate(envelope["chunks"]):
        require(chunk["bytes"] == min(CHUNK_BYTES, fixture["archiveBytes"] - i * CHUNK_BYTES) and
                re.fullmatch(r"[a-f0-9]{64}", chunk["sha256"]), "CHUNK_MANIFEST")
    require(re.fullmatch(r"[a-f0-9]{64}", envelope["ciphertextSha256"]), "CIPHER_DIGEST")
    return fixture_id


def begin(plan, envelope):
    fixture_id = check_envelope(plan, envelope)
    root = owned(plan)
    file = root / (fixture_id + ".envelope.json")
    data = canonical(envelope)
    if file.exists():
        require(file.read_bytes() == data, "ENVELOPE_CONFLICT")
        return {"status": "duplicate_envelope", "fixtureId": fixture_id}
    private_write(file, data)
    return {"status": "envelope_accepted", "fixtureId": fixture_id, "chunkCount": len(envelope["chunks"])}


def receive_chunk(plan, fixture_id, index, encoded):
    require(fixture_id in ["small", "scale"] and type(index) is int, "CHUNK_SCOPE")
    root = owned(plan)
    envelope = json.loads((root / (fixture_id + ".envelope.json")).read_text())
    check_envelope(plan, envelope)
    require(0 <= index < len(envelope["chunks"]) and len(encoded) <= 11000, "CHUNK_LIMIT")
    content = b64(encoded)
    expected = envelope["chunks"][index]
    file = root / ("%s.chunk-%02d" % (fixture_id, index))
    if file.exists():
        require(file.read_bytes() == content, "DUPLICATE_CONFLICT")
        return {"status": "duplicate_chunk", "fixtureId": fixture_id, "index": index, "sha256": digest(content)}
    require(len(content) == expected["bytes"] and digest(content) == expected["sha256"], "CHUNK_HASH_MISMATCH")
    private_write(file, content)
    return {"status": "chunk_accepted", "fixtureId": fixture_id, "index": index, "sha256": digest(content)}


def content_key(plan, envelope):
    from cryptography.hazmat.primitives import serialization, hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    key = serialization.load_pem_private_key((owned(plan) / "private.pem").read_bytes(), password=None)
    secret = key.decrypt(b64(envelope["wrappedKey"]),
                         padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    require(len(secret) == 32, "KEY_SIZE")
    return secret


def authenticate(plan, envelope, ciphertext):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.exceptions import InvalidTag
    fixture_id = check_envelope(plan, envelope)
    require(digest(ciphertext) == envelope["ciphertextSha256"], "CIPHER_DIGEST")
    try:
        plaintext = AESGCM(content_key(plan, envelope)).decrypt(b64(envelope["nonce"]),
                    ciphertext + b64(envelope["tag"]), canonical(envelope["metadata"]))
    except InvalidTag:
        raise ProbeError("AUTHENTICATION_FAILED") from None
    fixture = plan["fixtures"][fixture_id]
    require(len(plaintext) == fixture["archiveBytes"] and digest(plaintext) == fixture["archiveSha256"], "PLAINTEXT_DIGEST")
    return plaintext


def inspect_synthetic(plan, fixture_id, plaintext):
    with tarfile.open(fileobj=io.BytesIO(plaintext), mode="r:gz") as archive:
        members = archive.getmembers()
        require(len(members) == 2 and {m.name for m in members} == {"synthetic.bin", "release-manifest.json"} and
                all(m.isfile() and m.size <= MAX_ARCHIVE for m in members), "SYNTHETIC_MANIFEST")
        manifest = json.load(archive.extractfile("release-manifest.json"))
        require(manifest["purpose"] == "devpocket.synthetic.fixture.v1" and manifest["schemaVersion"] == 1 and
                len(manifest["files"]) == 1, "SYNTHETIC_ONLY")
        content = archive.extractfile("synthetic.bin").read(MAX_ARCHIVE + 1)
    expected = plan["fixtures"][fixture_id]
    require(manifest["files"][0] == {"name": "synthetic.bin", "sha256": expected["contentSha256"],
                                    "bytes": expected["contentBytes"]}, "SYNTHETIC_MANIFEST")
    require(len(content) == expected["contentBytes"] and digest(content) == expected["contentSha256"], "CONTENT_DIGEST")
    sentinel = content.split(b"\n", 1)[0]
    require(re.fullmatch(b"DPSYN-[a-f0-9]{64}", sentinel), "SYNTHETIC_SENTINEL")
    return sentinel


def ciphertext_for(plan, fixture_id):
    root = owned(plan)
    envelope = json.loads((root / (fixture_id + ".envelope.json")).read_text())
    check_envelope(plan, envelope)
    ciphertext = b"".join((root / ("%s.chunk-%02d" % (fixture_id, i))).read_bytes()
                           for i in range(len(envelope["chunks"])))
    require(len(ciphertext) <= MAX_ARCHIVE, "CIPHER_LIMIT")
    return envelope, ciphertext


def finish(plan, fixture_id):
    root = owned(plan)
    envelope, ciphertext = ciphertext_for(plan, fixture_id)
    plaintext = authenticate(plan, envelope, ciphertext)
    inspect_synthetic(plan, fixture_id, plaintext)
    file = root / (fixture_id + ".accepted.synthetic.tar.gz")
    duplicate = file.exists()
    if duplicate:
        require(digest(file.read_bytes()) == digest(plaintext), "FINALIZE_CONFLICT")
    else:
        private_write(file, plaintext)
    return {"status": "fixture_verified", "fixtureId": fixture_id, "sha256": digest(plaintext),
            "archiveBytes": len(plaintext), "chunkCount": len(envelope["chunks"]), "duplicateFinalize": duplicate}


def negative_tests(plan):
    root = owned(plan)
    envelope, ciphertext = ciphertext_for(plan, "small")
    checks = {}
    for name in ["tag", "target", "expired"]:
        bad = json.loads(json.dumps(envelope))
        if name == "tag":
            tag = bytearray(b64(bad["tag"]))
            tag[0] ^= 1
            bad["tag"] = base64.b64encode(tag).decode()
        elif name == "target":
            bad["metadata"]["vmId"] += "-wrong"
        else:
            bad["metadata"]["expiresAt"] = int(time.time() * 1000) - 1000
        try:
            authenticate(plan, bad, ciphertext)
            raise ProbeError("NEGATIVE_ACCEPTED")
        except ProbeError as error:
            expected = {"tag": "AUTHENTICATION_FAILED", "target": "VM_TARGET_MISMATCH", "expired": "EXPIRED"}[name]
            require(str(error) == expected, "NEGATIVE_WRONG_FAILURE")
            checks[name] = expected
    first = (root / "small.chunk-00").read_bytes()
    changed = bytearray(first)
    changed[0] ^= 1
    try:
        receive_chunk(plan, "small", 0, base64.b64encode(changed).decode())
        raise ProbeError("NEGATIVE_ACCEPTED")
    except ProbeError as error:
        require(str(error) == "DUPLICATE_CONFLICT", "NEGATIVE_WRONG_FAILURE")
    require((root / "small.chunk-00").read_bytes() == first, "DUPLICATE_OVERWROTE")
    require(not (root / "negative.plaintext.tmp").exists(), "FAILED_PLAINTEXT_REMAINS")
    return {"status": "negative_tests_passed", "rejected": checks, "conflictingChunkRejected": True,
            "originalChunkUnchanged": True, "failedPlaintextFiles": 0}


def scan_buffers(buffers, needles):
    return {name: sum(sum(content.count(pattern) for pattern in patterns if pattern) for content in buffers)
            for name, patterns in needles.items()}


def log_audit(plan):
    from cryptography.hazmat.primitives import serialization
    root = owned(plan)
    private_pem = (root / "private.pem").read_bytes()
    key = serialization.load_pem_private_key(private_pem, password=None)
    der = key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    lines = private_pem.splitlines()[1:-1]
    secret_line = lines[max(0, len(lines) * 3 // 4)]
    needles = {"privateKey": [private_pem, der, base64.b64encode(der), secret_line], "contentKey": [], "sentinel": []}
    for fixture_id in ["small", "scale"]:
        envelope = json.loads((root / (fixture_id + ".envelope.json")).read_text())
        secret = content_key(plan, envelope)
        needles["contentKey"] += [secret, base64.b64encode(secret), secret.hex().encode()]
        accepted = (root / (fixture_id + ".accepted.synthetic.tar.gz")).read_bytes()
        needles["sentinel"].append(inspect_synthetic(plan, fixture_id, accepted))
    candidates = {"handler": [Path("/var/log/azure/run-command/handler.log")],
                  "scripts": [], "stdoutStderr": [], "status": [], "probeOperations": [root / "operations.log"]}
    downloads = Path("/var/lib/waagent/run-command/download")
    if downloads.exists():
        for directory in list(downloads.iterdir())[:64]:
            if directory.is_dir() and not directory.is_symlink() and re.fullmatch(r"\d+", directory.name):
                candidates["scripts"].append(directory / "script.sh")
                candidates["stdoutStderr"] += [directory / "stdout", directory / "stderr"]
    for directory in list(Path("/var/lib/waagent").glob("Microsoft.CPlat.Core.RunCommandLinux-*"))[:4]:
        candidates["status"] += list((directory / "status").glob("*.status"))[:64]
    buffers, counts, skipped, total = [], {}, 0, 0
    for scope, paths in candidates.items():
        counts[scope] = 0
        for file in paths:
            if not file.exists() or file.is_symlink() or not file.is_file():
                continue
            size = file.stat().st_size
            if size > 1024 * 1024 or total + size > 8 * 1024 * 1024:
                skipped += 1
                continue
            buffers.append(file.read_bytes())
            counts[scope] += 1
            total += size
    matches = scan_buffers(buffers, needles)
    return {"status": "log_audit", "scopeFileCounts": counts, "bytesScanned": total, "skippedOversizeFiles": skipped,
            "matches": matches, "completeForVisibleScopes": skipped == 0 and counts["handler"] > 0 and counts["scripts"] > 0,
            "boundary": "Selected visible local handler/script/output/status files only; not Azure backend/all future logs/admin secrecy"}


def cleanup(plan):
    root = root_path(plan)
    if not root.exists():
        return {"status": "cleaned", "alreadyAbsent": True, "directoryAbsent": True}
    owned(plan)
    require(root.parent.resolve() == BASE.resolve() and root.name == plan["transferId"], "CLEANUP_SCOPE")
    require(len(list(root.iterdir())) <= 32, "CLEANUP_UNEXPECTED_FILES")
    shutil.rmtree(root)
    require(not root.exists(), "CLEANUP_FAILED")
    return {"status": "cleaned", "alreadyAbsent": False, "directoryAbsent": True}


def dispatch(payload):
    plan, action = payload["plan"], payload["action"]
    root_path(plan)
    readiness = capabilities(plan)
    if action == "inspect":
        return readiness
    require(readiness["status"] == "ready", "DEPENDENCIES_MISSING")
    if action == "cleanup":
        return cleanup(plan)
    check_deadline(plan)
    if action == "init":
        return initialize(plan)
    if action == "small":
        begin(plan, payload["envelope"])
        for index, encoded in enumerate(payload["chunks"]):
            receive_chunk(plan, "small", index, encoded)
        return finish(plan, "small")
    if action == "begin-scale":
        return begin(plan, payload["envelope"])
    if action == "chunk":
        return receive_chunk(plan, "scale", payload["index"], payload["data"])
    if action == "finish-scale":
        return finish(plan, "scale")
    if action == "negative":
        return negative_tests(plan)
    if action == "audit":
        return log_audit(plan)
    raise ProbeError("ACTION_DENIED")


def main(payload):
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    def deadline(_signum, _frame):
        raise ProbeError("SCRIPT_TIME_LIMIT")
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(30)
    try:
        response = dispatch(payload)
    except BaseException as error:
        code = str(error) if isinstance(error, ProbeError) else type(error).__name__
        response = {"status": "failed", "code": code[:80]}
        try:
            response["cleanup"] = cleanup(payload["plan"])
        except BaseException:
            response["cleanup"] = {"status": "needs-explicit-cleanup"}
    encoded = json.dumps(response, separators=(",", ":"), ensure_ascii=True)
    if len(encoded.encode()) > 3200:
        encoded = '{"status":"failed","code":"OUTPUT_BUDGET"}'
    print("DEVPOCKET_PROBE_RESULT=" + encoded, flush=True)
    signal.alarm(0)


if __name__ == "__main__":
    main(json.loads(base64.b64decode("__DEVPOCKET_PROBE_PAYLOAD__")))
