namespace Qomicex.Launcher.Backend;

public static class AppPaths
{
    public static string BaseDir { get; } =
        Environment.GetEnvironmentVariable("QOMICEX_HOME") ?? AppContext.BaseDirectory;
}
