using System.Buffers.Binary;
using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace Qomicex.Launcher.Backend.Neo.Services;

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

    public static string GetMachineCode()
    {
        if (!string.IsNullOrEmpty(_cachedMachineCode))
            return _cachedMachineCode;

        var cpuInfo = GetCpuIdentifier();
        var boardInfo = GetBoardIdentifier();
        var macAddress = GetMacAddress();
        var combined = $"{cpuInfo}-{boardInfo}-{macAddress}";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(combined));
        _cachedMachineCode = Convert.ToHexString(hash);
        return _cachedMachineCode;
    }

    public static string EncryptToBase64(string plainText, string? password = null)
        => Convert.ToBase64String(EncryptCore(Encoding.UTF8.GetBytes(plainText), password));

    public static string DecryptFromBase64(string cipherTextBase64, string? password = null)
        => Encoding.UTF8.GetString(DecryptCore(Convert.FromBase64String(cipherTextBase64), password));

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
            throw new ArgumentException("Invalid encrypted data.");
        return data[0] switch
        {
            CurrentVersion => DecryptV1(data, password),
            _ => throw new NotSupportedException($"Unsupported encryption version: {data[0]}"),
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
            throw new CryptographicException("Data integrity check failed.");

        byte[] ikm = DeriveIKM(password ?? GetMachineCode(), salt);
        (byte[] encKey, byte[] cmtKey) = DeriveKeys(ikm);

        byte[] aad = BuildAssociatedData(salt, nonce);
        byte[] expectedCommitment = HMACSHA256.HashData(cmtKey, aad);
        if (!CryptographicOperations.FixedTimeEquals(commitment, expectedCommitment))
        {
            ZeroMemory(ikm, encKey, cmtKey, expectedCommitment);
            throw new CryptographicException("Data integrity check failed.");
        }

        byte[] plainBytes = new byte[plainLen];
        using var aes = new AesGcm(encKey, TagSize);
        try { aes.Decrypt(nonce, ciphertext, tag, plainBytes, aad); }
        catch (AuthenticationTagMismatchException)
        {
            ZeroMemory(ikm, encKey, cmtKey, plainBytes);
            throw new CryptographicException("Data integrity check failed.");
        }

        ZeroMemory(ikm, encKey, cmtKey);
        return plainBytes;
    }

    private static byte[] DeriveIKM(string machineCode, byte[] salt)
        => Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(machineCode), salt, Pbkdf2Iterations,
            HashAlgorithmName.SHA256, KeySize);

    private static (byte[] encKey, byte[] cmtKey) DeriveKeys(byte[] ikm)
    {
        return (
            HKDF.Expand(HashAlgorithmName.SHA256, ikm, KeySize, Encoding.UTF8.GetBytes("enc-v1")),
            HKDF.Expand(HashAlgorithmName.SHA256, ikm, KeySize, Encoding.UTF8.GetBytes("cmt-v1")));
    }

    private static byte[] BuildAssociatedData(byte[] salt, byte[] nonce)
    {
        byte[] aad = new byte[1 + SaltSize + NonceSize];
        aad[0] = CurrentVersion;
        Buffer.BlockCopy(salt, 0, aad, 1, SaltSize);
        Buffer.BlockCopy(nonce, 0, aad, 1 + SaltSize, NonceSize);
        return aad;
    }

    private static string GetCpuIdentifier()
    {
        if (OperatingSystem.IsWindows())
        {
            try { return Environment.GetEnvironmentVariable("PROCESSOR_IDENTIFIER") ?? "UnknownCPU"; }
            catch { return "UnknownCPU"; }
        }
        try
        {
            if (File.Exists("/proc/cpuinfo"))
            {
                var content = File.ReadAllText("/proc/cpuinfo");
                var lines = content.Split('\n');
                var model = lines.FirstOrDefault(l => l.StartsWith("model name", StringComparison.OrdinalIgnoreCase));
                var cores = lines.FirstOrDefault(l => l.StartsWith("cpu cores", StringComparison.OrdinalIgnoreCase));
                if (model != null)
                {
                    var m = model.Split(':').Last().Trim();
                    var c = cores?.Split(':').Last().Trim() ?? "?";
                    return $"cpu:{m}:cores={c}";
                }
                var proc = lines.FirstOrDefault(l => l.StartsWith("Processor", StringComparison.OrdinalIgnoreCase));
                if (proc != null) return proc.Split(':').Last().Trim();
            }
            if (File.Exists("/etc/machine-id")) return "cpu-" + File.ReadAllText("/etc/machine-id").Trim();
            if (File.Exists("/var/lib/dbus/machine-id")) return "cpu-" + File.ReadAllText("/var/lib/dbus/machine-id").Trim();
            return "UnknownCPU";
        }
        catch { return "UnknownCPU"; }
    }

    private static string GetBoardIdentifier()
    {
        if (OperatingSystem.IsWindows())
        {
            try { return Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\BIOS", "SystemManufacturer", "") + "-" + Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\BIOS", "SystemProductName", ""); }
            catch { return "UnknownBoard"; }
        }
        if (OperatingSystem.IsMacOS())
        {
            try
            {
                var psi = new ProcessStartInfo("sysctl", "-n hw.model") { RedirectStandardOutput = true, UseShellExecute = false };
                using var p = Process.Start(psi);
                return p?.StandardOutput.ReadToEnd().Trim() ?? "UnknownBoard";
            }
            catch { return "UnknownBoard"; }
        }
        try
        {
            if (File.Exists("/sys/class/dmi/id/board_serial"))
            {
                var s = File.ReadAllText("/sys/class/dmi/id/board_serial").Trim();
                if (!string.IsNullOrEmpty(s) && s != "Not Available" && s != "None") return s;
            }
            if (File.Exists("/sys/class/dmi/id/product_uuid"))
            {
                var u = File.ReadAllText("/sys/class/dmi/id/product_uuid").Trim();
                if (!string.IsNullOrEmpty(u)) return u;
            }
            if (File.Exists("/etc/machine-id")) return "board-" + File.ReadAllText("/etc/machine-id").Trim();
            if (File.Exists("/var/lib/dbus/machine-id")) return "board-" + File.ReadAllText("/var/lib/dbus/machine-id").Trim();
            return "UnknownBoard";
        }
        catch { return "UnknownBoard"; }
    }

    private static string GetMacAddress()
    {
        try
        {
            var nic = NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.OperationalStatus == OperationalStatus.Up
                         && n.NetworkInterfaceType != NetworkInterfaceType.Loopback
                         && n.NetworkInterfaceType != NetworkInterfaceType.Tunnel)
                .Select(n => n.GetPhysicalAddress().ToString())
                .FirstOrDefault(s => !string.IsNullOrEmpty(s) && s.Length >= 12);
            return nic ?? "UnknownMAC";
        }
        catch { return "UnknownMAC"; }
    }

    private static void ZeroMemory(params byte[][] arrays)
    {
        foreach (var arr in arrays)
            CryptographicOperations.ZeroMemory(arr);
    }
}
