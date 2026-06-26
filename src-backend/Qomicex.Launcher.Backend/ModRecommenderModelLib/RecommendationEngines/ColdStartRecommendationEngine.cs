using Qomicex.Launcher.Backend.ModRecommenderModelLib.Abstractions;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.ML;

namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.RecommendationEngines;

public class ColdStartRecommendationEngine : IRecommendationEngine
{
    private readonly IModDataService _modDataService;
    private readonly TagFeatureExtractor _featureExtractor;
    private readonly ModSimilarityCalculator _similarityCalculator;
    private bool _isInitialized = false;

    public string EngineName => "ColdStart-ContentBased";
    public bool RequiresUserData => false;

    public ColdStartRecommendationEngine(IModDataService modDataService)
    {
        _modDataService = modDataService;
        _featureExtractor = new TagFeatureExtractor();
        _similarityCalculator = new ModSimilarityCalculator();
    }

    public async Task InitializeAsync()
    {
        if (_isInitialized) return;

        var mods = await _modDataService.GetAllModsAsync();
        _featureExtractor.Fit(mods);
        _isInitialized = true;
    }

    public async Task<List<ModRecommendation>> GetRecommendationsAsync(
        string? userId,
        int count = 10,
        CancellationToken cancellationToken = default)
    {
        if (!_isInitialized)
        {
            await InitializeAsync();
        }

        return [];
    }

    public async Task<List<ModRecommendation>> GetRecommendationsByTagsAsync(
        List<string> preferredTags,
        int count = 10,
        CancellationToken cancellationToken = default)
    {
        if (!_isInitialized)
        {
            await InitializeAsync();
        }

        if (preferredTags == null || preferredTags.Count == 0)
        {
            return [];
        }

        var allMods = await _modDataService.GetAllModsAsync();
        var recommendations = new List<ModRecommendation>();

        foreach (var mod in allMods)
        {
            double score = _similarityCalculator.CalculatePreferenceScore(mod, preferredTags);

            if (score > 0)
            {
                var matchedTags = preferredTags
                    .Where(tag => mod.Tags.Contains(tag, StringComparer.OrdinalIgnoreCase))
                    .ToList();

                recommendations.Add(new ModRecommendation
                {
                    Mod = mod,
                    Score = score,
                    Reason = $"匹配标签: {string.Join(", ", matchedTags)}",
                    RecommendationType = RecommendationType.ContentBased,
                    MatchedTags = matchedTags
                });
            }
        }

        return recommendations
            .OrderByDescending(r => r.Score)
            .Take(count)
            .ToList();
    }
}
