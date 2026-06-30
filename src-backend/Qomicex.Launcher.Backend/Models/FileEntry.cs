namespace Qomicex.Launcher.Backend.Models;

public class FileEntry
{
    public string Name { get; set; } = string.Empty;
    public long Size { get; set; }
    public DateTime LastModified { get; set; }
    public DateTime? Created { get; set; }
    public bool IsDirectory { get; set; }
    public string Extension { get; set; } = string.Empty;
}

public class ServerEntry
{
    public string Name { get; set; } = string.Empty;
    public string Ip { get; set; } = string.Empty;
    public string? IconBase64 { get; set; }
    public bool AcceptTextures { get; set; }
}

public class ServerStateResult
{
    public string Name { get; set; } = string.Empty;
    public string Address { get; set; } = string.Empty;
    public bool IsOnline { get; set; }
    public long Ping { get; set; }
    public int OnlinePlayers { get; set; }
    public int MaxPlayers { get; set; }
    public string Version { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string ErrorMessage { get; set; } = string.Empty;
}

public class CopySaveRequest
{
    public string Name { get; set; } = string.Empty;
    public string NewName { get; set; } = string.Empty;
}

public class InstallModRequest
{
    public string DownloadUrl { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
}

public class AddServerRequest
{
    public string Name { get; set; } = string.Empty;
    public string Ip { get; set; } = string.Empty;
}

public class ModMetadataDto
{
    public string FileName { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Version { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string[] Authors { get; set; } = [];
    public string? IconUrl { get; set; }
    public int? CurseForgeId { get; set; }
    public string? ModrinthId { get; set; }
    public string? Source { get; set; }
    public int? McmodId { get; set; }
    public string? ChineseName { get; set; }
    public bool Active { get; set; }
}

public class ChangeModVersionRequest
{
    public string FileName { get; set; } = string.Empty;
    public string DownloadUrl { get; set; } = string.Empty;
    public string NewFileName { get; set; } = string.Empty;
}
