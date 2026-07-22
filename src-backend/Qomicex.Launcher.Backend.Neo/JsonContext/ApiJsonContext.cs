using System.Text.Json.Serialization;
using Qomicex.Core.AOT.Models.Expansion.CurseForge;
using Qomicex.Core.AOT.Models.Expansion.Local;
using Qomicex.Core.AOT.Models.Expansion.Modrinth;
using Qomicex.Core.AOT.Models.Local;
using Qomicex.Core.AOT.Models.VersionManifest;
using Qomicex.Core.AOT.Public.Models;
using Qomicex.Core.AOT.Services.Options;
using Qomicex.Launcher.Backend.Neo.Endpoints;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;
using Qomicex.Launcher.Backend.Neo.Services.Connector;

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
[JsonSerializable(typeof(DiagnosticsHealthResponse))]
[JsonSerializable(typeof(PingResult))]
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
// Version manifest
[JsonSerializable(typeof(VersionManifestRoot))]
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
// Open folder/logs
[JsonSerializable(typeof(OpenPathRequest))]
// SSE progress
[JsonSerializable(typeof(ProgressSsePayload))]
[JsonSerializable(typeof(ProgressSseSummary))]
[JsonSerializable(typeof(List<StoredJavaRuntime>))]
// Account types
[JsonSerializable(typeof(StoredAccount))]
[JsonSerializable(typeof(List<StoredAccount>))]
[JsonSerializable(typeof(AccountInfo))]
[JsonSerializable(typeof(List<AccountInfo>))]
[JsonSerializable(typeof(Dictionary<string, string>))]
[JsonSerializable(typeof(SkinProfile))]
[JsonSerializable(typeof(MicrosoftInfoRequest))]
[JsonSerializable(typeof(TongyiLoginRequest))]
[JsonSerializable(typeof(MicrosoftRefreshRequest))]
[JsonSerializable(typeof(YggdrasilMetaResponse))]
[JsonSerializable(typeof(OfflineUuidResponse))]
[JsonSerializable(typeof(LostResponse))]
[JsonSerializable(typeof(MicrosoftRefreshResponse))]
[JsonSerializable(typeof(OpenPathResponse))]
[JsonSerializable(typeof(List<string>))]
[JsonSerializable(typeof(DownloadSourcePing))]
[JsonSerializable(typeof(List<DownloadSourcePing>))]
[JsonSerializable(typeof(ModSourcePing))]
[JsonSerializable(typeof(List<ModSourcePing>))]
[JsonSerializable(typeof(YggdrasilProfileInfo))]
[JsonSerializable(typeof(List<YggdrasilProfileInfo>))]
[JsonSerializable(typeof(YggdrasilProfilesResponse))]
[JsonSerializable(typeof(YggdrasilSelectRequest))]
[JsonSerializable(typeof(CnNameResponse))]
[JsonSerializable(typeof(TranslateResponse))]
// Connector DTOs
[JsonSerializable(typeof(ConnectorPlayerDto))]
[JsonSerializable(typeof(List<ConnectorPlayerDto>))]
[JsonSerializable(typeof(ConnectorStatusDto))]
[JsonSerializable(typeof(GameInfoDto))]
[JsonSerializable(typeof(EasyTierDownloadStatus))]
[JsonSerializable(typeof(HostResponse))]
[JsonSerializable(typeof(JoinResponse))]
[JsonSerializable(typeof(StatusResponse))]
[JsonSerializable(typeof(ScanPortsResponse))]
[JsonSerializable(typeof(AutoSelectResponse))]
[JsonSerializable(typeof(HostByPortRequest))]
[JsonSerializable(typeof(HostByInstanceRequest))]
[JsonSerializable(typeof(JoinRequest))]
// Instance files — Local resource types (Core.AOT)
[JsonSerializable(typeof(ModInfo))]
[JsonSerializable(typeof(List<ModInfo>))]
[JsonSerializable(typeof(SaveInfo))]
[JsonSerializable(typeof(List<SaveInfo>))]
[JsonSerializable(typeof(ResourcePackInfo))]
[JsonSerializable(typeof(List<ResourcePackInfo>))]
[JsonSerializable(typeof(ShaderInfo))]
[JsonSerializable(typeof(List<ShaderInfo>))]
[JsonSerializable(typeof(ScreenshotInfo))]
[JsonSerializable(typeof(List<ScreenshotInfo>))]
[JsonSerializable(typeof(DataPackInfo))]
[JsonSerializable(typeof(List<DataPackInfo>))]
// Instance files — Server & Options types (Core.AOT)
[JsonSerializable(typeof(ServerEntry))]
[JsonSerializable(typeof(List<ServerEntry>))]
[JsonSerializable(typeof(ServerState))]
[JsonSerializable(typeof(LanServerEntry))]
[JsonSerializable(typeof(List<LanServerEntry>))]
[JsonSerializable(typeof(OptionViewItem))]
[JsonSerializable(typeof(List<OptionViewItem>))]
[JsonSerializable(typeof(OptionDefinition))]
// Instance files — Request DTOs
[JsonSerializable(typeof(FileOperationRequest))]
[JsonSerializable(typeof(BatchFileRequest))]
[JsonSerializable(typeof(SaveCopyRequestDto))]
[JsonSerializable(typeof(SaveRenameRequestDto))]
[JsonSerializable(typeof(SetOptionRequest))]
[JsonSerializable(typeof(AddServerRequest))]
// Resource download
[JsonSerializable(typeof(ResourceDownloadEndpoints.StartDownloadRequest))]
[JsonSerializable(typeof(ResourceDownloadEndpoints.CancelBatchRequest))]
[JsonSerializable(typeof(ResourceDownloadEndpoints.DownloadStartResponse))]
[JsonSerializable(typeof(ResourceDownloadEndpoints.StatusResponse), TypeInfoPropertyName = "ResourceDownloadStatusResponse")]
[JsonSerializable(typeof(ResourceDownloadEndpoints.DownloadProgressResponse))]
[JsonSerializable(typeof(ResourceDownloadEndpoints.DownloadToRequest))]
[JsonSerializable(typeof(ResourceDownloadEndpoints.DownloadToResponse))]
[JsonSerializable(typeof(JavaRequirementResponse))]
[JsonSerializable(typeof(ModLoadProgress))]
// Instance files — Response DTOs
[JsonSerializable(typeof(FileEntryDto))]
[JsonSerializable(typeof(List<FileEntryDto>))]
[JsonSerializable(typeof(ModMetadataDto))]
[JsonSerializable(typeof(List<ModMetadataDto>))]
[JsonSerializable(typeof(ResourcePackMetadataDto))]
[JsonSerializable(typeof(List<ResourcePackMetadataDto>))]
[JsonSerializable(typeof(ShaderMetadataDto))]
[JsonSerializable(typeof(List<ShaderMetadataDto>))]
[JsonSerializable(typeof(DataPackMetadataDto))]
[JsonSerializable(typeof(List<DataPackMetadataDto>))]
[JsonSerializable(typeof(ScreenshotMetadataDto))]
[JsonSerializable(typeof(List<ScreenshotMetadataDto>))]
[JsonSerializable(typeof(SaveMetadataDto))]
[JsonSerializable(typeof(List<SaveMetadataDto>))]
[JsonSerializable(typeof(OldServerEntryDto))]
[JsonSerializable(typeof(List<OldServerEntryDto>))]
[JsonSerializable(typeof(ServerStateResultDto))]
[JsonSerializable(typeof(Dictionary<string, int>))]
[JsonSerializable(typeof(LicenseStatusResponse))]
[JsonSerializable(typeof(LicenseActivateRequest))]
[JsonSerializable(typeof(LicenseActivateResponse))]
[JsonSerializable(typeof(PublicKeyResponse))]
public sealed partial class ApiJsonContext : JsonSerializerContext
{
}

