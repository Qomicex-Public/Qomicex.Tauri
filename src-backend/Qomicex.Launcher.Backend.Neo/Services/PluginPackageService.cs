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

    public async Task<PluginInfo?> InstallFromPackage(Stream packageStream)
    {
        using var archive = new ZipArchive(packageStream, ZipArchiveMode.Read);

        var manifestEntry = archive.GetEntry("manifest.json");
        if (manifestEntry == null) return null;

        using var reader = new StreamReader(manifestEntry.Open());
        var manifestJson = reader.ReadToEnd();
        var manifest = JsonSerializer.Deserialize(manifestJson, ApiJsonContext.Default.PluginManifest);
        if (manifest == null) return null;

        var targetDir = Path.Combine(_pluginsDir, manifest.Id);

        // 先解压到同分区临时目录，再原子替换正式目录，避免重装/目录被占用时强删失败
        var tempDir = Path.Combine(_pluginsDir, $".{manifest.Id}.tmp-{Guid.NewGuid():N}");
        var moved = false;
        try
        {
            Directory.CreateDirectory(tempDir);
            foreach (var entry in archive.Entries)
            {
                if (entry.FullName.EndsWith("/")) continue;
                var filePath = Path.Combine(tempDir, entry.FullName);
                var fileDir = Path.GetDirectoryName(filePath);
                if (fileDir != null) Directory.CreateDirectory(fileDir);
                entry.ExtractToFile(filePath, overwrite: true);
            }

            await DeleteRecursivelyWithRetry(targetDir);
            Directory.Move(tempDir, targetDir);
            moved = true;
        }
        finally
        {
            // 仅清理未成功移动的临时目录；成功移动后 tempDir 已不存在于原路径
            if (!moved && Directory.Exists(tempDir)) { try { Directory.Delete(tempDir, true); } catch { } }
        }

        return new PluginInfo
        {
            Manifest = manifest,
            Dir = targetDir,
            State = "installed",
            InstalledAt = DateTime.UtcNow.ToString("O")
        };
    }

    /// <summary>带重试的递归删除，容忍目录刚被后台上锁/占用导致的瞬时 IOException。</summary>
    private static async Task DeleteRecursivelyWithRetry(string dir)
    {
        if (!Directory.Exists(dir)) return;
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                Directory.Delete(dir, recursive: true);
                return;
            }
            catch (IOException) when (attempt < 4)
            {
                await Task.Delay(200 * (attempt + 1));
            }
        }
    }
}