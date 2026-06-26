namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;

public class ModRecommendation
{
    public ModInfo Mod { get; set; } = new();

    public double Score { get; set; }

    public string Reason { get; set; } = string.Empty;

    public RecommendationType RecommendationType { get; set; }

    public List<string> MatchedTags { get; set; } = [];
}

public enum RecommendationType
{
    ContentBased,

    CollaborativeFiltering,

    Hybrid,

    Popular,

    SimilarItems
}

public class RecommendationRequest
{
    public string? UserId { get; set; }

    public int Count { get; set; } = 10;

    public List<int> ExcludeModIds { get; set; } = [];

    public List<string> PreferredTags { get; set; } = [];

    public double MinScore { get; set; } = 0.0;
}

public class RecommendationResult
{
    public List<ModRecommendation> Recommendations { get; set; } = [];

    public string AlgorithmUsed { get; set; } = string.Empty;

    public DateTime GeneratedAt { get; set; } = DateTime.UtcNow;

    public bool IsColdStart { get; set; }
}
