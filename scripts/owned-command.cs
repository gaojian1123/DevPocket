using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
#if NETFRAMEWORK
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
#endif

public sealed class DevPocketCommandInput {
    readonly Stream input;
    readonly byte[] buffer;
    readonly List<byte> line = new List<byte>();
    Task<int> pending;
    public bool Cancelled { get; private set; }
    public DevPocketCommandInput(Stream input, byte[] buffer, Task<int> pending, bool cancelled, byte[] prefix = null) {
        this.input = input; this.buffer = buffer; this.pending = pending;
        Cancelled = cancelled;
        if (prefix != null) {
            if (prefix.Length > 65536) throw new InvalidDataException("Owned command input exceeded its bound.");
            line.AddRange(prefix);
        }
    }
    public void Poll() {
        while (!Cancelled && pending.IsCompleted) {
            int count = pending.GetAwaiter().GetResult();
            if (count == 0) { Cancelled = true; break; }
            for (int i = 0; i < count; i++) {
                byte value = buffer[i];
                if (value == 10) {
                    string text = Encoding.UTF8.GetString(line.ToArray());
                    if (text.Trim() == "cancel") { Cancelled = true; break; }
                    throw new InvalidDataException("Unsupported owned-command control message.");
                } else {
                    if (line.Count >= 65536) throw new InvalidDataException("Owned command input exceeded its bound.");
                    line.Add(value);
                }
            }
            if (!Cancelled) pending = input.ReadAsync(buffer, 0, buffer.Length);
        }
    }
}

public sealed class DevPocketOwnedCommand : IDisposable {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Startup {
        public int cb; public string reserved, desktop, title;
        public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
        public short show,reservedSize;
        public IntPtr reservedData,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupEx { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process,thread; public uint processId,threadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct Security { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long processTime,jobTime;
        public uint flags;
        public UIntPtr minWork,maxWork;
        public uint active;
        public UIntPtr affinity;
        public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits basic; public IoCounters io;
        public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr value, int size, IntPtr returned);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string file, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd,
        ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);

    IntPtr job, process, thread;
    StreamWriter targetInput;
    readonly Process owner;
    readonly Process supervisorParent;
    readonly DevPocketCommandInput control;
    readonly DateTime deadline;
    readonly string receiptId;
    int interrupted;
    public int Interruption { get { return interrupted; } }

