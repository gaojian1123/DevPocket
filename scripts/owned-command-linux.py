import ctypes
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time


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


def stop_descendants():
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
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            pass
        if not descendants():
            return
        if time.monotonic() >= deadline:
            raise RuntimeError("Owned Linux descendants did not confirm exit.")
        time.sleep(0.05)


def main():
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
    state = {"stopping": False, "forced": False}
    signal.signal(signal.SIGTERM, lambda *_: state.update(stopping=True, forced=True))
    signal.signal(signal.SIGINT, lambda *_: state.update(stopping=True))
    child = None
    try:
        child = subprocess.Popen([request["file"], *request["arguments"]],
                                 stdin=subprocess.PIPE, start_new_session=True)
        print("DEVPOCKET_OWNERSHIP_ACTIVE", file=sys.stderr, flush=True)

        started = time.monotonic()
        deadline = None
        exit_code = 124
        input_buffer = bytearray()
        while True:
            code = child.poll()
            live = [item for item in descendants() if item["state"] != "Z"]
            if (not request.get("persistent") and code is not None) or not live:
                try:
                    exit_code = code if code is not None else child.wait(timeout=1)
                except subprocess.TimeoutExpired as error:
                    raise RuntimeError("Cannot reconcile the owned command's exit status.") from error
                break
            try:
                if select.select([owner_descriptor], [], [], 0)[0]:
                    state.update(stopping=True, forced=True)
            except (FileNotFoundError, ProcessLookupError):
                state.update(stopping=True, forced=True)
            if select.select([0], [], [], 0)[0]:
                received = os.read(0, 4096)
                if not received:
                    state["stopping"] = True
                input_buffer.extend(received)
                if len(input_buffer) > 65536:
                    state.update(stopping=True, forced=True)
                while b"\n" in input_buffer:
                    line, _, remainder = input_buffer.partition(b"\n")
                    input_buffer = bytearray(remainder)
                    try:
                        child.stdin.write(line + b"\n")
                        child.stdin.flush()
                    except (BrokenPipeError, OSError):
                        state["stopping"] = True
                    if line.strip() == b"cancel":
                        state["stopping"] = True
            if time.monotonic() - started >= request["timeoutMs"] / 1000:
                state["stopping"] = True
            if state["stopping"] and deadline is None:
                deadline = time.monotonic() + request["graceMs"] / 1000
                try:
                    child.stdin.write(b"cancel\n")
                    child.stdin.flush()
                except (BrokenPipeError, OSError):
                    pass
            if state["forced"] or (deadline is not None and time.monotonic() >= deadline):
                break
            time.sleep(0.05)
        return exit_code
    finally:
        try:
            if child is not None:
                stop_descendants()
                write_cleanup_ack()
        finally:
            os.close(owner_descriptor)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Owned Linux command failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
