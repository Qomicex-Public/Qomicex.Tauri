using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Services;

public static class LicenseValidator
{
    private const string LicenseFileName = "license.qmcx";

    public static string LicenseFilePath =>
        Path.Combine(AppPaths.BaseDir, "QML", LicenseFileName);

    public static string LicensePassword(string machineCode) =>
        machineCode + "-qomicex-license";

#if LICENSE_REQUIRED
    private static Func<IHttpClientFactory, CancellationToken, Task<LicenseMetadata>>? _validateFunc;
    private static Func<string, IHttpClientFactory, Task<LicenseMetadata>>? _activateFunc;
#else
    private static Func<IHttpClientFactory, CancellationToken, Task<LicenseMetadata>>? _validateFunc;
    private static Func<string, IHttpClientFactory, Task<LicenseMetadata>>? _activateFunc;
#endif

    public static void Register(
        Func<IHttpClientFactory, CancellationToken, Task<LicenseMetadata>> validate,
        Func<string, IHttpClientFactory, Task<LicenseMetadata>> activate)
    {
        _validateFunc = validate;
        _activateFunc = activate;
    }

#if LICENSE_REQUIRED

    public static Task<LicenseMetadata> ValidateAsync(IHttpClientFactory httpFactory, CancellationToken ct = default)
    {
        if (_validateFunc == null)
            throw new InvalidOperationException("License core module not loaded. Ensure LicenseCore.Bootstrap is included in the build.");
        return _validateFunc(httpFactory, ct);
    }

    public static Task<LicenseMetadata> ActivateAsync(string licenseToken, IHttpClientFactory httpFactory)
    {
        if (_activateFunc == null)
            throw new InvalidOperationException("License core module not loaded. Ensure LicenseCore.Bootstrap is included in the build.");
        return _activateFunc(licenseToken, httpFactory);
    }
#else
    public static Task<LicenseMetadata> ValidateAsync(IHttpClientFactory httpFactory, CancellationToken ct = default)
        => Task.FromResult(LicenseMetadata.Empty);

    public static Task<LicenseMetadata> ActivateAsync(string licenseToken, IHttpClientFactory httpFactory)
        => Task.FromResult(LicenseMetadata.Empty);
#endif

    public static void SaveLicenseToken(string token)
    {
        var dir = Path.GetDirectoryName(LicenseFilePath)!;
        Directory.CreateDirectory(dir);
        File.WriteAllText(LicenseFilePath, token);
    }

    public static bool LicenseFileExists() => File.Exists(LicenseFilePath);
}
