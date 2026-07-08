using Newtonsoft.Json.Linq;

namespace Qomicex.Core.Modules.Helpers.Resources
{
    public enum DownloadSource
    {
        BMCLAPI,
        Adoptium,
        Zulu
    }

    public enum JavaPlatform
    {
        Windows,
        Linux,
        MacOS
    }

    public enum JavaArchitecture
    {
        X64,
        Arm64
    }

    public enum JavaPackageType
    {
        JRE,
        JDK
    }

    public sealed class JavaPackageInfo
    {
        public int MajorVersion { get; set; }
        public string FullVersion { get; set; } = string.Empty;
        public string Build { get; set; } = string.Empty;
        public JavaPlatform Platform { get; set; }
        public JavaArchitecture Architecture { get; set; }
        public JavaPackageType PackageType { get; set; }
        public DownloadSource Source { get; set; }
        public string FileName { get; set; } = string.Empty;
        public string DownloadUrl { get; set; } = string.Empty;
        public string Sha256 { get; set; } = string.Empty;
        public long? Size { get; set; }
    }

    public class JavaResourceHelper
    {
        private static readonly HttpClient _httpClient = new();

        public async Task<JavaPackageInfo?> GetLatestPackageAsync(
            int majorVersion,
            JavaPlatform platform,
            JavaArchitecture architecture,
            JavaPackageType packageType,
            DownloadSource source = DownloadSource.Adoptium)
        {
            if (majorVersion <= 0)
            {
                throw new ArgumentException("Java major version must be greater than 0.", nameof(majorVersion));
            }

            ValidateEnumValue(platform, nameof(platform));
            ValidateEnumValue(architecture, nameof(architecture));
            ValidateEnumValue(packageType, nameof(packageType));
            ValidateEnumValue(source, nameof(source));

            return source switch
            {
                DownloadSource.Adoptium => await GetLatestFromAdoptiumAsync(majorVersion, platform, architecture, packageType),
                DownloadSource.Zulu => await GetLatestFromZuluAsync(majorVersion, platform, architecture, packageType),
                DownloadSource.BMCLAPI => await GetLatestFromBmclapiAsync(majorVersion, platform, architecture, packageType),
                _ => throw new ArgumentException($"Unsupported Java download source: {source}.", nameof(source))
            };
        }

        public async Task<JavaPackageInfo?> GetLatestPackageWithFallbackAsync(
            int majorVersion,
            JavaPlatform platform,
            JavaArchitecture architecture,
            JavaPackageType packageType,
            params DownloadSource[] sources)
        {
            var orderedSources = sources is { Length: > 0 }
                ? sources
                : new[] { DownloadSource.Adoptium, DownloadSource.Zulu, DownloadSource.BMCLAPI };

            foreach (var source in orderedSources)
            {
                var result = await GetLatestPackageAsync(majorVersion, platform, architecture, packageType, source);
                if (result is not null)
                {
                    return result;
                }
            }

            return null;
        }

        private static void ValidateEnumValue<TEnum>(TEnum value, string paramName)
            where TEnum : struct, Enum
        {
            if (!Enum.IsDefined(value))
            {
                throw new ArgumentException($"Unsupported {typeof(TEnum).Name} value: {value}.", paramName);
            }
        }

        private static string BuildAdoptiumUrl(int majorVersion)
        {
            return $"https://api.adoptium.net/v3/assets/latest/{majorVersion}/hotspot";
        }

        private async Task<JavaPackageInfo?> GetLatestFromAdoptiumAsync(
            int majorVersion,
            JavaPlatform platform,
            JavaArchitecture architecture,
            JavaPackageType packageType)
        {
            try
            {
                var json = await _httpClient.GetStringAsync(BuildAdoptiumUrl(majorVersion));
                var assets = JArray.Parse(json);
                var matched = assets.FirstOrDefault(asset => IsMatchingAdoptiumBinary(asset, platform, architecture, packageType));
                return matched is null
                    ? null
                    : ToAdoptiumPackageInfo(matched, majorVersion, platform, architecture, packageType);
            }
            catch
            {
                return null;
            }
        }

        private static bool IsMatchingAdoptiumBinary(
            JToken asset,
            JavaPlatform platform,
            JavaArchitecture architecture,
            JavaPackageType packageType)
        {
            return string.Equals(asset["binary"]?["os"]?.ToString(), MapAdoptiumOs(platform), StringComparison.OrdinalIgnoreCase)
                && string.Equals(asset["binary"]?["architecture"]?.ToString(), MapAdoptiumArchitecture(architecture), StringComparison.OrdinalIgnoreCase)
                && string.Equals(asset["binary"]?["image_type"]?.ToString(), MapAdoptiumImageType(packageType), StringComparison.OrdinalIgnoreCase)
                && IsPortablePackage(asset["binary"]?["package"]?["name"]?.ToString(), platform);
        }

