using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class LicenseEndpoints
{
    public static void MapLicenseEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/license");

        group.MapGet("/status", async (IHttpClientFactory httpFactory) =>
        {
            var machineCode = CryptHelper.GetMachineCode();
            try
            {
                if (!LicenseValidator.LicenseFileExists())
                    return Results.Json(new LicenseStatusResponse(false, MachineCode: machineCode, Error: "LICENSE_NOT_FOUND"), ApiJsonContext.Default.LicenseStatusResponse);

                var metadata = await LicenseValidator.ValidateAsync(httpFactory);
                return Results.Json(new LicenseStatusResponse(true, MachineCode: machineCode, LicenseId: metadata.LicenseId, Channel: metadata.Channel, ExpireAt: metadata.ExpireAt, IsPermanent: metadata.IsPermanent), ApiJsonContext.Default.LicenseStatusResponse);
            }
            catch (ApiException ex)
            {
                return Results.Json(new LicenseStatusResponse(false, MachineCode: machineCode, Error: ex.ErrorCode), ApiJsonContext.Default.LicenseStatusResponse);
            }
        });

        group.MapPost("/activate", async (LicenseActivateRequest req, IHttpClientFactory httpFactory) =>
        {
            if (string.IsNullOrWhiteSpace(req.LicenseToken))
                throw ApiException.BadRequest("许可证 Token 不能为空", "LICENSE_TOKEN_EMPTY");

            var metadata = await LicenseValidator.ActivateAsync(req.LicenseToken, httpFactory);
            LicenseValidator.SaveLicenseToken(req.LicenseToken);

            return Results.Json(new LicenseActivateResponse(true, LicenseId: metadata.LicenseId, Channel: metadata.Channel, ExpireAt: metadata.ExpireAt, IsPermanent: metadata.IsPermanent), ApiJsonContext.Default.LicenseActivateResponse);
        });
    }
}
