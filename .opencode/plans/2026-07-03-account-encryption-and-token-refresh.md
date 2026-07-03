# 账户加密升级与 Microsoft Token 刷新实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 统一后端账户数据加密方案（升级非 Windows 平台的弱加密），并在启动流程中为 Microsoft 账户添加 token 自动刷新 + 过期提示。

**Architecture:** 
- 后端新增 `SecureCrypto` 类，使用 PBKDF2-SHA256 + AES-256-CBC + HMAC-SHA512，密码固定为 "QomicexLauncher"，输出格式与 Avalonia CryptHelper 的 `EncryptToBase64` 完全一致。
- `AccountService` 迁移到 `SecureCrypto`，非 Windows 平台旧数据在首次读取时自动用新格式重写（透明升级）。
- `InstanceController` 启动流程中为 Microsoft 账户添加 token 刷新逻辑，参照 Avalonia `Microsoft.RefreshUserInfo()` 的实现。
- 前端在启动失败收到 token 过期错误时弹窗引导重新登录 Microsoft OAuth。

**Tech Stack:** .NET 10 (ASP.NET Core), PBKDF2, AES-256-CBC, HMAC-SHA512

## 全局约束

- 目标框架: `net10.0`
- 加密参数: PBKDF2-SHA256, 100000 次迭代, AES-256-CBC, PKCS7 填充, HMAC-SHA512 (64 字节)
- 输出格式: `[salt(16)][iv(16)][hmac(64)][ciphertext]` → Base64
- 密码固定: "QomicexLauncher"（不绑定硬件，跨平台一致）
- Windows 平台保持 DPAPI 不变，只有非 Windows 平台升级到 SecureCrypto
- 错误码规范: 使用 `ApiException` 抛出，由 `ErrorHandlingMiddleware` 统一处理
- 所有本地路径使用 `Path.Combine`，不硬编码分隔符
- 使用 `CryptographicOperations.FixedTimeEquals` 做 HMAC 恒定时间比较

---

## Task 1: 创建 SecureCrypto 类

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Services/SecureCrypto.cs`

**Interfaces:**
- Produces: `SecureCrypto.Encrypt(string plaintext) → string base64`
- Produces: `SecureCrypto.Decrypt(string base64) → string plaintext`
- Throws: `CryptographicException` on HMAC mismatch

**实现代码：**

```csharp
using System.Security.Cryptography;
using System.Text;

namespace Qomicex.Launcher.Backend.Services;

/// <summary>
/// 统一加密工具 — 基于 PBKDF2 + AES-256-CBC + HMAC-SHA512。
/// 输出格式与 Avalonia CryptHelper.EncryptToBase64 完全一致，
/// 密码固定为 "QomicexLauncher"，不绑定硬件。
/// </summary>
public static class SecureCrypto
{
    private const int Pbkdf2Iterations = 100_000;
    private const int AesKeySize = 32;
    private const int HmacKeySize = 64;
    private const int SaltSize = 16;
    private const int IvSize = 16;
    private const int HeaderSize = SaltSize + IvSize + HmacKeySize; // 96
    private const string Password = "QomicexLauncher";

    public static string Encrypt(string plainText)
    {
        if (plainText == null) throw new ArgumentNullException(nameof(plainText));

        byte[] salt = RandomNumberGenerator.GetBytes(SaltSize);
        byte[] iv = new byte[IvSize];
        
        byte[] key = DeriveKey(Password, salt, AesKeySize);
        
        byte[] cipherText;
        using (var aes = Aes.Create())
        {
            aes.Key = key;
            aes.Mode = CipherMode.CBC;
            aes.Padding = PaddingMode.PKCS7;
            aes.GenerateIV();
            Array.Copy(aes.IV, iv, IvSize);
            
            using var encryptor = aes.CreateEncryptor();
            var plainBytes = Encoding.UTF8.GetBytes(plainText);
            cipherText = encryptor.TransformFinalBlock(plainBytes, 0, plainBytes.Length);
        }

        byte[] hmacKey = DeriveKey(Password, salt, HmacKeySize);
        byte[] hmac;
        using (var hmacSha512 = new HMACSHA512(hmacKey))
        {
            hmac = hmacSha512.ComputeHash(cipherText);
        }

        byte[] result = new byte[HeaderSize + cipherText.Length];
        Buffer.BlockCopy(salt, 0, result, 0, SaltSize);
        Buffer.BlockCopy(iv, 0, result, SaltSize, IvSize);
        Buffer.BlockCopy(hmac, 0, result, SaltSize + IvSize, HmacKeySize);
        Buffer.BlockCopy(cipherText, 0, result, HeaderSize, cipherText.Length);

        return Convert.ToBase64String(result);
    }