        private static JavaPackageInfo ToAdoptiumPackageInfo(
            JToken asset,
            int majorVersion,
            JavaPlatform platform,
            JavaArchitecture architecture,
            JavaPackageType packageType)
        {
            return new JavaPackageInfo
            {
                MajorVersion = majorVersion,
                FullVersion = asset["version"]?["openjdk_version"]?.ToString() ?? string.Empty,
                Build = asset["version"]?["build"]?.ToString() ?? string.Empty,
                Platform = platform,
                Architecture = architecture,
                PackageType = packageType,
                Source = DownloadSource.Adoptium,
                FileName = asset["binary"]?["package"]?["name"]?.ToString() ?? string.Empty,
                DownloadUrl = asset["binary"]?["package"]?["link"]?.ToString() ?? string.Empty,
                Sha256 = asset["binary"]?["package"]?["checksum"]?.ToString() ?? string.Empty,
                Size = asset["binary"]?["package"]?["size"]?.Value<long?>()
            };
        }

        private static string MapAdoptiumOs(JavaPlatform platform)
        {
            return platform switch
            {
                JavaPlatform.Windows => "windows",
                JavaPlatform.Linux => "linux",
                JavaPlatform.MacOS => "mac",
                _ => throw new ArgumentException($"Unsupported Java platform: {platform}.", nameof(platform))
            };
        }

        private static string MapAdoptiumArchitecture(JavaArchitecture architecture)
        {
            return architecture switch
            {
                JavaArchitecture.X64 => "x64",
                JavaArchitecture.Arm64 => "aarch64",
                _ => throw new ArgumentException($"Unsupported Java architecture: {architecture}.", nameof(architecture))
            };
        }

        private static string MapAdoptiumImageType(JavaPackageType packageType)
        {
            return packageType switch
            {
                JavaPackageType.JRE => "jre",
                JavaPackageType.JDK => "jdk",
                _ => throw new ArgumentException($"Unsupported Java package type: {packageType}.", nameof(packageType))
            };
        }

        private static bool IsPortablePackage(string? fileName, JavaPlatform platform)
        {
            if (string.IsNullOrWhiteSpace(fileName))
            {
                return false;
            }

            var lower = fileName.Trim().ToLowerInvariant();

            return platform switch
            {
                JavaPlatform.Windows => lower.EndsWith(".zip", StringComparison.Ordinal),
                JavaPlatform.Linux => lower.EndsWith(".tar.gz", StringComparison.Ordinal),
                JavaPlatform.MacOS => lower.EndsWith(".tar.gz", StringComparison.Ordinal)
                    || lower.EndsWith(".zip", StringComparison.Ordinal),
                _ => false
            };
        }

        private static string BuildZuluMetadataUrl(
            int majorVersion,
            JavaPlatform platform,
            JavaArchitecture architecture,
            JavaPackageType packageType)
        {
            var archiveType = platform switch
            {
                JavaPlatform.Windows => "zip",
                JavaPlatform.Linux => "tar.gz",
                JavaPlatform.MacOS => "zip",
                _ => throw new ArgumentException($"Unsupported Java platform: {platform}.", nameof(platform))
            };

            var os = platform switch
            {
                JavaPlatform.Windows => "windows",
                JavaPlatform.Linux => "linux",
                JavaPlatform.MacOS => "macos",
                _ => throw new ArgumentException($"Unsupported Java platform: {platform}.", nameof(platform))
            };

            var arch = architecture switch
            {
                JavaArchitecture.X64 => "x86_64",
                JavaArchitecture.Arm64 => "arm64",
                _ => throw new ArgumentException($"Unsupported Java architecture: {architecture}.", nameof(architecture))
            };

            var javaPackageType = packageType switch
            {
                JavaPackageType.JRE => "jre",
                JavaPackageType.JDK => "jdk",
                _ => throw new ArgumentException($"Unsupported Java package type: {packageType}.", nameof(packageType))
            };

            return $"https://api.azul.com/metadata/v1/zulu/packages/?java_version={majorVersion}&os={os}&arch={arch}&archive_type={Uri.EscapeDataString(archiveType)}&java_package_type={javaPackageType}&release_status=ga&availability_types=CA&latest=true&page=1&page_size=20";
        }

        private async Task<JavaPackageInfo?> GetLatestFromZuluAsync(
            int majorVersion,
            JavaPlatform platform,
            JavaArchitecture architecture,
            JavaPackageType packageType)
        {
            try
            {
                var url = BuildZuluMetadataUrl(majorVersion, platform, architecture, packageType);
                var json = await _httpClient.GetStringAsync(url);
                return ParseZuluResponse(json, majorVersion, platform, architecture, packageType);
            }
            catch
            {
                return null;
            }
        }

