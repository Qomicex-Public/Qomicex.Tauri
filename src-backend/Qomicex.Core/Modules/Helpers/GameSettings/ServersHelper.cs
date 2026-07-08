using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text;
using System.Diagnostics;
using DnsClient;
using DnsClient.Protocol;

namespace Qomicex.Core.Modules.Helpers.GameSettings
{
    public class ServersHelper
    {
        private readonly string _gameDirectory;
        private readonly string _version;
        private readonly bool _versionSpecific;

        public ServersHelper(string gameDirectory, string version, bool versionSpecific)
        {
            _gameDirectory = gameDirectory ?? throw new ArgumentNullException(nameof(gameDirectory));
            _version = version ?? throw new ArgumentNullException(nameof(version));
            _versionSpecific = versionSpecific;
        }

        public List<ServerEntry> GetServers()
        {
            var serverFilePath = GetServerFilePath();
            if (!File.Exists(serverFilePath))
            {
                return new List<ServerEntry>();
            }

            try
            {
                using var fileStream = File.OpenRead(serverFilePath);
                using var dataStream = CreateReadStream(fileStream);
                using var reader = new BinaryReader(dataStream, Encoding.UTF8, leaveOpen: false);

                var root = ReadRootCompound(reader);
                if (!root.TryGetValue("servers", out var serversTag))
                {
                    return new List<ServerEntry>();
                }

                if (serversTag is not List<NbtCompound> compounds)
                {
                    throw new InvalidDataException("The 'servers' tag is not a compound list.");
                }

                return compounds.Select(ToServerEntry).ToList();
            }
            catch (EndOfStreamException ex)
            {
                throw new InvalidDataException($"Failed to read Minecraft servers file '{serverFilePath}': {ex.Message}", ex);
            }
            catch (InvalidDataException ex)
            {
                throw new InvalidDataException($"Failed to read Minecraft servers file '{serverFilePath}': {ex.Message}", ex);
            }
        }

        private static Stream CreateReadStream(FileStream fileStream)
        {
            Span<byte> header = stackalloc byte[2];
            var read = fileStream.Read(header);
            fileStream.Position = 0;

            var isGzip = read == 2 && header[0] == 0x1F && header[1] == 0x8B;
            if (isGzip)
            {
                return new GZipStream(fileStream, CompressionMode.Decompress);
            }

            return fileStream;
        }

        public void SaveServers(IReadOnlyList<ServerEntry> servers)
        {
            ArgumentNullException.ThrowIfNull(servers);

            var serverFilePath = GetServerFilePath();
            var directory = Path.GetDirectoryName(serverFilePath);
            if (!string.IsNullOrWhiteSpace(directory))
            {
                Directory.CreateDirectory(directory);
            }

            using var fileStream = File.Create(serverFilePath);
            using var gzipStream = new GZipStream(fileStream, CompressionMode.Compress);
            using var writer = new BinaryWriter(gzipStream, Encoding.UTF8, leaveOpen: false);

            WriteRootCompound(writer, new NbtCompound(StringComparer.Ordinal)
            {
                ["servers"] = servers.Select(ToNbtCompound).ToList()
            });
        }

        public void AddOrUpdateServer(ServerEntry server)
        {
            ArgumentNullException.ThrowIfNull(server);

            var servers = GetServers();
            var index = servers.FindIndex(existing => string.Equals(existing.Address, server.Address, StringComparison.OrdinalIgnoreCase));
            if (index >= 0)
            {
                servers[index] = Clone(server);
            }
            else
            {
                servers.Add(Clone(server));
            }

            SaveServers(servers);
        }

        public bool RemoveServer(string address)
        {
            ArgumentNullException.ThrowIfNull(address);

            var servers = GetServers();
            var removed = servers.RemoveAll(server => string.Equals(server.Address, address, StringComparison.OrdinalIgnoreCase)) > 0;
            if (removed)
            {
                SaveServers(servers);
            }

            return removed;
        }

        public ServerEntry? GetServer(string address)
        {
            ArgumentNullException.ThrowIfNull(address);

            return GetServers()
                .FirstOrDefault(server => string.Equals(server.Address, address, StringComparison.OrdinalIgnoreCase));
        }