    public static string Decrypt(string base64CipherText)
    {
        if (base64CipherText == null) throw new ArgumentNullException(nameof(base64CipherText));
        
        byte[] data = Convert.FromBase64String(base64CipherText);
        if (data.Length < HeaderSize)
            throw new CryptographicException("Invalid encrypted data: too short.");

        byte[] salt = new byte[SaltSize];
        byte[] iv = new byte[IvSize];
        byte[] hmac = new byte[HmacKeySize];
        byte[] cipherText = new byte[data.Length - HeaderSize];

        Buffer.BlockCopy(data, 0, salt, 0, SaltSize);
        Buffer.BlockCopy(data, SaltSize, iv, 0, IvSize);
        Buffer.BlockCopy(data, SaltSize + IvSize, hmac, 0, HmacKeySize);
        Buffer.BlockCopy(data, HeaderSize, cipherText, 0, cipherText.Length);

        byte[] hmacKey = DeriveKey(Password, salt, HmacKeySize);
        byte[] computedHmac;
        using (var hmacSha512 = new HMACSHA512(hmacKey))
        {
            computedHmac = hmacSha512.ComputeHash(cipherText);
        }

        if (!CryptographicOperations.FixedTimeEquals(computedHmac, hmac))
            throw new CryptographicException("HMAC verification failed: data may be tampered.");

        byte[] key = DeriveKey(Password, salt, AesKeySize);
        using (var aes = Aes.Create())
        {
            aes.Key = key;
            aes.IV = iv;
            aes.Mode = CipherMode.CBC;
            aes.Padding = PaddingMode.PKCS7;

            using var decryptor = aes.CreateDecryptor();
            byte[] plainBytes = decryptor.TransformFinalBlock(cipherText, 0, cipherText.Length);
            return Encoding.UTF8.GetString(plainBytes);
        }
    }

    private static byte[] DeriveKey(string password, byte[] salt, int keySize)
    {
        return Rfc2898DeriveBytes.Pbkdf2(
            password: Encoding.UTF8.GetBytes(password),
            salt: salt,
            iterations: Pbkdf2Iterations,
            hashAlgorithm: HashAlgorithmName.SHA256,
            outputLength: keySize);
    }
}
```

---

## Task 2: 修改 AccountService 使用 SecureCrypto

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Services/AccountService.cs`

**改动内容：**

1. `ProtectData.Protect` 非 Windows 分支：改为调用 `SecureCrypto.Encrypt`
2. `ProtectData.Unprotect` 非 Windows 分支：先尝试 `SecureCrypto.Decrypt`，失败后回退到旧格式 `AesDecrypt`
3. 旧格式的 `AesEncrypt/AesDecrypt` 方法保留（向后兼容）

**具体修改 — ProtectData.Protect:**

```csharp
public static byte[] Protect(byte[] plaintext)
{
    if (OperatingSystem.IsWindows())
        return ProtectedData.Protect(plaintext, null, DataProtectionScope.CurrentUser);
    
    // 非 Windows: 使用 SecureCrypto 加密（新格式）
    var json = Encoding.UTF8.GetString(plaintext);
    var encrypted = SecureCrypto.Encrypt(json);
    return Encoding.UTF8.GetBytes(encrypted);
}
```

**具体修改 — ProtectData.Unprotect:**

