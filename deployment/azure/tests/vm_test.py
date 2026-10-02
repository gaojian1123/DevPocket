import importlib.util
import io
import json
import hashlib
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import sqlite3
from contextlib import closing

spec = importlib.util.spec_from_file_location("devpocket_vm", Path(__file__).parents[1] / "vm" / "control.py")
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
TEMP_ROOT = Path(__file__).resolve().parents[3] / ".data" / "azure-tests"
TEMP_ROOT.mkdir(parents=True, exist_ok=True)


class PrivateExtraction(unittest.TestCase):
    def archive(self, name="safe.txt", link=False, duplicate=False):
        out = io.BytesIO()
        with tarfile.open(fileobj=out, mode="w:gz") as tar:
            content = b"verified source"
            manifest = json.dumps({"files": [{"name": name, "sha256": hashlib.sha256(content).hexdigest()}]}).encode()
            for filename, body in [(name, content), ("release-manifest.json", manifest)]:
                info = tarfile.TarInfo(filename)
                info.size = len(body)
                if link and filename == name:
                    info.type = tarfile.SYMTYPE
                    info.linkname = "/etc/shadow"
                    info.size = 0
                tar.addfile(info, io.BytesIO(body))
            if duplicate:
                tar.addfile(tarfile.TarInfo(name), io.BytesIO(b""))
        return out.getvalue()

    def test_verified_regular_files_only(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as temp:
            dest = Path(temp) / "release"
            vm.extract(self.archive(), dest)
            self.assertEqual((dest / "safe.txt").read_text(), "verified source")

    def test_traversal_links_and_duplicate_entries_fail(self):
        for body in [self.archive("../escape"), self.archive("/absolute"), self.archive(link=True), self.archive(duplicate=True)]:
            with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as temp:
                with self.assertRaises(ValueError):
                    vm.extract(body, Path(temp) / "release")

    def test_failed_activation_restarts_previous_image_without_rewinding_database(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as temp:
            root = Path(temp)
            old, new = "a" * 64, "b" * 64
            for name in ["relay", "backups", "caddy-data", "caddy-config", "private", "releases"]:
                (root / name).mkdir()
            (root / "current.json").write_text(json.dumps({"releaseId": old}))
            (root / "prepared.json").write_text(json.dumps({"releaseId": new}))
            config = {"deploymentId": "fixture", "host": "relay.example.test", "tlsEmail": "operator@example.com",
                      "releaseId": new, "autostart": False}
            (root / "config.json").write_text(json.dumps(config))
            for release in [old, new]:
                directory = root / "releases" / release
                directory.mkdir()
                (directory / "deployment-state.json").write_text(json.dumps({
                    **config, "caddyImage": "caddy@sha256:" + "c" * 64,
                }))
            with closing(sqlite3.connect(root / "relay" / "relay.sqlite")) as connection:
                connection.execute("CREATE TABLE sent (id TEXT)")
                connection.execute("INSERT INTO sent VALUES ('must-not-repeat')")
                connection.commit()
            calls = []

            def docker(args, **kwargs):
                calls.append(args)
                if "up" in args and new in " ".join(args) and kwargs.get("check", True):
                    raise RuntimeError("Simulated unhealthy new image")
                return 0

            with patch.object(vm, "ROOT", root), patch.object(vm, "assert_owner"), patch.object(vm, "run", side_effect=docker):
                with self.assertRaisesRegex(RuntimeError, "Database was not rolled back"):
                    vm.activate(config)
            self.assertEqual(json.loads((root / "current.json").read_text())["releaseId"], old)
            self.assertTrue(any("up" in args and old in " ".join(args) for args in calls))
            with closing(sqlite3.connect(root / "relay" / "relay.sqlite")) as connection:
                self.assertEqual(connection.execute("SELECT id FROM sent").fetchone()[0], "must-not-repeat")
            self.assertEqual(len(list((root / "backups").glob("*/relay.sqlite"))), 1)

    def test_preparing_another_release_cannot_change_current_release_environment(self):
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as temp:
            root = Path(temp)
            old, new = "a" * 64, "b" * 64
            for release, host in [(old, "old.example.test"), (new, "new.example.test")]:
                directory = root / "releases" / release
                directory.mkdir(parents=True)
                (directory / "deployment-state.json").write_text(json.dumps({
                    "host": host, "tlsEmail": "operator@example.com", "caddyImage": "caddy@sha256:" + "c" * 64,
                }))
            with patch.object(vm, "ROOT", root):
                vm.compose(old, ["config", "--quiet"])
                before = (root / "releases" / old / "runtime.env").read_bytes()
                vm.compose(new, ["config", "--quiet"])
                self.assertEqual((root / "releases" / old / "runtime.env").read_bytes(), before)
                self.assertIn("old.example.test", before.decode())
                self.assertNotIn("new.example.test", before.decode())


if __name__ == "__main__":
    unittest.main()
