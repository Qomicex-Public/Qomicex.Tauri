namespace Qomicex.Launcher.Backend.Models;

public class GameSettingDto
{
    public string Name { get; set; } = "";
    public string DefaultValue { get; set; } = "";
    public string CurrentValue { get; set; } = "";
    public string Description { get; set; } = "";
    public string ValidValues { get; set; } = "";
    public string IntroducedVersion { get; set; } = "";
    public bool IsAvailableInCurrentVersion { get; set; }
    public string ValueKind { get; set; } = "Text";
}
