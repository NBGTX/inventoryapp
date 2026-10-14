using System.IO;
using System.Text;
using System.Text.Json;
using Microsoft.Identity.Client;
using Microsoft.Identity.Client.Extensions.Msal;

namespace SpPerm.App;

public sealed record AppConfig(string TenantId, string ClientId, string RedirectUri)
{
    public bool IsConfigured => Guid.TryParse(TenantId, out _) && Guid.TryParse(ClientId, out var id) && id != Guid.Empty;

    public static string DataDirectory { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SharePointPermissionsManager");

    public static AppConfig Load()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "appsettings.json");
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var root = doc.RootElement;
            string Read(string name, string fallback = "") => root.TryGetProperty(name, out var v) ? v.GetString() ?? fallback : fallback;
            return new AppConfig(Read("TenantId"), Read("ClientId"), Read("RedirectUri", "http://localhost"));
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            return new AppConfig("", "", "http://localhost");
        }
    }
}

public sealed class SettingsStore
{
    private static string FilePath => Path.Combine(AppConfig.DataDirectory, "settings.json");

    public string LastSiteUrl { get; set; } = "";

    public static SettingsStore Load()
    {
        try { return JsonSerializer.Deserialize<SettingsStore>(File.ReadAllText(FilePath)) ?? new SettingsStore(); }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException) { return new SettingsStore(); }
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(AppConfig.DataDirectory);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }
}

public sealed class AuthService
{
    private readonly IPublicClientApplication _app;
    private readonly string[] _scopes;

    public string Account { get; private set; } = "";

    private AuthService(IPublicClientApplication app, string host)
    {
        _app = app;
        _scopes = new[] { $"https://{host}/AllSites.FullControl" };
    }

    public static async Task<AuthService> CreateAsync(AppConfig config, string host)
    {
        var app = PublicClientApplicationBuilder
            .Create(config.ClientId)
            .WithAuthority(AzureCloudInstance.AzurePublic, config.TenantId)
            .WithRedirectUri(config.RedirectUri)
            .Build();

        try
        {
            var props = new StorageCreationPropertiesBuilder("msal.cache", AppConfig.DataDirectory).Build();
            var helper = await MsalCacheHelper.CreateAsync(props);
            helper.RegisterCache(app.UserTokenCache);
        }
        catch (Exception ex) when (ex is MsalCachePersistenceException or IOException or UnauthorizedAccessException)
        {
            // Without a token cache the user just signs in again next time.
        }

        return new AuthService(app, host);
    }

    public async Task<AuthenticationResult> SignInAsync(CancellationToken ct)
    {
        var account = (await _app.GetAccountsAsync()).FirstOrDefault();
        AuthenticationResult result;
        if (account is not null)
        {
            try
            {
                result = await _app.AcquireTokenSilent(_scopes, account).ExecuteAsync(ct);
                Account = result.Account.Username;
                return result;
            }
            catch (MsalUiRequiredException) { }
        }

        result = await _app.AcquireTokenInteractive(_scopes).WithPrompt(Prompt.SelectAccount).ExecuteAsync(ct);
        Account = result.Account.Username;
        return result;
    }

    public async Task<string> GetTokenAsync(CancellationToken ct) => (await SignInAsync(ct)).AccessToken;

    public async Task SignOutAsync()
    {
        foreach (var account in await _app.GetAccountsAsync()) await _app.RemoveAsync(account);
        Account = "";
    }

    public static IReadOnlyList<string> ScopesFromToken(string accessToken)
    {
        try
        {
            var parts = accessToken.Split('.');
            if (parts.Length < 2) return Array.Empty<string>();
            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
            using var doc = JsonDocument.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(payload)));
            return doc.RootElement.TryGetProperty("scp", out var scp)
                ? (scp.GetString() ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries)
                : Array.Empty<string>();
        }
        catch (Exception ex) when (ex is FormatException or JsonException) { return Array.Empty<string>(); }
    }
}
