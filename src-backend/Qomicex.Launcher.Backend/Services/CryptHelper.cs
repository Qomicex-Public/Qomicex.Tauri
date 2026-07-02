using System.Buffers.Binary;
using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Text;

namespace Qomicex.Launcher.Backend.Services;

/// <summary>
/// AES-256-GCM + HKDF 密钥分层 + 密钥承诺 + 硬件指纹加密库。
/// 输出格式: [version][salt(16)][nonce(12)][tag(16)][commitment(32)][plainLen(4)][ciphertext]
/// </summary>
public static class CryptHelper
{
    private const int Pbkdf2Iterations = 100_000;
    private const int KeySize = 32;
    private const int SaltSize = 16;
    private const int NonceSize = 12;
    private const int TagSize = 16;
    private const int CommitmentSize = 32;
    private const int LengthPrefixSize = 4;
    private const byte CurrentVersion = 0x01;

    private const int SaltOffset = 1;
    private const int NonceOffset = SaltOffset + SaltSize;
    private const int TagOffset = NonceOffset + NonceSize;
    private const int CommitmentOffset = TagOffset + TagSize;
    private const int LenOffset = CommitmentOffset + CommitmentSize;
    private const int CiphertextOffset = LenOffset + LengthPrefixSize;
    private const int HeaderSize = CiphertextOffset;

    private static string? _cachedMachineCode;

    // ──────────────────────────────────────────────
    //  公开 API
    // ──────────────────────────────────────────────

    public static string GetMachineCode()
    {
        if (!string.IsNullOrEmpty(_cachedMachineCode))
            return _cachedMachineCode;

        string cpuInfo = GetCpuInfo();
        string boardInfo = GetMotherboardSerial();
        string macAddress = GetMacAddress();

        string combinedInfo = $"{cpuInfo}-{boardInfo}-{macAddress}";

        byte[] hashBytes = SHA256.HashData(Encoding.UTF8.GetBytes(combinedInfo));
        _cachedMachineCode = Convert.ToHexString(hashBytes);
        return _cachedMachineCode;
    }

    public static string EncryptToBase64(string plainText, string? password = null)
        => Convert.ToBase64String(EncryptCore(Encoding.UTF8.GetBytes(plainText), password));

    public static string DecryptFromBase64(string cipherTextBase64, string? password = null)
        => Encoding.UTF8.GetString(DecryptCore(Convert.FromBase64String(cipherTextBase64), password));

    // ──────────────────────────────────────────────
    //  核心加密（AES-256-GCM）
    // ──────────────────────────────────────────────

    private static byte[] EncryptCore(byte[] plainBytes, string? password)
    {
        byte[] salt = RandomNumberGenerator.GetBytes(SaltSize);
        byte[] nonce = RandomNumberGenerator.GetBytes(NonceSize);

        byte[] ikm = DeriveIKM(password ?? GetMachineCode(), salt);
        (byte[] encKey, byte[] cmtKey) = DeriveKeys(ikm);

        byte[] aad = BuildAssociatedData(salt, nonce);
        byte[] commitment = HMACSHA256.HashData(cmtKey, aad);

        byte[] ciphertext = new byte[plainBytes.Length];
        byte[] tag = new byte[TagSize];

        using var aes = new AesGcm(encKey, TagSize);
        aes.Encrypt(nonce, plainBytes, ciphertext, tag, aad);

        byte[] result = new byte[HeaderSize + ciphertext.Length];
        result[0] = CurrentVersion;
        Buffer.BlockCopy(salt, 0, result, SaltOffset, SaltSize);
        Buffer.BlockCopy(nonce, 0, result, NonceOffset, NonceSize);
        Buffer.BlockCopy(tag, 0, result, TagOffset, TagSize);
        Buffer.BlockCopy(commitment, 0, result, CommitmentOffset, CommitmentSize);
        BinaryPrimitives.WriteUInt32LittleEndian(
            new Span<byte>(result, LenOffset, LengthPrefixSize), (uint)plainBytes.Length);
        Buffer.BlockCopy(ciphertext, 0, result, CiphertextOffset, ciphertext.Length);

        ZeroMemory(ikm, encKey, cmtKey);

        return result;
    }