```csharp
public static byte[] Unprotect(byte[] ciphertext)
{
    if (OperatingSystem.IsWindows())
        return ProtectedData.Unprotect(ciphertext, null, DataProtectionScope.CurrentUser);
    
    // 非 Windows: 先尝试新格式 (SecureCrypto)
    try
    {
        var base64 = Encoding.UTF8.GetString(ciphertext);
        var json = SecureCrypto.Decrypt(base64);
        return Encoding.UTF8.GetBytes(json);
    }
    catch (CryptographicException)
    {
        // HMAC 验证失败 → 旧格式数据
        return AesDecrypt(ciphertext);
    }
    catch (FormatException)
    {
        // 不是 Base64 → 旧格式数据
        return AesDecrypt(ciphertext);
    }
}
```

> **透明升级机制**: 首次读取旧格式数据时，`Unprotect` 会成功解密（走旧路径），但下次写入时 `Protect` 会用新格式加密。用户无感知。

---

## Task 3: 新增 Microsoft Token 刷新 API 端点

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Controllers/AccountController.cs`

**新增端点：**

```csharp
/// <summary>
/// 刷新 Microsoft 账户的 Minecraft Access Token。
/// 使用 stored Microsoft OAuth RefreshToken 重新走完整认证链。
/// </summary>
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
        // 调用 Qomicex.Core 的 Microsoft.RefreshUserInfo 走完整认证链
        var refreshedAccount = await _msAccount.RefreshUserInfo(account.RefreshToken);
        
        // 更新账户
        account.AccessToken = refreshedAccount.Token;
        account.RefreshToken = refreshedAccount.RefreshToken;
        account.Name = refreshedAccount.Name;
        account.Uuid = refreshedAccount.Uuid;
        
        await _accountService.SaveAccountAsync(account);
        
        return Ok(new { success = true });
    }
    catch (Exception ex) when (ex.Message.Contains("invalid_grant") || ex.Message.Contains("AADSTS70008"))
    {
        // Refresh token 已过期或失效，需要重新 OAuth 登录
        return Ok(new { success = false, needReauth = true, error = "TOKEN_EXPIRED" });
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Microsoft token refresh failed for account {Uuid}", account.Uuid);
        return BadRequest(ApiError.Create(400, "REFRESH_FAILED", $"Token 刷新失败: {ex.Message}", HttpContext.TraceIdentifier));
    }
}
```

**请求模型：**

```csharp
public class MicrosoftRefreshRequest
{
    public string AccountUuid { get; set; } = "";
}
```

---

## Task 4: InstanceController 中为 Microsoft 账户添加 token 刷新

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Controllers/InstanceController.cs` (around line 522)

**改动位置：** 在 Step 3 Account login 的 `else` 分支（line 522-525），即 Microsoft/Offline 账户的处理处。

**替换后的代码：**

```csharp
else if (defaultAccount.LoginMethod == "Microsoft")
{
    param.Account.LoginMethod = "Microsoft";
    // 尝试用 RefreshToken 刷新 Minecraft Access Token
    if (!string.IsNullOrEmpty(defaultAccount.RefreshToken))
    {
        try
        {
            var refreshed = await _msAccount.RefreshUserInfo(defaultAccount.RefreshToken);
            defaultAccount.AccessToken = refreshed.Token;
            defaultAccount.RefreshToken = refreshed.RefreshToken;
            defaultAccount.Name = refreshed.Name;
            defaultAccount.Uuid = refreshed.Uuid;
            await _accountService.SaveAccountAsync(defaultAccount);
            
            param.Account.AccessToken = defaultAccount.AccessToken;
            param.Account.Name = defaultAccount.Name;
            param.Account.Uuid = defaultAccount.Uuid;
        }
        catch (Exception ex) when (ex.Message.Contains("invalid_grant") || ex.Message.Contains("AADSTS70008"))
        {
            // Refresh token 已失效，需要重新 OAuth 登录
            // 继续使用旧的 AccessToken（可能会在 Minecraft 启动时失败）
            param.Account.AccessToken = string.IsNullOrEmpty(defaultAccount.AccessToken) 
                ? "faked-token-for-offline" 
                : defaultAccount.AccessToken;
        }
        catch
        {
            // 刷新失败，使用旧 token
            param.Account.AccessToken = string.IsNullOrEmpty(defaultAccount.AccessToken) 
                ? "faked-token-for-offline" 
                : defaultAccount.AccessToken;
        }
    }
    else
    {
        param.Account.AccessToken = string.IsNullOrEmpty(defaultAccount.AccessToken) 
            ? "faked-token-for-offline" 
            : defaultAccount.AccessToken;
    }
}
else
{
    // Offline 账户
    param.Account.AccessToken = string.IsNullOrEmpty(defaultAccount.AccessToken) ? "faked-token-for-offline" : defaultAccount.AccessToken;
}
```

