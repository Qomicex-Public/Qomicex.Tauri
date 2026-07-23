using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Services;

public class AccountService
{
    private readonly string _filePath;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private List<StoredAccount>? _cache;
    private bool _accountsWereLost;

    public AccountService()
    {
        var dataDir = Path.Combine(Common.AppPaths.BaseDir, "data");
        Directory.CreateDirectory(dataDir);
        _filePath = Path.Combine(dataDir, "accounts.dat");
    }

    public async Task<List<AccountInfo>> GetAccountsAsync()
    {
        var accounts = await LoadAsync();
        return accounts.Select(a => new AccountInfo
        {
            Name = a.Name,
            Uuid = a.Uuid,
            Token = a.Token,
            AccessToken = a.AccessToken,
            RefreshToken = a.RefreshToken,
            LoginMethod = a.LoginMethod,
            LastUsed = a.LastUsed,
            HasToken = !string.IsNullOrEmpty(a.AccessToken),
            IsDefault = a.IsDefault,
            ServerUrl = a.ServerUrl,
        }).ToList();
    }

    public bool CheckAccountsLost()
    {
        var v = _accountsWereLost;
        _accountsWereLost = false;
        return v;
    }

    public async Task<StoredAccount?> GetAccountAsync(string uuid)
    {
        var accounts = await LoadAsync();
        return accounts.FirstOrDefault(a => a.Uuid == uuid);
    }

    public async Task<StoredAccount?> GetDefaultAsync()
    {
        var accounts = await LoadAsync();
        return accounts.FirstOrDefault(a => a.IsDefault);
    }

    public async Task SetDefaultAsync(string uuid)
    {
        await _lock.WaitAsync();
        try
        {
            var accounts = _cache ?? await ReadFileAsync();
            var account = accounts.FirstOrDefault(a => a.Uuid == uuid);
            if (account == null) return;
            foreach (var a in accounts)
                a.IsDefault = a.Uuid == uuid;
            _cache = accounts;
            await WriteFileAsync(accounts);
        }
        finally { _lock.Release(); }
    }

    public async Task ClearDefaultAsync()
    {
        await _lock.WaitAsync();
        try
        {
            var accounts = _cache ?? await ReadFileAsync();
            foreach (var a in accounts)
                a.IsDefault = false;
            _cache = accounts;
            await WriteFileAsync(accounts);
        }
        finally { _lock.Release(); }
    }

    public async Task AutoSetDefaultOnSaveAsync(StoredAccount account)
    {
        await _lock.WaitAsync();
        try
        {
            var accounts = _cache ?? await ReadFileAsync();
            var isNew = !accounts.Any(a => a.Uuid == account.Uuid);
            account.LastUsed = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            if (isNew)
            {
                account.IsDefault = !accounts.Any(a => a.IsDefault);
                accounts.Add(account);
            }
            else
            {
                var idx = accounts.FindIndex(a => a.Uuid == account.Uuid);
                if (idx >= 0) accounts[idx] = account;
            }
            _cache = accounts;
            await WriteFileAsync(accounts);
        }
        finally { _lock.Release(); }
    }

    public async Task AutoReassignDefaultOnDeleteAsync(string deletedUuid)
    {
        await _lock.WaitAsync();
        try
        {
            var accounts = _cache ?? await ReadFileAsync();
            accounts.RemoveAll(a => a.Uuid == deletedUuid);
            if (!accounts.Any(a => a.IsDefault) && accounts.Count > 0)
                accounts[0].IsDefault = true;
            _cache = accounts;
            await WriteFileAsync(accounts);
        }
        finally { _lock.Release(); }
    }

    public async Task SaveAccountAsync(StoredAccount account)
    {
        await _lock.WaitAsync();
        try
        {
            var accounts = _cache ?? await ReadFileAsync();
            var idx = accounts.FindIndex(a => a.Uuid == account.Uuid);
            account.LastUsed = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            if (idx >= 0) accounts[idx] = account;
            else accounts.Add(account);
            _cache = accounts;
            await WriteFileAsync(accounts);
        }
        finally { _lock.Release(); }
    }

    public async Task DeleteAccountAsync(string uuid)
    {
        await _lock.WaitAsync();
        try
        {
            var accounts = _cache ?? await ReadFileAsync();
            accounts.RemoveAll(a => a.Uuid == uuid);
            _cache = accounts;
            await WriteFileAsync(accounts);
        }
        finally { _lock.Release(); }
    }

    private async Task<List<StoredAccount>> LoadAsync()
    {
        if (_cache != null) return _cache;
        await _lock.WaitAsync();
        try
        {
            _cache ??= await ReadFileAsync();
            return _cache;
        }
        finally { _lock.Release(); }
    }

    private async Task<List<StoredAccount>> ReadFileAsync()
    {
        if (!File.Exists(_filePath)) return new();
        try
        {
            var encrypted = await File.ReadAllBytesAsync(_filePath);
            var base64 = Encoding.UTF8.GetString(encrypted);
            var json = CryptHelper.DecryptFromBase64(base64);
            return JsonSerializer.Deserialize(json, ApiJsonContext.Default.ListStoredAccount) ?? new();
        }
        catch (CryptographicException)
        {
            _accountsWereLost = true;
            Trace.WriteLine("[AccountService] accounts.dat decryption failed, deleting and reinitializing.");
            try { File.Delete(_filePath); } catch { }
            return new();
        }
        catch { return new(); }
    }

    private async Task WriteFileAsync(List<StoredAccount> accounts)
    {
        var json = JsonSerializer.Serialize(accounts, ApiJsonContext.Default.ListStoredAccount);
        var encryptedBase64 = CryptHelper.EncryptToBase64(json);
        await File.WriteAllBytesAsync(_filePath, Encoding.UTF8.GetBytes(encryptedBase64));
    }
}

public class StoredAccount
{
    public string Name { get; set; } = string.Empty;
    public string Uuid { get; set; } = string.Empty;
    public string Token { get; set; } = string.Empty;
    public string AccessToken { get; set; } = string.Empty;
    public string RefreshToken { get; set; } = string.Empty;
    public string LoginMethod { get; set; } = string.Empty;
    public long LastUsed { get; set; }
    public bool IsDefault { get; set; }
    public string? ServerUrl { get; set; }
}

public class AccountInfo
{
    public string Name { get; set; } = string.Empty;
    public string Uuid { get; set; } = string.Empty;
    public string Token { get; set; } = string.Empty;
    public string AccessToken { get; set; } = string.Empty;
    public string RefreshToken { get; set; } = string.Empty;
    public string LoginMethod { get; set; } = string.Empty;
    public long LastUsed { get; set; }
    public bool HasToken { get; set; }
    public bool IsDefault { get; set; }
    public string? ServerUrl { get; set; }
}
