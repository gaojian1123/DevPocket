import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import tarfile
import time
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import os

spec = importlib.util.spec_from_file_location("probe_receiver", Path(__file__).with_name("receiver.py"))
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)
ROOT = Path(__file__).resolve().parents[3] / ".data" / "probe-local-tests"
ROOT.mkdir(parents=True, exist_ok=True)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fixture(content_bytes):
    sentinel = b"DPSYN-" + os.urandom(32).hex().encode()
    data = sentinel + b"\n" + os.urandom(content_bytes - len(sentinel) - 1)
    manifest = {"schemaVersion": 1, "purpose": "devpocket.synthetic.fixture.v1",
                "files": [{"name": "synthetic.bin", "sha256": sha(data), "bytes": len(data)}]}
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, content in [("synthetic.bin", data), ("release-manifest.json", json.dumps(manifest).encode())]:
            item = tarfile.TarInfo(name)
            item.size = len(content)
            archive.addfile(item, io.BytesIO(content))
    body = output.getvalue()
    return body, {"archiveBytes": len(body), "archiveSha256": sha(body),
                  "contentSha256": sha(data), "contentBytes": len(data)}, sentinel


class ReceiverTest(unittest.TestCase):
    def test_actual_receiver_positive_negative_idempotency_and_cleanup(self):
        small, small_info, sentinel = fixture(512)
        scale, scale_info, _ = fixture(44993)
        plan = {"protocol": receiver.PROTOCOL, "planHash": "a" * 64,
                "transferId": "00000000-0000-4000-8000-000000000002",
                "vmId": "/subscriptions/fixture/resourceGroups/fixture/providers/Microsoft.Compute/virtualMachines/fixture",
                "expiresAt": int(time.time() * 1000) + 600000, "fixtures": {"small": small_info, "scale": scale_info}}
        with tempfile.TemporaryDirectory(dir=ROOT) as temp, patch.object(receiver, "BASE", Path(temp)):
            public = receiver.initialize(plan)
            self.assertEqual(receiver.initialize(plan)["publicKeySha256"], public["publicKeySha256"])
            rsa_key = serialization.load_pem_public_key(public["publicKeyPem"].encode())
            for identifier, archive in [("small", small), ("scale", scale)]:
                secret, nonce = os.urandom(32), os.urandom(12)
                metadata = {"protocol": receiver.PROTOCOL, "probePlanHash": plan["planHash"], "vmId": plan["vmId"],
                            "transferId": plan["transferId"], "fixtureId": identifier,
                            "fixtureSha256": plan["fixtures"][identifier]["archiveSha256"],
                            "expiresAt": plan["expiresAt"], "archiveBytes": len(archive),
                            "algorithm": "RSA-OAEP-SHA256+A256GCM", "chunkBytes": receiver.CHUNK_BYTES,
                            "publicKeySha256": public["publicKeySha256"]}
                sealed = AESGCM(secret).encrypt(nonce, archive, receiver.canonical(metadata))
                ciphertext, tag = sealed[:-16], sealed[-16:]
                chunks = [ciphertext[i:i + receiver.CHUNK_BYTES] for i in range(0, len(ciphertext), receiver.CHUNK_BYTES)]
                envelope = {"metadata": metadata, "nonce": base64.b64encode(nonce).decode(),
                            "tag": base64.b64encode(tag).decode(),
                            "wrappedKey": base64.b64encode(rsa_key.encrypt(secret, padding.OAEP(
                                mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))).decode(),
                            "ciphertextSha256": sha(ciphertext),
                            "chunks": [{"bytes": len(chunk), "sha256": sha(chunk)} for chunk in chunks]}
                receiver.begin(plan, envelope)
                self.assertEqual(receiver.begin(plan, envelope)["status"], "duplicate_envelope")
                for index, chunk in enumerate(chunks):
                    encoded = base64.b64encode(chunk).decode()
                    receiver.receive_chunk(plan, identifier, index, encoded)
                    self.assertEqual(receiver.receive_chunk(plan, identifier, index, encoded)["status"], "duplicate_chunk")
                self.assertEqual(receiver.finish(plan, identifier)["sha256"], sha(archive))
                self.assertTrue(receiver.finish(plan, identifier)["duplicateFinalize"])
            self.assertEqual(receiver.negative_tests(plan)["status"], "negative_tests_passed")
            self.assertEqual(receiver.scan_buffers([b"clean"], {"sentinel": [sentinel]})["sentinel"], 0)
            self.assertGreater(receiver.scan_buffers([b"log:" + sentinel], {"sentinel": [sentinel]})["sentinel"], 0)
            result = receiver.cleanup(plan)
            self.assertTrue(result["directoryAbsent"])
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_wrong_owner_cannot_clean_other_probe_directory(self):
        _, info, _ = fixture(512)
        plan = {"protocol": receiver.PROTOCOL, "planHash": "a" * 64,
                "transferId": "00000000-0000-4000-8000-000000000002",
                "vmId": "fixture", "expiresAt": int(time.time() * 1000) + 600000, "fixtures": {"small": info}}
        with tempfile.TemporaryDirectory(dir=ROOT) as temp, patch.object(receiver, "BASE", Path(temp)):
            receiver.initialize(plan)
            wrong = {**plan, "planHash": "b" * 64}
            with self.assertRaisesRegex(receiver.ProbeError, "OWNER_MISMATCH"):
                receiver.cleanup(wrong)
            self.assertTrue(receiver.root_path(plan).exists())
            receiver.cleanup(plan)


if __name__ == "__main__":
    unittest.main()
