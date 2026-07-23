using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Qomicex.Core.AOT.Builder;
using Qomicex.Core.AOT.Core;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class AuthEndpoints
{
    public static void MapAuthEndpoints(this WebApplication app, DefaultGameCore core, AccountService accountService)
    {
        var group = app.MapGroup("/api/auth");

        group.MapPost("/offline", async (AuthRequest req) =>
        {
            var authReq = new Qomicex.Core.AOT.Interfaces.AuthRequest
            {
                Username = req.Username ?? "Player",
                IsOffline = true
            };
            var result = await core.Auth.AuthenticateAsync(authReq);
            return ToResponse(result);
        });

        group.MapPost("/microsoft/device-code", async () =>
        {
            var deviceCodeTask = core.Auth.StartDeviceCodeAsync();
            if (deviceCodeTask == null)
                throw ApiException.BadRequest("Device code flow not supported by current auth provider", "NOT_SUPPORTED");
            var result = await deviceCodeTask;
            if (result == null)
                throw ApiException.BadRequest("Device code flow not supported by current auth provider", "NOT_SUPPORTED");
            return Results.Json(new AuthResponse(
                Success: true,
                Username: null,
                AccessToken: null,
                Uuid: null,
                UserType: "microsoft",
                ErrorMessage: null,
                DeviceCode: result.DeviceCode,
                UserCode: result.UserCode,
                VerificationUri: result.VerificationUri,
                Interval: result.Interval,
                ExpiresIn: result.ExpiresIn
            ), ApiJsonContext.Default.AuthResponse);
        });

        group.MapPost("/microsoft/poll", async (AuthRequest req) =>
        {
            if (string.IsNullOrEmpty(req.AccessToken))
                throw ApiException.BadRequest("deviceCode is required", "MISSING_PARAMETER");
            var pollTask = core.Auth.PollForTokenAsync(req.AccessToken);
            if (pollTask == null)
                throw ApiException.BadRequest("Polling not supported by current auth provider", "NOT_SUPPORTED");
            var result = await pollTask;
            if (result == null)
                throw ApiException.BadRequest("Polling not supported", "NOT_SUPPORTED");
            if (result.IsCompleted && result.AccessToken != null)
            {
                var authResult = await core.Auth.CompleteLoginAsync(result.AccessToken, result.RefreshToken ?? "");
                return Results.Json(new AuthResponse(
                    Success: authResult.Success,
                    Username: authResult.Username,
                    AccessToken: authResult.AccessToken,
                    Uuid: authResult.Uuid,
                    RefreshToken: authResult.RefreshToken,
                    UserType: authResult.UserType ?? "microsoft",
                    ErrorMessage: authResult.ErrorMessage
                ), ApiJsonContext.Default.AuthResponse);
            }
            return Results.Json(new AuthResponse(
                Success: false,
                Username: null,
                AccessToken: null,
                Uuid: null,
                UserType: "microsoft",
                ErrorMessage: result.Error,
                IsPending: result.IsPending
            ), ApiJsonContext.Default.AuthResponse);
        });

        group.MapPost("/microsoft/info", async (MicrosoftInfoRequest req, IHttpClientFactory httpFactory) =>
        {
            var http = httpFactory.CreateClient();
            using var profileReq = new HttpRequestMessage(HttpMethod.Get,
                "https://api.minecraftservices.com/minecraft/profile");
            profileReq.Headers.Authorization =
                new AuthenticationHeaderValue("Bearer", req.AccessToken);
            using var profileResp = await http.SendAsync(profileReq);
            if (!profileResp.IsSuccessStatusCode)
                throw ApiException.BadRequest("该 Microsoft 账号没有关联的 Minecraft 档案", "NO_MINECRAFT_PROFILE");

            var body = await profileResp.Content.ReadAsStringAsync();
            var doc = JsonDocument.Parse(body);
            var uuid = doc.RootElement.GetProperty("id").GetString() ?? "";
            if (string.IsNullOrEmpty(uuid))
                throw ApiException.BadRequest("该 Microsoft 账号没有关联的 Minecraft 档案", "NO_MINECRAFT_PROFILE");

            var stored = new StoredAccount
            {
                Name = doc.RootElement.GetProperty("name").GetString() ?? "",
                Uuid = uuid,
                Token = req.AccessToken,
                AccessToken = req.AccessToken,
                RefreshToken = req.RefreshToken,
                LoginMethod = "Microsoft",
            };
            await accountService.SaveAccountAsync(stored);
            return Results.Json(stored, ApiJsonContext.Default.StoredAccount);
        });

        group.MapPost("/microsoft/refresh", async (MicrosoftRefreshRequest req) =>
        {
            var account = await accountService.GetAccountAsync(req.AccountUuid);
            if (account == null)
                throw ApiException.NotFound("ACCOUNT_NOT_FOUND", "Account not found");
            if (account.LoginMethod != "Microsoft")
                throw ApiException.BadRequest("INVALID_ACCOUNT_TYPE", "Not a Microsoft account");
            if (string.IsNullOrEmpty(account.RefreshToken))
                throw ApiException.BadRequest("MISSING_REFRESH_TOKEN", "Missing refresh token");

            try
            {
                var result = await core.Auth.RefreshLoginAsync(account.RefreshToken);
                if (!result.Success)
                    return Results.Json(new MicrosoftRefreshResponse(false, true, "TOKEN_EXPIRED"), ApiJsonContext.Default.MicrosoftRefreshResponse);
                account.AccessToken = result.AccessToken ?? "";
                account.RefreshToken = result.RefreshToken ?? "";
                account.Name = result.Username ?? account.Name;
                account.Uuid = result.Uuid ?? account.Uuid;
                await accountService.SaveAccountAsync(account);
                return Results.Json(new MicrosoftRefreshResponse(true, null, null), ApiJsonContext.Default.MicrosoftRefreshResponse);
            }
            catch (Exception ex) when (ex.Message.Contains("invalid_grant") || ex.Message.Contains("AADSTS70008"))
            {
                return Results.Json(new MicrosoftRefreshResponse(false, true, "TOKEN_EXPIRED"), ApiJsonContext.Default.MicrosoftRefreshResponse);
            }
        });

        group.MapPost("/yggdrasil", async (AuthRequest req, IHttpClientFactory httpFactory) =>
        {
            var http = httpFactory.CreateClient();
            var baseUrl = (req.ServerUrl ?? "https://littleskin.cn/api/yggdrasil").TrimEnd('/');

            var authPayload = new JsonObject
            {
                ["agent"] = new JsonObject { ["name"] = "Minecraft", ["version"] = 1 },
                ["username"] = req.Username,
                ["password"] = req.Password,
                ["clientToken"] = Guid.NewGuid().ToString("N"),
                ["requestUser"] = true
            };

            using var authResp = await http.PostAsync(
                $"{baseUrl}/authserver/authenticate",
                new StringContent(authPayload.ToString(), Encoding.UTF8, "application/json"));

            var body = await authResp.Content.ReadAsStringAsync();
            var doc = JsonDocument.Parse(body);

            if (!authResp.IsSuccessStatusCode)
            {
                var errMsg = doc.RootElement.TryGetProperty("errorMessage", out var err) ? err.GetString() : $"认证失败: {authResp.StatusCode}";
                return Results.Json(new YggdrasilProfilesResponse(
                    Success: false, AccessToken: null, ClientToken: null, Profiles: null, ErrorMessage: errMsg
                ), ApiJsonContext.Default.YggdrasilProfilesResponse);
            }

            var accessToken = doc.RootElement.GetProperty("accessToken").GetString() ?? "";
            var clientToken = doc.RootElement.GetProperty("clientToken").GetString() ?? "";

            var profiles = new List<YggdrasilProfileInfo>();
            if (doc.RootElement.TryGetProperty("availableProfiles", out var profilesEl))
            {
                foreach (var p in profilesEl.EnumerateArray())
                {
                    profiles.Add(new YggdrasilProfileInfo(
                        p.GetProperty("id").GetString() ?? "",
                        p.GetProperty("name").GetString() ?? ""));
                }
            }

            return Results.Json(new YggdrasilProfilesResponse(
                Success: true, AccessToken: accessToken, ClientToken: clientToken,
                Profiles: profiles.Count > 0 ? profiles : null
            ), ApiJsonContext.Default.YggdrasilProfilesResponse);
        });

        group.MapPost("/yggdrasil/select", async (YggdrasilSelectRequest req) =>
        {
            var saved = new List<StoredAccount>();
            foreach (var p in req.SelectedProfiles)
            {
                var stored = new StoredAccount
                {
                    Name = p.Name,
                    Uuid = p.Id,
                    Token = req.AccessToken,
                    AccessToken = req.AccessToken,
                    RefreshToken = req.ClientToken,
                    LoginMethod = "Yggdrasil",
                    ServerUrl = req.ServerUrl,
                };
                await accountService.SaveAccountAsync(stored);
                saved.Add(stored);
            }
            return Results.Json(saved, ApiJsonContext.Default.ListStoredAccount);
        });

        group.MapPost("/tongyi", async (TongyiLoginRequest req, IHttpClientFactory httpFactory) =>
        {
            var serverUrl = $"https://auth.mc-user.com:233/{req.ServerId}/";
            using var authCore = new GameCoreBuilder()
                .UseYggdrasilAuth(serverUrl)
                .WithHttpClient(httpFactory.CreateClient())
                .Build();
            var authReq = new Qomicex.Core.AOT.Interfaces.AuthRequest
            {
                Username = req.Email,
                Password = req.Password,
                ServerUrl = serverUrl,
                IsOffline = false
            };
            var result = await authCore.Auth.AuthenticateAsync(authReq);
            if (!result.Success || result.Uuid == null)
                return Results.Json(new AuthResponse(
                    Success: false, Username: null, AccessToken: null, Uuid: null,
                    UserType: "统一通行证", ErrorMessage: result.ErrorMessage
                ), ApiJsonContext.Default.AuthResponse);

            var tyStored = new StoredAccount
            {
                Name = result.Username ?? "",
                Uuid = result.Uuid,
                Token = result.AccessToken ?? "",
                AccessToken = result.AccessToken ?? "",
                RefreshToken = result.RefreshToken ?? "",
                LoginMethod = "统一通行证",
                ServerUrl = serverUrl,
            };
            await accountService.SaveAccountAsync(tyStored);
            return Results.Json(tyStored, ApiJsonContext.Default.StoredAccount);
        });

        group.MapPost("/validate", async (AuthRequest req) =>
        {
            if (string.IsNullOrEmpty(req.AccessToken))
                throw ApiException.BadRequest("accessToken is required", "MISSING_PARAMETER");
            var valid = await core.Auth.ValidateAsync(req.AccessToken);
            return Results.Json(new ValidateResponse(valid), ApiJsonContext.Default.ValidateResponse);
        });

        group.MapPost("/invalidate", async (AuthRequest req) =>
        {
            if (string.IsNullOrEmpty(req.AccessToken))
                throw ApiException.BadRequest("accessToken is required", "MISSING_PARAMETER");
            await core.Auth.InvalidateAsync(req.AccessToken);
            return Results.Json(new MessageResponse("Token invalidated"), ApiJsonContext.Default.MessageResponse);
        });
    }

    private static IResult ToResponse(Qomicex.Core.AOT.Interfaces.AuthResult result)
    {
        return Results.Json(new AuthResponse(
            Success: result.Success,
            Username: result.Username,
            AccessToken: result.AccessToken,
            Uuid: result.Uuid,
            UserType: result.UserType,
            ErrorMessage: result.ErrorMessage,
            RefreshToken: result.RefreshToken
        ), ApiJsonContext.Default.AuthResponse);
    }


}
