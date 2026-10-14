using SpPerm.Core;

namespace SpPerm.Tests;

public class DiffAndUrlTests
{
    private static readonly RoleDefinition Full = new(1, "Full Control", 5);
    private static readonly RoleDefinition Edit = new(2, "Edit", 6);
    private static readonly RoleDefinition Read = new(3, "Read", 2);
    private static readonly RoleDefinition Limited = new(4, "Limited Access", 1);

    private static Principal P(int id, string name) => new(id, name, $"i:0#.f|membership|{name}", null, PrincipalKind.User);

    private static RoleAssignment A(int id, string name, params RoleDefinition[] roles) => new(P(id, name), roles);

    [Fact]
    public void Identical_permissions_are_reported_as_same_as_parent()
    {
        var diff = PermissionDiff.Compute(new[] { A(1, "a", Full), A(2, "b", Edit) }, new[] { A(2, "b", Edit), A(1, "a", Full) });

        Assert.True(diff.IsIdentical);
        Assert.Equal("Same as parent", diff.Summary);
    }

    [Fact]
    public void Added_removed_and_changed_are_counted()
    {
        var current = new[] { A(1, "owner", Full), A(2, "added", Read), A(3, "changed", Edit) };
        var parent = new[] { A(1, "owner", Full), A(3, "changed", Read), A(4, "removed", Edit) };

        var diff = PermissionDiff.Compute(current, parent);

        Assert.False(diff.IsIdentical);
        Assert.Equal(1, diff.AddedCount);
        Assert.Equal(1, diff.RemovedCount);
        Assert.Equal(1, diff.ChangedCount);
        Assert.Equal("+1 added, 1 removed, 1 changed", diff.Summary);
    }

    [Fact]
    public void Limited_access_entries_are_ignored()
    {
        var diff = PermissionDiff.Compute(new[] { A(1, "a", Full), A(9, "guest", Limited) }, new[] { A(1, "a", Full) });

        Assert.True(diff.IsIdentical);
    }

    [Fact]
    public void Role_order_does_not_create_a_difference()
    {
        var diff = PermissionDiff.Compute(new[] { A(1, "a", Edit, Read) }, new[] { A(1, "a", Read, Edit) });

        Assert.True(diff.IsIdentical);
    }

    [Theory]
    [InlineData("https://nucor.sharepoint.com/sites/Ops/SitePages/Home.aspx", "https://nucor.sharepoint.com/sites/Ops", "nucor.sharepoint.com")]
    [InlineData("nucor.sharepoint.com/teams/Eng/Shared%20Documents/Forms/AllItems.aspx?id=1", "https://nucor.sharepoint.com/teams/Eng", "nucor.sharepoint.com")]
    [InlineData("  https://nucor.sharepoint.com  ", "https://nucor.sharepoint.com", "nucor.sharepoint.com")]
    public void Site_urls_are_reduced_to_the_site(string input, string expectedSite, string expectedHost)
    {
        Assert.True(SiteUrlHelper.TryNormalize(input, out var site, out var host, out _));
        Assert.Equal(expectedSite, site);
        Assert.Equal(expectedHost, host);
    }

    [Theory]
    [InlineData("")]
    [InlineData("https://example.com/sites/Ops")]
    [InlineData("http://nucor.sharepoint.com/sites/Ops")]
    public void Non_sharepoint_addresses_are_rejected(string input)
    {
        Assert.False(SiteUrlHelper.TryNormalize(input, out _, out _, out var error));
        Assert.NotEmpty(error);
    }
}
