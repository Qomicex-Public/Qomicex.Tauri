using System;
using System.IO;
using System.IO.Compression;
using System.Text;

namespace Qomicex.Launcher.Backend.Modules.Helpers;

public enum SkinModelType
{
    Classic,
    Slim
}

public enum RenderFace
{
    Front,
    Back,
    Left,
    Right
}

public enum SkinPart
{
    HeadFront, HeadBack, HeadLeft, HeadRight, HeadTop, HeadBottom,
    HatFront, HatBack,
    BodyFront, BodyBack, BodyLeft, BodyRight,
    LeftArmFront, LeftArmBack,
    RightArmFront, RightArmBack,
    LeftLegFront, LeftLegBack,
    RightLegFront, RightLegBack
}

public class SkinHelper : IDisposable
{
    private byte[] _skinData;
    private int _width;
    private int _height;
    private bool _isSlim;
    private bool _disposed;

    public SkinModelType ModelType { get; private set; }
    public int SkinWidth => _width;
    public int SkinHeight => _height;

    private static readonly byte[] PngSignature = { 137, 80, 78, 71, 13, 10, 26, 10 };

    public SkinHelper(string filePath)
    {
        if (!File.Exists(filePath))
            throw new FileNotFoundException("皮肤文件不存在", filePath);

        _skinData = File.ReadAllBytes(filePath);
        ParsePngHeader();
    }

    public SkinHelper(byte[] data)
    {
        _skinData = data ?? throw new ArgumentNullException(nameof(data));
        ParsePngHeader();
    }

    public SkinHelper(Stream stream)
    {
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        _skinData = ms.ToArray();
        ParsePngHeader();
    }

    private void ParsePngHeader()
    {
        _width = 64;
        _height = 64;
        _isSlim = false;
        ModelType = SkinModelType.Classic;

        if (_skinData == null || _skinData.Length < 33)
            return;

        if (_skinData[0] != 137 || _skinData[1] != 80 || _skinData[2] != 78 || _skinData[3] != 71)
            return;

        _width = (_skinData[16] << 24) | (_skinData[17] << 16) | (_skinData[18] << 8) | _skinData[19];
        _height = (_skinData[20] << 24) | (_skinData[21] << 16) | (_skinData[22] << 8) | _skinData[23];

        if (_height == 32 && _width == 64)
            _height = 64;

        _isSlim = false;
        ModelType = SkinModelType.Classic;
    }

    public byte[] GetHeadAvatar(int size = 64, bool includeHat = true)
    {
        return CreateDefaultSkinPng(64, 32);
    }

    public byte[] GetFullBody(RenderFace face = RenderFace.Front,
                               int scale = 4, bool includeOuter = true)
    {
        return CreateDefaultSkinPng(64, 32);
    }

    public byte[] GetPartRaw(SkinPart part)
    {
        return CreateDefaultSkinPng(16, 16);
    }

    public byte[] GetFrontBackComparison(int scale = 4, bool includeOuter = true)
    {
        return CreateDefaultSkinPng(128, 64);
    }

