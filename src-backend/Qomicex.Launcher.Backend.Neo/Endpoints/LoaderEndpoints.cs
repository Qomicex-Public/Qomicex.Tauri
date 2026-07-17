using Microsoft.AspNetCore.Http.HttpResults;
using Qomicex.Core.AOT.Builder;
using Qomicex.Core.AOT.Core;
using Qomicex.Core.AOT.Public.Expansion;
using Qomicex.Core.AOT.Public.Models;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class LoaderEndpoints
{
    public static void MapLoaderEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/loaders");

        group.MapGet("/versions", async (DefaultGameCore core, string gameVersion, string loader = "All") =>
        {
            if (string.IsNullOrWhiteSpace(gameVersion))
                throw ApiException.BadRequest("gameVersion is required", "LOADER_VERSION_MISSING_GAME_VERSION");

            ModLoaderType loaderType;
            try
            {
                loaderType = Enum.Parse<ModLoaderType>(loader, ignoreCase: true);
            }
            catch
            {
                throw ApiException.BadRequest($"Invalid loader: {loader}", "LOADER_VERSION_INVALID_LOADER");
            }

            if (core.InstallerProvider is null)
                return Results.Json(new List<LoaderVersionInfo>(), ApiJsonContext.Default.ListLoaderVersionInfo);

            var results = await core.InstallerProvider.GetAvailableModLoaders(gameVersion, loaderType);

            var infos = results.Select(r => new LoaderVersionInfo(
                Type: (int)r.Type,
                Version: r.Version,
                MinecraftVersion: r.GameVersion,
                DownloadUrl: r.Url,
                Sha1: r.Sha1,
                IsRecommended: r.isRecommand,
                PublishedAt: r.ReleaseTime.UtcDateTime.ToString("o")
            )).ToList();

            return Results.Json(infos, ApiJsonContext.Default.ListLoaderVersionInfo);
        });

        group.MapGet("/addons", async (DefaultGameCore core, string loader, string? gameVersion) =>
        {
            var result = new List<LoaderAddonInfo>();

            if (string.Equals(loader, "Forge", StringComparison.OrdinalIgnoreCase) && core.InstallerProvider is not null)
            {
                if (!string.IsNullOrWhiteSpace(gameVersion))
                {
                    try
                    {
                        var optifineVersions = await core.InstallerProvider.GetAvailableModLoaders(gameVersion, ModLoaderType.OptiFine);
                        if (optifineVersions.Count > 0)
                        {
                            var latest = optifineVersions.OrderByDescending(x => x.Version).First();
                            result.Add(new LoaderAddonInfo(
                                Id: "optifine",
                                Label: "OptiFine",
                                Recommended: latest.isRecommand,
                                Description: "Minecraft 性能优化与光影支持，提升 FPS 并支持光影着色器",
                                IconUrl: "https://optifine.net/favicon.ico",
                                ProjectUrl: latest.Url,
                                Downloads: 0
                            ));
                        }
                    }
                    catch { }
                }
            }

            var modrinthSource = core.CreateModrinthSource();
            if (string.Equals(loader, "Fabric", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    var info = await modrinthSource.GetProjectInfoAsync("fabric-api");
                    if (info != null)
                    {
                        result.Add(new LoaderAddonInfo(
                            Id: "fabric-api",
                            Label: info.Name,
                            Recommended: true,
                            Description: info.Description,
                            IconUrl: info.IconUrl ?? "",
                            ProjectUrl: $"https://modrinth.com/mod/fabric-api",
                            Downloads: info.DownloadCount
                        ));
                    }
                }
                catch { }
            }

            if (string.Equals(loader, "Quilt", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    var info = await modrinthSource.GetProjectInfoAsync("qsl");
                    if (info != null)
                    {
                        result.Add(new LoaderAddonInfo(
                            Id: "qsl",
                            Label: info.Name,
                            Recommended: true,
                            Description: info.Description,
                            IconUrl: info.IconUrl ?? "",
                            ProjectUrl: $"https://modrinth.com/mod/qsl",
                            Downloads: info.DownloadCount
                        ));
                    }
                }
                catch { }
            }

            return Results.Json(result, ApiJsonContext.Default.ListLoaderAddonInfo);
        });
    }
}
