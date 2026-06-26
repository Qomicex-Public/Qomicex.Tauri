using Qomicex.Launcher.Backend.ModRecommenderModelLib.Abstractions;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.RecommendationEngines;

namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.Services;

public class ModRecommendationService : IModRecommendationService
{
    private readonly IModDataService _modDataService;
    private readonly IUserBehaviorRepository _behaviorRepository;
    private readonly ColdStartRecommendationEngine _coldStartEngine;
    private readonly CollaborativeFilteringEngine _collaborativeEngine;
    private readonly HybridRecommendationEngine _hybridEngine;

    public ModRecommendationService(
        IModDataService modDataService,
        IUserBehaviorRepository behaviorRepository,
        ColdStartRecommendationEngine coldStartEngine,
        CollaborativeFilteringEngine collaborativeEngine,
        HybridRecommendationEngine hybridEngine)
    {
        _modDataService = modDataService;
        _behaviorRepository = behaviorRepository;
        _coldStartEngine = coldStartEngine;
        _collaborativeEngine = collaborativeEngine;
        _hybridEngine = hybridEngine;
    }

    public async Task InitializeAsync(string modDataFilePath)
    {
        await _modDataService.LoadModDataAsync(modDataFilePath);
        await _coldStartEngine.InitializeAsync();
        await _collaborativeEngine.InitializeAsync();
        await _hybridEngine.InitializeAsync();
    }

    public async Task<RecommendationResult> GetColdStartRecommendationsAsync(
        List<string> preferredTags,
        int count = 10)
    {
        var recommendations = await _coldStartEngine.GetRecommendationsByTagsAsync(
            preferredTags, count);

        return new RecommendationResult
        {
            Recommendations = recommendations,
            AlgorithmUsed = _coldStartEngine.EngineName,
            IsColdStart = true,
            GeneratedAt = DateTime.UtcNow
        };
    }

    public async Task<RecommendationResult> GetPersonalizedRecommendationsAsync(
        string userId,
        int count = 10)
    {
        var userBehaviors = await _behaviorRepository.GetByUserIdAsync(userId);
        var hasEnoughData = userBehaviors.Count >= 5;

        List<ModRecommendation> recommendations;
        string algorithmUsed;
        bool isColdStart = false;

        if (!hasEnoughData)
        {
            var userPreference = await _behaviorRepository.GetOrCreateUserPreferenceAsync(userId);
            recommendations = await _coldStartEngine.GetRecommendationsByTagsAsync(
                userPreference.PreferredTags, count);
            algorithmUsed = _coldStartEngine.EngineName;
            isColdStart = true;
        }
        else
        {
            recommendations = await _hybridEngine.GetRecommendationsAsync(userId, count);
            algorithmUsed = _hybridEngine.EngineName;
        }

        return new RecommendationResult
        {
            Recommendations = recommendations,
            AlgorithmUsed = algorithmUsed,
            IsColdStart = isColdStart,
            GeneratedAt = DateTime.UtcNow
        };
    }

    public async Task RecordUserBehaviorAsync(UserBehavior behavior)
    {
        await _behaviorRepository.AddAsync(behavior);

        var behaviorCount = await _behaviorRepository.GetCountAsync();
        if (behaviorCount % 50 == 0)
        {
            await RetrainModelAsync();
        }
    }

    public async Task RecordUserBehaviorsAsync(List<UserBehavior> behaviors)
    {
        await _behaviorRepository.AddRangeAsync(behaviors);
    }

    public async Task<List<ModRecommendation>> GetSimilarModsAsync(int modId, int count = 5)
    {
        var targetMod = await _modDataService.GetModByIdAsync(modId);
        if (targetMod == null)
        {
            return [];
        }

        var allMods = await _modDataService.GetAllModsAsync();
        var calculator = new ML.ModSimilarityCalculator();
        var similarMods = calculator.FindSimilarMods(targetMod, allMods, count);

        return similarMods.Select(m => new ModRecommendation
        {
            Mod = m.Mod,
            Score = m.Similarity,
            Reason = $"与 \"{targetMod.DisplayName}\" 相似度: {m.Similarity:F2}",
            RecommendationType = RecommendationType.SimilarItems,
            MatchedTags = targetMod.Tags.Intersect(m.Mod.Tags).ToList()
        }).ToList();
    }

    public async Task UpdateUserPreferencesAsync(
        string userId,
        List<string> preferredTags,
        List<string>? excludedTags = null)
    {
        var preference = await _behaviorRepository.GetOrCreateUserPreferenceAsync(userId);
        preference.PreferredTags = preferredTags;
        preference.ExcludedTags = excludedTags ?? [];
        preference.LastUpdatedAt = DateTime.UtcNow;

        await _behaviorRepository.UpdateUserPreferenceAsync(preference);
    }

    public Task<List<UserBehavior>> GetUserBehaviorHistoryAsync(string userId)
    {
        return _behaviorRepository.GetByUserIdAsync(userId);
    }

    public async Task RetrainModelAsync()
    {
        await _collaborativeEngine.InitializeAsync();
        await _hybridEngine.InitializeAsync();
    }

    public async Task<RecommendationStats> GetStatsAsync()
    {
        var allMods = await _modDataService.GetAllModsAsync();
        var allTags = await _modDataService.GetAllTagsAsync();
        var allBehaviors = await _behaviorRepository.GetAllAsync();

        var userIds = allBehaviors.Select(b => b.UserId).Distinct().ToList();

        return new RecommendationStats
        {
            TotalMods = allMods.Count,
            TotalUsers = userIds.Count,
            TotalBehaviors = allBehaviors.Count,
            TotalTags = allTags.Count,
            IsModelTrained = allBehaviors.Count >= 50
        };
    }
}
