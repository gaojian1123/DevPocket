import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time


def main(request_file):
    request_path = Path(request_file).resolve(strict=True)
    info = request_path.stat()
    if os.geteuid() != 0 or info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > 65536:
        raise RuntimeError("A root-owned private command request is required.")
    request = json.loads(request_path.read_text())
    if (request.get("version") != 1 or not isinstance(request.get("uid"), int) or request["uid"] < 1000
            or not isinstance(request.get("gid"), int) or request["gid"] < 1000
            or not isinstance(request.get("arguments"), list)
            or not all(isinstance(value, str) for value in request["arguments"])
            or not Path(request.get("file", "")).is_absolute()
            or not Path(request.get("cwd", "")).is_absolute()
            or not 0 < request.get("timeoutMs", 0) <= 86400000):
        raise ValueError("Invalid isolated command request.")
    helper = Path(__file__).with_name("owned-command-linux.py")
    spec = importlib.util.spec_from_file_location("devpocket_owned_command", helper)
    owned = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(owned)
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot establish isolated process ownership.")
    receipt = {"version": 1, "id": request["id"], "status": "blocked", "started": False,
               "processTreeStopped": False, "exitCode": None}
    child = None
    try:
        child = subprocess.Popen([
            "/usr/bin/setpriv", "--reuid", str(request["uid"]), "--regid", str(request["gid"]),
            "--clear-groups", "--no-new-privs", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all",
            "--", request["file"], *request["arguments"],
        ], cwd=request["cwd"], env=request["environment"], stdin=subprocess.PIPE,
            start_new_session=True, close_fds=True)
        receipt["started"] = True
        started = time.monotonic()
        while child.poll() is None:
            if time.monotonic() - started >= request["timeoutMs"] / 1000:
                raise TimeoutError("Isolated command deadline expired.")
            if select.select([0], [], [], 0)[0]:
                message = os.read(0, 4096)
                if message != b"" and message.strip() != b"cancel":
                    raise ValueError("Unsupported isolated command control message.")
                raise InterruptedError("Isolated command was cancelled.")
            time.sleep(0.05)
        code = child.returncode
        receipt.update(status="executed", exitCode=code if code >= 0 else 128 - code)
    finally:
        try:
            owned.stop_descendants()
            receipt["processTreeStopped"] = True
        finally:
            descriptor = os.open(str(request_path) + ".result.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as output:
                json.dump(receipt, output, separators=(",", ":"))
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
    return receipt["exitCode"]


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1]))
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        print(json.dumps({"status": "blocked", "phase": "isolated-command", "error": type(error).__name__}),
              file=sys.stderr)
        sys.exit(78)
