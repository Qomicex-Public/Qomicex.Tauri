using System.Text.Json;
using Qomicex.Launcher.Backend.Models;

namespace Qomicex.Launcher.Backend.Services;

public class InstanceRepository : IInstanceRepository
{
    private readonly string _filePath;
    private List<GameInstance> _instances;
    private readonly object _lock = new();

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public InstanceRepository()
    {
        var dataDir = Path.Combine(AppContext.BaseDirectory, "data");
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
                return JsonSerializer.Deserialize<List<GameInstance>>(json, JsonOptions) ?? [];
            }
        }
        catch { }
        return [];
    }

    private void SaveToFile()
    {
        var json = JsonSerializer.Serialize(_instances, JsonOptions);
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

    public GameInstance? GetDefault()
    {
        lock (_lock) { return _instances.FirstOrDefault(i => i.IsDefault); }
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

    public bool Delete(string id)
    {
        lock (_lock)
        {
            var removed = _instances.RemoveAll(i => i.Id == id);
            if (removed > 0)
            {
                SaveToFile();
                return true;
            }
            return false;
        }
    }
}
