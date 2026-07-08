using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using static Qomicex.Core.DataModules;

namespace Qomicex.Core.Modules.Helpers
{
    public class SystemInfoHelper
    {
        private static readonly Lazy<string> _osName = new(() => GetSystemInfo().OSName ?? "unknown");
        private static readonly Lazy<string> _osArch = new(() => RuntimeInformation.OSArchitecture.ToString().ToLower());
        private static readonly Lazy<string> _separator = new(() =>
        {
            var info = GetSystemInfo();
            if (info.OSName != null && info.OSName.Contains("windows", StringComparison.OrdinalIgnoreCase))
                return ";";
            return ":";
        });

        public static string OsName => _osName.Value;
        public static string OsArch => _osArch.Value;
        public static string Separator => _separator.Value;

        public static SystemInfo GetSystemInfo()
        {
            string osDescription = System.Runtime.InteropServices.RuntimeInformation.OSDescription;
            string osName;
            
            // 优先使用 API 检测（更可靠）
            if (OperatingSystem.IsWindows())
                osName = "windows";
            else if (OperatingSystem.IsLinux())
                osName = "linux";
            else if (OperatingSystem.IsMacOS())
                osName = "osx";
            else if (osDescription.Contains("Windows", StringComparison.OrdinalIgnoreCase))
                osName = "windows";
            else if (osDescription.Contains("Linux", StringComparison.OrdinalIgnoreCase))
                osName = "linux";
            else if (osDescription.Contains("Darwin", StringComparison.OrdinalIgnoreCase) || osDescription.Contains("Mac", StringComparison.OrdinalIgnoreCase))
                osName = "osx";
            else osName = "unknown";

            // 提取大版本号
            string versionId = "unknown";
            try
            {
                if (osName == "windows")
                {
                    // Windows: Environment.OSVersion.Version.Major 通常对应大版本号
                    versionId = Environment.OSVersion.Version.Major.ToString();
                }
                else if (osName == "linux")
                { // Linux: OSDescription 里通常是 "Linux 5.x.x"
                    var parts = osDescription.Split(' ');
                    if (parts.Length > 1 && int.TryParse(parts[1].Split('.')[0], out int major))
                        versionId = major.ToString();
                }
                else if (osName == "osx")
                { // macOS: Darwin 内核版本号
                    var parts = osDescription.Split(' ');
                    if (parts.Length > 1 && int.TryParse(parts[1].Split('.')[0], out int major))
                        versionId = major.ToString();
                }
            }
            catch
            {
                versionId = "unknown";
            }
            return new SystemInfo
            {
                OS = osDescription,
                OSVersion = Environment.OSVersion.VersionString,
                OSName = osName,
                Architecture = System.Runtime.InteropServices.RuntimeInformation.OSArchitecture.ToString(),
                OSVersionID = versionId,
                OSDisplayName = GetOsDisplayName(osName, osDescription)
            };
        }

        private static string GetOsDisplayName(string osName, string osDescription)
        {
            try
            {
                if (osName == "windows")
                {
                    var v = Environment.OSVersion.Version;
                    return ResolveWindowsName(v.Major, v.Minor, v.Build);
                }
                if (osName == "linux")
                {
                    return ResolveLinuxDistro(osDescription);
                }
            }
            catch { }
            return osDescription;
        }

        private static string ResolveWindowsName(int major, int minor, int build)
        {
            if (major == 10 && minor == 0)
            {
                if (build >= 26100) return $"Windows 11 24H2+";
                if (build >= 22631) return $"Windows 11 23H2";
                if (build >= 22621) return $"Windows 11 22H2";
                if (build >= 22000) return $"Windows 11 21H2";
                if (build >= 19045) return $"Windows 10 22H2";
                if (build >= 19044) return $"Windows 10 21H2";
                if (build >= 19043) return $"Windows 10 21H1";
                if (build >= 19042) return $"Windows 10 20H2";
                if (build >= 19041) return $"Windows 10 2004";
                if (build >= 18363) return $"Windows 10 1909";
                if (build >= 18362) return $"Windows 10 1903";
                if (build >= 17763) return $"Windows 10 1809";
                if (build >= 17134) return $"Windows 10 1803";
                if (build >= 16299) return $"Windows 10 1709";
                if (build >= 15063) return $"Windows 10 1703";
                if (build >= 10586) return $"Windows 10 1511";
                if (build >= 10240) return $"Windows 10 1507";
            }
            if (major == 6 && minor == 3) return "Windows 8.1";
            if (major == 6 && minor == 2) return "Windows 8";
            if (major == 6 && minor == 1) return "Windows 7";
            if (major == 6 && minor == 0) return "Windows Vista";
            if (major == 5 && minor == 2) return "Windows XP x64 / Server 2003";
            if (major == 5 && minor == 1) return "Windows XP";
            return $"Windows NT {major}.{minor}.{build}";
        }

        private static string ResolveLinuxDistro(string osDescription)
        {
            try
            {
                if (System.IO.File.Exists("/etc/os-release"))
                {
                    foreach (var line in System.IO.File.ReadAllLines("/etc/os-release"))
                    {
                        if (line.StartsWith("PRETTY_NAME="))
                        {
                            var value = line.Substring("PRETTY_NAME=".Length).Trim('"', '\'');
                            if (!string.IsNullOrEmpty(value)) return value;
                        }
                    }
                    string name = null, version = null;
                    foreach (var line in System.IO.File.ReadAllLines("/etc/os-release"))
                    {
                        if (line.StartsWith("NAME=")) name = line.Substring("NAME=".Length).Trim('"', '\'');
                        else if (line.StartsWith("VERSION=")) version = line.Substring("VERSION=".Length).Trim('"', '\'');
                        else if (line.StartsWith("VERSION_ID=")) version = line.Substring("VERSION_ID=".Length).Trim('"', '\'');
                    }
                    if (name != null) return version != null ? $"{name} {version}" : name;
                }
                if (System.IO.File.Exists("/usr/lib/os-release"))
                {
                    foreach (var line in System.IO.File.ReadAllLines("/usr/lib/os-release"))
                    {
                        if (line.StartsWith("PRETTY_NAME="))
                        {
                            var value = line.Substring("PRETTY_NAME=".Length).Trim('"', '\'');
                            if (!string.IsNullOrEmpty(value)) return value;
                        }
                    }
                }
            }
            catch { }
            var parts = osDescription.Split(' ');
            return parts.Length > 1 ? string.Join(" ", parts[1..]) : osDescription;
        }
    }
}
