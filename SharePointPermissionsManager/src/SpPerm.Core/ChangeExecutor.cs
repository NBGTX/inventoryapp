namespace SpPerm.Core;

public sealed record UndoResult(IReadOnlyList<string> Messages, int Failures);

public sealed class ChangeExecutor
{
    private readonly ISharePointClient _client;
    private readonly ChangeLogStore? _log;
    private readonly string _actor;

    public ChangeExecutor(ISharePointClient client, ChangeLogStore? log, string actor)
    {
        _client = client;
        _log = log;
        _actor = actor;
    }

    public async Task<BatchRecord> ExecuteAsync(IEnumerable<PlannedChange> plan, IProgress<ScanProgress>? progress, CancellationToken ct)
    {
        var groups = plan.GroupBy(p => p.Target).ToList();
        var batch = new BatchRecord { Actor = _actor, SiteUrl = _client.SiteUrl };
        var done = 0;

        foreach (var group in groups)
        {
            ct.ThrowIfCancellationRequested();
            var record = new TargetRecord { Target = group.Key, Path = group.First().Path };
            batch.Targets.Add(record);

            try
            {
                var unique = await _client.HasUniqueRoleAssignmentsAsync(group.Key, ct);
                record.WasUnique = unique;
                record.Before = Snapshot(await _client.GetRoleAssignmentsAsync(group.Key, ct));

                foreach (var change in group)
                {
                    switch (change)
                    {
                        case ResetToInherit:
                            if (unique)
                            {
                                await _client.ResetInheritanceAsync(group.Key, ct);
                                unique = false;
                                record.Mutated = true;
                                record.Actions.Add("Reset to inherit from parent");
                            }
                            else
                            {
                                record.Actions.Add("Already inherits, skipped");
                            }
                            break;

                        case SetRole set:
                            if (!unique)
                            {
                                await _client.BreakInheritanceAsync(group.Key, copyExisting: true, ct);
                                unique = true;
                                record.Mutated = true;
                                record.Actions.Add("Stopped inheriting (existing access copied)");
                            }

                            await ApplySetRoleAsync(group.Key, set, record, ct);
                            break;
                    }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                record.Error = ex.Message;
            }

            progress?.Report(new ScanProgress("Applying changes", ++done, groups.Count));
        }

        batch.FinishedAt = DateTime.Now;
        if (_log is not null) await _log.SaveAsync(batch);
        return batch;
    }

    public async Task<UndoResult> UndoAsync(BatchRecord batch, IProgress<ScanProgress>? progress, CancellationToken ct)
    {
        var messages = new List<string>();
        var failures = 0;
        var targets = batch.Targets.Where(t => t.Mutated).Reverse().ToList();
        var done = 0;

        foreach (var record in targets)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var unique = await _client.HasUniqueRoleAssignmentsAsync(record.Target, ct);

                if (!record.WasUnique)
                {
                    if (unique) await _client.ResetInheritanceAsync(record.Target, ct);
                    messages.Add($"Restored inheritance: {record.Path}");
                }
                else
                {
                    if (!unique) await _client.BreakInheritanceAsync(record.Target, copyExisting: true, ct);
                    failures += await RestoreAssignmentsAsync(record, messages, ct);
                    messages.Add($"Restored previous permissions: {record.Path}");
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                failures++;
                messages.Add($"Couldn't undo {record.Path}: {ex.Message}");
            }

            progress?.Report(new ScanProgress("Undoing changes", ++done, targets.Count));
        }

        batch.UndoneAt = DateTime.Now;
        if (_log is not null) await _log.SaveAsync(batch);
        return new UndoResult(messages, failures);
    }

    private async Task ApplySetRoleAsync(SecurableRef target, SetRole set, TargetRecord record, CancellationToken ct)
    {
        var current = await _client.GetRoleAssignmentsAsync(target, ct);
        var existing = current
            .Where(a => a.Principal.Id == set.Principal.Id)
            .SelectMany(a => a.EffectiveRoles)
            .DistinctBy(r => r.Id)
            .ToList();

        var changed = false;
        foreach (var role in existing.Where(r => set.Role is null || r.Id != set.Role.Id))
        {
            await _client.RemoveRoleAsync(target, set.Principal.Id, role.Id, ct);
            changed = true;
        }

        if (set.Role is not null && existing.All(r => r.Id != set.Role.Id))
        {
            await _client.AddRoleAsync(target, set.Principal.Id, set.Role.Id, ct);
            changed = true;
        }

        if (changed) record.Mutated = true;
        record.Actions.Add(changed ? set.Describe() : $"No change needed: {set.Describe()}");
    }

    private async Task<int> RestoreAssignmentsAsync(TargetRecord record, List<string> messages, CancellationToken ct)
    {
        var failures = 0;
        var current = await _client.GetRoleAssignmentsAsync(record.Target, ct);
        var currentMap = current.Where(a => !a.IsLimitedOnly).GroupBy(a => a.Principal.Id)
            .ToDictionary(g => g.Key, g => g.SelectMany(a => a.EffectiveRoles).DistinctBy(r => r.Id).ToList());
        var before = record.Before.Where(p => p.Roles.Any(r => r.RoleTypeKind != 1)).ToDictionary(p => p.Id);

        foreach (var (principalId, roles) in currentMap)
        {
            if (before.ContainsKey(principalId)) continue;
            foreach (var role in roles)
                failures += await TryAsync(() => _client.RemoveRoleAsync(record.Target, principalId, role.Id, ct), messages, record.Path);
        }

        foreach (var (principalId, snapshot) in before)
        {
            currentMap.TryGetValue(principalId, out var have);
            have ??= new List<RoleDefinition>();
            var want = snapshot.Roles.Where(r => r.RoleTypeKind != 1).ToList();

            foreach (var role in have.Where(h => want.All(w => w.Id != h.Id)))
                failures += await TryAsync(() => _client.RemoveRoleAsync(record.Target, principalId, role.Id, ct), messages, record.Path);

            foreach (var role in want.Where(w => have.All(h => h.Id != w.Id)))
                failures += await TryAsync(() => _client.AddRoleAsync(record.Target, principalId, role.Id, ct), messages, record.Path);
        }

        return failures;
    }

    private static async Task<int> TryAsync(Func<Task> action, List<string> messages, string path)
    {
        try
        {
            await action();
            return 0;
        }
        catch (SharePointException ex)
        {
            messages.Add($"Skipped one entry on {path}: {ex.Message}");
            return 1;
        }
    }

    public static List<PrincipalSnapshot> Snapshot(IEnumerable<RoleAssignment> assignments) =>
        assignments
            .Select(a => new PrincipalSnapshot(
                a.Principal.Id, a.Principal.Title, a.Principal.LoginName, a.Principal.Email, a.Principal.Kind,
                a.Roles.Select(r => new RoleSnapshot(r.Id, r.Name, r.RoleTypeKind)).ToList()))
            .ToList();
}
