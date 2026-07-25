namespace Qomicex.Launcher.Backend.Neo.Services.Translation;

public interface ITranslationService
{
    Task<string?> TranslateAsync(string text);
}