    private static byte[] DecryptCore(byte[] data, string? password)
    {
        if (data.Length < HeaderSize)
            throw new ArgumentException("无效的加密数据。");

        byte version = data[0];
        return version switch
        {
            CurrentVersion => DecryptV1(data, password),
            _ => throw new NotSupportedException($"不支持的加密版本: {version}")
        };
    }

    private static byte[] DecryptV1(byte[] data, string? password)
    {
        byte[] salt = new byte[SaltSize];
        byte[] nonce = new byte[NonceSize];
        byte[] tag = new byte[TagSize];
        byte[] commitment = new byte[CommitmentSize];

        Buffer.BlockCopy(data, SaltOffset, salt, 0, SaltSize);
        Buffer.BlockCopy(data, NonceOffset, nonce, 0, NonceSize);
        Buffer.BlockCopy(data, TagOffset, tag, 0, TagSize);
        Buffer.BlockCopy(data, CommitmentOffset, commitment, 0, CommitmentSize);

        int plainLen = (int)BinaryPrimitives.ReadUInt32LittleEndian(
            new ReadOnlySpan<byte>(data, LenOffset, LengthPrefixSize));

        byte[] ciphertext = new byte[data.Length - CiphertextOffset];
        Buffer.BlockCopy(data, CiphertextOffset, ciphertext, 0, ciphertext.Length);

        if (ciphertext.Length != plainLen)
            throw new CryptographicException("数据完整性验证失败，数据可能已被篡改。");

        byte[] ikm = DeriveIKM(password ?? GetMachineCode(), salt);
        (byte[] encKey, byte[] cmtKey) = DeriveKeys(ikm);

        byte[] aad = BuildAssociatedData(salt, nonce);
        byte[] expectedCommitment = HMACSHA256.HashData(cmtKey, aad);
        if (!CryptographicOperations.FixedTimeEquals(commitment, expectedCommitment))
        {
            ZeroMemory(ikm, encKey, cmtKey, expectedCommitment);
            throw new CryptographicException("数据完整性验证失败，数据可能已被篡改或密码错误。");
        }

        byte[] plainBytes = new byte[plainLen];
        using var aes = new AesGcm(encKey, TagSize);
        try
        {
            aes.Decrypt(nonce, ciphertext, tag, plainBytes, aad);
        }
        catch (AuthenticationTagMismatchException)
        {
            ZeroMemory(ikm, encKey, cmtKey, plainBytes);
            throw new CryptographicException("数据完整性验证失败，数据可能已被篡改。");
        }

        ZeroMemory(ikm, encKey, cmtKey);

        return plainBytes;
    }

    private static byte[] DeriveIKM(string machineCode, byte[] salt)
    {
        return Rfc2898DeriveBytes.Pbkdf2(
            password: Encoding.UTF8.GetBytes(machineCode),
            salt: salt,
            iterations: Pbkdf2Iterations,
            hashAlgorithm: HashAlgorithmName.SHA256,
            outputLength: KeySize);
    }

    private static (byte[] encKey, byte[] cmtKey) DeriveKeys(byte[] ikm)
    {
        byte[] encKey = HKDF.Expand(HashAlgorithmName.SHA256, ikm, KeySize, Encoding.UTF8.GetBytes("enc-v1"));
        byte[] cmtKey = HKDF.Expand(HashAlgorithmName.SHA256, ikm, KeySize, Encoding.UTF8.GetBytes("cmt-v1"));
        return (encKey, cmtKey);
    }

    private static byte[] BuildAssociatedData(byte[] salt, byte[] nonce)
    {
        byte[] aad = new byte[1 + SaltSize + NonceSize];
        aad[0] = CurrentVersion;
        Buffer.BlockCopy(salt, 0, aad, 1, SaltSize);
        Buffer.BlockCopy(nonce, 0, aad, 1 + SaltSize, NonceSize);
        return aad;
    }

    // ──────────────────────────────────────────────
    //  硬件信息采集
    // ──────────────────────────────────────────────

