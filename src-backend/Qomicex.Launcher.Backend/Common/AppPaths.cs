namespace Qomicex.Launcher.Backend;

public static class AppPaths
{
    private static readonly string AppDataRoot =
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    public static string BaseDir { get; } =
        Environment.GetEnvironmentVariable("QOMICEX_HOME")
        ?? Path.Combine(AppDataRoot, "qomicex-launcher");
}