        private static JavaPackageInfo? ParseZuluResponse(
            string json,
            int majorVersion,
            JavaPlatform platform,
            JavaArchitecture architecture,
            JavaPackageType packageType)
        {
            var packages = JArray.Parse(json);
            var matched = packages
                .Where(package => IsMatchingZuluPackage(package, platform) && HasZuluOrderingFields(package))
                .OrderByDescending(package => ToComparableVersion(package["java_version"] as JArray))
                .ThenByDescending(package => ToComparableVersion(package["distro_version"] as JArray))
                .ThenByDescending(package => package["openjdk_build_number"]?.Value<int?>() ?? int.MinValue)
                .FirstOrDefault();
            if (matched is null)
            {
                return null;
            }

            var javaVersion = matched["java_version"] is JArray versionParts
                ? string.Join('.', versionParts.Select(part => part.ToString()))
                : string.Empty;

            return new JavaPackageInfo
            {
                MajorVersion = majorVersion,
                FullVersion = javaVersion,
                Build = matched["openjdk_build_number"]?.ToString() ?? string.Empty,
                Platform = platform,
                Architecture = architecture,
                PackageType = packageType,
                Source = DownloadSource.Zulu,
                FileName = matched["name"]?.ToString() ?? string.Empty,
                DownloadUrl = matched["download_url"]?.ToString() ?? string.Empty,
                Sha256 = string.Empty,
                Size = null
            };
        }

        private static bool IsMatchingZuluPackage(JToken package, JavaPlatform platform)
        {
            var fileName = package["name"]?.ToString();
            if (!IsPortablePackage(fileName, platform))
            {
                return false;
            }

            var lower = fileName!.ToLowerInvariant();
            return !lower.Contains("-fx-", StringComparison.Ordinal)
                && !lower.Contains("-crac-", StringComparison.Ordinal)
                && !lower.Contains("_musl_", StringComparison.Ordinal);
        }

        private static bool HasZuluOrderingFields(JToken package)
        {
            return package["java_version"] is JArray { Count: > 0 }
                && package["distro_version"] is JArray { Count: > 0 }
                && !string.IsNullOrWhiteSpace(package["download_url"]?.ToString());
        }

        private static string ToComparableVersion(JArray? versionParts)
        {
            if (versionParts is null || versionParts.Count == 0)
            {
                return string.Empty;
            }

            return string.Join('.', versionParts.Select(part => $"{part.Value<int>():D8}"));
        }

        private static string BuildBmclapiUrl(int majorVersion)
        {
            _ = majorVersion;
            return "https://bmclapi2.bangbang93.com/java/list";
        }

        private async Task<JavaPackageInfo?> GetLatestFromBmclapiAsync(
            int majorVersion,
            JavaPlatform platform,
            JavaArchitecture architecture,
            JavaPackageType packageType)
        {
            try
            {
                var url = BuildBmclapiUrl(majorVersion);
                using var response = await _httpClient.GetAsync(url);
                if (response.StatusCode == System.Net.HttpStatusCode.Forbidden)
                {
                    // Capability probe result: the BMCLAPI Java list endpoint is currently blocked here,
                    // so this source cannot be confirmed usable and must be treated as unavailable.
                    return null;
                }

                if (!response.IsSuccessStatusCode)
                {
                    return null;
                }

                var json = await response.Content.ReadAsStringAsync();
                return ParseBmclapiResponse(json, majorVersion, platform, architecture, packageType);
            }
            catch
            {
                return null;
            }
        }

        private static JavaPackageInfo? ParseBmclapiResponse(
            string json,
            int majorVersion,
            JavaPlatform platform,
            JavaArchitecture architecture,
            JavaPackageType packageType)
        {
            _ = majorVersion;
            _ = platform;
            _ = architecture;
            _ = packageType;

            var token = JToken.Parse(json);
            var packages = token.Type switch
            {
                JTokenType.Array => token as JArray,
                JTokenType.Object => token["body"] as JArray,
                _ => null
            };

            if (packages is null)
            {
                return null;
            }

            var hasDocumentedShape = packages.Any(package =>
                !string.IsNullOrWhiteSpace(package?["title"]?.ToString())
                && !string.IsNullOrWhiteSpace(package["file"]?.ToString()));

            if (!hasDocumentedShape)
            {
                return null;
            }

            // The documented shape hints at title/file pairs, but the current public docs and
            // blocked endpoint response do not provide enough verified fields to confirm the
            // requested majorVersion/platform/architecture/packageType dimensions safely.
            return null;
        }
    }
}
