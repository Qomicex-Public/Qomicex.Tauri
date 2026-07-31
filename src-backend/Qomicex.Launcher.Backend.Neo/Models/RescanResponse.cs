using System.Text.Json.Serialization;

namespace Qomicex.Launcher.Backend.Neo.Models;

public class RescanResponse
{
    [JsonPropertyName("scanned")]
    public int Scanned { get; set; }
}
