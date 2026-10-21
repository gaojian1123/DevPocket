import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tempfile
import uuid


def run(*arguments, **options):
    return subprocess.run(arguments, check=True, **options)


def seal(directory):
    for current, directories, files in os.walk(directory, followlinks=False):
        for name in directories + files:
            item = Path(current, name)
            if item.is_symlink():
                target = item.resolve(strict=True)
                if not target.is_relative_to(directory) or not target.is_file():
                    raise RuntimeError("Trusted worker inputs contain an external or directory symbolic link.")
                os.chown(item, 0, 0, follow_symlinks=False)
                continue
            os.chown(item, 0, 0)
            os.chmod(item, 0o555 if item.is_dir() or item.stat().st_mode & 0o111 else 0o444)
    os.chown(directory, 0, 0)
    os.chmod(directory, 0o555)


def candidate_directory(directory, uid, gid):
    for current, directories, files in os.walk(directory, followlinks=False):
        if Path(current) == directory:
            directories[:] = [name for name in directories if name != ".git"]
        for name in directories + files:
            os.chown(Path(current, name), uid, gid, follow_symlinks=False)
    os.chown(directory, 0, gid)
    os.chmod(directory, 0o1770)
    metadata = directory / ".git"
    metadata.mkdir(exist_ok=True)
    seal(metadata)


def protect_tool(executable):
    executable = Path(executable).resolve(strict=True)
    if executable.is_relative_to("/opt/hostedtoolcache"):
        parts = executable.relative_to("/opt/hostedtoolcache").parts
        if len(parts) < 4:
            raise RuntimeError("The hosted tool installation root is incomplete.")
        seal(Path("/opt/hostedtoolcache", *parts[:3]))
    for item in [executable, *executable.parents]:
        if item.stat().st_mode & 0o022:
            os.chown(item, 0, 0)
            os.chmod(item, item.stat().st_mode & 0o777 & ~0o022)


