using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class AccountEndpoints
{
    public static void MapAccountEndpoints(this WebApplication app, AccountService accountService)
    {
        var group = app.MapGroup("/api/account");

        group.MapGet("/", async () =>
        {
            var accounts = await accountService.GetAccountsAsync();
            return Results.Json(accounts, ApiJsonContext.Default.ListAccountInfo);
        });

        group.MapGet("/{uuid}", async (string uuid) =>
        {
            var account = await accountService.GetAccountAsync(uuid);
            return account != null
                ? Results.Json(account, ApiJsonContext.Default.StoredAccount)
                : Results.NotFound();
        });

        group.MapPost("/", async (StoredAccount body) =>
        {
            await accountService.AutoSetDefaultOnSaveAsync(body);
            return Results.Json(body, ApiJsonContext.Default.StoredAccount);
        });

        group.MapDelete("/{uuid}", async (string uuid) =>
        {
            var account = await accountService.GetAccountAsync(uuid);
            if (account != null && account.IsDefault)
                await accountService.AutoReassignDefaultOnDeleteAsync(uuid);
            else
                await accountService.DeleteAccountAsync(uuid);
            return Results.NoContent();
        });

        group.MapGet("/default", async () =>
        {
            var account = await accountService.GetDefaultAsync();
            return account != null
                ? Results.Json(account, ApiJsonContext.Default.StoredAccount)
                : Results.NotFound();
        });

        group.MapPut("/{uuid}/default", async (string uuid) =>
        {
            var account = await accountService.GetAccountAsync(uuid);
            if (account == null) return Results.NotFound();
            await accountService.SetDefaultAsync(uuid);
            return Results.Json(account, ApiJsonContext.Default.StoredAccount);
        });

        group.MapDelete("/default", async () =>
        {
            await accountService.ClearDefaultAsync();
            return Results.NoContent();
        });

        group.MapGet("/lost", () =>
        {
            var lost = accountService.CheckAccountsLost();
            return Results.Json(new LostResponse(lost), ApiJsonContext.Default.LostResponse);
        });

        group.MapGet("/offline-uuid", (string name) =>
        {
            if (string.IsNullOrWhiteSpace(name))
                return Results.BadRequest(new { error = "name is required" });
            var hash = MD5.HashData(Encoding.UTF8.GetBytes("OfflinePlayer:" + name));
            hash[6] = (byte)((hash[6] & 0x0f) | 0x40);
            hash[8] = (byte)((hash[8] & 0x3f) | 0x80);
            var uuid = new Guid(hash).ToString("D");
            return Results.Json(new OfflineUuidResponse(uuid), ApiJsonContext.Default.OfflineUuidResponse);
        });

        group.MapGet("/yggdrasil-meta", async (string serverUrl, IHttpClientFactory httpFactory) =>
        {
            if (string.IsNullOrWhiteSpace(serverUrl))
                return Results.BadRequest();
            try
            {
                var http = httpFactory.CreateClient();
                var resp = await http.GetStringAsync(serverUrl);
                var json = JsonDocument.Parse(resp);
                var name = json.RootElement.GetProperty("meta").GetProperty("serverName").GetString();
                return Results.Json(new YggdrasilMetaResponse(name ?? ""), ApiJsonContext.Default.YggdrasilMetaResponse);
            }
            catch
            {
                return Results.Json(new YggdrasilMetaResponse(""), ApiJsonContext.Default.YggdrasilMetaResponse);
            }
        });
    }
}
