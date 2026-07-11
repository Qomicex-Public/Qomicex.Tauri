using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using Qomicex.Connector;
using Qomicex.Connector.Center;
using Qomicex.Connector.Guest;
using Qomicex.Connector.Models;
using Qomicex.Launcher.Backend.Common;
using Qomicex.Core.Modules.Helpers;

namespace Qomicex.Launcher.Backend.Services.Connector;

public sealed record ConnectorPlayerDto(string Name, string Vendor, string? IconBase64, string Kind);
public sealed record ConnectorStatusDto(
    string Mode, string? RoomCode, string? McHost, int? McPort,
    GameInfoDto? GameInfo, List<ConnectorPlayerDto> Players, string? Error);

public sealed class ConnectorService : IDisposable
{
    private readonly ILogger<ConnectorService> _logger;
    private readonly GameProcessInspector _inspector;
    private readonly AccountService _accountService;
    private readonly LanGameListenerService _lanListener;
    private readonly IInstanceRepository _instances;
    private readonly SkinService _skinService;
    private readonly EasyTierProvider _easyTier;
    private readonly LaunchService _launchService;

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ScaffoldingClient _client;
    private readonly HttpClient _localHttp = new() { BaseAddress = new Uri("http://localhost:5000") };

    private ScaffoldingCenter? _center;
    private ScaffoldingGuest? _guest;
    private GameInfoDto _gameInfo = new();
    private readonly Dictionary<string, string> _iconMap = new();
    private readonly object _iconLock = new();
    private string? _mcHost;
    private int? _mcPort;
    private int _lastGuestPlayerCount = -1;

    private volatile bool _starting;
    private volatile string? _startError;
    private CancellationTokenSource? _startCts;
    private string? _hostingInstanceId;

    private static string? _cachedVendor;
    private static string? _cachedMachineId;

    public ConnectorService(
        ILogger<ConnectorService> logger,
        GameProcessInspector inspector,
        AccountService accountService,
        LanGameListenerService lanListener,
        IInstanceRepository instances,
        SkinService skinService,
        EasyTierProvider easyTier,
        LaunchService launchService)
    {
        _logger = logger;
        _inspector = inspector;
        _accountService = accountService;
        _lanListener = lanListener;
        _instances = instances;
        _skinService = skinService;
        _easyTier = easyTier;
        _launchService = launchService;
        _client = new ScaffoldingClient(easyTierPath: EasyTierProvider.GetExecutablePath());
    }

