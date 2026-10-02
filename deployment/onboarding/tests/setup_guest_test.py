import copy
import importlib.util
import io
import json
import sys
import types
from pathlib import Path
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("setup_guest", Path(__file__).parents[1] / "guest.py")
guest = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"fcntl": types.ModuleType("fcntl"), "resource": types.ModuleType("resource")}
                if sys.platform == "win32" else {}):
    spec.loader.exec_module(guest)


class SetupGuestTest(unittest.TestCase):
    def setUp(self):
        self.scope = {"vmId": "/subscriptions/test/vm/relay", "vmUniqueId": "vm-instance", "deploymentId": "owner"}
        self.release = "a" * 64
        self.container = {
            "Image": "sha256:" + "b" * 64, "State": {"Running": True, "Health": {"Status": "healthy"}},
            "Config": {"Image": "devpocket-relay:" + self.release, "User": "1000:1000",
                       "Cmd": ["node", "dist/cli.js", "relay", "--data", "/data", "--url",
                               "https://relay.example.test", "--trusted-proxy", "127.0.0.1"]},
            "Mounts": [{"Destination": "/data", "Type": "bind", "Source": "/srv/devpocket/relay", "RW": True}],
        }
        self.files = {
            "/srv/devpocket/.owner": "owner", "/var/lib/devpocket/owner": "owner",
            "/srv/devpocket/current.json": json.dumps({"releaseId": self.release}),
            "/srv/devpocket/relay/relay.sqlite": "existing database",
        }
        self.mounted = True
        outer = self

        class FakePath:
            def __init__(self, name):
                self.name = str(name)

            def __truediv__(self, name):
                return FakePath(self.name + "/" + name)

            def __str__(self):
                return self.name

            def is_mount(self):
                return outer.mounted and self.name == "/srv/devpocket"

            def is_symlink(self):
                return False

            def is_file(self):
                return self.name in outer.files

            def read_text(self):
                return outer.files[self.name]

        class Opener:
            def open(self, request, timeout):
                value = outer.scope["vmUniqueId"] if "/vmId?" in request.full_url else outer.scope["vmId"]
                return io.BytesIO(value.encode())

        def command(args):
            if args[:2] == ["docker", "ps"]:
                return ("c" * 12).encode()
            self.assertEqual(args[:2], ["docker", "inspect"])
            return json.dumps([self.container]).encode()

        for patcher in [
            patch.object(guest, "Path", FakePath), patch.object(guest, "command", command),
            patch.object(guest.os, "geteuid", lambda: 0, create=True),
            patch.object(guest.urllib.request, "build_opener", lambda *_: Opener()),
        ]:
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_discovery_reads_live_release_without_old_local_evidence(self):
        target, url = guest.context(self.scope, discovering=True)
        self.assertEqual(url, "https://relay.example.test")
        self.assertEqual(target["releaseId"], self.release)
        self.assertEqual(target["imageId"], self.container["Image"])
        self.assertEqual(target["databasePath"], "/srv/devpocket/relay/relay.sqlite")
        recorded = {**self.scope, **{k: target[k] for k in ["releaseId", "imageId", "containerId"]}, "relayUrl": url}
        self.assertEqual(guest.context(recorded), target)
        recorded["containerId"] = "d" * 12
        with self.assertRaisesRegex(RuntimeError, "RELAY_CONTAINER_CHANGED"):
            guest.context(recorded)

    def test_discovery_fails_closed_for_wrong_relay_mount_image_command_and_health(self):
        original = copy.deepcopy(self.container)
        changes = [
            lambda c: c["Mounts"][0].update(Source="/another/database"),
            lambda c: c["Config"].update(Image="unrelated:image"),
            lambda c: c["Config"].update(User="root"),
            lambda c: c["State"]["Health"].update(Status="unhealthy"),
            lambda c: c["Config"]["Cmd"].__setitem__(6, "http://relay.example.test"),
            lambda c: c["Config"]["Cmd"].__setitem__(6, "https://user:secret@relay.example.test"),
        ]
        for change in changes:
            self.container = copy.deepcopy(original)
            change(self.container)
            with self.assertRaises(RuntimeError):
                guest.context(self.scope, discovering=True)

    def test_missing_mount_or_database_never_creates_a_replacement(self):
        self.mounted = False
        with self.assertRaisesRegex(RuntimeError, "OWNED_DATA_MOUNT_REQUIRED"):
            guest.context(self.scope, discovering=True)
        self.mounted = True
        del self.files["/srv/devpocket/relay/relay.sqlite"]
        with self.assertRaisesRegex(RuntimeError, "EXISTING_DATABASE_REQUIRED"):
            guest.context(self.scope, discovering=True)


if __name__ == "__main__":
    unittest.main()
