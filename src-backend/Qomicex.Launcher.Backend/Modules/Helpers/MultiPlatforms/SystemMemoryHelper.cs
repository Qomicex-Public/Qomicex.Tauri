using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;

namespace Qomicex.Launcher.Backend.Modules.Helpers.MultiPlatforms
{
    public class SystemMemoryHelper
    {
        public static long GetOptimalMemory(double percentage = 0.6)
        {
            try
            {
                long availableBytes = GetAvailablePhysicalMemory();
                if (availableBytes <= 0)
                    return -1;

                return (long)(availableBytes * percentage / 1024 / 1024);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"获取可用内存失败: {ex}");
                return -1;
            }
        }

        public static long GetTotalPhysicalMemory()
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                return (long)GetTotalMemoryWindows() / (1024 * 1024);

            if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
                return (long)GetTotalMemoryLinux() / (1024 * 1024);

            if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
                return (long)GetTotalMemoryMac() / (1024 * 1024);
            return -1;
        }

        public static long GetAvailablePhysicalMemory()
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                return GetAvailableMemoryWindows();

            if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
                return GetAvailableMemoryLinux();

            if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
                return GetAvailableMemoryMacOS();

            return -1;
        }

        #region Windows

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

        private static long GetAvailableMemoryWindows()
        {
            var memStatus = new MEMORYSTATUSEX();
            memStatus.dwLength = (uint)Marshal.SizeOf(memStatus);

            if (!GlobalMemoryStatusEx(ref memStatus))
                return -1;

            return (long)memStatus.ullAvailPhys;
        }

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

        private static ulong GetTotalMemoryWindows()
        {
            var memStatus = new MEMORYSTATUSEX();
            memStatus.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
            if (GlobalMemoryStatusEx(ref memStatus))
            {
                return memStatus.ullTotalPhys;
            }
            return 0;
        }

        #endregion

        #region Linux

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
            catch (Exception ex)
            {
                Debug.WriteLine($"读取 /proc/meminfo 失败: {ex}");
            }
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
                        {
                            return kb * 1024;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"读取 /proc/meminfo 失败: {ex}");
            }
            return 0;
        }
        #endregion

        #region macOS

        [DllImport("libc")]
        private static extern int sysctlbyname([MarshalAs(UnmanagedType.LPStr)] string property, IntPtr output, ref IntPtr oldLen, IntPtr newp, uint newlen);

        private static long GetAvailableMemoryMacOS()
        {
            IntPtr size = (IntPtr)Marshal.SizeOf(typeof(long));
            IntPtr pageSizePtr = Marshal.AllocHGlobal(sizeof(long));
            try
            {
                if (sysctlbyname("hw.pagesize", pageSizePtr, ref size, IntPtr.Zero, 0) != 0)
                    return -1;

                long pageSize = Marshal.ReadInt64(pageSizePtr);

                var psi = new ProcessStartInfo
                {
                    FileName = "vm_stat",
                    RedirectStandardOutput = true,
                    UseShellExecute = false
                };

                using var process = Process.Start(psi);
                string output = process!.StandardOutput.ReadToEnd();
                process.WaitForExit();

                long freePages = 0;
                long inactivePages = 0;

                foreach (var line in output.Split('\n'))
                {
                    if (line.Contains("Pages free"))
                        freePages = ExtractPages(line);
                    else if (line.Contains("Pages inactive"))
                        inactivePages = ExtractPages(line);
                }

                return (freePages + inactivePages) * pageSize;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"获取 macOS 可用内存失败: {ex}");
                return -1;
            }
            finally
            {
                Marshal.FreeHGlobal(pageSizePtr);
            }
        }

        private static long ExtractPages(string line)
        {
            var parts = line.Split(':');
            if (parts.Length < 2)
                return 0;

            var number = parts[1].Trim().TrimEnd('.');
            return long.TryParse(number, out var pages) ? pages : 0;
        }

        private static ulong GetTotalMemoryMac()
        {
            IntPtr oldp = IntPtr.Zero;
            IntPtr oldlenp = (IntPtr)sizeof(ulong);
            oldp = Marshal.AllocHGlobal(oldlenp);
            try
            {
                if (sysctlbyname("hw.memsize", oldp, ref oldlenp, IntPtr.Zero, 0) == 0)
                {
                    return (ulong)Marshal.ReadInt64(oldp);
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"获取 macOS 总内存失败: {ex}");
            }
            finally
            {
                Marshal.FreeHGlobal(oldp);
            }
            return 0;
        }

        #endregion
    }
}
