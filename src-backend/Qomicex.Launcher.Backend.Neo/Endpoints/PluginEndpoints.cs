using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class PluginEndpoints
{
    public static void MapPluginEndpoints(this WebApplication app)
    {
        var plugins = app.MapGroup("/api/plugins");

        plugins.MapGet("/", (PluginStore store) =>
        {
            return Results.Ok(store.ListPlugins());
        });

        plugins.MapGet("/{id}", (string id, PluginStore store) =>
        {
            var plugin = store.GetPlugin(id);
            return plugin != null ? Results.Ok(plugin) : Results.NotFound();
        });

        plugins.MapPost("/rescan", (PluginStore store) =>
        {
            store.InvalidateCache();
            return Results.Ok(new RescanResponse { Scanned = store.ListPlugins().Count });
        });

        plugins.MapPost("/install", (PluginStore store, InstallRequest req) =>
        {
            var plugin = store.InstallPlugin(req.SourceDir);
            return plugin != null ? Results.Ok(plugin) : Results.BadRequest("Invalid plugin package");
        });

        plugins.MapDelete("/{id}", (string id, PluginStore store) =>
        {
            store.UninstallPlugin(id);
            return Results.NoContent();
        });

        plugins.MapPost("/upload", async (HttpRequest request, PluginPackageService packageService, PluginStore store) =>
        {
            if (!request.HasFormContentType)
                return Results.BadRequest("Expected multipart form");

            var file = request.Form.Files.GetFile("plugin");
            if (file == null)
                return Results.BadRequest("No plugin file uploaded");

            using var stream = file.OpenReadStream();
            var plugin = packageService.InstallFromPackage(stream);
            if (plugin == null)
                return Results.BadRequest("Invalid plugin package");

            store.InvalidateCache();
            return Results.Ok(plugin);
        });

        plugins.MapPut("/{id}/state", (string id, PluginStore store, SetPluginStateRequest req) =>
        {
            var plugin = store.GetPlugin(id);
            if (plugin == null) return Results.NotFound();

            store.SetPluginState(id, req.State);
            plugin.State = req.State;
            return Results.Ok(plugin);
        });

        plugins.MapGet("/{id}/files/{*path}", (string id, string path) =>
        {
            var filePath = Path.Combine(AppPaths.PluginsDir, id, path);
            if (!File.Exists(filePath)) return Results.NotFound();
            var ext = Path.GetExtension(filePath).ToLowerInvariant();
            var contentType = ext switch
            {
                ".css" => "text/css",
                ".js" => "application/javascript",
                ".json" => "application/json",
                ".png" => "image/png",
                ".jpg" or ".jpeg" => "image/jpeg",
                ".svg" => "image/svg+xml",
                ".html" or ".htm" => "text/html",
                _ => "application/octet-stream",
            };
            return Results.File(filePath, contentType);
        });

        plugins.MapGet("/settings/{id}", (string id) =>
        {
            var settingsFile = Path.Combine(AppPaths.PluginsDir, id, "settings.json");
            if (!File.Exists(settingsFile))
                return Results.Content("{}", "application/json");
            var json = File.ReadAllText(settingsFile);
            return Results.Content(json, "application/json");
        });

        plugins.MapPost("/settings/{id}", async (string id, HttpRequest request) =>
        {
            var settingsDir = Path.Combine(AppPaths.PluginsDir, id);
            Directory.CreateDirectory(settingsDir);
            var settingsFile = Path.Combine(settingsDir, "settings.json");
            using var reader = new StreamReader(request.Body);
            var json = await reader.ReadToEndAsync();
            File.WriteAllText(settingsFile, json);
            return Results.Ok();
        });
    }
}

public record SetPluginStateRequest(string State);
