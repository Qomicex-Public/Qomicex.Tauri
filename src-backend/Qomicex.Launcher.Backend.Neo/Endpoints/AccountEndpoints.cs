using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class AccountEndpoints
{
    public static void MapAccountEndpoints(this WebApplication app)
    {
        app.MapGet("/api/account", () =>
        {
            return Results.Json(new List<object>(), ApiJsonContext.Default.ListObject);
        });
    }
}
