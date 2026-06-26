using Qomicex.Launcher.Backend.ModRecommenderModelLib.Abstractions;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;

namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.RecommendationEngines;

public class HybridRecommendationEngine : IRecommendationEngine
{
    private readonly ColdStartRecommendationEngine _coldStartEngine;
    private readonly CollaborativeFilteringEngine _collaborativeEngine;

    public double ContentWeight { get; set; } = 0.4;
    public double CollaborativeWeight { get; set; } = 0.6;

    public string EngineName => "Hybrid-Content+Collaborative";
    public bool RequiresUserData => true;

    public HybridRecommendationEngine(
        ColdStartRecommendationEngine coldStartEngine,
        CollaborativeFilteringEngine collaborativeEngine)
    {
        _coldStartEngine = coldStartEngine;
        _collaborativeEngine = collaborativeEngine;
    }

    public async Task InitializeAsync()
    {
        await _coldStartEngine.InitializeAsync();
        await _collaborativeEngine.InitializeAsync();
    }

    public async Task<List<ModRecommendation>> GetRecommendationsAsync(
        string? userId,
        int count = 10,
        CancellationToken cancellationToken = default)
    {
        var contentRecommendations = await _coldStartEngine.GetRecommendationsAsync(userId, count * 2, cancellationToken);
        var collaborativeRecommendations = await _collaborativeEngine.GetRecommendationsAsync(userId, count * 2, cancellationToken);

        var mergedScores = new Dictionary<int, (ModInfo Mod, double Score, string Reason, List<string> MatchedTags)>();

        foreach (var rec in contentRecommendations)
        {
            var weightedScore = rec.Score * ContentWeight;
            mergedScores[rec.Mod.Id] = (rec.Mod, weightedScore, rec.Reason, rec.MatchedTags);
        }

        foreach (var rec in collaborativeRecommendations)
        {
            var weightedScore = rec.Score * CollaborativeWeight;
            if (mergedScores.TryGetValue(rec.Mod.Id, out var existing))
            {
                var combinedScore = existing.Score + weightedScore;
                var combinedReason = $"内容匹配 + 协同过滤（综合得分: {combinedScore:F2}）";
                var combinedTags = existing.MatchedTags.Union(rec.MatchedTags).ToList();
                mergedScores[rec.Mod.Id] = (existing.Mod, combinedScore, combinedReason, combinedTags);
            }
            else
            {
                mergedScores[rec.Mod.Id] = (rec.Mod, weightedScore, rec.Reason, rec.MatchedTags);
            }
        }

        return mergedScores.Values
            .OrderByDescending(v => v.Score)
            .Take(count)
            .Select(v => new ModRecommendation
            {
                Mod = v.Mod,
                Score = v.Score,
                Reason = v.Reason,
                RecommendationType = RecommendationType.Hybrid,
                MatchedTags = v.MatchedTags
            })
            .ToList();
    }

    public async Task<List<ModRecommendation>> GetRecommendationsByTagsAsync(
        List<string> preferredTags,
        int count = 10,
        CancellationToken cancellationToken = default)
    {
        return await _coldStartEngine.GetRecommendationsByTagsAsync(preferredTags, count, cancellationToken);
    }
}