    private static string GetCpuInfo()
    {
        if (OperatingSystem.IsWindows())
        {
            try
            {
                using var searcher = new System.Management.ManagementObjectSearcher(
                    "select ProcessorId from Win32_Processor");
                foreach (var item in searcher.Get())
                    return item["ProcessorId"]?.ToString() ?? "UnknownCPU";
            }
            catch { return "UnknownCPU"; }
            return "UnknownCPU";
        }

        try
        {
            if (File.Exists("/proc/cpuinfo"))
            {
                string content = File.ReadAllText("/proc/cpuinfo");
                var lines = content.Split('\n');

                var serial = lines.FirstOrDefault(l =>
                    l.StartsWith("Serial", StringComparison.OrdinalIgnoreCase));
                if (serial != null)
                {
                    var parts = serial.Split(':');
                    if (parts.Length > 1) return parts[1].Trim();
                }

                var model = lines.FirstOrDefault(l =>
                    l.StartsWith("model name", StringComparison.OrdinalIgnoreCase));
                var cores = lines.FirstOrDefault(l =>
                    l.StartsWith("cpu cores", StringComparison.OrdinalIgnoreCase));

                if (model != null && cores != null)
                {
                    string m = model.Split(':').Last().Trim();
                    string c = cores.Split(':').Last().Trim();
                    return $"cpu:{m}:cores={c}";
                }

                var proc = lines.FirstOrDefault(l =>
                    l.StartsWith("Processor", StringComparison.OrdinalIgnoreCase));
                if (proc != null)
                {
                    var parts = proc.Split(':');
                    if (parts.Length > 1) return parts[1].Trim();
                }
            }

            if (File.Exists("/etc/machine-id"))
                return "cpu-" + File.ReadAllText("/etc/machine-id").Trim();

            if (File.Exists("/var/lib/dbus/machine-id"))
                return "cpu-" + File.ReadAllText("/var/lib/dbus/machine-id").Trim();

            return "UnknownCPU";
        }
        catch { return "UnknownCPU"; }
    }

    private static string GetMotherboardSerial()
    {
        if (OperatingSystem.IsWindows())
        {
            try
            {
                using var searcher = new System.Management.ManagementObjectSearcher(
                    "SELECT SerialNumber FROM Win32_BaseBoard");
                foreach (var item in searcher.Get())
                    return item["SerialNumber"]?.ToString() ?? "UnknownBoard";
            }
            catch { return "UnknownBoard"; }
            return "UnknownBoard";
        }

        try
        {
            if (File.Exists("/sys/class/dmi/id/board_serial"))
            {
                string serial = File.ReadAllText("/sys/class/dmi/id/board_serial").Trim();
                if (!string.IsNullOrEmpty(serial) && serial != "Not Available" && serial != "None")
                    return serial;
            }

            if (File.Exists("/sys/class/dmi/id/product_uuid"))
            {
                string uuid = File.ReadAllText("/sys/class/dmi/id/product_uuid").Trim();
                if (!string.IsNullOrEmpty(uuid))
                    return uuid;
            }

            if (File.Exists("/etc/machine-id"))
                return "board-" + File.ReadAllText("/etc/machine-id").Trim();

            if (File.Exists("/var/lib/dbus/machine-id"))
                return "board-" + File.ReadAllText("/var/lib/dbus/machine-id").Trim();

            return "UnknownBoard";
        }
        catch { return "UnknownBoard"; }
    }

    private static string GetMacAddress()
    {
        try
        {
            var nic = NetworkInterface.GetAllNetworkInterfaces()
                .FirstOrDefault(n => n.OperationalStatus == OperationalStatus.Up
                                  && n.NetworkInterfaceType != NetworkInterfaceType.Loopback);
            return nic?.GetPhysicalAddress().ToString() ?? "UnknownMAC";
        }
        catch { return "UnknownMAC"; }
    }

    private static void ZeroMemory(params byte[][] arrays)
    {
        foreach (var arr in arrays)
            CryptographicOperations.ZeroMemory(arr);
    }
}
