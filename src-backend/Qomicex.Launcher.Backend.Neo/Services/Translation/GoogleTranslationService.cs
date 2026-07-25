using System.Text.Json;

namespace Qomicex.Launcher.Backend.Neo.Services.Translation;

public class GoogleTranslationService : ITranslationService
{
    private readonly HttpClient _httpClient;

    public GoogleTranslationService(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public async Task<string?> TranslateAsync(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return null;

        try
        {
            var encodedText = Uri.EscapeDataString(text);
            var url = $"https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q={encodedText}";
            var response = await _httpClient.GetStringAsync(url);
            using var doc = JsonDocument.Parse(response);
            var segments = doc.RootElement[0];
            var result = new System.Text.StringBuilder();
            for (var i = 0; i < segments.GetArrayLength(); i++)
            {
                var segment = segments[i];
                var translated = segment[0].GetString();
                if (!string.IsNullOrEmpty(translated))
                    result.Append(translated);
            }
            return FixMarkdownPunctuation(result.ToString());
        }
        catch
        {
            return null;
        }
    }

    private static string FixMarkdownPunctuation(string text)
    {
        return text
            .Replace('\uff08', '(')
            .Replace('\uff09', ')')
            .Replace('\uff3b', '[')
            .Replace('\uff3d', ']')
            .Replace('\uff5b', '{')
            .Replace('\uff5d', '}')
            .Replace('\uff03', '#')
            .Replace('\uff01', '!')
            .Replace('\uff0a', '*')
            .Replace('\uff40', '`')
            .Replace('\uff1c', '<')
            .Replace('\uff1e', '>')
            .Replace('\uff0f', '/');
    }
}
