using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
using TimeoutException = System.TimeoutException;

public sealed class DevPocketWindowsSupervisor : ServiceBase {
    const int JsonLimit = 65536;
    const int OutputLimit = 16 * 1024 * 1024;
    readonly Dictionary<string, object> configuration;
    readonly TaskCompletionSource<string> shutdown = new TaskCompletionSource<string>();
    Thread worker;
    NamedPipeServerStream listener;
    Exception workerFailure;
    string stage = "identity";
    bool? assignEnabled;
    [StructLayout(LayoutKind.Sequential)]
    struct PipeAttributes { public int length; public IntPtr descriptor; public int inherit; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint instances,
        uint outputSize, uint inputSize, uint timeout, ref PipeAttributes attributes);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CancelIoEx(SafePipeHandle pipe, IntPtr overlapped);
    [StructLayout(LayoutKind.Sequential)]
    struct FileAttributeTag { public uint attributes, tag; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, out FileAttributeTag information, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder name, uint size, uint flags);
    [StructLayout(LayoutKind.Sequential)]
    struct ServiceStatusProcess {
        public uint type, state, controls, win32Exit, serviceExit, checkpoint, waitHint, pid, flags;
    }
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool QueryServiceStatusEx(SafeHandle service, int kind, out ServiceStatusProcess status, int length, out int needed);

