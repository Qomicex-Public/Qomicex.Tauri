using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Qomicex.Core.Modules.Helpers.Resources.Expansion.CurseForge;
using Qomicex.Core.Modules.Helpers.Resources.Expansion.Modrinth;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Tomlyn;
using Tomlyn.Model;

namespace Qomicex.Core.Modules.Helpers.Resources.Expansion.Local
{
    public class Mods : LocalResourceBase
    {
        private readonly string _gameDirectory;
        private readonly string _version;
        private readonly bool _versionSegmented;
        private readonly string _apiKey;

        private static readonly HttpClient _httpClient = new();

        public Mods(string gameDirectory, string version, bool versionSegmented, string apiKey)
        {
            _gameDirectory = gameDirectory;
            _version = version;
            _versionSegmented = versionSegmented;
            _apiKey = apiKey;
        }

        private List<string> GetModFiles()
        {
            string modDirectory = _versionSegmented
                ? Path.Combine(_gameDirectory, "versions", _version, "mods")
                : Path.Combine(_gameDirectory, "mods");

            if (!Directory.Exists(modDirectory))
                return new List<string>();

            var files = new List<string>();
            files.AddRange(Directory.GetFiles(modDirectory, "*.jar"));
            files.AddRange(Directory.GetFiles(modDirectory, "*.disabled"));
            return files;
        }

        private static string[] ExtractFabricAuthors(JToken authorsToken)
        {
            if (authorsToken == null)
                return Array.Empty<string>();

            return authorsToken.Select(a =>
            {
                if (a is JObject obj && obj["name"] != null)
                    return obj["name"].ToString();
                return a.ToString();
            }).ToArray();
        }

        private static string? ReadZipEntry(ZipArchive archive, string entryPath)
        {
            var entry = archive.GetEntry(entryPath);
            if (entry == null) return null;
            using var reader = new StreamReader(entry.Open());
            return reader.ReadToEnd();
        }

        private static string ExtractIconFromArchive(ZipArchive archive, string iconPath)
        {
            var entry = archive.GetEntry(iconPath);
            if (entry == null) return string.Empty;
            using var stream = entry.Open();
            using var ms = new MemoryStream();
            stream.CopyTo(ms);
            return ms.Length > 0 ? Convert.ToBase64String(ms.ToArray()) : string.Empty;
        }

        public async Task<List<ModInfo>> GetModList(Action<int, int>? onProgress = null)
        {
            var modFiles = GetModFiles();
            Trace.WriteLine($"Fetching mod list: {_version}, dir: {(_versionSegmented ? Path.Combine(_gameDirectory, "versions", _version, "mods") : Path.Combine(_gameDirectory, "mods"))}, count: {modFiles.Count}");
            foreach (var f in modFiles) Trace.WriteLine($"  mod file: {f}");
            var hashBag = new ConcurrentBag<(string hash, long cfHash)>();
            var modBag = new ConcurrentBag<ModInfo>();
            int processedCount = 0;
            var totalCount = modFiles.Count;

            onProgress?.Invoke(0, totalCount);
            Parallel.ForEach(modFiles, mod =>
            {
                byte[] fileBytes = File.ReadAllBytes(mod);
                string hash;
                using (SHA1 sha1 = SHA1.Create())
                    hash = BitConverter.ToString(sha1.ComputeHash(fileBytes)).Replace("-", "").ToLowerInvariant();
                long cfHash = MurmurHash2(fileBytes);

                ModInfo modInfo = new ModInfo
                {
                    FilePath = mod,
                    Sha1Hash = hash,
                    CFHash = cfHash,
                };

                try
                {
                    using var archive = new ZipArchive(new MemoryStream(fileBytes), ZipArchiveMode.Read);

                    string fabricContent = ReadZipEntry(archive, "fabric.mod.json");
                    if (fabricContent != null)
                    {
                        JObject json = JObject.Parse(fabricContent);
                        modInfo.Name = json["name"]?.ToString() ?? "Unknown";
                        modInfo.Version = json["version"]?.ToString() ?? "";
                        modInfo.Description = json["description"]?.ToString() ?? "No description available";
                        modInfo.Authors = ExtractFabricAuthors(json["authors"]);

                        var iconPath = json["icon"]?.ToString();
                        if (!string.IsNullOrEmpty(iconPath))
                            modInfo.Icon = ExtractIconFromArchive(archive, iconPath);
                    }
                    else
                    {
                        string tomlContent = ReadZipEntry(archive, "META-INF/mods.toml");
                        if (tomlContent != null)
                        {
                            var model = Toml.ToModel(tomlContent);
                            var mods = (TomlTableArray)model["mods"];
                            var firstMod = (TomlTable)mods[0];
                            modInfo.Name = firstMod.TryGetValue("displayName", out var dn) ? dn?.ToString() ?? "Unknown" : "Unknown";
                            modInfo.Description = firstMod.TryGetValue("description", out var desc) ? desc?.ToString() ?? "" : "";
                            modInfo.Version = firstMod.TryGetValue("version", out var ver) ? ver?.ToString() ?? "" : "";
                            if (firstMod.TryGetValue("authors", out var aut) && aut is string autStr)
                                modInfo.Authors = autStr.Split(',').Select(a => a.Trim()).ToArray();

                            if (firstMod.TryGetValue("logoFile", out var lf) && lf is string logoFile && !string.IsNullOrEmpty(logoFile))
                                modInfo.Icon = ExtractIconFromArchive(archive, logoFile);
                        }
                        else
                        {
                            string mcmodContent = ReadZipEntry(archive, "mcmod.info");
                            if (mcmodContent != null)
                            {
                                var mcmodArray = JArray.Parse(mcmodContent);
                                if (mcmodArray.Count > 0)
                                {
                                    var firstEntry = (JObject)mcmodArray[0];
                                    modInfo.Name = firstEntry["name"]?.ToString() ?? "Unknown";
                                    modInfo.Description = firstEntry["description"]?.ToString() ?? "";
                                    modInfo.Version = firstEntry["version"]?.ToString() ?? "";
                                    if (firstEntry["authors"] is JArray authorsArray)
                                        modInfo.Authors = authorsArray.Select(a => a.ToString()).ToArray();
                                    else if (firstEntry["authors"]?.Type == JTokenType.String)
                                        modInfo.Authors = firstEntry["authors"]!.ToString().Split(',').Select(a => a.Trim()).ToArray();
                                }
                            }
                        }
                    }
                }
                catch { }

                if (string.IsNullOrEmpty(modInfo.Name))
                    modInfo.Name = Path.GetFileNameWithoutExtension(mod);

                hashBag.Add((hash, cfHash));
                modBag.Add(modInfo);

                var current = Interlocked.Increment(ref processedCount);
                onProgress?.Invoke(current, totalCount);
            });

            var hashList = hashBag.Select(x => x.hash).ToList();
            var mHashList = hashBag.Select(x => x.cfHash).ToList();
            var modInfos = modBag.ToList();

            var cfDict = new Dictionary<long, CurseForgeBase.FingerprintsFilesMeta>();
            var mrDict = new Dictionary<string, ModrinthBase.ProjectVersionInfo>();

            if (hashList.Count > 0)
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
                    mrDict = await mr.GetProjectVersionsFromHashesDictAsync(hashList);
                }
                catch { }
            }

