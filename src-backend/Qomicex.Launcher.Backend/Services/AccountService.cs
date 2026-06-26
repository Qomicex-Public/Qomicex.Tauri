using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Qomicex.Launcher.Backend.Services;

public class AccountService
{
    private readonly string _filePath;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private List<StoredAccount>? _cache;

    public AccountService(string baseDir)
    {
        var dataDir = Path.Combine(baseDir, "data");
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
            LoginMethod = a.LoginMethod,
            LastUsed = a.LastUsed,
            HasToken = !string.IsNullOrEmpty(a.AccessToken)
        }).ToList();
    }

    public async Task<StoredAccount?> GetAccountAsync(string uuid)
    {
        var accounts = await LoadAsync();
        return accounts.FirstOrDefault(a => a.Uuid == uuid);
    }

    public async Task SaveAccountAsync(StoredAccount account)
    {
        await _lock.WaitAsync();
        try
        {
            var accounts = _cache ?? await ReadFileAsync();
            var idx = accounts.FindIndex(a => a.Uuid == account.Uuid);
            account.LastUsed = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            if (idx >= 0)
                accounts[idx] = account;
            else
                accounts.Add(account);
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
        if (!File.Exists(_filePath))
            return new();

        try
        {
            var encrypted = await File.ReadAllBytesAsync(_filePath);
            var plaintext = ProtectedData.Unprotect(encrypted, null, DataProtectionScope.CurrentUser);
            return JsonSerializer.Deserialize<List<StoredAccount>>(plaintext) ?? new();
        }
        catch
        {
            return new();
        }
    }

    private async Task WriteFileAsync(List<StoredAccount> accounts)
    {
        var plaintext = JsonSerializer.SerializeToUtf8Bytes(accounts);
        var encrypted = ProtectedData.Protect(plaintext, null, DataProtectionScope.CurrentUser);
        await File.WriteAllBytesAsync(_filePath, encrypted);
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
}

public class AccountInfo
{
    public string Name { get; set; } = string.Empty;
    public string Uuid { get; set; } = string.Empty;
    public string LoginMethod { get; set; } = string.Empty;
    public long LastUsed { get; set; }
    public bool HasToken { get; set; }
}
