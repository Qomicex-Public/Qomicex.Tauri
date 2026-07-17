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
            var result = await core.Auth.StartDeviceCodeAsync();
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
            var result = await core.Auth.PollForTokenAsync(req.AccessToken);
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

        group.MapPost("/microsoft/info", async (MicrosoftInfoRequest req) =>
        {
            Exception? lastEx = null;
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    var authResult = await core.Auth.CompleteLoginAsync(req.AccessToken, req.RefreshToken);
                    var stored = new StoredAccount
                    {
                        Name = authResult.Username ?? "",
                        Uuid = authResult.Uuid ?? "",
                        AccessToken = authResult.AccessToken ?? "",
                        RefreshToken = authResult.RefreshToken ?? "",
                        LoginMethod = "Microsoft",
                    };
                    await accountService.SaveAccountAsync(stored);
                    return Results.Json(new AuthResponse(
                        Success: true,
                        Username: stored.Name,
                        AccessToken: stored.AccessToken,
                        Uuid: stored.Uuid,
                        RefreshToken: stored.RefreshToken,
                        UserType: "microsoft",
                        ErrorMessage: null
                    ), ApiJsonContext.Default.AuthResponse);
                }
                catch (Exception ex)
                {
                    lastEx = ex;
                    if (attempt < 2) await Task.Delay(3000 * (attempt + 1));
                }
            }
            throw lastEx!;
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
                    return Results.Json(new { success = false, needReauth = true, error = "TOKEN_EXPIRED" });
                account.AccessToken = result.AccessToken ?? "";
                account.RefreshToken = result.RefreshToken ?? "";
                account.Name = result.Username ?? account.Name;
                account.Uuid = result.Uuid ?? account.Uuid;
                await accountService.SaveAccountAsync(account);
                return Results.Json(new { success = true });
            }
            catch (Exception ex) when (ex.Message.Contains("invalid_grant") || ex.Message.Contains("AADSTS70008"))
            {
                return Results.Json(new { success = false, needReauth = true, error = "TOKEN_EXPIRED" });
            }
        });

        group.MapPost("/yggdrasil", async (AuthRequest req) =>
        {
            var authReq = new Qomicex.Core.AOT.Interfaces.AuthRequest
            {
                Username = req.Username,
                Password = req.Password,
                ServerUrl = req.ServerUrl,
                IsOffline = false
            };
            var result = await core.Auth.AuthenticateAsync(authReq);
            return ToAndSaveResponse(result, "Yggdrasil", req.ServerUrl, accountService);
        });

        group.MapPost("/tongyi", async (TongyiLoginRequest req) =>
        {
            var serverUrl = $"https://auth.mc-user.com:233/{req.ServerId}/";
            var authReq = new Qomicex.Core.AOT.Interfaces.AuthRequest
            {
                Username = req.Email,
                Password = req.Password,
                ServerUrl = serverUrl,
                IsOffline = false
            };
            var result = await core.Auth.AuthenticateAsync(authReq);
            return ToAndSaveResponse(result, "统一通行证", serverUrl, accountService);
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

    private static async Task<IResult> ToAndSaveResponse(
        Qomicex.Core.AOT.Interfaces.AuthResult result, string loginMethod, string? serverUrl, AccountService accountService)
    {
        if (!result.Success || result.Uuid == null)
            return Results.Json(new AuthResponse(
                Success: false, Username: null, AccessToken: null, Uuid: null,
                UserType: loginMethod, ErrorMessage: result.ErrorMessage
            ), ApiJsonContext.Default.AuthResponse);

        var stored = new StoredAccount
        {
            Name = result.Username ?? "",
            Uuid = result.Uuid,
            AccessToken = result.AccessToken ?? "",
            RefreshToken = result.RefreshToken ?? "",
            LoginMethod = loginMethod,
            ServerUrl = serverUrl,
        };
        await accountService.SaveAccountAsync(stored);
        return Results.Json(new AuthResponse(
            Success: true,
            Username: stored.Name,
            AccessToken: stored.AccessToken,
            Uuid: stored.Uuid,
            RefreshToken: stored.RefreshToken,
            UserType: loginMethod,
            ErrorMessage: null
        ), ApiJsonContext.Default.AuthResponse);
    }
}