    private static string MachineId
    {
        get
        {
            if (_cachedMachineId != null) return _cachedMachineId;
            var info = SystemInfoHelper.GetSystemInfo();
            var sysText = $"{info.OSName}|{info.OS}|{info.OSVersion}|{info.Architecture}";
            var combined = sysText + CryptHelper.GetMachineCode();
            _cachedMachineId = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(combined)));
            return _cachedMachineId;
        }
    }

    private string Vendor
    {
        get
        {
            if (_cachedVendor != null) return _cachedVendor;
            var launcherVersion = (typeof(ConnectorService).Assembly
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
                ?? typeof(ConnectorService).Assembly.GetName().Version?.ToString()
                ?? "0.0.0").Split('+')[0];
            var etVersion = GetEasyTierVersion();
            _cachedVendor = $"Qomicex.Launcher {launcherVersion}/Qomicex.Connector | EasyTier{etVersion}";
            return _cachedVendor;
        }
    }

    private string GetEasyTierVersion()
    {
        try
        {
            var exePath = EasyTierProvider.GetExecutablePath();
            if (!File.Exists(exePath)) return "unknown";
            using var proc = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(exePath, "--version")
            {
                RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true
            });
            if (proc == null) return "unknown";
            var output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(3000);
            var token = output.Split(new[] { ' ', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries)
                .FirstOrDefault(t => t.Any(char.IsDigit) && t.Contains('.'));
            return token ?? "unknown";
        }
        catch { return "unknown"; }
    }

    public async Task<string> HostByPortAsync(int port, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            EnsureIdle();
            EnsureEasyTierReady();
            var proc = _inspector.Inspect(port);
            _gameInfo = new GameInfoDto { GameVersion = proc.GameVersionArg ?? "unknown" };
            var selfIcon = await ResolveHostIconAsync(proc);
            lock (_iconLock) _iconMap[MachineId] = selfIcon;

            var protocols = QmlProtocols.BuildHostProtocols(() => _gameInfo, ExchangeIcons, mid => _center?.RemovePlayer(mid));
            _center = await _client.CreateRoomAsync(proc.PlayerName, MachineId, Vendor, port, protocols, ct);
            return _center.RoomCode.Raw;
        }
        finally { _gate.Release(); }
    }

    public async Task HostByInstanceAsync(string instanceId, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            EnsureIdle();
            var instance = _instances.GetById(instanceId)
                ?? throw ApiException.NotFound("实例不存在");
            EnsureEasyTierReady();

            _startError = null;
            _starting = true;
            _startCts = new CancellationTokenSource();
            _hostingInstanceId = instanceId;
            var token = _startCts.Token;
            _ = Task.Run(() => RunHostByInstanceAsync(instance, token));
        }
        finally { _gate.Release(); }
    }

    private async Task RunHostByInstanceAsync(Models.GameInstance instance, CancellationToken ct)
    {
        try
        {
            var knownPorts = _lanListener.GetGames().Select(g => g.Port).ToHashSet();

            using var resp = await _localHttp.PostAsync($"/api/instance/{instance.Id}/launch", null, ct);
            resp.EnsureSuccessStatusCode();

            var deadline = DateTime.UtcNow.AddMinutes(5);
            int? newPort = null;
            while (DateTime.UtcNow < deadline)
            {
                ct.ThrowIfCancellationRequested();
                var candidate = _lanListener.GetGames()
                    .Where(g => !knownPorts.Contains(g.Port))
                    .OrderByDescending(g => g.LastSeen)
                    .FirstOrDefault();
                if (candidate != null) { newPort = candidate.Port; break; }
                await Task.Delay(2000, ct);
            }

            if (newPort is null)
            {
                _startError = "等待游戏开放局域网超时，请在游戏内点击\"对局域网开放\"";
                return;
            }

            var proc = _inspector.Inspect(newPort.Value);
            var gameInfo = new GameInfoDto
            {
                GameVersion = instance.GameVersion,
                Loader = instance.Loader,
                LoaderVersion = instance.LoaderVersion,
            };
            var selfIcon = await ResolveHostIconAsync(proc);

            await _gate.WaitAsync(ct);
            try
            {
                _gameInfo = gameInfo;
                lock (_iconLock) _iconMap[MachineId] = selfIcon;
                var protocols = QmlProtocols.BuildHostProtocols(() => _gameInfo, ExchangeIcons, mid => _center?.RemovePlayer(mid));
                _center = await _client.CreateRoomAsync(proc.PlayerName, MachineId, Vendor, newPort.Value, protocols, ct);
            }
            finally { _gate.Release(); }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "选实例开房失败");
            _startError = ex is ApiException api ? api.Message : "开房失败: " + ex.Message;
        }
        finally
        {
            _starting = false;
        }
    }

    public async Task<(string Host, int Port)> JoinAsync(string code, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            EnsureIdle();
            EnsureEasyTierReady();
            var account = await _accountService.GetDefaultAsync()
                ?? throw ApiException.BadRequest("请先在账户页选择一个账户再加入房间");

            _guest = await _client.JoinRoomAsync(code, account.Name, MachineId, Vendor, QmlProtocols.GuestKeys, ct);
            _guest.ConnectionLost += OnGuestConnectionLost;
            var (host, mcPort) = await _guest.MapMinecraftPortAsync(ct);
            _mcHost = host; _mcPort = mcPort;

            _gameInfo = await QmlProtocols.FetchGameInfoAsync(_guest, ct) ?? new GameInfoDto();

            var isMicrosoft = string.Equals(account.LoginMethod, "Microsoft", StringComparison.OrdinalIgnoreCase);
            var icon = await GetSelfIconBase64(account.Uuid, isMicrosoft);
            var map = await QmlProtocols.ExchangeIconsAsync(_guest,
                new PlayerIconUpload { MachineId = MachineId, IconBase64 = icon }, ct);
            if (map?.Icons != null)
                lock (_iconLock)
                    foreach (var kv in map.Icons) _iconMap[kv.Key] = kv.Value;

            return (host, mcPort);
        }
        finally { _gate.Release(); }
    }

    public async Task LeaveAsync(CancellationToken ct = default)
    {
        _startCts?.Cancel();
        if (_hostingInstanceId != null)
        {
            _launchService.Cancel(_hostingInstanceId);
            _hostingInstanceId = null;
        }
        await _gate.WaitAsync(ct);
        try
        {
            if (_guest != null)
            {
                _guest.ConnectionLost -= OnGuestConnectionLost;
                try { await QmlProtocols.NotifyLeaveAsync(_guest, MachineId, ct); }
                catch (Exception ex) { _logger.LogDebug(ex, "发送离开通知失败，将由断开/心跳超时兜底移除"); }
            }
            await _client.CloseAsync(ct);
            _center = null; _guest = null; _mcHost = null; _mcPort = null;
            _gameInfo = new GameInfoDto();
            _starting = false; _startError = null;
            lock (_iconLock) _iconMap.Clear();
        }
        finally { _gate.Release(); }
    }

    public ConnectorStatusDto GetStatus()
    {
        var center = _center;
        var guest = _guest;
        Dictionary<string, string> icons;
        lock (_iconLock) icons = new Dictionary<string, string>(_iconMap);
        if (center != null)
            return new ConnectorStatusDto("host", center.RoomCode.Raw, null, null, _gameInfo,
                MapPlayers(center.GetPlayers(), icons), null);
        if (guest != null)
        {
            try
            {
                var players = guest.GetPlayerListAsync().GetAwaiter().GetResult();
                if (players.Count != _lastGuestPlayerCount)
                {
                    _lastGuestPlayerCount = players.Count;
                    try
                    {
                        var map = QmlProtocols.ExchangeIconsAsync(guest,
                            new PlayerIconUpload { MachineId = MachineId, IconBase64 = "" }).GetAwaiter().GetResult();
                        if (map?.Icons != null)
                            lock (_iconLock)
                                foreach (var kv in map.Icons) _iconMap[kv.Key] = kv.Value;
                        icons = new Dictionary<string, string>(_iconMap);
                    }
                    catch (Exception ex) { _logger.LogDebug(ex, "刷新 icon map 失败"); }
                }
                return new ConnectorStatusDto("guest", null, _mcHost, _mcPort, _gameInfo,
                    MapPlayers(players, icons), null);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "获取玩家列表失败，连接可能已断开");
                _ = Task.Run(() => OnGuestConnectionLost());
                return new ConnectorStatusDto("guest", null, _mcHost, _mcPort, _gameInfo,
                    new(), "连接已断开，正在退出…");
            }
        }
        if (_starting)
            return new ConnectorStatusDto("starting", null, null, null, null, new(), _startError);
        return new ConnectorStatusDto("idle", null, null, null, null, new(), _startError);
    }

    public EasyTierDownloadStatus GetEasyTierStatus() => _easyTier.GetStatus();

    public void EnsureEasyTierDownloadStarted() => _easyTier.EnsureDownloadStarted();

    public int? ScanJavaPort() => _inspector.ScanJavaPort();

    private void EnsureIdle()
    {
        if (_center != null || _guest != null || _starting)
            throw ApiException.BadRequest("已有进行中的房间或连接，请先退出");
    }

    private void EnsureEasyTierReady()
    {
        if (!_easyTier.IsInstalled)
            throw ApiException.BadRequest("EasyTier 尚未就绪，请等待下载完成后重试");
    }

    private PlayerIconMap ExchangeIcons(PlayerIconUpload upload)
    {
        lock (_iconLock)
        {
            if (!string.IsNullOrEmpty(upload.MachineId) && !string.IsNullOrEmpty(upload.IconBase64))
                _iconMap[upload.MachineId] = upload.IconBase64;
            return new PlayerIconMap { Icons = new Dictionary<string, string>(_iconMap) };
        }
    }

    private async Task<string> ResolveHostIconAsync(GameProcessInfo proc)
    {
        var account = await _accountService.GetDefaultAsync();
        if (account != null)
        {
            var isMicrosoft = string.Equals(account.LoginMethod, "Microsoft", StringComparison.OrdinalIgnoreCase);
            return await GetSelfIconBase64(account.Uuid, isMicrosoft);
        }
        return await GetSelfIconBase64(proc.Uuid, proc.IsMicrosoft);
    }

    private async Task<string> GetSelfIconBase64(string uuid, bool isMicrosoft)
    {
        try
        {
            var loginMethod = isMicrosoft ? "Microsoft" : "Offline";
            var local = _skinService.GetLocalSkin(uuid);
            byte[]? skinData = local;
            if (skinData == null)
            {
                if (loginMethod == "Offline")
                    skinData = SkinService.GetDefaultSkinBytes();
                else
                {
                    var profile = await _skinService.FetchProfile(uuid, loginMethod, null);
                    if (profile?.SkinUrl != null)
                        skinData = await _skinService.DownloadSkin(profile.SkinUrl);
                    skinData ??= SkinService.GetDefaultSkinBytes();
                }
            }
            return skinData != null ? Convert.ToBase64String(skinData) : "";
        }
        catch { return ""; }
    }

    private List<ConnectorPlayerDto> MapPlayers(IReadOnlyList<PlayerInfo> players, IReadOnlyDictionary<string, string> icons)
        => players.Select(p => new ConnectorPlayerDto(
            p.Name, p.Vendor,
            icons.TryGetValue(p.MachineId, out var icon) ? icon : null,
            p.Kind == PlayerKind.Host ? "host" : "guest")).ToList();

    private async void OnGuestConnectionLost()
    {
        _logger.LogWarning("与联机中心的连接已断开，自动退出房间");
        try { await LeaveAsync(CancellationToken.None); }
        catch (Exception ex) { _logger.LogError(ex, "自动退出房间时出错"); }
    }

    public void Dispose() { _startCts?.Dispose(); _client.Dispose(); _gate.Dispose(); _localHttp.Dispose(); }
}
