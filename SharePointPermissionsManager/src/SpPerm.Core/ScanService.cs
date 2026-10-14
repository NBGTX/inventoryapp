using System.Collections.Concurrent;

namespace SpPerm.Core;

public sealed class UniqueEntry
{
    public required LibraryInfo Library { get; init; }

    public required SecurableRef Ref { get; init; }

    public required string Path { get; init; }

    public required string DisplayPath { get; init; }

    public bool IsFolder { get; init; }

    public bool IsLibraryRoot { get; init; }

    public required SecurableRef ParentRef { get; init; }

    public required string ParentPath { get; init; }

    public required string ParentDisplayPath { get; init; }

    public required IReadOnlyList<RoleAssignment> Assignments { get; init; }

    public required IReadOnlyList<RoleAssignment> ParentAssignments { get; init; }

    public required PermissionDiff Diff { get; init; }

    public ItemDetails? Details { get; set; }

    public string TypeLabel => IsLibraryRoot ? "Library" : IsFolder ? "Folder" : "File";

    public bool SafeToReset => !IsLibraryRoot && Diff.IsIdentical;

    public bool HasDirectUsers => Assignments.Any(a => !a.IsLimitedOnly && a.Principal.IsUser);

    public bool HasExternal => Assignments.Any(a => !a.IsLimitedOnly && a.Principal.IsExternal);

    public bool HasSharingLinks => Assignments.Any(a => !a.IsLimitedOnly && a.Principal.IsSharingLink);
}

public sealed class ScanResult
{
    public required string SiteUrl { get; init; }

    public required string SiteTitle { get; init; }

    public required DateTime ScannedAt { get; init; }

    public required IReadOnlyList<LibraryInfo> Libraries { get; init; }

    public required int ItemsScanned { get; init; }

    public required IReadOnlyList<UniqueEntry> Entries { get; init; }

    public required IReadOnlyList<RoleAssignment> WebAssignments { get; init; }

    public required IReadOnlyList<RoleDefinition> RoleDefinitions { get; init; }

    public required string WebServerRelativeUrl { get; init; }

    public IEnumerable<Principal> Principals =>
        Entries.SelectMany(e => e.Assignments).Concat(WebAssignments)
            .Where(a => !a.IsLimitedOnly)
            .Select(a => a.Principal)
            .DistinctBy(p => p.Id);

    public IEnumerable<RoleDefinition> AssignableRoles => RoleDefinitions.Where(r => !r.IsLimitedAccess);
}

public sealed class ScanService
{
    private readonly ISharePointClient _client;
    private readonly int _parallelism;

    public ScanService(ISharePointClient client, int parallelism = 4)
    {
        _client = client;
        _parallelism = Math.Max(1, parallelism);
    }

