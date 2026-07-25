using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;

namespace Qomicex.Launcher.Backend.Neo.Services.Connector;

public sealed record NatTypeResult(string Type, string? PublicIp, int? PublicPort);

public sealed class NatTypeDetector
{
    private readonly ILogger<NatTypeDetector> _logger;

    public NatTypeDetector(ILogger<NatTypeDetector> logger) => _logger = logger;

    private static readonly (string Host, int Port)[] StunServers = [
        ("stun.miwifi.com", 3478),
        ("stun.l.google.com", 19302),
    ];

    public async Task<NatTypeResult> DetectAsync(CancellationToken ct = default)
    {
        using var udp = new UdpClient();
        udp.Client.SendTimeout = 3000;
        udp.Client.ReceiveTimeout = 3000;

        var results = new List<(IPAddress? Address, int? Port)>();

        foreach (var (host, port) in StunServers)
        {
            var mapped = await QueryStunAsync(udp, host, port, ct);
            results.Add(mapped);
        }

        var valid = results.Where(r => r.Address is not null).ToList();

        if (valid.Count == 0)
            return new NatTypeResult("blocked", null, null);

        var first = valid[0];

        if (valid.Count == 1)
            return new NatTypeResult("unknown", first.Address!.ToString(), first.Port);

        var distinctPorts = valid.Select(r => r.Port!.Value).Distinct().ToList();
        var type = distinctPorts.Count == 1 ? "cone" : "symmetric";

        return new NatTypeResult(type, first.Address!.ToString(), first.Port);
    }

    private static async Task<(IPAddress? Address, int? Port)> QueryStunAsync(UdpClient udp, string host, int port, CancellationToken ct)
    {
        try
        {
            var addresses = await Dns.GetHostAddressesAsync(host, ct);
            if (addresses.Length == 0) return (null, null);

            var endpoint = new IPEndPoint(addresses[0], port);
            udp.Client.Connect(endpoint);

            var txId = new byte[12];
            RandomNumberGenerator.Fill(txId);
            var request = BuildBindingRequest(txId);

            await udp.SendAsync(request.AsMemory(), ct);

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(3000);
            var response = await udp.ReceiveAsync(timeoutCts.Token);

            return ParseStunResponse(response.Buffer, txId);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return (null, null);
        }
    }

    private static byte[] BuildBindingRequest(byte[] txId)
    {
        var packet = new byte[20];
        packet[0] = 0x00; packet[1] = 0x01;
        packet[2] = 0x00; packet[3] = 0x00;
        packet[4] = 0x21; packet[5] = 0x12;
        packet[6] = 0xA4; packet[7] = 0x42;
        Array.Copy(txId, 0, packet, 8, 12);
        return packet;
    }

    private static (IPAddress? Address, int? Port) ParseStunResponse(byte[] data, byte[] txId)
    {
        if (data.Length < 20) return (null, null);

        int msgType = (data[0] << 8) | data[1];
        if (msgType != 0x0101) return (null, null);

        if (data[4] != 0x21 || data[5] != 0x12 || data[6] != 0xA4 || data[7] != 0x42)
            return (null, null);

        for (int i = 0; i < 12; i++)
            if (data[8 + i] != txId[i]) return (null, null);

        int messageLength = (data[2] << 8) | data[3];
        int offset = 20;
        int end = 20 + messageLength;
        int endPadding = Math.Min(data.Length, end);

        while (offset + 4 <= endPadding)
        {
            int attrType = (data[offset] << 8) | data[offset + 1];
            int attrLength = (data[offset + 2] << 8) | data[offset + 3];
            offset += 4;

            int paddedLength = attrLength + (attrLength % 4 == 0 ? 0 : 4 - (attrLength % 4));
            if (offset + attrLength > endPadding) break;

            if (attrType == 0x0020 && attrLength >= 8)
            {
                int family = data[offset + 1];
                if (family == 0x01)
                {
                    int xPort = (data[offset + 2] << 8) | data[offset + 3];
                    int port = xPort ^ 0x2112;

                    var ipBytes = new byte[4];
                    Array.Copy(data, offset + 4, ipBytes, 0, 4);
                    ipBytes[0] ^= 0x21; ipBytes[1] ^= 0x12;
                    ipBytes[2] ^= 0xA4; ipBytes[3] ^= 0x42;

                    return (new IPAddress(ipBytes), port);
                }
            }
            else if (attrType == 0x0001 && attrLength >= 8)
            {
                int family = data[offset + 1];
                if (family == 0x01)
                {
                    int port = (data[offset + 2] << 8) | data[offset + 3];
                    var ipBytes = new byte[4];
                    Array.Copy(data, offset + 4, ipBytes, 0, 4);
                    return (new IPAddress(ipBytes), port);
                }
            }

            offset += paddedLength;
        }

        return (null, null);
    }
}
