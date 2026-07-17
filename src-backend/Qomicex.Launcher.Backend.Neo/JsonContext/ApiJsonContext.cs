using System.Text.Json.Serialization;
using Qomicex.Core.AOT.Models.Expansion.CurseForge;
using Qomicex.Core.AOT.Models.Expansion.Modrinth;
using Qomicex.Core.AOT.Models.Local;
using Qomicex.Core.AOT.Models.VersionManifest;
using Qomicex.Core.AOT.Public.Models;
using Qomicex.Launcher.Backend.Neo.Endpoints;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.JsonContext;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    WriteIndented = false,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(ApiError))]
[JsonSerializable(typeof(GameInstance))]
[JsonSerializable(typeof(List<GameInstance>))]
[JsonSerializable(typeof(AuthRequest))]
[JsonSerializable(typeof(AuthResponse))]
[JsonSerializable(typeof(CreateInstanceRequest))]
[JsonSerializable(typeof(UpdateInstanceRequest))]
[JsonSerializable(typeof(LaunchRequest))]
[JsonSerializable(typeof(ResourceCompleteRequest))]
[JsonSerializable(typeof(ProgressResponse))]
[JsonSerializable(typeof(CheckResourcesResponse))]
[JsonSerializable(typeof(MessageResponse))]
[JsonSerializable(typeof(ValidateResponse))]
// Core.AOT types
[JsonSerializable(typeof(LocalVersionInfo))]
[JsonSerializable(typeof(List<LocalVersionInfo>))]
[JsonSerializable(typeof(ManifestVersionInfo))]
[JsonSerializable(typeof(List<ManifestVersionInfo>))]
[JsonSerializable(typeof(LatestVersionInfo))]
[JsonSerializable(typeof(HealthResponse))]
[JsonSerializable(typeof(SystemInfoResponse))]
[JsonSerializable(typeof(SettingsResponse))]
[JsonSerializable(typeof(List<SettingsResponse>))]
[JsonSerializable(typeof(ScannedVersionEntry))]
[JsonSerializable(typeof(List<ScannedVersionEntry>))]
[JsonSerializable(typeof(ScanVersionsResponse))]
[JsonSerializable(typeof(CustomJavaEntryDto))]
[JsonSerializable(typeof(List<CustomJavaEntryDto>))]
[JsonSerializable(typeof(LaunchResultDto))]
[JsonSerializable(typeof(LaunchProgressDto))]
[JsonSerializable(typeof(InstallerRequest))]
[JsonSerializable(typeof(InstallProgressResponse))]
[JsonSerializable(typeof(ResourceSearchResponse))]
[JsonSerializable(typeof(ResourceItemDto))]
[JsonSerializable(typeof(List<ResourceItemDto>))]
[JsonSerializable(typeof(ResourceDetailDto))]
[JsonSerializable(typeof(ResourceVersionDto))]
[JsonSerializable(typeof(List<ResourceVersionDto>))]
[JsonSerializable(typeof(ResourceFileDto))]
[JsonSerializable(typeof(List<ResourceFileDto>))]
[JsonSerializable(typeof(ResourceDependencyDto))]
[JsonSerializable(typeof(List<ResourceDependencyDto>))]
[JsonSerializable(typeof(ResolvedDependencyDto))]
[JsonSerializable(typeof(List<ResolvedDependencyDto>))]
[JsonSerializable(typeof(CurseForgeVersionFetchStartResponse))]
[JsonSerializable(typeof(CurseForgeVersionFetchProgressResponse))]
[JsonSerializable(typeof(List<object>))]
// Loader endpoints
[JsonSerializable(typeof(LoaderVersionInfo))]
[JsonSerializable(typeof(List<LoaderVersionInfo>))]
[JsonSerializable(typeof(LoaderAddonInfo))]
[JsonSerializable(typeof(List<LoaderAddonInfo>))]
// Java DTOs
[JsonSerializable(typeof(JavaResult))]
[JsonSerializable(typeof(List<JavaResult>))]
// InstallTracker addon types
[JsonSerializable(typeof(ModrinthVersion))]
[JsonSerializable(typeof(List<ModrinthVersion>))]
[JsonSerializable(typeof(ModrinthVersion.ModrinthFile))]
[JsonSerializable(typeof(JavaDownloadVendorInfo))]
[JsonSerializable(typeof(JavaDownloadCatalogResponse))]
[JsonSerializable(typeof(JavaDownloadStartRequest))]
[JsonSerializable(typeof(JavaDownloadStartResponse))]
[JsonSerializable(typeof(JavaDownloadProgressResponse))]
[JsonSerializable(typeof(List<JavaDownloadProgressResponse>))]
[JsonSerializable(typeof(JavaPathRequest))]
[JsonSerializable(typeof(JavaRecommendRequest))]
[JsonSerializable(typeof(StoredJavaRuntime))]
[JsonSerializable(typeof(List<StoredJavaRuntime>))]
public sealed partial class ApiJsonContext : JsonSerializerContext
{
}

public sealed record HealthResponse(string Status, DateTime Timestamp);

public sealed record SystemInfoResponse(
    string Os, string Architecture, string Runtime, int ProcessorCount, string WorkingDirectory);

public sealed record AuthRequest(
    string Mode,
    string? Username = null,
    string? Password = null,
    string? AccessToken = null,
    string? ServerUrl = null,
    string? ClientId = null);

public sealed record AuthResponse(
    bool Success, string? Username, string? AccessToken, string? Uuid,
    string? UserType, string? ErrorMessage, string? RefreshToken = null,
    string? DeviceCode = null, string? UserCode = null, string? VerificationUri = null,
    int? Interval = null, int? ExpiresIn = null, bool? IsPending = null);

