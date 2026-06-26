using Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;

namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.Abstractions;

public interface IModRecommendationService
{
    Task<RecommendationResult> GetColdStartRecommendationsAsync(
        List<string> preferredTags,
        int count = 10);

    Task<RecommendationResult> GetPersonalizedRecommendationsAsync(
        string userId,
        int count = 10);

    Task RecordUserBehaviorAsync(UserBehavior behavior);

    Task RecordUserBehaviorsAsync(List<UserBehavior> behaviors);

    Task<List<ModRecommendation>> GetSimilarModsAsync(
        int modId,
        int count = 5);

    Task UpdateUserPreferencesAsync(
        string userId,
        List<string> preferredTags,
        List<string>? excludedTags = null);

    Task<List<UserBehavior>> GetUserBehaviorHistoryAsync(string userId);

    Task RetrainModelAsync();

    Task<RecommendationStats> GetStatsAsync();

    Task InitializeAsync(string modDataFilePath);
}

public class RecommendationStats
{
    public int TotalMods { get; set; }

    public int TotalUsers { get; set; }

    public int TotalBehaviors { get; set; }

    public int TotalTags { get; set; }

    public bool IsModelTrained { get; set; }

    public DateTime? LastTrainedAt { get; set; }
}
