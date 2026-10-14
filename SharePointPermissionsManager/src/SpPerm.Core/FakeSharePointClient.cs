using System.Runtime.CompilerServices;

namespace SpPerm.Core;

// In-memory SharePoint used for unit tests and the built-in demo. It models inheritance the way SharePoint does:
// an item without its own permissions takes its parent's, and role changes on an inheriting item are refused.
public sealed class FakeSharePointClient : ISharePointClient
{
    private sealed class Scope
    {
        public bool Unique;
        public Dictionary<int, HashSet<int>> Roles = new();
    }

    private sealed class FakeLibrary
    {
        public Guid Id;
        public string Title = "";
        public string Root = "";
        public Scope Scope = new();
        public List<FakeItem> Items = new();
    }

    private sealed class FakeItem
    {
        public int Id;
        public string Path = "";
        public bool IsFolder;
        public Scope Scope = new();
        public DateTime Modified;
        public string Editor = "";
        public FakeLibrary Library = null!;
    }

    private readonly Dictionary<int, Principal> _principals = new();
    private readonly Dictionary<int, RoleDefinition> _roles = new();
    private readonly List<FakeLibrary> _libraries = new();
    private readonly Scope _web = new() { Unique = true };
    private int _nextItemId = 1;

    public string SiteUrl { get; } = "https://demo.sharepoint.com/sites/Demo";

    public string WebServerRelativeUrl { get; } = "/sites/Demo";

    public Principal CurrentPrincipal { get; private set; } = null!;

    public List<string> Calls { get; } = new();

    public bool CanManagePermissions { get; set; } = true;

    public Principal AddPrincipal(int id, string title, PrincipalKind kind, string? login = null)
    {
        var loginName = login ?? (kind == PrincipalKind.SharePointGroup ? title : $"i:0#.f|membership|{title.ToLowerInvariant().Replace(' ', '.')}@demo.com");
        var p = new Principal(id, PrincipalNames.Friendly(title, loginName), loginName, null, kind);
        _principals[id] = p;
        return p;
    }

    public RoleDefinition AddRole(int id, string name, int kind)
    {
        var r = new RoleDefinition(id, name, kind);
        _roles[id] = r;
        return r;
    }

    public void SetCurrentUser(Principal p) => CurrentPrincipal = p;

    public Guid AddLibrary(string title, bool unique = false)
    {
        var lib = new FakeLibrary { Id = Guid.NewGuid(), Title = title, Root = $"{WebServerRelativeUrl}/{title}" };
        lib.Scope.Unique = unique;
        _libraries.Add(lib);
        return lib.Id;
    }

    public SecurableRef AddFolder(Guid libraryId, string relativePath, bool unique = false, string editor = "B. Stevenson", DateTime? modified = null) =>
        AddItem(libraryId, relativePath, true, unique, editor, modified);

    public SecurableRef AddFile(Guid libraryId, string relativePath, bool unique = false, string editor = "B. Stevenson", DateTime? modified = null) =>
        AddItem(libraryId, relativePath, false, unique, editor, modified);

    private SecurableRef AddItem(Guid libraryId, string relativePath, bool folder, bool unique, string editor, DateTime? modified)
    {
        var lib = _libraries.First(l => l.Id == libraryId);
        var item = new FakeItem
        {
            Id = _nextItemId++,
            Path = $"{lib.Root}/{relativePath}",
            IsFolder = folder,
            Library = lib,
            Editor = editor,
            Modified = modified ?? DateTime.Now.AddDays(-30),
        };
        item.Scope.Unique = unique;
        lib.Items.Add(item);
        return SecurableRef.ForItem(libraryId, item.Id);
    }

    public void Grant(SecurableRef target, int principalId, int roleId)
    {
        var scope = ScopeOf(target);
        if (!scope.Roles.TryGetValue(principalId, out var set)) scope.Roles[principalId] = set = new HashSet<int>();
        set.Add(roleId);
    }

    public int FindItemId(Guid libraryId, string relativePath)
    {
        var lib = _libraries.First(l => l.Id == libraryId);
        return lib.Items.First(i => string.Equals(i.Path, $"{lib.Root}/{relativePath}", StringComparison.OrdinalIgnoreCase)).Id;
    }

    public void MakeUnique(SecurableRef target)
    {
        var scope = ScopeOf(target);
        scope.Unique = true;
        scope.Roles = new Dictionary<int, HashSet<int>>();
    }

    public bool IsUnique(SecurableRef target) => target.Kind == SecurableKind.Web || ScopeOf(target).Unique;

    public Task<CurrentUser> GetCurrentUserAsync(CancellationToken ct) =>
        Task.FromResult(new CurrentUser(CurrentPrincipal.Id, CurrentPrincipal.Title, CurrentPrincipal.Email, CurrentPrincipal.LoginName));

    public Task<CapabilityReport> ProbeCapabilitiesAsync(CancellationToken ct) =>
        Task.FromResult(new CapabilityReport(CanManagePermissions, CanManagePermissions ? "You can manage permissions on this site." : "Read-only account."));

    public Task<WebInfo> GetWebInfoAsync(CancellationToken ct) => Task.FromResult(new WebInfo("Demo site", SiteUrl, WebServerRelativeUrl));