public sealed record CreateInstanceRequest(
    string Name, string GameVersion, string? Loader = null,
    string? LoaderVersion = null, string? JavaPath = null,
    int MaxMemory = 4096, string GameDir = ".minecraft");

public sealed record UpdateInstanceRequest(
    string? Name = null, string? GameVersion = null,
    string? Loader = null, string? LoaderVersion = null,
    string? JavaPath = null, int? MaxMemory = null,
    string? JvmArgs = null, bool? IsHidden = null,
    bool? VersionIsolation = null);

public sealed record LaunchRequest(
    string InstanceId, string VersionId, string JavaPath,
    int MaxMemory = 4096, string? JvmArgs = null,
    bool VersionIsolation = false, string? AuthUuid = null,
    string? AuthName = null, string? AuthToken = null,
    string? JoinServer = null, string? JoinWorld = null);

public sealed record ResourceCompleteRequest(
    string VersionId, bool CheckOnly = false);

public sealed record ProgressResponse(
    string TaskId, double Percentage, long Downloaded, long Total,
    string? CurrentFile = null, string? Status = null);

public sealed record CheckResourcesResponse(bool Complete, string VersionId);

public sealed record MessageResponse(string Message, string? VersionId = null);

public sealed record ValidateResponse(bool Valid);

public sealed record SettingsResponse(
    string GameDir,
    int DownloadThreads = 64,
    int? FileChunkThreads = null,
    int MaxConnectionsPerServer = 64,
    bool VersionIsolation = true,
    bool CloseAfterLaunch = false,
    string? MemoryMode = "auto",
    int DefaultMaxMemory = 4096,
    string JvmArgs = "",
    string Language = "zh-CN",
    string DefaultJavaPath = "",
    int DownloadSource = 0,
    bool? AutoSelectDownloadSource = null,
    int ModMirror = 0,
    bool? AutoSelectModMirror = null,
    int DownloadTimeout = 15,
    bool? AnimationsEnabled = null,
    int? AnimationSpeed = null,
    string? BackgroundImage = null,
    bool? BackgroundRandom = null,
    int? BgOverlayOpacity = null,
    int? BgBlur = null,
    bool? WatermarkEnabled = null,
    string? WatermarkText = null,
    string? WatermarkSubtext = null,
    List<string>? Directories = null,
    List<CustomJavaEntryDto>? CustomJavaRuntimes = null
);

public sealed record CustomJavaEntryDto(
    string Name, string Path, string Version, int VersionID,
    string Type, string Arch, string State
);

public sealed record LaunchResultDto(
    bool Success, int ProcessId, string? Error = null, string? Detail = null,
    string? Arguments = null, string? Stage = null,
    List<string>? MissingFiles = null, int? ExitCode = null,
    string? CrashReport = null
);

public sealed record LaunchProgressDto(
    string Stage, string Message, double Progress, bool IsRunning,
    int? ProcessId = null, int? ExitCode = null, string? Error = null,
    string? CrashReport = null, List<string>? MissingFiles = null,
    string? Arguments = null,
    string? CurrentFile = null, int TotalFiles = 0, int CompletedFiles = 0
);

public sealed record InstallerRequest(
    string? Loader = null,
    string? LoaderVersion = null,
    string[]? Addons = null,
    int? DownloadThreads = null,
    bool? VersionIsolation = null,
    int? DownloadSourceId = null,
    int? DownloadTimeout = null
);

public sealed record InstallProgressResponse(
    string InstanceId,
    string Status,
    double Progress,
    string? Error = null,
    int TotalFiles = 0,
    int CompletedFiles = 0,
    int FailedFiles = 0,
    string CurrentFile = "",
    double Speed = 0,
    bool IsPaused = false,
    string Stage = ""
);

// Resource center DTOs
public sealed record ResourceSearchResponse(
    List<ResourceItemDto> Items, int Total, int Page, int PageSize
);

public sealed record ResourceItemDto(
    string Id, string Title, string Description, string Author,
    string IconUrl, int DownloadCount, string Source,
    List<string> Categories, string ProjectUrl, string Slug,
    string? LatestVersion = null
);

public sealed record ResourceDetailDto(
    string Id, string Title, string Description, string Author,
    string IconUrl, int DownloadCount, string Source,
    List<string> Categories, string ProjectUrl, string Slug,
    string Body, string? LatestVersion = null
);

public sealed record ResourceVersionDto(
    string Id, string Name, string VersionNumber,
    List<string> GameVersions, List<string> Loaders,
    List<ResourceFileDto> Downloads,
    List<ResourceDependencyDto>? Dependencies = null,
    string? DatePublished = null
);

public sealed record ResourceFileDto(
    string Url, string FileName, long Size
);

public sealed record ResourceDependencyDto(
    string? VersionId, string ProjectId, string? FileName,
    string DependencyType
);

public sealed record ResolvedDependencyDto(
    string ProjectId, string Name, string IconUrl,
    string VersionId, string VersionNumber, string DownloadUrl,
    string FileName, string Category, string Source
);

public sealed record CurseForgeVersionFetchStartResponse(
    string TaskId, int TotalVersionCount, int LoadedVersionCount
);

public sealed record CurseForgeVersionFetchProgressResponse(
    int LoadedVersionCount, int TotalVersionCount, bool Done
);

// Loader endpoints DTOs
public sealed record LoaderVersionInfo(
    int Type,
    string Version,
    string MinecraftVersion,
    string DownloadUrl,
    string Sha1,
    bool IsRecommended,
    string? PublishedAt
);

public sealed record LoaderAddonInfo(
    string Id,
    string Label,
    bool Recommended,
    string Description,
    string IconUrl,
    string ProjectUrl,
    int Downloads
);
