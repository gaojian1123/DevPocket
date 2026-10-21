using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;

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
    struct FileAttributeTag { public uint attributes, tag; }
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
    static extern bool LogonUserW(string user, string domain, string password, int kind, int provider, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder command,
        IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint creationFlags,
        IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
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
    [DllImport("advapi32.dll")]
    static extern uint SetSecurityInfo(IntPtr handle, int objectType, uint information,
        IntPtr owner, IntPtr group, [In] byte[] dacl, IntPtr sacl);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(IntPtr handle, int objectType, uint information,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, ref Security security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(IntPtr file, int kind, out FileAttributeTag information, uint size);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
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

    public static void ProtectAncestor(string path, SecurityIdentifier candidate, FileSystemRights mutation) {
        if (!Path.IsPathRooted(path) || !string.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("An ancestor must be an absolute directory.");
        var security = new Security { length = Marshal.SizeOf(typeof(Security)) };
        // MAXIMUM_ALLOWED prevents SetSecurityInfo from propagating into the volume's descendants.
        IntPtr directory = CreateFileW(path, 0x02000000, 7, ref security, 3, 0x02200000, IntPtr.Zero);
        if (directory == new IntPtr(-1)) throw new Win32Exception();
        IntPtr descriptor = IntPtr.Zero;
        try {
            FileAttributeTag attributes;
            if (!GetFileInformationByHandleEx(directory, 9, out attributes, (uint)Marshal.SizeOf(typeof(FileAttributeTag))))
                throw new Win32Exception();
            if ((attributes.attributes & (uint)(FileAttributes.Directory | FileAttributes.ReparsePoint)) != (uint)FileAttributes.Directory)
                throw new InvalidOperationException("The opened ancestor is not a regular directory.");
            uint error = GetSecurityInfo(directory, 1, 4, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out descriptor);
            if (error != 0) throw new Win32Exception((int)error);
            if (descriptor == IntPtr.Zero) throw new InvalidOperationException("The ancestor security descriptor is unavailable.");
            uint length = GetSecurityDescriptorLength(descriptor);
            if (length < 20 || length > 1024 * 1024) throw new InvalidOperationException("The ancestor security descriptor is invalid.");
            var bytes = new byte[length];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            if (new RawSecurityDescriptor(bytes, 0).DiscretionaryAcl == null)
                throw new InvalidOperationException("An ancestor must retain a non-null DACL.");
            var acl = new DirectorySecurity();
            acl.SetSecurityDescriptorBinaryForm(bytes, AccessControlSections.Access);
            acl.AddAccessRule(new FileSystemAccessRule(candidate, mutation, AccessControlType.Deny));
            var raw = new RawSecurityDescriptor(acl.GetSecurityDescriptorBinaryForm(), 0).DiscretionaryAcl;
            var dacl = new byte[raw.BinaryLength];
            raw.GetBinaryForm(dacl, 0);
            error = SetSecurityInfo(directory, 1, 4, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
            if (error != 0) throw new Win32Exception((int)error);
        } finally {
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            CloseHandle(directory);
        }
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

    void RestrictToken(string sid) {
        IntPtr token;
        if (!OpenProcessToken(process, 0x28, out token)) throw new Win32Exception();
        try {
            using (var identity = new WindowsIdentity(token)) {
                if (identity.User.Value != sid || identity.User.Equals(WindowsIdentity.GetCurrent().User) ||
                    identity.Groups.Contains(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null)))
                    throw new InvalidOperationException("The candidate token is not the separate unprivileged identity.");
            }
            int needed;
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
        } finally { CloseHandle(token); }
    }

    public int Run(string user, string password, string sid, string file, string[] args,
        string[] environment, string cwd, int timeoutMs) {
        Task<string> cancellation = controlInput ?? Task.Run(() => Console.In.ReadLine());
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        IntPtr block = IntPtr.Zero, token = IntPtr.Zero, attributes = IntPtr.Zero, jobValue = IntPtr.Zero,
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
                IntPtr handle = index == 0 ? targetInput : GetStdHandle(-10 - index);
                if (handle == IntPtr.Zero || handle == new IntPtr(-1) || !SetHandleInformation(handle, 1, 1))
                    throw new Win32Exception();
                Marshal.WriteIntPtr(handleValues, index * IntPtr.Size, handle);
            }
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handleValues,
                    new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            var startup = new StartupEx { startup = new Startup {
                cb = Marshal.SizeOf(typeof(StartupEx)), flags = 0x100,
                input = targetInput, output = GetStdHandle(-11), error = GetStdHandle(-12)
            }, attributes = attributes };
            ProcessInfo info;
            CheckControl(cancellation, deadline);
            Admission = "creation-attempted";
            ProcessTreeStopped = false;
            Stage = "create";
            if (!CreateProcessAsUserW(token, file, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080404,
                    block, cwd, ref startup, out info)) throw new Win32Exception();
            process = info.process; thread = info.thread;
            Admission = "created";
            Stage = "identity";
            bool member;
            if (!IsProcessInJob(process, job, out member) || !member)
                throw new InvalidOperationException("The candidate did not join the isolated Job.");
            RestrictToken(sid);
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
            if (token != IntPtr.Zero) CloseHandle(token);
            if (block != IntPtr.Zero) Marshal.FreeHGlobal(block);
            Stop();
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
