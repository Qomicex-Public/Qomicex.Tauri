using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Services.Connector;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class ConnectorEndpoints
{
    public static void MapConnectorEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/connector");

        group.MapPost("/host/port", async (HostByPortRequest req, ConnectorService connector, CancellationToken ct) =>
        {
            var roomCode = await connector.HostByPortAsync(req.Port, ct);
            return Results.Json(new HostResponse(roomCode, null, null), ApiJsonContext.Default.HostResponse);
        });

        group.MapPost("/host/instance", async (HostByInstanceRequest req, ConnectorService connector, CancellationToken ct) =>
        {
            await connector.HostByInstanceAsync(req.InstanceId, ct);
            return Results.Json(new HostResponse(null, "hosting", null), ApiJsonContext.Default.HostResponse);
        });

        group.MapPost("/join", async (JoinRequest req, ConnectorService connector, CancellationToken ct) =>
        {
            var (host, port) = await connector.JoinAsync(req.Code, ct);
            return Results.Json(new JoinResponse(host, port), ApiJsonContext.Default.JoinResponse);
        });

        group.MapGet("/status", (ConnectorService connector) =>
            Results.Json(connector.GetStatus(), ApiJsonContext.Default.ConnectorStatusDto));

        group.MapGet("/easytier/status", (ConnectorService connector) =>
            Results.Json(connector.GetEasyTierStatus(), ApiJsonContext.Default.EasyTierDownloadStatus));

        group.MapPost("/easytier/download", (ConnectorService connector) =>
        {
            connector.EnsureEasyTierDownloadStarted();
            return Results.Json(connector.GetEasyTierStatus(), ApiJsonContext.Default.EasyTierDownloadStatus);
        });

        group.MapPost("/leave", async (ConnectorService connector, CancellationToken ct) =>
        {
            await connector.LeaveAsync(ct);
            return Results.Json(new StatusResponse("idle"), ApiJsonContext.Default.StatusResponse);
        });

        group.MapGet("/scan-ports", (ConnectorService connector) =>
            Results.Json(new ScanPortsResponse(connector.ScanJavaPort()), ApiJsonContext.Default.ScanPortsResponse));
    }
}

public sealed record HostResponse(string? RoomCode, string? Status, string? Error);
public sealed record JoinResponse(string McHost, int McPort);
public sealed record StatusResponse(string Status);
public sealed record ScanPortsResponse(int? Port);
public sealed record HostByPortRequest(int Port);
public sealed record HostByInstanceRequest(string InstanceId);
public sealed record JoinRequest(string Code);
