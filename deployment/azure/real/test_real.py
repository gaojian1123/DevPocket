import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import time
import types
import contextlib
import sys
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def load(name):
    spec = importlib.util.spec_from_file_location("real_" + name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

receiver, control = load("receiver"), load("control")
TEST_ROOT = Path(__file__).resolve().parents[3] / ".data" / "real-local-tests"
TEST_ROOT.mkdir(parents=True, exist_ok=True)
sha = lambda value: hashlib.sha256(value).hexdigest()


def fixture(unsafe=False):
    binding = {"deploymentId": "owner-fixture", "host": "fixture.example", "tlsEmail": "operator@example.com", "autostart": True}
    files = {"package.json": b'{"version":"0.1.0"}',
             "deployment-target.json": json.dumps({"schemaVersion": 1, **binding}).encode(),
             "deployment/azure/vm/control.py": b'raise RuntimeError("FIXTURE_MUST_NOT_EXECUTE")\n',
             "backend/src/test.ts": b"NON_SENSITIVE_TEST_SOURCE_" * 40}
    manifest = json.dumps({"schemaVersion": 1, "files": [{"name": n, "sha256": sha(b)} for n, b in files.items()]}).encode()
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as archive:
        for name, value in {**files, "release-manifest.json": manifest}.items():
            item = tarfile.TarInfo("../escape" if unsafe and name == "package.json" else name)
            item.size = len(value)
            archive.addfile(item, io.BytesIO(value))
    body = out.getvalue()
    plan = {"protocol": receiver.PROTOCOL, "planHash": "a" * 64, "vmId": "fixture-vm",
            "transferId": "00000000-0000-4000-8000-000000000071", "expiresAt": int(time.time() * 1000) + 600000,
            "transportSourceHash": "b" * 64, "dataDiskGiB": 32, "serviceBinding": binding,
            "business": {"archiveSha256": sha(body), "archiveBytes": len(body), "manifestSha256": sha(manifest),
                         "controlSha256": sha(files["deployment/azure/vm/control.py"]), "fileCount": len(files),
                         "originSourceHash": "c" * 64}}
    return body, plan


def envelope(plan, body, pub):
    key, nonce = os.urandom(32), os.urandom(12)
    metadata = {"protocol": receiver.PROTOCOL, "planHash": plan["planHash"], "vmId": plan["vmId"],
                "transferId": plan["transferId"], "packageSha256": plan["business"]["archiveSha256"],
                "manifestSha256": plan["business"]["manifestSha256"], "expiresAt": plan["expiresAt"],
                "transportSourceHash": plan["transportSourceHash"], "archiveBytes": len(body),
                "publicKeySha256": pub["publicKeySha256"], "algorithm": "RSA-OAEP-SHA256+A256GCM", "chunkBytes": receiver.CHUNK}
    cipher = AESGCM(key).encrypt(nonce, body, receiver.canonical(metadata))
    rsa_key = serialization.load_pem_public_key(pub["publicKeyPem"].encode())
    ciphertext, tag = cipher[:-16], cipher[-16:]
    chunks = [ciphertext[i:i + receiver.CHUNK] for i in range(0, len(ciphertext), receiver.CHUNK)]
    env = {"metadata": metadata, "nonce": base64.b64encode(nonce).decode(), "tag": base64.b64encode(tag).decode(),
           "wrappedKey": base64.b64encode(rsa_key.encrypt(key, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))).decode(),
           "ciphertextSha256": sha(ciphertext), "chunks": [{"bytes": len(c), "sha256": sha(c)} for c in chunks]}
    return env, chunks


