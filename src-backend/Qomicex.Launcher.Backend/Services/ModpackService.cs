namespace Qomicex.Launcher.Backend.Services;

public enum ModpackSource { Mrpack, CurseForge, Ftb, Local }
public enum ModpackLoader { Forge, Fabric, NeoForge, Quilt }

public class ModpackFileEntry
{
    public string Path { get; set; } = "";
    public string? DownloadUrl { get; set; }
    public long? Size { get; set; }
}

public class ModpackParseResult
{
    public string Name { get; set; } = "";
    public string? Summary { get; set; }
    public string GameVersion { get; set; } = "";
    public ModpackLoader Loader { get; set; }
    public string? LoaderVersion { get; set; }
    public ModpackSource Source { get; set; }
    public List<ModpackFileEntry> Files { get; set; } = [];
    public bool HasOverrides { get; set; }
}
