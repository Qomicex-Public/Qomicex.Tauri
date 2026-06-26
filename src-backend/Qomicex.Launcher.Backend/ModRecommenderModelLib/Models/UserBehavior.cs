namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;

public enum BehaviorType
{
    View,

    Download,

    Favorite,

    Rate,

    Ignore
}

public class UserBehavior
{
    public string UserId { get; set; } = string.Empty;

    public int ModId { get; set; }

    public BehaviorType BehaviorType { get; set; }

    public float Rating { get; set; }

    public DateTime Timestamp { get; set; } = DateTime.UtcNow;

    public float GetBehaviorWeight()
    {
        return BehaviorType switch
        {
            BehaviorType.View => 1.0f,
            BehaviorType.Download => 3.0f,
            BehaviorType.Favorite => 4.0f,
            BehaviorType.Rate => Rating,
            BehaviorType.Ignore => -1.0f,
            _ => 1.0f
        };
    }
}

public class UserPreference
{
    public string UserId { get; set; } = string.Empty;

    public List<string> PreferredTags { get; set; } = [];

    public List<string> ExcludedTags { get; set; } = [];

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime LastUpdatedAt { get; set; } = DateTime.UtcNow;
}
