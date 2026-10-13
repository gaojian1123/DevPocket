import ctypes
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time


class NativeLifecycle:
    def __init__(self):
        self.enabled = False
        self.failed = False
        self.stage = "initialize"
        self.emitted = set()

    def emit(self, phase, **fields):
        if not self.enabled or self.failed or phase in self.emitted:
            return
        try:
            payload = json.dumps({"version": 1, "sequence": len(self.emitted) + 1,
                                  "phase": phase, **fields}, separators=(",", ":")).encode() + b"\n"
        except (TypeError, ValueError):
            self.failed = True
            return
        if len(payload) > 1024 or len(self.emitted) >= 12:
            self.failed = True
        else:
            try:
                offset = 0
                while offset < len(payload):
                    written = os.write(3, payload[offset:])
                    if written <= 0:
                        raise OSError("Diagnostic pipe did not accept data.")
                    offset += written
                self.emitted.add(phase)
                return
            except OSError:
                self.failed = True
        # Telemetry failure must not write to another failed pipe or interrupt cleanup.

    def exited(self, phase, code):
        if code is not None:
            self.emit(phase, returnCode=code, signalNumber=-code if code < 0 else 0)

    def observe_native(self, child):
        if child is None:
            return None, False
        try:
            code = child.poll()
        except OSError:
            return None, None
        if "cleanup-starting" in self.emitted:
            if "native-exited" not in self.emitted:
                self.exited("cleanup-native-exited", code)
        else:
            self.exited("native-exited", code)
        return code, code is None

    def failure(self, phase, error, native_alive=None):
        fields = {"stage": self.stage, "failureClass": "os-error" if isinstance(error, OSError) else
                  "invalid-request" if isinstance(error, ValueError) else "supervisor-error",
                  "errno": getattr(error, "errno", None)}
        if native_alive is not None:
            fields["nativeAlive"] = native_alive
        self.emit(phase, **fields)


def write_cleanup_ack():
    print("\nDEVPOCKET_OWNED_TREE_STOPPED", file=sys.stderr, flush=True)


def process_identity(pid):
    text = Path(f"/proc/{pid}/stat").read_text()
    fields = text[text.rindex(")") + 2:].split()
    return {"pid": pid, "parent": int(fields[1]), "state": fields[0], "start": fields[19]}


def descendants():
    table = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            table.append(process_identity(int(entry.name)))
        except (FileNotFoundError, ProcessLookupError):
            continue
    owned = {os.getpid()}
    while True:
        found = {item["pid"] for item in table if item["parent"] in owned}
        if found.issubset(owned):
            break
        owned.update(found)
    return [item for item in table if item["pid"] in owned and item["pid"] != os.getpid()]


def stop_descendants(exits=None):
    exits = {} if exits is None else exits
    deadline = time.monotonic() + 10
    while True:
        children = descendants()
        for child in children:
            descriptor = None
            try:
                descriptor = os.pidfd_open(child["pid"], 0)
                if process_identity(child["pid"])["start"] == child["start"]:
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError):
                pass
            finally:
                if descriptor is not None:
                    os.close(descriptor)
        try:
            while True:
                pid, status = os.waitpid(-1, os.WNOHANG)
                if not pid:
                    break
                exits[pid] = os.waitstatus_to_exitcode(status)
        except ChildProcessError:
            pass
        if not descendants():
            return exits
        if time.monotonic() >= deadline:
            raise RuntimeError("Owned Linux descendants did not confirm exit.")
        time.sleep(0.05)