        public ServerState? GetServerStateByName(string name)
        {
            ArgumentNullException.ThrowIfNull(name);

            var server = GetServers()
                .FirstOrDefault(entry => string.Equals(entry.Name, name, StringComparison.Ordinal));

            return server is null ? null : GetServerStateByAddress(server.Address);
        }

        public ServerState GetServerStateByAddress(string address)
        {
            ArgumentNullException.ThrowIfNull(address);

            var state = new ServerState
            {
                Address = address,
                Name = TryGetServerNameByAddress(address)
            };

            var endpoint = ResolveStatusEndpoint(address);
            var tcpConnected = false;

            try
            {
                return QueryModernServerState(endpoint, state, out tcpConnected);
            }
            catch (Exception ex) when (ex is SocketException or IOException or InvalidDataException or JsonException or FormatException or TimeoutException)
            {
                if (tcpConnected && ShouldFallbackToLegacy(ex))
                {
                    return QueryLegacyServerState(endpoint, state, ex.Message);
                }

                state.IsOnline = false;
                state.ErrorMessage = ex.Message;
                return state;
            }
        }

        public IReadOnlyList<LanServerEntry> DiscoverLanServers(TimeSpan timeout)
        {
            using var cancellationTokenSource = new CancellationTokenSource(timeout);
            var entries = new List<LanServerEntry>();

            try
            {
                var enumerator = DiscoverLanServersAsync(cancellationTokenSource.Token).GetAsyncEnumerator(cancellationTokenSource.Token);
                try
                {
                    while (enumerator.MoveNextAsync().AsTask().GetAwaiter().GetResult())
                    {
                        entries.Add(enumerator.Current);
                    }
                }
                finally
                {
                    enumerator.DisposeAsync().AsTask().GetAwaiter().GetResult();
                }
            }
            catch (OperationCanceledException)
            {
            }

            return entries;
        }

