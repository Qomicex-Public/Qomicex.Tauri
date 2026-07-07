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

public enum ConnectorMode { Idle, Host, Guest }

public sealed record ConnectorPlayerDto(string Name, string Vendor, string? IconBase64, string Kind);
public sealed record ConnectorStatusDto(
    string Mode, string? RoomCode, string? McHost, int? McPort,
    GameInfoDto? GameInfo, List<ConnectorPlayerDto> Players);

public sealed class ConnectorService : IDisposable
{
    private readonly ILogger<ConnectorService> _logger;
    private readonly GameProcessInspector _inspector;
    private readonly AccountService _accountService;
    private readonly LanGameListenerService _lanListener;
    private readonly IInstanceRepository _instances;
    private readonly SkinService _skinService;

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ScaffoldingClient _client = new(easyTierPath: null);

    private ScaffoldingCenter? _center;
    private ScaffoldingGuest? _guest;
    private GameInfoDto _gameInfo = new();
    private readonly Dictionary<string, string> _iconMap = new();
    private readonly object _iconLock = new();
    private string? _mcHost;
    private int? _mcPort;

    private static string? _cachedVendor;
    private static string? _cachedMachineId;

    public ConnectorService(
        ILogger<ConnectorService> logger,
        GameProcessInspector inspector,
        AccountService accountService,
        LanGameListenerService lanListener,
        IInstanceRepository instances,
        SkinService skinService)
    {
        _logger = logger;
        _inspector = inspector;
        _accountService = accountService;
        _lanListener = lanListener;
        _instances = instances;
        _skinService = skinService;
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
            var launcherVersion = typeof(ConnectorService).Assembly.GetName().Version?.ToString() ?? "0.0.0";
            var etVersion = GetEasyTierVersion();
            _cachedVendor = $"Qomicex {launcherVersion}/Qomicex.Connector | EasyTier{etVersion}";
            return _cachedVendor;
        }
    }

    private string GetEasyTierVersion()
    {
        try
        {
            using var proc = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("easytier-core", "-V")
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
            var proc = _inspector.Inspect(port);
            _gameInfo = new GameInfoDto { GameVersion = proc.GameVersionArg ?? "unknown" };
            var selfIcon = await GetSelfIconBase64(proc.Uuid, proc.IsMicrosoft);
            lock (_iconLock) _iconMap[MachineId] = selfIcon;

            var protocols = QmlProtocols.BuildHostProtocols(() => _gameInfo, ExchangeIcons);
            _center = await _client.CreateRoomAsync(proc.PlayerName, MachineId, Vendor, port, protocols, ct);
            return _center.RoomCode.Raw;
        }
        finally { _gate.Release(); }
    }

    public async Task<(string Host, int Port)> JoinAsync(string code, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            EnsureIdle();
            var account = await _accountService.GetDefaultAsync()
                ?? throw ApiException.BadRequest("请先在账户页选择一个账户再加入房间");

            _guest = await _client.JoinRoomAsync(code, account.Name, MachineId, Vendor, QmlProtocols.GuestKeys, ct);
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
        await _gate.WaitAsync(ct);
        try
        {
            await _client.CloseAsync(ct);
            _center = null; _guest = null; _mcHost = null; _mcPort = null;
            _gameInfo = new GameInfoDto();
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
                MapPlayers(center.GetPlayers(), icons));
        if (guest != null)
            return new ConnectorStatusDto("guest", null, _mcHost, _mcPort, _gameInfo,
                MapPlayers(guest.GetPlayerListAsync().GetAwaiter().GetResult(), icons));
        return new ConnectorStatusDto("idle", null, null, null, null, new());
    }

    private void EnsureIdle()
    {
        if (_center != null || _guest != null)
            throw ApiException.BadRequest("已有进行中的房间或连接，请先退出");
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

    private async Task<string> GetSelfIconBase64(string uuid, bool isMicrosoft)
    {
        try
        {
            var loginMethod = isMicrosoft ? "Microsoft" : "Offline";
            var bytes = await _skinService.GetHeadAvatar(uuid, loginMethod, null, 64);
            return bytes != null ? Convert.ToBase64String(bytes) : "";
        }
        catch { return ""; }
    }

    private List<ConnectorPlayerDto> MapPlayers(IReadOnlyList<PlayerInfo> players, IReadOnlyDictionary<string, string> icons)
        => players.Select(p => new ConnectorPlayerDto(
            p.Name, p.Vendor,
            icons.TryGetValue(p.MachineId, out var icon) ? icon : null,
            p.Kind == PlayerKind.Host ? "host" : "guest")).ToList();

    public void Dispose() { _client.Dispose(); _gate.Dispose(); }
}
