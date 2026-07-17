using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Services;

public sealed class InstanceService
{
    private readonly string _filePath;
    private List<GameInstance> _instances;
    private readonly object _lock = new();

    private static readonly JsonSerializerOptions FileJsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        TypeInfoResolver = ApiJsonContext.Default,
    };

    public InstanceService()
    {
        var dataDir = Path.Combine(AppPaths.BaseDir, "data");
        Directory.CreateDirectory(dataDir);
        _filePath = Path.Combine(dataDir, "instances.json");
        _instances = LoadFromFile();
    }

    private List<GameInstance> LoadFromFile()
    {
        try
        {
            if (File.Exists(_filePath))
            {
                var json = File.ReadAllText(_filePath);
                return JsonSerializer.Deserialize(json, ApiJsonContext.Default.ListGameInstance) ?? [];
            }
        }
        catch { }
        return [];
    }

    private void SaveToFile()
    {
        var json = JsonSerializer.Serialize(_instances, ApiJsonContext.Default.ListGameInstance);
        File.WriteAllText(_filePath, json);
    }

    public List<GameInstance> GetAll()
    {
        lock (_lock) { return [.. _instances]; }
    }

    public GameInstance? GetById(string id)
    {
        lock (_lock) { return _instances.FirstOrDefault(i => i.Id == id); }
    }

    public GameInstance Create(GameInstance instance)
    {
        lock (_lock)
        {
            _instances.Add(instance);
            SaveToFile();
            return instance;
        }
    }

    public GameInstance? Update(string id, GameInstance instance)
    {
        lock (_lock)
        {
            var index = _instances.FindIndex(i => i.Id == id);
            if (index < 0) return null;
            instance.Id = id;
            _instances[index] = instance;
            SaveToFile();
            return instance;
        }
    }

    public GameInstance? Delete(string id)
    {
        lock (_lock)
        {
            if (_defaultId == id) _defaultId = null;
            var instance = _instances.FirstOrDefault(i => i.Id == id);
            if (instance == null) return null;
            _instances.RemoveAll(i => i.Id == id);
            SaveToFile();
            return instance;
        }
    }

    private string? _defaultId;
    private static readonly string DefaultFilePath =
        Path.Combine(AppPaths.BaseDir, "data", "default_instance.json");

    public string? GetDefaultId()
    {
        lock (_lock)
        {
            if (_defaultId != null) return _defaultId;
            try
            {
                if (File.Exists(DefaultFilePath))
                {
                    _defaultId = File.ReadAllText(DefaultFilePath).Trim().Trim('"');
                    return _defaultId;
                }
            }
            catch { }
            return null;
        }
    }

    public void SetDefaultId(string id)
    {
        lock (_lock)
        {
            _defaultId = id;
            var dir = Path.GetDirectoryName(DefaultFilePath)!;
            Directory.CreateDirectory(dir);
            File.WriteAllText(DefaultFilePath, $"\"{id}\"");
        }
    }

    public void ClearDefaultId()
    {
        lock (_lock)
        {
            _defaultId = null;
            try { if (File.Exists(DefaultFilePath)) File.Delete(DefaultFilePath); }
            catch { }
        }
    }
}
