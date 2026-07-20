using System.Diagnostics;
using System.Runtime.InteropServices;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Services.Connector;

public sealed record GameProcessInfo(string PlayerName, string Uuid, bool IsMicrosoft, string? GameVersionArg);

public sealed class GameProcessInspector
{
    private readonly ILogger<GameProcessInspector> _logger;

    public GameProcessInspector(ILogger<GameProcessInspector> logger) => _logger = logger;

    public GameProcessInfo Inspect(int port)
    {
        var pid = FindPidByPort(port)
            ?? throw ApiException.BadRequest($"未在端口 {port} 上找到正在运行的 Minecraft 游戏");
        var cmdline = GetCommandLine(pid)
            ?? throw ApiException.BadRequest($"无法读取端口 {port} 对应进程 (PID {pid}) 的启动参数");

        var args = Tokenize(cmdline);
        var name = GetArgValue(args, "--username") ?? GetArgValue(args, "--name")
            ?? throw ApiException.BadRequest("游戏启动参数中未找到玩家名 (--username)");
        var uuid = GetArgValue(args, "--uuid") ?? "";
        var userType = GetArgValue(args, "--userType") ?? "";
        var version = GetArgValue(args, "--version");
        var isMicrosoft = string.Equals(userType, "microsoft", StringComparison.OrdinalIgnoreCase)
                          || string.Equals(userType, "msa", StringComparison.OrdinalIgnoreCase);

        return new GameProcessInfo(name, uuid, isMicrosoft, version);
    }

    public int? ScanJavaPort()
    {
        if (OperatingSystem.IsWindows()) return ScanJavaPortWindows();
        if (OperatingSystem.IsLinux()) return ScanJavaPortLinux();
        if (OperatingSystem.IsMacOS()) return ScanJavaPortMac();
        return null;
    }

