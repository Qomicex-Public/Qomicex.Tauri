using Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;

namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.Abstractions;

public interface IModDataProvider
{
    Task<List<ModInfo>> LoadModsAsync(CancellationToken cancellationToken = default);

    Task<ModListRoot> LoadModListAsync(CancellationToken cancellationToken = default);
}
