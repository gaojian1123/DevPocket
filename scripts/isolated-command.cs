using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public sealed class DevPocketIsolatedCommand : IDisposable {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Startup {
        public int cb; public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
        public short show, reservedSize;
        public IntPtr reservedData, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupEx { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public uint processId, threadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct Security { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential)]
    struct SidAndAttributes { public IntPtr sid; public uint attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long processTime, jobTime; public uint flags; public UIntPtr minWork, maxWork;
        public uint active; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits basic; public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool LogonUserW(string user, string domain, string password, int kind, int provider, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessAsUserW(SafeAccessTokenHandle token, string application, StringBuilder command,
        IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint creationFlags,
        IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CreateRestrictedToken(SafeAccessTokenHandle token, uint flags, uint disabledCount,
        IntPtr disabled, uint privilegeCount, IntPtr privileges, uint restrictedCount,
        [In] SidAndAttributes[] restricted, out SafeAccessTokenHandle result);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int length, out int needed);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, IntPtr state, int length, IntPtr previous, IntPtr returned);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool LookupPrivilegeNameW(string system, IntPtr luid, StringBuilder name, ref int length);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool LookupPrivilegeValueW(string system, string name, IntPtr luid);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int index);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformationW(IntPtr handle, int kind, IntPtr value, int size, out int needed);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, ref Security security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr value, int size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, IntPtr bytes, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr process, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();

    IntPtr job, process, thread;
    readonly Task<string> controlInput;
    public bool Started { get; private set; }
    public bool ProcessTreeStopped { get; private set; }
    public int? ExitCode { get; private set; }
    public string Admission { get; private set; }
    public string Interruption { get; private set; }
    public string Stage { get; private set; }
    public string FailureStage { get; private set; }
    public int? NativeErrorCode { get; private set; }
    public bool? AssignPrimaryTokenEnabled { get; private set; }
    public bool? IncreaseQuotaEnabled { get; private set; }

    public DevPocketIsolatedCommand() : this(null) {}
    public DevPocketIsolatedCommand(Task<string> controlInput) {
        this.controlInput = controlInput;
        Admission = "not-admitted";
        Stage = "control";
        ProcessTreeStopped = true;
    }

    public static bool PrepareCreationPrivileges() {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) throw new Win32Exception();
        bool assignEnabled = false;
        try {
            foreach (string name in new[] { "SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege" }) {
                IntPtr state = Marshal.AllocHGlobal(16);
                try {
                    Marshal.WriteInt32(state, 1);
                    if (!LookupPrivilegeValueW(null, name, IntPtr.Add(state, 4))) throw new Win32Exception();
                    Marshal.WriteInt32(state, 12, 2);
                    bool adjusted = AdjustTokenPrivileges(token, false, state, 0, IntPtr.Zero, IntPtr.Zero);
                    int error = Marshal.GetLastWin32Error();
                    if (!adjusted) throw new Win32Exception(error);
                    if (name == "SeAssignPrimaryTokenPrivilege" && error == 1300) continue;
                    if (error != 0)
                        throw new InvalidOperationException("Hosted token creation privilege is unavailable: " + name);
                    if (name == "SeAssignPrimaryTokenPrivilege") assignEnabled = true;
                } finally { Marshal.FreeHGlobal(state); }
            }
        } finally { CloseHandle(token); }
        return assignEnabled;
    }

    public static string[] RequireSupervisorPrivileges() {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 8, out token)) throw new Win32Exception();
        try {
            int needed;
            GetTokenInformation(token, 3, IntPtr.Zero, 0, out needed);
            if (needed <= 0 || needed > 65536) throw new InvalidDataException("Invalid supervisor privilege buffer.");
            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try {
                if (!GetTokenInformation(token, 3, buffer, needed, out needed)) throw new Win32Exception();
                int count = Marshal.ReadInt32(buffer);
                if (count < 0 || 4 + count * 12 > needed) throw new InvalidDataException("Invalid supervisor privileges.");
                var names = new List<string>();
                for (int index = 0; index < count; index++) {
                    IntPtr luid = IntPtr.Add(buffer, 4 + index * 12);
                    int length = 256;
                    var name = new StringBuilder(length);
                    if (!LookupPrivilegeNameW(null, luid, name, ref length)) throw new Win32Exception();
                    string value = name.ToString();
                    if (value != "SeAssignPrimaryTokenPrivilege" && value != "SeIncreaseQuotaPrivilege" && value != "SeChangeNotifyPrivilege")
                        throw new InvalidOperationException("The supervisor retained an unrequested privilege.");
                    if ((Marshal.ReadInt32(luid, 8) & 2) == 0) throw new InvalidOperationException("A supervisor privilege is not enabled.");
                    names.Add(value);
                }
                if (!names.Contains("SeAssignPrimaryTokenPrivilege") || !names.Contains("SeIncreaseQuotaPrivilege"))
                    throw new InvalidOperationException("Required supervisor privileges are missing.");
                return names.ToArray();
            } finally { Marshal.FreeHGlobal(buffer); }
        } finally { CloseHandle(token); }
    }

    static byte[] UserObjectInformation(IntPtr handle, int kind) {
        int needed;
        GetUserObjectInformationW(handle, kind, IntPtr.Zero, 0, out needed);
        if (needed < 1 || needed > 4096) throw new InvalidDataException("Invalid desktop information.");
        IntPtr value = Marshal.AllocHGlobal(needed);
        try {
            if (!GetUserObjectInformationW(handle, kind, value, needed, out needed)) throw new Win32Exception();
            var bytes = new byte[needed];
            Marshal.Copy(value, bytes, 0, needed);
            return bytes;
        } finally { Marshal.FreeHGlobal(value); }
    }

    static byte[] TokenInformation(IntPtr token, int kind) {
        int needed;
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out needed);
        if (needed < 1 || needed > 65536) throw new InvalidDataException("Invalid token information.");
        IntPtr value = Marshal.AllocHGlobal(needed);
        try {
            if (!GetTokenInformation(token, kind, value, needed, out needed)) throw new Win32Exception();
            var bytes = new byte[needed];
            Marshal.Copy(value, bytes, 0, needed);
            return bytes;
        } finally { Marshal.FreeHGlobal(value); }
    }

    static string LogonSid(IntPtr token) {
        int needed;
        GetTokenInformation(token, 2, IntPtr.Zero, 0, out needed);
        if (needed < IntPtr.Size || needed > 65536) throw new InvalidDataException("Invalid token groups.");
        IntPtr value = Marshal.AllocHGlobal(needed);
        try {
            if (!GetTokenInformation(token, 2, value, needed, out needed)) throw new Win32Exception();
            int count = Marshal.ReadInt32(value), size = Marshal.SizeOf(typeof(SidAndAttributes));
            if (count < 0 || IntPtr.Size + (long)count * size > needed) throw new InvalidDataException("Invalid token group count.");
            string result = null;
            for (int index = 0; index < count; index++) {
                IntPtr group = IntPtr.Add(value, IntPtr.Size + index * size);
                if ((unchecked((uint)Marshal.ReadInt32(group, IntPtr.Size)) & 0xc0000000) != 0xc0000000) continue;
                if (result != null) throw new InvalidDataException("The token has multiple logon SIDs.");
                result = new SecurityIdentifier(Marshal.ReadIntPtr(group)).Value;
            }
            return result;
        } finally { Marshal.FreeHGlobal(value); }
    }

    public static Dictionary<string, object> DescribeDesktopScope() {
        // Establish the USER32 connection before querying its station and desktop handles.
        GetSystemMetrics(0);
        IntPtr station = GetProcessWindowStation(), desktop = GetThreadDesktop(GetCurrentThreadId()), token;
        if (station == IntPtr.Zero || desktop == IntPtr.Zero || !OpenProcessToken(GetCurrentProcess(), 8, out token))
            throw new Win32Exception();
        try {
            byte[] flags = UserObjectInformation(station, 1), statistics = TokenInformation(token, 10),
                session = TokenInformation(token, 12);
            if (flags.Length != 12 || statistics.Length < 56 || session.Length != 4)
                throw new InvalidDataException("Incomplete desktop/token scope.");
            using (var identity = new WindowsIdentity(token)) {
                return new Dictionary<string, object> {
                    { "version", 1 }, { "kind", "windows-desktop-scope" }, { "sid", identity.User.Value },
                    { "authenticationId", BitConverter.ToUInt32(statistics, 12).ToString("x8") + BitConverter.ToUInt32(statistics, 8).ToString("x8") },
                    { "logonSid", LogonSid(token) }, { "sessionId", BitConverter.ToUInt32(session, 0) },
                    { "windowStation", Encoding.Unicode.GetString(UserObjectInformation(station, 2)).TrimEnd('\0') },
                    { "desktop", Encoding.Unicode.GetString(UserObjectInformation(desktop, 2)).TrimEnd('\0') },
                    { "interactive", (BitConverter.ToUInt32(flags, 8) & 1) != 0 }
                };
            }
        } finally { CloseHandle(token); }
    }

    static SafeAccessTokenHandle WriteRestrictedToken(SafeAccessTokenHandle token, string sid) {
        var identity = new SecurityIdentifier(sid);
        var bytes = new byte[identity.BinaryLength];
        identity.GetBinaryForm(bytes, 0);
        var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try {
            SafeAccessTokenHandle restricted;
            var sids = new[] { new SidAndAttributes { sid = pinned.AddrOfPinnedObject(), attributes = 0 } };
            // The second write-access check must grant this task's SID, not a broad Users/Everyone group.
            if (!CreateRestrictedToken(token, 0x9, 0, IntPtr.Zero, 0, IntPtr.Zero, 1, sids, out restricted)) {
                int error = Marshal.GetLastWin32Error();
                if (restricted != null) restricted.Dispose();
                throw new Win32Exception(error);
            }
            return restricted;
        } finally { pinned.Free(); }
    }

    static string Quote(string value) {
        var output = new StringBuilder("\"");
        int slashes = 0;
        foreach (char item in value) {
            if (item == '\\') { slashes++; continue; }
            output.Append('\\', item == '"' ? slashes * 2 + 1 : slashes).Append(item);
            slashes = 0;
        }
        return output.Append('\\', slashes * 2).Append('"').ToString();
    }

    static void CheckControl(Task<string> cancellation, DateTime deadline) {
        if (cancellation.IsCompleted) {
            string message = cancellation.GetAwaiter().GetResult();
            if (message != null && message.Trim() != "cancel")
                throw new InvalidDataException("Unsupported isolated command control message.");
            throw new OperationCanceledException("Isolated command input closed or cancelled.");
        }
        if (DateTime.UtcNow >= deadline) throw new TimeoutException("Isolated command deadline expired.");
    }

    void RestrictToken(string sid, SafeAccessTokenHandle logonToken) {
        IntPtr token = IntPtr.Zero;
        try {
            // Acquire the candidate's handle without giving LocalService cross-account debug access.
            WindowsIdentity.RunImpersonated(logonToken, () => {
                if (!OpenProcessToken(process, 0x28, out token)) throw new Win32Exception();
            });
            using (var identity = new WindowsIdentity(token)) {
                if (identity.User.Value != sid || identity.User.Equals(WindowsIdentity.GetCurrent().User) ||
                    identity.Groups.Contains(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null)))
                    throw new InvalidOperationException("The candidate token is not the separate unprivileged identity.");
            }
            int needed;
            GetTokenInformation(token, 11, IntPtr.Zero, 0, out needed);
            if (needed < IntPtr.Size + Marshal.SizeOf(typeof(SidAndAttributes)) || needed > 65536)
                throw new InvalidDataException("The child write-restriction buffer is invalid.");
            IntPtr restrictions = Marshal.AllocHGlobal(needed);
            try {
                if (!GetTokenInformation(token, 11, restrictions, needed, out needed)) throw new Win32Exception();
                if (Marshal.ReadInt32(restrictions) != 1 ||
                    new SecurityIdentifier(Marshal.ReadIntPtr(restrictions, IntPtr.Size)).Value != sid)
                    throw new InvalidOperationException("The actual child token lacks the task-specific write restriction.");
            } finally { Marshal.FreeHGlobal(restrictions); }
            GetTokenInformation(token, 3, IntPtr.Zero, 0, out needed);
            if (needed <= 0 || needed > 65536) throw new Win32Exception();
            IntPtr privileges = Marshal.AllocHGlobal(needed);
            try {
                if (!GetTokenInformation(token, 3, privileges, needed, out needed)) throw new Win32Exception();
                int count = Marshal.ReadInt32(privileges);
                if (count < 0 || 4 + count * 12 > needed) throw new InvalidDataException("Invalid token privileges.");
                for (int index = 0; index < count; index++) {
                    IntPtr luid = IntPtr.Add(privileges, 4 + index * 12);
                    int length = 256;
                    var name = new StringBuilder(length);
                    if (!LookupPrivilegeNameW(null, luid, name, ref length)) throw new Win32Exception();
                    Marshal.WriteInt32(luid, 8, name.ToString() == "SeChangeNotifyPrivilege" ? 2 : 4);
                }
                if (!AdjustTokenPrivileges(token, false, privileges, 0, IntPtr.Zero, IntPtr.Zero) ||
                    Marshal.GetLastWin32Error() != 0) throw new Win32Exception();
            } finally { Marshal.FreeHGlobal(privileges); }
        } finally { if (token != IntPtr.Zero) CloseHandle(token); }
    }

    public int Run(string user, string password, string sid, string file, string[] args,
        string[] environment, string cwd, int timeoutMs) {
        return Run(user, password, sid, file, args, environment, cwd, timeoutMs, GetStdHandle(-11), GetStdHandle(-12));
    }

    public int Run(string user, string password, string sid, string file, string[] args,
        string[] environment, string cwd, int timeoutMs, IntPtr standardOutput, IntPtr standardError) {
        Task<string> cancellation = controlInput ?? Task.Run(() => Console.In.ReadLine());
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        SafeAccessTokenHandle token = null, restricted = null;
        IntPtr block = IntPtr.Zero, attributes = IntPtr.Zero, jobValue = IntPtr.Zero,
            handleValues = IntPtr.Zero, targetInput = IntPtr.Zero;
        bool initialized = false;
        try {
            CheckControl(cancellation, deadline);
            Stage = "privileges";
            AssignPrimaryTokenEnabled = PrepareCreationPrivileges();
            IncreaseQuotaEnabled = true;
            Stage = "job";
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            var limits = new ExtendedLimits(); limits.basic.flags = 0x2000;
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits))) throw new Win32Exception();
            var command = new StringBuilder(Quote(file));
            foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            Array.Sort(environment, StringComparer.OrdinalIgnoreCase);
            block = Marshal.StringToHGlobalUni(string.Join("\0", environment) + "\0\0");
            Stage = "logon";
            if (!LogonUserW(user, ".", password, 2, 0, out token)) throw new Win32Exception();
            restricted = WriteRestrictedToken(token, sid);
            Stage = "attributes";
            IntPtr bytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
            attributes = Marshal.AllocHGlobal(bytes);
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref bytes)) throw new Win32Exception();
            initialized = true;
            jobValue = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobValue, job);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000d), jobValue,
                    new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            var security = new Security { length = Marshal.SizeOf(typeof(Security)), inherit = 1 };
            targetInput = CreateFileW(@"\\.\NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
            if (targetInput == new IntPtr(-1)) { targetInput = IntPtr.Zero; throw new Win32Exception(); }
            handleValues = Marshal.AllocHGlobal(3 * IntPtr.Size);
            for (int index = 0; index < 3; index++) {
                IntPtr handle = index == 0 ? targetInput : index == 1 ? standardOutput : standardError;
                if (handle == IntPtr.Zero || handle == new IntPtr(-1) || !SetHandleInformation(handle, 1, 1))
                    throw new Win32Exception();
                Marshal.WriteIntPtr(handleValues, index * IntPtr.Size, handle);
            }
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handleValues,
                    new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            var startup = new StartupEx { startup = new Startup {
                cb = Marshal.SizeOf(typeof(StartupEx)), flags = 0x100,
                // Empty selects the fresh logon session; null would inherit the service desktop.
                input = targetInput, output = standardOutput, error = standardError, desktop = ""
            }, attributes = attributes };
            ProcessInfo info;
            CheckControl(cancellation, deadline);
            Admission = "creation-attempted";
            ProcessTreeStopped = false;
            Stage = "create";
            if (!CreateProcessAsUserW(restricted, file, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080404,
                    block, cwd, ref startup, out info)) throw new Win32Exception();
            process = info.process; thread = info.thread;
            Admission = "created";
            Stage = "identity";
            bool member;
            if (!IsProcessInJob(process, job, out member) || !member)
                throw new InvalidOperationException("The candidate did not join the isolated Job.");
            RestrictToken(sid, token);
            Stage = "resume";
            CheckControl(cancellation, deadline);
            if (ResumeThread(thread) == 0xffffffff) throw new Win32Exception();
            Started = true;
            Admission = "running";
            Stage = "wait";
            while (true) {
                CheckControl(cancellation, deadline);
                uint status = WaitForSingleObject(process, 50);
                if (status == 0xffffffff) throw new Win32Exception();
                if (status == 0) break;
            }
            CheckControl(cancellation, deadline);
            uint code;
            if (!GetExitCodeProcess(process, out code)) throw new Win32Exception();
            ExitCode = unchecked((int)code);
            return ExitCode.Value;
        } catch (OperationCanceledException) {
            Interruption = "cancelled";
            throw;
        } catch (TimeoutException) {
            Interruption = "timeout";
            throw;
        } catch (Win32Exception error) {
            NativeErrorCode = error.NativeErrorCode;
            throw;
        } finally {
            if (!ExitCode.HasValue) FailureStage = Stage;
            Stage = "cleanup";
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
            if (handleValues != IntPtr.Zero) Marshal.FreeHGlobal(handleValues);
            if (targetInput != IntPtr.Zero) CloseHandle(targetInput);
            if (restricted != null) restricted.Dispose();
            if (token != null) token.Dispose();
            if (block != IntPtr.Zero) Marshal.FreeHGlobal(block);
            var failures = new List<Exception>();
            try { Stop(); } catch (Exception error) { failures.Add(error); }
            if (failures.Count != 0) {
                FailureStage = "cleanup";
                throw new AggregateException("Isolated command cleanup failed.", failures);
            }
        }
    }

    void Stop() {
        if (Admission == "not-admitted") {
            ProcessTreeStopped = true;
            return;
        }
        ProcessTreeStopped = false;
        if (job != IntPtr.Zero) {
            if (!TerminateJobObject(job, 78)) throw new Win32Exception();
            IntPtr information = Marshal.AllocHGlobal(48);
            try {
                var deadline = DateTime.UtcNow.AddSeconds(10);
                do {
                    if (!QueryInformationJobObject(job, 1, information, 48, IntPtr.Zero)) throw new Win32Exception();
                    if (Marshal.ReadInt32(information, 40) == 0) { ProcessTreeStopped = true; return; }
                    System.Threading.Thread.Sleep(25);
                } while (DateTime.UtcNow < deadline);
                throw new InvalidOperationException("The isolated Job still contains live processes.");
            } finally { Marshal.FreeHGlobal(information); }
        }
        throw new InvalidOperationException("Native creation was attempted without an owned Job.");
    }

    public void Dispose() {
        if (thread != IntPtr.Zero) { CloseHandle(thread); thread = IntPtr.Zero; }
        if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    }
}
