namespace SpPerm.Core;

public interface ISharePointClient
{
    string SiteUrl { get; }

    Task<CurrentUser> GetCurrentUserAsync(CancellationToken ct);

    Task<CapabilityReport> ProbeCapabilitiesAsync(CancellationToken ct);

    Task<WebInfo> GetWebInfoAsync(CancellationToken ct);

    Task<IReadOnlyList<LibraryInfo>> GetLibrariesAsync(CancellationToken ct);

    IAsyncEnumerable<ItemInfo> GetItemsAsync(LibraryInfo library, CancellationToken ct);

    Task<ItemDetails> GetItemDetailsAsync(SecurableRef target, CancellationToken ct);

    Task<bool> HasUniqueRoleAssignmentsAsync(SecurableRef target, CancellationToken ct);

    Task<IReadOnlyList<RoleAssignment>> GetRoleAssignmentsAsync(SecurableRef target, CancellationToken ct);

    Task<IReadOnlyList<RoleDefinition>> GetRoleDefinitionsAsync(CancellationToken ct);

    Task<IReadOnlyList<Principal>> GetSiteGroupsAsync(CancellationToken ct);

    Task<IReadOnlyList<PrincipalCandidate>> SearchPrincipalsAsync(string query, CancellationToken ct);

    Task<Principal> EnsureUserAsync(string loginName, CancellationToken ct);

    Task BreakInheritanceAsync(SecurableRef target, bool copyExisting, CancellationToken ct);

    Task ResetInheritanceAsync(SecurableRef target, CancellationToken ct);

    Task AddRoleAsync(SecurableRef target, int principalId, int roleDefinitionId, CancellationToken ct);

    Task RemoveRoleAsync(SecurableRef target, int principalId, int roleDefinitionId, CancellationToken ct);
}
