using System.Diagnostics;
using System.IO;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Models;
using Qomicex.Launcher.Backend.Services;
using Qomicex.Core.Modules.Helpers;
using static Qomicex.Core.DataModules;
using static Qomicex.Core.DataModules.DataDetails;
using Microsoft.Extensions.Logging;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class InstanceController : ControllerBase
{
    private readonly IInstanceRepository _repository;
    private readonly InstanceInstallService _installService;
    private readonly AccountService _accountService;
    private readonly ILogger<InstanceController> _logger;

    public InstanceController(IInstanceRepository repository, InstanceInstallService installService, AccountService accountService, ILogger<InstanceController> logger)
    {
        _repository = repository;
        _installService = installService;
        _accountService = accountService;
        _logger = logger;
    }

    [HttpGet]
    public ActionResult<List<GameInstance>> GetAll()
    {
        return Ok(_repository.GetAll());
    }

    [HttpGet("default")]
    public ActionResult<GameInstance?> GetDefault()
    {
        return Ok(_repository.GetDefault());
    }

    [HttpPut("{id}/default")]
    public IActionResult SetDefault(string id)
    {
        var instance = _repository.GetById(id);
        if (instance == null) return NotFound();
        foreach (var inst in _repository.GetAll())
        {
            if (inst.IsDefault)
            {
                inst.IsDefault = false;
                _repository.Update(inst.Id, inst);
            }
        }
        instance.IsDefault = true;
        _repository.Update(instance.Id, instance);
        return Ok(instance);
    }

    [HttpDelete("{id}/default")]
    public IActionResult ClearDefault(string id)
    {
        var instance = _repository.GetById(id);
        if (instance == null) return NotFound();
        instance.IsDefault = false;
        _repository.Update(instance.Id, instance);
        return NoContent();
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
            VersionIsolation = request.VersionIsolation,
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
        var existing = _repository.GetById(id);
        if (existing == null) return NotFound();
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
            VersionIsolation = request.VersionIsolation,
            IsDefault = existing.IsDefault,
        };
        var updated = _repository.Update(id, instance);
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
            var versionId = !string.IsNullOrEmpty(instance.Loader) && !string.IsNullOrEmpty(instance.LoaderVersion)
                ? $"{instance.GameVersion}-{instance.Loader}-{instance.LoaderVersion}"
                : instance.GameVersion;

            var launcher = new Qomicex.Core.Modules.Launcher.Launcher();
            var param = new Qomicex.Core.Modules.Launcher.Launcher.LauncherParam
            {
                Version = versionId,
                MaxMemory = instance.MaxMemory.ToString(),
                AdditionalParam = instance.JvmArgs ?? "",
                DevideVersion = instance.VersionIsolation,
                GameDir = instance.GameDir,
                LauncherName = "qomicex",
            };

            param.Account.Name = "Player";
            param.Account.Uuid = "";
            param.Account.AccessToken = "faked-token-for-offline";
            var defaultAccount = _accountService.GetDefaultAsync().GetAwaiter().GetResult();
            if (defaultAccount != null)
            {
                param.Account.Name = defaultAccount.Name;
                param.Account.Uuid = defaultAccount.Uuid;
                param.Account.AccessToken = string.IsNullOrEmpty(defaultAccount.AccessToken) ? "faked-token-for-offline" : defaultAccount.AccessToken;
            }

            string javaPath;
            if (!string.IsNullOrEmpty(instance.JavaPath))
            {
                javaPath = instance.JavaPath;
            }
            else
            {
                var javaList = JavaHelper.SearchJava(new JavaHelper.JavaSearchOptions { Mode = JavaHelper.JavaSearchMode.Quick });
                var recommended = JavaHelper.GetRecommendedJava(javaList, instance.GameVersion, instance.GameDir);
                var chosen = recommended.FirstOrDefault();
                javaPath = chosen?.Path ?? "java";
                param.Java.Path = javaPath;
                param.Java.VersionID = chosen?.VersionID ?? 21;
            }

            if (param.Java.VersionID == 0)
            {
                try
                {
                    var verStr = GeneralHelper.GetMinecraftRequireJavaVersion(instance.GameVersion, instance.GameDir);
                    param.Java.VersionID = int.TryParse(verStr, out var vid) ? vid : 21;
                }
                catch
                {
                    param.Java.VersionID = 21;
                }
            }

            var args = launcher.SelectParam(param, param.LauncherName);

            _logger.LogInformation("Launch {Instance} versionId={VersionId} java={JavaPath} versionID={JavaVer} DevideVersion={Devide}", instance.Name, versionId, javaPath, param.Java.VersionID, instance.VersionIsolation);
            _logger.LogInformation("Launch args: {Args}", args);

            var versionPath = Path.Combine(instance.GameDir, "versions", versionId);
            var jsonPath = Path.Combine(versionPath, $"{versionId}.json");
            launcher.UnzipNatives(jsonPath, instance.GameDir, versionPath);

            var logsDir = Path.Combine(instance.GameDir, "logs");
            System.IO.Directory.CreateDirectory(logsDir);
            var stderrPath = System.IO.Path.Combine(logsDir, "launcher-latest.log");

            var psi = new ProcessStartInfo
            {
                FileName = javaPath,
                Arguments = args,
                WorkingDirectory = instance.GameDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                StandardErrorEncoding = Encoding.UTF8,
                StandardOutputEncoding = Encoding.UTF8,
            };

            using var process = System.Diagnostics.Process.Start(psi);
            if (process == null)
            {
                return Ok(new LaunchResult
                {
                    Success = false,
                    Error = "无法启动 Java 进程",
                });
            }

            process.ErrorDataReceived += (_, e) =>
            {
                if (e.Data != null) System.IO.File.AppendAllText(stderrPath, e.Data + Environment.NewLine);
            };
            process.BeginErrorReadLine();

            // Capture initial output for crash detection (wait briefly for immediate failures)
            var stdout = new StringBuilder();
            process.OutputDataReceived += (_, e) =>
            {
                if (e.Data != null) stdout.AppendLine(e.Data);
            };
            process.BeginOutputReadLine();

            if (!process.WaitForExit(5000))
            {
                instance.LastPlayed = DateTime.UtcNow;
                _repository.Update(instance.Id, instance);
                return Ok(new LaunchResult
                {
                    Success = true,
                    ProcessId = process.Id,
                    Arguments = args,
                });
            }

            // Process exited within 5s — likely a crash
            var stderr = System.IO.File.Exists(stderrPath) ? System.IO.File.ReadAllText(stderrPath) : "";
            var output = stdout.ToString();
            return Ok(new LaunchResult
            {
                Success = false,
                Error = "游戏进程异常退出",
                Detail = string.IsNullOrEmpty(stderr) ? output : stderr,
                Arguments = args,
            });
        }
        catch (Exception ex)
        {
            return Ok(new LaunchResult
            {
                Success = false,
                Error = ex.Message,
                Detail = ex.ToString(),
            });
        }
    }
}