    public async Task<ScanResult> ScanAsync(IProgress<ScanProgress>? progress, CancellationToken ct)
    {
        progress?.Report(new ScanProgress("Reading site", 0, 0));
        var web = await _client.GetWebInfoAsync(ct);
        var roles = await _client.GetRoleDefinitionsAsync(ct);
        var libraries = await _client.GetLibrariesAsync(ct);

        var cache = new ConcurrentDictionary<SecurableRef, Task<IReadOnlyList<RoleAssignment>>>();
        Task<IReadOnlyList<RoleAssignment>> Assignments(SecurableRef r) =>
            cache.GetOrAdd(r, key => _client.GetRoleAssignmentsAsync(key, ct));

        var uniques = new List<(LibraryInfo Lib, string Path, SecurableRef Ref, bool IsFolder, SecurableRef ParentRef, string ParentPath)>();
        var scanned = 0;
        var expected = libraries.Sum(l => l.ItemCount);

        foreach (var lib in libraries)
        {
            var byPath = new Dictionary<string, ItemInfo>(StringComparer.OrdinalIgnoreCase);
            var libUnique = new List<ItemInfo>();

            await foreach (var item in _client.GetItemsAsync(lib, ct))
            {
                byPath[item.Path] = item;
                if (item.HasUniqueRoleAssignments) libUnique.Add(item);
                if (++scanned % 250 == 0) progress?.Report(new ScanProgress($"Scanning {lib.Title}", scanned, expected));
            }

            if (lib.HasUniqueRoleAssignments)
                uniques.Add((lib, lib.RootUrl, SecurableRef.ForList(lib.Id), true, SecurableRef.Web, web.ServerRelativeUrl));

            foreach (var item in libUnique)
            {
                var (parentRef, parentPath) = FindParent(lib, item.Path, byPath, web);
                uniques.Add((lib, item.Path, SecurableRef.ForItem(lib.Id, item.Id), item.IsFolder, parentRef, parentPath));
            }
        }

        progress?.Report(new ScanProgress("Scanning", scanned, expected));

        var needed = uniques.SelectMany(u => new[] { u.Ref, u.ParentRef }).Append(SecurableRef.Web).Distinct().ToList();
        var done = 0;
        await Parallel.ForEachAsync(needed, new ParallelOptions { MaxDegreeOfParallelism = _parallelism, CancellationToken = ct }, async (r, token) =>
        {
            await Assignments(r);
            progress?.Report(new ScanProgress("Reading permissions", Interlocked.Increment(ref done), needed.Count));
        });

        var entries = new List<UniqueEntry>();
        foreach (var u in uniques)
        {
            var own = await Assignments(u.Ref);
            var parent = await Assignments(u.ParentRef);
            entries.Add(new UniqueEntry
            {
                Library = u.Lib,
                Ref = u.Ref,
                Path = u.Path,
                DisplayPath = Display(u.Path, web),
                IsFolder = u.IsFolder,
                IsLibraryRoot = u.Ref.Kind == SecurableKind.List,
                ParentRef = u.ParentRef,
                ParentPath = u.ParentPath,
                ParentDisplayPath = u.ParentRef.Kind == SecurableKind.Web ? "(site)" : Display(u.ParentPath, web),
                Assignments = own,
                ParentAssignments = parent,
                Diff = PermissionDiff.Compute(own, parent),
            });
        }

        var detailTargets = entries.Where(e => e.Ref.Kind == SecurableKind.Item).ToList();
        done = 0;
        await Parallel.ForEachAsync(detailTargets, new ParallelOptions { MaxDegreeOfParallelism = _parallelism, CancellationToken = ct }, async (e, token) =>
        {
            try { e.Details = await _client.GetItemDetailsAsync(e.Ref, token); }
            catch (SharePointException) { }
            progress?.Report(new ScanProgress("Reading history", Interlocked.Increment(ref done), detailTargets.Count));
        });

        entries.Sort((a, b) => string.Compare(a.DisplayPath, b.DisplayPath, StringComparison.OrdinalIgnoreCase));

        return new ScanResult
        {
            SiteUrl = _client.SiteUrl,
            SiteTitle = web.Title,
            ScannedAt = DateTime.Now,
            Libraries = libraries,
            ItemsScanned = scanned,
            Entries = entries,
            WebAssignments = await Assignments(SecurableRef.Web),
            RoleDefinitions = roles,
            WebServerRelativeUrl = web.ServerRelativeUrl,
        };
    }

    private static (SecurableRef Ref, string Path) FindParent(LibraryInfo lib, string path, Dictionary<string, ItemInfo> byPath, WebInfo web)
    {
        var p = ParentOf(path);
        while (p.Length > lib.RootUrl.Length && p.StartsWith(lib.RootUrl, StringComparison.OrdinalIgnoreCase))
        {
            if (byPath.TryGetValue(p, out var ancestor) && ancestor.HasUniqueRoleAssignments)
                return (SecurableRef.ForItem(lib.Id, ancestor.Id), p);
            p = ParentOf(p);
        }

        return lib.HasUniqueRoleAssignments
            ? (SecurableRef.ForList(lib.Id), lib.RootUrl)
            : (SecurableRef.Web, web.ServerRelativeUrl);
    }

    private static string ParentOf(string path)
    {
        var i = path.LastIndexOf('/');
        return i <= 0 ? "" : path[..i];
    }

    private static string Display(string serverRelative, WebInfo web)
    {
        var root = web.ServerRelativeUrl.TrimEnd('/');
        var text = root.Length > 0 && serverRelative.StartsWith(root, StringComparison.OrdinalIgnoreCase)
            ? serverRelative[root.Length..]
            : serverRelative;
        return text.TrimStart('/');
    }
}
