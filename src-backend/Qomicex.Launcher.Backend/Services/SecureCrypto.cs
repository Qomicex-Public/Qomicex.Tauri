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
