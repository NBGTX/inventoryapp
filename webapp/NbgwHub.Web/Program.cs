using System.Text.Json;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.Negotiate;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using NbgwHub.Web;

var b = WebApplication.CreateBuilder(args);
b.Services.AddSingleton<Db>();

// Auth: Windows (Negotiate) now. Entra OIDC is scaffolded behind Entra:Enabled for the later switch
// (needs a Web redirect URI + client secret on the app registration; secret via env Entra__ClientSecret).
var entra = b.Configuration.GetSection("Entra");
if (entra.GetValue<bool>("Enabled"))
{
    b.Services.AddAuthentication(o =>
        {
            o.DefaultScheme = CookieAuthenticationDefaults.AuthenticationScheme;
            o.DefaultChallengeScheme = OpenIdConnectDefaults.AuthenticationScheme;
        })
        .AddCookie()
        .AddOpenIdConnect(o =>
        {
            o.Authority = $"https://login.microsoftonline.com/{entra["TenantId"]}/v2.0";
            o.ClientId = entra["ClientId"];
            o.ClientSecret = entra["ClientSecret"];
            o.CallbackPath = entra["CallbackPath"];
            o.ResponseType = "code";
            o.SaveTokens = true;
            o.Scope.Add("offline_access");   // Graph delegated scopes get added when Graph is ported
        });
}
else
{
    b.Services.AddAuthentication(NegotiateDefaults.AuthenticationScheme).AddNegotiate();
}
b.Services.AddAuthorization(o => o.FallbackPolicy = o.DefaultPolicy);

var app = b.Build();
app.UseAuthentication();
app.UseAuthorization();
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/ping", () => new { ok = true, web = true });

app.MapPost("/api/call/{method}", async (string method, HttpContext h, Db db, IConfiguration cfg) =>
{
    var ctx = Rpc.Resolve(h, db, cfg);
    if (ctx == null) return Results.Json(new { ok = false, error = "No division access" }, statusCode: 403);
    if (!Rpc.Methods.TryGetValue(method, out var fn))
        return Results.Json(new { ok = false, error = "not_implemented", method }, statusCode: 404);
    JsonElement[] args = [];
    try
    {
        var body = await JsonDocument.ParseAsync(h.Request.Body);
        if (body.RootElement.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Array)
            args = a.EnumerateArray().Select(x => x.Clone()).ToArray();
    }
    catch (JsonException) { }
    try { return Results.Json(fn(ctx, args)); }
    catch (Exception e) { return Results.Json(new { ok = false, error = e.Message }); }   // never throw to JS
});

app.Run();
