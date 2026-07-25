using System.Text.RegularExpressions;

namespace Qomicex.Launcher.Backend.Neo.Services.Translation;

public static partial class TextProtector
{
    [GeneratedRegex(@"<!--.*?-->", RegexOptions.Singleline)]
    private static partial Regex HtmlCommentRegex();

    [GeneratedRegex(@"</?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?/?>")]
    private static partial Regex HtmlTagRegex();

    [GeneratedRegex(@"!\[([^\]]*)\]\(([^)]+)\)")]
    private static partial Regex ImageRegex();

    [GeneratedRegex(@"(?<!!)\[([^\]]*)\]\(([^)]+)\)")]
    private static partial Regex LinkRegex();

    [GeneratedRegex(@"https?://[^\s)]+")]
    private static partial Regex BareUrlRegex();

    [GeneratedRegex(@"  \n")]
    private static partial Regex SoftBreakRegex();

    public static (string text, Dictionary<string, string> map) Protect(string text)
    {
        var map = new Dictionary<string, string>();
        var index = 0;

        text = HtmlCommentRegex().Replace(text, match =>
        {
            var key = $"ZMCOM{index:D4}";
            map[key] = match.Value;
            index++;
            return key;
        });

        text = HtmlTagRegex().Replace(text, match =>
        {
            var key = $"ZMTAG{index:D4}";
            map[key] = match.Value;
            index++;
            return key;
        });

        text = ImageRegex().Replace(text, match =>
        {
            var key = $"ZMIMG{index:D4}";
            map[key] = match.Value;
            index++;
            return key;
        });

        text = LinkRegex().Replace(text, match =>
        {
            var key = $"ZMLNK{index:D4}";
            map[key] = match.Value;
            index++;
            return key;
        });

        text = BareUrlRegex().Replace(text, match =>
        {
            if (map.ContainsValue(match.Value))
                return match.Value;
            var key = $"ZMURL{index:D4}";
            map[key] = match.Value;
            index++;
            return key;
        });

        text = SoftBreakRegex().Replace(text, match =>
        {
            var key = $"ZMBRK{index:D4}";
            map[key] = match.Value;
            index++;
            return key;
        });

        return (text, map);
    }

    public static string Restore(string text, Dictionary<string, string> map)
    {
        foreach (var (key, value) in map)
            text = text.Replace(key, value);
        return text;
    }
}
