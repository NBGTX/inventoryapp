using SpPerm.Core;

namespace SpPerm.Tests;

public class ScanAndExecuteTests
{
    private static async Task<(FakeSharePointClient Fake, ScanResult Scan)> ScanDemoAsync()
    {
        var fake = DemoData.Create();
        var scan = await new ScanService(fake).ScanAsync(null, CancellationToken.None);
        return (fake, scan);
    }

    private static UniqueEntry Entry(ScanResult scan, string endsWith) =>
        scan.Entries.Single(e => e.DisplayPath.EndsWith(endsWith, StringComparison.OrdinalIgnoreCase));

    private static string TempLogDir() => Path.Combine(Path.GetTempPath(), "sppm-tests-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task Scan_finds_every_item_with_its_own_permissions()
    {
        var (fake, scan) = await ScanDemoAsync();

        var libs = await fake.GetLibrariesAsync(CancellationToken.None);
        Assert.Equal(libs.Sum(l => l.ItemCount), scan.ItemsScanned);
        Assert.Equal(11, scan.Entries.Count);
        Assert.Contains(scan.Entries, e => e.IsLibraryRoot && e.Library.Title == "HR Documents");
    }

    [Fact]
    public async Task Scan_flags_folders_that_are_identical_to_their_parent()
    {
        var (_, scan) = await ScanDemoAsync();

        var safe = scan.Entries.Where(e => e.SafeToReset).Select(e => e.DisplayPath).OrderBy(x => x).ToList();

        Assert.Equal(new[] { "Documents/Archive/2022", "HR Documents/Onboarding" }, safe);
    }

    [Fact]
    public async Task Scan_describes_how_a_folder_differs_from_its_parent()
    {
        var (_, scan) = await ScanDemoAsync();

        Assert.Equal("+2 added, 2 removed", Entry(scan, "Projects/2026 budget").Diff.Summary);
        Assert.Equal("+1 added", Entry(scan, "Projects/Vendor contracts").Diff.Summary);
        Assert.Equal("1 removed", Entry(scan, "Shared forms/Templates").Diff.Summary);
    }

    [Fact]
    public async Task Scan_compares_against_the_nearest_unique_ancestor()
    {
        var (_, scan) = await ScanDemoAsync();

        var q3 = Entry(scan, "Reports/Q3 close");
        Assert.EndsWith("Documents/Reports", q3.ParentDisplayPath);
        Assert.Equal("+2 added", q3.Diff.Summary);

        var sheet = Entry(scan, "Budget v3.xlsx");
        Assert.EndsWith("Projects/2026 budget", sheet.ParentDisplayPath);
        Assert.Equal("+1 added", sheet.Diff.Summary);

        var library = scan.Entries.Single(e => e.IsLibraryRoot);
        Assert.Equal(SecurableKind.Web, library.ParentRef.Kind);
    }

    [Fact]
    public async Task Scan_reports_external_users_and_history()
    {
        var (_, scan) = await ScanDemoAsync();

        var budget = Entry(scan, "Projects/2026 budget");
        Assert.True(budget.HasExternal);
        Assert.True(budget.HasDirectUsers);
        Assert.Equal("B. Stevenson", budget.Details?.ModifiedBy);
        Assert.False(Entry(scan, "Reports/Q3 close").HasExternal);
    }

    [Fact]
    public async Task Sharing_links_get_readable_names_and_are_flagged()
    {
        var (_, scan) = await ScanDemoAsync();

        var shared = scan.Entries.Where(e => e.HasSharingLinks).Select(e => e.DisplayPath).OrderBy(x => x).ToList();
        Assert.Equal(new[] { "Documents/Projects/Vendor contracts/Contract draft.docx", "Documents/Reports/Q3 close/Summary.pdf" }, shared);

        var draft = Entry(scan, "Contract draft.docx");
        Assert.Equal("+1 added", draft.Diff.Summary);
        Assert.Contains(draft.Diff.Rows, r => r.Principal.Title == "Sharing link: people in your organization (view)" && r.Principal.KindLabel == "Sharing link");
        Assert.False(draft.SafeToReset);
        Assert.Contains(scan.Entries.Single(e => e.DisplayPath.EndsWith("Summary.pdf")).Assignments, a => a.Principal.Title == "Sharing link: anyone (view)");
    }

    [Theory]
    [InlineData("SharingLinks.a.AnonymousEdit.b", "Sharing link: anyone (edit)")]
    [InlineData("SharingLinks.a.Flexible.b", "Sharing link: specific people")]
    [InlineData("SharingLinks.a.Unknown.b", "Sharing link")]
    [InlineData("Site Owners", "Site Owners")]
    public void Sharing_link_group_names_are_made_readable(string login, string expected)
    {
        Assert.Equal(expected, PrincipalNames.Friendly(login, login));
    }

    [Fact]
    public async Task Setting_a_role_on_an_inheriting_folder_stops_inheriting_first_and_keeps_existing_access()
    {
        var (fake, scan) = await ScanDemoAsync();
        var folder = SecurableRef.ForItem(scan.Libraries.First(l => l.Title == "Documents").Id, fake.FindItemId(scan.Libraries.First(l => l.Title == "Documents").Id, "Projects/Safety"));
        var contractors = scan.Principals.Single(p => p.Title == "Contractors");
        var read = scan.RoleDefinitions.Single(r => r.Name == "Read");

        var executor = new ChangeExecutor(fake, null, "tester");
        var batch = await executor.ExecuteAsync(new PlannedChange[] { new SetRole(folder, "Projects/Safety", contractors, read) }, null, CancellationToken.None);

        Assert.Equal(0, batch.FailureCount);
        Assert.StartsWith("break:", fake.Calls.First());
        Assert.True(fake.IsUnique(folder));
        var now = await fake.GetRoleAssignmentsAsync(folder, CancellationToken.None);
        Assert.Contains(now, a => a.Principal.Title == "Contractors");
        Assert.Contains(now, a => a.Principal.Title == "Demo Owners");
    }

    [Fact]
    public async Task Resetting_a_unique_folder_restores_inheritance_and_is_skipped_when_already_inheriting()
    {
        var (fake, scan) = await ScanDemoAsync();
        var archive = Entry(scan, "Archive/2022");
        var inheriting = SecurableRef.ForItem(archive.Library.Id, fake.FindItemId(archive.Library.Id, "Projects/Safety"));
        var executor = new ChangeExecutor(fake, null, "tester");

        var batch = await executor.ExecuteAsync(
            new PlannedChange[] { new ResetToInherit(archive.Ref, archive.DisplayPath), new ResetToInherit(inheriting, "Projects/Safety") },
            null, CancellationToken.None);

        Assert.False(fake.IsUnique(archive.Ref));
        Assert.Equal(1, batch.ChangedCount);
        Assert.Contains(batch.Targets, t => t.Actions.Any(a => a.Contains("skipped")) && !t.Mutated);
    }

    [Fact]
    public async Task Removing_a_person_removes_every_role_they_hold()
    {
        var (fake, scan) = await ScanDemoAsync();
        var vendor = Entry(scan, "Projects/Vendor contracts");
        var contractors = scan.Principals.Single(p => p.Title == "Contractors");

        var executor = new ChangeExecutor(fake, null, "tester");
        await executor.ExecuteAsync(new PlannedChange[] { new SetRole(vendor.Ref, vendor.DisplayPath, contractors, null) }, null, CancellationToken.None);

        var now = await fake.GetRoleAssignmentsAsync(vendor.Ref, CancellationToken.None);
        Assert.DoesNotContain(now, a => a.Principal.Title == "Contractors");
    }

    [Fact]
    public async Task Applying_the_same_role_twice_changes_nothing_the_second_time()
    {
        var (fake, scan) = await ScanDemoAsync();
        var vendor = Entry(scan, "Projects/Vendor contracts");
        var contractors = scan.Principals.Single(p => p.Title == "Contractors");
        var read = scan.RoleDefinitions.Single(r => r.Name == "Read");

        var batch = await new ChangeExecutor(fake, null, "tester")
            .ExecuteAsync(new PlannedChange[] { new SetRole(vendor.Ref, vendor.DisplayPath, contractors, read) }, null, CancellationToken.None);

        Assert.Equal(0, batch.ChangedCount);
    }

    [Fact]
    public async Task Undo_restores_inheritance_and_previous_permissions()
    {
        var (fake, scan) = await ScanDemoAsync();
        var budget = Entry(scan, "Projects/2026 budget");
        var before = PermissionDiff.ToMap(await fake.GetRoleAssignmentsAsync(budget.Ref, CancellationToken.None));
        var safety = SecurableRef.ForItem(budget.Library.Id, fake.FindItemId(budget.Library.Id, "Projects/Safety"));
        var contractors = scan.Principals.Single(p => p.Title == "Contractors");
        var read = scan.RoleDefinitions.Single(r => r.Name == "Read");

        var executor = new ChangeExecutor(fake, new ChangeLogStore(TempLogDir()), "tester");
        var batch = await executor.ExecuteAsync(
            new PlannedChange[]
            {
                new ResetToInherit(budget.Ref, budget.DisplayPath),
                new SetRole(safety, "Projects/Safety", contractors, read),
            },
            null, CancellationToken.None);
        Assert.False(fake.IsUnique(budget.Ref));
        Assert.True(fake.IsUnique(safety));

        var result = await executor.UndoAsync(batch, null, CancellationToken.None);

        Assert.Equal(0, result.Failures);
        Assert.False(fake.IsUnique(safety));
        Assert.True(fake.IsUnique(budget.Ref));
        var after = PermissionDiff.ToMap(await fake.GetRoleAssignmentsAsync(budget.Ref, CancellationToken.None));
        Assert.Equal(before.Select(kv => (kv.Key, kv.Value.Level)).OrderBy(x => x.Key), after.Select(kv => (kv.Key, kv.Value.Level)).OrderBy(x => x.Key));
        Assert.NotNull(batch.UndoneAt);
    }

    [Fact]
    public async Task One_failing_folder_does_not_stop_the_rest_of_the_batch()
    {
        var (fake, scan) = await ScanDemoAsync();
        var archive = Entry(scan, "Archive/2022");
        var missing = SecurableRef.ForItem(archive.Library.Id, 9999);

        var batch = await new ChangeExecutor(fake, null, "tester").ExecuteAsync(
            new PlannedChange[] { new ResetToInherit(missing, "gone"), new ResetToInherit(archive.Ref, archive.DisplayPath) },
            null, CancellationToken.None);

        Assert.Equal(1, batch.FailureCount);
        Assert.False(fake.IsUnique(archive.Ref));
    }

    [Fact]
    public async Task Change_log_round_trips_through_disk()
    {
        var dir = TempLogDir();
        var store = new ChangeLogStore(dir);
        var (fake, scan) = await ScanDemoAsync();
        var archive = Entry(scan, "Archive/2022");

        var batch = await new ChangeExecutor(fake, store, "tester")
            .ExecuteAsync(new PlannedChange[] { new ResetToInherit(archive.Ref, archive.DisplayPath) }, null, CancellationToken.None);

        var listed = await store.ListAsync();
        var loaded = Assert.Single(listed);
        Assert.Equal(batch.Id, loaded.Id);
        Assert.Equal("tester", loaded.Actor);
        Assert.True(loaded.Targets[0].WasUnique);
        Assert.Equal(archive.Ref, loaded.Targets[0].Target);
        Directory.Delete(dir, true);
    }

    [Fact]
    public async Task Plan_builder_keeps_only_the_latest_change_for_each_target()
    {
        var (_, scan) = await ScanDemoAsync();
        var entry = Entry(scan, "Projects/Vendor contracts");
        var person = scan.Principals.First(p => p.Title == "Contractors");
        var read = scan.RoleDefinitions.Single(r => r.Name == "Read");
        var edit = scan.RoleDefinitions.Single(r => r.Name == "Edit");
        var plan = new PlanBuilder();

        plan.SetRole(entry.Ref, entry.DisplayPath, person, read);
        plan.SetRole(entry.Ref, entry.DisplayPath, person, edit);
        Assert.Single(plan.Changes);
        Assert.Equal(edit, plan.FindSetRole(entry.Ref, person.Id)?.Role);

        plan.Reset(entry.Ref, entry.DisplayPath);
        Assert.Single(plan.Changes);
        Assert.True(plan.IsResetPending(entry.Ref));

        plan.SetRole(entry.Ref, entry.DisplayPath, person, read);
        Assert.False(plan.IsResetPending(entry.Ref));
    }

    [Fact]
    public async Task Excel_export_writes_a_workbook()
    {
        var (_, scan) = await ScanDemoAsync();
        var file = Path.Combine(Path.GetTempPath(), "sppm-" + Guid.NewGuid().ToString("N") + ".xlsx");

        ExcelExporter.Export(scan, file);

        Assert.True(new FileInfo(file).Length > 2000);
        File.Delete(file);
    }
}