    public static void SavePng(byte[] pngData, string outputPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(outputPath) ?? ".");
        File.WriteAllBytes(outputPath, pngData);
    }

    public static byte[] ToPngBytes(byte[] pngData)
    {
        return pngData;
    }

    public void Dispose()
    {
        if (!_disposed)
        {
            _skinData = null;
            _disposed = true;
        }
    }

    private static byte[] CreateDefaultSkinPng(int width, int height)
    {
        using var ms = new MemoryStream();
        ms.Write(PngSignature, 0, 8);

        WriteChunk(ms, "IHDR", CreateIhdrData(width, height));

        byte[] rawData = new byte[height * (1 + width * 4)];
        for (int y = 0; y < height; y++)
        {
            int rowOffset = y * (1 + width * 4);
            rawData[rowOffset] = 0;
            for (int x = 0; x < width; x++)
            {
                int px = rowOffset + 1 + x * 4;
                rawData[px] = 255;
                rawData[px + 1] = 255;
                rawData[px + 2] = 255;
                rawData[px + 3] = 255;
            }
        }

        byte[] compressed;
        using (var compressedMs = new MemoryStream())
        {
            using (var deflate = new DeflateStream(compressedMs, CompressionLevel.Optimal))
            {
                deflate.Write(rawData, 0, rawData.Length);
            }
            compressed = compressedMs.ToArray();
        }

        byte[] idatData = new byte[2 + compressed.Length];
        idatData[0] = 0x78;
        idatData[1] = 0x01;
        Array.Copy(compressed, 0, idatData, 2, compressed.Length);
        WriteChunk(ms, "IDAT", idatData);

        WriteChunk(ms, "IEND", Array.Empty<byte>());

        return ms.ToArray();
    }

    private static byte[] CreateIhdrData(int width, int height)
    {
        byte[] data = new byte[13];
        data[0] = (byte)((width >> 24) & 0xFF);
        data[1] = (byte)((width >> 16) & 0xFF);
        data[2] = (byte)((width >> 8) & 0xFF);
        data[3] = (byte)(width & 0xFF);
        data[4] = (byte)((height >> 24) & 0xFF);
        data[5] = (byte)((height >> 16) & 0xFF);
        data[6] = (byte)((height >> 8) & 0xFF);
        data[7] = (byte)(height & 0xFF);
        data[8] = 8;
        data[9] = 6;
        data[10] = 0;
        data[11] = 0;
        data[12] = 0;
        return data;
    }

    private static void WriteChunk(MemoryStream stream, string type, byte[] data)
    {
        byte[] typeBytes = Encoding.ASCII.GetBytes(type);
        uint length = (uint)data.Length;

        byte[] lengthBytes = new byte[4];
        lengthBytes[0] = (byte)((length >> 24) & 0xFF);
        lengthBytes[1] = (byte)((length >> 16) & 0xFF);
        lengthBytes[2] = (byte)((length >> 8) & 0xFF);
        lengthBytes[3] = (byte)(length & 0xFF);
        stream.Write(lengthBytes, 0, 4);

        stream.Write(typeBytes, 0, 4);
        stream.Write(data, 0, data.Length);

        uint crc = Crc32(typeBytes, data);
        byte[] crcBytes = new byte[4];
        crcBytes[0] = (byte)((crc >> 24) & 0xFF);
        crcBytes[1] = (byte)((crc >> 16) & 0xFF);
        crcBytes[2] = (byte)((crc >> 8) & 0xFF);
        crcBytes[3] = (byte)(crc & 0xFF);
        stream.Write(crcBytes, 0, 4);
    }

    private static uint Crc32(byte[] type, byte[] data)
    {
        uint[] table = new uint[256];
        for (uint i = 0; i < 256; i++)
        {
            uint c = i;
            for (int j = 0; j < 8; j++)
            {
                if ((c & 1) != 0)
                    c = 0xEDB88320 ^ (c >> 1);
                else
                    c >>= 1;
            }
            table[i] = c;
        }

        uint crc = 0xFFFFFFFF;
        foreach (byte b in type)
            crc = table[(crc ^ b) & 0xFF] ^ (crc >> 8);
        foreach (byte b in data)
            crc = table[(crc ^ b) & 0xFF] ^ (crc >> 8);
        return crc ^ 0xFFFFFFFF;
    }
}

public static class SkinRenderer
{
    public static byte[] GetRoundAvatar(byte[] headAvatar, int size = 128, bool includeHat = true)
    {
        return headAvatar;
    }

    public static byte[] GetAvatarWithBackground(byte[] headAvatar,
        byte[] background, int size = 128, bool includeHat = true, int padding = 8)
    {
        return headAvatar;
    }

    public static byte[] GetRoundedAvatar(byte[] headAvatar,
        int size = 128, float cornerRadius = 16f, bool includeHat = true)
    {
        return headAvatar;
    }

    public static byte[] GetSkinAtlas(byte[] skinPng, int scale = 4)
    {
        return skinPng;
    }

    public static byte[] PixelScale(byte[] source, int scale)
    {
        return source;
    }
}
