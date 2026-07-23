using System.Net;
using System.Net.Sockets;
using System.Text;
using Microsoft.Extensions.Logging;

namespace Qomicex.Launcher.Backend.Neo.Services;

public record LanGameEntry(
    string Ip,
    int Port,
    string Motd,
    string WorldName,
    int OnlinePlayers,
    int MaxPlayers,
    string GameVersion
)
{
    public DateTime LastSeen { get; set; } = DateTime.UtcNow;
}

public class LanGameListenerService : IDisposable
{
    private static readonly IPAddress MulticastAddress = IPAddress.Parse("224.0.2.60");
    private const int MulticastPort = 4445;

    private readonly UdpClient _udp;
    private readonly List<LanGameEntry> _games = new();
    private readonly object _lock = new();
    private readonly ILogger<LanGameListenerService> _logger;
    private CancellationTokenSource? _cts;

    public LanGameListenerService(ILogger<LanGameListenerService> logger)
    {
        _logger = logger;
        _udp = new UdpClient();
        _udp.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        _udp.Client.Bind(new IPEndPoint(IPAddress.Any, MulticastPort));
        _udp.JoinMulticastGroup(MulticastAddress);
    }

    public void Start()
    {
        _cts?.Cancel();
        _cts = new CancellationTokenSource();
        _ = Task.Run(() => RunListenLoop(_cts.Token));
    }

    public void Stop()
    {
        _cts?.Cancel();
    }

    public List<LanGameEntry> GetGames()
    {
        var cutoff = DateTime.UtcNow.AddSeconds(-30);
        lock (_lock)
        {
            _games.RemoveAll(g => g.LastSeen < cutoff);
            return new List<LanGameEntry>(_games);
        }
    }

    private async Task RunListenLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await ListenLoop(ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "LAN listener loop crashed, restarting in 5s");
                try { await Task.Delay(5000, ct); } catch (OperationCanceledException) { break; }
            }
        }
    }

    private async Task ListenLoop(CancellationToken ct)
    {
        lock (_lock) _games.Clear();

        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeoutCts.CancelAfter(TimeSpan.FromSeconds(5));

                var result = await _udp.ReceiveAsync(timeoutCts.Token);
                var message = Encoding.UTF8.GetString(result.Buffer);

                var motd = ExtractTag(message, "[MOTD]", "[/MOTD]");
                var portStr = ExtractTag(message, "[AD]", "[/AD]");
                var worldName = motd ?? "Unknown";

                if (!int.TryParse(portStr, out var port)) port = 25565;

                var game = new LanGameEntry(
                    Ip: result.RemoteEndPoint.Address.ToString(),
                    Port: port,
                    Motd: motd ?? "",
                    WorldName: worldName,
                    OnlinePlayers: 1,
                    MaxPlayers: 8,
                    GameVersion: "Unknown"
                )
                {
                    LastSeen = DateTime.UtcNow
                };

                lock (_lock)
                {
                    var idx = _games.FindIndex(g => g.Ip == game.Ip && g.Port == game.Port);
                    if (idx >= 0)
                        _games[idx] = game;
                    else
                        _games.Add(game);
                }
            }
            catch (OperationCanceledException) { break; }
            catch { }
        }
    }

    private static string? ExtractTag(string input, string openTag, string closeTag)
    {
        var start = input.IndexOf(openTag, StringComparison.OrdinalIgnoreCase);
        if (start < 0) return null;
        start += openTag.Length;
        var end = input.IndexOf(closeTag, start, StringComparison.OrdinalIgnoreCase);
        if (end < 0) return null;
        return input[start..end];
    }

    public void Dispose()
    {
        Stop();
        _udp.DropMulticastGroup(MulticastAddress);
        _udp.Dispose();
        _cts?.Dispose();
    }
}
