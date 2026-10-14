using System.Net;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;

namespace SpPerm.Core;

public sealed class SharePointRestClient : ISharePointClient
{
    // SPBasePermissions.ManagePermissions (low word of the base permission mask).
    private const long ManagePermissionsMask = 0x02000000;
    private const int MaxAttempts = 6;

    private readonly HttpClient _http;
    private readonly Func<CancellationToken, Task<string>> _tokenProvider;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;

    public string SiteUrl { get; }

    public SharePointRestClient(
        string siteUrl,
        Func<CancellationToken, Task<string>> tokenProvider,
        HttpClient? http = null,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        SiteUrl = siteUrl.TrimEnd('/');
        _tokenProvider = tokenProvider;
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromMinutes(2) };
        _delay = delay ?? ((span, ct) => Task.Delay(span, ct));
    }

    public async Task<CurrentUser> GetCurrentUserAsync(CancellationToken ct)
    {
        var json = await GetAsync("/web/currentuser?$select=Id,Title,Email,LoginName", ct);
        return new CurrentUser(json.GetProperty("Id").GetInt32(), Str(json, "Title"), NullableStr(json, "Email"), Str(json, "LoginName"));
    }

    public async Task<CapabilityReport> ProbeCapabilitiesAsync(CancellationToken ct)
    {
        var json = await GetAsync("/web/effectivebasepermissions", ct);
        var low = ReadLong(json, "Low");
        var can = (low & ManagePermissionsMask) != 0;
        return new CapabilityReport(can, can
            ? "You can manage permissions on this site."
            : "Your account doesn't have Manage Permissions on this site, so changes will be refused. You need to be a site owner.");
    }

    public async Task<WebInfo> GetWebInfoAsync(CancellationToken ct)
    {
        var json = await GetAsync("/web?$select=Title,Url,ServerRelativeUrl", ct);
        return new WebInfo(Str(json, "Title"), Str(json, "Url"), Str(json, "ServerRelativeUrl"));
    }

    public async Task<IReadOnlyList<LibraryInfo>> GetLibrariesAsync(CancellationToken ct)
    {
        var json = await GetAsync(
            "/web/lists?$select=Id,Title,ItemCount,HasUniqueRoleAssignments,BaseTemplate,Hidden,RootFolder/ServerRelativeUrl&$expand=RootFolder&$filter=BaseTemplate eq 101 and Hidden eq false",
            ct);

        var skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Form Templates", "Style Library" };
        var result = new List<LibraryInfo>();
        foreach (var l in json.GetProperty("value").EnumerateArray())
        {
            var title = Str(l, "Title");
            if (skip.Contains(title)) continue;
            result.Add(new LibraryInfo(
                Guid.Parse(Str(l, "Id")),
                title,
                l.GetProperty("RootFolder").GetProperty("ServerRelativeUrl").GetString() ?? "",
                l.TryGetProperty("HasUniqueRoleAssignments", out var hu) && hu.ValueKind == JsonValueKind.True,
                l.TryGetProperty("ItemCount", out var ic) && ic.ValueKind == JsonValueKind.Number ? ic.GetInt32() : 0));
        }

        return result;
    }

    public async IAsyncEnumerable<ItemInfo> GetItemsAsync(LibraryInfo library, [EnumeratorCancellation] CancellationToken ct)
    {
        string? next = $"/web/lists(guid'{library.Id}')/items?$select=Id,FileRef,FileSystemObjectType,HasUniqueRoleAssignments&$top=5000";
        while (next is not null)
        {
            var json = await GetAsync(next, ct);
            foreach (var i in json.GetProperty("value").EnumerateArray())
            {
                yield return new ItemInfo(
                    library.Id,
                    i.GetProperty("Id").GetInt32(),
                    Str(i, "FileRef"),
                    i.GetProperty("FileSystemObjectType").GetInt32() == 1,
                    i.TryGetProperty("HasUniqueRoleAssignments", out var hu) && hu.ValueKind == JsonValueKind.True);
            }

            next = json.TryGetProperty("odata.nextLink", out var link) ? link.GetString() : null;
        }
    }

    public async Task<ItemDetails> GetItemDetailsAsync(SecurableRef target, CancellationToken ct)
    {
        var json = await GetAsync($"{BaseUrl(target)}?$select=Modified,Editor/Title&$expand=Editor", ct);
        DateTime? modified = json.TryGetProperty("Modified", out var m) && m.ValueKind == JsonValueKind.String && DateTime.TryParse(m.GetString(), out var dt)
            ? dt.ToLocalTime()
            : null;
        string? editor = json.TryGetProperty("Editor", out var e) && e.ValueKind == JsonValueKind.Object ? NullableStr(e, "Title") : null;
        return new ItemDetails(modified, editor);
    }

    public async Task<bool> HasUniqueRoleAssignmentsAsync(SecurableRef target, CancellationToken ct)
    {
        if (target.Kind == SecurableKind.Web) return true;
        var json = await GetAsync($"{BaseUrl(target)}?$select=HasUniqueRoleAssignments", ct);
        return json.TryGetProperty("HasUniqueRoleAssignments", out var v) && v.ValueKind == JsonValueKind.True;
    }

    public async Task<IReadOnlyList<RoleAssignment>> GetRoleAssignmentsAsync(SecurableRef target, CancellationToken ct)
    {
        var json = await GetAsync(
            $"{BaseUrl(target)}/roleassignments?$select=PrincipalId,Member/Id,Member/Title,Member/LoginName,Member/Email,Member/PrincipalType,RoleDefinitionBindings/Id,RoleDefinitionBindings/Name,RoleDefinitionBindings/RoleTypeKind&$expand=Member,RoleDefinitionBindings",
            ct);

        var result = new List<RoleAssignment>();
        foreach (var ra in json.GetProperty("value").EnumerateArray())
        {
            var member = ra.GetProperty("Member");
            var principal = new Principal(
                member.GetProperty("Id").GetInt32(),
                PrincipalNames.Friendly(Str(member, "Title"), Str(member, "LoginName")),
                Str(member, "LoginName"),
                NullableStr(member, "Email"),
                MapKind(member.TryGetProperty("PrincipalType", out var pt) ? pt.GetInt32() : 0));
            var roles = ra.GetProperty("RoleDefinitionBindings").EnumerateArray()
                .Select(r => new RoleDefinition(r.GetProperty("Id").GetInt32(), Str(r, "Name"), r.TryGetProperty("RoleTypeKind", out var k) ? k.GetInt32() : 0))
                .ToList();
            result.Add(new RoleAssignment(principal, roles));
        }

        return result;
    }

    public async Task<IReadOnlyList<RoleDefinition>> GetRoleDefinitionsAsync(CancellationToken ct)
    {
        var json = await GetAsync("/web/roledefinitions?$select=Id,Name,RoleTypeKind,Hidden", ct);
        return json.GetProperty("value").EnumerateArray()
            .Where(r => !(r.TryGetProperty("Hidden", out var h) && h.ValueKind == JsonValueKind.True))
            .Select(r => new RoleDefinition(r.GetProperty("Id").GetInt32(), Str(r, "Name"), r.TryGetProperty("RoleTypeKind", out var k) ? k.GetInt32() : 0))
            .ToList();
    }

    public async Task<IReadOnlyList<Principal>> GetSiteGroupsAsync(CancellationToken ct)
    {
        var json = await GetAsync("/web/sitegroups?$select=Id,Title,LoginName,PrincipalType", ct);
        return json.GetProperty("value").EnumerateArray()
            .Select(g => new Principal(g.GetProperty("Id").GetInt32(), PrincipalNames.Friendly(Str(g, "Title"), Str(g, "LoginName")), Str(g, "LoginName"), null, PrincipalKind.SharePointGroup))
            .Where(p => !p.IsSharingLink)
            .ToList();
    }

    public async Task<IReadOnlyList<PrincipalCandidate>> SearchPrincipalsAsync(string query, CancellationToken ct)
    {
        var body = new Dictionary<string, object>
        {
            ["queryParams"] = new Dictionary<string, object>
            {
                ["__metadata"] = new Dictionary<string, string> { ["type"] = "SP.UI.ApplicationPages.ClientPeoplePickerQueryParameters" },
                ["QueryString"] = query,
                ["MaximumEntitySuggestions"] = 15,
                ["AllowEmailAddresses"] = false,
                ["AllowOnlyEmailAddresses"] = false,
                ["PrincipalSource"] = 15,
                ["PrincipalType"] = 5,
                ["SharePointGroupID"] = 0,
            },
        };

        var json = await SendAsync(
            HttpMethod.Post,
            "/SP.UI.ApplicationPages.ClientPeoplePickerWebServiceInterface.clientPeoplePickerSearchUser",
            body, verbose: true, ct);

        string? payload = null;
        if (json.TryGetProperty("d", out var d) && d.TryGetProperty("ClientPeoplePickerSearchUser", out var s)) payload = s.GetString();
        else if (json.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.String) payload = v.GetString();
        if (string.IsNullOrWhiteSpace(payload)) return Array.Empty<PrincipalCandidate>();

        using var doc = JsonDocument.Parse(payload);
        var result = new List<PrincipalCandidate>();
        foreach (var e in doc.RootElement.EnumerateArray())
        {
            var key = e.TryGetProperty("Key", out var k) ? k.GetString() ?? "" : "";
            if (key.Length == 0) continue;
            var display = e.TryGetProperty("DisplayText", out var dt) ? dt.GetString() ?? key : key;
            string? email = null;
            var kind = PrincipalKind.User;
            if (e.TryGetProperty("EntityData", out var data) && data.ValueKind == JsonValueKind.Object)
            {
                email = data.TryGetProperty("Email", out var em) ? em.GetString() : null;
                var pt = data.TryGetProperty("PrincipalType", out var ptv) ? ptv.GetString() : null;
                kind = pt switch { "SecGroup" or "DL" => PrincipalKind.SecurityGroup, "SPGroup" => PrincipalKind.SharePointGroup, _ => PrincipalKind.User };
            }

            result.Add(new PrincipalCandidate(display, key, string.IsNullOrWhiteSpace(email) ? null : email, kind));
        }

        return result;
    }

    public async Task<Principal> EnsureUserAsync(string loginName, CancellationToken ct)
    {
        var json = await SendAsync(HttpMethod.Post, "/web/ensureuser", new { logonName = loginName }, verbose: false, ct);
        return new Principal(
            json.GetProperty("Id").GetInt32(),
            Str(json, "Title"),
            Str(json, "LoginName"),
            NullableStr(json, "Email"),
            MapKind(json.TryGetProperty("PrincipalType", out var pt) ? pt.GetInt32() : 1));
    }

    public Task BreakInheritanceAsync(SecurableRef target, bool copyExisting, CancellationToken ct)
    {
        RequireSecurable(target);
        var copy = copyExisting ? "true" : "false";
        return SendAsync(HttpMethod.Post, $"{BaseUrl(target)}/breakroleinheritance(copyRoleAssignments={copy},clearSubscopes=false)", null, verbose: false, ct);
    }

    public Task ResetInheritanceAsync(SecurableRef target, CancellationToken ct)
    {
        RequireSecurable(target);
        return SendAsync(HttpMethod.Post, $"{BaseUrl(target)}/resetroleinheritance", null, verbose: false, ct);
    }

    public Task AddRoleAsync(SecurableRef target, int principalId, int roleDefinitionId, CancellationToken ct) =>
        SendAsync(HttpMethod.Post, $"{BaseUrl(target)}/roleassignments/addroleassignment(principalid={principalId},roledefid={roleDefinitionId})", null, verbose: false, ct);

    public Task RemoveRoleAsync(SecurableRef target, int principalId, int roleDefinitionId, CancellationToken ct) =>
        SendAsync(HttpMethod.Post, $"{BaseUrl(target)}/roleassignments/removeroleassignment(principalid={principalId},roledefid={roleDefinitionId})", null, verbose: false, ct);

    private static void RequireSecurable(SecurableRef target)
    {
        if (target.Kind == SecurableKind.Web)
            throw new NotSupportedException("Inheritance can't be changed on the site root.");
    }

    private static string BaseUrl(SecurableRef r) => r.Kind switch
    {
        SecurableKind.Web => "/web",
        SecurableKind.List => $"/web/lists(guid'{r.ListId}')",
        _ => $"/web/lists(guid'{r.ListId}')/items({r.ItemId})",
    };

    private Task<JsonElement> GetAsync(string pathOrUrl, CancellationToken ct) =>
        SendAsync(HttpMethod.Get, pathOrUrl, null, verbose: false, ct);

    private async Task<JsonElement> SendAsync(HttpMethod method, string pathOrUrl, object? body, bool verbose, CancellationToken ct)
    {
        var url = pathOrUrl.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? pathOrUrl : $"{SiteUrl}/_api{pathOrUrl}";
        var odata = verbose ? "application/json;odata=verbose" : "application/json;odata=nometadata";

        for (var attempt = 1; ; attempt++)
        {
            using var request = new HttpRequestMessage(method, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await _tokenProvider(ct));
            request.Headers.Accept.ParseAdd(odata);
            if (method == HttpMethod.Post)
            {
                request.Content = body is null
                    ? new StringContent("", Encoding.UTF8, "application/json")
                    : new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
                request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(odata);
            }

            using var response = await _http.SendAsync(request, ct);
            var text = await response.Content.ReadAsStringAsync(ct);

            if (response.IsSuccessStatusCode)
            {
                if (string.IsNullOrWhiteSpace(text)) return default;
                using var doc = JsonDocument.Parse(text);
                return doc.RootElement.Clone();
            }

            var status = (int)response.StatusCode;
            var retryable = status is 429 or 503 or 504;
            if (retryable && attempt < MaxAttempts)
            {
                await _delay(RetryDelay(response, attempt), ct);
                continue;
            }

            throw ToException(status, response.StatusCode, text);
        }
    }

    private static TimeSpan RetryDelay(HttpResponseMessage response, int attempt)
    {
        var retryAfter = response.Headers.RetryAfter;
        if (retryAfter?.Delta is { } delta) return delta;
        if (retryAfter?.Date is { } date)
        {
            var span = date - DateTimeOffset.UtcNow;
            return span > TimeSpan.Zero ? span : TimeSpan.FromSeconds(1);
        }

        return TimeSpan.FromSeconds(Math.Pow(2, attempt));
    }

    private static SharePointException ToException(int status, HttpStatusCode code, string body)
    {
        string? errorCode = null;
        string? message = null;
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.TryGetProperty("odata.error", out var err) || root.TryGetProperty("error", out err))
            {
                errorCode = err.TryGetProperty("code", out var c) ? c.GetString() : null;
                if (err.TryGetProperty("message", out var m))
                    message = m.ValueKind == JsonValueKind.Object && m.TryGetProperty("value", out var mv) ? mv.GetString() : m.GetString();
            }
        }
        catch (JsonException) { }

        var friendly = status switch
        {
            401 => "Your sign-in expired or the app isn't allowed to use SharePoint. Sign in again.",
            403 => "SharePoint refused this action. You need to be a site owner, and the app needs the AllSites.FullControl permission.",
            404 => "SharePoint couldn't find that item. It may have been moved or deleted.",
            _ => $"SharePoint returned {status} ({code}).",
        };

        return new SharePointException(string.IsNullOrWhiteSpace(message) ? friendly : $"{friendly} ({message})", status, errorCode);
    }

    private static PrincipalKind MapKind(int principalType) => principalType switch
    {
        1 => PrincipalKind.User,
        2 or 4 => PrincipalKind.SecurityGroup,
        8 => PrincipalKind.SharePointGroup,
        _ => PrincipalKind.Other,
    };

    private static string Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private static string? NullableStr(JsonElement e, string name)
    {
        var s = Str(e, name);
        return s.Length == 0 ? null : s;
    }

    private static long ReadLong(JsonElement e, string name)
    {
        if (!e.TryGetProperty(name, out var v)) return 0;
        return v.ValueKind == JsonValueKind.Number ? v.GetInt64() : long.TryParse(v.GetString(), out var n) ? n : 0;
    }
}