            foreach (var modInfo in modInfos)
            {
                if (cfDict.TryGetValue(modInfo.CFHash, out var cfMeta))
                {
                    modInfo.CurseForgeId = Convert.ToInt32(cfMeta.ModId);
                    modInfo.CurseForgeMeta = cfMeta;
                }

                if (mrDict.TryGetValue(modInfo.Sha1Hash, out var mrMeta))
                {
                    modInfo.ModrinthId = mrMeta.ProjectId ?? "";
                    modInfo.ModrinthMeta = mrMeta;
                }
            }

            // Parallel icon downloads
            var iconTasks = modInfos
                .Where(m => string.IsNullOrEmpty(m.Icon))
                .Select(async modInfo =>
                {
                    try
                    {
                        if (!string.IsNullOrEmpty(modInfo.ModrinthId))
                        {
                            var mr = new Modrinth.Mods();
                            var project = await mr.GetProjectInfoAsync(modInfo.ModrinthId);
                            if (!string.IsNullOrEmpty(project?.IconUrl))
                            {
                                modInfo.Icon = await DownloadIconAsBase64(project.IconUrl);
                                return;
                            }
                        }
                    }
                    catch { }

                    try
                    {
                        if (modInfo.CurseForgeId > 0)
                        {
                            var cf = new CurseForge.Mods(_apiKey);
                            var info = await cf.GetModInfoAsync(modInfo.CurseForgeId.ToString());
                            if (!string.IsNullOrEmpty(info?.IconUrl))
                            {
                                modInfo.Icon = await DownloadIconAsBase64(info.IconUrl);
                            }
                        }
                    }
                    catch { }
                });

            await Task.WhenAll(iconTasks);

            Trace.WriteLine($"Returning {modInfos.Count} mods");
            return modInfos;
        }

        private static async Task<string> DownloadIconAsBase64(string url)
        {
            var bytes = await _httpClient.GetByteArrayAsync(url);
            if (bytes == null || bytes.Length == 0)
                return string.Empty;

            return Convert.ToBase64String(bytes);
        }

        public void DisableMod(string modFilePath)
        {
            if (File.Exists(modFilePath))
            {
                string newFilePath = modFilePath + ".disabled";
                File.Move(modFilePath, newFilePath);
            }
        }

        public void EnableMod(string modFilePath)
        {
            if (File.Exists(modFilePath) && modFilePath.EndsWith(".disabled", StringComparison.OrdinalIgnoreCase))
            {
                string newFilePath = modFilePath.Substring(0, modFilePath.Length - ".disabled".Length);
                File.Move(modFilePath, newFilePath);
            }
        }



        public class ModInfo
        {
            public string Name { get; set; }
            public string Description { get; set; }
            public string Version { get; set; }
            public string[] Authors { get; set; }
            public string FilePath { get; set; }
            /// <summary>
            /// Mod图标的Base64编码字符串，如果没有图标则为空字符串
            /// </summary>
            public string Icon { get; set; }
            public int CurseForgeId { get; set; }
            public string ModrinthId { get; set; }
            public bool Active { get { return Path.GetExtension(FilePath).Equals(".jar", StringComparison.OrdinalIgnoreCase);} }
            public string Sha1Hash { get; set; }
            public long CFHash { get; set; }
            public CurseForgeBase.FingerprintsFilesMeta CurseForgeMeta { get; set; }
            public ModrinthBase.ProjectVersionInfo ModrinthMeta { get; set; }
        }
    }
}
