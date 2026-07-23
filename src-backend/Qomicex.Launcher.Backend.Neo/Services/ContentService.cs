using System.Reflection;
using System.Text.Json;
using Qomicex.Core.AOT.Core;
using Qomicex.Core.AOT.Models.VersionManifest;
using Qomicex.Core.AOT.Public.Services;
using Qomicex.Core.AOT.Services.Expansion.Local;
using Qomicex.Core.AOT.Services.Options;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Services;

public sealed class ContentService
{
    private readonly DefaultGameCore _core;
    private readonly string _apiKey;
    private readonly string _optionsJson;
    private readonly string _descriptionsJson;

    public ContentService(DefaultGameCore core, string apiKey)
    {
        _core = core;
        _apiKey = apiKey;
        _optionsJson = ReadEmbeddedResource("Qomicex.Launcher.Backend.Neo.Resources.GameSettings.options.json");
        _descriptionsJson = ReadEmbeddedResource("Qomicex.Launcher.Backend.Neo.Resources.GameSettings.descriptions.json");
    }

    public async Task<IOptionsProvider> CreateOptionsAsync(string gameDir, string version, bool versionSpecific)
    {
        var optDir = Path.Combine(Path.GetTempPath(), "qomicex-neo-options");
        Directory.CreateDirectory(optDir);

        var optionsPath = Path.Combine(optDir, "options.json");
        var descPath = Path.Combine(optDir, "descriptions.json");

        if (!File.Exists(optionsPath))
            await File.WriteAllTextAsync(optionsPath, _optionsJson);
        if (!File.Exists(descPath))
            await File.WriteAllTextAsync(descPath, _descriptionsJson);

        var manifest = await _core.Version.GetManifestAsync();
        var manifestJson = JsonSerializer.Serialize(manifest, ApiJsonContext.Default.VersionManifestRoot);

        return new OptionsProvider(optionsPath, descPath, manifestJson, gameDir, version, versionSpecific);
    }

    public IServerManager CreateServerManager(string gameDir, string version, bool versionSpecific)
        => new ServerManager(gameDir, version, versionSpecific);

    public Mods CreateMods(string version, bool versionSegmented)
        => _core.LocalResourceProvider.CreateMods(version, versionSegmented, _apiKey);

    public Saves CreateSaves(string version, bool versionSegmented)
        => _core.LocalResourceProvider.CreateSaves(version, versionSegmented, _apiKey);

    public Resourcepack CreateResourcepack(string version, bool versionSegmented)
        => _core.LocalResourceProvider.CreateResourcepack(version, versionSegmented, _apiKey);

    public Shaders CreateShaders(string version, bool versionSegmented)
        => _core.LocalResourceProvider.CreateShaders(version, versionSegmented, _apiKey);

    public Screenshots CreateScreenshots(string version, bool versionSegmented)
        => _core.LocalResourceProvider.CreateScreenshots(version, versionSegmented, _apiKey);

    public DataPacks CreateDataPacks(string version, bool versionSegmented)
        => _core.LocalResourceProvider.CreateDataPacks(version, versionSegmented, _apiKey);

    private static string ReadEmbeddedResource(string name)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        if (stream is null)
            throw new FileNotFoundException($"Embedded resource not found: {name}");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
