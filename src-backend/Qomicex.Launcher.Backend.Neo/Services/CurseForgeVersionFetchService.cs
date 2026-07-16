using System.Collections.Concurrent;
using Qomicex.Core.AOT.Models.Expansion.CurseForge;
using Qomicex.Core.AOT.Public.Expansion;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Services;

public sealed class CurseForgeVersionFetchService
{
    private readonly ConcurrentDictionary<string, FetchState> _states = new();

    public string Start(string modId, string? gameVersion, string? loader,
        ICurseForgeSource cf, ILogger log, int maxConcurrency = 5)
    {
        var taskId = Guid.NewGuid().ToString();
        var normalizedLoader = loader?.Trim().ToLowerInvariant();

        var state = new FetchState();
        _states[taskId] = state;

        Task.Run(async () =>
        {
            try
            {
                var info = await cf.GetModInfoAsync(modId);
                var files = info.Files ?? [];
                var parsed = files
                    .Select(f => ParseCfFile(modId, f))
                    .Where(f => MatchVersionLoader(f, gameVersion, normalizedLoader))
                    .ToList();

                state.Results.AddRange(parsed);
                state.LoadedVersionCount = parsed.Count;
                state.TotalVersionCount = parsed.Count;
                state.Done = true;
            }
            catch (Exception ex)
            {
                log.LogWarning("CurseForge version fetch failed for {ModId}: {Error}", modId, ex.Message);
                state.Error = ex.Message;
                state.TotalVersionCount = state.LoadedVersionCount;
                state.Done = true;
            }
        });

        return taskId;
    }

    public FetchState? GetProgress(string taskId)
    {
        _states.TryGetValue(taskId, out var state);
        return state;
    }

    public FetchState? GetResult(string taskId)
    {
        if (_states.TryGetValue(taskId, out var state) && state.Done)
        {
            _states.TryRemove(taskId, out _);
            return state;
        }
        return null;
    }

    private static ResourceVersionDto ParseCfFile(string modId, CurseForgeFilesMeta f)
    {
        var gameVersions = string.IsNullOrEmpty(f.GameVersion) ? new List<string>() : [f.GameVersion];

        var loaders = f.ModLoader switch
        {
            1 => ["forge"],
            3 => ["liteloader"],
            4 => ["fabric"],
            5 => ["quilt"],
            6 => ["neoforge"],
            _ => new List<string>()
        };

        return new ResourceVersionDto(
            Id: f.FileId.ToString(),
            Name: f.FileName ?? f.FileId.ToString(),
            VersionNumber: f.FileName ?? f.FileId.ToString(),
            GameVersions: gameVersions,
            Loaders: loaders,
            Downloads: [new ResourceFileDto("", f.FileName ?? "", 0)],
            DatePublished: null
        );
    }

    private static bool MatchVersionLoader(ResourceVersionDto v, string? gameVersion, string? loader)
    {
        if (!string.IsNullOrEmpty(gameVersion) &&
            !v.GameVersions.Contains(gameVersion, StringComparer.OrdinalIgnoreCase))
            return false;
        if (!string.IsNullOrEmpty(loader) &&
            v.Loaders.Count > 0 &&
            !v.Loaders.Any(l => l.Equals(loader, StringComparison.OrdinalIgnoreCase)))
            return false;
        return true;
    }
}

public sealed class FetchState
{
    public int TotalVersionCount { get; set; }
    public int LoadedVersionCount { get; set; }
    public bool Done { get; set; }
    public string? Error { get; set; }
    public List<ResourceVersionDto> Results { get; set; } = [];
}
