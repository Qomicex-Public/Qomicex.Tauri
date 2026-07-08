using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;

namespace Qomicex.Core.Modules.Helpers.Resources.Expansion.Local
{
    public class Saves: LocalResourceBase
    {
        private readonly string _gameDirectory;
        private readonly string _version;
        private readonly bool _versionSegmented;
        private readonly string _apiKey;

        public Saves(string gameDirectory, string version, bool versionSegmented, string apiKey)
        {
            _gameDirectory = gameDirectory;
            _version = version;
            _versionSegmented = versionSegmented;
            _apiKey = apiKey;
        }

        private List<string> GetSaveFolders()
        {
            string savesDirectory = _versionSegmented
                ? Path.Combine(_gameDirectory, "versions", _version, "saves")
                : Path.Combine(_gameDirectory, "saves");

            if (!Directory.Exists(savesDirectory))
                return new List<string>();

            return Directory.GetDirectories(savesDirectory).ToList();
        }

        private static string ReadLevelName(string saveDirectory)
        {
            string levelDatPath = Path.Combine(saveDirectory, "level.dat");
            if (!File.Exists(levelDatPath))
                return null;

            try
            {
                using var fileStream = File.OpenRead(levelDatPath);
                using var dataStream = CreateReadStream(fileStream);
                using var reader = new BinaryReader(dataStream, Encoding.UTF8, leaveOpen: false);

                var root = ReadRootCompound(reader);
                if (root.TryGetValue("Data", out var dataTag) && dataTag.Value is NbtCompound data)
                {
                    if (data.TryGetValue("LevelName", out var nameTag) && nameTag.Value is string name)
                        return name;
                }

                return null;
            }
            catch
            {
                return null;
            }
        }

        private static long ReadLastPlayed(string saveDirectory)
        {
            string levelDatPath = Path.Combine(saveDirectory, "level.dat");
            if (!File.Exists(levelDatPath))
                return 0;

            try
            {
                using var fileStream = File.OpenRead(levelDatPath);
                using var dataStream = CreateReadStream(fileStream);
                using var reader = new BinaryReader(dataStream, Encoding.UTF8, leaveOpen: false);

                var root = ReadRootCompound(reader);
                if (root.TryGetValue("Data", out var dataTag) && dataTag.Value is NbtCompound data)
                {
                    if (data.TryGetValue("LastPlayed", out var lastPlayedTag) && lastPlayedTag.Value is long lastPlayed)
                        return lastPlayed;
                }

                return 0;
            }
            catch
            {
                return 0;
            }
        }

        private static string ReadIconFromSave(string saveDirectory)
        {
            string iconPath = Path.Combine(saveDirectory, "icon.png");
            if (!File.Exists(iconPath))
                return string.Empty;

            try
            {
                byte[] bytes = File.ReadAllBytes(iconPath);
                return Convert.ToBase64String(bytes);
            }
            catch
            {
                return string.Empty;
            }
        }

        public List<SaveInfo> GetSaveList()
        {
            var folders = GetSaveFolders();
            var saveInfos = new List<SaveInfo>();

            foreach (var folder in folders)
            {
                string levelName = ReadLevelName(folder) ?? Path.GetFileName(folder);
                long lastPlayed = ReadLastPlayed(folder);
                string icon = ReadIconFromSave(folder);

                saveInfos.Add(new SaveInfo
                {
                    FilePath = folder,
                    Name = levelName,
                    LastPlayed = lastPlayed,
                    Icon = icon
                });
            }

            return saveInfos;
        }

        private static void WriteLevelName(string saveDirectory, string newName)
        {
            string levelDatPath = Path.Combine(saveDirectory, "level.dat");
            byte[] originalBytes = File.ReadAllBytes(levelDatPath);

            try
            {
                NbtCompound root;
                using (var fileStream = new MemoryStream(originalBytes))
                using (var dataStream = CreateReadStream(fileStream))
                using (var reader = new BinaryReader(dataStream, Encoding.UTF8, leaveOpen: false))
                {
                    root = ReadRootCompound(reader);
                }

                if (root.TryGetValue("Data", out var dataTag) && dataTag.Value is NbtCompound data)
                {
                    data["LevelName"] = new NbtValue { TagType = NbtTagType.String, Value = newName };
                }
                else
                {
                    throw new InvalidDataException("level.dat does not contain Data compound.");
                }

                using var outStream = File.Create(levelDatPath);
                using var gzipStream = new GZipStream(outStream, CompressionMode.Compress);
                using var writer = new BinaryWriter(gzipStream, Encoding.UTF8, leaveOpen: false);

                WriteRootCompound(writer, root);
            }
            catch
            {
                File.WriteAllBytes(levelDatPath, originalBytes);
                throw;
            }
        }

