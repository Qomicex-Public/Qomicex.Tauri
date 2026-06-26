using Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;

namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.ML;

public class ModSimilarityCalculator
{
    public double CalculateCosineSimilarity(ModInfo mod1, ModInfo mod2)
    {
        var tags1 = new HashSet<string>(mod1.Tags, StringComparer.OrdinalIgnoreCase);
        var tags2 = new HashSet<string>(mod2.Tags, StringComparer.OrdinalIgnoreCase);

        if (tags1.Count == 0 || tags2.Count == 0)
        {
            return 0.0;
        }

        var intersection = tags1.Intersect(tags2, StringComparer.OrdinalIgnoreCase).Count();

        var magnitude1 = Math.Sqrt(tags1.Count);
        var magnitude2 = Math.Sqrt(tags2.Count);

        return intersection / (magnitude1 * magnitude2);
    }

    public double CalculateJaccardSimilarity(ModInfo mod1, ModInfo mod2)
    {
        var tags1 = new HashSet<string>(mod1.Tags, StringComparer.OrdinalIgnoreCase);
        var tags2 = new HashSet<string>(mod2.Tags, StringComparer.OrdinalIgnoreCase);

        if (tags1.Count == 0 || tags2.Count == 0)
        {
            return 0.0;
        }

        var intersection = tags1.Intersect(tags2, StringComparer.OrdinalIgnoreCase).Count();
        var union = tags1.Union(tags2, StringComparer.OrdinalIgnoreCase).Count();

        return (double)intersection / union;
    }

    public List<(ModInfo Mod, double Similarity)> FindSimilarMods(
        ModInfo targetMod,
        List<ModInfo> allMods,
        int topK = 5,
        double minSimilarity = 0.0)
    {
        var similarities = new List<(ModInfo Mod, double Similarity)>();

        foreach (var mod in allMods)
        {
            if (mod.Id == targetMod.Id)
            {
                continue;
            }

            var similarity = CalculateCosineSimilarity(targetMod, mod);

            if (similarity >= minSimilarity)
            {
                similarities.Add((mod, similarity));
            }
        }

        return similarities
            .OrderByDescending(s => s.Similarity)
            .Take(topK)
            .ToList();
    }

    public double CalculatePreferenceScore(
        ModInfo mod,
        List<string> preferredTags,
        List<string>? excludedTags = null)
    {
        excludedTags ??= [];

        double score = 0.0;

        foreach (var excludedTag in excludedTags)
        {
            if (mod.Tags.Contains(excludedTag, StringComparer.OrdinalIgnoreCase))
            {
                return -1.0;
            }
        }

        foreach (var preferredTag in preferredTags)
        {
            if (mod.Tags.Contains(preferredTag, StringComparer.OrdinalIgnoreCase))
            {
                score += 1.0;
            }
        }

        if (preferredTags.Count > 0)
        {
            score /= preferredTags.Count;
        }

        return score;
    }
}
