using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Models;
using Qomicex.Launcher.Backend.Services;
using Qomicex.Core.Modules.Helpers.GameSettings;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/instance/{instanceId}/files")]
public class InstanceFilesController : ControllerBase
{
    private readonly IInstanceRepository _repository;
    private readonly IHttpClientFactory _httpClientFactory;

    public InstanceFilesController(IInstanceRepository repository, IHttpClientFactory httpClientFactory)
    {
        _repository = repository;
        _httpClientFactory = httpClientFactory;
    }

    private string? ResolveGameDir(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return null;
        var dir = inst.GameDir;
        if (!Path.IsPathRooted(dir))
            dir = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), dir));

        var versionsDir = Path.Combine(dir, "versions");
        if (Directory.Exists(versionsDir))
        {
            var expectedId = !string.IsNullOrEmpty(inst.Loader) && !string.IsNullOrEmpty(inst.LoaderVersion)
                ? $"{inst.GameVersion}-{inst.Loader}-{inst.LoaderVersion}"
                : inst.GameVersion;
            var expectedDir = Path.Combine(versionsDir, expectedId);
            if (Directory.Exists(expectedDir))
                return expectedDir;
        }

        return dir;
    }

    private string? GetPath(string instanceId, string category, out string? dir)
    {
        dir = ResolveGameDir(instanceId);
        if (dir == null) return null;
        var sub = category switch
        {
            "saves" => "saves",
            "screenshots" => "screenshots",
            "mods" => "mods",
            "resourcepacks" => "resourcepacks",
            "shaderpacks" => "shaderpacks",
            _ => null,
        };
        if (sub == null) return null;
        var full = Path.Combine(dir, sub);
        if (!Directory.Exists(full)) Directory.CreateDirectory(full);
        return full;
    }

    [HttpGet("saves")]
    public ActionResult<List<FileEntry>> GetSaves(string instanceId)
    {
        var gameDir = ResolveGameDir(instanceId);
        if (gameDir == null) return NotFound();
        var savesDir = Path.Combine(gameDir, "saves");
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
        var gameDir = ResolveGameDir(instanceId);
        if (gameDir == null) return NotFound();
        var path = Path.Combine(gameDir, "saves", name);
        if (!Directory.Exists(path)) return NotFound();
        Directory.Delete(path, true);
        return NoContent();
    }

    [HttpPost("saves/copy")]
    public IActionResult CopySave(string instanceId, [FromBody] CopySaveRequest request)
    {
        var gameDir = ResolveGameDir(instanceId);
        if (gameDir == null) return NotFound();
        var src = Path.Combine(gameDir, "saves", request.Name);
        if (!Directory.Exists(src)) return NotFound();
        var dst = Path.Combine(gameDir, "saves", request.NewName);
        CopyDirectory(src, dst);
        return Ok();
    }

    [HttpGet("screenshots")]
    public ActionResult<List<FileEntry>> GetScreenshots(string instanceId)
    {
        var gameDir = ResolveGameDir(instanceId);
        if (gameDir == null) return NotFound();
        var dir = Path.Combine(gameDir, "screenshots");
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
        var dir = GetPath(instanceId, "screenshots", out var _);
        if (dir == null) return NotFound();
        var path = Path.Combine(dir, name);
        if (!System.IO.File.Exists(path)) return NotFound();
        System.IO.File.Delete(path);
        return NoContent();
    }

    [HttpGet("mods")]
    public ActionResult<List<FileEntry>> GetMods(string instanceId)
    {
        var gameDir = ResolveGameDir(instanceId);
        if (gameDir == null) return NotFound();
        var dir = Path.Combine(gameDir, "mods");
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
        var dir = GetPath(instanceId, "mods", out var _);
        if (dir == null) return NotFound();
        var path = Path.Combine(dir, name);
        if (!System.IO.File.Exists(path)) return NotFound();
        System.IO.File.Delete(path);
        return NoContent();
    }

    [HttpPost("mods/install")]
    public async Task<IActionResult> InstallMod(string instanceId, [FromBody] InstallModRequest request)
    {
        var dir = GetPath(instanceId, "mods", out var _);
        if (dir == null) return NotFound();
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

    [HttpGet("resourcepacks")]
    public ActionResult<List<FileEntry>> GetResourcePacks(string instanceId)
    {
        var gameDir = ResolveGameDir(instanceId);
        if (gameDir == null) return NotFound();
        var dir = Path.Combine(gameDir, "resourcepacks");
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
        var dir = GetPath(instanceId, "resourcepacks", out var _);
        if (dir == null) return NotFound();
        var path = Path.Combine(dir, name);
        if (!System.IO.File.Exists(path)) return NotFound();
        System.IO.File.Delete(path);
        return NoContent();
    }

    [HttpGet("shaderpacks")]
    public ActionResult<List<FileEntry>> GetShaderPacks(string instanceId)
    {
        var gameDir = ResolveGameDir(instanceId);
        if (gameDir == null) return NotFound();
        var dir = Path.Combine(gameDir, "shaderpacks");
        if (!Directory.Exists(dir)) return Ok(new List<FileEntry>());
        return Ok(Directory.GetFiles(dir).Select(f => new FileEntry
        {
            Name = Path.GetFileName(f),
            Size = new FileInfo(f).Length,
            LastModified = System.IO.Directory.GetLastWriteTime(f),
            Extension = Path.GetExtension(f).ToLower(),
        }).ToList());
    }

    [HttpDelete("shaderpacks")]
    public IActionResult DeleteShaderPack(string instanceId, [FromQuery] string name)
    {
        var dir = GetPath(instanceId, "shaderpacks", out var _);
        if (dir == null) return NotFound();
        var path = Path.Combine(dir, name);
        if (!System.IO.File.Exists(path)) return NotFound();
        System.IO.File.Delete(path);
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
        var gameDir = ResolveGameDir(instanceId);
        if (gameDir == null) return (null, null);
        var versionSpecific = inst.VersionIsolation || Directory.Exists(Path.Combine(gameDir, "versions"));
        var versionId = !string.IsNullOrEmpty(inst.Loader) && !string.IsNullOrEmpty(inst.LoaderVersion)
            ? $"{inst.GameVersion}-{inst.Loader}-{inst.LoaderVersion}"
            : inst.GameVersion;
        return (new ServersHelper(gameDir, versionId, versionSpecific), gameDir);
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
