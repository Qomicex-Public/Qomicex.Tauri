namespace Qomicex.Launcher.Backend.Neo.Models;

/// <summary>
/// 统一的附加文件下载项模型，用于 mods、configs 等额外文件的批量下载。
/// </summary>
/// <param name="Source">来源标识：modrinth / url / curseforge</param>
/// <param name="Identifier">标识符：modrinth slug、直接 URL、或 curseforge projectId</param>
/// <param name="RelativePath">相对于 GameDir 的保存路径，如 "mods/xxx.jar" 或 "config/xxx.toml"</param>
/// <param name="Sha1">可选 SHA1 校验值</param>
/// <param name="Size">可选文件大小（字节）</param>
public sealed record AdditionalFile(
    string Source,
    string Identifier,
    string RelativePath,
    string? Sha1 = null,
    long? Size = null
);
