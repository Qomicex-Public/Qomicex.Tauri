using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Qomicex.Launcher.Backend.Neo.Services;

public static class SystemMemoryHelper
{
    public static long GetTotalPhysicalMemory()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            return (long)(GetTotalMemoryWindows() / (1024 * 1024));
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
            return (long)(GetTotalMemoryLinux() / (1024 * 1024));
        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            return (long)(GetTotalMemoryMac() / (1024 * 1024));
        return -1;
    }

    public static long GetAvailablePhysicalMemory()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            return GetAvailableMemoryWindows() / (1024 * 1024);
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
            return GetAvailableMemoryLinux() / (1024 * 1024);
        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            return GetAvailableMemoryMacOS() / (1024 * 1024);
        return -1;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    private static long GetAvailableMemoryWindows()
    {
        var memStatus = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
        return GlobalMemoryStatusEx(ref memStatus) ? (long)memStatus.ullAvailPhys : -1;
    }

    private static ulong GetTotalMemoryWindows()
    {
        var memStatus = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
        return GlobalMemoryStatusEx(ref memStatus) ? memStatus.ullTotalPhys : 0;
    }

    private static long GetAvailableMemoryLinux()
    {
        try
        {
            foreach (var line in File.ReadLines("/proc/meminfo"))
            {
                if (line.StartsWith("MemAvailable:", StringComparison.Ordinal))
                {
                    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 2 && long.TryParse(parts[1], out var kb))
                        return kb * 1024;
                }
            }
        }
        catch (Exception ex) { Trace.WriteLine($"Read /proc/meminfo failed: {ex}"); }
        return -1;
    }

    private static ulong GetTotalMemoryLinux()
    {
        try
        {
            foreach (var line in File.ReadLines("/proc/meminfo"))
            {
                if (line.StartsWith("MemTotal", StringComparison.Ordinal))
                {
                    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 2 && ulong.TryParse(parts[1], out ulong kb))
                        return kb * 1024;
                }
            }
        }
        catch (Exception ex) { Trace.WriteLine($"Read /proc/meminfo failed: {ex}"); }
        return 0;
    }

    [DllImport("libc")]
    private static extern int sysctlbyname([MarshalAs(UnmanagedType.LPStr)] string property, IntPtr output, ref IntPtr oldLen, IntPtr newp, uint newlen);

    private static long GetAvailableMemoryMacOS()
    {
        IntPtr size = (IntPtr)sizeof(long);
        IntPtr pageSizePtr = Marshal.AllocHGlobal(sizeof(long));
        try
        {
            if (sysctlbyname("hw.pagesize", pageSizePtr, ref size, IntPtr.Zero, 0) != 0) return -1;
            long pageSize = Marshal.ReadInt64(pageSizePtr);

            var psi = new ProcessStartInfo("vm_stat") { RedirectStandardOutput = true, UseShellExecute = false };
            using var process = Process.Start(psi);
            var output = process!.StandardOutput.ReadToEnd();
            process.WaitForExit();

            long freePages = 0, inactivePages = 0;
            foreach (var line in output.Split('\n'))
            {
                if (line.Contains("Pages free")) freePages = ExtractPages(line);
                else if (line.Contains("Pages inactive")) inactivePages = ExtractPages(line);
            }
            return (freePages + inactivePages) * pageSize;
        }
        catch (Exception ex) { Trace.WriteLine($"Get macOS memory failed: {ex}"); return -1; }
        finally { Marshal.FreeHGlobal(pageSizePtr); }
    }

    private static ulong GetTotalMemoryMac()
    {
        IntPtr oldp = IntPtr.Zero;
        IntPtr oldlenp = (IntPtr)sizeof(ulong);
        oldp = Marshal.AllocHGlobal(oldlenp);
        try
        {
            return sysctlbyname("hw.memsize", oldp, ref oldlenp, IntPtr.Zero, 0) == 0
                ? (ulong)Marshal.ReadInt64(oldp) : 0;
        }
        catch (Exception ex) { Trace.WriteLine($"Get macOS total memory failed: {ex}"); return 0; }
        finally { Marshal.FreeHGlobal(oldp); }
    }

    private static long ExtractPages(string line)
    {
        var parts = line.Split(':');
        return parts.Length >= 2 && long.TryParse(parts[1].Trim().TrimEnd('.'), out var pages) ? pages : 0;
    }
}
