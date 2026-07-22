using Microsoft.AspNetCore.Http.HttpResults;
using System.Text.Json;
using Qomicex.Core.AOT.Core;
using Qomicex.Core.AOT.JsonContext;
using Qomicex.Core.AOT.Models.VersionManifest;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public sealed record ScannedVersionEntry(string Name, string GameVersion, string State, string StateDescribe, List<ScannedLoaderEntry>? Loaders);
public sealed record ScannedLoaderEntry(string Type, string Version);
public sealed record ScanVersionsResponse(string Path, List<ScannedVersionEntry> Versions, List<string> NoJsonDirs);

public static class VersionEndpoints
{
    private static List<ScannedLoaderEntry> DetectLoaders(JsonElement root, string? mainClass, string id, string? inheritsFrom)
    {
        var loaders = new List<ScannedLoaderEntry>();
        string? fabricVer = null, quiltVer = null, forgeVer = null, neoForgeVer = null, liteVer = null, optiVer = null;

        if (root.TryGetProperty("libraries", out var libsEl) && libsEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var lib in libsEl.EnumerateArray())
            {
                var libName = lib.TryGetProperty("name", out var lnEl) ? lnEl.GetString() : "";
                if (string.IsNullOrEmpty(libName)) continue;
                var lower = libName.ToLowerInvariant();
                var parts = libName.Split(':');

                if (fabricVer == null && parts.Length >= 3 && (parts[1] == "fabric" || parts[1] == "fabric-loader"))
                    fabricVer = parts[2];

                if (quiltVer == null && parts.Length >= 3 && (parts[1] == "quilt" || parts[1] == "quilt-loader"))
                    quiltVer = parts[2];

                if (liteVer == null && parts.Length >= 3 && parts[1] == "liteloader")
                    liteVer = parts[2];

                if (optiVer == null && parts.Length >= 3 && parts[1] == "optifine")
                    optiVer = parts[2];

                if (forgeVer == null && parts.Length >= 3 && parts[1] == "fmlloader")
                {
                    var ver = parts[2].Split('-');
                    forgeVer = ver.Length >= 2 ? ver[1] : parts[2];
                }

                if (neoForgeVer == null && parts.Length >= 3 && parts[1] == "neoforge")
                    neoForgeVer = parts[2];
            }
        }

