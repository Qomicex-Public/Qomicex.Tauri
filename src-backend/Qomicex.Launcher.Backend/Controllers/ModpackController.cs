using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Models;
using Qomicex.Launcher.Backend.Services;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ModpackController : ControllerBase
{
    private readonly ModpackService _modpackService;
    private readonly InstanceInstallService _installService;
    private readonly IInstanceRepository _repository;

    public ModpackController(ModpackService modpackService,
        InstanceInstallService installService,
        IInstanceRepository repository)
    {
        _modpackService = modpackService;
        _installService = installService;
        _repository = repository;
    }

    [HttpPost("parse")]
    public async Task<IActionResult> Parse(IFormFile file)
    {
        if (file == null || file.Length == 0)
            return BadRequest(new { error = "No file uploaded" });

        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        if (ext != ".mrpack" && ext != ".zip")
            return BadRequest(new { error = "Unsupported file format. Use .mrpack or .zip" });

        var tempPath = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName() + ext);
        try
        {
            await using (var stream = new FileStream(tempPath, FileMode.CreateNew))
                await file.CopyToAsync(stream);

            var result = await _modpackService.ParseModpackFileAsync(tempPath);
            result.Name = result.Name ?? Path.GetFileNameWithoutExtension(file.FileName);

            byte[]? overridesZip = null;
            if (result.HasOverrides)
                overridesZip = _modpackService.ExtractOverridesZip(tempPath);

            return Ok(new
            {
                result.Name,
                result.Summary,
                result.GameVersion,
                Loader = result.Loader.ToString(),
                result.LoaderVersion,
                Source = result.Source.ToString().ToLowerInvariant(),
                result.Files,
                result.HasOverrides,
                FileCount = result.Files.Count,
                OverridesZip = overridesZip != null ? Convert.ToBase64String(overridesZip) : null,
            });
        }
        finally
        {
            if (System.IO.File.Exists(tempPath))
                System.IO.File.Delete(tempPath);
        }
    }

    [HttpPost("resolve")]
    public async Task<IActionResult> Resolve([FromBody] ModpackResolveRequest request)
    {
        var result = await _modpackService.ResolveOnlineAsync(
            request.Source, request.ProjectId, request.VersionId);

        return Ok(new
        {
            result.Name,
            result.GameVersion,
            Loader = result.Loader.ToString(),
            result.LoaderVersion,
            Source = result.Source.ToString().ToLowerInvariant(),
            result.Files,
            FileCount = result.Files.Count,
        });
    }

    [HttpPost("install")]
    public async Task<IActionResult> Install([FromBody] ModpackInstallRequest request)
    {
        var instance = new GameInstance
        {
            Name = request.Name,
            GameVersion = request.GameVersion,
            Loader = request.Loader,
            LoaderVersion = request.LoaderVersion,
            MaxMemory = request.MaxMemory,
            GameDir = request.GameDir,
            VersionIsolation = request.VersionIsolation,
            Icon = GetDefaultIcon(request.Loader),
        };
        var created = _repository.Create(instance);

        if (request.VersionIsolation != false)
        {
            created.VersionDirName = request.Name;
            _repository.Update(created.Id, created);
        }

        _installService.StartModpackInstall(created.Id, request.GameVersion, request.GameDir,
            request.Loader, request.LoaderVersion, created.VersionDirName ?? created.Name,
            request.DownloadThreads ?? 64, request.VersionIsolation != false,
            request.ModpackFiles, request.OverridesZip, created.JavaPath);

        return Ok(new { message = "整合包安装已开始", instanceId = created.Id });
    }

    private static string GetDefaultIcon(string? loader) => loader?.ToLowerInvariant() switch
    {
        "forge" => "Anvil",
        "neoforge" => "NeoForge",
        "fabric" => "Fabric",
        "quilt" => "Quilt",
        _ => "Grass",
    };
}

public class ModpackResolveRequest
{
    public string Source { get; set; } = "";
    public string ProjectId { get; set; } = "";
    public string VersionId { get; set; } = "";
}

public class ModpackInstallRequest
{
    public string Name { get; set; } = "";
    public string GameVersion { get; set; } = "";
    public string? Loader { get; set; }
    public string? LoaderVersion { get; set; }
    public int MaxMemory { get; set; } = 4096;
    public string GameDir { get; set; } = "";
    public bool VersionIsolation { get; set; } = true;
    public int? DownloadThreads { get; set; }
    public List<ModpackFileEntry> ModpackFiles { get; set; } = [];
    public byte[]? OverridesZip { get; set; }
}
