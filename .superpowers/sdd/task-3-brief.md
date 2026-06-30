### Task 3: InstanceFilesController — 新增 Mod 管理端点

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs`

**Interfaces:**
- Consumes: `ModMetadataDto`, `ChangeModVersionRequest` (Task 2); `McmodService.BatchLookupWithIds` (Task 1)
- Produces: `GET .../mods/metadata`, `POST .../mods/enable`, `POST .../mods/disable`, `POST .../mods/change-version`, `POST .../mods/batch-enable`, `POST .../mods/batch-disable`, `POST .../mods/batch-delete`

- [ ] **Step 1: 添加 McmodService 和 IConfiguration 注入**

修改构造函数，添加两个新依赖：

```csharp
private readonly IInstanceRepository _repository;
private readonly IHttpClientFactory _httpClientFactory;
private readonly McmodService _mcmod;
private readonly IConfiguration _configuration;

public InstanceFilesController(
    IInstanceRepository repository,
    IHttpClientFactory httpClientFactory,
    McmodService mcmod,
    IConfiguration configuration)
{
    _repository = repository;
    _httpClientFactory = httpClientFactory;
    _mcmod = mcmod;
    _configuration = configuration;
}
```

在文件顶部添加 using:

```csharp
using Qomicex.Core.Modules.Helpers.Resources.Expansion.Local;
```

- [ ] **Step 2: 添加 GET mods/metadata 端点**

在现有 `mods` GET 方法后面添加（放在 `[HttpDelete("mods")]` 之后，`[HttpPost("mods/install")]` 之前）：

```csharp
[HttpGet("mods/metadata")]
public async Task<ActionResult<List<ModMetadataDto>>> GetModsMetadata(string instanceId)
{
    var inst = _repository.GetById(instanceId);
    if (inst == null) return NotFound();

    var gameDir = ResolveGameDir(instanceId);
    if (gameDir == null) return NotFound();

    var versionSegmented = inst.VersionIsolation ?? true;
    var apiKey = _configuration["CurseForge:ApiKey"] ?? "";

    var mods = new Mods(gameDir, inst.GameVersion, versionSegmented, apiKey);
    var modList = await mods.GetModList();

    var names = modList.Select(m => m.Name).Distinct().ToList();
    var lookupResult = _mcmod.BatchLookupWithIds(names);

    var result = modList.Select(m =>
    {
        var (cnName, mcmodId) = lookupResult.GetValueOrDefault(m.Name, (null, null));
        string? source = null;
        if (m.CurseForgeId > 0) source = "curseforge";
        else if (!string.IsNullOrEmpty(m.ModrinthId)) source = "modrinth";

        return new ModMetadataDto
        {
            FileName = Path.GetFileName(m.FilePath),
            Name = m.Name,
            Version = m.Version,
            Description = m.Description ?? "",
            Authors = m.Authors ?? [],
            IconUrl = m.CurseFoegeMeta?.IconUrl ?? m.ModrinthMeta?.IconUrl ?? null,
            CurseForgeId = m.CurseForgeId > 0 ? m.CurseForgeId : null,
            ModrinthId = m.ModrinthId,
            Source = source,
            McmodId = mcmodId,
            ChineseName = cnName,
            Active = m.Active,
        };
    }).ToList();

    return Ok(result);
}
```

- [ ] **Step 3: 添加 POST mods/enable 端点**

放在 metadata endpoint 之后：

```csharp
[HttpPost("mods/enable")]
public IActionResult EnableMod(string instanceId, [FromQuery] string name)
{
    var gameDir = ResolveGameDir(instanceId);
    if (gameDir == null) return NotFound();
    var modsDir = Path.Combine(gameDir, "mods");
    var fileName = name.EndsWith(".disabled", StringComparison.OrdinalIgnoreCase) ? name : name + ".disabled";
    var filePath = Path.Combine(modsDir, fileName);
    if (!System.IO.File.Exists(filePath))
    {
        var altPath = Path.Combine(modsDir, name);
        if (!System.IO.File.Exists(altPath)) return NotFound();
        return NoContent(); // already enabled
    }

    var versionSegmented = _repository.GetById(instanceId)?.VersionIsolation ?? true;
    var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
    var inst = _repository.GetById(instanceId)!;
    var mods = new Mods(gameDir, inst.GameVersion, versionSegmented, apiKey);
    mods.EnableMod(filePath);
    return NoContent();
}
```

- [ ] **Step 4: 添加 POST mods/disable 端点**

```csharp
[HttpPost("mods/disable")]
public IActionResult DisableMod(string instanceId, [FromQuery] string name)
{
    var gameDir = ResolveGameDir(instanceId);
    if (gameDir == null) return NotFound();
    var modsDir = Path.Combine(gameDir, "mods");
    var filePath = Path.Combine(modsDir, name);
    if (!System.IO.File.Exists(filePath)) return NotFound();

    var versionSegmented = _repository.GetById(instanceId)?.VersionIsolation ?? true;
    var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
    var inst = _repository.GetById(instanceId)!;
    var mods = new Mods(gameDir, inst.GameVersion, versionSegmented, apiKey);
    mods.DisableMod(filePath);
    return NoContent();
}
```

- [ ] **Step 5: 添加 POST mods/change-version 端点**

```csharp
[HttpPost("mods/change-version")]
public async Task<IActionResult> ChangeModVersion(string instanceId, [FromBody] ChangeModVersionRequest request)
{
    var gameDir = ResolveGameDir(instanceId);
    if (gameDir == null) return NotFound();
    var modsDir = Path.Combine(gameDir, "mods");

    // 删除旧文件（可能是 .jar 或 .jar.disabled）
    var oldPath = Path.Combine(modsDir, request.FileName);
    if (System.IO.File.Exists(oldPath))
        System.IO.File.Delete(oldPath);
    var disabledPath = Path.Combine(modsDir, request.FileName + ".disabled");
    if (System.IO.File.Exists(disabledPath))
        System.IO.File.Delete(disabledPath);

    // 下载新文件
    var newPath = Path.Combine(modsDir, request.NewFileName);
    using var client = _httpClientFactory.CreateClient();
    var response = await client.GetAsync(request.DownloadUrl);
    if (!response.IsSuccessStatusCode)
        return BadRequest(new { error = "下载失败" });
    await using var stream = await response.Content.ReadAsStreamAsync();
    await using var file = System.IO.File.Create(newPath);
    await stream.CopyToAsync(file);

    return NoContent();
}
```

- [ ] **Step 6: 添加批量操作端点**

```csharp
[HttpPost("mods/batch-enable")]
public IActionResult BatchEnableMods(string instanceId, [FromBody] List<string> names)
{
    var gameDir = ResolveGameDir(instanceId);
    if (gameDir == null) return NotFound();
    var modsDir = Path.Combine(gameDir, "mods");
    var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
    var inst = _repository.GetById(instanceId)!;
    var versionSegmented = inst.VersionIsolation ?? true;
    var mods = new Mods(gameDir, inst.GameVersion, versionSegmented, apiKey);

    foreach (var name in names)
    {
        var fileName = name.EndsWith(".disabled", StringComparison.OrdinalIgnoreCase) ? name : name + ".disabled";
        var path = Path.Combine(modsDir, fileName);
        if (System.IO.File.Exists(path))
            mods.EnableMod(path);
    }
    return NoContent();
}