        if (root.TryGetProperty("arguments", out var argsEl) && argsEl.TryGetProperty("game", out var gameEl) && gameEl.ValueKind == JsonValueKind.Array)
        {
            string? prev = null;
            foreach (var item in gameEl.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String) { prev = null; continue; }
                var s = item.GetString();
                if (prev == "--fml.neoForgeVersion" && s != null && !s.StartsWith("--"))
                    { if (neoForgeVer == null) neoForgeVer = s; break; }
                if (prev == "--fml.forgeVersion" && s != null && !s.StartsWith("--"))
                    { if (forgeVer == null) forgeVer = s; break; }
                prev = s;
            }
        }

        if (fabricVer != null) loaders.Add(new ScannedLoaderEntry("Fabric", fabricVer));
        if (quiltVer != null) loaders.Add(new ScannedLoaderEntry("Quilt", quiltVer));
        if (liteVer != null) loaders.Add(new ScannedLoaderEntry("LiteLoader", liteVer));
        if (optiVer != null) loaders.Add(new ScannedLoaderEntry("OptiFine", optiVer));
        if (forgeVer != null) loaders.Add(new ScannedLoaderEntry("Forge", forgeVer));
        if (neoForgeVer != null) loaders.Add(new ScannedLoaderEntry("NeoForge", neoForgeVer));

        if (loaders.Count == 0 && mainClass != null)
        {
            var mc = mainClass.ToLowerInvariant();
            if (mc.Contains("fabricmc")) loaders.Add(new ScannedLoaderEntry("Fabric", ""));
            else if (mc.Contains("quiltmc")) loaders.Add(new ScannedLoaderEntry("Quilt", ""));
            else if (mc.Contains("neoforge") || mc.Contains("cpw.mods")) loaders.Add(new ScannedLoaderEntry("NeoForge", ""));
            else if (mc.Contains("minecraftforge") || mc.Contains("forge")) loaders.Add(new ScannedLoaderEntry("Forge", ""));
        }

        if (loaders.Count == 0 && inheritsFrom != null && inheritsFrom != id)
        {
            var guess = id.Contains("-forge-", StringComparison.OrdinalIgnoreCase) ? "Forge"
                : id.Contains("-fabric-", StringComparison.OrdinalIgnoreCase) ? "Fabric"
                : id.Contains("-quilt-", StringComparison.OrdinalIgnoreCase) ? "Quilt"
                : id.Contains("-neoforge-", StringComparison.OrdinalIgnoreCase) ? "NeoForge"
                : null;
            if (guess != null)
                loaders.Add(new ScannedLoaderEntry(guess, id));
        }

        return loaders;
    }

    public static void MapVersionEndpoints(this WebApplication app, DefaultGameCore core)
    {
        var group = app.MapGroup("/api/versions");

        group.MapGet("/", async (bool? forceRefresh) =>
        {
            var versions = await core.Version.GetAvailableVersionsAsync(forceRefresh ?? false);
            return Results.Json(versions, ApiJsonContext.Default.ListManifestVersionInfo);
        });

        group.MapGet("/latest", async (bool? forceRefresh) =>
        {
            var latest = await core.Version.GetLatestVersionsAsync(forceRefresh ?? false);
            return Results.Json(latest, ApiJsonContext.Default.LatestVersionInfo);
        });

        group.MapGet("/installed", () =>
        {
            var installed = core.Version.GetInstalledVersions();
            return Results.Json(installed, ApiJsonContext.Default.ListLocalVersionInfo);
        });

        group.MapGet("/remote", async (int? source) =>
        {
            try
            {
                var versions = await core.Version.GetAvailableVersionsAsync(false);
                return Results.Json(versions, ApiJsonContext.Default.ListManifestVersionInfo);
            }
            catch
            {
                return Results.Json(new List<ManifestVersionInfo>(), ApiJsonContext.Default.ListManifestVersionInfo);
            }
        });

        group.MapGet("/scan", (string gameDir, ILogger<Program> logger) =>
        {
            var result = new List<ScannedVersionEntry>();
            string absDir;
            try
            {
                absDir = Path.GetFullPath(gameDir);
                var versionsDir = Path.Combine(absDir, "versions");

                logger.LogInformation("Scan: gameDir={GameDir}, absDir={AbsDir}, versionsDir={VersionsDir}, versionsExists={Exists}",
                    gameDir, absDir, versionsDir, Directory.Exists(versionsDir));

                if (Directory.Exists(versionsDir))
                {
                    foreach (var dir in Directory.EnumerateDirectories(versionsDir))
                    {
                        var name = Path.GetFileName(dir);
                        var jsonPath = Path.Combine(dir, $"{name}.json");
                        if (!File.Exists(jsonPath))
                        {
                            result.Add(new ScannedVersionEntry(name, name, "Corrupted", "版本文件缺失", null));
                            continue;
                        }

                        try
                        {
                            using var doc = JsonDocument.Parse(File.ReadAllBytes(jsonPath));
                            var root = doc.RootElement;

                            var id = root.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? name : name;
                            var inheritsFrom = root.TryGetProperty("inheritsFrom", out var infEl) ? infEl.GetString() : null;
                            var mcVersion = root.TryGetProperty("minecraftVersion", out var mcEl) ? mcEl.GetString() : null;
                            var gameVersion = mcVersion ?? inheritsFrom ?? id;
                            var mainClass = root.TryGetProperty("mainClass", out var mcEl2) ? mcEl2.GetString() : "";

                            var loaders = DetectLoaders(root, mainClass, id, inheritsFrom);
                            result.Add(new ScannedVersionEntry(id, gameVersion, "Available", "", loaders.Count > 0 ? loaders : null));
                        }
                        catch (Exception ex) { logger.LogWarning(ex, "Scan: failed to parse {Name}", name); }
                    }

                    logger.LogInformation("Scan: found {Count} versions", result.Count);
                }

                return Results.Json(new ScanVersionsResponse(absDir, result, new List<string>()), ApiJsonContext.Default.ScanVersionsResponse);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Scan: unexpected error for {GameDir}", gameDir);
                absDir = gameDir;
                return Results.Json(new ScanVersionsResponse(absDir, result, new List<string>()), ApiJsonContext.Default.ScanVersionsResponse);
            }
        });

        group.MapGet("/{name}", async (string name) =>
        {
            var metadata = await core.Version.GetVersionMetadataAsync(name);
            return Results.Json(metadata, CombinedJsonContext.Default.CompleteVersionMetadata);
        });

        group.MapPost("/{name}/install", async (string name) =>
        {
            await core.Version.InstallVersionAsync(name);
            return Results.Json(new MessageResponse($"Installing version {name}", name), ApiJsonContext.Default.MessageResponse);
        });

        group.MapPost("/{name}/uninstall", async (string name) =>
        {
            if (!core.Version.IsVersionInstalled(name))
                throw new Qomicex.Core.AOT.Exceptions.VersionNotFoundException($"Version {name} is not installed");
            await core.Version.UninstallVersionAsync(name);
            return Results.Json(new MessageResponse($"Uninstalled version {name}"), ApiJsonContext.Default.MessageResponse);
        });
    }
}
