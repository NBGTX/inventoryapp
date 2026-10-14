using ClosedXML.Excel;

namespace SpPerm.Core;

public static class ExcelExporter
{
    private static readonly XLColor Dark = XLColor.FromHtml("#213B34");

    public static void Export(ScanResult scan, string path)
    {
        using var wb = new XLWorkbook();

        var summary = wb.Worksheets.Add("Summary");
        var rows = new (string, string)[]
        {
            ("Site", scan.SiteTitle),
            ("Address", scan.SiteUrl),
            ("Scanned", scan.ScannedAt.ToString("yyyy-MM-dd HH:mm")),
            ("Items scanned", scan.ItemsScanned.ToString("N0")),
            ("Items with their own permissions", scan.Entries.Count.ToString("N0")),
            ("Safe to reset (identical to parent)", scan.Entries.Count(e => e.SafeToReset).ToString("N0")),
            ("With direct users", scan.Entries.Count(e => e.HasDirectUsers).ToString("N0")),
            ("With external users", scan.Entries.Count(e => e.HasExternal).ToString("N0")),
        };
        for (var i = 0; i < rows.Length; i++)
        {
            summary.Cell(i + 1, 1).Value = rows[i].Item1;
            summary.Cell(i + 1, 1).Style.Font.Bold = true;
            summary.Cell(i + 1, 2).Value = rows[i].Item2;
        }
        summary.Columns().AdjustToContents();

        var unique = wb.Worksheets.Add("Unique permissions");
        Header(unique, "Library", "Path", "Type", "Differs from parent", "Safe to reset", "Inherits from", "Last modified", "Modified by", "People with access");
        var r = 2;
        foreach (var e in scan.Entries)
        {
            unique.Cell(r, 1).Value = e.Library.Title;
            unique.Cell(r, 2).Value = e.DisplayPath;
            unique.Cell(r, 3).Value = e.TypeLabel;
            unique.Cell(r, 4).Value = e.Diff.Summary;
            unique.Cell(r, 5).Value = e.SafeToReset ? "Yes" : "No";
            unique.Cell(r, 6).Value = e.ParentDisplayPath;
            if (e.Details?.Modified is { } m) unique.Cell(r, 7).Value = m;
            unique.Cell(r, 8).Value = e.Details?.ModifiedBy ?? "";
            unique.Cell(r, 9).Value = e.Assignments.Count(a => !a.IsLimitedOnly);
            r++;
        }
        Finish(unique, r - 1);

        var detail = wb.Worksheets.Add("Access detail");
        Header(detail, "Path", "Name", "Type", "Login", "Email", "Level", "Parent level", "Versus parent");
        r = 2;
        foreach (var e in scan.Entries)
            foreach (var row in e.Diff.Rows)
            {
                detail.Cell(r, 1).Value = e.DisplayPath;
                detail.Cell(r, 2).Value = row.Principal.Title;
                detail.Cell(r, 3).Value = row.Principal.KindLabel;
                detail.Cell(r, 4).Value = row.Principal.LoginName;
                detail.Cell(r, 5).Value = row.Principal.Email ?? "";
                detail.Cell(r, 6).Value = row.Level;
                detail.Cell(r, 7).Value = row.ParentLevel;
                detail.Cell(r, 8).Value = row.Status.ToString();
                r++;
            }
        Finish(detail, r - 1);

        var byPerson = wb.Worksheets.Add("By person");
        Header(byPerson, "Name", "Type", "Login", "Path", "Level");
        r = 2;
        var flat = scan.Entries
            .SelectMany(e => e.Assignments.Where(a => !a.IsLimitedOnly).Select(a => (e, a)))
            .OrderBy(x => x.a.Principal.Title, StringComparer.OrdinalIgnoreCase)
            .ThenBy(x => x.e.DisplayPath, StringComparer.OrdinalIgnoreCase);
        foreach (var (e, a) in flat)
        {
            byPerson.Cell(r, 1).Value = a.Principal.Title;
            byPerson.Cell(r, 2).Value = a.Principal.KindLabel;
            byPerson.Cell(r, 3).Value = a.Principal.LoginName;
            byPerson.Cell(r, 4).Value = e.DisplayPath;
            byPerson.Cell(r, 5).Value = a.RoleText;
            r++;
        }
        Finish(byPerson, r - 1);

        wb.SaveAs(path);
    }

    private static void Header(IXLWorksheet ws, params string[] names)
    {
        for (var i = 0; i < names.Length; i++)
        {
            var cell = ws.Cell(1, i + 1);
            cell.Value = names[i];
            cell.Style.Font.Bold = true;
            cell.Style.Font.FontColor = XLColor.White;
            cell.Style.Fill.BackgroundColor = Dark;
        }
    }

    private static void Finish(IXLWorksheet ws, int lastRow)
    {
        ws.SheetView.FreezeRows(1);
        if (lastRow >= 2) ws.Range(1, 1, lastRow, ws.LastColumnUsed()!.ColumnNumber()).SetAutoFilter();
        ws.Columns().AdjustToContents();
        ws.Row(1).Style.Fill.BackgroundColor = Dark;
    }
}
