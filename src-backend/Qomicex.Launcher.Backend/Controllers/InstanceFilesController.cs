using System.Collections.Concurrent;
using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Models;
using Qomicex.Launcher.Backend.Services;
using Qomicex.Core.Modules.Helpers.GameSettings;
using Qomicex.Core.Modules.Helpers.Resources.Expansion.Local;
using System.Diagnostics;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/instance/{instanceId}/files")]
public class InstanceFilesController : ControllerBase
{
    private static readonly ConcurrentDictionary<string, ModLoadProgress> ModLoadProgressStore = new();

    private readonly IInstanceRepository _repository;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly McmodService _mcmod;
    private readonly IConfiguration _configuration;
    private readonly LanGameListenerService _lanListener;

    public InstanceFilesController(
        IInstanceRepository repository,
        IHttpClientFactory httpClientFactory,
        McmodService mcmod,
        IConfiguration configuration,
        LanGameListenerService lanListener)
    {
        _repository = repository;
        _httpClientFactory = httpClientFactory;
        _mcmod = mcmod;
        _configuration = configuration;
        _lanListener = lanListener;
    }

    private static string ResolveGameDir(GameInstance inst)
    {
        var dir = inst.GameDir;
        if (!Path.IsPathRooted(dir))
            dir = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), dir));
        return dir;
    }

    private static string GetCategoryDir(string gameDir, string gameVersion, bool versionIsolation, string category)
    {
        var sub = category switch
        {
            "saves" => "saves",
            "screenshots" => "screenshots",
            "mods" => "mods",
            "datapacks" => "datapacks",
            "resourcepacks" => "resourcepacks",
            "shaderpacks" => "shaderpacks",
            _ => null,
        };
        if (sub == null) return string.Empty;
        var full = versionIsolation
            ? Path.Combine(gameDir, "versions", gameVersion, sub)
            : Path.Combine(gameDir, sub);
        if (!Directory.Exists(full)) Directory.CreateDirectory(full);
        return full;
    }

    [HttpGet("saves")]
    public ActionResult<List<FileEntry>> GetSaves(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var savesDir = GetCategoryDir(gameDir, inst.Name, isolation, "saves");
        if (!Directory.Exists(savesDir)) return Ok(new List<FileEntry>());
        return Ok(Directory.GetDirectories(savesDir).Select(d => new FileEntry
        {
            Name = Path.GetFileName(d),
            IsDirectory = true,
            LastModified = System.IO.Directory.GetLastWriteTime(d),
            Created = System.IO.Directory.GetCreationTime(d),
        }).ToList());
    }

    [HttpDelete("saves")]
    public IActionResult DeleteSave(string instanceId, [FromQuery] string name)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var savesDir = GetCategoryDir(gameDir, inst.Name, isolation, "saves");
        var path = Path.Combine(savesDir, name);
        if (!Directory.Exists(path)) return NotFound();
        Common.FileTrash.MoveDirectory(path, gameDir);
        return NoContent();
    }

    [HttpPost("saves/copy")]
    public IActionResult CopySave(string instanceId, [FromBody] CopySaveRequest request)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var savesDir = GetCategoryDir(gameDir, inst.Name, isolation, "saves");
        var src = Path.Combine(savesDir, request.Name);
        if (!Directory.Exists(src)) return NotFound();
        var dst = Path.Combine(savesDir, request.NewName);
        CopyDirectory(src, dst);
        return Ok();
    }

    [HttpGet("screenshots")]
    public ActionResult<List<FileEntry>> GetScreenshots(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var dir = GetCategoryDir(gameDir, inst.Name, isolation, "screenshots");
        if (!Directory.Exists(dir)) return Ok(new List<FileEntry>());
        return Ok(Directory.GetFiles(dir).Select(f => new FileEntry
        {
            Name = Path.GetFileName(f),
            Size = new FileInfo(f).Length,
            LastModified = System.IO.Directory.GetLastWriteTime(f),
            Extension = Path.GetExtension(f).ToLower(),
        }).ToList());
    }

    [HttpDelete("screenshots")]
    public IActionResult DeleteScreenshot(string instanceId, [FromQuery] string name)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var dir = GetCategoryDir(gameDir, inst.Name, isolation, "screenshots");
        var path = Path.Combine(dir, name);
        if (!System.IO.File.Exists(path)) return NotFound();
        Common.FileTrash.MoveFile(path, gameDir);
        return NoContent();
    }

    [HttpGet("mods")]
    public ActionResult<List<FileEntry>> GetMods(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var dir = GetCategoryDir(gameDir, inst.Name, isolation, "mods");
        if (!Directory.Exists(dir)) return Ok(new List<FileEntry>());
        return Ok(Directory.GetFiles(dir).Select(f => new FileEntry
        {
            Name = Path.GetFileName(f),
            Size = new FileInfo(f).Length,
            LastModified = System.IO.Directory.GetLastWriteTime(f),
            Extension = Path.GetExtension(f).ToLower(),
        }).ToList());
    }

    [HttpDelete("mods")]
    public IActionResult DeleteMod(string instanceId, [FromQuery] string name)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var dir = GetCategoryDir(gameDir, inst.Name, isolation, "mods");
        var path = Path.Combine(dir, name);
        if (!System.IO.File.Exists(path)) return NotFound();
        Common.FileTrash.MoveFile(path, gameDir);
        return NoContent();
    }

    [HttpGet("mods/count")]
    public ActionResult<int> GetModsCount(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var modsDir = GetCategoryDir(gameDir, inst.Name, isolation, "mods");
        if (!Directory.Exists(modsDir)) return Ok(0);
        var count = Directory.GetFiles(modsDir, "*.jar").Length + Directory.GetFiles(modsDir, "*.disabled").Length;
        return Ok(count);
    }

    [HttpGet("mods/progress")]
    public ActionResult<ModLoadProgress?> GetModsProgress(string instanceId)
    {
        return Ok(ModLoadProgressStore.GetValueOrDefault(instanceId));
    }

    [HttpGet("mods/metadata")]
    public async Task<ActionResult<List<ModMetadataDto>>> GetModsMetadata(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();

        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";

        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var modsDir = GetCategoryDir(gameDir, inst.Name, isolation, "mods");

        var totalCount = Directory.Exists(modsDir)
            ? Directory.GetFiles(modsDir, "*.jar").Length + Directory.GetFiles(modsDir, "*.disabled").Length
            : 0;
        var progress = new ModLoadProgress(0, totalCount);
        ModLoadProgressStore[instanceId] = progress;

        try
        {
            Trace.WriteLine(new { instanceId, inst.Name, inst.VersionDirName, inst.Loader, inst.LoaderVersion, apiKey, modsDir, totalCount, inst.Id, inst.VersionIsolation });
            var mods = new Mods(gameDir, inst.Name, isolation, apiKey);
            var modList = await mods.GetModList((current, total) =>
            {
                progress.Current = current;
                progress.Total = total;
            });
            var names = modList.Select(m => m.Name).Where(n => n != null).Distinct().ToList();
            var lookupResult = _mcmod.BatchLookupWithIds(names);

            var result = modList.Select(m =>
            {
                var (cnName, mcmodId) = m.Name != null ? lookupResult.GetValueOrDefault(m.Name, (null, null)) : (null, null);
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
                    IconBase64 = m.Icon,
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
        finally
        {
            ModLoadProgressStore.TryRemove(instanceId, out _);
        }
    }

    [HttpPost("mods/enable")]
    public IActionResult EnableMod(string instanceId, [FromQuery] string name)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var modsDir = GetCategoryDir(gameDir, inst.Name, isolation, "mods");
        var fileName = name.EndsWith(".disabled", StringComparison.OrdinalIgnoreCase) ? name : name + ".disabled";
        var filePath = Path.Combine(modsDir, fileName);
        if (!System.IO.File.Exists(filePath))
        {
            var altPath = Path.Combine(modsDir, name);
            if (!System.IO.File.Exists(altPath)) return NotFound();
            return NoContent();
        }

        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
        var mods = new Mods(gameDir, inst.Name, isolation, apiKey);
        mods.EnableMod(filePath);
        return NoContent();
    }

    [HttpPost("mods/disable")]
    public IActionResult DisableMod(string instanceId, [FromQuery] string name)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var modsDir = GetCategoryDir(gameDir, inst.Name, isolation, "mods");
        var filePath = Path.Combine(modsDir, name);
        if (!System.IO.File.Exists(filePath)) return NotFound();

        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
        var mods = new Mods(gameDir, inst.Name, isolation, apiKey);
        mods.DisableMod(filePath);
        return NoContent();
    }

    [HttpPost("mods/change-version")]
    public async Task<IActionResult> ChangeModVersion(string instanceId, [FromBody] ChangeModVersionRequest request)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var modsDir = GetCategoryDir(gameDir, inst.Name, isolation, "mods");

        var oldPath = Path.Combine(modsDir, request.FileName);
        var oldBak = oldPath + ".bak";
        if (System.IO.File.Exists(oldPath))
            System.IO.File.Move(oldPath, oldBak);

        var disabledPath = Path.Combine(modsDir, request.FileName + ".disabled");
        var disabledBak = disabledPath + ".bak";
        if (System.IO.File.Exists(disabledPath))
            System.IO.File.Move(disabledPath, disabledBak);

        var newPath = Path.Combine(modsDir, request.NewFileName);
        try
        {
            using var client = _httpClientFactory.CreateClient();
            var response = await client.GetAsync(request.DownloadUrl);
            if (!response.IsSuccessStatusCode)
            {
                RollbackBackups(oldBak, oldPath, disabledBak, disabledPath);
                return BadRequest(new { error = "下载失败" });
            }
            await using var stream = await response.Content.ReadAsStreamAsync();
            await using var file = System.IO.File.Create(newPath);
            await stream.CopyToAsync(file);

            if (System.IO.File.Exists(oldBak)) System.IO.File.Delete(oldBak);
            if (System.IO.File.Exists(disabledBak)) System.IO.File.Delete(disabledBak);

            return NoContent();
        }
        catch
        {
            RollbackBackups(oldBak, oldPath, disabledBak, disabledPath);
            throw;
        }
    }

    private static void RollbackBackups(string oldBak, string oldPath, string disabledBak, string disabledPath)
    {
        if (System.IO.File.Exists(oldBak))
            System.IO.File.Move(oldBak, oldPath);
        if (System.IO.File.Exists(disabledBak))
            System.IO.File.Move(disabledBak, disabledPath);
    }

    [HttpPost("mods/install")]
    public async Task<IActionResult> InstallMod(string instanceId, [FromBody] InstallModRequest request)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var dir = GetCategoryDir(gameDir, inst.Name, isolation, "mods");
        var path = Path.Combine(dir, request.FileName);
        using var client = _httpClientFactory.CreateClient();
        var response = await client.GetAsync(request.DownloadUrl);
        if (!response.IsSuccessStatusCode)
            return BadRequest(new { error = "下载失败" });
        await using var stream = await response.Content.ReadAsStreamAsync();
        await using var file = System.IO.File.Create(path);
        await stream.CopyToAsync(file);
        return Ok(new { name = request.FileName });
    }

    [HttpPost("mods/batch-enable")]
    public IActionResult BatchEnableMods(string instanceId, [FromBody] List<string> names)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var modsDir = GetCategoryDir(gameDir, inst.Name, isolation, "mods");
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
        var mods = new Mods(gameDir, inst.Name, isolation, apiKey);

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
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var modsDir = GetCategoryDir(gameDir, inst.Name, isolation, "mods");
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
        var mods = new Mods(gameDir, inst.Name, isolation, apiKey);

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
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var modsDir = GetCategoryDir(gameDir, inst.Name, isolation, "mods");

        foreach (var name in names)
        {
            var path = Path.Combine(modsDir, name);
            if (System.IO.File.Exists(path))
                Common.FileTrash.MoveFile(path, gameDir);
            var disabledPath = Path.Combine(modsDir, name + ".disabled");
            if (System.IO.File.Exists(disabledPath))
                Common.FileTrash.MoveFile(disabledPath, gameDir);
        }
        return NoContent();
    }

    [HttpGet("resourcepacks")]
    public ActionResult<List<FileEntry>> GetResourcePacks(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var dir = GetCategoryDir(gameDir, inst.Name, isolation, "resourcepacks");
        if (!Directory.Exists(dir)) return Ok(new List<FileEntry>());
        return Ok(Directory.GetFiles(dir).Select(f => new FileEntry
        {
            Name = Path.GetFileName(f),
            Size = new FileInfo(f).Length,
            LastModified = System.IO.Directory.GetLastWriteTime(f),
            Extension = Path.GetExtension(f).ToLower(),
        }).ToList());
    }

    [HttpDelete("resourcepacks")]
    public IActionResult DeleteResourcePack(string instanceId, [FromQuery] string name)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var dir = GetCategoryDir(gameDir, inst.Name, isolation, "resourcepacks");
        var path = Path.Combine(dir, name);
        if (!System.IO.File.Exists(path)) return NotFound();
        Common.FileTrash.MoveFile(path, gameDir);
        return NoContent();
    }

    [HttpGet("resourcepacks/metadata")]
    public async Task<ActionResult<List<ResourcePackMetadataDto>>> GetResourcePacksMetadata(string instanceId)
    {
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";

        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();

        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();

        var rp = new Resourcepack(gameDir, inst.Name, isolation, apiKey);
        var list = await rp.GetResourcePackList();

        var result = list.Select(m =>
        {
            string? source = null;
            if (m.CurseForgeId > 0) source = "curseforge";
            else if (!string.IsNullOrEmpty(m.ModrinthId)) source = "modrinth";

            return new ResourcePackMetadataDto
            {
                FileName = Path.GetFileName(m.FilePath),
                Name = m.Name,
                Description = m.Description ?? string.Empty,
                Version = m.Version ?? string.Empty,
                PackFormat = m.PackFormat,
                IconBase64 = string.IsNullOrEmpty(m.Icon) ? null : m.Icon,
                CurseForgeId = m.CurseForgeId > 0 ? m.CurseForgeId : null,
                ModrinthId = string.IsNullOrEmpty(m.ModrinthId) ? null : m.ModrinthId,
                Source = source,
            };
        }).ToList();

        return Ok(result);
    }

    [HttpGet("shaderpacks/metadata")]
    public async Task<ActionResult<List<ShaderMetadataDto>>> GetShaderPacksMetadata(string instanceId)
    {
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";

        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();

        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();

        var shaders = new Shaders(gameDir, inst.Name, isolation, apiKey);
        var list = await shaders.GetShaderList();

        var result = list.Select(m =>
        {
            string? source = null;
            if (m.CurseForgeId > 0) source = "curseforge";
            else if (!string.IsNullOrEmpty(m.ModrinthId)) source = "modrinth";

            return new ShaderMetadataDto
            {
                FileName = Path.GetFileName(m.FilePath),
                Name = m.Name ?? string.Empty,
                Description = m.Description ?? string.Empty,
                Version = m.Version ?? string.Empty,
                IconBase64 = string.IsNullOrEmpty(m.Icon) ? null : m.Icon,
                CurseForgeId = m.CurseForgeId > 0 ? m.CurseForgeId : null,
                ModrinthId = string.IsNullOrEmpty(m.ModrinthId) ? null : m.ModrinthId,
                Source = source,
            };
        }).ToList();

        return Ok(result);
    }

    [HttpGet("saves/metadata")]
    public ActionResult<List<SaveMetadataDto>> GetSavesMetadata(string instanceId)
    {
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";

        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();

        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();

        var saves = new Saves(gameDir, inst.Name, isolation, apiKey);
        var list = saves.GetSaveList();

        var result = list.Select(s => new SaveMetadataDto
        {
            Name = s.Name,
            FilePath = s.FilePath,
            LastPlayed = s.LastPlayed,
            IconBase64 = string.IsNullOrEmpty(s.Icon) ? null : s.Icon,
        }).ToList();

        return Ok(result);
    }

    [HttpPost("saves/rename")]
    public IActionResult RenameSave(string instanceId, [FromBody] RenameSaveRequest request)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
        var saves = new Saves(gameDir, inst.Name, isolation, apiKey);

        var savesDir = GetCategoryDir(gameDir, inst.Name, isolation, "saves");
        var savePath = Path.Combine(savesDir, request.OldName);
        if (!Directory.Exists(savePath)) return NotFound();
        saves.RenameSave(savePath, request.NewName);
        return NoContent();
    }

    [HttpPost("saves/backup")]
    public IActionResult BackupSave(string instanceId, [FromQuery] string name)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
        var saves = new Saves(gameDir, inst.Name, isolation, apiKey);

        var savesDir = GetCategoryDir(gameDir, inst.Name, isolation, "saves");
        var savePath = Path.Combine(savesDir, name);
        if (!Directory.Exists(savePath)) return NotFound();
        saves.BackupSave(savePath);
        return NoContent();
    }

    [HttpGet("screenshots/metadata")]
    public ActionResult<List<ScreenshotMetadataDto>> GetScreenshotsMetadata(string instanceId)
    {
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";

        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();

        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();

        var screenshots = new Screenshots(gameDir, inst.Name, isolation, apiKey);
        var list = screenshots.GetScreenshotList();

        var result = list.Select(s => new ScreenshotMetadataDto
        {
            FileName = s.FileName,
            FilePath = s.FilePath,
            CreatedAt = s.CreatedAt,
            FileSize = s.FileSize,
        }).ToList();

        return Ok(result);
    }

    [HttpGet("datapacks")]
    public ActionResult<List<FileEntry>> GetDataPacks(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var dir = GetCategoryDir(gameDir, inst.Name, isolation, "datapacks");
        if (!Directory.Exists(dir)) return Ok(new List<FileEntry>());
        return Ok(Directory.GetFiles(dir).Select(f => new FileEntry
        {
            Name = Path.GetFileName(f),
            Size = new FileInfo(f).Length,
            LastModified = System.IO.Directory.GetLastWriteTime(f),
            Extension = Path.GetExtension(f).ToLower(),
        }).ToList());
    }

    [HttpGet("datapacks/metadata")]
    public async Task<ActionResult<List<DataPackMetadataDto>>> GetDataPacksMetadata(string instanceId)
    {
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";

        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();

        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();

        var dp = new DataPacks(gameDir, inst.Name, isolation, apiKey);
        var list = await dp.GetDataPackList();

        var result = list.Select(m =>
        {
            string? source = null;
            if (m.CurseForgeId > 0) source = "curseforge";
            else if (!string.IsNullOrEmpty(m.ModrinthId)) source = "modrinth";

            return new DataPackMetadataDto
            {
                FileName = Path.GetFileName(m.FilePath),
                Name = m.Name,
                Description = m.Description ?? string.Empty,
                Version = m.Version ?? string.Empty,
                PackFormat = m.PackFormat,
                IconBase64 = string.IsNullOrEmpty(m.Icon) ? null : m.Icon,
                CurseForgeId = m.CurseForgeId > 0 ? m.CurseForgeId : null,
                ModrinthId = string.IsNullOrEmpty(m.ModrinthId) ? null : m.ModrinthId,
                Source = source,
            };
        }).ToList();

        return Ok(result);
    }

    [HttpDelete("datapacks")]
    public IActionResult DeleteDataPack(string instanceId, [FromQuery] string name)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var dir = GetCategoryDir(gameDir, inst.Name, isolation, "datapacks");
        var path = Path.Combine(dir, name);
        if (!System.IO.File.Exists(path)) return NotFound();
        Common.FileTrash.MoveFile(path, gameDir);
        return NoContent();
    }

    [HttpGet("shaderpacks")]
    public ActionResult<List<FileEntry>> GetShaderPacks(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var dir = GetCategoryDir(gameDir, inst.Name, isolation, "shaderpacks");
        if (!Directory.Exists(dir)) return Ok(new List<FileEntry>());
        return Ok(Directory.GetFiles(dir).Select(f => new FileEntry
        {
            Name = Path.GetFileName(f),
            Size = new FileInfo(f).Length,
            LastModified = System.IO.Directory.GetLastWriteTime(f),
            Extension = Path.GetExtension(f).ToLower(),
        }).ToList());
    }

    [HttpGet("installed-names")]
    public ActionResult<List<string>> GetInstalledNames(string instanceId, [FromQuery] string category = "mods")
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var dir = GetCategoryDir(gameDir, inst.Name, isolation, category);
        if (string.IsNullOrEmpty(dir)) return Ok(new List<string>());
        if (!Directory.Exists(dir)) return Ok(new List<string>());
        return Ok(Directory.GetFiles(dir).Select(Path.GetFileName).ToList());
    }

    [HttpDelete("shaderpacks")]
    public IActionResult DeleteShaderPack(string instanceId, [FromQuery] string name)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var gameDir = ResolveGameDir(inst);
        var isolation = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        var dir = GetCategoryDir(gameDir, inst.Name, isolation, "shaderpacks");
        var path = Path.Combine(dir, name);
        if (!System.IO.File.Exists(path)) return NotFound();
        Common.FileTrash.MoveFile(path, gameDir);
        return NoContent();
    }

    [HttpGet("servers")]
    public ActionResult<List<Models.ServerEntry>> GetServers(string instanceId)
    {
        var (helper, dir) = CreateServerHelper(instanceId);
        if (helper == null) return NotFound();
        return Ok(helper.GetServers().Select(MapServerEntry).ToList());
    }

    [HttpPost("servers")]
    public IActionResult AddServer(string instanceId, [FromBody] AddServerRequest request)
    {
        var (helper, dir) = CreateServerHelper(instanceId);
        if (helper == null) return NotFound();
        helper.AddOrUpdateServer(new Qomicex.Core.Modules.Helpers.GameSettings.ServerEntry { Name = request.Name, Address = request.Ip });
        return Ok();
    }

    [HttpDelete("servers")]
    public IActionResult DeleteServer(string instanceId, [FromQuery] string ip)
    {
        var (helper, dir) = CreateServerHelper(instanceId);
        if (helper == null) return NotFound();
        if (!helper.RemoveServer(ip)) return NotFound();
        return NoContent();
    }

    [HttpGet("lan-games")]
    public ActionResult<List<LanGameEntry>> GetLanGames(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        return Ok(_lanListener.GetGames());
    }

    [HttpGet("server-ping")]
    public ActionResult<ServerStateResult> PingServer(string instanceId, [FromQuery] string address)
    {
        var (helper, dir) = CreateServerHelper(instanceId);
        if (helper == null) return NotFound();
        var state = helper.GetServerStateByAddress(address);
        return Ok(new ServerStateResult
        {
            Name = state.Name,
            Address = state.Address,
            IsOnline = state.IsOnline,
            Ping = state.Ping,
            OnlinePlayers = state.OnlinePlayers,
            MaxPlayers = state.MaxPlayers,
            Version = state.Version,
            Description = state.Description,
            ErrorMessage = state.ErrorMessage,
        });
    }

    private (ServersHelper? helper, string? dir) CreateServerHelper(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return (null, null);
        var gameDir = ResolveGameDir(inst);
        var versionSpecific = inst.VersionIsolation ?? InstanceController.GetGlobalVersionIsolation();
        return (new ServersHelper(gameDir, inst.Name, versionSpecific), gameDir);
    }

    private static Models.ServerEntry MapServerEntry(Qomicex.Core.Modules.Helpers.GameSettings.ServerEntry s)
    {
        return new Models.ServerEntry
        {
            Name = s.Name,
            Ip = s.Address,
            IconBase64 = s.IconBase64,
            AcceptTextures = s.AcceptTextures,
        };
    }

    private static void CopyDirectory(string src, string dst)
    {
        Directory.CreateDirectory(dst);
        foreach (var f in Directory.GetFiles(src))
            System.IO.File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), true);
        foreach (var d in Directory.GetDirectories(src))
            CopyDirectory(d, Path.Combine(dst, Path.GetFileName(d)));
    }
}

public class ModLoadProgress
{
    public int Current { get; set; }
    public int Total { get; set; }
    public ModLoadProgress(int current, int total) { Current = current; Total = total; }
}
