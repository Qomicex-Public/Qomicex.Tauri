using Microsoft.AspNetCore.Http.HttpResults;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class McmodEndpoints
{
    public static void MapMcmodEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/mcmod");

        group.MapGet("/lookup", (string name, McmodService mcmod) =>
        {
            var cn = mcmod.Lookup(name);
            if (cn == null) return Results.Json(new CnNameResponse(null), ApiJsonContext.Default.CnNameResponse);
            return Results.Json(new CnNameResponse(cn), ApiJsonContext.Default.CnNameResponse);
        });

        group.MapPost("/batch", (List<string> names, McmodService mcmod) =>
        {
            if (names == null || names.Count == 0)
                return Results.Json(new Dictionary<string, string>(), ApiJsonContext.Default.DictionaryStringString);
            var result = mcmod.BatchLookup(names);
            var safe = result.ToDictionary(kv => kv.Key, kv => kv.Value ?? "");
            return Results.Json(safe, ApiJsonContext.Default.DictionaryStringString);
        });
    }
}

public sealed record CnNameResponse(string? CnName);
