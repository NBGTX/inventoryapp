namespace SpPerm.Core;

public static class SiteUrlHelper
{
    public static bool TryNormalize(string? input, out string siteUrl, out string host, out string error)
    {
        siteUrl = host = error = "";
        var text = (input ?? "").Trim();
        if (text.Length == 0)
        {
            error = "Enter your SharePoint site address.";
            return false;
        }

        if (!text.Contains("://", StringComparison.Ordinal)) text = "https://" + text;

        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
        {
            error = "That doesn't look like a SharePoint address. Use something like https://nucor.sharepoint.com/sites/YourSite.";
            return false;
        }

        if (!uri.Host.EndsWith(".sharepoint.com", StringComparison.OrdinalIgnoreCase))
        {
            error = "Only SharePoint Online addresses (…sharepoint.com) are supported.";
            return false;
        }

        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var keep = segments.Length >= 2 && (segments[0].Equals("sites", StringComparison.OrdinalIgnoreCase) || segments[0].Equals("teams", StringComparison.OrdinalIgnoreCase))
            ? $"/{segments[0]}/{segments[1]}"
            : "";

        host = uri.Host;
        siteUrl = $"https://{uri.Host}{keep}";
        return true;
    }
}
