using Microsoft.Extensions.DependencyInjection;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.Abstractions;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.Data;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.RecommendationEngines;

namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.Services;

public static class ServiceExtensions
{
    public static IServiceCollection AddModRecommender(
        this IServiceCollection services,
        IModDataProvider dataProvider)
    {
        services.AddSingleton(dataProvider);
        services.AddSingleton<IModDataService, ModDataService>();
        RegisterCoreServices(services);
        return services;
    }

    public static IServiceCollection AddModRecommender(
        this IServiceCollection services,
        string modListFilePath)
    {
        services.AddSingleton<IModDataProvider>(
            new FileModDataProvider(modListFilePath));
        services.AddSingleton<IModDataService, ModDataService>();
        RegisterCoreServices(services);
        return services;
    }

    public static IServiceCollection AddModRecommender(
        this IServiceCollection services,
        List<ModInfo> mods,
        ModListMetadata? metadata = null)
    {
        services.AddSingleton<IModDataService>(
            new ModDataService(mods, metadata));
        RegisterCoreServices(services);
        return services;
    }

    public static IServiceCollection AddModRecommender(
        this IServiceCollection services,
        Func<IServiceProvider, IModDataProvider> dataProviderFactory)
    {
        services.AddSingleton(dataProviderFactory);
        services.AddSingleton<IModDataService, ModDataService>();
        RegisterCoreServices(services);
        return services;
    }

    private static void RegisterCoreServices(IServiceCollection services)
    {
        services.AddSingleton<IUserBehaviorRepository, UserBehaviorRepository>();

        services.AddSingleton<ColdStartRecommendationEngine>();
        services.AddSingleton<CollaborativeFilteringEngine>();
        services.AddSingleton<HybridRecommendationEngine>();

        services.AddSingleton<IModRecommendationService, ModRecommendationService>();
    }

    public static IServiceCollection ConfigureUserBehaviorDataDirectory(
        this IServiceCollection services,
        string dataDirectory)
    {
        services.AddSingleton<IUserBehaviorRepository>(
            sp => new UserBehaviorRepository(dataDirectory));
        return services;
    }
}
