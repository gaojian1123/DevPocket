$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadLine() | ConvertFrom-Json
if (-not $request.file -or $request.timeoutMs -le 0) { throw 'Invalid owned-command request.' }
$executable = (Get-Command -Name $request.file -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

# Assign the job atomically at process creation, including cancellation during startup.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

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
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, int size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr value, int size, IntPtr returned);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcessW(string file, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd,
        ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    IntPtr job, process;
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
    public DevPocketOwnedCommand(string file, string[] args, string cwd) {
        job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits(); limits.basic.flags = 0x2000;
        if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits))) {
            var error = new Win32Exception(); Dispose(); throw error;
        }
        var command = new StringBuilder(Quote(file));
        foreach (string arg in args) command.Append(' ').Append(Quote(arg));
        var startup = new StartupEx { startup = new Startup {
            cb = Marshal.SizeOf(typeof(StartupEx)), flags = 0x100,
            input = GetStdHandle(-10), output = GetStdHandle(-11), error = GetStdHandle(-12)
        } };
        IntPtr bytes = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
        startup.attributes = Marshal.AllocHGlobal(bytes);
        IntPtr jobValue = Marshal.AllocHGlobal(IntPtr.Size);
        ProcessInfo info;
        bool initialized = false;
        try {
            if (!InitializeProcThreadAttributeList(startup.attributes, 1, 0, ref bytes)) throw new Win32Exception();
            initialized = true;
            Marshal.WriteIntPtr(jobValue, job);
            if (!UpdateProcThreadAttribute(startup.attributes, 0, new IntPtr(0x2000d),
                    jobValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            if (!CreateProcessW(file, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004,
                    IntPtr.Zero, cwd, ref startup, out info)) throw new Win32Exception();
        } catch {
            Dispose(); throw;
        } finally {
            if (initialized) DeleteProcThreadAttributeList(startup.attributes);
            Marshal.FreeHGlobal(startup.attributes); Marshal.FreeHGlobal(jobValue);
        }
        process = info.process;
        try {
            if (ResumeThread(info.thread) == 0xffffffff) throw new Win32Exception();
        } catch {
            TerminateProcess(process, 1); Dispose(); throw;
        } finally { CloseHandle(info.thread); }
    }
    public bool Wait(int milliseconds) {
        uint status = WaitForSingleObject(process, (uint)milliseconds);
        if (status == 0xffffffff) throw new Win32Exception();
        return status == 0;
    }
    public int ExitCode {
        get { uint code; if (!GetExitCodeProcess(process, out code)) throw new Win32Exception(); return unchecked((int)code); }
    }
    public int[] ProcessIds() {
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
    public void Dispose() {
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
        if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
    }
}
'@

$owned = [DevPocketOwnedCommand]::new($executable, [string[]]$request.arguments, (Get-Location).Path)
[Console]::Error.WriteLine('DEVPOCKET_OWNERSHIP_ACTIVE')
$watch = [Diagnostics.Stopwatch]::StartNew()
$exitCode = 124
try {
    while ($true) {
        if ($request.persistent) {
            if (-not $owned.ProcessIds().Count) { break }
            Start-Sleep -Milliseconds 100
        } elseif ($owned.Wait(100)) { break }
        if ($watch.ElapsedMilliseconds -gt ($request.timeoutMs + $request.graceMs)) { break }
    }
    if ($owned.Wait(0)) { $exitCode = $owned.ExitCode }
} finally {
    foreach ($childId in $owned.ProcessIds()) {
        try { Stop-Process -Id $childId -Force -ErrorAction Stop }
        catch {
            if (Get-Process -Id $childId -ErrorAction SilentlyContinue) { throw }
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ($owned.ProcessIds().Count -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    $remaining = $owned.ProcessIds().Count
    $owned.Dispose()
    if ($remaining) { throw 'Owned command descendants did not confirm exit.' }
    [Console]::Error.WriteLine('DEVPOCKET_OWNED_TREE_STOPPED')
}
exit $exitCode
