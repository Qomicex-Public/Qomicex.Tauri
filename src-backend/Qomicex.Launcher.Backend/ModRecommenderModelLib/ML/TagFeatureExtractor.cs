using Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;

namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.ML;

public class TagFeatureExtractor
{
    private readonly Dictionary<string, int> _tagToIndex = new();
    private readonly Dictionary<string, double> _idfScores = new();
    private bool _isFitted = false;

    public void Fit(List<ModInfo> mods)
    {
        if (mods == null || mods.Count == 0)
        {
            return;
        }

        var docFrequency = new Dictionary<string, int>();
        int totalDocs = mods.Count;

        foreach (var mod in mods)
        {
            var uniqueTags = new HashSet<string>(mod.Tags);
            foreach (var tag in uniqueTags)
            {
                if (!docFrequency.ContainsKey(tag))
                {
                    docFrequency[tag] = 0;
                }
                docFrequency[tag]++;
            }
        }

        _idfScores.Clear();
        _tagToIndex.Clear();
        int index = 0;

        foreach (var kvp in docFrequency)
        {
            var tag = kvp.Key;
            var df = kvp.Value;

            var idf = Math.Log((double)totalDocs / df);
            _idfScores[tag] = idf;
            _tagToIndex[tag] = index++;
        }

        _isFitted = true;
    }

    public Dictionary<int, float> ExtractFeatures(ModInfo mod)
    {
        if (!_isFitted)
        {
            throw new InvalidOperationException("必须先调用Fit方法训练特征提取器");
        }

        var features = new Dictionary<int, float>();

        foreach (var tag in mod.Tags)
        {
            if (_tagToIndex.TryGetValue(tag, out var index) &&
                _idfScores.TryGetValue(tag, out var idf))
            {
                features[index] = (float)idf;
            }
        }

        return features;
    }

    public Dictionary<int, Dictionary<int, float>> BatchExtractFeatures(List<ModInfo> mods)
    {
        var result = new Dictionary<int, Dictionary<int, float>>();

        foreach (var mod in mods)
        {
            result[mod.Id] = ExtractFeatures(mod);
        }

        return result;
    }
}
