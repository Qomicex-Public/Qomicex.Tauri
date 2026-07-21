namespace Qomicex.Launcher.Backend.Neo.Models;

public sealed record LicenseStatusResponse(
    bool Valid,
    string? MachineCode = null,
    string? LicenseId = null,
    string? Channel = null,
    string? ExpireAt = null,
    bool IsPermanent = false,
    string? Error = null
);

public sealed record LicenseActivateRequest(
    string LicenseToken
);

public sealed record LicenseActivateResponse(
    bool Success,
    string? LicenseId = null,
    string? Channel = null,
    string? ExpireAt = null,
    bool IsPermanent = false,
    string? Error = null
);

public sealed record PublicKeyResponse(
    string PublicKey
);

public sealed record LicenseMetadata(
    string LicenseId,
    string Channel,
    string ExpireAt,
    bool IsPermanent
)
{
    public static readonly LicenseMetadata Empty = new("", "", "", false);
}
