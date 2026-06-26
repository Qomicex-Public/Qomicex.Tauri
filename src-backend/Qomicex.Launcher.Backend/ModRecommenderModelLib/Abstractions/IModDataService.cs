using Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;

namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.Abstractions;

public interface IModDataService
{
    Task<List<ModInfo>> GetAllModsAsync();

    Task<ModInfo?> GetModByIdAsync(int modId);

    Task<List<ModInfo>> GetModsByTagsAsync(List<string> tags);

    Task<List<string>> GetAllTagsAsync();

    Task LoadModDataAsync(string filePath);
}
