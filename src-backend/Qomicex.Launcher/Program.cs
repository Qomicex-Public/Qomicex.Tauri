using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;

var exeDir = Path.GetDirectoryName(Environment.ProcessPath)!;
var runtimeDir = Path.Combine(exeDir, "QML", "Runtime");
var dataDir = Path.Combine(exeDir, "QML", "Data");
var versionFile = Path.Combine(runtimeDir, ".version");
var logFile = Path.Combine(exeDir, "QML", "launcher.log");

var currentVersion = Assembly.GetExecutingAssembly()
    .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";

try
{
    if (!File.Exists(versionFile) || File.ReadAllText(versionFile).Trim() != currentVersion)
    {
        if (Directory.Exists(runtimeDir))
            Directory.Delete(runtimeDir, true);
        Directory.CreateDirectory(runtimeDir);

        using var stream = Assembly.GetExecutingAssembly()
            .GetManifestResourceStream("Qomicex.Launcher.Resources.runtime.zip");
        if (stream == null)
            throw new FileNotFoundException("runtime.zip not found in embedded resources");

        using var archive = new ZipArchive(stream);
        foreach (var entry in archive.Entries)
        {
            var dest = Path.Combine(runtimeDir, entry.FullName);
            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(dest);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            entry.ExtractToFile(dest, true);
        }

        File.WriteAllText(versionFile, currentVersion);
    }

    Directory.CreateDirectory(dataDir);

    var backendPath = Path.Combine(runtimeDir, "backend.exe");
    var backendProcess = new Process
    {
        StartInfo = new ProcessStartInfo
        {
            FileName = backendPath,
            UseShellExecute = false,
            CreateNoWindow = true,
        }
    };
    backendProcess.StartInfo.EnvironmentVariables["QOMICEX_HOME"] = dataDir;
    backendProcess.Start();

    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
    var healthUrl = "http://localhost:5000/api/diagnostics/health";
    var started = false;
    for (int i = 0; i < 60; i++)
    {
        try
        {
            var resp = await http.GetAsync(healthUrl);
            if (resp.IsSuccessStatusCode)
            {
                started = true;
                break;
            }
        }
        catch { }
        await Task.Delay(500);
    }

    if (!started)
    {
        backendProcess.Kill();
        await backendProcess.WaitForExitAsync();
        throw new Exception("Backend failed to start within 30s");
    }

    var frontendPath = Path.Combine(runtimeDir, "qomicex-launcher.exe");
    var frontendProcess = new Process
    {
        StartInfo = new ProcessStartInfo
        {
            FileName = frontendPath,
            UseShellExecute = false,
        }
    };
    frontendProcess.StartInfo.EnvironmentVariables["QOMICEX_HOME"] = dataDir;
    frontendProcess.StartInfo.EnvironmentVariables["QOMICEX_LAUNCHER_MANAGED"] = "1";
    frontendProcess.Start();

    await frontendProcess.WaitForExitAsync();

    if (!backendProcess.HasExited)
    {
        backendProcess.Kill();
        await backendProcess.WaitForExitAsync();
    }
}
catch (Exception ex)
{
    File.AppendAllText(logFile, $"[{DateTime.UtcNow:O}] {ex}\n");
    return 1;
}

return 0;
