namespace Qomicex.Launcher.Backend.Neo.Models;

public sealed class ModLoadProgress
{
    public int Current { get; set; }
    public int Total { get; set; }
    public ModLoadProgress(int current, int total) { Current = current; Total = total; }
}

public sealed class FileEntryDto
{
    public string Name { get; set; } = "";
    public long Size { get; set; }
    public DateTime LastModified { get; set; }
    public DateTime? Created { get; set; }
    public bool IsDirectory { get; set; }
    public string Extension { get; set; } = "";
}

public sealed class ModMetadataDto
{
    public string FileName { get; set; } = "";
    public string Name { get; set; } = "";
    public string Version { get; set; } = "";
    public string Description { get; set; } = "";
    public string[] Authors { get; set; } = [];
    public string? IconUrl { get; set; }
    public string? IconBase64 { get; set; }
    public int? CurseForgeId { get; set; }
    public string? ModrinthId { get; set; }
    public string? Source { get; set; }
    public int? McmodId { get; set; }
    public string? ChineseName { get; set; }
    public bool Active { get; set; }
}

public sealed class ResourcePackMetadataDto
{
    public string FileName { get; set; } = "";
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public string Version { get; set; } = "";
    public int PackFormat { get; set; }
    public string? IconBase64 { get; set; }
    public int? CurseForgeId { get; set; }
    public string? ModrinthId { get; set; }
    public string? Source { get; set; }
}

public sealed class ShaderMetadataDto
{
    public string FileName { get; set; } = "";
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public string Version { get; set; } = "";
    public string? IconBase64 { get; set; }
    public int? CurseForgeId { get; set; }
    public string? ModrinthId { get; set; }
    public string? Source { get; set; }
}

public sealed class DataPackMetadataDto
{
    public string FileName { get; set; } = "";
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public string Version { get; set; } = "";
    public int PackFormat { get; set; }
    public string? IconBase64 { get; set; }
    public int? CurseForgeId { get; set; }
    public string? ModrinthId { get; set; }
    public string? Source { get; set; }
}

public sealed class ScreenshotMetadataDto
{
    public string FileName { get; set; } = "";
    public string FilePath { get; set; } = "";
    public DateTime CreatedAt { get; set; }
    public long FileSize { get; set; }
}

public sealed class SaveMetadataDto
{
    public string Name { get; set; } = "";
    public string FilePath { get; set; } = "";
    public long LastPlayed { get; set; }
    public string? IconBase64 { get; set; }
}

public sealed class OldServerEntryDto
{
    public string Name { get; set; } = "";
    public string Ip { get; set; } = "";
    public string? IconBase64 { get; set; }
    public bool AcceptTextures { get; set; }
}

public sealed class ServerStateResultDto
{
    public string Name { get; set; } = "";
    public string Address { get; set; } = "";
    public bool IsOnline { get; set; }
    public long Ping { get; set; }
    public int OnlinePlayers { get; set; }
    public int MaxPlayers { get; set; }
    public string Version { get; set; } = "";
    public string Description { get; set; } = "";
    public string ErrorMessage { get; set; } = "";
    public string? IconBase64 { get; set; }
}

public sealed class AddServerRequest
{
    public string Name { get; set; } = "";
    public string Ip { get; set; } = "";
}

public sealed class SaveCopyRequestDto
{
    public string Name { get; set; } = "";
    public string NewName { get; set; } = "";
}

public sealed class SaveRenameRequestDto
{
    public string OldName { get; set; } = "";
    public string NewName { get; set; } = "";
}

public sealed class FileOperationRequest
{
    public string Path { get; set; } = "";
}

public sealed class BatchFileRequest
{
    public string[] Paths { get; set; } = [];
}

public sealed class SetOptionRequest
{
    public string Value { get; set; } = "";
}
