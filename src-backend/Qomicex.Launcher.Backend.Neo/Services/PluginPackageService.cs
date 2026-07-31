using System.IO.Compression;
using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Services;

public class PluginPackageService
{
    private readonly string _pluginsDir;

    public PluginPackageService()
    {
        _pluginsDir = AppPaths.PluginsDir;
        Directory.CreateDirectory(_pluginsDir);
    }

    public PluginInfo? InstallFromPackage(Stream packageStream)
    {
        using var archive = new ZipArchive(packageStream, ZipArchiveMode.Read);

        var manifestEntry = archive.GetEntry("manifest.json");
        if (manifestEntry == null) return null;

        using var reader = new StreamReader(manifestEntry.Open());
        var manifestJson = reader.ReadToEnd();
        var manifest = JsonSerializer.Deserialize(manifestJson, ApiJsonContext.Default.PluginManifest);
        if (manifest == null) return null;

        var targetDir = Path.Combine(_pluginsDir, manifest.Id);
        if (Directory.Exists(targetDir))
            Directory.Delete(targetDir, recursive: true);
        Directory.CreateDirectory(targetDir);

        foreach (var entry in archive.Entries)
        {
            if (entry.FullName.EndsWith("/")) continue;
            var filePath = Path.Combine(targetDir, entry.FullName);
            var fileDir = Path.GetDirectoryName(filePath);
            if (fileDir != null) Directory.CreateDirectory(fileDir);
            entry.ExtractToFile(filePath, overwrite: true);
        }

        return new PluginInfo
        {
            Manifest = manifest,
            Dir = targetDir,
            State = "installed",
            InstalledAt = DateTime.UtcNow.ToString("O")
        };
    }
}