[HttpPost("mods/batch-disable")]
public IActionResult BatchDisableMods(string instanceId, [FromBody] List<string> names)
{
    var gameDir = ResolveGameDir(instanceId);
    if (gameDir == null) return NotFound();
    var modsDir = Path.Combine(gameDir, "mods");
    var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
    var inst = _repository.GetById(instanceId)!;
    var versionSegmented = inst.VersionIsolation ?? true;
    var mods = new Mods(gameDir, inst.GameVersion, versionSegmented, apiKey);

    foreach (var name in names)
    {
        var path = Path.Combine(modsDir, name);
        if (System.IO.File.Exists(path))
            mods.DisableMod(path);
    }
    return NoContent();
}

[HttpPost("mods/batch-delete")]
public IActionResult BatchDeleteMods(string instanceId, [FromBody] List<string> names)
{
    var modsDir = GetPath(instanceId, "mods", out var _);
    if (modsDir == null) return NotFound();

    foreach (var name in names)
    {
        var path = Path.Combine(modsDir, name);
        if (System.IO.File.Exists(path))
            System.IO.File.Delete(path);
        var disabledPath = Path.Combine(modsDir, name + ".disabled");
        if (System.IO.File.Exists(disabledPath))
            System.IO.File.Delete(disabledPath);
    }
    return NoContent();
}
```

- [ ] **Step 7: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded

- [ ] **Step 8: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs
git commit -m "feat: add mod metadata, enable/disable, change-version, batch endpoints"
```
