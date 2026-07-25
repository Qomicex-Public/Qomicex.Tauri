using System.Text;
using System.Text.Json;

namespace Qomicex.Launcher.Backend.Neo.Services.Translation;

public class MyMemoryTranslationService : ITranslationService
{
    private readonly HttpClient _httpClient;
    private const int MaxChunkLength = 480;

    public MyMemoryTranslationService(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public async Task<string?> TranslateAsync(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return null;

        if (text.Length <= MaxChunkLength)
            return await TranslateChunkAsync(text);

        var chunks = SplitText(text, MaxChunkLength);
        var results = new List<string>(chunks.Length);
        for (var i = 0; i < chunks.Length; i++)
        {
            if (i > 0)
                await Task.Delay(1000);
            var translated = await TranslateChunkAsync(chunks[i]);
            if (translated != null)
                results.Add(translated);
        }
        return results.Count > 0 ? string.Join("\n\n", results) : null;
    }

    private async Task<string?> TranslateChunkAsync(string text)
    {
        try
        {
            var encodedText = Uri.EscapeDataString(text);
            var url = $"https://api.mymemory.translated.net/get?q={encodedText}&langpair=en|zh-CN";
            var response = await _httpClient.GetStringAsync(url);
            using var doc = JsonDocument.Parse(response);
            var responseData = doc.RootElement.GetProperty("responseData");
            var translated = responseData.GetProperty("translatedText").GetString();
            return translated;
        }
        catch
        {
            return null;
        }
    }

    private static string[] SplitText(string text, int maxLength)
    {
        var chunks = new List<string>();
        var sb = new StringBuilder();
        var sentences = text.Split(['.', '!', '?', '\n'], StringSplitOptions.None);

        foreach (var sentence in sentences)
        {
            var trimmed = sentence.Trim();
            if (trimmed.Length == 0) continue;

            if (sb.Length + trimmed.Length > maxLength && sb.Length > 0)
            {
                chunks.Add(sb.ToString().Trim());
                sb.Clear();
            }

            if (sb.Length > 0) sb.Append(' ');
            sb.Append(trimmed);
        }

        if (sb.Length > 0)
            chunks.Add(sb.ToString().Trim());

        return chunks.ToArray();
    }
}
