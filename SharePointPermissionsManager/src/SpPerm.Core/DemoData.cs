namespace SpPerm.Core;

// Sample site that mirrors the design mockups, so the app can be tried without signing in.
public static class DemoData
{
    public static FakeSharePointClient Create()
    {
        var f = new FakeSharePointClient();

        var full = f.AddRole(1073741829, "Full Control", 5);
        f.AddRole(1073741828, "Design", 4);
        var edit = f.AddRole(1073741830, "Edit", 6);
        var contribute = f.AddRole(1073741827, "Contribute", 3);
        var read = f.AddRole(1073741826, "Read", 2);
        var limited = f.AddRole(1073741825, "Limited Access", 1);

        var owners = f.AddPrincipal(3, "Demo Owners", PrincipalKind.SharePointGroup);
        var members = f.AddPrincipal(4, "Demo Members", PrincipalKind.SharePointGroup);
        var visitors = f.AddPrincipal(5, "Demo Visitors", PrincipalKind.SharePointGroup);
        var blake = f.AddPrincipal(12, "Blake Stevenson", PrincipalKind.User, "i:0#.f|membership|blake.stevenson@nucor.com");
        var finance = f.AddPrincipal(21, "Finance Team", PrincipalKind.SecurityGroup);
        var rivera = f.AddPrincipal(22, "J. Rivera", PrincipalKind.User, "i:0#.f|membership|j.rivera_contoso.com#ext#@nucor.onmicrosoft.com");
        var contractors = f.AddPrincipal(23, "Contractors", PrincipalKind.SecurityGroup);
        var alvarez = f.AddPrincipal(24, "M. Alvarez", PrincipalKind.User);
        var tran = f.AddPrincipal(25, "K. Tran", PrincipalKind.User);
        f.AddPrincipal(26, "J. Patel", PrincipalKind.User);
        var orgLink = f.AddPrincipal(30, "SharingLinks.1f2e3d4c.OrganizationView.9a8b7c6d", PrincipalKind.SharePointGroup);
        var anyoneLink = f.AddPrincipal(31, "SharingLinks.5e6f7a8b.AnonymousView.0c1d2e3f", PrincipalKind.SharePointGroup);
        f.SetCurrentUser(blake);

        var web = SecurableRef.Web;
        f.Grant(web, owners.Id, full.Id);
        f.Grant(web, members.Id, edit.Id);
        f.Grant(web, visitors.Id, read.Id);
        f.Grant(web, rivera.Id, limited.Id);

        var docs = f.AddLibrary("Documents");
        var hrDocs = f.AddLibrary("HR Documents", unique: true);
        f.Grant(SecurableRef.ForList(hrDocs), owners.Id, full.Id);
        f.Grant(SecurableRef.ForList(hrDocs), members.Id, contribute.Id);

        foreach (var year in new[] { 2019, 2020, 2021, 2022, 2023, 2024, 2025 })
            f.AddFolder(docs, $"Archive/{year}");
        f.AddFolder(docs, "Archive");
        f.AddFolder(docs, "Projects");
        f.AddFolder(docs, "Projects/Vendor contracts", unique: true, "M. Alvarez", DateTime.Now.AddDays(-23));
        f.AddFolder(docs, "Projects/Safety");
        f.AddFolder(docs, "Shared forms");
        f.AddFolder(docs, "Reports");
        f.AddFolder(docs, "Reports/Q1 close");
        for (var i = 1; i <= 12; i++) f.AddFile(docs, $"Projects/Safety/Checklist {i}.pdf");

        var budget = f.AddFolder(docs, "Projects/2026 budget", unique: true, "B. Stevenson", DateTime.Now.AddDays(-9));
        f.Grant(budget, owners.Id, full.Id);
        f.Grant(budget, finance.Id, edit.Id);
        f.Grant(budget, rivera.Id, read.Id);

        var sheet = f.AddFile(docs, "Projects/2026 budget/Budget v3.xlsx", unique: true, "B. Stevenson", DateTime.Now.AddDays(-5));
        f.Grant(sheet, owners.Id, full.Id);
        f.Grant(sheet, alvarez.Id, edit.Id);
        f.Grant(sheet, finance.Id, edit.Id);
        f.Grant(sheet, rivera.Id, read.Id);

        var vendor = SecurableRef.ForItem(docs, f.FindItemId(docs, "Projects/Vendor contracts"));
        f.Grant(vendor, owners.Id, full.Id);
        f.Grant(vendor, members.Id, edit.Id);
        f.Grant(vendor, visitors.Id, read.Id);
        f.Grant(vendor, contractors.Id, read.Id);

        var draft = f.AddFile(docs, "Projects/Vendor contracts/Contract draft.docx", unique: true, "M. Alvarez", DateTime.Now.AddDays(-4));
        f.Grant(draft, owners.Id, full.Id);
        f.Grant(draft, members.Id, edit.Id);
        f.Grant(draft, visitors.Id, read.Id);
        f.Grant(draft, contractors.Id, read.Id);
        f.Grant(draft, orgLink.Id, read.Id);

        var summary = f.AddFile(docs, "Reports/Q3 close/Summary.pdf", unique: true, "B. Stevenson", DateTime.Now.AddDays(-2));
        f.Grant(summary, owners.Id, full.Id);
        f.Grant(summary, members.Id, edit.Id);
        f.Grant(summary, visitors.Id, edit.Id);
        f.Grant(summary, contractors.Id, read.Id);
        f.Grant(summary, finance.Id, edit.Id);
        f.Grant(summary, tran.Id, read.Id);
        f.Grant(summary, anyoneLink.Id, read.Id);

        var onboarding = f.AddFolder(hrDocs, "Onboarding", unique: true, "K. Tran", DateTime.Now.AddDays(-71));
        f.Grant(onboarding, owners.Id, full.Id);
        f.Grant(onboarding, members.Id, contribute.Id);

        var reports = SecurableRef.ForItem(docs, f.FindItemId(docs, "Reports"));
        f.MakeUnique(reports);
        f.Grant(reports, owners.Id, full.Id);
        f.Grant(reports, members.Id, edit.Id);
        f.Grant(reports, visitors.Id, edit.Id);
        f.Grant(reports, contractors.Id, read.Id);

        var q3 = f.AddFolder(docs, "Reports/Q3 close", unique: true, "Finance sync", DateTime.Now.AddDays(-12));
        f.Grant(q3, owners.Id, full.Id);
        f.Grant(q3, members.Id, edit.Id);
        f.Grant(q3, visitors.Id, edit.Id);
        f.Grant(q3, contractors.Id, read.Id);
        f.Grant(q3, finance.Id, edit.Id);
        f.Grant(q3, tran.Id, read.Id);

        var templates = f.AddFolder(docs, "Shared forms/Templates", unique: true, "J. Patel", DateTime.Now.AddDays(-90));
        f.Grant(templates, owners.Id, full.Id);
        f.Grant(templates, members.Id, edit.Id);

        var archive22 = SecurableRef.ForItem(docs, f.FindItemId(docs, "Archive/2022"));
        f.MakeUnique(archive22);
        f.Grant(archive22, owners.Id, full.Id);
        f.Grant(archive22, members.Id, edit.Id);
        f.Grant(archive22, visitors.Id, read.Id);

        return f;
    }
}
