using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Services;
using MsAccount = Qomicex.Launcher.Backend.Modules.Helpers.Account.Microsoft;
using YggdrasilAccount = Qomicex.Launcher.Backend.Modules.Helpers.Account.Yggdrasil;
using TongyiAccount = Qomicex.Launcher.Backend.Modules.Helpers.Account.Tongyi;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class AccountController : ControllerBase
{
    private readonly MsAccount _msAccount;
    private readonly AccountService _accountService;

    public AccountController(MsAccount msAccount, AccountService accountService)
    {
        _msAccount = msAccount;
        _accountService = accountService;
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
        await _accountService.SaveAccountAsync(account);
        return Ok(account);
    }

    [HttpDelete("{uuid}")]
    public async Task<IActionResult> Delete(string uuid)
    {
        await _accountService.DeleteAccountAsync(uuid);
        return NoContent();
    }

    [HttpPost("microsoft/oauth")]
    public async Task<IActionResult> MicrosoftOAuth()
    {
        var oauthResponse = await _msAccount.OAuthLogin();
        return Ok(oauthResponse);
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
                Name = ygg.Name,
                Uuid = ygg.Uuid,
                Token = ygg.AccessToken,
                AccessToken = ygg.AccessToken,
                RefreshToken = ygg.ClientToken,
                LoginMethod = "Yggdrasil",
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
