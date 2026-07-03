using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Qomicex.Launcher.Backend.Services;

public record LanGameEntry(
    string Ip,
    int Port,
    string Motd,
    string WorldName,
    int OnlinePlayers,
    int MaxPlayers,
    string GameVersion
);

public class LanGameListenerService : IDisposable
{
    private static readonly IPAddress MulticastAddress = IPAddress.Parse("224.0.2.60");
    private const int MulticastPort = 4445;

    private readonly UdpClient _udp;
    private readonly List<LanGameEntry> _games = new();
    private readonly object _lock = new();
    private CancellationTokenSource? _cts;

    public LanGameListenerService()
    {
        _udp = new UdpClient();
        _udp.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        _udp.Client.Bind(new IPEndPoint(IPAddress.Any, MulticastPort));
        _udp.JoinMulticastGroup(MulticastAddress);
    }

    public void Start()
    {
        _cts?.Cancel();
        _cts = new CancellationTokenSource();
        _ = ListenLoop(_cts.Token);
    }

    public void Stop()
    {
        _cts?.Cancel();
    }

    public List<LanGameEntry> GetGames()
    {
        lock (_lock) return new List<LanGameEntry>(_games);
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

                var motd = ExtractTag(message, "MOTD", "[MOTD]", "[/MOTD]");
                var portStr = ExtractTag(message, "AD", "[AD]", "[/AD]");
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
                );

                lock (_lock)
                {
                    var existing = _games.FirstOrDefault(g => g.Ip == game.Ip && g.Port == game.Port);
                    if (existing == null)
                        _games.Add(game);
                }
            }
            catch (OperationCanceledException) { break; }
            catch { /* ignore individual packet errors */ }
        }
    }

    private static string? ExtractTag(string input, string tagName, string openTag, string closeTag)
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
