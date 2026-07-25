using System.Text;

namespace Qomicex.Launcher.Backend.Neo.Services.Translation;

public class BingTranslationService : ITranslationService
{
    private readonly HttpClient _httpClient;
    private readonly string? _apiKey;

    public BingTranslationService(HttpClient httpClient, string? apiKey = null)
    {
        _httpClient = httpClient;
        _apiKey = apiKey;
    }

    public async Task<string?> TranslateAsync(string text)
    {
        if (string.IsNullOrWhiteSpace(text) || string.IsNullOrWhiteSpace(_apiKey))
            return null;

        try
        {
            var escaped = text.Replace("\\", "\\\\").Replace("\"", "\\\"");
            var body = $"[{{\"Text\":\"{escaped}\"}}]";
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            content.Headers.Add("Ocp-Apim-Subscription-Key", _apiKey);
            content.Headers.Add("Ocp-Apim-Subscription-Region", "global");

            var url = "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans";
            var response = await _httpClient.PostAsync(url, content);
            if (!response.IsSuccessStatusCode)
                return null;

            var responseBody = await response.Content.ReadAsStringAsync();
            using var doc = System.Text.Json.JsonDocument.Parse(responseBody);
            var translations = doc.RootElement[0].GetProperty("translations");
            var translated = translations[0].GetProperty("text").GetString();
            return translated;
        }
        catch
        {
            return null;
        }
    }
}
