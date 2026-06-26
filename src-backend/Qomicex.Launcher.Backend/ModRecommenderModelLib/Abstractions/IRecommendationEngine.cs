using Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;

namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.Abstractions;

public interface IRecommendationEngine
{
    string EngineName { get; }

    bool RequiresUserData { get; }

    Task InitializeAsync();

    Task<List<ModRecommendation>> GetRecommendationsAsync(
        string? userId,
        int count = 10,
        CancellationToken cancellationToken = default);

    Task<List<ModRecommendation>> GetRecommendationsByTagsAsync(
        List<string> preferredTags,
        int count = 10,
        CancellationToken cancellationToken = default);
}
