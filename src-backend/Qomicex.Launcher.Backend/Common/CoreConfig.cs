namespace Qomicex.Launcher.Backend;

public static class CoreConfig
{
    public static string UserAgent { get; set; } = "QomicexLauncher/1.0";
    public static int MaxConnectionsPerServer { get; set; } = 64;
}