        public void RenameSave(string saveDirectory, string newName)
        {
            if (!Directory.Exists(saveDirectory))
                throw new DirectoryNotFoundException($"Save directory not found: {saveDirectory}");

            string levelDatPath = Path.Combine(saveDirectory, "level.dat");
            if (!File.Exists(levelDatPath))
                throw new FileNotFoundException($"level.dat not found in save directory: {saveDirectory}");

            string originalName = ReadLevelName(saveDirectory) ?? Path.GetFileName(saveDirectory);

            try
            {
                WriteLevelName(saveDirectory, newName);

                string parentDir = Path.GetDirectoryName(saveDirectory);
                string newPath = Path.Combine(parentDir, newName);

                if (Directory.Exists(newPath))
                    throw new IOException($"Target directory already exists: {newPath}");

                Directory.Move(saveDirectory, newPath);
            }
            catch
            {
                WriteLevelName(saveDirectory, originalName);
                throw;
            }
        }

        public void BackupSave(string saveDirectory)
        {
            if (!Directory.Exists(saveDirectory))
                throw new DirectoryNotFoundException($"Save directory not found: {saveDirectory}");

            string timestamp = DateTime.Now.ToString("yyyyMMdd_HHmmss");
            string saveName = Path.GetFileName(saveDirectory);
            string parentDir = Path.GetDirectoryName(saveDirectory);
            string backupPath = Path.Combine(parentDir, $"{saveName}_backup_{timestamp}");

            if (Directory.Exists(backupPath))
                return;

            CopyDirectoryRecursive(saveDirectory, backupPath);
        }

        private static void CopyDirectoryRecursive(string sourceDir, string destDir)
        {
            Directory.CreateDirectory(destDir);

            foreach (var file in Directory.GetFiles(sourceDir))
            {
                string destFile = Path.Combine(destDir, Path.GetFileName(file));
                File.Copy(file, destFile);
            }

            foreach (var dir in Directory.GetDirectories(sourceDir))
            {
                string destSubDir = Path.Combine(destDir, Path.GetFileName(dir));
                CopyDirectoryRecursive(dir, destSubDir);
            }
        }

        public class SaveInfo
        {
            public string Name { get; set; }
            public string FilePath { get; set; }
            public long LastPlayed { get; set; }
            public string Icon { get; set; }
        }

        #region NBT Parser

        private struct NbtValue
        {
            public byte TagType;
            public object Value;
        }

        private static Stream CreateReadStream(Stream stream)
        {
            Span<byte> header = stackalloc byte[2];
            var read = stream.Read(header);
            stream.Position = 0;

            var isGzip = read == 2 && header[0] == 0x1F && header[1] == 0x8B;
            if (isGzip)
                return new GZipStream(stream, CompressionMode.Decompress);

            return stream;
        }

        private static NbtCompound ReadRootCompound(BinaryReader reader)
        {
            var tagType = reader.ReadByte();
            if (tagType != NbtTagType.Compound)
                throw new InvalidDataException($"Expected root compound tag, but found type {tagType}.");

            ReadString(reader);
            return ReadCompoundPayload(reader);
        }

        private static void WriteRootCompound(BinaryWriter writer, NbtCompound root)
        {
            writer.Write(NbtTagType.Compound);
            WriteString(writer, string.Empty);
            WriteCompoundPayload(writer, root);
        }

        private static NbtCompound ReadCompoundPayload(BinaryReader reader)
        {
            var compound = new NbtCompound();

            while (true)
            {
                var tagType = reader.ReadByte();
                if (tagType == NbtTagType.End)
                    return compound;

                var name = ReadString(reader);
                compound[name] = ReadTagPayload(reader, tagType);
            }
        }

        private static NbtValue ReadTagPayload(BinaryReader reader, byte tagType)
        {
            return tagType switch
            {
                NbtTagType.Byte => new NbtValue { TagType = tagType, Value = reader.ReadByte() },
                NbtTagType.Short => new NbtValue { TagType = tagType, Value = ReadInt16BigEndian(reader) },
                NbtTagType.Int => new NbtValue { TagType = tagType, Value = ReadInt32BigEndian(reader) },
                NbtTagType.Long => new NbtValue { TagType = tagType, Value = ReadInt64BigEndian(reader) },
                NbtTagType.Float => new NbtValue { TagType = tagType, Value = ReadFloatBigEndian(reader) },
                NbtTagType.Double => new NbtValue { TagType = tagType, Value = ReadDoubleBigEndian(reader) },
                NbtTagType.String => new NbtValue { TagType = tagType, Value = ReadString(reader) },
                NbtTagType.List => new NbtValue { TagType = tagType, Value = ReadListPayload(reader) },
                NbtTagType.Compound => new NbtValue { TagType = tagType, Value = ReadCompoundPayload(reader) },
                NbtTagType.IntArray => new NbtValue { TagType = tagType, Value = ReadIntArrayPayload(reader) },
                NbtTagType.LongArray => new NbtValue { TagType = tagType, Value = ReadLongArrayPayload(reader) },
                _ => throw new InvalidDataException($"Unsupported NBT tag type {tagType}.")
            };
        }

