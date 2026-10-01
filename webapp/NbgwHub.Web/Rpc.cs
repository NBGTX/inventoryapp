using System.Security.Claims;
using System.Text.Json;

namespace NbgwHub.Web;

/// <summary>Per-request context: signed-in user + the division (tenant) they are working in.</summary>
public class Ctx
{
    public required HttpContext Http { get; init; }
    public required Db Db { get; init; }
    public required Division Division { get; init; }
    public required List<Division> Allowed { get; init; }
    public string User => Http.User.Identity?.Name ?? "unknown";
}

public static class Rpc
{
    public const string DivCookie = "nbgw_div";

    public static bool CanAccess(HttpContext h, IConfiguration cfg, Division d)
    {
        var admins = cfg.GetSection("Admins").Get<string[]>() ?? [];
        if (admins.Any(a => IsMatch(h.User, a))) return true;
        var acl = JsonSerializer.Deserialize<string[]>(d.AccessJson) ?? [];
        return acl.Length == 0 || acl.Any(a => IsMatch(h.User, a));   // empty ACL = any signed-in user
    }

    static bool IsMatch(ClaimsPrincipal u, string entry) =>
        string.Equals(u.Identity?.Name, entry, StringComparison.OrdinalIgnoreCase) || u.IsInRole(entry);

    public static Ctx? Resolve(HttpContext h, Db db, IConfiguration cfg)
    {
        var allowed = db.Divisions().Where(d => CanAccess(h, cfg, d)).ToList();
        if (allowed.Count == 0) return null;
        h.Request.Cookies.TryGetValue(DivCookie, out var want);
        var cur = allowed.FirstOrDefault(d => d.Id == want) ?? allowed[0];
        return new Ctx { Http = h, Db = db, Division = cur, Allowed = allowed };
    }

    // Method names mirror app.py Api so the existing UI works unchanged. Port more methods here.
    public static readonly Dictionary<string, Func<Ctx, JsonElement[], object?>> Methods = new()
    {
        ["whoami"] = (c, _) => new { ok = true, user = c.User, division = c.Division.Id },
        ["get_divisions"] = (c, _) => new {
            ok = true, current = c.Division.Id,
            divisions = c.Allowed.Select(d => new { id = d.Id, name = d.Name }) },
        ["switch_division"] = (c, a) => {
            var id = a.Length > 0 ? a[0].GetString() : null;
            var d = c.Allowed.FirstOrDefault(x => x.Id == id);
            if (d == null) return new { ok = false, error = "Division not found or no access", current = c.Division.Id };
            c.Http.Response.Cookies.Append(DivCookie, d.Id, new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Lax, Secure = c.Http.Request.IsHttps });
            c.Db.Audit(d.Id, c.User, "switch_division", d.Name);
            return new { ok = true, current = d.Id };
        },
        ["get_division_config"] = (c, _) => new { ok = true, division = new {
            id = c.Division.Id, name = c.Division.Name, companyName = c.Division.CompanyName,
            intuneCategory = c.Division.IntuneCategory, spHostname = c.Division.SpHostname,
            spSitePath = c.Division.SpSitePath, adDomain = c.Division.AdDomain, sqlServer = c.Division.SqlServer,
            sites = JsonSerializer.Deserialize<JsonElement>(c.Division.SitesJson) } },
        // hub document: sites (was nbgw-nbt-sites.json)
        ["get_sites"] = (c, _) => (object?)c.Db.GetDoc(c.Division.Id, "sites") ?? new { sites = Array.Empty<object>() },
        ["save_sites"] = (c, a) => {
            if (a.Length == 0) return new { ok = false, error = "missing data" };
            c.Db.PutDoc(c.Division.Id, "sites", "main", a[0].GetRawText(), c.User);
            c.Db.Audit(c.Division.Id, c.User, "save_sites", "");
            return new { ok = true };
        },
    };
}
