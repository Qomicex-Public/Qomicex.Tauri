using Qomicex.Launcher.Backend.ModRecommenderModelLib.Abstractions;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.Data;

namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.Services;

public class ModDataService : IModDataService
{
    private readonly IModDataProvider? _dataProvider;
    private List<ModInfo> _mods = [];
    private readonly Dictionary<int, ModInfo> _modDict = new();
    private readonly HashSet<string> _allTags = new();
    private ModListMetadata? _metadata;

    public ModDataService(IModDataProvider dataProvider)
    {
        _dataProvider = dataProvider ?? throw new ArgumentNullException(nameof(dataProvider));
    }

    public ModDataService(List<ModInfo> mods, ModListMetadata? metadata = null)
    {
        _mods = mods ?? throw new ArgumentNullException(nameof(mods));
        _metadata = metadata;
        BuildIndex();
    }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        if (_dataProvider == null) return;

        var root = await _dataProvider.LoadModListAsync(cancellationToken);
        _mods = root.Mods;
        _metadata = root.Metadata;
        BuildIndex();
    }

    private void BuildIndex()
    {
        _modDict.Clear();
        _allTags.Clear();

        foreach (var mod in _mods)
        {
            _modDict[mod.Id] = mod;
            foreach (var tag in mod.Tags)
            {
                _allTags.Add(tag);
            }
        }
    }

    public async Task LoadModDataAsync(string filePath)
    {
        var fileProvider = new FileModDataProvider(filePath);
        var root = await fileProvider.LoadModListAsync();
        _mods = root.Mods;
        _metadata = root.Metadata;
        BuildIndex();
    }

    public Task<List<ModInfo>> GetAllModsAsync()
    {
        return Task.FromResult(_mods.ToList());
    }

    public Task<ModInfo?> GetModByIdAsync(int modId)
    {
        _modDict.TryGetValue(modId, out var mod);
        return Task.FromResult(mod);
    }

    public Task<List<ModInfo>> GetModsByTagsAsync(List<string> tags)
    {
        if (tags == null || tags.Count == 0)
        {
            return Task.FromResult<List<ModInfo>>([]);
        }

        var result = _mods.Where(mod =>
            tags.Any(tag =>
                mod.Tags.Contains(tag, StringComparer.OrdinalIgnoreCase)))
            .ToList();

        return Task.FromResult(result);
    }

    public Task<List<string>> GetAllTagsAsync()
    {
        return Task.FromResult(_allTags.ToList());
    }

    public Task<ModListMetadata?> GetMetadataAsync()
    {
        return Task.FromResult(_metadata);
    }
}