        public async IAsyncEnumerable<LanServerEntry> DiscoverLanServersAsync([EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            UdpClient? client = null;

            try
            {
                client = CreateLanDiscoveryClient();
            }
            catch (SocketException)
            {
                yield break;
            }
            catch (IOException)
            {
                yield break;
            }

            using (client)
            {
                var seen = new HashSet<string>(StringComparer.Ordinal);

                while (!cancellationToken.IsCancellationRequested)
                {
                    UdpReceiveResult result;

                    try
                    {
                        result = await client.ReceiveAsync(cancellationToken);
                    }
                    catch (OperationCanceledException)
                    {
                        yield break;
                    }
                    catch (SocketException)
                    {
                        yield break;
                    }

                    var payload = Encoding.UTF8.GetString(result.Buffer);
                    var entry = ParseLanBroadcast(payload, result.RemoteEndPoint.Address.ToString());
                    if (entry is null)
                    {
                        continue;
                    }

                    var key = $"{entry.Address}|{entry.Port}|{entry.Motd}";
                    if (seen.Add(key))
                    {
                        yield return entry;
                    }
                }
            }
        }

        public string GetServerFilePath()
        {
            if (_versionSpecific)
            {
                return Path.Combine(_gameDirectory, "versions", _version, "servers.dat");
            }

            return Path.Combine(_gameDirectory, "servers.dat");
        }

        public bool ServerFileExists()
        {
            return File.Exists(GetServerFilePath());
        }

        public void ClearServers()
        {
            SaveServers(Array.Empty<ServerEntry>());
        }

        private static ServerEntry ToServerEntry(NbtCompound compound)
        {
            return new ServerEntry
            {
                Name = GetOptionalString(compound, "name") ?? string.Empty,
                Address = GetOptionalString(compound, "ip") ?? string.Empty,
                IconBase64 = GetOptionalString(compound, "icon"),
                AcceptTextures = GetOptionalBool(compound, "acceptTextures")
            };
        }

        private static NbtCompound ToNbtCompound(ServerEntry server)
        {
            var compound = new NbtCompound(StringComparer.Ordinal)
            {
                ["name"] = server.Name ?? string.Empty,
                ["ip"] = server.Address ?? string.Empty,
                ["acceptTextures"] = server.AcceptTextures
            };

            if (!string.IsNullOrEmpty(server.IconBase64))
            {
                compound["icon"] = server.IconBase64;
            }

            return compound;
        }

        private static ServerEntry Clone(ServerEntry server)
        {
            return new ServerEntry
            {
                Name = server.Name,
                Address = server.Address,
                IconBase64 = server.IconBase64,
                AcceptTextures = server.AcceptTextures
            };
        }

        private static string? GetOptionalString(NbtCompound compound, string name)
        {
            if (!compound.TryGetValue(name, out var value))
            {
                return null;
            }

            if (value is not string text)
            {
                throw new InvalidDataException($"Server entry tag '{name}' is not a string.");
            }

            return text;
        }

        private static bool GetOptionalBool(NbtCompound compound, string name)
        {
            if (!compound.TryGetValue(name, out var value))
            {
                return false;
            }

            return value switch
            {
                bool boolean => boolean,
                byte number => number != 0,
                _ => throw new InvalidDataException($"Server entry tag '{name}' is not a byte/boolean.")
            };
        }

        private static (string Host, ushort Port) ParseServerAddress(string address)
        {
            var trimmed = address.Trim();
            if (string.IsNullOrWhiteSpace(trimmed))
            {
                throw new FormatException("Server address cannot be empty.");
            }

            const ushort defaultPort = 25565;

            if (trimmed.StartsWith("[", StringComparison.Ordinal))
            {
                var closingIndex = trimmed.IndexOf(']');
                if (closingIndex < 0)
                {
                    throw new FormatException("IPv6 server address is missing a closing bracket.");
                }

                var host = trimmed[1..closingIndex];
                if (closingIndex == trimmed.Length - 1)
                {
                    return (host, defaultPort);
                }

                if (trimmed[closingIndex + 1] != ':')
                {
                    throw new FormatException("IPv6 server address must use [host]:port format.");
                }

                return (host, ParsePort(trimmed[(closingIndex + 2)..]));
            }

            var firstColonIndex = trimmed.IndexOf(':');
            var lastColonIndex = trimmed.LastIndexOf(':');
            if (firstColonIndex >= 0 && firstColonIndex == lastColonIndex)
            {
                return (trimmed[..firstColonIndex], ParsePort(trimmed[(firstColonIndex + 1)..]));
            }

            return (trimmed, defaultPort);
        }

        private static ushort ParsePort(string text)
        {
            if (!ushort.TryParse(text, out var port))
            {
                throw new FormatException($"Invalid server port '{text}'.");
            }

            return port;
        }

        private static StatusEndpoint ResolveStatusEndpoint(string address)
        {
            var (host, port) = ParseServerAddress(address);
            if (port != 25565 || IPAddress.TryParse(host, out _))
            {
                return new StatusEndpoint(host, port, host);
            }

            try
            {
                var lookup = new LookupClient();
                var query = lookup.Query($"_minecraft._tcp.{host}", QueryType.SRV);
                var record = query.Answers.SrvRecords().FirstOrDefault();
                if (record is null)
                {
                    return new StatusEndpoint(host, port, host);
                }

                var target = record.Target.Value.TrimEnd('.');
                if (string.IsNullOrWhiteSpace(target))
                {
                    return new StatusEndpoint(host, port, host);
                }

                return new StatusEndpoint(target, (ushort)record.Port, host);
            }
            catch (DnsResponseException)
            {
                return new StatusEndpoint(host, port, host);
            }
            catch (SocketException)
            {
                return new StatusEndpoint(host, port, host);
            }
        }

        private static ServerState QueryModernServerState(StatusEndpoint endpoint, ServerState state, out bool tcpConnected)
        {
            using var client = new TcpClient();
            client.ReceiveTimeout = 5000;
            client.SendTimeout = 5000;
            client.ConnectAsync(endpoint.ConnectHost, endpoint.ConnectPort)
                .WaitAsync(TimeSpan.FromSeconds(5))
                .GetAwaiter()
                .GetResult();

            tcpConnected = true;

            using var stream = client.GetStream();
            SendHandshake(stream, endpoint.HandshakeHost, endpoint.ConnectPort);
            SendStatusRequest(stream);

            using var responseDocument = ReadStatusResponse(stream);
            PopulateStateFromResponse(state, responseDocument.RootElement);

            state.Ping = MeasurePing(stream);
            state.IsOnline = true;
            state.ErrorMessage = string.Empty;
            return state;
        }

        private static bool ShouldFallbackToLegacy(Exception exception)
        {
            return exception is InvalidDataException or JsonException or EndOfStreamException;
        }

        private static ServerState QueryLegacyServerState(StatusEndpoint endpoint, ServerState state, string priorError)
        {
            try
            {
                var response = QueryLegacyPingHost(endpoint);
                PopulateStateFromLegacyResponse(state, response);
                state.IsOnline = true;
                state.ErrorMessage = string.Empty;
                return state;
            }
            catch (Exception ex) when (ex is InvalidDataException or IOException or SocketException or TimeoutException)
            {
                try
                {
                    var response = QueryLegacyFe01(endpoint);
                    PopulateStateFromLegacyResponse(state, response);
                    state.IsOnline = true;
                    state.ErrorMessage = string.Empty;
                    return state;
                }
                catch (Exception fallbackEx) when (fallbackEx is InvalidDataException or IOException or SocketException or TimeoutException)
                {
                    state.IsOnline = false;
                    state.ErrorMessage = string.IsNullOrWhiteSpace(fallbackEx.Message) ? priorError : fallbackEx.Message;
                    return state;
                }
            }
        }

        private static LegacyServerResponse QueryLegacyPingHost(StatusEndpoint endpoint)
        {
            using var client = CreateStatusClient(endpoint);
            using var stream = client.GetStream();
            SendLegacyPingHostRequest(stream, endpoint.HandshakeHost, endpoint.ConnectPort);
            return ReadLegacyResponse(stream);
        }

        private static LegacyServerResponse QueryLegacyFe01(StatusEndpoint endpoint)
        {
            using var client = CreateStatusClient(endpoint);
            using var stream = client.GetStream();
            stream.WriteByte(0xFE);
            stream.WriteByte(0x01);
            return ReadLegacyResponse(stream);
        }

        private static TcpClient CreateStatusClient(StatusEndpoint endpoint)
        {
            var client = new TcpClient();
            try
            {
                client.ReceiveTimeout = 5000;
                client.SendTimeout = 5000;
                client.ConnectAsync(endpoint.ConnectHost, endpoint.ConnectPort)
                    .WaitAsync(TimeSpan.FromSeconds(5))
                    .GetAwaiter()
                    .GetResult();
                return client;
            }
            catch
            {
                client.Dispose();
                throw;
            }
        }

        private static void SendLegacyPingHostRequest(Stream stream, string host, ushort port)
        {
            var hostBytes = Encoding.BigEndianUnicode.GetBytes(host);
            var payloadLength = (ushort)(7 + hostBytes.Length);

            stream.WriteByte(0xFE);
            stream.WriteByte(0x01);
            stream.WriteByte(0xFA);
            WriteUInt16BigEndian(stream, 11);
            stream.Write(Encoding.BigEndianUnicode.GetBytes("MC|PingHost"));
            WriteUInt16BigEndian(stream, payloadLength);
            stream.WriteByte(127);
            WriteUInt16BigEndian(stream, (ushort)host.Length);
            stream.Write(hostBytes);
            WriteInt32BigEndian(stream, port);
        }

        private static LegacyServerResponse ReadLegacyResponse(Stream stream)
        {
            var header = stream.ReadByte();
            if (header != 0xFF)
            {
                throw new InvalidDataException($"Unexpected legacy response header {header}.");
            }

            var length = ReadUInt16BigEndian(stream);
            var bytes = new byte[length * 2];
            ReadExactly(stream, bytes, "Legacy server response");
            var text = Encoding.BigEndianUnicode.GetString(bytes);

            return ParseLegacyResponse(text);
        }

        private static LegacyServerResponse ParseLegacyResponse(string text)
        {
            if (text.StartsWith("§1\0", StringComparison.Ordinal))
            {
                var parts = text.Split('\0');
                if (parts.Length < 6)
                {
                    throw new InvalidDataException("Legacy server response does not contain all expected fields.");
                }

                return new LegacyServerResponse(
                    parts[3],
                    ParseLegacyPlayerCount(parts[4], "online players"),
                    ParseLegacyPlayerCount(parts[5], "max players"),
                    parts[2]);
            }

            var segments = text.Split('§');
            if (segments.Length < 3)
            {
                throw new InvalidDataException("Legacy server response format is not recognized.");
            }

            return new LegacyServerResponse(
                segments[0],
                ParseLegacyPlayerCount(segments[1], "online players"),
                ParseLegacyPlayerCount(segments[2], "max players"),
                string.Empty);
        }

        private static int ParseLegacyPlayerCount(string text, string valueName)
        {
            if (!int.TryParse(text, out var value))
            {
                throw new InvalidDataException($"Legacy server response contains an invalid {valueName} value '{text}'.");
            }

            return value;
        }

        private static void PopulateStateFromLegacyResponse(ServerState state, LegacyServerResponse response)
        {
            state.Description = response.Motd;
            state.OnlinePlayers = response.OnlinePlayers;
            state.MaxPlayers = response.MaxPlayers;
            state.Version = response.VersionName;
            state.Ping = 0;
        }

        private static UdpClient CreateLanDiscoveryClient()
        {
            var client = new UdpClient(AddressFamily.InterNetwork);
            try
            {
                client.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                client.ExclusiveAddressUse = false;
                client.Client.Bind(new IPEndPoint(IPAddress.Any, 4445));
                client.JoinMulticastGroup(IPAddress.Parse("224.0.2.60"));
                return client;
            }
            catch
            {
                client.Dispose();
                throw;
            }
        }

        private static LanServerEntry? ParseLanBroadcast(string payload, string sourceAddress)
        {
            var motd = ExtractLanTag(payload, "MOTD") ?? "missing no";
            var portText = ExtractLanTag(payload, "AD");
            if (!int.TryParse(portText, out var port))
            {
                return null;
            }

            return new LanServerEntry
            {
                Motd = motd,
                Address = sourceAddress,
                Port = port,
                DisplayAddress = $"{sourceAddress}:{port}"
            };
        }

        private static string? ExtractLanTag(string payload, string tagName)
        {
            var startTag = $"[{tagName}]";
            var endTag = $"[/{tagName}]";
            var startIndex = payload.IndexOf(startTag, StringComparison.Ordinal);
            if (startIndex < 0)
            {
                return null;
            }

            startIndex += startTag.Length;
            var endIndex = payload.IndexOf(endTag, startIndex, StringComparison.Ordinal);
            if (endIndex < 0)
            {
                return null;
            }

            return payload[startIndex..endIndex];
        }

        private string TryGetServerNameByAddress(string address)
        {
            try
            {
                return GetServers()
                    .FirstOrDefault(server => string.Equals(server.Address, address, StringComparison.OrdinalIgnoreCase))?.Name
                    ?? string.Empty;
            }
            catch (Exception ex) when (ex is InvalidDataException or IOException or UnauthorizedAccessException)
            {
                return string.Empty;
            }
        }

        private static void SendHandshake(Stream stream, string host, ushort port)
        {
            using var packetStream = new MemoryStream();
            WriteVarInt(packetStream, 0);
            WriteVarInt(packetStream, 47);
            WriteString(packetStream, host);
            WriteUInt16BigEndian(packetStream, port);
            WriteVarInt(packetStream, 1);
            WritePacket(stream, packetStream.ToArray());
        }

        private static void SendStatusRequest(Stream stream)
        {
            using var packetStream = new MemoryStream();
            WriteVarInt(packetStream, 0);
            WritePacket(stream, packetStream.ToArray());
        }

        private static JsonDocument ReadStatusResponse(Stream stream)
        {
            _ = ReadVarInt(stream);
            var packetId = ReadVarInt(stream);
            if (packetId != 0)
            {
                throw new InvalidDataException($"Unexpected status response packet id {packetId}.");
            }

            var json = ReadString(stream);
            return JsonDocument.Parse(json);
        }

        private static long MeasurePing(Stream stream)
        {
            using var packetStream = new MemoryStream();
            WriteVarInt(packetStream, 1);
            var timestamp = Stopwatch.GetTimestamp();
            Span<byte> payload = stackalloc byte[sizeof(long)];
            BitConverter.TryWriteBytes(payload, timestamp);
            if (BitConverter.IsLittleEndian)
            {
                payload.Reverse();
            }

            packetStream.Write(payload);

            var stopwatch = Stopwatch.StartNew();
            WritePacket(stream, packetStream.ToArray());

            _ = ReadVarInt(stream);
            var packetId = ReadVarInt(stream);
            if (packetId != 1)
            {
                throw new InvalidDataException($"Unexpected pong response packet id {packetId}.");
            }

            _ = ReadInt64BigEndian(stream);
            stopwatch.Stop();
            return stopwatch.ElapsedMilliseconds;
        }

        private static void PopulateStateFromResponse(ServerState state, JsonElement response)
        {
            if (response.TryGetProperty("version", out var version) && version.TryGetProperty("name", out var versionName))
            {
                state.Version = versionName.GetString() ?? string.Empty;
            }

            if (response.TryGetProperty("players", out var players))
            {
                if (players.TryGetProperty("online", out var onlinePlayers) && onlinePlayers.TryGetInt32(out var online))
                {
                    state.OnlinePlayers = online;
                }

                if (players.TryGetProperty("max", out var maxPlayers) && maxPlayers.TryGetInt32(out var max))
                {
                    state.MaxPlayers = max;
                }
            }

            if (response.TryGetProperty("description", out var description))
            {
                state.Description = FlattenDescription(description).Trim();
            }
        }

        private static string FlattenDescription(JsonElement description)
        {
            return description.ValueKind switch
            {
                JsonValueKind.String => description.GetString() ?? string.Empty,
                JsonValueKind.Object => FlattenDescriptionObject(description),
                JsonValueKind.Array => string.Concat(description.EnumerateArray().Select(FlattenDescription)),
                _ => string.Empty
            };
        }

        private static string FlattenDescriptionObject(JsonElement description)
        {
            var builder = new StringBuilder();

            if (description.TryGetProperty("text", out var text))
            {
                builder.Append(text.GetString());
            }

            if (description.TryGetProperty("extra", out var extra) && extra.ValueKind == JsonValueKind.Array)
            {
                foreach (var element in extra.EnumerateArray())
                {
                    builder.Append(FlattenDescription(element));
                }
            }

            return builder.ToString();
        }

        private static NbtCompound ReadRootCompound(BinaryReader reader)
        {
            var tagType = reader.ReadByte();
            if (tagType != NbtTagType.Compound)
            {
                throw new InvalidDataException($"Expected root compound tag, but found type {tagType}.");
            }

            _ = ReadString(reader);
            return ReadCompoundPayload(reader);
        }

        private static void WriteRootCompound(BinaryWriter writer, NbtCompound root)
        {
            writer.Write(NbtTagType.Compound);
            WriteString(writer, string.Empty);
            WriteCompoundPayload(writer, root);
        }

        private static NbtCompound ReadCompoundPayload(BinaryReader reader)
        {
            var compound = new NbtCompound(StringComparer.Ordinal);

            while (true)
            {
                var tagType = reader.ReadByte();
                if (tagType == NbtTagType.End)
                {
                    return compound;
                }

                var name = ReadString(reader);
                compound[name] = ReadTagPayload(reader, tagType);
            }
        }

        private static object ReadTagPayload(BinaryReader reader, byte tagType)
        {
            return tagType switch
            {
                NbtTagType.Byte => reader.ReadByte() != 0,
                NbtTagType.String => ReadString(reader),
                NbtTagType.List => ReadListPayload(reader),
                NbtTagType.Compound => ReadCompoundPayload(reader),
                _ => throw new InvalidDataException($"Unsupported NBT tag type {tagType} in servers.dat.")
            };
        }

        private static object ReadListPayload(BinaryReader reader)
        {
            var elementType = reader.ReadByte();
            var length = ReadInt32BigEndian(reader);
            if (length < 0)
            {
                throw new InvalidDataException("NBT list length cannot be negative.");
            }

            if (elementType != NbtTagType.Compound)
            {
                throw new InvalidDataException($"Unsupported NBT list element type {elementType} in servers.dat.");
            }

            var items = new List<NbtCompound>(length);
            for (var i = 0; i < length; i++)
            {
                items.Add(ReadCompoundPayload(reader));
            }

            return items;
        }

        private static void WriteCompoundPayload(BinaryWriter writer, NbtCompound compound)
        {
            foreach (var entry in compound)
            {
                WriteNamedTag(writer, entry.Key, entry.Value);
            }

            writer.Write(NbtTagType.End);
        }

        private static void WriteNamedTag(BinaryWriter writer, string name, object value)
        {
            switch (value)
            {
                case bool boolean:
                    writer.Write(NbtTagType.Byte);
                    WriteString(writer, name);
                    writer.Write(boolean ? (byte)1 : (byte)0);
                    break;
                case string text:
                    writer.Write(NbtTagType.String);
                    WriteString(writer, name);
                    WriteString(writer, text);
                    break;
                case List<NbtCompound> compounds:
                    writer.Write(NbtTagType.List);
                    WriteString(writer, name);
                    writer.Write(NbtTagType.Compound);
                    WriteInt32BigEndian(writer, compounds.Count);
                    foreach (var compound in compounds)
                    {
                        WriteCompoundPayload(writer, compound);
                    }
                    break;
                case NbtCompound compound:
                    writer.Write(NbtTagType.Compound);
                    WriteString(writer, name);
                    WriteCompoundPayload(writer, compound);
                    break;
                default:
                    throw new InvalidOperationException($"Unsupported NBT value type '{value.GetType().FullName}'.");
            }
        }

        private static string ReadString(BinaryReader reader)
        {
            var length = ReadUInt16BigEndian(reader);
            var bytes = reader.ReadBytes(length);
            if (bytes.Length != length)
            {
                throw new EndOfStreamException("Unexpected end of stream while reading NBT string.");
            }

            return Encoding.UTF8.GetString(bytes);
        }

        private static void WriteString(BinaryWriter writer, string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            if (bytes.Length > ushort.MaxValue)
            {
                throw new InvalidOperationException("NBT string length exceeds UInt16.MaxValue.");
            }

            WriteUInt16BigEndian(writer, (ushort)bytes.Length);
            writer.Write(bytes);
        }

        private static int ReadInt32BigEndian(BinaryReader reader)
        {
            Span<byte> bytes = stackalloc byte[sizeof(int)];
            ReadExactly(reader, bytes, "NBT Int32");

            if (BitConverter.IsLittleEndian)
            {
                bytes.Reverse();
            }

            return BitConverter.ToInt32(bytes);
        }

        private static long ReadInt64BigEndian(Stream stream)
        {
            Span<byte> bytes = stackalloc byte[sizeof(long)];
            ReadExactly(stream, bytes, "Int64");

            if (BitConverter.IsLittleEndian)
            {
                bytes.Reverse();
            }

            return BitConverter.ToInt64(bytes);
        }

        private static ushort ReadUInt16BigEndian(BinaryReader reader)
        {
            Span<byte> bytes = stackalloc byte[sizeof(ushort)];
            ReadExactly(reader, bytes, "NBT UInt16");

            if (BitConverter.IsLittleEndian)
            {
                bytes.Reverse();
            }

            return BitConverter.ToUInt16(bytes);
        }

        private static ushort ReadUInt16BigEndian(Stream stream)
        {
            Span<byte> bytes = stackalloc byte[sizeof(ushort)];
            ReadExactly(stream, bytes, "UInt16");

            if (BitConverter.IsLittleEndian)
            {
                bytes.Reverse();
            }

            return BitConverter.ToUInt16(bytes);
        }

        private static void ReadExactly(BinaryReader reader, Span<byte> buffer, string valueName)
        {
            var totalRead = 0;
            while (totalRead < buffer.Length)
            {
                var read = reader.Read(buffer[totalRead..]);
                if (read == 0)
                {
                    throw new EndOfStreamException($"Unexpected end of stream while reading {valueName}.");
                }

                totalRead += read;
            }
        }

        private static void ReadExactly(Stream stream, Span<byte> buffer, string valueName)
        {
            var totalRead = 0;
            while (totalRead < buffer.Length)
            {
                var read = stream.Read(buffer[totalRead..]);
                if (read == 0)
                {
                    throw new EndOfStreamException($"Unexpected end of stream while reading {valueName}.");
                }

                totalRead += read;
            }
        }

        private static int ReadVarInt(Stream stream)
        {
            var value = 0;
            var position = 0;

            while (true)
            {
                var currentByte = stream.ReadByte();
                if (currentByte < 0)
                {
                    throw new EndOfStreamException("Unexpected end of stream while reading VarInt.");
                }

                value |= (currentByte & 0x7F) << position;
                if ((currentByte & 0x80) == 0)
                {
                    return value;
                }

                position += 7;
                if (position >= 35)
                {
                    throw new InvalidDataException("VarInt is too large.");
                }
            }
        }

        private static string ReadString(Stream stream)
        {
            var length = ReadVarInt(stream);
            if (length < 0)
            {
                throw new InvalidDataException("String length cannot be negative.");
            }

            var bytes = new byte[length];
            ReadExactly(stream, bytes, "String");
            return Encoding.UTF8.GetString(bytes);
        }

        private static void WriteInt32BigEndian(BinaryWriter writer, int value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(int)];
            BitConverter.TryWriteBytes(bytes, value);
            if (BitConverter.IsLittleEndian)
            {
                bytes.Reverse();
            }

            writer.Write(bytes);
        }