public sealed record HealthResponse(string Status, DateTime Timestamp);
public sealed record PingResult(bool Ok, long Latency);
public sealed record DiagnosticsHealthResponse(bool Backend, PingResult Modrinth, PingResult Curseforge);

public sealed record SystemInfoResponse(
    string Os, string Architecture, string OsName, string OsVersion,
    string OsVersionId, string OsDisplayName, string GitCommit,
    long Memory, long AvailableMemory);

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
    string FileName, string Category, string Source,
    string? CurseForgeId = null, string? ModrinthId = null
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

public sealed record OpenPathRequest(string Path);

public sealed record LoaderAddonInfo(
    string Id,
    string Label,
    bool Recommended,
    string Description,
    string IconUrl,
    string ProjectUrl,
    int Downloads
);

public sealed record MicrosoftInfoRequest(string AccessToken, string RefreshToken);
public sealed record TongyiLoginRequest(string ServerId, string Email, string Password);
public sealed record MicrosoftRefreshRequest(string AccountUuid);
public sealed record YggdrasilMetaResponse(string ServerName);
public sealed record OfflineUuidResponse(string Uuid);
public sealed record LostResponse(bool Lost);
public sealed record MicrosoftRefreshResponse(bool Success, bool? NeedReauth, string? Error);
public sealed record OpenPathResponse(string Path);

public sealed record DownloadSourcePing(int Id, string Name, string Url, long LatencyMs, bool Available);
public sealed record ModSourcePing(int Id, string Name, string ModrinthUrl, bool ModrinthOk, long ModrinthLatency, bool Available);

public sealed record YggdrasilProfileInfo(string Id, string Name);
public sealed record YggdrasilProfilesResponse(
    bool Success, string? AccessToken, string? ClientToken,
    List<YggdrasilProfileInfo>? Profiles, string? ErrorMessage = null);
public sealed record YggdrasilSelectRequest(
    string AccessToken, string ClientToken, string ServerUrl, List<YggdrasilProfileInfo> SelectedProfiles);

public sealed record TranslateResponse(string? Original, string? Translated, string? TranslatedAt);
public sealed record AutoSelectResponse(int Id, long LatencyMs);
