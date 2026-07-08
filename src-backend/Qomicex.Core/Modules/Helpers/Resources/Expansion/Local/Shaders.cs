using Newtonsoft.Json.Linq;
using Qomicex.Core.Modules.Helpers.Resources.Expansion.CurseForge;
using Qomicex.Core.Modules.Helpers.Resources.Expansion.Modrinth;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Threading.Tasks;

namespace Qomicex.Core.Modules.Helpers.Resources.Expansion.Local
{
    public class Shaders: LocalResourceBase
    {
        private readonly string _gameDirectory;
        private readonly string _version;
        private readonly bool _versionSegmented;
        private readonly string _apiKey;

        public Shaders(string gameDirectory, string version, bool versionSegmented, string apiKey)
        {
            _gameDirectory = gameDirectory;
            _version = version;
            _versionSegmented = versionSegmented;
            _apiKey = apiKey;
        }

        private List<string> GetShaderFiles()
        {
            string shaderDirectory = _versionSegmented
                ? Path.Combine(_gameDirectory, "versions", _version, "shaderpacks")
                : Path.Combine(_gameDirectory, "shaderpacks");

            if (!Directory.Exists(shaderDirectory))
                return new List<string>();

            return Directory.GetFiles(shaderDirectory, "*.zip").ToList();
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

        public async Task<List<ShaderInfo>> GetShaderList()
        {
            var files = GetShaderFiles();
            Trace.WriteLine($"Fetching shader list: {_version}, dir: {(_versionSegmented ? Path.Combine(_gameDirectory, "versions", _version, "shaderpacks") : Path.Combine(_gameDirectory, "shaderpacks"))}");
            var sha1List = new List<string>();
            var mHashList = new List<long>();
            var shaderInfos = new List<ShaderInfo>();

            foreach (var file in files)
            {
                Trace.WriteLine($"Fetching shader: {file}");

                var (sha1, cfHash) = ComputeHashesForFile(file);
                sha1List.Add(sha1);
                mHashList.Add(cfHash);

                string fallbackName = Path.GetFileNameWithoutExtension(file);

                shaderInfos.Add(new ShaderInfo
                {
                    FilePath = file,
                    Sha1Hash = sha1,
                    CFHash = cfHash,
                    Name = fallbackName
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

            foreach (var shaderInfo in shaderInfos)
            {
                if (cfDict.TryGetValue(shaderInfo.CFHash, out var cfMeta))
                {
                    if (int.TryParse(cfMeta.ModId, out int modId))
                        shaderInfo.CurseForgeId = modId;
                    shaderInfo.CurseForgeMeta = cfMeta;
                }

                if (mrDict.TryGetValue(shaderInfo.Sha1Hash, out var mrMeta))
                {
                    shaderInfo.ModrinthId = mrMeta.ProjectId ?? "";
                    shaderInfo.ModrinthMeta = mrMeta;
                    if (!string.IsNullOrEmpty(mrMeta.Name))
                        shaderInfo.Name = mrMeta.Name;
                    if (!string.IsNullOrEmpty(mrMeta.VersionNumber))
                        shaderInfo.Version = mrMeta.VersionNumber;
                }
            }

            return shaderInfos;
        }

        public class ShaderInfo
        {
            public string Name { get; set; }
            public string Description { get; set; }
            public string Version { get; set; }
            public string FilePath { get; set; }
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
