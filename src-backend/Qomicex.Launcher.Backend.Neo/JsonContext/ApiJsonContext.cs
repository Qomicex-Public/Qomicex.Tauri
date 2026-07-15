using System.Text.Json.Serialization;
using Qomicex.Core.AOT.Models.Local;
using Qomicex.Core.AOT.Models.VersionManifest;
using Qomicex.Core.AOT.Public.Models;
using Qomicex.Launcher.Backend.Neo.Models;

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
[JsonSerializable(typeof(LaunchResult))]
[JsonSerializable(typeof(LocalVersionInfo))]
[JsonSerializable(typeof(List<LocalVersionInfo>))]
[JsonSerializable(typeof(ManifestVersionInfo))]
[JsonSerializable(typeof(List<ManifestVersionInfo>))]
[JsonSerializable(typeof(LatestVersionInfo))]
[JsonSerializable(typeof(HealthResponse))]
[JsonSerializable(typeof(SystemInfoResponse))]
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