    public Task<IReadOnlyList<LibraryInfo>> GetLibrariesAsync(CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<LibraryInfo>>(_libraries.Select(l => new LibraryInfo(l.Id, l.Title, l.Root, l.Scope.Unique, l.Items.Count)).ToList());

    public async IAsyncEnumerable<ItemInfo> GetItemsAsync(LibraryInfo library, [EnumeratorCancellation] CancellationToken ct)
    {
        await Task.Yield();
        foreach (var i in _libraries.First(l => l.Id == library.Id).Items.ToList())
            yield return new ItemInfo(library.Id, i.Id, i.Path, i.IsFolder, i.Scope.Unique);
    }

    public Task<ItemDetails> GetItemDetailsAsync(SecurableRef target, CancellationToken ct)
    {
        var item = ItemOf(target);
        return Task.FromResult(new ItemDetails(item.Modified, item.Editor));
    }

    public Task<bool> HasUniqueRoleAssignmentsAsync(SecurableRef target, CancellationToken ct) => Task.FromResult(IsUnique(target));

    public Task<IReadOnlyList<RoleAssignment>> GetRoleAssignmentsAsync(SecurableRef target, CancellationToken ct)
    {
        var roles = Effective(target);
        IReadOnlyList<RoleAssignment> result = roles
            .Select(kv => new RoleAssignment(_principals[kv.Key], kv.Value.Select(id => _roles[id]).ToList()))
            .ToList();
        return Task.FromResult(result);
    }

    public Task<IReadOnlyList<RoleDefinition>> GetRoleDefinitionsAsync(CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<RoleDefinition>>(_roles.Values.ToList());

    public Task<IReadOnlyList<Principal>> GetSiteGroupsAsync(CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<Principal>>(_principals.Values.Where(p => p.Kind == PrincipalKind.SharePointGroup).ToList());

    public Task<IReadOnlyList<PrincipalCandidate>> SearchPrincipalsAsync(string query, CancellationToken ct)
    {
        IReadOnlyList<PrincipalCandidate> result = _principals.Values
            .Where(p => p.Kind != PrincipalKind.SharePointGroup && p.Title.Contains(query, StringComparison.OrdinalIgnoreCase))
            .Select(p => new PrincipalCandidate(p.Title, p.LoginName, p.Email, p.Kind, p.Id))
            .ToList();
        return Task.FromResult(result);
    }

    public Task<Principal> EnsureUserAsync(string loginName, CancellationToken ct)
    {
        var p = _principals.Values.FirstOrDefault(x => string.Equals(x.LoginName, loginName, StringComparison.OrdinalIgnoreCase))
            ?? throw new SharePointException("User not found.", 404);
        return Task.FromResult(p);
    }

    public Task BreakInheritanceAsync(SecurableRef target, bool copyExisting, CancellationToken ct)
    {
        Calls.Add($"break:{Key(target)}:{copyExisting}");
        var scope = ScopeOf(target);
        var inherited = Effective(target).ToDictionary(kv => kv.Key, kv => new HashSet<int>(kv.Value));
        scope.Unique = true;
        scope.Roles = copyExisting ? inherited : new Dictionary<int, HashSet<int>>();
        return Task.CompletedTask;
    }

    public Task ResetInheritanceAsync(SecurableRef target, CancellationToken ct)
    {
        Calls.Add($"reset:{Key(target)}");
        var scope = ScopeOf(target);
        scope.Unique = false;
        scope.Roles = new Dictionary<int, HashSet<int>>();
        return Task.CompletedTask;
    }

    public Task AddRoleAsync(SecurableRef target, int principalId, int roleDefinitionId, CancellationToken ct)
    {
        Calls.Add($"add:{Key(target)}:{principalId}:{roleDefinitionId}");
        RequireUnique(target);
        Grant(target, principalId, roleDefinitionId);
        return Task.CompletedTask;
    }

    public Task RemoveRoleAsync(SecurableRef target, int principalId, int roleDefinitionId, CancellationToken ct)
    {
        Calls.Add($"remove:{Key(target)}:{principalId}:{roleDefinitionId}");
        RequireUnique(target);
        var scope = ScopeOf(target);
        if (scope.Roles.TryGetValue(principalId, out var set))
        {
            set.Remove(roleDefinitionId);
            if (set.Count == 0) scope.Roles.Remove(principalId);
        }

        return Task.CompletedTask;
    }

    private void RequireUnique(SecurableRef target)
    {
        if (!IsUnique(target)) throw new SharePointException("This item inherits permissions; stop inheriting first.", 400);
    }

    private string Key(SecurableRef t) => t.Kind switch
    {
        SecurableKind.Web => "web",
        SecurableKind.List => "list",
        _ => ItemOf(t).Path,
    };

    private Scope ScopeOf(SecurableRef t) => t.Kind switch
    {
        SecurableKind.Web => _web,
        SecurableKind.List => LibOf(t).Scope,
        _ => ItemOf(t).Scope,
    };

    private FakeLibrary LibOf(SecurableRef t) => _libraries.First(l => l.Id == t.ListId);

    private FakeItem ItemOf(SecurableRef t) => LibOf(t).Items.First(i => i.Id == t.ItemId);

    private Dictionary<int, HashSet<int>> Effective(SecurableRef t)
    {
        switch (t.Kind)
        {
            case SecurableKind.Web:
                return _web.Roles;
            case SecurableKind.List:
                return LibOf(t).Scope.Unique ? LibOf(t).Scope.Roles : _web.Roles;
            default:
                var item = ItemOf(t);
                if (item.Scope.Unique) return item.Scope.Roles;
                var parentPath = item.Path[..item.Path.LastIndexOf('/')];
                var parent = item.Library.Items.FirstOrDefault(i => string.Equals(i.Path, parentPath, StringComparison.OrdinalIgnoreCase));
                return parent is null
                    ? Effective(SecurableRef.ForList(item.Library.Id))
                    : Effective(SecurableRef.ForItem(item.Library.Id, parent.Id));
        }
    }
}
