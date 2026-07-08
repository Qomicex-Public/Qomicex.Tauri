using Newtonsoft.Json.Linq;
using Qomicex.Core.Modules.Helpers.Resources.Expansion.CurseForge;
using Qomicex.Core.Modules.Helpers.Resources.Expansion.Modrinth;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace Qomicex.Core.Modules.Helpers.Resources.Expansion.Local
{
    public class DataPacks: LocalResourceBase
    {
        private readonly string _gameDirectory;
        private readonly string _version;
        private readonly bool _versionSegmented;
        private readonly string _apiKey;

        public DataPacks(string gameDirectory, string version, bool versionSegmented, string apiKey)
        {
            _gameDirectory = gameDirectory;
            _version = version;
            _versionSegmented = versionSegmented;
            _apiKey = apiKey;
        }

        private List<string> GetDataPackFiles()
        {
            string datapackDirectory = _versionSegmented
                ? Path.Combine(_gameDirectory, "versions", _version, "datapacks")
                : Path.Combine(_gameDirectory, "datapacks");

            if (!Directory.Exists(datapackDirectory))
                return new List<string>();

            var entries = new List<string>();
            entries.AddRange(Directory.GetFiles(datapackDirectory, "*.zip"));

            foreach (var dir in Directory.GetDirectories(datapackDirectory))
            {
                if (File.Exists(Path.Combine(dir, "pack.mcmeta")))
                    entries.Add(dir);
            }

            return entries;
        }

        private static JObject ReadMcmetaFromZip(string zipPath)
        {
            var bytes = TryReadFileFromZip(zipPath, "pack.mcmeta");
            if (bytes == null)
                return null;

            try
            {
                string jsonContent = Encoding.UTF8.GetString(bytes);
                return JObject.Parse(jsonContent);
            }
            catch
            {
                return null;
            }
        }

        private static JObject ReadMcmetaFromFolder(string folderPath)
        {
            string mcmetaPath = Path.Combine(folderPath, "pack.mcmeta");
            if (!File.Exists(mcmetaPath))
                return null;

            try
            {
                string jsonContent = File.ReadAllText(mcmetaPath);
                return JObject.Parse(jsonContent);
            }
            catch
            {
                return null;
            }
        }

        private static string ReadIconFromZip(string zipPath)
        {
            var bytes = TryReadFileFromZip(zipPath, "pack.png");
            if (bytes == null || bytes.Length == 0)
                return string.Empty;
            return Convert.ToBase64String(bytes);
        }

        private static string ReadIconFromFolder(string folderPath)
        {
            string iconPath = Path.Combine(folderPath, "pack.png");
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

        private static (string sha1, long cfHash) ComputeHashesForFile(string filePath)
        {
            byte[] fileBytes = File.ReadAllBytes(filePath);
            using (SHA1 sha1 = SHA1.Create())
            {
                byte[] hashBytes = sha1.ComputeHash(fileBytes);
                string sha1Hash = BitConverter.ToString(hashBytes).Replace("-", "").ToLowerInvariant();
                long cfHash = MurmurHash2(fileBytes);
                return (sha1Hash, cfHash);
            }
        }

        private static (string sha1, long cfHash) ComputeHashesForFolder(string folderPath)
        {
            using (var memStream = new MemoryStream())
            {
                using (var archive = new ZipArchive(memStream, ZipArchiveMode.Create, true))
                {
                    foreach (var file in Directory.GetFiles(folderPath, "*", SearchOption.AllDirectories))
                    {
                        string relativePath = Path.GetRelativePath(folderPath, file).Replace('\\', '/');
                        archive.CreateEntryFromFile(file, relativePath);
                    }
                }

                memStream.Position = 0;
                byte[] zipBytes = memStream.ToArray();
                using (SHA1 sha1 = SHA1.Create())
                {
                    byte[] hashBytes = sha1.ComputeHash(zipBytes);
                    string sha1Hash = BitConverter.ToString(hashBytes).Replace("-", "").ToLowerInvariant();
                    long cfHash = MurmurHash2(zipBytes);
                    return (sha1Hash, cfHash);
                }
            }
        }

        public async Task<List<DataPackInfo>> GetDataPackList()
        {
            var entries = GetDataPackFiles();
            Trace.WriteLine($"Fetching datapack list: {_version}, dir: {(_versionSegmented ? Path.Combine(_gameDirectory, "versions", _version, "datapacks") : Path.Combine(_gameDirectory, "datapacks"))}");
            var sha1List = new List<string>();
            var mHashList = new List<long>();
            var packInfos = new List<DataPackInfo>();

            foreach (var entry in entries)
            {
                Trace.WriteLine($"Fetching datapack: {entry}");
                bool isDirectory = Directory.Exists(entry);

                JObject mcmeta = isDirectory
                    ? ReadMcmetaFromFolder(entry)
                    : ReadMcmetaFromZip(entry);

                string description = mcmeta?["pack"]?["description"]?.ToString() ?? "";
                int packFormat = mcmeta?["pack"]?["pack_format"]?.ToObject<int>() ?? 0;

                string icon = isDirectory
                    ? ReadIconFromFolder(entry)
                    : ReadIconFromZip(entry);

                string sha1;
                long cfHash;
                if (isDirectory)
                    (sha1, cfHash) = ComputeHashesForFolder(entry);
                else
                    (sha1, cfHash) = ComputeHashesForFile(entry);

                sha1List.Add(sha1);
                mHashList.Add(cfHash);

                string fallbackName = Path.GetFileNameWithoutExtension(entry);

                packInfos.Add(new DataPackInfo
                {
                    FilePath = entry,
                    IsDirectory = isDirectory,
                    Sha1Hash = sha1,
                    CFHash = cfHash,
                    Name = fallbackName,
                    Description = description,
                    PackFormat = packFormat,
                    Icon = icon
                });
            }

            var cfDict = new Dictionary<long, CurseForgeBase.FingerprintsFilesMeta>();
            var mrDict = new Dictionary<string, ModrinthBase.ProjectVersionInfo>();

            if (sha1List.Count > 0)
            {
                try
                {
                    CurseForgeBase cf = new CurseForgeBase(_apiKey, "", "");
                    cfDict = await cf.GetInfoFromHashesDictAsync(mHashList);
                }
                catch { }

                try
                {
                    ModrinthBase mr = new ModrinthBase();
                    mrDict = await mr.GetProjectVersionsFromHashesDictAsync(sha1List);
                }
                catch { }
            }

            foreach (var packInfo in packInfos)
            {
                if (cfDict.TryGetValue(packInfo.CFHash, out var cfMeta))
                {
                    if (int.TryParse(cfMeta.ModId, out int modId))
                        packInfo.CurseForgeId = modId;
                    packInfo.CurseForgeMeta = cfMeta;
                }

                if (mrDict.TryGetValue(packInfo.Sha1Hash, out var mrMeta))
                {
                    packInfo.ModrinthId = mrMeta.ProjectId ?? "";
                    packInfo.ModrinthMeta = mrMeta;
                    if (!string.IsNullOrEmpty(mrMeta.Name))
                        packInfo.Name = mrMeta.Name;
                    if (!string.IsNullOrEmpty(mrMeta.VersionNumber))
                        packInfo.Version = mrMeta.VersionNumber;
                }
            }

            return packInfos;
        }

        public class DataPackInfo
        {
            public string Name { get; set; }
            public string Description { get; set; }
            public string Version { get; set; }
            public string FilePath { get; set; }
            public bool IsDirectory { get; set; }
            public int PackFormat { get; set; }
            public string Icon { get; set; }
            public int CurseForgeId { get; set; }
            public string ModrinthId { get; set; }
            public string Sha1Hash { get; set; }
            public long CFHash { get; set; }
            public CurseForgeBase.FingerprintsFilesMeta CurseForgeMeta { get; set; }
            public ModrinthBase.ProjectVersionInfo ModrinthMeta { get; set; }
        }
    }
}
