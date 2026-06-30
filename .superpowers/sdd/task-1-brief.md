### Task 1: McmodService 扩展 — 支持读取 mcmod ID

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Services/McmodService.cs`

**Interfaces:**
- Produces: `McmodEntry` 新增 `Id?` 属性；`BatchLookupWithIds(List<string>)` → `Dictionary<string, (string? cnName, int? id)>`

- [ ] **Step 1: 修改 McmodEntry，添加 Id 字段**

在 `private sealed class McmodEntry` 中添加：

```csharp
private sealed class McmodEntry
{
    public int? Id { get; set; }
    public string? EnName { get; set; }
    public string? CnName { get; set; }
}
```

- [ ] **Step 2: 修改数据加载逻辑，存储 Id 映射**

修改构造函数中的加载逻辑，将 `_map` 从 `Dictionary<string, string>` 改为 `Dictionary<string, (string cnName, int? id)>`：

```csharp
private readonly Dictionary<string, (string CnName, int? Id)> _map;

public McmodService()
{
    _map = [];

    try
    {
        var json = TryLoadRuntimeOverride() ?? TryLoadEmbedded();
        if (json == null) return;
        var doc = JsonSerializer.Deserialize<McmodData>(json, JsonOptions);
        if (doc?.Mods == null) return;
        foreach (var entry in doc.Mods)
        {
            var key = Normalize(entry.EnName ?? "");
            if (key.Length > 0 && !_map.ContainsKey(key))
                _map[key] = (entry.CnName ?? entry.EnName ?? "", entry.Id);
        }
    }
    catch { }
}
```

- [ ] **Step 3: 更新查找和批量查找方法**

修改 `Lookup` 和 `BatchLookup` 以适配新的数据结构：

```csharp
public string? Lookup(string enName)
{
    var key = Normalize(enName);
    if (key.Length == 0) return null;
    if (_map.TryGetValue(key, out var entry)) return entry.CnName;
    foreach (var (k, v) in _map)
        if (k.Contains(key) || key.Contains(k)) return v.CnName;
    var words = key.Split(' ', StringSplitOptions.RemoveEmptyEntries);
    foreach (var (k, v) in _map)
        foreach (var w in words)
            if (w.Length > 2 && k.Contains(w)) return v.CnName;
    return null;
}

public Dictionary<string, string?> BatchLookup(List<string> names)
{
    var result = new Dictionary<string, string?>(names.Count);
    foreach (var name in names)
        result[name] = Lookup(name);
    return result;
}
```

- [ ] **Step 4: 新增 BatchLookupWithIds 方法**

```csharp
public Dictionary<string, (string? CnName, int? Id)> BatchLookupWithIds(List<string> names)
{
    var result = new Dictionary<string, (string? CnName, int? Id)>(names.Count);
    foreach (var name in names)
    {
        var key = Normalize(name);
        if (key.Length > 0 && _map.TryGetValue(key, out var entry))
            result[name] = (entry.CnName, entry.Id);
        else
            result[name] = (null, null);
    }
    return result;
}
```

- [ ] **Step 5: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded

- [ ] **Step 6: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/McmodService.cs
git commit -m "feat: extend McmodService to read mcmod ID from data"
```