    public DevPocketOwnedCommand(Process owner, DevPocketCommandInput control, DateTime deadline, string receiptId,
        Process supervisorParent = null) {
        this.owner = owner; this.control = control; this.deadline = deadline; this.supervisorParent = supervisorParent;
        this.receiptId = receiptId;
    }
    public static void WriteControl(string receiptId, string phase) {
        byte[] bytes = Encoding.UTF8.GetBytes("\u001eDEVPOCKET:" + receiptId + ":" + phase + "\u001f");
        Console.OpenStandardError().Write(bytes, 0, bytes.Length);
    }
    public bool CheckStop() {
        if (interrupted != 0) return true;
        control.Poll();
        if (control.Cancelled) {
            interrupted = 130;
            WriteControl(receiptId, "cancel-accepted");
        } else if (owner.HasExited || (supervisorParent != null && supervisorParent.HasExited)) {
            interrupted = 125;
        } else if (DateTime.UtcNow >= deadline) {
            interrupted = 124;
            WriteControl(receiptId, "deadline-expired");
        }

        return interrupted != 0;
    }
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    public bool Start(string file, string[] args, string cwd) {
        if (CheckStop()) return false;
        job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits(); limits.basic.flags = 0x2000;
        if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits))) throw new Win32Exception();
        var security = new Security { length = Marshal.SizeOf(typeof(Security)), inherit = 1 };
        IntPtr inputRead, inputWrite;
        if (!CreatePipe(out inputRead, out inputWrite, ref security, 0)) throw new Win32Exception();
        try {
            if (!SetHandleInformation(inputWrite, 1, 0)) throw new Win32Exception();
            targetInput = new StreamWriter(new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write),
                new UTF8Encoding(false));
            inputWrite = IntPtr.Zero;
            var command = new StringBuilder(Quote(file));
            foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            var startup = new StartupEx { startup = new Startup {
                cb = Marshal.SizeOf(typeof(StartupEx)), flags = 0x100,
                input = inputRead, output = GetStdHandle(-11), error = GetStdHandle(-12)
            } };
            IntPtr bytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
            startup.attributes = Marshal.AllocHGlobal(bytes);
            IntPtr jobValue = Marshal.AllocHGlobal(IntPtr.Size);
            bool initialized = false;
            try {
                if (!InitializeProcThreadAttributeList(startup.attributes, 1, 0, ref bytes)) throw new Win32Exception();
                initialized = true;
                Marshal.WriteIntPtr(jobValue, job);
                if (!UpdateProcThreadAttribute(startup.attributes, 0, new IntPtr(0x2000d),
                        jobValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
                if (CheckStop()) return false;
                ProcessInfo info;
                // The target joins the Job while still suspended, before it can create descendants.
                if (!CreateProcessW(file, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004,
                        IntPtr.Zero, cwd, ref startup, out info)) throw new Win32Exception();
                process = info.process; thread = info.thread;
                bool member;
                if (!IsProcessInJob(process, job, out member) || !member)
                    throw new InvalidOperationException("The target did not join its owned Job.");
                if (CheckStop()) return false;
                if (ResumeThread(thread) == 0xffffffff) throw new Win32Exception();
                WriteControl(receiptId, "active");
                return true;
            } finally {
                if (initialized) DeleteProcThreadAttributeList(startup.attributes);
                Marshal.FreeHGlobal(startup.attributes); Marshal.FreeHGlobal(jobValue);
            }
        } finally {
            CloseHandle(inputRead);
            if (inputWrite != IntPtr.Zero) CloseHandle(inputWrite);
        }
    }
    public bool Wait(int milliseconds) {
        if (process == IntPtr.Zero) return true;
        uint status = WaitForSingleObject(process, (uint)milliseconds);
        if (status == 0xffffffff) throw new Win32Exception();
        return status == 0;
    }
    public int ExitCode {
        get {
            uint code;
            if (process == IntPtr.Zero || !GetExitCodeProcess(process, out code)) throw new Win32Exception();
            return unchecked((int)code);
        }
    }
    public int[] ProcessIds() {
        if (job == IntPtr.Zero) return new int[0];
        for (int bytes = 4096; bytes <= 1048576; bytes *= 2) {
            IntPtr buffer = Marshal.AllocHGlobal(bytes);
            try {
                if (!QueryInformationJobObject(job, 3, buffer, bytes, IntPtr.Zero)) {
                    if (Marshal.GetLastWin32Error() == 234) continue;
                    throw new Win32Exception();
                }
                int count = Marshal.ReadInt32(buffer, 4);
                var ids = new List<int>();
                for (int i = 0; i < count; i++) ids.Add((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size));
                return ids.ToArray();
            } finally { Marshal.FreeHGlobal(buffer); }
        }
        throw new InvalidOperationException("Owned process list exceeded its bound.");
    }
    public int Monitor(bool persistent, int graceMs) {
        long stopAt = -1;
        var clock = Stopwatch.StartNew();
        while (true) {
            if (CheckStop() && stopAt < 0) {
                if (interrupted == 125) return interrupted;
                stopAt = clock.ElapsedMilliseconds + graceMs;
                try { targetInput.WriteLine("cancel"); targetInput.Flush(); }
                catch (IOException) { if (!Wait(0)) throw; }
            }
            if ((!persistent && Wait(0)) || ProcessIds().Length == 0)
                return interrupted != 0 ? interrupted : ExitCode;
            if (stopAt >= 0 && clock.ElapsedMilliseconds >= stopAt) return interrupted;
            Thread.Sleep(20);
        }
    }
    public void StopAndConfirm() {
        if (job != IntPtr.Zero && ProcessIds().Length != 0 && !TerminateJobObject(job, 1)) throw new Win32Exception();
        var watch = Stopwatch.StartNew();
        while (ProcessIds().Length != 0 || !Wait(0)) {
            if (watch.ElapsedMilliseconds >= 10000) throw new InvalidOperationException("Owned command descendants did not confirm exit.");
            Thread.Sleep(10);
        }
    }
    public void Dispose() {
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
        if (thread != IntPtr.Zero) { CloseHandle(thread); thread = IntPtr.Zero; }
        if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
        if (targetInput != null) { targetInput.Dispose(); targetInput = null; }
    }
}