def main(diagnostics):
    if sys.platform != "linux":
        raise RuntimeError("This command owner requires Linux.")
    first_line = bytearray()
    while len(first_line) <= 65536:
        byte = os.read(0, 1)
        if not byte:
            raise ValueError("Owned Linux command input closed before startup.")
        if byte == b"\n":
            break
        first_line.extend(byte)
    else:
        raise ValueError("Owned Linux command request exceeded its bound.")
    request = json.loads(first_line)
    diagnostics.enabled = request.get("nativeLifecycle") is True
    if diagnostics.enabled:
        os.set_blocking(3, False)
    diagnostics.emit("supervisor-starting")
    if (not isinstance(request.get("file"), str) or not request["file"] or
            not isinstance(request.get("arguments"), list) or
            not all(isinstance(value, str) for value in request["arguments"]) or
            not isinstance(request.get("ownerPid"), int) or request["ownerPid"] <= 0 or
            not 0 < request.get("timeoutMs", 0) <= 86400000 or
            not 0 <= request.get("graceMs", -1) <= 60000):
        raise ValueError("Invalid owned Linux command request.")
    owner = process_identity(request["ownerPid"])
    libc = ctypes.CDLL(None, use_errno=True)
    # Adopt orphaned descendants, including children that create a new process group.
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot establish Linux child-subreaper ownership.")
    setting = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(setting), 0, 0, 0) != 0 or setting.value != 1:
        raise RuntimeError("Linux child-subreaper ownership was not confirmed.")
    owner_descriptor = os.pidfd_open(owner["pid"], 0)
    if process_identity(owner["pid"])["start"] != owner["start"] or select.select([owner_descriptor], [], [], 0)[0]:
        os.close(owner_descriptor)
        raise RuntimeError("Command owner exited before startup.")
    state = {"stopping": False, "forced": False, "reason": None, "requestedSignal": None}

    def request_stop(reason, forced=False, requested_signal=None):
        state["stopping"] = True
        state["forced"] |= forced
        if state["reason"] is None:
            state["reason"] = reason
            state["requestedSignal"] = requested_signal

    signal.signal(signal.SIGTERM, lambda number, _: request_stop("supervisor-signal", True, number))
    signal.signal(signal.SIGINT, lambda number, _: request_stop("supervisor-signal", False, number))
    child = None
    exit_code = 124
    try:
        diagnostics.stage = "spawn"
        diagnostics.emit("spawn-starting")
        try:
            child = subprocess.Popen([request["file"], *request["arguments"]],
                                     stdin=subprocess.PIPE, start_new_session=True, close_fds=True)
        except OSError as error:
            diagnostics.emit("spawn-failed", errno=error.errno)
            raise
        diagnostics.emit("native-started")
        diagnostics.stage = "monitor"
        print("DEVPOCKET_OWNERSHIP_ACTIVE", file=sys.stderr, flush=True)

        started = time.monotonic()
        deadline = None
        input_buffer = bytearray()
        while True:
            code = child.poll()
            diagnostics.exited("native-exited", code)
            live = [item for item in descendants() if item["state"] != "Z"]
            if (not request.get("persistent") and code is not None) or not live:
                try:
                    exit_code = code if code is not None else child.wait(timeout=1)
                except subprocess.TimeoutExpired as error:
                    raise RuntimeError("Cannot reconcile the owned command's exit status.") from error
                diagnostics.exited("native-exited", exit_code)
                break
            try:
                if select.select([owner_descriptor], [], [], 0)[0]:
                    request_stop("owner-exited", True)
            except (FileNotFoundError, ProcessLookupError):
                request_stop("owner-exited", True)
            if select.select([0], [], [], 0)[0]:
                received = os.read(0, 4096)
                if not received:
                    request_stop("stdin-eof")
                input_buffer.extend(received)
                if len(input_buffer) > 65536:
                    request_stop("input-limit", True)
                while b"\n" in input_buffer:
                    line, _, remainder = input_buffer.partition(b"\n")
                    input_buffer = bytearray(remainder)
                    try:
                        child.stdin.write(line + b"\n")
                        child.stdin.flush()
                    except (BrokenPipeError, OSError):
                        request_stop("stdin-error")
                    if line.strip() == b"cancel":
                        request_stop("stdin-cancel")
            if time.monotonic() - started >= request["timeoutMs"] / 1000:
                request_stop("timeout")
            if state["stopping"] and deadline is None:
                deadline = time.monotonic() + request["graceMs"] / 1000
                _, native_alive = diagnostics.observe_native(child)
                fields = {"reason": state["reason"], "nativeAlive": native_alive}
                if state["requestedSignal"] is not None:
                    fields["requestedSignal"] = state["requestedSignal"]
                diagnostics.emit("stop-requested", **fields)
                try:
                    child.stdin.write(b"cancel\n")
                    child.stdin.flush()
                except (BrokenPipeError, OSError):
                    pass
            if state["forced"] or (deadline is not None and time.monotonic() >= deadline):
                break
            time.sleep(0.05)
    except (OSError, ValueError, RuntimeError) as error:
        diagnostics.failure("supervisor-failed", error, diagnostics.observe_native(child)[1])
        raise
    finally:
        try:
            if child is not None:
                diagnostics.stage = "cleanup"
                _, native_alive = diagnostics.observe_native(child)
                diagnostics.emit("cleanup-starting", nativeAlive=native_alive)
                exits = {}
                try:
                    try:
                        stop_descendants(exits)
                    finally:
                        if child.returncode is None and child.pid in exits:
                            child.returncode = exits[child.pid]
                        if "native-exited" not in diagnostics.emitted:
                            diagnostics.exited("cleanup-native-exited", child.returncode)
                except (OSError, ValueError, RuntimeError) as error:
                    diagnostics.failure("cleanup-failed", error, diagnostics.observe_native(child)[1])
                    raise
                write_cleanup_ack()
                diagnostics.emit("cleanup-complete")
        finally:
            os.close(owner_descriptor)
    return exit_code if exit_code != 0 or not diagnostics.failed else 1


if __name__ == "__main__":
    diagnostics = NativeLifecycle()
    try:
        sys.exit(main(diagnostics))
    except (OSError, ValueError, RuntimeError) as error:
        diagnostics.failure("supervisor-failed", error)
        print(f"Owned Linux command failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
