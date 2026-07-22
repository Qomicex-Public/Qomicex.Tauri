using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class AnnouncementEndpoints
{
    public static void MapAnnouncementEndpoints(this WebApplication app)
    {
        app.MapGet("/api/client/announcements", async (
            string? channel,
            IHttpClientFactory httpFactory,
            CancellationToken ct) =>
        {
            var client = httpFactory.CreateClient("QomicexWeb");

            var url = "/api/client/announcements";
            if (!string.IsNullOrEmpty(channel))
            {
                url += $"?channel={Uri.EscapeDataString(channel)}";
            }

            var response = await client.GetAsync(url, ct);
            if (!response.IsSuccessStatusCode)
            {
                return Results.Json(new List<AnnouncementDto>(), ApiJsonContext.Default.ListAnnouncementDto);
            }

            var json = await response.Content.ReadAsStringAsync(ct);
            var result = JsonSerializer.Deserialize(json, ApiJsonContext.Default.ListAnnouncementDto);
            return Results.Json(result ?? new List<AnnouncementDto>(), ApiJsonContext.Default.ListAnnouncementDto);
        });
    }
}

public sealed record AnnouncementDto(
    string Id,
    string Title,
    string Content,
    string? Channel,
    string CreatedAt);