def main():
    if (sys.platform != "linux" or os.geteuid() != 0 or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"):
        raise RuntimeError("Worker bootstrap requires the authorized disposable hosted Linux VM.")
    os.umask(0o077)
    control, candidate = (Path(value).resolve(strict=True) for value in sys.argv[1:3])
    group, mode = sys.argv[3:5]
    if group not in ("tooling", "backend", "android", "device") or mode not in ("worker", "self-test"):
        raise ValueError("Unknown isolated worker mode.")
    reference = os.environ.get("GITHUB_WORKFLOW_REF", "")
    workflow = ".github/workflows/ci.yml" if mode == "self-test" else ".github/workflows/isolated-verification.yml"
    if f"/{workflow}@" not in reference:
        raise RuntimeError("This bootstrap was not selected by the approved workflow.")
    tools = {name: str(Path(shutil.which(name)).resolve(strict=True)) for name in ("node", "pwsh", "git", "python3")}
    head = run(tools["git"], "-C", str(control), "rev-parse", "HEAD", capture_output=True, text=True).stdout.strip()
    if head != os.environ.get("GITHUB_SHA"):
        raise RuntimeError("Control checkout does not match the selected workflow revision.")
    if mode == "worker":
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        if event.get("inputs", {}).get("trusted_sha") != head:
            raise RuntimeError("Control revision does not match the independently approved revision.")
    runner = pwd.getpwuid(int(os.environ["SUDO_UID"]))
    if runner.pw_uid == 0:
        raise RuntimeError("A distinct hosted runner identity is required.")
    state = Path(tempfile.mkdtemp(prefix="devpocket-isolation-", dir="/opt"))
    os.chmod(state, 0o755)
    private = state / "private"
    private.mkdir(mode=0o700)
    name = "dpw" + uuid.uuid4().hex[:12]
    account = None
    exit_code = 78
    try:
        run("/usr/sbin/useradd", "--no-create-home", "--home-dir", str(state / "home"),
            "--shell", "/usr/sbin/nologin", "--user-group", name)
        account = pwd.getpwnam(name)
        if account.pw_uid < 1000 or account.pw_gid < 1000 or os.getgrouplist(name, account.pw_gid) != [account.pw_gid]:
            raise RuntimeError("The candidate identity has unexpected supplementary groups.")
        home = state / "home"
        home.mkdir(mode=0o700)
        os.chown(home, account.pw_uid, account.pw_gid)
        temporary = home / "tmp"
        temporary.mkdir(mode=0o700)
        os.chown(temporary, account.pw_uid, account.pw_gid)
        control_copy, candidate_copy = state / "control", state / "candidate"
        shutil.copytree(control, control_copy, symlinks=True, ignore=shutil.ignore_patterns(".data", ".tools", "node_modules"))
        shutil.copytree(candidate, candidate_copy, symlinks=True, ignore=shutil.ignore_patterns(".data", ".tools", "node_modules"))
        seal(control_copy)
        evidence = control_copy / ".data" / "ci" / "isolated"
        evidence.mkdir(parents=True, mode=0o700)
        bytecode = control_copy / "scripts" / "__pycache__"
        bytecode.mkdir(mode=0o700)
        for protected in (control_copy / ".data", control_copy / ".data" / "ci", evidence, bytecode):
            info = protected.stat()
            if protected.is_symlink() or info.st_uid != 0 or info.st_mode & 0o077:
                raise RuntimeError("A private control directory permits candidate access.")
        candidate_directory(candidate_copy, account.pw_uid, account.pw_gid)
        fixture = state / "fixture"
        fixture.mkdir()
        candidate_directory(fixture, account.pw_uid, account.pw_gid)
        # Runner command files, artifact credentials and action implementations stay outside the candidate identity.
        os.chmod(runner.pw_dir, 0o700)
        ptrace = Path("/proc/sys/kernel/yama/ptrace_scope")
        ptrace.write_text("2\n")
        if ptrace.read_text().strip() != "2":
            raise RuntimeError("Candidate processes can still attach to trusted test runners.")
        environment = dict(os.environ)
        for executable in tools.values():
            protect_tool(executable)
        if environment.get("JAVA_HOME"):
            jdk = Path(environment["JAVA_HOME"]).resolve(strict=True)
            runner_temp = Path(environment["RUNNER_TEMP"]).resolve(strict=True)
            if jdk.is_relative_to(runner_temp):
                destination = state / "jdk"
                shutil.copytree(jdk, destination, symlinks=True)
                seal(destination)
                environment["JAVA_HOME"] = str(destination)
        sdk = Path(environment["ANDROID_HOME"]).resolve(strict=True) if group == "device" else None
        if sdk:
            if not Path("/dev/kvm").is_char_device():
                raise RuntimeError("The isolated device worker requires KVM.")
            for current, directories, files in os.walk(sdk, followlinks=False):
                for item in [Path(current), *(Path(current, name) for name in files)]:
                    if not item.is_symlink():
                        os.chown(item, 0, 0)
                        os.chmod(item, item.stat().st_mode & 0o777 & ~0o022)
            rule = Path("/etc/udev/rules.d", f"99-devpocket-kvm-{environment['GITHUB_RUN_ID']}-{environment['GITHUB_RUN_ATTEMPT']}.rules")
            original = f'ACTION=="add|change", SUBSYSTEM=="misc", KERNEL=="kvm", OWNER:="{runner.pw_uid}", MODE:="0600"\n'
            if rule.read_text() != original:
                raise RuntimeError("KVM preparation differs from the approved setup.")
            rule.write_text(original.replace(str(runner.pw_uid), str(account.pw_uid)))
            run("/usr/bin/udevadm", "control", "--reload-rules")
            os.chown("/dev/kvm", account.pw_uid, account.pw_gid)
            os.chmod("/dev/kvm", 0o600)
        configuration = {
            "version": 1, "platform": "linux", "control": str(control_copy), "candidate": str(candidate_copy),
            "fixture": str(fixture), "private": str(private), "home": str(home), "temporary": str(temporary),
            "uid": account.pw_uid, "gid": account.pw_gid, "tools": tools, "group": group, "mode": mode,
            "protectedPaths": [str(control_copy), str(private), str(state), str(control_copy / ".data"),
                               str(evidence), str(bytecode), runner.pw_dir, environment["RUNNER_TEMP"]],
        }
        file = private / "configuration.json"
        descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(configuration, output)
        environment.pop("NODE_OPTIONS", None)
        environment.pop("NODE_PATH", None)
        environment.pop("PYTHONPATH", None)
        environment.pop("PYTHONHOME", None)
        owner_home, owner_temp = private / "home", private / "tmp"
        owner_home.mkdir(mode=0o700)
        owner_temp.mkdir(mode=0o700)
        environment.update(HOME=str(owner_home), TMP=str(owner_temp), TEMP=str(owner_temp), TMPDIR=str(owner_temp))
        result = subprocess.run([tools["node"], "--disable-sigusr1", str(control_copy / "scripts" / "isolated-worker.mjs"),
                                 "--configuration", str(file)], cwd=control_copy, env=environment)
        exit_code = result.returncode
    finally:
        if account:
            remaining = []
            for entry in Path("/proc").iterdir():
                if entry.name.isdigit():
                    try:
                        if entry.stat().st_uid == account.pw_uid:
                            remaining.append(entry.name)
                    except FileNotFoundError:
                        pass
            if remaining:
                raise RuntimeError("Candidate processes remain; isolated worker cleanup is unconfirmed.")
            run("/usr/sbin/userdel", name)
        report_directory = state / "control" / ".data" / "ci" / "isolated"
        if report_directory.is_dir() and not report_directory.is_symlink():
            destination = control / ".data" / "ci" / "isolated"
            for directory in (control / ".data", control / ".data" / "ci", destination):
                directory.mkdir(mode=0o700, exist_ok=True)
                if directory.is_symlink():
                    raise RuntimeError("The owned publication directory changed.")
                os.chown(directory, runner.pw_uid, runner.pw_gid)
                os.chmod(directory, 0o700)
            for name in ("report.json", "isolation-proof.json", "isolation-negative-report.json", "bootstrap-failure.json"):
                source = report_directory / name
                if source.is_file() and not source.is_symlink() and source.stat().st_size <= 1024 * 1024:
                    with (destination / name).open("xb") as output:
                        output.write(source.read_bytes())
                    os.chown(destination / name, runner.pw_uid, runner.pw_gid)
            if exit_code == 0 and group in ("android", "device") and mode == "worker":
                artifacts = destination / "artifacts"
                artifacts.mkdir(mode=0o700)
                os.chown(artifacts, runner.pw_uid, runner.pw_gid)
                for name in ("app-debug.apk", "app-debug-androidTest.apk"):
                    source = report_directory / "artifacts" / name
                    if not source.is_file() or source.is_symlink() or source.stat().st_size > 256 * 1024 * 1024:
                        raise RuntimeError("An isolated build artifact is unavailable.")
                    with (artifacts / name).open("xb") as output, source.open("rb") as input_file:
                        shutil.copyfileobj(input_file, output)
                    os.chown(artifacts / name, runner.pw_uid, runner.pw_gid)
        for name in ("configuration.json",):
            file = private / name
            if file.exists():
                file.unlink()
    return exit_code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.CalledProcessError) as error:
        print(json.dumps({"status": "blocked", "phase": "isolated-bootstrap", "error": type(error).__name__}),
              file=sys.stderr)
        sys.exit(78)