    static NamedPipeServerStream PrivatePipe(string name, PipeSecurity security) {
        byte[] descriptor = security.GetSecurityDescriptorBinaryForm();
        var pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
        try {
            var attributes = new PipeAttributes { length = Marshal.SizeOf(typeof(PipeAttributes)), descriptor = pinned.AddrOfPinnedObject() };
            IntPtr handle = CreateNamedPipeW(@"\\.\pipe\" + name, 0x40080003, 8, 1, 4096, 4096, 30000, ref attributes);
            if (handle == new IntPtr(-1)) throw new Win32Exception();
            var owned = new SafePipeHandle(handle, true);
            try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, owned); }
            catch { owned.Dispose(); throw; }
        } finally { pinned.Free(); }
    }

    public DevPocketWindowsSupervisor(Dictionary<string, object> configuration) {
        this.configuration = configuration;
        ServiceName = Text(configuration, "service");
        AutoLog = false;
        CanStop = true;
    }

    static JavaScriptSerializer Serializer() {
        return new JavaScriptSerializer { MaxJsonLength = JsonLimit, RecursionLimit = 16 };
    }

    public static string Digest(byte[] bytes) {
        using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    }

    static string Text(Dictionary<string, object> value, string key) {
        object result;
        if (!value.TryGetValue(key, out result) || !(result is string) || ((string)result).Length == 0 ||
            ((string)result).IndexOf('\0') >= 0) throw new InvalidDataException("Missing or invalid supervisor field: " + key);
        return (string)result;
    }

    static int Number(Dictionary<string, object> value, string key) {
        object result;
        if (!value.TryGetValue(key, out result) || !(result is int)) throw new InvalidDataException("Invalid integer: " + key);
        return (int)result;
    }

    static void Keys(Dictionary<string, object> value, params string[] expected) {
        if (value == null || value.Count != expected.Length) throw new InvalidDataException("Unexpected supervisor record shape.");
        foreach (string key in expected) if (!value.ContainsKey(key)) throw new InvalidDataException("Incomplete supervisor record.");
    }

    static byte[] ReadFile(string file, int maximum) {
        if (!Path.IsPathRooted(file) || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Supervisor input must be a regular absolute file.");
        using (var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            if (input.Length < 1 || input.Length > maximum) throw new InvalidDataException("Supervisor input exceeds its bound.");
            var bytes = new byte[input.Length];
            int offset = 0;
            while (offset < bytes.Length) {
                int count = input.Read(bytes, offset, bytes.Length - offset);
                if (count == 0) throw new EndOfStreamException();
                offset += count;
            }
            return bytes;
        }
    }

    public static Dictionary<string, object> ReadConfiguration(string file, string digest) {
        byte[] bytes = ReadFile(file, JsonLimit);
        if (Digest(bytes) != digest) throw new InvalidDataException("Supervisor configuration changed.");
        var value = Serializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes));
        Keys(value, "version", "service", "serviceSid", "runnerSid", "ownerPid", "ownerPipe", "commandPipe", "nonce",
            "privateRoot", "identity", "executableSha256", "probeNode", "probeNodeSha256", "probeCwd",
            "mode", "workingRoots", "executableRoots");
        if (Number(value, "version") != 1 || !System.Text.RegularExpressions.Regex.IsMatch(Text(value, "service"), @"^dpws_[a-f0-9]{24}$") ||
            !System.Text.RegularExpressions.Regex.IsMatch(Text(value, "nonce"), @"^[a-f0-9]{64}$"))
            throw new InvalidDataException("Invalid supervisor identity.");
        foreach (string key in new[] { "runnerSid", "serviceSid" }) new SecurityIdentifier(Text(value, key));
        if (Number(value, "ownerPid") < 1) throw new InvalidDataException("Invalid supervisor owner.");
        foreach (string key in new[] { "ownerPipe", "commandPipe" })
            if (!System.Text.RegularExpressions.Regex.IsMatch(Text(value, key), @"^devpocket-[a-f0-9]{32}-(?:owner|command)$"))
                throw new InvalidDataException("Invalid supervisor pipe.");
        foreach (string key in new[] { "privateRoot", "identity", "probeNode", "probeCwd" }) {
            string selected = Text(value, key);
            if (!Path.IsPathRooted(selected) || !string.Equals(Path.GetFullPath(selected), selected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Supervisor paths must be absolute and normalized.");
        }
        foreach (string key in new[] { "executableSha256", "probeNodeSha256" })
            if (!System.Text.RegularExpressions.Regex.IsMatch(Text(value, key), @"^[a-f0-9]{64}$"))
                throw new InvalidDataException("Invalid supervisor executable binding.");
        if (Text(value, "mode") != "probe" && Text(value, "mode") != "worker")
            throw new InvalidDataException("Invalid supervisor command mode.");
        foreach (string key in new[] { "workingRoots", "executableRoots" }) {
            var roots = value[key] as System.Collections.IList;
            if (roots == null || roots.Count < 1 || roots.Count > 16) throw new InvalidDataException("Invalid supervisor path scope.");
            foreach (object item in roots) {
                string selected = item as string;
                if (string.IsNullOrEmpty(selected) || !Path.IsPathRooted(selected) ||
                    !string.Equals(Path.GetFullPath(selected), selected, StringComparison.OrdinalIgnoreCase) ||
                    selected.TrimEnd(Path.DirectorySeparatorChar) == Path.GetPathRoot(selected).TrimEnd(Path.DirectorySeparatorChar))
                    throw new InvalidDataException("Supervisor path scopes must be bounded absolute directories.");
            }
        }
        string root = Path.GetFullPath(Text(value, "privateRoot"));
        if (Path.GetFullPath(file) != Path.Combine(root, "supervisor.json") ||
            Text(value, "identity") != Path.Combine(root, "identity.json") ||
            (File.GetAttributes(root) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
            throw new InvalidDataException("Supervisor allocation changed.");
        if (Digest(ReadFile(Process.GetCurrentProcess().MainModule.FileName, 1024 * 1024)) != Text(value, "executableSha256"))
            throw new InvalidDataException("Supervisor executable changed.");
        return value;
    }

    static string ReadLine(StreamReader input, int maximum) {
        var line = new StringBuilder();
        while (line.Length <= maximum) {
            int item = input.Read();
            if (item < 0) return line.Length == 0 ? null : line.ToString();
            if (item == '\n') return line.ToString().TrimEnd('\r');
            line.Append((char)item);
        }
        throw new InvalidDataException("Supervisor message exceeds its bound.");
    }

    static void WriteLine(Stream pipe, string message) {
        byte[] bytes = Encoding.UTF8.GetBytes(message + "\n");
        pipe.Write(bytes, 0, bytes.Length);
        pipe.Flush();
    }

    static void WriteNew(string file, byte[] bytes) {
        using (var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
            output.Write(bytes, 0, bytes.Length);
            output.Flush(true);
        }
    }

    static void WriteJson(string file, object value) {
        string temporary = file + ".pending-" + Guid.NewGuid().ToString("N");
        try {
            WriteNew(temporary, Encoding.UTF8.GetBytes(Serializer().Serialize(value) + "\n"));
            File.Move(temporary, file);
        } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    protected override void OnStart(string[] args) {
        worker = new Thread(Serve) { IsBackground = true };
        worker.Start();
    }

    protected override void OnStop() {
        shutdown.TrySetResult("cancel");
        if (listener != null) listener.Dispose();
        if (worker != null && worker != Thread.CurrentThread && !worker.Join(35000))
            throw new TimeoutException("Supervisor cleanup did not finish.");
        if (workerFailure != null) ExitCode = 78;
    }

    void Serve() {
        try {
            using (var identity = WindowsIdentity.GetCurrent()) {
                if (identity.User.Value != "S-1-5-19" ||
                    !identity.Groups.Contains(new SecurityIdentifier(Text(configuration, "serviceSid"))))
                    throw new InvalidOperationException("The service token is not the configured LocalService identity.");
            }
            stage = "privileges";
            assignEnabled = DevPocketIsolatedCommand.PrepareCreationPrivileges();
            if (assignEnabled != true)
                throw new InvalidOperationException("The service lacks the required primary-token privilege.");
            string[] privileges = DevPocketIsolatedCommand.RequireSupervisorPrivileges();
            stage = "owner";
            using (var owner = new NamedPipeClientStream(".", Text(configuration, "ownerPipe"), PipeDirection.InOut, PipeOptions.Asynchronous)) {
                owner.Connect(30000);
                uint ownerPid;
                if (!GetNamedPipeServerProcessId(owner.SafePipeHandle, out ownerPid) || ownerPid != Number(configuration, "ownerPid"))
                    throw new InvalidDataException("The supervisor owner process changed.");
                using (var input = new StreamReader(owner, new UTF8Encoding(false), false, 4096, true)) {
                    var hello = Task.Run(() => ReadLine(input, 128));
                    if (!hello.Wait(30000) || hello.Result != Text(configuration, "nonce"))
                        throw new InvalidDataException("The supervisor owner handshake failed.");
                    var ownerControl = Task.Run(() => ReadLine(input, 64));
                    ownerControl.ContinueWith(task => shutdown.TrySetResult("cancel"), TaskScheduler.Default);
                    WriteJson(Path.Combine(Text(configuration, "privateRoot"), "service-capabilities.json"), new {
                        version = 1, kind = "windows-supervisor-capability", acceptance = false,
                        identity = "LocalService", serviceSid = Text(configuration, "serviceSid"),
                        assignPrimaryTokenEnabled = true, increaseQuotaEnabled = true, privileges = privileges,
                        servicePid = Process.GetCurrentProcess().Id, desktopScope = DevPocketIsolatedCommand.DescribeDesktopScope()
                    });
                    var security = new PipeSecurity();
                    security.SetAccessRuleProtection(true, false);
                    foreach (string sid in new[] { Text(configuration, "runnerSid"), Text(configuration, "serviceSid"), "S-1-5-18" })
                        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid), PipeAccessRights.FullControl, AccessControlType.Allow));
                    using (listener = PrivatePipe(Text(configuration, "commandPipe"), security)) {
                        while (!shutdown.Task.IsCompleted) {
                            stage = "command";
                            var connected = listener.WaitForConnectionAsync();
                            if (Task.WhenAny(connected, shutdown.Task).GetAwaiter().GetResult() != connected) break;
                            connected.GetAwaiter().GetResult();
                            using (var requestInput = new StreamReader(listener, new UTF8Encoding(false), false, 4096, true)) {
                                bool admitted = false;
                                Task<string> pendingRead = null;
                                try { HandleCommand(listener, requestInput, ref admitted, out pendingRead); }
                                catch (Exception error) {
                                    if (admitted || !(error is InvalidDataException || error is IOException)) throw;
                                    if (!ClosedPipe(error)) {
                                        try { WriteLine(listener, "rejected"); }
                                        catch (IOException closed) { if (!ClosedPipe(closed)) throw; }
                                    }
                                } finally {
                                    if (!shutdown.Task.IsCompleted) {
                                        if (listener.IsConnected) listener.Disconnect();
                                        if (!CancelIoEx(listener.SafePipeHandle, IntPtr.Zero) && Marshal.GetLastWin32Error() != 1168)
                                            throw new Win32Exception();
                                    }
                                    if (pendingRead != null) {
                                        if (Task.WhenAny(pendingRead, Task.Delay(5000)).GetAwaiter().GetResult() != pendingRead)
                                            throw new TimeoutException("The previous pipe reader did not stop.");
                                        try { pendingRead.GetAwaiter().GetResult(); }
                                        catch (Exception error) {
                                            if (!ClosedPipe(error) && !(shutdown.Task.IsCompleted && error is ObjectDisposedException)) throw;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (Exception error) {
            if (!shutdown.Task.IsCompleted || !(error is IOException || error is ObjectDisposedException || error is OperationCanceledException)) {
                workerFailure = error;
                ExitCode = 78;
                WriteJson(Path.Combine(Text(configuration, "privateRoot"), "service-failure.json"), new {
                    version = 1, kind = "windows-supervisor-diagnostic", acceptance = false, status = "blocked",
                    phase = stage, assignPrimaryTokenEnabled = assignEnabled,
                    error = error.GetType().Name, nativeError = error is Win32Exception ? ((Win32Exception)error).NativeErrorCode : (int?)null
                });
            }
        } finally {
            shutdown.TrySetResult("cancel");
            ThreadPool.QueueUserWorkItem(_ => Stop());
        }
    }

    static bool ClosedPipe(Exception error) {
        int code = error.HResult & 0xffff;
        return error is IOException && (code == 109 || code == 232 || code == 233 || code == 995);
    }

    static void ClaimRequest(string requestFile, object admission) {
        if (File.Exists(requestFile + ".result.json")) throw new IOException("The request already has a terminal result.");
        WriteJson(requestFile + ".admitted", admission);
    }

    public static void RecordUnadmittedCancellation(string requestFile, string id, string requestSha256) {
        Guid parsed;
        if (!Guid.TryParseExact(id, "D", out parsed) || Path.GetFileName(requestFile) != id + ".json" ||
            !System.Text.RegularExpressions.Regex.IsMatch(requestSha256, "^[a-f0-9]{64}$"))
            throw new InvalidDataException("Invalid cancellation identity.");
        ClaimRequest(requestFile, new { id = id, requestSha256 = requestSha256, state = "cancelled-before-header" });
        WriteJson(requestFile + ".result.json", new {
            version = 1, id = id, requestSha256 = requestSha256, status = "blocked", admission = "not-admitted",
            interruption = "cancelled", started = false, processTreeStopped = true, exitCode = (int?)null
        });
    }

    sealed class CapturedOutput {
        readonly object gate = new object();
        int total;
        public readonly TaskCompletionSource<string> Stop = new TaskCompletionSource<string>();
        public bool Truncated { get; private set; }

        public byte[] Read(Stream input) {
            using (var output = new MemoryStream()) {
                var buffer = new byte[8192];
                int count;
                while ((count = input.Read(buffer, 0, buffer.Length)) != 0) {
                    lock (gate) {
                        int retained = Math.Min(count, OutputLimit - total);
                        output.Write(buffer, 0, retained);
                        total += retained;
                        if (retained != count) { Truncated = true; Stop.TrySetResult("cancel"); }
                    }
                }
                return output.ToArray();
            }
        }
    }

    void HandleCommand(NamedPipeServerStream pipe, StreamReader input, ref bool admitted, out Task<string> pendingRead) {
        pendingRead = null;
        LaunchPaths launch = null;
        try {
            var headerRead = Task.Run(() => ReadLine(input, 4096));
            pendingRead = headerRead;
            if (Task.WhenAny(headerRead, shutdown.Task, Task.Delay(30000)).GetAwaiter().GetResult() != headerRead)
                throw new OperationCanceledException("The supervisor owner did not retain a bounded request.");
            string line = headerRead.GetAwaiter().GetResult();
            if (line == null) return;
            var header = Serializer().Deserialize<Dictionary<string, object>>(line ?? "");
            Keys(header, "id", "sha256", "nonce");
            string id = Text(header, "id");
            Guid parsed;
            if (!Guid.TryParseExact(id, "D", out parsed) || Text(header, "nonce") != Text(configuration, "nonce"))
                throw new InvalidDataException("Unbound supervisor request.");
            string requestFile = Path.Combine(Text(configuration, "privateRoot"), id + ".json");
            byte[] bytes = ReadFile(requestFile, JsonLimit);
            if (Digest(bytes) != Text(header, "sha256")) throw new InvalidDataException("Supervisor request changed.");
            var request = Serializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes));
            ValidateCommandRequest(configuration, request);
            launch = new LaunchPaths(configuration, request);
            if (Text(request, "id") != id) throw new InvalidDataException("The private request identity changed.");
            uint clientPid;
            if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientPid) || clientPid == 0)
                throw new Win32Exception();
            ClaimRequest(requestFile, new { requestSha256 = Digest(bytes), clientPid = clientPid });
            admitted = true;
            var clientControl = Task.Run(() => ReadLine(input, 64));
            pendingRead = clientControl;
            clientControl.ContinueWith(task => { var observed = task.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
            var capture = new CapturedOutput();
            var cancellation = Task.WhenAny(clientControl, shutdown.Task, capture.Stop.Task).Unwrap();
            var identity = Serializer().Deserialize<Dictionary<string, object>>(
                Encoding.UTF8.GetString(ReadFile(Text(configuration, "identity"), JsonLimit)));
            Keys(identity, "user", "password", "sid");
            var environment = new List<string>();
            foreach (var entry in (Dictionary<string, object>)request["environment"])
                environment.Add(entry.Key + "=" + (string)entry.Value);
            var arguments = new List<string>();
            foreach (object value in (System.Collections.IEnumerable)request["arguments"]) arguments.Add((string)value);
            var receipt = new Dictionary<string, object> {
                { "version", 1 }, { "id", id }, { "status", "blocked" }, { "requestSha256", Digest(bytes) }
            };
            using (var stdout = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None))
            using (var stderr = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None))
            using (var command = new DevPocketIsolatedCommand(cancellation)) {
                var outputRead = Task.Run(() => capture.Read(stdout));
                var errorRead = Task.Run(() => capture.Read(stderr));
                bool drained = false;
                try {
                    command.Run(Text(identity, "user"), Text(identity, "password"), Text(identity, "sid"),
                        Text(request, "file"), arguments.ToArray(), environment.ToArray(), Text(request, "cwd"),
                        Number(request, "timeoutMs"), stdout.ClientSafePipeHandle.DangerousGetHandle(), stderr.ClientSafePipeHandle.DangerousGetHandle());
                } catch (Exception error) {
                    if (!(error is Win32Exception) && !(error is OperationCanceledException) && !(error is TimeoutException) &&
                        !(error is InvalidOperationException) && !(error is InvalidDataException)) throw;
                } finally {
                    stdout.DisposeLocalCopyOfClientHandle();
                    stderr.DisposeLocalCopyOfClientHandle();
                    try {
                        if (!Task.WaitAll(new Task[] { outputRead, errorRead }, 10000))
                            throw new TimeoutException("The candidate output pipes did not close.");
                        WriteNew(requestFile + ".stdout", outputRead.Result);
                        WriteNew(requestFile + ".stderr", errorRead.Result);
                        drained = true;
                    } finally {
                        receipt["started"] = command.Started;
                        receipt["status"] = command.ExitCode.HasValue && !capture.Truncated ? "executed" : "blocked";
                        receipt["admission"] = command.Admission;
                        receipt["interruption"] = command.Interruption;
                        receipt["processTreeStopped"] = command.ProcessTreeStopped && drained;
                        receipt["exitCode"] = capture.Truncated ? null : command.ExitCode;
                        receipt["outputTruncated"] = capture.Truncated;
                        receipt["native"] = new {
                            stage = command.FailureStage, errorCode = command.NativeErrorCode,
                            assignPrimaryTokenEnabled = command.AssignPrimaryTokenEnabled, increaseQuotaEnabled = command.IncreaseQuotaEnabled
                        };
                        WriteJson(requestFile + ".result.json", receipt);
                    }
                }
                if (!command.ProcessTreeStopped) throw new InvalidOperationException("The candidate Job cleanup was not confirmed.");
            }
            WriteLine(pipe, "complete");
            for (int index = 0; index < 2; index++) {
                if (Task.WhenAny(pendingRead, Task.Delay(5000)).GetAwaiter().GetResult() != pendingRead) break;
                string control;
                try { control = pendingRead.GetAwaiter().GetResult(); }
                catch (IOException closed) { if (ClosedPipe(closed)) break; throw; }
                if (control == null) break;
                if (control.Trim() != "cancel") throw new InvalidDataException("Unsupported final client control message.");
                pendingRead = Task.Run(() => ReadLine(input, 64));
            }
        } finally { if (launch != null) launch.Dispose(); }
    }

    public static void ValidateProbeRequest(Dictionary<string, object> configuration, Dictionary<string, object> request) {
        ValidateRequestShape(configuration, request);
        if (Number(request, "timeoutMs") > 30000 ||
            Text(request, "file") != Text(configuration, "probeNode") || Text(request, "cwd") != Text(configuration, "probeCwd"))
            throw new InvalidDataException("Only the fixed supervisor capability probe is enabled.");
        if (Digest(ReadFile(Text(request, "file"), 128 * 1024 * 1024)) != Text(configuration, "probeNodeSha256"))
            throw new InvalidDataException("The trusted probe executable changed.");
        string[] expected = { "--disable-sigusr1", "-e", "process.stdout.write('DEVPOCKET_ISOLATED_LAUNCH')" };
        var arguments = (System.Collections.IList)request["arguments"];
        if (arguments.Count != expected.Length) throw new InvalidDataException("Invalid probe arguments.");
        for (int index = 0; index < expected.Length; index++)
            if ((string)arguments[index] != expected[index])
                throw new InvalidDataException("Candidate code cannot run through the capability probe.");
    }

    static void ValidateRequestShape(Dictionary<string, object> configuration, Dictionary<string, object> request) {
        Keys(request, "version", "id", "file", "arguments", "cwd", "timeoutMs", "environment", "identity");
        Guid id;
        if (!Guid.TryParseExact(Text(request, "id"), "D", out id)) throw new InvalidDataException("Invalid probe identity.");
        if (Number(request, "version") != 1 || Number(request, "timeoutMs") < 1 ||
            Text(request, "identity") != Text(configuration, "identity"))
            throw new InvalidDataException("Invalid isolated command scope.");
        foreach (string key in new[] { "file", "cwd" }) {
            string selected = Text(request, key);
            if (!Path.IsPathRooted(selected) || !string.Equals(Path.GetFullPath(selected), selected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Isolated commands require absolute normalized paths.");
        }
        var arguments = request["arguments"] as System.Collections.IList;
        if (arguments == null || arguments.Count > 4096) throw new InvalidDataException("Invalid command arguments.");
        foreach (object argument in arguments)
            if (!(argument is string) || ((string)argument).IndexOf('\0') >= 0) throw new InvalidDataException("Invalid command argument.");
        var environment = request["environment"] as Dictionary<string, object>;
        if (environment == null || environment.Count > 64) throw new InvalidDataException("Invalid probe environment.");
        var allowed = new HashSet<string>(new[] {
            "PATH", "HOME", "CI", "TMP", "TEMP", "TMPDIR", "GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_TEMP",
            "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1",
            "GIT_CONFIG_KEY_2", "GIT_CONFIG_VALUE_2", "npm_config_cache", "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT",
            "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA",
            "LOCALAPPDATA", "NoDefaultCurrentDirectoryInExePath", "DEVPOCKET_BACKEND_DIAGNOSTIC_ID",
            "DEVPOCKET_TEST_DIAGNOSTIC_SCOPE", "DEVPOCKET_PROBE_PYTHON"
        }, StringComparer.OrdinalIgnoreCase);
        foreach (var item in environment) {
            if (!allowed.Contains(item.Key) || !(item.Value is string) || ((string)item.Value).IndexOf('\0') >= 0)
                throw new InvalidDataException("A privileged startup setting or credential entered the probe.");
        }
    }

    static bool Within(string selected, object roots) {
        var directories = roots as System.Collections.IList;
        if (directories == null) throw new InvalidDataException("Missing command directory scope.");
        foreach (object value in directories) {
            string root = value as string;
            if (root == null) throw new InvalidDataException("Invalid command directory scope.");
            if (selected.Equals(root, StringComparison.OrdinalIgnoreCase) ||
                selected.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    sealed class LaunchPaths : IDisposable {
        readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();

        void Hold(string selected, bool directory) {
            var handle = CreateFileW(selected, directory ? 0x81u : 0x80000000u, 1, IntPtr.Zero, 3,
                directory ? 0x02200000u : 0x00200000u, IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error);
            }
            handles.Add(handle);
            FileAttributeTag information;
            if (!GetFileInformationByHandleEx(handle, 9, out information, (uint)Marshal.SizeOf(typeof(FileAttributeTag))))
                throw new Win32Exception();
            if ((information.attributes & (uint)FileAttributes.ReparsePoint) != 0 ||
                ((information.attributes & (uint)FileAttributes.Directory) != 0) != directory)
                throw new InvalidDataException("A launch path is redirected or has the wrong type.");
            var name = new StringBuilder(32768);
            uint count = GetFinalPathNameByHandleW(handle, name, (uint)name.Capacity, 0);
            if (count == 0 || count >= name.Capacity) throw new Win32Exception();
            string resolved = name.ToString();
            if (resolved.StartsWith(@"\\?\", StringComparison.Ordinal)) resolved = resolved.Substring(4);
            if (!string.Equals(resolved.TrimEnd(Path.DirectorySeparatorChar),
                    selected.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("A launch path resolves outside its declared identity.");
        }

        public static IDisposable BindLaunchPaths(Dictionary<string, object> configuration, Dictionary<string, object> request) {
            return new LaunchPaths(configuration, request);
        }

        void Bind(string selected, object roots, bool directory) {
            string root = null;
            foreach (string candidate in (System.Collections.IList)roots)
                if (Within(selected, new[] { candidate }) && (root == null || candidate.Length > root.Length)) root = candidate;
            if (root == null) throw new InvalidDataException("A launch path has no declared root.");
            root = root.TrimEnd(Path.DirectorySeparatorChar);
            if (string.Equals(selected.TrimEnd(Path.DirectorySeparatorChar), root, StringComparison.OrdinalIgnoreCase)) {
                Hold(root, directory);
                return;
            }
            Hold(root, true);
            string current = root;
            string[] parts = selected.Substring(root.Length).TrimStart(Path.DirectorySeparatorChar)
                .Split(new[] { Path.DirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
            for (int index = 0; index < parts.Length; index++) {
                current = Path.Combine(current, parts[index]);
                Hold(current, index < parts.Length - 1 || directory);
            }
        }

        public LaunchPaths(Dictionary<string, object> configuration, Dictionary<string, object> request) {
            try {
                Bind(Text(request, "cwd"), configuration["workingRoots"], true);
                Bind(Text(request, "file"), configuration["executableRoots"], false);
            } catch { Dispose(); throw; }
        }

        public void Dispose() {
            for (int index = handles.Count - 1; index >= 0; index--) handles[index].Dispose();
            handles.Clear();
        }
    }

    public static void ValidateCommandRequest(Dictionary<string, object> configuration, Dictionary<string, object> request) {
        if (Text(configuration, "mode") == "probe") { ValidateProbeRequest(configuration, request); return; }
        if (Text(configuration, "mode") != "worker") throw new InvalidDataException("Invalid command mode.");
        ValidateRequestShape(configuration, request);
        if (!Within(Text(request, "cwd"), configuration["workingRoots"]) ||
            !Within(Text(request, "file"), configuration["executableRoots"]) ||
            (File.GetAttributes(Text(request, "file")) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            throw new InvalidDataException("The command is outside the task allocation or fixed tools.");
        using (BindLaunchPaths(configuration, request)) {}
    }

    static int Client(Dictionary<string, object> configuration, string requestFile) {
        byte[] bytes = ReadFile(requestFile, JsonLimit);
        var request = Serializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes));
        ValidateCommandRequest(configuration, request);
        string id = Text(request, "id");
        Guid parsed;
        if (!Guid.TryParseExact(id, "D", out parsed)) throw new InvalidDataException("Invalid command identity.");
        if (Path.GetFullPath(requestFile) != Path.Combine(Text(configuration, "privateRoot"), id + ".json"))
            throw new InvalidDataException("The command request is outside the private allocation.");
        using (var pipe = new NamedPipeClientStream(".", Text(configuration, "commandPipe"), PipeDirection.InOut, PipeOptions.Asynchronous)) {
            var control = Task.Run(() => Console.In.ReadLine());
            pipe.Connect(30000);
            using (var service = new ServiceController(Text(configuration, "service")))
            using (var handle = service.ServiceHandle) {
                uint serverPid;
                ServiceStatusProcess status;
                int needed;
                if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out serverPid)) throw new Win32Exception();
                if (!QueryServiceStatusEx(handle, 0, out status, Marshal.SizeOf(typeof(ServiceStatusProcess)), out needed))
                    throw new Win32Exception();
                if (status.state != 4 || status.pid != serverPid)
                    throw new InvalidDataException("The command pipe is not the running task service.");
            }
            using (var output = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true })
            using (var input = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true)) {
                if (control.IsCompleted) {
                    string message = control.GetAwaiter().GetResult();
                    if (message != null && message.Trim() != "cancel") throw new InvalidDataException("Unsupported client control message.");
                    RecordUnadmittedCancellation(requestFile, id, Digest(bytes));
                    return 78;
                }
                output.WriteLine(Serializer().Serialize(new { id = id, sha256 = Digest(bytes), nonce = Text(configuration, "nonce") }));
                var completion = Task.Run(() => ReadLine(input, 64));
                if (Task.WhenAny(completion, control).GetAwaiter().GetResult() != completion) {
                    string message = control.GetAwaiter().GetResult();
                    if (message != null && message.Trim() != "cancel") throw new InvalidDataException("Unsupported client control message.");
                    output.WriteLine("cancel");
                }
                if (!completion.Wait(40000) || completion.Result != "complete")
                    throw new IOException("The supervisor did not confirm completion.");
            }
        }
        var receipt = Serializer().Deserialize<Dictionary<string, object>>(
            Encoding.UTF8.GetString(ReadFile(requestFile + ".result.json", JsonLimit)));
        if (Text(receipt, "id") != id || Text(receipt, "requestSha256") != Digest(bytes))
            throw new InvalidDataException("The supervisor receipt does not match the request.");
        foreach (var pair in new[] { new { Suffix = ".stdout", Stream = Console.OpenStandardOutput() },
            new { Suffix = ".stderr", Stream = Console.OpenStandardError() } }) {
            using (var content = new FileStream(requestFile + pair.Suffix, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                if (content.Length > OutputLimit) throw new InvalidDataException("The fixed probe output exceeded its bound.");
                content.CopyTo(pair.Stream);
                pair.Stream.Flush();
            }
        }
        return Text(receipt, "status") == "executed" ? Number(receipt, "exitCode") : 78;
    }

    public static int Main(string[] args) {
        try {
            if (args.Length == 1 && args[0] == "--desktop-scope") {
                Console.WriteLine(Serializer().Serialize(DevPocketIsolatedCommand.DescribeDesktopScope()));
                return 0;
            }
            if (args.Length != 3 && args.Length != 4) throw new InvalidDataException("Invalid supervisor invocation.");
            var configuration = ReadConfiguration(args[1], args[2]);
            if (args[0] == "--client" && args.Length == 4) return Client(configuration, args[3]);
            if (args[0] != "--service" || args.Length != 3) throw new InvalidDataException("Invalid supervisor mode.");
            ServiceBase.Run(new DevPocketWindowsSupervisor(configuration));
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine(Serializer().Serialize(new {
                kind = "windows-supervisor-diagnostic", acceptance = false, status = "blocked",
                error = error.GetType().Name, nativeError = error is Win32Exception ? ((Win32Exception)error).NativeErrorCode : (int?)null
            }));
            return 78;
        }
    }
}
