using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Qomicex.Launcher.Backend.Services;

public class AccountService
{
    private readonly string _filePath;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private List<StoredAccount>? _cache;
    private bool _accountsWereLost;
    private static readonly byte[] _entropy = [0x51, 0x6F, 0x6D, 0x69, 0x63, 0x65, 0x78, 0x4C, 0x61, 0x75, 0x6E, 0x63, 0x68, 0x65, 0x72];

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

    public async Task EnsureDefaultAsync()
    {
        await _lock.WaitAsync();
        try
        {
            var accounts = _cache ?? await ReadFileAsync();
            var hasDefault = accounts.Any(a => a.IsDefault);
            if (!hasDefault && accounts.Count > 0)
            {
                accounts[0].IsDefault = true;
                _cache = accounts;
                await WriteFileAsync(accounts);
            }
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
            var hasDefault = accounts.Any(a => a.IsDefault);
            account.LastUsed = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            if (isNew)
            {
                account.IsDefault = true;
                accounts.Add(account);
            }
            else
            {
                var idx = accounts.FindIndex(a => a.Uuid == account.Uuid);
                if (idx >= 0)
                {
                    accounts[idx] = account;
                }
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
            var stillHasDefault = accounts.Any(a => a.IsDefault);
            if (!stillHasDefault && accounts.Count > 0)
            {
                accounts[0].IsDefault = true;
            }
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
        if (!File.Exists(_filePath)) return new();
        try
        {
            var encrypted = await File.ReadAllBytesAsync(_filePath);
            var plaintext = ProtectData.Unprotect(encrypted);
            return JsonSerializer.Deserialize<List<StoredAccount>>(plaintext) ?? new();
        }
        catch (CryptographicException)
        {
            _accountsWereLost = true;
            Trace.WriteLine("[AccountService] accounts.dat 解密失败（机器码不匹配或数据被篡改），已删除文件，账户数据将重新初始化。");
            try { File.Delete(_filePath); } catch { }
            return new();
        }
        catch { return new(); }
    }

    private async Task WriteFileAsync(List<StoredAccount> accounts)
    {
        var plaintext = JsonSerializer.SerializeToUtf8Bytes(accounts);
        var encrypted = ProtectData.Protect(plaintext);
        await File.WriteAllBytesAsync(_filePath, encrypted);
    }
}

internal static class ProtectData
{
    public static byte[] Protect(byte[] plaintext)
    {
        var json = Encoding.UTF8.GetString(plaintext);
        var encrypted = CryptHelper.EncryptToBase64(json);
        return Encoding.UTF8.GetBytes(encrypted);
    }

    public static byte[] Unprotect(byte[] ciphertext)
    {
        var base64 = Encoding.UTF8.GetString(ciphertext);
        var json = CryptHelper.DecryptFromBase64(base64);
        return Encoding.UTF8.GetBytes(json);
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
    public string LoginMethod { get; set; } = string.Empty;
    public long LastUsed { get; set; }
    public bool HasToken { get; set; }
    public bool IsDefault { get; set; }
    public string? ServerUrl { get; set; }
}