#if NETFRAMEWORK
[DataContract]
public sealed class DevPocketCommandRequest {
    [DataMember] public string file;
    [DataMember] public string[] arguments;
    [DataMember] public int timeoutMs;
    [DataMember] public int graceMs;
    [DataMember] public int ownerPid;
    [DataMember] public int bootstrapPid;
    [DataMember] public long deadlineUnixMs;
    [DataMember] public bool cancelled;
    [DataMember] public bool persistent;
    [DataMember] public string receiptId;
}

public static class DevPocketCommandProgram {
    static string Executable(string file) {
        if (Path.IsPathRooted(file) || file.IndexOf(Path.DirectorySeparatorChar) >= 0 ||
            file.IndexOf(Path.AltDirectorySeparatorChar) >= 0) return Path.GetFullPath(file);
        var folders = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator);
        foreach (string folder in folders) {
            if (string.IsNullOrWhiteSpace(folder)) continue;
            string candidate = Path.Combine(folder.Trim('"'), file);
            if (File.Exists(candidate)) return Path.GetFullPath(candidate);
            if (!Path.HasExtension(file) && File.Exists(candidate + ".exe")) return Path.GetFullPath(candidate + ".exe");
        }
        throw new FileNotFoundException("The owned executable could not be resolved.");
    }
    public static int Main() {
        DevPocketOwnedCommand owned = null;
        Process owner = null, bootstrap = null;
        DevPocketCommandRequest request = null;
        int result = 1;
        bool stopped = false;
        try {
            Stream input = Console.OpenStandardInput();
            var bytes = new List<byte>();
            while (true) {
                int value = input.ReadByte();
                if (value < 0) throw new EndOfStreamException("Owned command input closed before startup.");
                if (value == 10) break;
                if (bytes.Count >= 1048576) throw new InvalidDataException("Owned command request exceeded its bound.");
                bytes.Add((byte)value);
            }
            using (var encoded = new MemoryStream(bytes.ToArray())) {
                request = (DevPocketCommandRequest)new DataContractJsonSerializer(typeof(DevPocketCommandRequest)).ReadObject(encoded);
            }
            Guid receipt;
            if (request == null || string.IsNullOrEmpty(request.file) || request.arguments == null ||
                Array.Exists(request.arguments, value => value == null) || request.ownerPid <= 0 || request.bootstrapPid <= 0 ||
                request.timeoutMs <= 0 || request.timeoutMs > 86400000 || request.graceMs < 0 || request.graceMs > 60000 ||
                request.deadlineUnixMs <= 0 || !Guid.TryParse(request.receiptId, out receipt))
                throw new InvalidDataException("Invalid owned command request.");
            owner = Process.GetProcessById(request.ownerPid);
            bootstrap = Process.GetProcessById(request.bootstrapPid);
            IntPtr ownerHandle = owner.Handle, bootstrapHandle = bootstrap.Handle;
            byte[] buffer = new byte[4096];
            var control = new DevPocketCommandInput(input, buffer, input.ReadAsync(buffer, 0, buffer.Length), request.cancelled);
            DateTime deadline = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(request.deadlineUnixMs);
            owned = new DevPocketOwnedCommand(owner, control, deadline, request.receiptId, bootstrap);
            result = owned.Start(Executable(request.file), request.arguments, Environment.CurrentDirectory)
                ? owned.Monitor(request.persistent, request.graceMs) : owned.Interruption;
        } catch (Exception error) {
            Console.Error.WriteLine(error);
        } finally {
            try {
                if (owned != null) { owned.StopAndConfirm(); stopped = true; }
            } catch (Exception error) {
                result = 1; Console.Error.WriteLine(error);
            } finally {
                if (owned != null) owned.Dispose();
                if (owner != null) owner.Dispose();
                if (bootstrap != null) bootstrap.Dispose();
            }
            if (stopped) {
                DevPocketOwnedCommand.WriteControl(request.receiptId, "tree-stopped");
            }
        }
        return result;
    }
}
#endif