    private int? ScanJavaPortWindows()
    {
        try
        {
            int bufferSize = 0;
            uint AF_INET = 2;
            GetExtendedTcpTable(IntPtr.Zero, ref bufferSize, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
            var buffer = Marshal.AllocHGlobal(bufferSize);
            try
            {
                if (GetExtendedTcpTable(buffer, ref bufferSize, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) != 0)
                    return null;

                int rowCount = Marshal.ReadInt32(buffer);
                var rowPtr = IntPtr.Add(buffer, 4);
                int rowSize = Marshal.SizeOf<MIB_TCPROW_OWNER_PID>();
                for (int i = 0; i < rowCount; i++)
                {
                    var row = Marshal.PtrToStructure<MIB_TCPROW_OWNER_PID>(IntPtr.Add(rowPtr, i * rowSize));
                    int localPort = (int)(((row.localPort & 0xFF) << 8) | ((row.localPort >> 8) & 0xFF));
                    try
                    {
                        var proc = System.Diagnostics.Process.GetProcessById((int)row.owningPid);
                        var name = proc.ProcessName.ToLowerInvariant();
                        if (name is "java" or "javaw")
                            return localPort;
                    }
                    catch { }
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Windows Java 端口扫描失败"); }
        return null;
    }

    private int? ScanJavaPortLinux()
    {
        try
        {
            var portToInode = new Dictionary<int, string>();
            foreach (var path in new[] { "/proc/net/tcp", "/proc/net/tcp6" })
            {
                if (!File.Exists(path)) continue;
                foreach (var line in File.ReadLines(path).Skip(1))
                {
                    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 10) continue;
                    var local = parts[1];
                    var colon = local.LastIndexOf(':');
                    if (colon < 0) continue;
                    if (int.TryParse(local[(colon + 1)..], System.Globalization.NumberStyles.HexNumber, null, out var p))
                        portToInode[p] = parts[9];
                }
            }
            if (portToInode.Count == 0) return null;

            foreach (var procDir in Directory.EnumerateDirectories("/proc"))
            {
                var pidName = Path.GetFileName(procDir);
                if (!int.TryParse(pidName, out _)) continue;
                var commPath = Path.Combine(procDir, "comm");
                if (!File.Exists(commPath)) continue;
                var procName = File.ReadAllText(commPath).Trim().ToLowerInvariant();
                if (procName is not ("java" or "javaw")) continue;

                var fdDir = Path.Combine(procDir, "fd");
                if (!Directory.Exists(fdDir)) continue;
                try
                {
                    foreach (var fd in Directory.EnumerateFiles(fdDir))
                    {
                        var link = ReadLinkSafe(fd);
                        if (link is null) continue;
                        foreach (var kv in portToInode)
                        {
                            if (link.Contains($"socket:[{kv.Value}]"))
                                return kv.Key;
                        }
                    }
                }
                catch { }
            }
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Linux Java 端口扫描失败"); }
        return null;
    }

    private int? ScanJavaPortMac()
    {
        try
        {
            var output = RunProcess("lsof", "-nP -iTCP -sTCP:LISTEN -c java -F pn");
            int? port = null;
            foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                if (line.StartsWith('n') && line.Contains(':'))
                {
                    var parts = line.Split(':');
                    if (parts.Length >= 2 && int.TryParse(parts[^1], out var p))
                        port = p;
                }
                if (line.StartsWith('p') && port.HasValue)
                    return port.Value;
            }
            if (port.HasValue) return port.Value;
        }
        catch (Exception ex) { _logger.LogWarning(ex, "macOS Java 端口扫描失败"); }
        return null;
    }

    private int? FindPidByPort(int port)
    {
        if (OperatingSystem.IsWindows()) return FindPidByPortWindows(port);
        if (OperatingSystem.IsLinux()) return FindPidByPortLinux(port);
        if (OperatingSystem.IsMacOS()) return FindPidByPortMac(port);
        return null;
    }

    // ── Windows: GetExtendedTcpTable ──
    private int? FindPidByPortWindows(int port)
    {
        try
        {
            int bufferSize = 0;
            uint AF_INET = 2;
            GetExtendedTcpTable(IntPtr.Zero, ref bufferSize, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
            var buffer = Marshal.AllocHGlobal(bufferSize);
            try
            {
                if (GetExtendedTcpTable(buffer, ref bufferSize, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) != 0)
                    return null;

                int rowCount = Marshal.ReadInt32(buffer);
                var rowPtr = IntPtr.Add(buffer, 4);
                int rowSize = Marshal.SizeOf<MIB_TCPROW_OWNER_PID>();
                for (int i = 0; i < rowCount; i++)
                {
                    var row = Marshal.PtrToStructure<MIB_TCPROW_OWNER_PID>(IntPtr.Add(rowPtr, i * rowSize));
                    int localPort = (int)(((row.localPort & 0xFF) << 8) | ((row.localPort >> 8) & 0xFF));
                    if (localPort == port) return (int)row.owningPid;
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Windows 端口反查失败"); }
        return null;
    }

    private const int TCP_TABLE_OWNER_PID_ALL = 5;

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(IntPtr pTcpTable, ref int pdwSize, bool bOrder, uint ulAf, int tableClass, uint reserved);

    [StructLayout(LayoutKind.Sequential)]
    private struct MIB_TCPROW_OWNER_PID
    {
        public uint state;
        public uint localAddr;
        public uint localPort;
        public uint remoteAddr;
        public uint remotePort;
        public uint owningPid;
    }

    // ── Linux: /proc/net/tcp(6) inode → /proc/*/fd ──
    private int? FindPidByPortLinux(int port)
    {
        try
        {
            var inodes = new HashSet<string>();
            foreach (var path in new[] { "/proc/net/tcp", "/proc/net/tcp6" })
            {
                if (!File.Exists(path)) continue;
                foreach (var line in File.ReadLines(path).Skip(1))
                {
                    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 10) continue;
                    var local = parts[1];
                    var colon = local.LastIndexOf(':');
                    if (colon < 0) continue;
                    if (int.TryParse(local[(colon + 1)..], System.Globalization.NumberStyles.HexNumber, null, out var p) && p == port)
                        inodes.Add(parts[9]);
                }
            }
            if (inodes.Count == 0) return null;

            foreach (var procDir in Directory.EnumerateDirectories("/proc"))
            {
                var pidName = Path.GetFileName(procDir);
                if (!int.TryParse(pidName, out var pid)) continue;
                var fdDir = Path.Combine(procDir, "fd");
                if (!Directory.Exists(fdDir)) continue;
                try
                {
                    foreach (var fd in Directory.EnumerateFiles(fdDir))
                    {
                        var link = ReadLinkSafe(fd);
                        if (link != null && inodes.Any(ino => link.Contains($"socket:[{ino}]")))
                            return pid;
                    }
                }
                catch { }
            }
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Linux 端口反查失败"); }
        return null;
    }

    private static string? ReadLinkSafe(string path)
    {
        try { return new FileInfo(path).LinkTarget; } catch { return null; }
    }

    // ── macOS: lsof ──
    private int? FindPidByPortMac(int port)
    {
        try
        {
            var output = RunProcess("lsof", $"-nP -iTCP:{port} -sTCP:LISTEN -t");
            var first = output.Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
            if (int.TryParse(first?.Trim(), out var pid)) return pid;
        }
        catch (Exception ex) { _logger.LogWarning(ex, "macOS 端口反查失败"); }
        return null;
    }

    private string? GetCommandLine(int pid)
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                using var searcher = new System.Management.ManagementObjectSearcher(
                    $"SELECT CommandLine FROM Win32_Process WHERE ProcessId={pid}");
                foreach (var o in searcher.Get())
                    return o["CommandLine"]?.ToString();
                return null;
            }
            if (OperatingSystem.IsLinux())
            {
                var path = $"/proc/{pid}/cmdline";
                if (!File.Exists(path)) return null;
                return File.ReadAllText(path).Replace('\0', ' ').Trim();
            }
            if (OperatingSystem.IsMacOS())
                return RunProcess("ps", $"-p {pid} -o command=").Trim();
        }
        catch (Exception ex) { _logger.LogWarning(ex, "读取 PID {Pid} 命令行失败", pid); }
        return null;
    }

    private static string RunProcess(string file, string args)
    {
        using var proc = Process.Start(new ProcessStartInfo(file, args)
        {
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        })!;
        var output = proc.StandardOutput.ReadToEnd();
        proc.WaitForExit(3000);
        return output;
    }

    private static List<string> Tokenize(string cmdline)
    {
        var tokens = new List<string>();
        var current = new System.Text.StringBuilder();
        bool inQuotes = false;
        foreach (var c in cmdline)
        {
            if (c == '"') { inQuotes = !inQuotes; continue; }
            if (c == ' ' && !inQuotes)
            {
                if (current.Length > 0) { tokens.Add(current.ToString()); current.Clear(); }
            }
            else current.Append(c);
        }
        if (current.Length > 0) tokens.Add(current.ToString());
        return tokens;
    }

    private static string? GetArgValue(List<string> args, string key)
    {
        var idx = args.FindIndex(a => a == key);
        if (idx >= 0 && idx + 1 < args.Count) return args[idx + 1];
        return null;
    }
}
