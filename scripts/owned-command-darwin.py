import ctypes
import errno
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time


class UniqueInfo(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_byte * 16), ("unique", ctypes.c_uint64),
                ("parent_unique", ctypes.c_uint64), ("version", ctypes.c_int32),
                ("parent_version", ctypes.c_int32), ("reserved", ctypes.c_uint64 * 2)]


class BsdInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "flags", "status", "exit_status", "pid", "parent", "uid", "gid",
        "real_uid", "real_gid", "saved_uid", "saved_gid", "reserved")]
    _fields_ += [("command", ctypes.c_byte * 16), ("name", ctypes.c_byte * 32)]
    _fields_ += [(name, ctypes.c_uint32) for name in (
        "files", "group", "jobs", "device", "tty_group", "nice")]
    _fields_ += [("started", ctypes.c_uint64), ("started_usec", ctypes.c_uint64)]


class ProcessInfo(ctypes.Structure):
    _fields_ = [("bsd", BsdInfo), ("identity", UniqueInfo)]


class UnstableOwnershipError(RuntimeError):
    pass


class Darwin:
    def __init__(self):
        if sys.platform != "darwin":
            raise RuntimeError("This command owner requires macOS.")
        self.lib = ctypes.CDLL(None, use_errno=True)
        self.lib.proc_pidinfo.argtypes = [
            ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_listpids.argtypes = [
            ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_signal_with_audittoken.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.lib.responsibility_get_pid_responsible_for_pid.argtypes = [ctypes.c_int]

    def identity(self, pid, *, include_zombies=False):
        for attempt in range(8):
            value = ProcessInfo()
            size = self.lib.proc_pidinfo(pid, 18, int(include_zombies), ctypes.byref(value), ctypes.sizeof(value))
            code = ctypes.get_errno()
            if size == 0 and code in (errno.ESRCH, errno.ENOENT):
                return None
            # PID creation/reaping can briefly refuse inspection; a refusal is never proof of exit.
            if size == 0 and code in (errno.EPERM, errno.EINTR, errno.EAGAIN) and attempt < 7:
                time.sleep(0.001)
                continue
            if size != ctypes.sizeof(value) or value.bsd.pid != pid or not value.identity.unique:
                raise RuntimeError(f"macOS process identity is incomplete (result {size}, OS error {code}).")
            return value

    def processes(self):
        for count in (4096, 16384, 65536):
            buffer = (ctypes.c_int * count)()
            size = self.lib.proc_listpids(4, os.getuid(), buffer, ctypes.sizeof(buffer))
            if size <= 0 or size % ctypes.sizeof(ctypes.c_int):
                raise RuntimeError("macOS process enumeration failed.")
            if size < ctypes.sizeof(buffer):
                return [pid for pid in buffer[:size // ctypes.sizeof(ctypes.c_int)] if pid > 0]
        raise RuntimeError("macOS process enumeration exceeded its bound.")

    def responsible(self, pid):
        return self.lib.responsibility_get_pid_responsible_for_pid(pid)

    def send(self, info, number):
        # The kernel checks PID version atomically; a recycled PID is never signalled.
        token = (ctypes.c_uint32 * 8)()
        token[5], token[7] = info.bsd.pid, info.identity.version
        result = self.lib.proc_signal_with_audittoken(ctypes.byref(token), number)
        if result not in (0, errno.ESRCH):
            raise OSError(result, "Cannot signal the bound macOS process.")

    def live(self, info):
        current = self.identity(info.bsd.pid)
        return current is not None and current.identity.unique == info.identity.unique and current.bsd.status != 5

    def owned(self):
        zombies = set()
        empty = 0
        for _ in range(8):
            result = []
            stable = True
            observed_zombies = set()
            for pid in self.processes():
                if pid == os.getpid():
                    continue
                info = self.identity(pid)
                if info is None:
                    # A nonzero proc_pidinfo argument also searches the kernel's zombie list.
                    info = self.identity(pid, include_zombies=True)
                    if info is None or info.bsd.status != 5:
                        stable = False
                        continue
                identity = (pid, info.identity.unique, info.identity.version)
                if info.bsd.status == 5:
                    observed_zombies.add(identity)
                    stable = stable and identity in zombies
                    continue
                responsible = self.responsible(pid)
                current = self.identity(pid)
                if current is None or current.bsd.status == 5:
                    stable = False
                    if current is not None:
                        observed_zombies.add((pid, current.identity.unique, current.identity.version))
                    continue
                if (current.identity.unique != info.identity.unique or
                        current.identity.version != info.identity.version or responsible <= 0):
                    stable = False
                    continue
                if responsible == os.getpid():
                    result.append(info)
            zombies = observed_zombies
            if result:
                return result
            # A disappearing parent can fork after enumeration; confirm emptiness with another full scan.
            empty = empty + 1 if stable else 0
            if empty >= 2:
                return []
        raise UnstableOwnershipError("macOS process ownership did not stabilize; cleanup is unconfirmed.")


def registry_lock():
    import fcntl

    info = os.fstat(3)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
            info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size != 0):
        raise ValueError("The macOS registry lock must be a private regular file.")
    try:
        fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 75
    return 0


def bootstrap(native):
    attr = ctypes.c_void_p()
    lib = native.lib
    lib.posix_spawnattr_init.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
    lib.posix_spawnattr_destroy.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
    lib.responsibility_spawnattrs_setdisclaim.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_int]
    lib.posix_spawn.argtypes = [
        ctypes.POINTER(ctypes.c_int), ctypes.c_char_p, ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_char_p), ctypes.POINTER(ctypes.c_char_p)]
    result = lib.posix_spawnattr_init(ctypes.byref(attr))
    if result:
        raise OSError(result, "Cannot initialize the macOS process scope.")
    try:
        result = lib.responsibility_spawnattrs_setdisclaim(ctypes.byref(attr), 1)
        if result:
            raise OSError(result, "macOS responsibility scopes are unavailable.")
        arguments = [sys.executable, "-B", str(Path(__file__).resolve()), "--scope", str(os.getpid())]
        argv = (ctypes.c_char_p * (len(arguments) + 1))(*map(os.fsencode, arguments), None)
        values = [os.fsencode(f"{key}={value}") for key, value in os.environ.items()]
        environment = (ctypes.c_char_p * (len(values) + 1))(*values, None)
        pid = ctypes.c_int()
        result = lib.posix_spawn(ctypes.byref(pid), os.fsencode(sys.executable), None,
                                ctypes.byref(attr), argv, environment)
        if result:
            raise OSError(result, "Cannot start the macOS process scope.")
    finally:
        lib.posix_spawnattr_destroy(ctypes.byref(attr))
    child = native.identity(pid.value)
    if child is None:
        raise RuntimeError("The macOS process scope exited before attachment.")
    for number in (signal.SIGINT, signal.SIGTERM):
        signal.signal(number, lambda received, _frame: native.send(child, received))
    _, status = os.waitpid(pid.value, 0)
    code = os.waitstatus_to_exitcode(status)
    return code if code >= 0 else 128 - code


def read_request():
    data = bytearray()
    while len(data) <= 65536:
        value = os.read(0, 1)
        if not value:
            raise ValueError("Command input closed before startup.")
        if value == b"\n":
            break
        data.extend(value)
    else:
        raise ValueError("Command request exceeded its bound.")
    request = json.loads(data)
    if (not isinstance(request, dict) or not isinstance(request.get("file"), str) or
            not request["file"] or "\0" in request["file"] or
            not isinstance(request.get("arguments"), list) or
            not all(isinstance(item, str) and "\0" not in item for item in request["arguments"]) or
            type(request.get("ownerPid")) is not int or request["ownerPid"] <= 0 or
            type(request.get("timeoutMs")) is not int or not 0 < request["timeoutMs"] <= 86400000 or
            type(request.get("graceMs")) is not int or not 0 <= request["graceMs"] <= 60000 or
            type(request.get("deadlineUnixMs")) is not int or request["deadlineUnixMs"] <= 0 or
            not isinstance(request.get("receiptId"), str) or
            not re.fullmatch(r"[a-f0-9-]{36}", request["receiptId"]) or
            request.get("nativeLifecycle") is True):
        raise ValueError("Invalid macOS command request.")
    return request


class Scope:
    def __init__(self, native):
        self.native = native
        self.nested = {}
        self.parent = None
        self.directory = tempfile.TemporaryDirectory(prefix="devpocket-owner-", dir="/private/tmp")
        self.address = str(Path(self.directory.name) / "owner.sock")
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(self.address)
        os.chmod(self.address, 0o600)
        self.server.listen(32)
        self.server.setblocking(False)

    def join_parent(self, bootstrap_pid):
        text = os.environ.get("DEVPOCKET_DARWIN_SCOPE")
        if text is None:
            return
        parent = json.loads(text)
        if (not isinstance(parent, dict) or set(parent) != {"pid", "version", "socket"} or
                type(parent["pid"]) is not int or type(parent["version"]) is not int or
                not isinstance(parent["socket"], str) or
                not re.fullmatch(r"/private/tmp/devpocket-owner-[A-Za-z0-9_-]+/owner\.sock", parent["socket"])):
            raise ValueError("Invalid inherited macOS ownership scope.")
        identity = self.native.identity(parent["pid"])
        if (identity is None or identity.identity.version != parent["version"] or
                self.native.responsible(bootstrap_pid) != parent["pid"]):
            raise RuntimeError("Inherited macOS ownership changed.")
        channel = socket.socket(socket.AF_UNIX)
        try:
            channel.settimeout(10)
            channel.connect(parent["socket"])
            response = b""
            while response != b"registered\n":
                part = channel.recv(16)
                response += part
                if not part or not b"registered\n".startswith(response):
                    raise RuntimeError("The parent did not register this macOS scope.")
            channel.setblocking(False)
            self.parent = channel
        except BaseException:
            channel.close()
            raise

    def environment(self):
        identity = self.native.identity(os.getpid())
        return {**os.environ, "DEVPOCKET_DARWIN_SCOPE": json.dumps({
            "pid": os.getpid(), "version": identity.identity.version, "socket": self.address})}

    def poll(self):
        while select.select([self.server], [], [], 0)[0]:
            channel, _ = self.server.accept()
            try:
                peer = struct.unpack("i", channel.getsockopt(0, 2, 4))[0]
                child = self.native.identity(peer)
                if (child is None or self.native.responsible(peer) != peer or
                        self.native.responsible(child.bsd.parent) != os.getpid() or
                        peer in self.nested or len(self.nested) >= 4096):
                    raise RuntimeError("Unbound nested macOS ownership request.")
                channel.sendall(b"registered\n")
                channel.setblocking(False)
                self.nested[peer] = {"identity": child, "channel": channel, "clean": False, "buffer": b""}
            except BaseException:
                channel.close()
                raise
        for pid, entry in list(self.nested.items()):
            channel = entry["channel"]
            if channel is not None and select.select([channel], [], [], 0)[0]:
                data = channel.recv(16)
                entry["buffer"] += data
                if not b"clean\n".startswith(entry["buffer"]):
                    channel.close()
                    entry["channel"] = None
                    raise RuntimeError("Invalid nested macOS cleanup acknowledgement.")
                if entry["buffer"] == b"clean\n":
                    entry["clean"] = True
                if not data:
                    channel.close()
                    entry["channel"] = None
                    if not entry["clean"]:
                        raise RuntimeError("Nested macOS cleanup was not confirmed.")
            if entry["clean"] and not self.native.live(entry["identity"]):
                if entry["channel"] is not None:
                    entry["channel"].close()
                del self.nested[pid]

    def cleanup(self, child):
        deadline = time.monotonic() + 15
        signalled = set()
        failure = None
        while True:
            try:
                if child is not None:
                    child.poll()
                self.poll()
            except (OSError, ValueError, RuntimeError) as error:
                failure = failure or error
            protected = set()
            pending = False
            for pid, entry in self.nested.items():
                try:
                    if self.native.live(entry["identity"]):
                        protected.add(entry["identity"].bsd.parent)
                        pending = True
                        if pid not in signalled:
                            self.native.send(entry["identity"], signal.SIGTERM)
                            signalled.add(pid)
                    elif not entry["clean"]:
                        if entry["channel"] is not None:
                            # Peer exit may precede reading its queued acknowledgement or EOF.
                            pending = True
                        else:
                            failure = failure or RuntimeError("A nested macOS owner exited without confirming cleanup.")
                except (OSError, ValueError, RuntimeError) as error:
                    failure = failure or error
                    pending = True
                    protected.add(entry["identity"].bsd.parent)
            owned = None
            snapshot_error = None
            try:
                owned = self.native.owned()
            except UnstableOwnershipError as error:
                snapshot_error = error
            except (OSError, ValueError, RuntimeError) as error:
                failure = failure or error
            for info in owned or []:
                if info.bsd.pid not in protected:
                    try:
                        self.native.send(info, signal.SIGKILL)
                    except (OSError, ValueError, RuntimeError) as error:
                        failure = failure or error
            if owned == [] and not pending:
                if failure is not None:
                    raise failure
                return
            if time.monotonic() >= deadline:
                raise RuntimeError("Owned macOS processes did not confirm exit.") from (failure or snapshot_error)
            time.sleep(0.02)

    def close(self, clean):
        if self.parent is not None:
            try:
                if clean:
                    self.parent.sendall(b"clean\n")
            finally:
                self.parent.close()
        for entry in self.nested.values():
            if entry["channel"] is not None:
                entry["channel"].close()
        self.server.close()
        self.directory.cleanup()


def supervise(native, bootstrap_pid):
    if os.getppid() != bootstrap_pid or native.responsible(os.getpid()) != os.getpid():
        raise RuntimeError("The macOS kernel did not establish an isolated responsibility scope.")
    request = read_request()
    bootstrap_identity = native.identity(bootstrap_pid)
    if bootstrap_identity is None or bootstrap_identity.bsd.parent != request["ownerPid"]:
        raise RuntimeError("The command owner changed before startup.")
    owner = native.identity(request["ownerPid"])
    if owner is None:
        raise RuntimeError("The command owner exited before startup.")
    state = {"stop": request.get("cancelled") is True, "control_open": True}

    def control(phase):
        if not state["control_open"]:
            return
        try:
            os.write(2, f"\x1eDEVPOCKET:{request['receiptId']}:{phase}\x1f".encode())
        except BrokenPipeError:
            # A lost reader must not skip target cancellation or the stopping grace.
            state.update(stop=True, control_open=False)

    scope = Scope(native)
    child = None
    clean = False
    for number in (signal.SIGINT, signal.SIGTERM):
        signal.signal(number, lambda _number, _frame: state.update(stop=True))
    deadline = time.monotonic() + max(0, (request["deadlineUnixMs"] - time.time() * 1000) / 1000)
    stopping_at = None
    buffer = bytearray()
    received = 0
    code = 130

    def input_ready():
        nonlocal received, buffer
        while select.select([0], [], [], 0)[0]:
            data = os.read(0, 4096)
            if not data:
                state["stop"] = True
                return
            received += len(data)
            buffer.extend(data)
            if received > 65536:
                raise ValueError("macOS control input exceeded its bound.")
            while b"\n" in buffer:
                line, _, remaining = buffer.partition(b"\n")
                buffer = bytearray(remaining)
                if line.rstrip(b"\r") != b"cancel":
                    raise ValueError("Unsupported macOS control input.")
                state["stop"] = True

    try:
        scope.join_parent(bootstrap_pid)
        input_ready()
        if time.monotonic() >= deadline:
            control("deadline-expired")
            return 124
        if state["stop"]:
            control("cancel-accepted")
            return 130
        child = subprocess.Popen([request["file"], *request["arguments"]], stdin=subprocess.PIPE,
                                 start_new_session=True, close_fds=True, env=scope.environment())
        control("active")
        while True:
            scope.poll()
            input_ready()
            if not native.live(owner) or not native.live(bootstrap_identity):
                state["stop"] = True
            now = time.monotonic()
            if now >= deadline:
                if not state["stop"]:
                    control("deadline-expired")
                state["stop"] = True
                code = 124
            if state["stop"] and stopping_at is None:
                stopping_at = now + request["graceMs"] / 1000
                control("cancel-accepted")
                try:
                    child.stdin.write(b"cancel\n")
                    child.stdin.flush()
                except BrokenPipeError:
                    pass
            result = child.poll()
            if result is not None:
                try:
                    finished = not request.get("persistent") or not native.owned()
                except UnstableOwnershipError:
                    finished = False
                if finished:
                    if not state["stop"]:
                        code = result if result >= 0 else 128 - result
                    break
            if stopping_at is not None and now >= stopping_at:
                break
            time.sleep(0.02)
    except (OSError, ValueError, RuntimeError, AttributeError) as error:
        # The cleanup receipt must remain the final output for this command.
        report_error(error)
        code = 1
    finally:
        try:
            scope.cleanup(child)
            clean = True
        finally:
            try:
                if child is not None:
                    try:
                        child.stdin.close()
                    except BrokenPipeError:
                        pass
            finally:
                scope.close(clean)
        control("tree-stopped")
    return code


def report_error(error):
    print(f"Owned macOS command failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)


def main():
    native = Darwin()
    if sys.argv[1:] == ["--registry-lock"]:
        return registry_lock()
    if sys.argv[1:] == ["--probe"]:
        identity = native.identity(os.getpid())
        if identity is None:
            raise RuntimeError("macOS process identity is unavailable.")
        print(json.dumps({"platform": "darwin", "release": os.uname().release, "ownership": "responsibility-audit-token"}))
        return 0
    if len(sys.argv) == 3 and sys.argv[1] == "--family" and sys.argv[2].isdigit():
        info = native.identity(int(sys.argv[2]))
        # A dead controller alone cannot prove that its orphaned preparations exited.
        print("alive" if info is not None and info.bsd.status != 5 else "unknown")
        return 0
    if len(sys.argv) == 4 and sys.argv[1] == "--listener" and all(arg.isdigit() for arg in sys.argv[2:]):
        port, parent = map(int, sys.argv[2:])
        if not 0 < port <= 65535 or parent <= 0:
            raise ValueError("Invalid macOS listener query.")
        scopes = {pid for pid in native.processes()
                  if (info := native.identity(pid)) is not None and info.bsd.parent == parent
                  and native.responsible(pid) == pid and info.bsd.status != 5}
        listeners = subprocess.run(["/usr/sbin/lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                                   capture_output=True, text=True, timeout=10, check=False)
        if listeners.returncode not in (0, 1) or listeners.stderr.strip():
            raise RuntimeError("macOS listener ownership is unavailable.")
        pids = listeners.stdout.split()
        if any(not pid.isdigit() for pid in pids):
            raise RuntimeError("Invalid macOS listener evidence.")
        print("owned" if pids and all(native.responsible(int(pid)) in scopes for pid in pids) else "not-owned")
        return 0
    if len(sys.argv) == 3 and sys.argv[1] == "--scope" and sys.argv[2].isdigit():
        return supervise(native, int(sys.argv[2]))
    if len(sys.argv) != 1:
        raise ValueError("Unsupported macOS owner invocation.")
    return bootstrap(native)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, AttributeError) as error:
        report_error(error)
        sys.exit(1)
