using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Qomicex.Launcher.Backend.Models;
using Qomicex.Launcher.Backend.Services;
using Qomicex.Core.Modules.Helpers;
using Qomicex.Core.Modules.Helpers.Resources;
using static Qomicex.Core.DataModules;
using static Qomicex.Core.DataModules.DataDetails;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class InstanceController : ControllerBase
{
    private readonly IInstanceRepository _repository;
    private readonly InstanceInstallService _installService;
    private readonly AccountService _accountService;
    private readonly JavaRuntimeStore _javaRuntimeStore;
    private readonly LaunchService _launchService;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<InstanceController> _logger;

    public InstanceController(IInstanceRepository repository, InstanceInstallService installService, AccountService accountService, JavaRuntimeStore javaRuntimeStore, LaunchService launchService, IHttpClientFactory httpClientFactory, ILogger<InstanceController> logger)
    {
        _repository = repository;
        _installService = installService;
        _accountService = accountService;
        _javaRuntimeStore = javaRuntimeStore;
        _launchService = launchService;
        _httpClientFactory = httpClientFactory;
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
            Icon = request.Icon ?? GetDefaultIcon(request.Loader),
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
    public ActionResult<GameInstance> Update(string id, [FromBody] JsonElement body)
    {
        var existing = _repository.GetById(id);
        if (existing == null) return NotFound();

        if (body.TryGetProperty("name", out var nameProp)) existing.Name = nameProp.GetString() ?? existing.Name;
        if (body.TryGetProperty("gameVersion", out var gvProp)) existing.GameVersion = gvProp.GetString() ?? existing.GameVersion;
        if (body.TryGetProperty("loader", out var loaderProp)) existing.Loader = loaderProp.GetString();
        if (body.TryGetProperty("loaderVersion", out var lvProp)) existing.LoaderVersion = lvProp.GetString();
        if (body.TryGetProperty("javaPath", out var jpProp)) existing.JavaPath = jpProp.GetString();
        if (body.TryGetProperty("maxMemory", out var memProp)) existing.MaxMemory = (int)memProp.GetInt64();
        if (body.TryGetProperty("gameDir", out var gdProp)) existing.GameDir = gdProp.GetString() ?? existing.GameDir;
        if (body.TryGetProperty("accountName", out var anProp)) existing.AccountName = anProp.GetString();
        if (body.TryGetProperty("accountUuid", out var auProp)) existing.AccountUuid = auProp.GetString();
        if (body.TryGetProperty("accessToken", out var atProp)) existing.AccessToken = atProp.GetString();
        if (body.TryGetProperty("jvmArgs", out var jaProp)) existing.JvmArgs = jaProp.GetString();
        if (body.TryGetProperty("versionIsolation", out var viProp))
        {
            existing.VersionIsolation = viProp.ValueKind == System.Text.Json.JsonValueKind.Null ? null : viProp.GetBoolean();
        }
        if (body.TryGetProperty("icon", out var iconProp)) existing.Icon = iconProp.GetString();
        if (body.TryGetProperty("skipIntegrityCheck", out var sicProp)) existing.SkipIntegrityCheck = sicProp.GetBoolean();

        var updated = _repository.Update(id, existing);
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

    [HttpGet("{id}/verify-resources")]
    public async Task<ActionResult<VerifyResourcesResult>> VerifyResources(string id)
    {
        var instance = _repository.GetById(id);
        if (instance == null) return NotFound();

        var versionId = instance.Name;
        var resourceHelper = new LocalResourceHelper();
        var missFiles = FilterMissFiles(await resourceHelper.GetAllMissFilesAsync(versionId, instance.GameDir));

        var result = new VerifyResourcesResult
        {
            TotalCount = missFiles.Count,
            Complete = missFiles.Count == 0,
            MissingFiles = missFiles.Select(f => new MissingFileInfo
            {
                Name = f.Name,
                Path = f.Path,
                Url = f.Url,
                Sha1 = f.Sha1,
            }).ToList(),
        };

        return Ok(result);
    }

    [HttpPost("{id}/repair-resources")]
    public async Task<IActionResult> RepairResources(string id)
    {
        var instance = _repository.GetById(id);
        if (instance == null) return NotFound();

        var versionId = instance.Name;
        var resourceHelper = new LocalResourceHelper();
        var missFiles = FilterMissFiles(await resourceHelper.GetAllMissFilesAsync(versionId, instance.GameDir));

        if (missFiles.Count == 0)
        {
            return Ok(new { status = "complete", missingCount = 0 });
        }

        _installService.StartRepairResources(id, instance.GameDir, missFiles);
        return Ok(new { status = "repairing", missingCount = missFiles.Count });
    }

    private static List<LocalResourceHelper.MissFileData> FilterMissFiles(List<LocalResourceHelper.MissFileData> raw)
    {
        var comparer = OperatingSystem.IsWindows()
            ? StringComparer.OrdinalIgnoreCase
            : StringComparer.Ordinal;
        return raw
            .Where(f => !string.IsNullOrEmpty(f.Path) && !string.IsNullOrEmpty(f.Url))
            .DistinctBy(f => f.Path, comparer)
            .ToList();
    }

    private static bool GetGlobalVersionIsolation()
    {
        try
        {
            var settingsPath = Path.Combine(AppPaths.BaseDir, "QML", "settings.json");
            if (!System.IO.File.Exists(settingsPath)) return true;
            var json = System.IO.File.ReadAllText(settingsPath);
            var doc = System.Text.Json.JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("versionIsolation", out var prop) && prop.ValueKind == System.Text.Json.JsonValueKind.False)
                return false;
            return true;
        }
        catch { return true; }
    }

    private static string GetDefaultIcon(string? loader) => loader?.ToLowerInvariant() switch
    {
        "forge" => "Anvil",
        "neoforge" => "NeoForge",
        "fabric" => "Fabric",
        "quilt" => "Quilt",
        "optifabric" => "OptiFabric",
        "labymod" => "LabyMod",
        "cleanroom" => "Cleanroom",
        _ => "Grass",
    };

    [HttpPost("{id}/launch")]
    public ActionResult<LaunchResult> Launch(string id)
    {
        var instance = _repository.GetById(id);
        if (instance == null) return NotFound();

        // Clear previous state
        _launchService.Set(id, new LaunchProgress { Stage = "starting", Message = "准备启动...", Progress = 0 });

        _ = RunLaunchAsync(id);

            return Ok(new LaunchResult { Success = true, Stage = "starting" });
        }

        [HttpPost("{id}/launch/cancel")]
        public IActionResult CancelLaunch(string id)
        {
            _launchService.Cancel(id);
            return Ok(new { status = "cancelled" });
        }

        [HttpGet("{id}/launch/progress")]
    public ActionResult<LaunchProgress?> GetLaunchProgress(string id)
    {
        return Ok(_launchService.Get(id));
    }

    private async Task RunLaunchAsync(string id)
    {
        var instance = _repository.GetById(id);
        if (instance == null)
        {
            _launchService.Set(id, new LaunchProgress { Stage = "failed", Error = "实例不存在" });
            return;
        }

        var state = _launchService.Get(id) ?? new LaunchProgress();
        var versionId = instance.Name;
        var effectiveIsolation = instance.VersionIsolation ?? GetGlobalVersionIsolation();

        var cancelToken = _launchService.GetCancellationToken(id);

        try
        {
            // ─── Step 1: File integrity check ───
            if (!instance.SkipIntegrityCheck)
            {
                cancelToken.ThrowIfCancellationRequested();
                state.Stage = "checking"; state.Message = "正在检查文件完整性..."; state.Progress = 5;
                _launchService.Set(id, state);

                var resourceHelper = new LocalResourceHelper();
                var missFiles = FilterMissFiles(await resourceHelper.GetAllMissFilesAsync(versionId, instance.GameDir));

                if (missFiles.Count > 0)
                {
                    cancelToken.ThrowIfCancellationRequested();
                    state.Stage = "repairing"; state.Message = $"正在补全 {missFiles.Count} 个缺失文件..."; state.Progress = 10;
                    state.MissingFiles = missFiles.Select(f => f.Name).ToList();
                    _launchService.Set(id, state);

                    _installService.StartRepairResources(id, instance.GameDir, missFiles);

                    // Poll repair progress
                    while (true)
                    {
                        cancelToken.ThrowIfCancellationRequested();
                        var repairState = _installService.GetState(id);
                        if (repairState == null || repairState.Stage == "completed" || repairState.Stage == "done")
                        {
                            state.Progress = 25;
                            break;
                        }
                        if (repairState.Stage == "failed" || repairState.Stage == "error")
                        {
                            throw new Exception($"文件补全失败: {repairState.Error}");
                        }
                        state.Progress = 10 + repairState.Progress * 0.15;
                        state.Message = $"正在补全: {repairState.CurrentFile ?? ""} ({Math.Round(repairState.Progress)}%)";
                        _launchService.Set(id, state);
                        await Task.Delay(500);
                    }
                }
            }

            // ─── Step 2: Environment setup ───
            cancelToken.ThrowIfCancellationRequested();
            state.Stage = "preparing"; state.Message = "正在准备环境..."; state.Progress = 25;
            _launchService.Set(id, state);

            var logsDir = Path.Combine(instance.GameDir, "logs");
            System.IO.Directory.CreateDirectory(logsDir);
            System.IO.Directory.CreateDirectory(Path.Combine(instance.GameDir, "assets", "indexes"));

            // ─── Step 3: Account login ───
            cancelToken.ThrowIfCancellationRequested();
            state.Stage = "logging-in"; state.Message = "正在验证账户..."; state.Progress = 30;
            _launchService.Set(id, state);

            var param = new Qomicex.Core.Modules.Launcher.Launcher.LauncherParam
            {
                Version = versionId,
                MaxMemory = instance.MaxMemory.ToString(),
                AdditionalParam = instance.JvmArgs ?? "",
                DevideVersion = effectiveIsolation,
                GameDir = instance.GameDir,
                LauncherName = "qomicex",
            };

            param.Account.Name = "Player";
            param.Account.Uuid = "";
            param.Account.AccessToken = "faked-token-for-offline";
            param.Account.LoginMethod = "Legacy";

            var defaultAccount = _accountService.GetDefaultAsync().GetAwaiter().GetResult();
            if (defaultAccount != null)
            {
                param.Account.Name = defaultAccount.Name;
                param.Account.Uuid = defaultAccount.Uuid;

                if (defaultAccount.LoginMethod == "Yggdrasil" && !string.IsNullOrEmpty(defaultAccount.ServerUrl))
                {
                    param.Account.LoginMethod = "Yggdrasil";
                    try
                    {
                        var yggdrasil = new Qomicex.Core.Modules.Helpers.Account.Yggdrasil(defaultAccount.ServerUrl, "", "");
                        var yggAccount = new Qomicex.Core.Modules.Helpers.Account.Yggdrasil.YggdrasilAccount
                        {
                            AccessToken = defaultAccount.AccessToken,
                            ClientToken = defaultAccount.Token,
                            Uuid = defaultAccount.Uuid,
                            Name = defaultAccount.Name,
                        };
                        if (!string.IsNullOrEmpty(yggAccount.AccessToken))
                        {
                            var refreshed = await yggdrasil.RefreshTokenAsync(yggAccount);
                            defaultAccount.AccessToken = refreshed.AccessToken ?? defaultAccount.AccessToken;
                            defaultAccount.Token = refreshed.ClientToken ?? defaultAccount.Token;
                            await _accountService.SaveAccountAsync(defaultAccount);
                        }
                        param.Account.AccessToken = string.IsNullOrEmpty(defaultAccount.AccessToken) ? "faked-token-for-offline" : defaultAccount.AccessToken;
                    }
                    catch
                    {
                        param.Account.AccessToken = string.IsNullOrEmpty(defaultAccount.AccessToken) ? "faked-token-for-offline" : defaultAccount.AccessToken;
                    }
                }
                else if (defaultAccount.LoginMethod == "统一通行证")
                {
                    param.Account.LoginMethod = "Yggdrasil";
                    try
                    {
                        var tongyi = new Qomicex.Core.Modules.Helpers.Account.Tongyi(defaultAccount.ServerUrl ?? "", "", "");
                        var tongyiAccount = new Qomicex.Core.Modules.Helpers.Account.Tongyi.TongyiAccount
                        {
                            AccessToken = defaultAccount.AccessToken,
                            ClientToken = defaultAccount.Token,
                            Uuid = defaultAccount.Uuid,
                            Name = defaultAccount.Name,
                        };
                        if (!string.IsNullOrEmpty(tongyiAccount.AccessToken))
                        {
                            var refreshed = await tongyi.RefreshTokenAsync(tongyiAccount);
                            defaultAccount.AccessToken = refreshed.AccessToken ?? defaultAccount.AccessToken;
                            defaultAccount.Token = refreshed.ClientToken ?? defaultAccount.Token;
                            await _accountService.SaveAccountAsync(defaultAccount);
                        }
                        param.Account.AccessToken = string.IsNullOrEmpty(defaultAccount.AccessToken) ? "faked-token-for-offline" : defaultAccount.AccessToken;
                    }
                    catch
                    {
                        param.Account.AccessToken = string.IsNullOrEmpty(defaultAccount.AccessToken) ? "faked-token-for-offline" : defaultAccount.AccessToken;
                    }
                }
                else
                {
                    param.Account.AccessToken = string.IsNullOrEmpty(defaultAccount.AccessToken) ? "faked-token-for-offline" : defaultAccount.AccessToken;
                }
            }

            // ─── Step 4: Authlib-injector ───
            cancelToken.ThrowIfCancellationRequested();
            if (defaultAccount?.LoginMethod == "Yggdrasil" || defaultAccount?.LoginMethod == "统一通行证")
            {
                state.Stage = "authlib"; state.Message = "正在配置外置登录..."; state.Progress = 40;
                _launchService.Set(id, state);

                var aiDir = Path.Combine(AppPaths.BaseDir, "QML");
                var aiPath = Path.Combine(aiDir, "authlib-injector.jar");
                System.IO.Directory.CreateDirectory(aiDir);

                if (!System.IO.File.Exists(aiPath))
                {
                    try
                    {
                        cancelToken.ThrowIfCancellationRequested();
                        var client = _httpClientFactory.CreateClient("AuthlibInjector");
                        var mirrorUrls = new[]
                        {
                            "https://bmclapi2.bangbang93.com/mirrors/authlib-injector/artifact/latest.json",
                            "https://authlib-injector.yushi.moe/artifact/latest.json"
                        };
                        string? downloadUrl = null;
                        foreach (var url in mirrorUrls)
                        {
                            try
                            {
                                var json = await client.GetStringAsync(url);
                                var doc = System.Text.Json.JsonDocument.Parse(json);
                                downloadUrl = doc.RootElement.GetProperty("download_url").GetString();
                                if (!string.IsNullOrEmpty(downloadUrl)) break;
                            }
                            catch { }
                        }
                        if (string.IsNullOrEmpty(downloadUrl))
                            throw new Exception("无法获取 authlib-injector 下载地址");
                        var bytes = await client.GetByteArrayAsync(downloadUrl);
                        await System.IO.File.WriteAllBytesAsync(aiPath, bytes);
                    }
                    catch (Exception ex)
                    {
                        throw new Exception($"authlib-injector 下载失败: {ex.Message}");
                    }
                }

                var serverUrl = defaultAccount.ServerUrl ?? "";
                var authlibArg = $"-javaagent:\"{aiPath}\"={serverUrl}";
                param.AdditionalParam = string.IsNullOrEmpty(param.AdditionalParam)
                    ? authlibArg
                    : param.AdditionalParam + " " + authlibArg;
            }

            // ─── Step 5: Resolve Java ───
            cancelToken.ThrowIfCancellationRequested();
            state.Stage = "preparing"; state.Message = "正在选择 Java 运行时..."; state.Progress = 50;
            _launchService.Set(id, state);

            string javaPath;
            if (!string.IsNullOrEmpty(instance.JavaPath))
            {
                javaPath = instance.JavaPath;
                param.Java.Path = javaPath;
                var javaInfo = JavaHelper.SearchJava(new JavaHelper.JavaSearchOptions
                {
                    Mode = JavaHelper.JavaSearchMode.Custom,
                    CustomRootPath = Path.GetDirectoryName(Path.GetDirectoryName(javaPath)) ?? "",
                    MaxDepth = 2,
                    MaxResults = 20,
                    ScanHiddenFolders = true,
                }).FirstOrDefault(j => string.Equals(j.Path, javaPath, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal));
                param.Java.VersionID = javaInfo?.VersionID ?? 0;
            }
            else
            {
                var javaList = _javaRuntimeStore.GetMergedAsync(JavaHelper.JavaSearchMode.Quick).GetAwaiter().GetResult();
                var recommended = JavaHelper.GetRecommendedJava(javaList, instance.GameVersion, instance.GameDir);
                var chosen = recommended.FirstOrDefault();
                javaPath = chosen?.Path ?? "java";
                param.Java.Path = javaPath;
                param.Java.VersionID = chosen?.VersionID ?? 0;
            }

            _logger.LogInformation("[Launch] 实例={Name} 版本={VersionId} GameDir={GameDir}", instance.Name, versionId, instance.GameDir);
            _logger.LogInformation("[Launch] Java: path={JavaPath} versionId={VersionId}", javaPath, param.Java.VersionID);
            _logger.LogInformation("[Launch] 内存: max={MaxMemory}MB", instance.MaxMemory);
            _logger.LogInformation("[Launch] 账户: name={AccountName} uuid={Uuid} method={LoginMethod}", param.Account.Name, param.Account.Uuid, param.Account.LoginMethod);

            if (param.Java.VersionID == 0)
            {
                try
                {
                    var verStr = GeneralHelper.GetMinecraftRequireJavaVersion(instance.GameVersion, instance.GameDir);
                    param.Java.VersionID = int.TryParse(verStr, out var vid) ? vid : 21;
                }
                catch { param.Java.VersionID = 21; }
            }

            // ─── Step 6: Build arguments + Natives ───
            cancelToken.ThrowIfCancellationRequested();
            state.Stage = "natives"; state.Message = "正在解压原生库..."; state.Progress = 60;
            _launchService.Set(id, state);

            var launcher = new Qomicex.Core.Modules.Launcher.Launcher();
            var versionPath = Path.Combine(instance.GameDir, "versions", versionId);
            var jsonPath = Path.Combine(versionPath, $"{versionId}.json");

            if (!System.IO.File.Exists(jsonPath))
                throw new Exception($"版本文件缺失: {jsonPath}");

            launcher.UnzipNatives(jsonPath, instance.GameDir, versionPath);

            state.Stage = "building"; state.Message = "正在构建启动参数..."; state.Progress = 70;
            _launchService.Set(id, state);

            var args = launcher.SelectParam(param, param.LauncherName);
            _logger.LogInformation("[Launch] 完整启动命令: {JavaPath} {Args}", javaPath, args);

            // ─── Step 7: Launch ───
            cancelToken.ThrowIfCancellationRequested();
            state.Stage = "launching"; state.Message = "正在启动游戏..."; state.Progress = 85;
            _launchService.Set(id, state);

            var stderrPath = System.IO.Path.Combine(logsDir, "launcher-latest.log");

            var process = System.Diagnostics.Process.Start(new ProcessStartInfo
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
            });

            if (process == null)
                throw new Exception("无法启动 Java 进程");

            process.ErrorDataReceived += (_, e) =>
            {
                if (e.Data != null)
                    System.IO.File.AppendAllText(stderrPath, e.Data + Environment.NewLine);
            };
            process.BeginErrorReadLine();

            var stdout = new StringBuilder();
            process.OutputDataReceived += (_, e) =>
            {
                if (e.Data != null) stdout.AppendLine(e.Data);
            };
            process.BeginOutputReadLine();

            // ─── Step 8: Wait for game window ───
            cancelToken.ThrowIfCancellationRequested();
            state.Stage = "waiting-window"; state.Message = "等待游戏窗口..."; state.Progress = 90;
            _launchService.Set(id, state);

            // Try WaitForInputIdle first (works for GUI processes)
            try { process.WaitForInputIdle(30_000); } catch { }

            // Poll for window handle (max 30s)
            for (var i = 0; i < 60; i++)
            {
                cancelToken.ThrowIfCancellationRequested();
                if (process.HasExited) break;
                process.Refresh();
                if (process.MainWindowHandle != IntPtr.Zero) break;
                await Task.Delay(500);
            }

            // Mark as launched successfully
            instance.LastPlayed = DateTime.UtcNow;
            _repository.Update(instance.Id, instance);

            _launchService.RegisterProcess(id, process.Id);
            state.Stage = "running"; state.Message = "游戏运行中"; state.Progress = 100;
            state.ProcessId = process.Id;
            state.Arguments = args;
            state.IsRunning = true;
            _launchService.Set(id, state);

            // ─── Step 9: Lightweight crash detection (background) ───
            _ = Task.Run(() =>
            {
                try
                {
                    process.WaitForExit();
                    state.ExitCode = process.ExitCode;

                    // Check crash-reports
                    var crashDir = Path.Combine(instance.GameDir, "crash-reports");
                    if (System.IO.Directory.Exists(crashDir))
                    {
                        var latest = System.IO.Directory.GetFiles(crashDir, "*.txt")
                            .OrderByDescending(f => System.IO.File.GetLastWriteTime(f))
                            .FirstOrDefault();
                        if (latest != null)
                        {
                            var content = System.IO.File.ReadAllText(latest);
                            state.CrashReport = content.Length > 5000 ? content[..5000] + "..." : content;
                        }
                    }

                    if (process.ExitCode != 0)
                    {
                        state.Stage = "crashed"; state.Message = $"游戏异常退出 (代码: {process.ExitCode})";
                    }
                    else
                    {
                        state.Stage = "completed"; state.Message = "游戏已退出";
                    }
                    state.IsRunning = false;
                    _launchService.Set(id, state);
                }
                catch (Exception ex)
                {
                    state.Stage = "failed"; state.Error = ex.Message; state.IsRunning = false;
                    _launchService.Set(id, state);
                }
                finally
                {
                    process.Dispose();
                }
            });
        }
        catch (Exception ex)
        {
            state.Stage = "failed"; state.Error = ex.Message;
            _launchService.Set(id, state);
        }
    }
}
