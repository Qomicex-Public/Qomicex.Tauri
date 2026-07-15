using Qomicex.Core.AOT.Core;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class AuthEndpoints
{
    public static void MapAuthEndpoints(this WebApplication app, DefaultGameCore core)
    {
        var group = app.MapGroup("/api/auth");

        group.MapPost("/offline", async (Qomicex.Launcher.Backend.Neo.JsonContext.AuthRequest req) =>
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

        group.MapPost("/microsoft/poll", async (Qomicex.Launcher.Backend.Neo.JsonContext.AuthRequest req) =>
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

        group.MapPost("/microsoft/refresh", async (Qomicex.Launcher.Backend.Neo.JsonContext.AuthRequest req) =>
        {
            if (string.IsNullOrEmpty(req.AccessToken))
                throw ApiException.BadRequest("refreshToken is required", "MISSING_PARAMETER");
            var result = await core.Auth.RefreshLoginAsync(req.AccessToken);
            return ToResponse(result);
        });

        group.MapPost("/yggdrasil", async (Qomicex.Launcher.Backend.Neo.JsonContext.AuthRequest req) =>
        {
            var authReq = new Qomicex.Core.AOT.Interfaces.AuthRequest
            {
                Username = req.Username,
                Password = req.Password,
                ServerUrl = req.ServerUrl,
                IsOffline = false
            };
            var result = await core.Auth.AuthenticateAsync(authReq);
            return ToResponse(result);
        });

        group.MapPost("/validate", async (Qomicex.Launcher.Backend.Neo.JsonContext.AuthRequest req) =>
        {
            if (string.IsNullOrEmpty(req.AccessToken))
                throw ApiException.BadRequest("accessToken is required", "MISSING_PARAMETER");
            var valid = await core.Auth.ValidateAsync(req.AccessToken);
            return Results.Json(new ValidateResponse(valid), ApiJsonContext.Default.ValidateResponse);
        });

        group.MapPost("/invalidate", async (Qomicex.Launcher.Backend.Neo.JsonContext.AuthRequest req) =>
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
