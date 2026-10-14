using System.Collections.ObjectModel;

namespace SpPerm.Core;

public abstract record PlannedChange(SecurableRef Target, string Path)
{
    public abstract string Describe();
}

public sealed record ResetToInherit(SecurableRef Target, string Path) : PlannedChange(Target, Path)
{
    public override string Describe() => $"Reset to inherit: {Path}";
}

// Role == null removes the principal from the target entirely.
public sealed record SetRole(SecurableRef Target, string Path, Principal Principal, RoleDefinition? Role) : PlannedChange(Target, Path)
{
    public override string Describe() => Role is null
        ? $"Remove {Principal.Title} from {Path}"
        : $"Give {Principal.Title} {Role.Name} on {Path}";
}

public sealed class PlanBuilder
{
    public ObservableCollection<PlannedChange> Changes { get; } = new();

    public void Reset(SecurableRef target, string path)
    {
        RemoveWhere(c => c.Target == target);
        Changes.Add(new ResetToInherit(target, path));
    }

    public void SetRole(SecurableRef target, string path, Principal principal, RoleDefinition? role)
    {
        RemoveWhere(c => c.Target == target && c is ResetToInherit);
        RemoveWhere(c => c.Target == target && c is SetRole s && s.Principal.Id == principal.Id);
        Changes.Add(new SetRole(target, path, principal, role));
    }

    public SetRole? FindSetRole(SecurableRef target, int principalId) =>
        Changes.OfType<SetRole>().FirstOrDefault(s => s.Target == target && s.Principal.Id == principalId);

    public bool IsResetPending(SecurableRef target) => Changes.OfType<ResetToInherit>().Any(r => r.Target == target);

    public void Remove(PlannedChange change) => Changes.Remove(change);

    public void Clear() => Changes.Clear();

    private void RemoveWhere(Func<PlannedChange, bool> predicate)
    {
        for (var i = Changes.Count - 1; i >= 0; i--)
            if (predicate(Changes[i])) Changes.RemoveAt(i);
    }
}