        private static void WriteUInt16BigEndian(Stream stream, ushort value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(ushort)];
            BitConverter.TryWriteBytes(bytes, value);
            if (BitConverter.IsLittleEndian)
            {
                bytes.Reverse();
            }

            stream.Write(bytes);
        }

        private static void WriteInt32BigEndian(Stream stream, int value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(int)];
            BitConverter.TryWriteBytes(bytes, value);
            if (BitConverter.IsLittleEndian)
            {
                bytes.Reverse();
            }

            stream.Write(bytes);
        }

        private static void WriteUInt16BigEndian(BinaryWriter writer, ushort value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(ushort)];
            BitConverter.TryWriteBytes(bytes, value);
            if (BitConverter.IsLittleEndian)
            {
                bytes.Reverse();
            }

            writer.Write(bytes);
        }

        private static void WriteVarInt(Stream stream, int value)
        {
            var unsignedValue = unchecked((uint)value);

            do
            {
                var currentByte = (byte)(unsignedValue & 0x7F);
                unsignedValue >>= 7;
                if (unsignedValue != 0)
                {
                    currentByte |= 0x80;
                }

                stream.WriteByte(currentByte);
            }
            while (unsignedValue != 0);
        }

        private static void WriteString(Stream stream, string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            WriteVarInt(stream, bytes.Length);
            stream.Write(bytes);
        }

        private static void WritePacket(Stream stream, byte[] payload)
        {
            WriteVarInt(stream, payload.Length);
            stream.Write(payload);
        }

        private sealed class NbtCompound : Dictionary<string, object>
        {
            public NbtCompound(IEqualityComparer<string>? comparer)
                : base(comparer)
            {
            }
        }

        private readonly record struct StatusEndpoint(string ConnectHost, ushort ConnectPort, string HandshakeHost);

        private readonly record struct LegacyServerResponse(string Motd, int OnlinePlayers, int MaxPlayers, string VersionName);

        private static class NbtTagType
        {
            public const byte End = 0;
            public const byte Byte = 1;
            public const byte String = 8;
            public const byte List = 9;
            public const byte Compound = 10;
        }
    }

    public sealed class ServerEntry
    {
        public string Name { get; set; } = string.Empty;

        public string Address { get; set; } = string.Empty;

        public string? IconBase64 { get; set; }

        public bool AcceptTextures { get; set; }
    }

    public sealed class ServerState
    {
        public string Name { get; set; } = string.Empty;

        public string Address { get; set; } = string.Empty;

        public bool IsOnline { get; set; }

        public long Ping { get; set; }

        public int OnlinePlayers { get; set; }

        public int MaxPlayers { get; set; }

        public string Version { get; set; } = string.Empty;

        public string Description { get; set; } = string.Empty;

        public string ErrorMessage { get; set; } = string.Empty;
    }

    public sealed class LanServerEntry
    {
        public string Motd { get; set; } = string.Empty;

        public string Address { get; set; } = string.Empty;

        public int Port { get; set; }

        public string DisplayAddress { get; set; } = string.Empty;
    }
}
