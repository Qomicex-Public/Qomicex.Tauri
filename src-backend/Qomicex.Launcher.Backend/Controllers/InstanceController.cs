using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Models;
using Qomicex.Launcher.Backend.Services;
using static Qomicex.Launcher.Backend.DataModules;
using static Qomicex.Launcher.Backend.DataModules.DataDetails;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class InstanceController : ControllerBase
{
    private readonly IInstanceRepository _repository;
    private readonly InstanceInstallService _installService;

    public InstanceController(IInstanceRepository repository, InstanceInstallService installService)
    {
        _repository = repository;
        _installService = installService;
    }

    [HttpGet]
    public ActionResult<List<GameInstance>> GetAll()
    {
        return Ok(_repository.GetAll());
    }

    [HttpGet("{id}")]
    public ActionResult<GameInstance> GetById(string id)
    {
        var instance = _repository.GetById(id);
        if (instance == null) return NotFound();
        return Ok(instance);
    }

    [HttpPost]
    public ActionResult<GameInstance> Create([FromBody] CreateInstanceRequest request)
    {
        var instance = new GameInstance
        {
            Name = request.Name,
            GameVersion = request.GameVersion,
            Loader = request.Loader,
            LoaderVersion = request.LoaderVersion,
            JavaPath = request.JavaPath,
            MaxMemory = request.MaxMemory,
            GameDir = request.GameDir,
            AccountName = request.AccountName,
            AccountUuid = request.AccountUuid,
            AccessToken = request.AccessToken,
            JvmArgs = request.JvmArgs,
        };
        var created = _repository.Create(instance);
        return CreatedAtAction(nameof(GetById), new { id = created.Id }, created);
    }

    [HttpPost("{id}/install")]
    public IActionResult StartInstall(string id, [FromBody] InstallRequest request)
    {
        var instance = _repository.GetById(id);
        if (instance == null) return NotFound();

        _installService.StartInstall(id, instance.GameVersion, instance.GameDir, request.Loader, request.LoaderVersion, request.Addons, request.DownloadThreads ?? 3, request.VersionIsolation, request.DownloadSourceId, request.DownloadTimeout);

        return Ok(new { message = "安装已开始", instanceId = id });
    }

    [HttpPost("{id}/install/pause")]
    public IActionResult PauseInstall(string id)
    {
        _installService.PauseInstall(id);
        return Ok(new { message = "已暂停" });
    }

    [HttpPost("{id}/install/resume")]
    public IActionResult ResumeInstall(string id)
    {
        _installService.ResumeInstall(id);
        return Ok(new { message = "已继续" });
    }

    [HttpPost("{id}/install/cancel")]
    public IActionResult CancelInstall(string id)
    {
        _installService.CancelInstall(id);
        return Ok(new { message = "已取消" });
    }

    [HttpGet("{id}/install/progress")]
    public ActionResult<InstallProgressResponse> GetInstallProgress(string id)
    {
        var state = _installService.GetState(id);
        if (state == null)
            return Ok(new InstallProgressResponse { Status = "not-started", Progress = 0 });

        return Ok(new InstallProgressResponse
        {
            Status = state.Stage,
            Progress = state.Progress,
            Error = state.Error,
            TotalFiles = state.TotalFiles,
            CompletedFiles = state.CompletedFiles,
            FailedFiles = state.FailedFiles,
            CurrentFile = state.CurrentFile,
            Speed = state.Speed,
            IsPaused = state.IsPaused,
        });
    }

    [HttpPut("{id}")]
    public ActionResult<GameInstance> Update(string id, [FromBody] CreateInstanceRequest request)
    {
        var instance = new GameInstance
        {
            Name = request.Name,
            GameVersion = request.GameVersion,
            Loader = request.Loader,
            LoaderVersion = request.LoaderVersion,
            JavaPath = request.JavaPath,
            MaxMemory = request.MaxMemory,
            GameDir = request.GameDir,
            AccountName = request.AccountName,
            AccountUuid = request.AccountUuid,
            AccessToken = request.AccessToken,
            JvmArgs = request.JvmArgs,
        };
        var updated = _repository.Update(id, instance);
        if (updated == null) return NotFound();
        return Ok(updated);
    }

    [HttpDelete("{id}")]
    public IActionResult Delete(string id)
    {
        if (_repository.Delete(id)) return NoContent();
        return NotFound();
    }

    [HttpPost("{id}/repair")]
    public IActionResult StartRepair(string id, [FromQuery] int? threads)
    {
        var instance = _repository.GetById(id);
        if (instance == null) return NotFound();

        _installService.StartRepair(id, instance.GameVersion, instance.GameDir, 
            instance.Loader, instance.LoaderVersion, threads ?? 3);
        return Ok(new { message = "文件补全已开始", instanceId = id });
    }

    [HttpPost("{id}/launch")]
    public ActionResult<LaunchResult> Launch(string id)
    {
        var instance = _repository.GetById(id);
        if (instance == null) return NotFound();

        try
        {
            var launcher = new Modules.Launcher.Launcher();
            var param = new Modules.Launcher.Launcher.LauncherParam
            {
                Version = instance.GameVersion,
                MaxMemory = instance.MaxMemory.ToString(),
                AdditionalParam = instance.JvmArgs ?? "",
                DevideVersion = false,
                GameDir = instance.GameDir,
                LauncherName = "qomicex",
            };
            param.Account.Name = instance.AccountName ?? "Player";
            param.Account.Uuid = instance.AccountUuid ?? "";
            param.Account.AccessToken = instance.AccessToken ?? "faked-token-for-offline";
            param.Java.Path = instance.JavaPath ?? "java";

            var javaPath = instance.JavaPath ?? "java";

            try
            {
                var verStr = Modules.Helpers.GeneralHelper.GetMinecraftRequireJavaVersion(instance.GameVersion, instance.GameDir);
                param.Java.VersionID = int.TryParse(verStr, out var vid) ? vid : 21;
            }
            catch
            {
                param.Java.VersionID = 21;
            }

            var args = launcher.SelectParam(param, param.LauncherName);

            var versionPath = Path.Combine(instance.GameDir, "versions", instance.GameVersion);
            var jsonPath = Path.Combine(versionPath, $"{instance.GameVersion}.json");
            launcher.UnzipNatives(jsonPath, instance.GameDir, versionPath);

            var psi = new ProcessStartInfo
            {
                FileName = javaPath,
                Arguments = args,
                WorkingDirectory = instance.GameDir,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            var process = System.Diagnostics.Process.Start(psi);
            if (process == null)
            {
                return Ok(new LaunchResult
                {
                    Success = false,
                    Error = "Failed to start process",
                });
            }

            instance.LastPlayed = DateTime.UtcNow;
            _repository.Update(instance.Id, instance);

            return Ok(new LaunchResult
            {
                Success = true,
                ProcessId = process.Id,
                Arguments = args,
            });
        }
        catch (Exception ex)
        {
            return Ok(new LaunchResult
            {
                Success = false,
                Error = ex.Message,
            });
        }
    }
}