class RealReceiverTests(unittest.TestCase):
    def test_real_protocol_authentication_manifest_duplicates_and_exact_cleanup(self):
        body, plan = fixture()
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as temp, patch.object(receiver, "BASE", Path(temp)):
            other = Path(temp) / "unrelated"
            other.mkdir()
            (other / "keep").write_text("preserve")
            pub = receiver.initialize(plan)
            env, chunks = envelope(plan, body, pub)
            for mode, expected in [("target", "VM_TARGET_MISMATCH"), ("expiry", "EXPIRED")]:
                bad = json.loads(json.dumps(env))
                if mode == "target":
                    bad["metadata"]["vmId"] = "wrong-vm"
                else:
                    bad["metadata"]["expiresAt"] = 1
                with self.assertRaisesRegex(receiver.ReleaseError, expected):
                    receiver.begin(plan, bad)
            receiver.begin(plan, env)
            self.assertEqual(receiver.begin(plan, env)["status"], "duplicate_envelope")
            for index, value in enumerate(chunks):
                data = base64.b64encode(value).decode()
                receiver.chunk(plan, index, data)
                self.assertEqual(receiver.chunk(plan, index, data)["status"], "duplicate_chunk")
            with self.assertRaisesRegex(receiver.ReleaseError, "CHUNK_CONFLICT"):
                receiver.chunk(plan, 0, base64.b64encode(b"different").decode())
            file = receiver.directory(plan) / "envelope.json"
            bad = json.loads(json.dumps(env))
            bad["tag"] = base64.b64encode(bytes([decode ^ 1 for decode in base64.b64decode(env["tag"])])).decode()
            file.write_text(json.dumps(bad))
            with self.assertRaisesRegex(receiver.ReleaseError, "AUTHENTICATION_FAILED"):
                receiver.authenticate(plan)
            self.assertFalse((receiver.directory(plan) / "quarantine").exists())
            file.write_text(json.dumps(env))
            self.assertEqual(receiver.authenticate(plan)["status"], "archive_authenticated")
            self.assertTrue(receiver.authenticate(plan)["duplicate"])
            self.assertTrue(receiver.cleanup(plan)["directoryAbsent"])
            self.assertEqual((other / "keep").read_text(), "preserve")

    def test_wrong_archive_and_traversal_are_rejected_before_import(self):
        body, plan = fixture()
        with self.assertRaisesRegex(receiver.ReleaseError, "FROZEN_PACKAGE_HASH"):
            receiver.inspect_archive(plan, body + b"tamper")
        unsafe, unsafe_plan = fixture(unsafe=True)
        with self.assertRaisesRegex(receiver.ReleaseError, "UNSAFE_MEMBER"):
            receiver.inspect_archive(unsafe_plan, unsafe)
        wrong = {**plan, "business": {**plan["business"], "manifestSha256": "0" * 64}}
        with self.assertRaisesRegex(receiver.ReleaseError, "FROZEN_MANIFEST_HASH"):
            receiver.inspect_archive(wrong, body)

    def test_missing_authentication_or_import_prevents_frozen_code_build_and_start(self):
        _, plan = fixture()
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as temp, patch.object(control, "DATA", Path(temp) / "data"), \
                patch.object(control, "TRANSFERS", Path(temp) / "transfers"), patch.object(control, "load_frozen_control") as load_code:
            for action in [control.bootstrap, control.import_release, control.build, control.activate]:
                with self.assertRaises((control.ControlError, FileNotFoundError)):
                    action(plan)
            self.assertEqual(load_code.call_count, 0)

    def test_verified_import_reuses_core_owner_checks_and_never_calls_blob(self):
        body, plan = fixture()
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as temp, patch.object(receiver, "BASE", Path(temp) / "transfers"), \
                patch.object(control, "TRANSFERS", Path(temp) / "transfers"), patch.object(control, "DATA", Path(temp) / "data"):
            pub = receiver.initialize(plan)
            env, chunks = envelope(plan, body, pub)
            receiver.begin(plan, env)
            for index, data in enumerate(chunks):
                receiver.chunk(plan, index, base64.b64encode(data).decode())
            receiver.authenticate(plan)
            control.DATA.mkdir()
            (control.DATA / "releases").mkdir()
            control.record(plan, "bootstrap", {"dataDiskGiB": 32, "ownerVerified": True})
            calls = []
            fake = types.SimpleNamespace(assert_owner=lambda config: calls.append(("owner", config)),
                                         download=lambda *_: self.fail("Blob must never be invoked"))
            with patch.object(control, "load_frozen_control", return_value=fake):
                result = control.import_release(plan)
                self.assertEqual(result["status"], "release_imported")
                self.assertFalse(result["blobUsed"])
                self.assertEqual(control.import_release(plan)["status"], "release_imported")
            self.assertEqual(len(calls), 2)
            self.assertEqual(control.required_receipt(plan, "import")["blobUploadReceipt"], False)
            with self.assertRaisesRegex(control.ControlError, "BLOB_PATH_FORBIDDEN"):
                control.no_blob()
            receiver.cleanup(plan)
            self.assertTrue(control.release(plan).exists())

    def test_failed_import_removes_only_its_own_staging_and_no_build_can_follow(self):
        body, plan = fixture()
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as temp, patch.object(receiver, "BASE", Path(temp) / "transfers"), \
                patch.object(control, "TRANSFERS", Path(temp) / "transfers"), patch.object(control, "DATA", Path(temp) / "data"):
            pub = receiver.initialize(plan)
            env, chunks = envelope(plan, body, pub)
            receiver.begin(plan, env)
            for index, data in enumerate(chunks):
                receiver.chunk(plan, index, base64.b64encode(data).decode())
            receiver.authenticate(plan)
            (control.DATA / "releases").mkdir(parents=True)
            unrelated = control.DATA / "releases" / "unrelated"
            unrelated.mkdir()
            (unrelated / "keep").write_text("preserved")
            control.record(plan, "bootstrap", {"dataDiskGiB": 32, "ownerVerified": True})
            fake = types.SimpleNamespace(assert_owner=lambda *_: None)

            def failed_copy(_source, stage):
                stage.mkdir()
                (stage / "partial").write_text("non-sensitive fixture")
                raise OSError("SIMULATED_COPY_FAILURE")

            with patch.object(control, "load_frozen_control", return_value=fake), patch.object(control.shutil, "copytree", side_effect=failed_copy):
                with self.assertRaises(OSError):
                    control.import_release(plan)
            self.assertFalse((control.DATA / "releases" / (".incoming-" + plan["transferId"])).exists())
            self.assertFalse((control.state_dir(plan) / "import.json").exists())
            self.assertEqual((unrelated / "keep").read_text(), "preserved")
            with patch.object(control, "load_frozen_control") as load_code:
                with self.assertRaisesRegex(control.ControlError, "SUCCESS_RECEIPT_REQUIRED"):
                    control.build(plan)
                self.assertEqual(load_code.call_count, 0)
            receiver.cleanup(plan)

    def test_control_hash_mismatch_is_rejected_before_any_frozen_module_execution(self):
        body, plan = fixture()
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as temp, patch.object(receiver, "BASE", Path(temp)):
            pub = receiver.initialize(plan)
            env, chunks = envelope(plan, body, pub)
            receiver.begin(plan, env)
            for index, data in enumerate(chunks):
                receiver.chunk(plan, index, base64.b64encode(data).decode())
            receiver.authenticate(plan)
            wrong = {**plan, "business": {**plan["business"], "controlSha256": "0" * 64}}
            with self.assertRaisesRegex(control.ControlError, "FROZEN_CONTROL_HASH"):
                control.load_frozen_control(wrong, receiver.directory(plan) / "quarantine")
            receiver.cleanup(plan)

    def test_untrusted_control_stdout_and_exception_never_enter_arm_result(self):
        _, plan = fixture()
        sentinel = "NON_SENSITIVE_PRIVATE_BUILD_OUTPUT_SENTINEL"
        fake_fcntl = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *_: None)
        fake_resource = types.SimpleNamespace(RLIMIT_CORE=0, setrlimit=lambda *_: None)
        response = contextlib.closing(io.BytesIO(plan["vmId"].encode()))
        opener = types.SimpleNamespace(open=lambda *_args, **_kwargs: response)

        def failing_business_control(_plan):
            print(sentinel)
            print(sentinel, file=sys.stderr)
            raise RuntimeError(sentinel)

        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as temp, \
                patch.object(control, "LOCK_FILE", Path(temp) / "operations.lock"), \
                patch.object(control, "LOG_DIRECTORY", Path(temp) / "private-logs"), \
                patch.dict(sys.modules, {"fcntl": fake_fcntl, "resource": fake_resource}), \
                patch.object(control.os, "geteuid", return_value=0, create=True), \
                patch.object(control.signal, "SIGALRM", 14, create=True), \
                patch.object(control.signal, "signal"), patch.object(control.signal, "alarm", create=True), \
                patch.object(control.urllib.request, "build_opener", return_value=opener), \
                patch.object(control, "bootstrap", side_effect=failing_business_control):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                control.main({"plan": plan, "action": "bootstrap"})
            self.assertNotIn(sentinel, output.getvalue())
            self.assertIn('"code":"RuntimeError"', output.getvalue())
            log = next((Path(temp) / "private-logs").glob("*.log")).read_text()
            self.assertIn(sentinel, log)


if __name__ == "__main__":
    unittest.main()
