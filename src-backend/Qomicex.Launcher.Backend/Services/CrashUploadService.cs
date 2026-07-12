using System.Net.Http.Json;
using System.Text.Json.Nodes;
using QRCoder;
using SkiaSharp;

namespace Qomicex.Launcher.Backend.Services;

public class CrashUploadService
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<CrashUploadService> _logger;

    public CrashUploadService(IHttpClientFactory httpClientFactory, ILogger<CrashUploadService> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public async Task<(string? Url, byte[]? QrCodePng)> UploadCrashLogAsync(string content)
    {
        try
        {
            var client = _httpClientFactory.CreateClient();
            using var form = new FormUrlEncodedContent(new[]
            {
                new KeyValuePair<string, string>("content", content)
            });
            var response = await client.PostAsync("https://api.mclo.gs/1/log", form);
            response.EnsureSuccessStatusCode();
            var json = await response.Content.ReadFromJsonAsync<JsonNode>();
            var url = json?["url"]?.GetValue<string>();
            if (string.IsNullOrEmpty(url)) return (null, null);
            var qrBytes = CreateQrCode(url);
            return (url, qrBytes);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to upload crash log to mclo.gs");
            return (null, null);
        }
    }

    private static byte[] CreateQrCode(string url)
    {
        using var generator = new QRCodeGenerator();
        var qrData = generator.CreateQrCode(url, QRCodeGenerator.ECCLevel.Q);
        var modules = qrData.ModuleMatrix;
        int moduleSize = 20;
        int size = modules.Count * moduleSize;
        using var bitmap = new SKBitmap(size, size);
        using var canvas = new SKCanvas(bitmap);
        canvas.Clear(SKColors.White);
        for (int row = 0; row < modules.Count; row++)
        {
            for (int col = 0; col < modules[row].Count; col++)
            {
                if (modules[row][col])
                {
                    var rect = new SKRect(col * moduleSize, row * moduleSize, (col + 1) * moduleSize, (row + 1) * moduleSize);
                    canvas.DrawRect(rect, new SKPaint { Color = SKColors.Black, Style = SKPaintStyle.Fill });
                }
            }
        }
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }
}
