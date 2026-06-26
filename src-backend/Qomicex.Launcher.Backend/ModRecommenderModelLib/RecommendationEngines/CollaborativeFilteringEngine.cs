using Microsoft.ML;
using Microsoft.ML.Data;
using Microsoft.ML.Trainers;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.Abstractions;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;

namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.RecommendationEngines;

public class CollaborativeFilteringEngine : IRecommendationEngine
{
    private readonly IModDataService _modDataService;
    private readonly IUserBehaviorRepository _behaviorRepository;
    private MLContext? _mlContext;
    private ITransformer? _model;
    private bool _isTrained = false;

    public string EngineName => "CollaborativeFiltering-MatrixFactorization";
    public bool RequiresUserData => true;

    public CollaborativeFilteringEngine(
        IModDataService modDataService,
        IUserBehaviorRepository behaviorRepository)
    {
        _modDataService = modDataService;
        _behaviorRepository = behaviorRepository;
    }

    public async Task InitializeAsync()
    {
        _mlContext = new MLContext(seed: 0);

        var behaviors = await _behaviorRepository.GetAllAsync();

        if (behaviors.Count < 50)
        {
            return;
        }

        var trainingData = behaviors.Select(b => new ModRating
        {
            UserId = b.UserId,
            ModId = (uint)b.ModId,
            Rating = b.GetBehaviorWeight()
        }).ToList();

        if (trainingData.Count == 0)
        {
            return;
        }

        var dataView = _mlContext.Data.LoadFromEnumerable(trainingData);

        var pipeline = _mlContext.Recommendation().Trainers.MatrixFactorization(
            new MatrixFactorizationTrainer.Options
            {
                MatrixColumnIndexColumnName = nameof(ModRating.UserId),
                MatrixRowIndexColumnName = nameof(ModRating.ModId),
                LabelColumnName = nameof(ModRating.Rating),
                NumberOfIterations = 100
            });

        _model = pipeline.Fit(dataView);
        _isTrained = true;
    }

    public async Task<List<ModRecommendation>> GetRecommendationsAsync(
        string? userId,
        int count = 10,
        CancellationToken cancellationToken = default)
    {
        if (!_isTrained || _mlContext == null || _model == null || string.IsNullOrEmpty(userId))
        {
            return [];
        }

        var allMods = await _modDataService.GetAllModsAsync();
        var predictions = new List<(ModInfo Mod, float Score)>();

        var predictionEngine = _mlContext.Model.CreatePredictionEngine<ModRating, ModRatingPrediction>(_model);

        foreach (var mod in allMods)
        {
            try
            {
                var prediction = predictionEngine.Predict(new ModRating
                {
                    UserId = userId,
                    ModId = (uint)mod.Id
                });

                if (prediction.Score > 0)
                {
                    predictions.Add((mod, prediction.Score));
                }
            }
            catch
            {
                continue;
            }
        }

        return predictions
            .OrderByDescending(p => p.Score)
            .Take(count)
            .Select(p => new ModRecommendation
            {
                Mod = p.Mod,
                Score = p.Score,
                Reason = "基于协同过滤算法的个性化推荐",
                RecommendationType = RecommendationType.CollaborativeFiltering,
                MatchedTags = p.Mod.Tags.ToList()
            })
            .ToList();
    }

    public Task<List<ModRecommendation>> GetRecommendationsByTagsAsync(
        List<string> preferredTags,
        int count = 10,
        CancellationToken cancellationToken = default)
    {
        return Task.FromResult<List<ModRecommendation>>([]);
    }
}

public class ModRating
{
    public string UserId { get; set; } = string.Empty;
    public uint ModId { get; set; }
    public float Rating { get; set; }
}

public class ModRatingPrediction
{
    public float Score { get; set; }
}
