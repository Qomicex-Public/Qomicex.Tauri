using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace Qomicex.Core.Modules.Helpers.GameSettings
{
    public class OptionsHelper
    {
        private const string DefaultDescription = "(无描述)";
        private const string FallbackLanguage = "en-US";
        private static readonly Regex RangePattern = new(@"^\s*-?\d+(?:\.\d+)?\s*[-–]\s*-?\d+(?:\.\d+)?\s*$", RegexOptions.Compiled);

        private readonly List<GameVersion> _versions;
        private readonly string _gameDirectory;
        private readonly string _version;
        private readonly bool _versionSpecific;

        private readonly List<MinecraftOption> _options;
        private readonly Dictionary<string, Dictionary<string, string>> _descriptions;

        public OptionsHelper(string optionsJsonPath, string descriptionsJsonPath, string minecraftManifest, string gameDirectory, string gameVersion, bool versionSpecific)
        {
            _gameDirectory = gameDirectory;
            _version = gameVersion;
            _versionSpecific = versionSpecific;

            var optionsJson = File.ReadAllText(optionsJsonPath);
            _options = JsonConvert.DeserializeObject<List<MinecraftOption>>(optionsJson) ?? new List<MinecraftOption>();

            var descJson = File.ReadAllText(descriptionsJsonPath);
            _descriptions = JsonConvert.DeserializeObject<Dictionary<string, Dictionary<string, string>>>(descJson)
                ?? new Dictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase);

            var manifest = JObject.Parse(minecraftManifest);
            var versions = manifest["versions"] as JArray;
            _versions = new List<GameVersion>();
            if (versions != null)
            {
                foreach (var version in versions)
                {
                    var id = version?["id"]?.ToString() ?? string.Empty;
                    var type = version?["type"]?.ToString() ?? string.Empty;
                    var releaseTimeStr = version?["releaseTime"]?.ToString();

                    DateTime releaseTime = DateTime.MinValue;
                    if (!string.IsNullOrEmpty(releaseTimeStr))
                    {
                        DateTime.TryParse(releaseTimeStr, out releaseTime);
                    }

                    _versions.Add(new GameVersion
                    {
                        Version = id,
                        ReleaseType = type,
                        ReleaseDate = releaseTime
                    });
                }
            }
        }

        public List<OptionDefinition> GetDefinitions()
        {
            return _options.Select(ToDefinition).ToList();
        }

        public OptionDefinition? GetDefinition(string name)
        {
            var option = FindOption(name);
            return option == null ? null : ToDefinition(option);
        }

        public string GetDescription(string name, string language)
        {
            if (_descriptions.TryGetValue(language, out var languageDescriptions)
                && languageDescriptions.TryGetValue(name, out var description)
                && !string.IsNullOrWhiteSpace(description))
            {
                return description;
            }

            if (_descriptions.TryGetValue(FallbackLanguage, out var fallbackDescriptions)
                && fallbackDescriptions.TryGetValue(name, out var fallbackDescription)
                && !string.IsNullOrWhiteSpace(fallbackDescription))
            {
                return fallbackDescription;
            }

            return DefaultDescription;
        }

        public string GetCurrentValue(string name)
        {
            var config = Load();
            return config.TryGetValue(name, out var value) ? value : string.Empty;
        }

        public List<GameOption> GetCurrentOptions()
        {
            return Load().Select(kv => new GameOption
            {
                OptionName = kv.Key,
                OptionValue = kv.Value
            }).ToList();
        }

        public List<OptionViewItem> GetOptionViewItems(string language)
        {
            var config = Load();

            return _options.Select(option =>
            {
                var definition = ToDefinition(option, config, language);
                return new OptionViewItem
                {
                    Name = definition.Name,
                    DefaultValue = definition.DefaultValue,
                    CurrentValue = definition.CurrentValue,
                    Description = definition.Description,
                    ValidValuesRaw = definition.ValidValuesRaw,
                    IntroducedVersion = definition.IntroducedVersion,
                    IsAvailableInCurrentVersion = definition.IsAvailableInCurrentVersion,
                    ValueKind = definition.ValueKind
                };
            }).ToList();
        }

        public void SetOption(string name, string value)
        {
            if (!IsOptionAvailableInVersion(name))
            {
                throw new InvalidOperationException($"Option '{name}' is not available in version '{_version}'.");
            }

            var config = Load();
            config[name] = value;
            Save(config);
        }

        public List<MinecraftOption> GetOptions()
        {
            return _options.Where(option => IsOptionAvailableInVersion(option.Name)).ToList();
        }

        public string GetDescription(string name)
        {
            return GetDescription(name, FallbackLanguage);
        }

        public void SetOption(GameOption option)
        {
            SetOption(option.OptionName, option.OptionValue);
        }

        public string GetOption(string optionName)
        {
            return GetCurrentValue(optionName);
        }

        public List<GameOption> GetAllOptions()
        {
            return Load().Select(kv => new GameOption
            {
                OptionName = kv.Key,
                OptionValue = kv.Value
            }).ToList();
        }

        private MinecraftOption? FindOption(string name)
        {
            return _options.FirstOrDefault(option => string.Equals(option.Name, name, StringComparison.Ordinal));
        }

        private OptionDefinition ToDefinition(MinecraftOption option)
        {
            return ToDefinition(option, Load(), FallbackLanguage);
        }

        private OptionDefinition ToDefinition(MinecraftOption option, IReadOnlyDictionary<string, string> config)
        {
            return ToDefinition(option, config, FallbackLanguage);
        }

        private OptionDefinition ToDefinition(MinecraftOption option, IReadOnlyDictionary<string, string> config, string language)
        {
            var currentValue = config.TryGetValue(option.Name, out var value) ? value : option.DefaultValue;

            return new OptionDefinition
            {
                Name = option.Name,
                DefaultValue = option.DefaultValue,
                CurrentValue = currentValue,
                Description = GetDescription(option.Name, language),
                ValidValuesRaw = option.ValidValues,
                IntroducedVersion = option.IntroducedVersion,
                IsAvailableInCurrentVersion = IsOptionAvailableInVersion(option.Name),
                ValueKind = InferValueKind(option.ValidValues)
            };
        }

        private bool IsOptionAvailableInVersion(string optionName)
        {
            var option = FindOption(optionName);
            if (option == null || string.IsNullOrWhiteSpace(option.IntroducedVersion))
            {
                return option != null;
            }

            var introducedVersion = _versions.FirstOrDefault(version => string.Equals(version.Version, option.IntroducedVersion, StringComparison.Ordinal));
            var currentVersion = _versions.FirstOrDefault(version => string.Equals(version.Version, _version, StringComparison.Ordinal));

            if (introducedVersion.Version == null || currentVersion.Version == null)
            {
                return true;
            }

            return currentVersion.ReleaseDate >= introducedVersion.ReleaseDate;
        }

        private string InferValueKind(string validValues)
        {
            if (string.Equals(validValues, "true,false", StringComparison.OrdinalIgnoreCase)
                || string.Equals(validValues, "false,true", StringComparison.OrdinalIgnoreCase))
            {
                return "Boolean";
            }

            if (RangePattern.IsMatch(validValues))
            {
                return "Range";
            }

            if (validValues.Contains(',', StringComparison.Ordinal))
            {
                return "Enum";
            }

            return "Text";
        }

        private string GetOptionFilePath()
        {
            if (_versionSpecific)
            {
                return Path.Combine(_gameDirectory, "versions", _version, "options.txt");
            }

            return Path.Combine(_gameDirectory, "options.txt");
        }

        private void Save(IReadOnlyDictionary<string, string> config)
        {
            using var writer = new StreamWriter(GetOptionFilePath());
            foreach (var kv in config)
            {
                writer.WriteLine($"{kv.Key}={kv.Value}");
            }
        }

        private Dictionary<string, string> Load()
        {
            var dict = new Dictionary<string, string>(StringComparer.Ordinal);
            var optionFilePath = GetOptionFilePath();
            if (!File.Exists(optionFilePath))
            {
                return dict;
            }

            foreach (var line in File.ReadAllLines(optionFilePath))
            {
                if (string.IsNullOrWhiteSpace(line) || line.StartsWith("#", StringComparison.Ordinal))
                {
                    continue;
                }

                var parts = line.Split('=', 2);
                if (parts.Length == 2)
                {
                    dict[parts[0].Trim()] = parts[1].Trim();
                }
            }

            return dict;
        }

        private struct GameVersion
        {
            public string Version;
            public string ReleaseType;
            public DateTime ReleaseDate;
        }

        public struct GameOption
        {
            public string OptionName;
            public string OptionValue;
        }

        public class MinecraftOption
        {
            [JsonProperty("name")]
            public string Name { get; set; } = "";

            [JsonProperty("defaultValue")]
            public string DefaultValue { get; set; } = "";

            [JsonProperty("validValues")]
            public string ValidValues { get; set; } = "";

            [JsonProperty("introducedVersion")]
            public string IntroducedVersion { get; set; } = "";

            [JsonProperty("introducedVersionRaw")]
            public string IntroducedVersionRaw { get; set; } = "";

            [JsonProperty("category")]
            public string Category { get; set; } = "";
        }

        public class OptionDefinition
        {
            public string Name { get; set; } = "";
            public string DefaultValue { get; set; } = "";
            public string CurrentValue { get; set; } = "";
            public string Description { get; set; } = DefaultDescription;
            public string ValidValuesRaw { get; set; } = "";
            public string IntroducedVersion { get; set; } = "";
            public bool IsAvailableInCurrentVersion { get; set; }
            public string ValueKind { get; set; } = "Text";
        }

        public class OptionViewItem : OptionDefinition
        {
        }
    }
}
