namespace Qomicex.Launcher.Backend.Neo.Common;

public static class AppPaths
{
    private static readonly string AppDataRoot =
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    private static string DefaultDir => Path.Combine(AppDataRoot, "qomicex-launcher");
    private static string BootstrapFile => Path.Combine(DefaultDir, ".qomicex-bootstrap");

    public static string BaseDir { get; } = ResolveBaseDir();

    private static string ResolveBaseDir()
    {
        var env = Environment.GetEnvironmentVariable("QOMICEX_HOME");
        if (!string.IsNullOrEmpty(env)) return env;

        if (File.Exists(BootstrapFile))
        {
            var customDir = File.ReadAllText(BootstrapFile).Trim();
            if (!string.IsNullOrEmpty(customDir))
                return customDir;
        }

        return DefaultDir;
    }

    public static void SetBaseDir(string path)
    {
        Directory.CreateDirectory(DefaultDir);
        File.WriteAllText(BootstrapFile, path);
    }
}
