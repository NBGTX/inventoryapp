namespace SpPerm.Core;

public enum DiffStatus { Same, Added, Removed, Changed }

public sealed record DiffRow(Principal Principal, string Level, string ParentLevel, DiffStatus Status);

public sealed class PermissionDiff
{
    public IReadOnlyList<DiffRow> Rows { get; }

    public int AddedCount => Rows.Count(r => r.Status == DiffStatus.Added);

    public int RemovedCount => Rows.Count(r => r.Status == DiffStatus.Removed);

    public int ChangedCount => Rows.Count(r => r.Status == DiffStatus.Changed);

    public bool IsIdentical => Rows.All(r => r.Status == DiffStatus.Same);

    public string Summary
    {
        get
        {
            if (IsIdentical) return "Same as parent";
            var parts = new List<string>();
            if (AddedCount > 0) parts.Add($"+{AddedCount} added");
            if (RemovedCount > 0) parts.Add($"{RemovedCount} removed");
            if (ChangedCount > 0) parts.Add($"{ChangedCount} changed");
            return string.Join(", ", parts);
        }
    }

    private PermissionDiff(IReadOnlyList<DiffRow> rows) => Rows = rows;

    public static PermissionDiff Compute(IEnumerable<RoleAssignment> current, IEnumerable<RoleAssignment> parent)
    {
        var cur = ToMap(current);
        var par = ToMap(parent);
        var rows = new List<DiffRow>();

        foreach (var id in cur.Keys.Union(par.Keys))
        {
            var hasCur = cur.TryGetValue(id, out var c);
            var hasPar = par.TryGetValue(id, out var p);
            if (hasCur && hasPar)
            {
                var status = string.Equals(c.Level, p.Level, StringComparison.OrdinalIgnoreCase) ? DiffStatus.Same : DiffStatus.Changed;
                rows.Add(new DiffRow(c.Principal, c.Level, p.Level, status));
            }
            else if (hasCur)
            {
                rows.Add(new DiffRow(c.Principal, c.Level, "", DiffStatus.Added));
            }
            else
            {
                rows.Add(new DiffRow(p.Principal, "", p.Level, DiffStatus.Removed));
            }
        }

        rows.Sort((a, b) => string.Compare(a.Principal.Title, b.Principal.Title, StringComparison.OrdinalIgnoreCase));
        return new PermissionDiff(rows);
    }

    public static Dictionary<int, (Principal Principal, string Level)> ToMap(IEnumerable<RoleAssignment> assignments) =>
        assignments
            .Where(a => !a.IsLimitedOnly)
            .GroupBy(a => a.Principal.Id)
            .ToDictionary(
                g => g.Key,
                g => (g.First().Principal,
                      string.Join(", ", g.SelectMany(a => a.EffectiveRoles).Select(r => r.Name).Distinct().OrderBy(n => n, StringComparer.OrdinalIgnoreCase))));
}
