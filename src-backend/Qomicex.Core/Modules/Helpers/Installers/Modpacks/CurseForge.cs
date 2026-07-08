using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.IO.Compression;
using System.Text;

namespace Qomicex.Core.Modules.Helpers.Installers.Modpacks
{
    public class CurseForge
    {
        private string _gameDir = string.Empty;
        private bool _versionIsolation;
        private string _modpackFilePath = string.Empty;
        public CurseForge(string gameDir, bool versionIsolation, string modpackFilePath)
        {
            _gameDir = gameDir;
            _versionIsolation = versionIsolation;
            _modpackFilePath = modpackFilePath;
        }

        public Task ReleaseFiles(string versionId)
        {
            var versionDir = _versionIsolation ? Path.Combine(_gameDir, "versions", versionId) : _gameDir;
            if (!Directory.Exists(versionDir))
                Directory.CreateDirectory(versionDir);

            var jsonData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(_modpackFilePath, "manifest.json"));

            var json = JObject.Parse(jsonData);

            if (json["manifestType"]?.ToString() != "minecraftModpack")
            {
                throw new InvalidOperationException("Only Minecraft modpacks are supported.");
            }

            var overrideName = json["overrides"]?.ToString() ?? string.Empty;

            using (ZipArchive archive = ZipFile.OpenRead(_modpackFilePath))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    // 只处理 override 文件夹里的内容
                    if (entry.FullName.StartsWith($"{overrideName}/", StringComparison.OrdinalIgnoreCase))
                    {
                        // 去掉 override/ 前缀
                        string relativePath = entry.FullName.Substring($"{overrideName}/".Length);

                        // 拼接到目标目录
                        string destinationPath = Path.Combine(versionDir, relativePath);

                        // 如果是目录就创建
                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(destinationPath);
                        }
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
                            entry.ExtractToFile(destinationPath, overwrite: true);
                        }
                    }
                }
            }

            return Task.CompletedTask;
        }

        public Task<CurseForgeModpackInfo> GetModpackInfo()
        {
            var info = new CurseForgeModpackInfo();
            var jsonData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(_modpackFilePath, "manifest.json"));

            var json = JObject.Parse(jsonData);

            if (json["manifestType"]?.ToString() != "minecraftModpack")
            {
                throw new InvalidOperationException("Only Minecraft modpacks are supported.");
            }

            info.Name = json["name"]?.ToString() ?? string.Empty;
            info.Version = json["version"]?.ToString() ?? string.Empty;

            info.GameVersion = json["minecraft"]?["version"]?.ToString() ?? string.Empty;
            JArray loaders = (JArray)json["minecraft"]?["modLoaders"];

            var loaderType = string.Empty;

            foreach (var loader in loaders)
            {
                if (loader["primary"]?.ToObject<bool>() == true)
                {
                    loaderType = loader["id"]?.ToString()?.Split('-')?[0] ?? string.Empty;
                    info.ModLoaderVersion = loader["id"]?.ToString()?.Split('-')?[1] ?? string.Empty;
                    break;
                }
            }
            info.ModLoader = loaderType switch
            {
                "quilt" => ModLoaderType.Quilt,
                "fabric" => ModLoaderType.Fabric,
                "forge" => ModLoaderType.Forge,
                "neoforge" => ModLoaderType.NeoForge,
                _ => ModLoaderType.Unknown
            };

            var filesArray = json["files"] as JArray;
            foreach (var file in filesArray)
            {
                if (file["required"]?.ToObject<bool>() != true)
                    continue;

                var fileInfo = new FileInfo
                {
                    ProjectId = file["projectID"]?.ToObject<int>() ?? 0,
                    FileId = file["fileID"]?.ToObject<int>() ?? 0,
                };
                info.Files.Add(fileInfo);
            }

            return Task.FromResult(info);
        }

        public class CurseForgeModpackInfo
        {
            public string Name { get; set; } = string.Empty;
            public string Version { get; set; } = string.Empty;
            public string GameVersion { get; set; } = string.Empty;
            public ModLoaderType ModLoader { get; set; }
            public string ModLoaderVersion { get; set; } = string.Empty;
            public List<FileInfo> Files { get; set; } = new List<FileInfo>();
        }

        public enum ModLoaderType
        {
            Forge,
            Fabric,
            Quilt,
            NeoForge,
            Unknown
        }
        public class FileInfo
        {
            public int ProjectId { get; set; }
            public int FileId { get; set; }
        }
    }
}