---

## Task 5: 前端添加 TOKEN_EXPIRED 处理和重新登录引导

**Files:**
- Create: `src/components/MicrosoftReauthDialog.tsx`
- Modify: `src/pages/Dashboard.tsx`
- Modify: `src/pages/Instances.tsx`
- Modify: `src/pages/InstanceDetail.tsx`

**新建 `MicrosoftReauthDialog.tsx`:**

```tsx
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui/dialog.tsx'
import { Button } from '../components/ui/button.tsx'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMicrosoft, faRightToBracket } from '@fortawesome/free-brands-svg-icons'

interface Props {
  open: boolean
  onClose: () => void
  onReauth: () => void
}

export function MicrosoftReauthDialog({ open, onClose, onReauth }: Props) {
  return (
    <Dialog open={open} onClose={onClose} className="max-w-sm">
      <DialogHeader onClose={onClose}>
        <DialogTitle>Microsoft 账户凭证已过期</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm text-muted-foreground">
          你的 Microsoft 账户凭证已过期，需要重新登录才能启动游戏。
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>取消</Button>
        <Button onClick={onReauth} className="gap-1.5">
          <FontAwesomeIcon icon={faMicrosoft} className="h-4 w-4" />
          重新登录 Microsoft
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
```

**在各页面的 `handleLaunch` 中捕获 token 过期错误：**

以 `Dashboard.tsx` 为例，在 `handleLaunch` 的 catch 块中：

```tsx
const [showMicrosoftReauth, setShowMicrosoftReauth] = useState(false)

// 在 handleLaunch 的 catch 块中：
catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  // 检查是否是 token 过期
  if (msg.includes('TOKEN_EXPIRED') || msg.includes('invalid_grant') || msg.includes('AADSTS70008')) {
    setShowMicrosoftReauth(true)
    return
  }
  setLaunchError({ title: '启动失败', message: e instanceof Error ? e.message : String(e) })
  return
}
```

在 return JSX 末尾添加：

```tsx
<MicrosoftReauthDialog
  open={showMicrosoftReauth}
  onClose={() => setShowMicrosoftReauth(false)}
  onReauth={() => {
    setShowMicrosoftReauth(false)
    navigate('/accounts')
  }}
/>
```

---

## Task 6: 验证构建

**Files:**
- All modified backend files
- All modified frontend files

**命令：**

```bash
# 后端编译
cd src-backend/Qomicex.Launcher.Backend && dotnet build

# 前端类型检查
npx tsc --noEmit

# 前端构建
npx vite build
```

所有步骤应零错误通过。

---

## 实施顺序

1. Task 1: SecureCrypto 类（基础加密）
2. Task 2: AccountService 迁移（升级加密）
3. Task 3: Microsoft Token 刷新 API（后端 API）
4. Task 4: InstanceController token 刷新（启动流程集成）
5. Task 5: 前端 TOKEN_EXPIRED 处理 + 重新登录引导
6. Task 6: 验证构建

## 注意事项

- **Windows 用户不受影响**：Windows 平台继续使用 DPAPI，加密格式不变
- **非 Windows 旧数据**：首次启动时 `Unprotect` 会尝试新格式解密，失败后回退到旧格式。下次写入时用新格式（透明升级）
- **Token 刷新失败**：不会阻塞启动，会继续使用旧 token，如果 Minecraft 服务端拒绝则返回具体错误
- **RefreshToken 轮换**：Microsoft OAuth refresh token 可能会轮换，`RefreshUserInfo` 返回的新 refresh token 需要保存回去
- **后端缺少 RefreshUserInfo 方法**：`Qomicex.Core` 在 Tauri 后端中是空的（子模块），`RefreshUserInfo` 需要从 Avalonia 的 `Microsoft.cs` 移植到后端项目中
