using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Qomicex.Launcher.Backend.Common;
using Qomicex.Launcher.Backend.Services;
using MsAccount = Qomicex.Core.Modules.Helpers.Account.Microsoft;
using YggdrasilAccount = Qomicex.Core.Modules.Helpers.Account.Yggdrasil;
using TongyiAccount = Qomicex.Core.Modules.Helpers.Account.Tongyi;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class AccountController : ControllerBase
{
    private readonly MsAccount _msAccount;
    private readonly AccountService _accountService;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<AccountController> _logger;

    public AccountController(MsAccount msAccount, AccountService accountService, IHttpClientFactory httpFactory, ILogger<AccountController> logger)
    {
        _msAccount = msAccount;
        _accountService = accountService;
        _httpFactory = httpFactory;
        _logger = logger;
    }

    [HttpGet]
    public async Task<IActionResult> List()
    {
        var accounts = await _accountService.GetAccountsAsync();
        return Ok(accounts);
    }

    [HttpGet("{uuid}")]
    public async Task<IActionResult> Get(string uuid)
    {
        var account = await _accountService.GetAccountAsync(uuid);
        if (account == null) return NotFound();
        return Ok(account);
    }

    [HttpPost]
    public async Task<IActionResult> Save([FromBody] StoredAccount account)
    {
        await _accountService.AutoSetDefaultOnSaveAsync(account);
        return Ok(account);
    }

    [HttpDelete("{uuid}")]
    public async Task<IActionResult> Delete(string uuid)
    {
        var account = await _accountService.GetAccountAsync(uuid);
        if (account != null && account.IsDefault)
        {
            await _accountService.AutoReassignDefaultOnDeleteAsync(uuid);
        }
        else
        {
            await _accountService.DeleteAccountAsync(uuid);
        }
        return NoContent();
    }

    [HttpGet("default")]
    public async Task<IActionResult> GetDefault()
    {
        var account = await _accountService.GetDefaultAsync();
        if (account == null) return NotFound();
        return Ok(account);
    }

    [HttpPut("{uuid}/default")]
    public async Task<IActionResult> SetDefault(string uuid)
    {
        var account = await _accountService.GetAccountAsync(uuid);
        if (account == null) return NotFound();
        await _accountService.SetDefaultAsync(uuid);
        return Ok(account);
    }

    [HttpDelete("default")]
    public async Task<IActionResult> ClearDefault()
    {
        await _accountService.ClearDefaultAsync();
        return NoContent();
    }

    [HttpGet("offline-uuid")]
    public IActionResult GetOfflineUuid([FromQuery] string name)
    {
        if (string.IsNullOrWhiteSpace(name))
            return BadRequest(new { error = "name is required" });
        var hash = MD5.HashData(Encoding.UTF8.GetBytes("OfflinePlayer:" + name));
        hash[6] = (byte)((hash[6] & 0x0f) | 0x40);
        hash[8] = (byte)((hash[8] & 0x3f) | 0x80);
        var uuid = new Guid(hash).ToString("D");
        return Ok(new { uuid });
    }

    [HttpGet("yggdrasil-meta")]
    public async Task<IActionResult> GetYggdrasilMeta([FromQuery] string serverUrl)
    {
        if (string.IsNullOrWhiteSpace(serverUrl)) return BadRequest();
        try
        {
            var http = _httpFactory.CreateClient();
            var resp = await http.GetStringAsync(serverUrl);
            var json = System.Text.Json.JsonDocument.Parse(resp);
            var name = json.RootElement.GetProperty("meta").GetProperty("serverName").GetString();
            return Ok(new { serverName = name ?? "" });
        }
        catch { return Ok(new { serverName = "" }); }
    }

    [HttpPost("microsoft/oauth")]
    public async Task<IActionResult> MicrosoftOAuth()
    {
        var oauthResponse = await _msAccount.OAuthLogin();
        return Ok(new
        {
            deviceCode = oauthResponse.DeviceCode,
            userCode = oauthResponse.UserCode,
            verificationUri = oauthResponse.VerificationUri,
            expiresIn = oauthResponse.ExpiresIn,
            interval = oauthResponse.Interval,
        });
    }

    [HttpPost("microsoft/poll")]
    public async Task<IActionResult> MicrosoftPoll([FromBody] MicrosoftPollRequest request)
    {
        var oauthResponse = new MsAccount.OAuthResponse
        {
            DeviceCode = request.DeviceCode,
            UserCode = request.UserCode,
            VerificationUri = request.VerificationUri,
            ExpiresIn = request.ExpiresIn,
            Interval = request.Interval
        };
        var state = await _msAccount.GetUserAuthorizationState(oauthResponse);
        return Ok(state);
    }

    [HttpPost("microsoft/info")]
    public async Task<IActionResult> MicrosoftUserInfo([FromBody] MicrosoftUserInfoRequest request)
    {
        Exception? lastEx = null;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                var account = await _msAccount.GetUserInfo(request.AccessToken, request.RefreshToken);
                var stored = new StoredAccount
                {
                    Name = account.Name,
                    Uuid = account.Uuid,
                    Token = account.Token,
                    AccessToken = account.AccessToken,
                    RefreshToken = account.RefreshToken,
                    LoginMethod = "Microsoft",
                };
                await _accountService.SaveAccountAsync(stored);
                return Ok(stored);
            }
            catch (Exception ex)
            {
                lastEx = ex;
                if (attempt < 2) await Task.Delay(3000 * (attempt + 1));
            }
        }
        throw lastEx!;
    }

    [HttpPost("yggdrasil/login")]
    public async Task<IActionResult> YggdrasilLogin([FromBody] YggdrasilLoginRequest request)
    {
        var auth = new YggdrasilAccount(request.ServerUrl, request.Email, request.Password);
        var accounts = await auth.AuthenticateAsync();

        var saved = new List<StoredAccount>();
        foreach (var ygg in accounts)
        {
            var stored = new StoredAccount
            {
                Name = ygg.Name ?? "",
                Uuid = ygg.Uuid ?? "",
                Token = ygg.AccessToken ?? "",
                AccessToken = ygg.AccessToken ?? "",
                RefreshToken = ygg.ClientToken ?? "",
                LoginMethod = "Yggdrasil",
                ServerUrl = request.ServerUrl,
            };
            await _accountService.SaveAccountAsync(stored);
            saved.Add(stored);
        }
        return Ok(saved);
    }

    [HttpPost("tongyi/login")]
    public async Task<IActionResult> TongyiLogin([FromBody] TongyiLoginRequest request)
    {
        var auth = new TongyiAccount(request.ServerId, request.Email, request.Password);
        var accounts = await auth.AuthenticateAsync();

        var saved = new List<StoredAccount>();
        foreach (var ty in accounts)
        {
            var stored = new StoredAccount
            {
                Name = ty.Name ?? "Unknown",
                Uuid = ty.Uuid ?? Guid.NewGuid().ToString("N"),
                Token = ty.AccessToken ?? "",
                AccessToken = ty.AccessToken ?? "",
                RefreshToken = ty.ClientToken ?? "",
                LoginMethod = "统一通行证",
            };
            await _accountService.SaveAccountAsync(stored);
            saved.Add(stored);
        }
        return Ok(saved);
    }

    [HttpPost("microsoft/refresh")]
    public async Task<IActionResult> RefreshMicrosoftToken([FromBody] MicrosoftRefreshRequest request)
    {
        var account = await _accountService.GetAccountAsync(request.AccountUuid);
        if (account == null)
            return NotFound(ApiError.Create(404, "ACCOUNT_NOT_FOUND", "账户不存在", HttpContext.TraceIdentifier));
        
        if (account.LoginMethod != "Microsoft")
            return BadRequest(ApiError.Create(400, "INVALID_ACCOUNT_TYPE", "该账户不是 Microsoft 类型", HttpContext.TraceIdentifier));
        
        if (string.IsNullOrEmpty(account.RefreshToken))
            return BadRequest(ApiError.Create(400, "MISSING_REFRESH_TOKEN", "账户缺少 RefreshToken", HttpContext.TraceIdentifier));

        try
        {
            var refreshedAccount = await _msAccount.RefreshUserInfo(account.RefreshToken);
            
            account.AccessToken = refreshedAccount.Token;
            account.RefreshToken = refreshedAccount.RefreshToken;
            account.Name = refreshedAccount.Name;
            account.Uuid = refreshedAccount.Uuid;
            
            await _accountService.SaveAccountAsync(account);
            
            return Ok(new { success = true });
        }
        catch (Exception ex) when (ex.Message.Contains("invalid_grant") || ex.Message.Contains("AADSTS70008"))
        {
            return Ok(new { success = false, needReauth = true, error = "TOKEN_EXPIRED" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Microsoft token refresh failed for account {Uuid}", account.Uuid);
            return BadRequest(ApiError.Create(400, "REFRESH_FAILED", $"Token 刷新失败: {ex.Message}", HttpContext.TraceIdentifier));
        }
    }
}

public class TongyiLoginRequest
{
    public string ServerId { get; set; } = "";
    public string Email { get; set; } = "";
    public string Password { get; set; } = "";
}

public class MicrosoftPollRequest
{
    public string DeviceCode { get; set; } = "";
    public string UserCode { get; set; } = "";
    public string VerificationUri { get; set; } = "";
    public int ExpiresIn { get; set; }
    public int Interval { get; set; }
}

public class MicrosoftUserInfoRequest
{
    public string AccessToken { get; set; } = "";
    public string RefreshToken { get; set; } = "";
}

public class YggdrasilLoginRequest
{
    public string Email { get; set; } = "";
    public string Password { get; set; } = "";
    public string ServerUrl { get; set; } = "https://authserver.mojang.com";
}

public class MicrosoftRefreshRequest
{
    public string AccountUuid { get; set; } = "";
}
