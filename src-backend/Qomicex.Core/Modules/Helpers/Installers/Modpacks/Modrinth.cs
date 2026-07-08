using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.IO.Compression;
using System.IO.Pipes;
using System.Text;

namespace Qomicex.Core.Modules.Helpers.Installers.Modpacks
{
    public class Modrinth
    {
        private string _gameDir = string.Empty;
        private bool _versionIsolation;
        private string _modpackFilePath = string.Empty;
        public Modrinth(string gameDir,bool versionIsolation,string modpackFilePath)
        {
            _gameDir = gameDir;
            _versionIsolation = versionIsolation;
            _modpackFilePath = modpackFilePath;
        }

        public Task ReleaseFiles(string versionId)
        {
            var versionDir = _versionIsolation ? Path.Combine(_gameDir,"versions",versionId) : _gameDir;
            if(!Directory.Exists(versionDir))
                Directory.CreateDirectory(versionDir);

            using (ZipArchive archive = ZipFile.OpenRead(_modpackFilePath))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    // 只处理 override 文件夹里的内容
                    if (entry.FullName.StartsWith("override/", StringComparison.OrdinalIgnoreCase))
                    {
                        // 去掉 override/ 前缀
                        string relativePath = entry.FullName.Substring("override/".Length);

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

        public Task<ModrinthModpackInfo> GetModpackInfo(string versionId)
        {
            var info = new ModrinthModpackInfo();
            var jsonData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(_modpackFilePath, "modrinth.index.json"));
            
            var json = JObject.Parse(jsonData);

            if (json["game"]?.ToString() != "minecraft")
            {
                throw new InvalidOperationException("Only Minecraft modpacks are supported.");
            }

            info.Name = json["name"]?.ToString() ?? string.Empty;
            info.Description = json["summary"]?.ToString() ?? string.Empty;
            info.Version = json["versionId"]?.ToString() ?? string.Empty;

            JObject deps = (JObject)json["dependencies"];
            // 遍历所有依赖
            foreach (var prop in deps.Properties())
            {
                string loaderType = prop.Name;
                string loaderVersion = (string)prop.Value;

                if (loaderType == "minecraft")
                    info.GameVersion = loaderVersion;
                else if (loaderType == "quilt-loader" || loaderType == "fabric-loader" || loaderType == "forge")
                {
                    info.ModLoader = loaderType switch
                    {
                        "quilt-loader" => ModLoaderType.Quilt,
                        "fabric-loader" => ModLoaderType.Fabric,
                        "forge" => ModLoaderType.Forge,
                        "neoforge" => ModLoaderType.NeoForge,
                        _ => ModLoaderType.Unknown
                    };
                    info.ModLoaderVersion = loaderVersion;
                }
            }
            
            var filesArray = json["files"] as JArray;
            var basePath = _versionIsolation ? Path.Combine(_gameDir, "versions", versionId) : _gameDir;
            foreach (var file in filesArray)
            {
                string clientEnv = (string?)file["env"]?["client"] ?? "required";
                if (clientEnv != "required")
                    continue;

                var fileInfo = new FileInfo
                {
                    Path = Path.Combine(basePath, file["path"]?.ToString() ?? string.Empty),
                    Hash = file["hashes"]?["sha1"]?.ToString() ?? string.Empty,
                    Url = file["downloads"]?[0]?.ToString() ?? string.Empty,
                    Size = file["fileSize"]?.ToObject<long>() ?? 0
                };
                info.Files.Add(fileInfo);
            }

            return Task.FromResult(info);
        }

        public class ModrinthModpackInfo
        {
            public string Name { get; set; } = string.Empty;
            public string Version { get; set; } = string.Empty;
            public string Description { get; set; } = string.Empty;
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
            /// <summary>
            /// 文件绝对路径
            /// </summary>
            public string Path { get; set; } = string.Empty;
            /// <summary>
            /// SHA-1
            /// </summary>
            public string Hash { get; set; } = string.Empty;
            public string Url { get; set; } = string.Empty;
            public long Size { get; set; } = 0;
        }
    }
}
