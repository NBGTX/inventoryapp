using System.Net;
using System.Text;
using SpPerm.Core;

namespace SpPerm.Tests;

public class RestClientTests
{
    private sealed class Stub : HttpMessageHandler
    {
        public readonly List<(HttpMethod Method, string Url, string Body, string Accept, string Auth)> Requests = new();
        public readonly Queue<Func<HttpResponseMessage>> Responses = new();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add((request.Method, request.RequestUri!.ToString(), body, request.Headers.Accept.ToString(), request.Headers.Authorization?.ToString() ?? ""));
            return Responses.Count > 0 ? Responses.Dequeue()() : Json("{}");
        }
    }

    private static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private static (SharePointRestClient Client, Stub Stub, List<TimeSpan> Delays) Create()
    {
        var stub = new Stub();
        var delays = new List<TimeSpan>();
        var client = new SharePointRestClient(
            "https://nucor.sharepoint.com/sites/Ops/",
            _ => Task.FromResult("TOKEN"),
            new HttpClient(stub),
            (span, _) => { delays.Add(span); return Task.CompletedTask; });
        return (client, stub, delays);
    }

    private static readonly Guid ListId = Guid.Parse("11111111-2222-3333-4444-555555555555");

    [Fact]
    public async Task Break_inheritance_posts_to_the_item_with_a_bearer_token()
    {
        var (client, stub, _) = Create();

        await client.BreakInheritanceAsync(SecurableRef.ForItem(ListId, 7), copyExisting: true, CancellationToken.None);

        var r = Assert.Single(stub.Requests);
        Assert.Equal(HttpMethod.Post, r.Method);
        Assert.Equal($"https://nucor.sharepoint.com/sites/Ops/_api/web/lists(guid'{ListId}')/items(7)/breakroleinheritance(copyRoleAssignments=true,clearSubscopes=false)", r.Url);
        Assert.Equal("Bearer TOKEN", r.Auth);
        Assert.Contains("odata=nometadata", r.Accept);
    }

    [Fact]
    public async Task Reset_add_and_remove_use_the_expected_endpoints()
    {
        var (client, stub, _) = Create();
        var item = SecurableRef.ForItem(ListId, 7);

        await client.ResetInheritanceAsync(item, CancellationToken.None);
        await client.AddRoleAsync(item, 12, 1073741826, CancellationToken.None);
        await client.RemoveRoleAsync(SecurableRef.ForList(ListId), 12, 1073741826, CancellationToken.None);

        Assert.EndsWith("/items(7)/resetroleinheritance", stub.Requests[0].Url);
        Assert.EndsWith("/items(7)/roleassignments/addroleassignment(principalid=12,roledefid=1073741826)", stub.Requests[1].Url);
        Assert.EndsWith($"/lists(guid'{ListId}')/roleassignments/removeroleassignment(principalid=12,roledefid=1073741826)", stub.Requests[2].Url);
        Assert.All(stub.Requests, r => Assert.Equal(HttpMethod.Post, r.Method));
    }

    [Fact]
    public async Task Inheritance_cannot_be_changed_on_the_site_root()
    {
        var (client, _, _) = Create();

        await Assert.ThrowsAsync<NotSupportedException>(() => client.ResetInheritanceAsync(SecurableRef.Web, CancellationToken.None));
    }

    [Fact]
    public async Task Items_are_read_across_pages()
    {
        var (client, stub, _) = Create();
        stub.Responses.Enqueue(() => Json("""
            {"odata.nextLink":"https://nucor.sharepoint.com/sites/Ops/_api/web/lists(guid'x')/items?$skiptoken=Paged%3dTRUE",
             "value":[{"Id":1,"FileRef":"/sites/Ops/Docs/A","FileSystemObjectType":1,"HasUniqueRoleAssignments":true},
                      {"Id":2,"FileRef":"/sites/Ops/Docs/A/b.docx","FileSystemObjectType":0,"HasUniqueRoleAssignments":false}]}
            """));
        stub.Responses.Enqueue(() => Json("""{"value":[{"Id":3,"FileRef":"/sites/Ops/Docs/C","FileSystemObjectType":1,"HasUniqueRoleAssignments":false}]}"""));

        var items = new List<ItemInfo>();
        await foreach (var i in client.GetItemsAsync(new LibraryInfo(ListId, "Docs", "/sites/Ops/Docs", false, 3), CancellationToken.None))
            items.Add(i);

        Assert.Equal(3, items.Count);
        Assert.True(items[0].IsFolder && items[0].HasUniqueRoleAssignments);
        Assert.False(items[1].IsFolder);
        Assert.Equal(2, stub.Requests.Count);
        Assert.Contains("$skiptoken", stub.Requests[1].Url);
    }

    [Fact]
    public async Task Throttled_requests_wait_for_retry_after_and_try_again()
    {
        var (client, stub, delays) = Create();
        stub.Responses.Enqueue(() =>
        {
            var throttled = Json("{}", (HttpStatusCode)429);
            throttled.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(7));
            return throttled;
        });
        stub.Responses.Enqueue(() => Json("""{"Id":4,"Title":"Blake","Email":"b@nucor.com","LoginName":"i:0#.f|membership|b@nucor.com"}"""));

        var user = await client.GetCurrentUserAsync(CancellationToken.None);

        Assert.Equal("Blake", user.Title);
        Assert.Equal(TimeSpan.FromSeconds(7), Assert.Single(delays));
        Assert.Equal(2, stub.Requests.Count);
    }

    [Fact]
    public async Task Forbidden_responses_explain_what_is_missing()
    {
        var (client, stub, _) = Create();
        stub.Responses.Enqueue(() => Json("""{"odata.error":{"code":"-2147024891, System.UnauthorizedAccessException","message":{"lang":"en-US","value":"Access denied."}}}""", HttpStatusCode.Forbidden));

        var ex = await Assert.ThrowsAsync<SharePointException>(() => client.ResetInheritanceAsync(SecurableRef.ForItem(ListId, 1), CancellationToken.None));

        Assert.Equal(403, ex.StatusCode);
        Assert.Contains("AllSites.FullControl", ex.Message);
        Assert.Contains("Access denied.", ex.Message);
    }

    [Fact]
    public async Task Role_assignments_are_parsed_with_principals_and_roles()
    {
        var (client, stub, _) = Create();
        stub.Responses.Enqueue(() => Json("""
            {"value":[
              {"PrincipalId":3,"Member":{"Id":3,"Title":"Owners","LoginName":"Owners","Email":"","PrincipalType":8},
               "RoleDefinitionBindings":[{"Id":1073741829,"Name":"Full Control","RoleTypeKind":5}]},
              {"PrincipalId":22,"Member":{"Id":22,"Title":"J. Rivera","LoginName":"i:0#.f|membership|j.rivera_contoso.com#ext#@nucor.onmicrosoft.com","Email":"j@contoso.com","PrincipalType":1},
               "RoleDefinitionBindings":[{"Id":1073741826,"Name":"Read","RoleTypeKind":2},{"Id":1073741825,"Name":"Limited Access","RoleTypeKind":1}]}]}
            """));

        var result = await client.GetRoleAssignmentsAsync(SecurableRef.ForItem(ListId, 9), CancellationToken.None);

        Assert.Equal(2, result.Count);
        Assert.Equal(PrincipalKind.SharePointGroup, result[0].Principal.Kind);
        Assert.True(result[1].Principal.IsExternal);
        Assert.Equal("Read", result[1].RoleText);
        Assert.Contains("roleassignments", stub.Requests[0].Url);
    }

    [Theory]
    [InlineData("\"2147483647\"", true)]
    [InlineData("\"0\"", false)]
    [InlineData("33554432", true)]
    public async Task Manage_permissions_is_read_from_the_base_permission_mask(string low, bool expected)
    {
        var (client, stub, _) = Create();
        stub.Responses.Enqueue(() => Json($$"""{"High":"432","Low":{{low}}}"""));

        var report = await client.ProbeCapabilitiesAsync(CancellationToken.None);

        Assert.Equal(expected, report.CanManagePermissions);
    }

    [Fact]
    public async Task Libraries_skip_system_libraries()
    {
        var (client, stub, _) = Create();
        stub.Responses.Enqueue(() => Json($$$"""
            {"value":[
              {"Id":"{{{ListId}}}","Title":"Documents","ItemCount":42,"HasUniqueRoleAssignments":false,"RootFolder":{"ServerRelativeUrl":"/sites/Ops/Shared Documents"}},
              {"Id":"{{{Guid.NewGuid()}}}","Title":"Form Templates","ItemCount":0,"HasUniqueRoleAssignments":false,"RootFolder":{"ServerRelativeUrl":"/sites/Ops/FormServerTemplates"}}]}
            """));

        var libs = await client.GetLibrariesAsync(CancellationToken.None);

        var lib = Assert.Single(libs);
        Assert.Equal("/sites/Ops/Shared Documents", lib.RootUrl);
        Assert.Equal(42, lib.ItemCount);
    }

    [Fact]
    public async Task People_picker_results_are_parsed_from_the_nested_json_string()
    {
        var (client, stub, _) = Create();
        const string inner = """[{"Key":"i:0#.f|membership|a@nucor.com","DisplayText":"Alex A","EntityData":{"Email":"a@nucor.com","PrincipalType":"User"}},{"Key":"c:0t.c|tenant|abc","DisplayText":"Finance","EntityData":{"PrincipalType":"SecGroup"}}]""";
        stub.Responses.Enqueue(() => Json("{\"d\":{\"ClientPeoplePickerSearchUser\":" + System.Text.Json.JsonSerializer.Serialize(inner) + "}}"));

        var results = await client.SearchPrincipalsAsync("a", CancellationToken.None);

        Assert.Equal(2, results.Count);
        Assert.Equal(PrincipalKind.User, results[0].Kind);
        Assert.Equal(PrincipalKind.SecurityGroup, results[1].Kind);
        Assert.Contains("odata=verbose", stub.Requests[0].Accept);
    }
}
