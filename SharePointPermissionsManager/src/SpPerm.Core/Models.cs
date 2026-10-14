namespace SpPerm.Core;

public enum PrincipalKind { User, SecurityGroup, SharePointGroup, Other }

public sealed record Principal(int Id, string Title, string LoginName, string? Email, PrincipalKind Kind)
{
    public bool IsUser => Kind == PrincipalKind.User;

    public bool IsExternal => LoginName.Contains("#ext#", StringComparison.OrdinalIgnoreCase);

    // Sharing a file or folder with a link makes SharePoint create a hidden "SharingLinks.<id>.<type>.<id>" group.
    public bool IsSharingLink => LoginName.StartsWith("SharingLinks.", StringComparison.OrdinalIgnoreCase);

    public string KindLabel => Kind switch
    {
        _ when IsSharingLink => "Sharing link",
        PrincipalKind.User => IsExternal ? "External user" : "User",
        PrincipalKind.SecurityGroup => "Group",
        PrincipalKind.SharePointGroup => "Site group",
        _ => "Other",
    };
}

public static class PrincipalNames
{
    public static string Friendly(string title, string loginName)
    {
        if (!loginName.StartsWith("SharingLinks.", StringComparison.OrdinalIgnoreCase)) return title;

        var parts = loginName.Split('.');
        var type = parts.Length >= 3 ? parts[2] : "";
        return type.ToLowerInvariant() switch
        {
            "anonymousview" => "Sharing link: anyone (view)",
            "anonymousedit" => "Sharing link: anyone (edit)",
            "organizationview" => "Sharing link: people in your organization (view)",
            "organizationedit" => "Sharing link: people in your organization (edit)",
            "flexible" => "Sharing link: specific people",
            _ => "Sharing link",
        };
    }
}

public sealed record PrincipalCandidate(string DisplayName, string LoginName, string? Email, PrincipalKind Kind, int? KnownId = null);

public sealed record RoleDefinition(int Id, string Name, int RoleTypeKind)
{
    // RoleTypeKind 1 = Guest, which SharePoint exposes as "Limited Access". It is added automatically and never assigned by hand.
    public bool IsLimitedAccess => RoleTypeKind == 1;
}

public sealed record RoleAssignment(Principal Principal, IReadOnlyList<RoleDefinition> Roles)
{
    public IEnumerable<RoleDefinition> EffectiveRoles => Roles.Where(r => !r.IsLimitedAccess);

    public bool IsLimitedOnly => !EffectiveRoles.Any();

    public string RoleText => string.Join(", ", EffectiveRoles.Select(r => r.Name).OrderBy(n => n, StringComparer.OrdinalIgnoreCase));
}

public enum SecurableKind { Web, List, Item }

public sealed record SecurableRef(SecurableKind Kind, Guid ListId = default, int ItemId = 0)
{
    public static SecurableRef Web { get; } = new(SecurableKind.Web);

    public static SecurableRef ForList(Guid listId) => new(SecurableKind.List, listId);

    public static SecurableRef ForItem(Guid listId, int itemId) => new(SecurableKind.Item, listId, itemId);
}

public sealed record WebInfo(string Title, string Url, string ServerRelativeUrl);

public sealed record LibraryInfo(Guid Id, string Title, string RootUrl, bool HasUniqueRoleAssignments, int ItemCount);

public sealed record ItemInfo(Guid ListId, int Id, string Path, bool IsFolder, bool HasUniqueRoleAssignments);

public sealed record ItemDetails(DateTime? Modified, string? ModifiedBy);

public sealed record CurrentUser(int Id, string Title, string? Email, string LoginName);

public sealed record CapabilityReport(bool CanManagePermissions, string Detail);

public sealed record ScanProgress(string Phase, int Done, int Total);

public sealed class SharePointException : Exception
{
    public int StatusCode { get; }

    public string? ErrorCode { get; }

    public SharePointException(string message, int statusCode = 0, string? errorCode = null, Exception? inner = null)
        : base(message, inner)
    {
        StatusCode = statusCode;
        ErrorCode = errorCode;
    }
}