        private static NbtList ReadListPayload(BinaryReader reader)
        {
            var elementType = reader.ReadByte();
            var length = ReadInt32BigEndian(reader);
            if (length < 0)
                throw new InvalidDataException("NBT list length cannot be negative.");

            var items = new NbtValue[length];
            for (var i = 0; i < length; i++)
                items[i] = ReadTagPayload(reader, elementType);

            return new NbtList { ElementType = elementType, Items = items };
        }

        private static int[] ReadIntArrayPayload(BinaryReader reader)
        {
            var length = ReadInt32BigEndian(reader);
            if (length < 0)
                throw new InvalidDataException("NBT int array length cannot be negative.");

            var array = new int[length];
            for (var i = 0; i < length; i++)
                array[i] = ReadInt32BigEndian(reader);

            return array;
        }

        private static long[] ReadLongArrayPayload(BinaryReader reader)
        {
            var length = ReadInt32BigEndian(reader);
            if (length < 0)
                throw new InvalidDataException("NBT long array length cannot be negative.");

            var array = new long[length];
            for (var i = 0; i < length; i++)
                array[i] = ReadInt64BigEndian(reader);

            return array;
        }

        private static void WriteCompoundPayload(BinaryWriter writer, NbtCompound compound)
        {
            foreach (var entry in compound)
                WriteNamedTag(writer, entry.Key, entry.Value);

            writer.Write(NbtTagType.End);
        }

        private static void WriteNamedTag(BinaryWriter writer, string name, NbtValue tag)
        {
            writer.Write(tag.TagType);
            WriteString(writer, name);

            switch (tag.Value)
            {
                case byte b:
                    writer.Write(b);
                    break;
                case short s:
                    WriteInt16BigEndian(writer, s);
                    break;
                case int i:
                    WriteInt32BigEndian(writer, i);
                    break;
                case long l:
                    WriteInt64BigEndian(writer, l);
                    break;
                case float f:
                    WriteFloatBigEndian(writer, f);
                    break;
                case double d:
                    WriteDoubleBigEndian(writer, d);
                    break;
                case string text:
                    WriteString(writer, text);
                    break;
                case NbtList list:
                    writer.Write(list.ElementType);
                    WriteInt32BigEndian(writer, list.Items.Length);
                    foreach (var item in list.Items)
                        WriteTagValue(writer, item);
                    break;
                case NbtCompound compound:
                    WriteCompoundPayload(writer, compound);
                    break;
                case int[] intArray:
                    WriteInt32BigEndian(writer, intArray.Length);
                    foreach (var v in intArray)
                        WriteInt32BigEndian(writer, v);
                    break;
                case long[] longArray:
                    WriteInt32BigEndian(writer, longArray.Length);
                    foreach (var v in longArray)
                        WriteInt64BigEndian(writer, v);
                    break;
                default:
                    throw new InvalidOperationException($"Unsupported NBT value type '{tag.Value.GetType().FullName}'.");
            }
        }

        private static void WriteTagValue(BinaryWriter writer, NbtValue tag)
        {
            switch (tag.Value)
            {
                case byte b:
                    writer.Write(b);
                    break;
                case short s:
                    WriteInt16BigEndian(writer, s);
                    break;
                case int i:
                    WriteInt32BigEndian(writer, i);
                    break;
                case long l:
                    WriteInt64BigEndian(writer, l);
                    break;
                case float f:
                    WriteFloatBigEndian(writer, f);
                    break;
                case double d:
                    WriteDoubleBigEndian(writer, d);
                    break;
                case string text:
                    WriteString(writer, text);
                    break;
                case NbtList list:
                    writer.Write(list.ElementType);
                    WriteInt32BigEndian(writer, list.Items.Length);
                    foreach (var item in list.Items)
                        WriteTagValue(writer, item);
                    break;
                case NbtCompound compound:
                    WriteCompoundPayload(writer, compound);
                    break;
                case int[] intArray:
                    WriteInt32BigEndian(writer, intArray.Length);
                    foreach (var v in intArray)
                        WriteInt32BigEndian(writer, v);
                    break;
                case long[] longArray:
                    WriteInt32BigEndian(writer, longArray.Length);
                    foreach (var v in longArray)
                        WriteInt64BigEndian(writer, v);
                    break;
                default:
                    throw new InvalidOperationException($"Unsupported NBT value type '{tag.Value.GetType().FullName}'.");
            }
        }

