using System.Text.Json.Serialization;

namespace Qomicex.Launcher.Backend.Neo.Models;

public class InstallRequest
{
    [JsonPropertyName("sourceDir")]
    public string SourceDir { get; set; } = "";
}
