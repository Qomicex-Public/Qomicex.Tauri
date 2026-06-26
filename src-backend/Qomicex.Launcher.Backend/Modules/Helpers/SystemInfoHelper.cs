using System.Text.Json;
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using static Qomicex.Launcher.Backend.DataModules;

namespace Qomicex.Launcher.Backend.Modules.Helpers
{
    public class SystemInfoHelper
    {

        private static string osname;
        private static string osarch;
        private static string separator;
        public static string OsName
        {
            get
            {
                if (osname != null)
                {
                    return osname;
                }
                else
                {
                    SystemInfo info = GetSystemInfo();
                    if (info.OSName != null)
                    {
                        osname = info.OSName;
                        return info.OSName;
                    }
                    return null;
                }
            }
        }
        public static string OsArch
        {
            get
            {
                if (osarch != null)
                {
                    return osarch;
                }
                else
                {
                    osarch = RuntimeInformation.OSArchitecture.ToString().ToLower();
                    return RuntimeInformation.OSArchitecture.ToString().ToLower();

                }
            }
        }
        public static string Separator
        {
            get
            {
                if (separator != null)
                {
                    return separator;
                }
                else
                {
                    SystemInfo info = GetSystemInfo();
                    if (info.OSName != null)
                    {
                        if (info.OSName.ToLower().Contains("windows"))
                        {
                            separator = ";";
                        }
                        else
                        {
                            separator = ":";
                        }
                        return separator;
                    }
                    return null;
                }
            }
        }

        public static SystemInfo GetSystemInfo()
        {
            string osDescription = System.Runtime.InteropServices.RuntimeInformation.OSDescription;
            string osName;
            if (osDescription.Contains("Windows", StringComparison.OrdinalIgnoreCase))
                osName = "windows";
            else if (osDescription.Contains("Linux", StringComparison.OrdinalIgnoreCase))
                osName = "linux";
            else if (osDescription.Contains("Darwin", StringComparison.OrdinalIgnoreCase) || osDescription.Contains("Mac", StringComparison.OrdinalIgnoreCase))
                osName = "osx";
            else osName = "unknown";

            string versionId = "unknown";
            try
            {
                if (osName == "windows")
                {
                    versionId = Environment.OSVersion.Version.Major.ToString();
                }
                else if (osName == "linux")
                {
                    var parts = osDescription.Split(' ');
                    if (parts.Length > 1 && int.TryParse(parts[1].Split('.')[0], out int major))
                        versionId = major.ToString();
                }
                else if (osName == "osx")
                {
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
                OSVersionID = versionId
            };
        }
    }
}