        private static string ReadString(BinaryReader reader)
        {
            var length = ReadUInt16BigEndian(reader);
            var bytes = reader.ReadBytes(length);
            if (bytes.Length != length)
                throw new EndOfStreamException("Unexpected end of stream while reading NBT string.");

            return Encoding.UTF8.GetString(bytes);
        }

        private static void WriteString(BinaryWriter writer, string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            if (bytes.Length > ushort.MaxValue)
                throw new InvalidOperationException("NBT string length exceeds UInt16.MaxValue.");

            WriteUInt16BigEndian(writer, (ushort)bytes.Length);
            writer.Write(bytes);
        }

        private static int ReadInt32BigEndian(BinaryReader reader)
        {
            Span<byte> bytes = stackalloc byte[sizeof(int)];
            reader.ReadExactly(bytes);
            if (BitConverter.IsLittleEndian) bytes.Reverse();
            return BitConverter.ToInt32(bytes);
        }

        private static void WriteInt32BigEndian(BinaryWriter writer, int value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(int)];
            BitConverter.TryWriteBytes(bytes, value);
            if (BitConverter.IsLittleEndian) bytes.Reverse();
            writer.Write(bytes);
        }

        private static short ReadInt16BigEndian(BinaryReader reader)
        {
            Span<byte> bytes = stackalloc byte[sizeof(short)];
            reader.ReadExactly(bytes);
            if (BitConverter.IsLittleEndian) bytes.Reverse();
            return BitConverter.ToInt16(bytes);
        }

        private static void WriteInt16BigEndian(BinaryWriter writer, short value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(short)];
            BitConverter.TryWriteBytes(bytes, value);
            if (BitConverter.IsLittleEndian) bytes.Reverse();
            writer.Write(bytes);
        }

        private static long ReadInt64BigEndian(BinaryReader reader)
        {
            Span<byte> bytes = stackalloc byte[sizeof(long)];
            reader.ReadExactly(bytes);
            if (BitConverter.IsLittleEndian) bytes.Reverse();
            return BitConverter.ToInt64(bytes);
        }

        private static void WriteInt64BigEndian(BinaryWriter writer, long value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(long)];
            BitConverter.TryWriteBytes(bytes, value);
            if (BitConverter.IsLittleEndian) bytes.Reverse();
            writer.Write(bytes);
        }

        private static float ReadFloatBigEndian(BinaryReader reader)
        {
            Span<byte> bytes = stackalloc byte[sizeof(float)];
            reader.ReadExactly(bytes);
            if (BitConverter.IsLittleEndian) bytes.Reverse();
            return BitConverter.ToSingle(bytes);
        }

        private static void WriteFloatBigEndian(BinaryWriter writer, float value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(float)];
            BitConverter.TryWriteBytes(bytes, value);
            if (BitConverter.IsLittleEndian) bytes.Reverse();
            writer.Write(bytes);
        }

        private static double ReadDoubleBigEndian(BinaryReader reader)
        {
            Span<byte> bytes = stackalloc byte[sizeof(double)];
            reader.ReadExactly(bytes);
            if (BitConverter.IsLittleEndian) bytes.Reverse();
            return BitConverter.ToDouble(bytes);
        }

        private static void WriteDoubleBigEndian(BinaryWriter writer, double value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(double)];
            BitConverter.TryWriteBytes(bytes, value);
            if (BitConverter.IsLittleEndian) bytes.Reverse();
            writer.Write(bytes);
        }

        private static ushort ReadUInt16BigEndian(BinaryReader reader)
        {
            Span<byte> bytes = stackalloc byte[sizeof(ushort)];
            reader.ReadExactly(bytes);
            if (BitConverter.IsLittleEndian) bytes.Reverse();
            return BitConverter.ToUInt16(bytes);
        }

        private static void WriteUInt16BigEndian(BinaryWriter writer, ushort value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(ushort)];
            BitConverter.TryWriteBytes(bytes, value);
            if (BitConverter.IsLittleEndian) bytes.Reverse();
            writer.Write(bytes);
        }

        private sealed class NbtCompound : Dictionary<string, NbtValue>
        {
        }

        private sealed class NbtList
        {
            public byte ElementType;
            public NbtValue[] Items;
        }

        private static class NbtTagType
        {
            public const byte End = 0;
            public const byte Byte = 1;
            public const byte Short = 2;
            public const byte Int = 3;
            public const byte Long = 4;
            public const byte Float = 5;
            public const byte Double = 6;
            public const byte ByteArray = 7;
            public const byte String = 8;
            public const byte List = 9;
            public const byte Compound = 10;
            public const byte IntArray = 11;
            public const byte LongArray = 12;
        }

        #endregion
    }
}
