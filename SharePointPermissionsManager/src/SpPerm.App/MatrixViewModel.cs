using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using SpPerm.Core;

namespace SpPerm.App;

public sealed class MatrixCell : ObservableObject
{
    public Principal Principal { get; }

    public string Label { get; private set; } = "–";

    public Brush Background { get; private set; } = Palette.White;

    public Brush Foreground { get; private set; } = Palette.Muted;

    public Brush Border { get; private set; } = Palette.MutedBorder;

    public Thickness BorderWidth { get; private set; } = new(1.5);

    public string Tip { get; private set; } = "";

    public MatrixCell(Principal principal) => Principal = principal;

    public void Update(IReadOnlyList<RoleDefinition> roles, bool inherited, bool pending, string tip)
    {
        var top = roles.OrderByDescending(r => RoleRank(r)).FirstOrDefault();
        Label = roles.Count switch
        {
            0 => "–",
            1 => Short(roles[0]),
            _ => "Mixed",
        };

        var fill = roles.Count == 0 ? Palette.MutedBorder : Fill(top!);
        if (roles.Count == 0)
        {
            Background = Palette.White;
            Foreground = Palette.Muted;
            Border = Palette.MutedBorder;
        }
        else if (inherited)
        {
            Background = Palette.White;
            Foreground = fill == Palette.Light ? Palette.Medium : fill;
            Border = fill;
        }
        else
        {
            Background = fill;
            Foreground = fill == Palette.Light || fill == Palette.LightBlue ? Palette.Dark : Palette.White;
            Border = fill;
        }

        if (pending) Border = Palette.Amber;
        BorderWidth = new Thickness(pending ? 2.5 : 1.5);
        Tip = tip;
        RaiseAll();
    }

    private static int RoleRank(RoleDefinition r) => r.RoleTypeKind switch { 5 => 5, 6 => 4, 4 => 3, 3 => 2, 2 => 1, _ => 0 };

    private static Brush Fill(RoleDefinition r) => r.RoleTypeKind switch
    {
        5 => Palette.Dark,
        6 or 4 or 3 => Palette.Medium,
        2 => Palette.Light,
        _ => Palette.LightBlue,
    };

    private static string Short(RoleDefinition r) => r.RoleTypeKind switch
    {
        5 => "Full",
        3 => "Contrib",
        _ => r.Name.Length > 8 ? r.Name[..8] : r.Name,
    };
}

public sealed class MatrixRow : ObservableObject
{
    public string Name { get; init; } = "";

    public string Path { get; init; } = "";

    public string Glyph { get; init; } = "";

    public int Depth { get; init; }

    public bool IsEditable { get; init; }

    public bool IsUnique { get; init; }

    public string Badge => IsUnique ? "Unique" : "Inherits";

    public Brush BadgeBackground => IsUnique ? Palette.ChipAmberBg : Palette.ChipGrayBg;

    public Brush BadgeForeground => IsUnique ? Palette.ChipAmberFg : Palette.ChipGrayFg;

    public Thickness Indent => new(4 + Depth * 16, 0, 0, 0);

    public SecurableRef Target { get; init; } = SecurableRef.Web;

    public UniqueEntry? Entry { get; init; }

    public IReadOnlyList<RoleAssignment> Current { get; init; } = Array.Empty<RoleAssignment>();

    public IReadOnlyList<RoleAssignment> ParentCurrent { get; init; } = Array.Empty<RoleAssignment>();

    public MatrixCell[] Cells { get; set; } = Array.Empty<MatrixCell>();

    public ICommand? ResetCommand { get; init; }

    public Visibility ResetVisibility => IsEditable && IsUnique && Entry is not null ? Visibility.Visible : Visibility.Collapsed;
}

public sealed record PersonRow(string Path, string Type, string Level);

public sealed class MatrixViewModel : ObservableObject
{
    private const int MaxColumns = 9;

    private readonly MainViewModel _main;
    private ScanResult? _scan;
    private string _selectedLibrary = "All libraries";
    private string _peopleFilter = "";
    private int _mode;
    private Principal? _selectedPerson;

    public ObservableCollection<MatrixRow> Rows { get; } = new();

    public List<Principal> Columns { get; private set; } = new();

    public List<string> Libraries { get; private set; } = new() { "All libraries" };

    public List<Principal> People { get; private set; } = new();

    public ObservableCollection<PersonRow> PersonRows { get; } = new();

    public IReadOnlyList<RoleDefinition> Roles => _scan?.AssignableRoles.ToList() ?? new List<RoleDefinition>();

    public string ColumnsNote { get; private set; } = "";

    public string PersonNote { get; private set; } = "";

    public ICommand SetModeCommand { get; }

    public event Action? ColumnsChanged;

    public int Mode
    {
        get => _mode;
        set => Set(ref _mode, value);
    }

    public string SelectedLibrary
    {
        get => _selectedLibrary;
        set
        {
            if (Set(ref _selectedLibrary, value)) Rebuild();
        }
    }

    public string PeopleFilter
    {
        get => _peopleFilter;
        set
        {
            if (Set(ref _peopleFilter, value)) Rebuild();
        }
    }

    public Principal? SelectedPerson
    {
        get => _selectedPerson;
        set
        {
            if (Set(ref _selectedPerson, value)) RebuildPerson();
        }
    }

    public MatrixViewModel(MainViewModel main)
    {
        _main = main;
        SetModeCommand = new RelayCommand(p => Mode = int.Parse(p!.ToString()!));
        _main.Plan.Changes.CollectionChanged += (_, _) => RefreshCells();
    }

    public void Load(ScanResult scan)
    {
        _scan = scan;
        Libraries = new List<string> { "All libraries" }.Concat(scan.Libraries.Select(l => l.Title)).ToList();
        if (!Libraries.Contains(_selectedLibrary)) _selectedLibrary = "All libraries";
        People = scan.Principals.OrderBy(p => p.Title, StringComparer.OrdinalIgnoreCase).ToList();
        _selectedPerson = People.FirstOrDefault(p => p.Id == _selectedPerson?.Id) ?? People.FirstOrDefault();
        RaiseAll();
        Rebuild();
        RebuildPerson();
    }

    public void Choose(MatrixRow row, MatrixCell cell, RoleDefinition? role)
    {
        if (!row.IsEditable) return;
        var plan = _main.Plan;
        if (plan.FindSetRole(row.Target, cell.Principal.Id) is { } existing) plan.Remove(existing);

        var current = RolesFor(row.Current, cell.Principal.Id);
        var same = role is null ? current.Count == 0 : current.Count == 1 && current[0].Id == role.Id;
        if (!same) plan.SetRole(row.Target, row.Path, cell.Principal, role);
        else RefreshCells();
    }

    private void Rebuild()
    {
        Rows.Clear();
        if (_scan is null) return;
        var scan = _scan;

        Rows.Add(new MatrixRow
        {
            Name = "Site (default)",
            Path = "(site)",
            Glyph = "",
            IsEditable = false,
            IsUnique = true,
            Target = SecurableRef.Web,
            Current = scan.WebAssignments,
            ParentCurrent = scan.WebAssignments,
        });

        foreach (var lib in scan.Libraries.Where(l => _selectedLibrary == "All libraries" || l.Title == _selectedLibrary))
        {
            var libEntry = scan.Entries.FirstOrDefault(e => e.IsLibraryRoot && e.Library.Id == lib.Id);
            var libDisplay = Relative(scan, lib.RootUrl);
            Rows.Add(MakeRow(lib.Title, lib.Title, "", 0, libEntry, SecurableRef.ForList(lib.Id), scan.WebAssignments));

            foreach (var e in scan.Entries.Where(e => !e.IsLibraryRoot && e.Library.Id == lib.Id).OrderBy(e => e.DisplayPath, StringComparer.OrdinalIgnoreCase))
            {
                var depth = Math.Max(1, e.DisplayPath.Split('/').Length - libDisplay.Split('/').Length);
                Rows.Add(MakeRow(e.DisplayPath.Split('/').Last(), e.DisplayPath, e.IsFolder ? "" : "", depth, e, e.Ref, e.ParentAssignments));
            }
        }

        var pool = scan.Principals
            .Where(p => _peopleFilter.Length == 0 || p.Title.Contains(_peopleFilter.Trim(), StringComparison.OrdinalIgnoreCase))
            .Select(p => (Principal: p, Count: Rows.Count(r => RolesFor(r.Current, p.Id).Count > 0)))
            .OrderByDescending(x => x.Count)
            .ThenBy(x => x.Principal.Title, StringComparer.OrdinalIgnoreCase)
            .ToList();
        Columns = pool.Take(MaxColumns).Select(x => x.Principal).ToList();
        ColumnsNote = pool.Count > MaxColumns
            ? $"Showing the {MaxColumns} people and groups on the most items. Type in the filter to find others ({pool.Count} total)."
            : $"{pool.Count} people and groups.";
        Raise(nameof(ColumnsNote));

        foreach (var row in Rows) row.Cells = Columns.Select(c => new MatrixCell(c)).ToArray();
        ColumnsChanged?.Invoke();
        RefreshCells();
    }

    private MatrixRow MakeRow(string name, string path, string glyph, int depth, UniqueEntry? entry, SecurableRef target, IReadOnlyList<RoleAssignment> parent)
    {
        return new MatrixRow
        {
            Name = name,
            Path = path,
            Glyph = glyph,
            Depth = depth,
            IsEditable = true,
            IsUnique = entry is not null,
            Target = target,
            Entry = entry,
            Current = entry?.Assignments ?? parent,
            ParentCurrent = parent,
            ResetCommand = new RelayCommand(() => _main.Plan.Reset(target, path)),
        };
    }

    private void RefreshCells()
    {
        var plan = _main.Plan;
        foreach (var row in Rows)
        {
            var reset = plan.IsResetPending(row.Target);
            var baseList = reset ? row.ParentCurrent : row.Current;
            foreach (var cell in row.Cells)
            {
                var set = plan.FindSetRole(row.Target, cell.Principal.Id);
                IReadOnlyList<RoleDefinition> roles = set is not null
                    ? (set.Role is null ? Array.Empty<RoleDefinition>() : new[] { set.Role })
                    : RolesFor(baseList, cell.Principal.Id);
                var pending = set is not null
                    || (reset && !SameRoles(RolesFor(row.Current, cell.Principal.Id), RolesFor(row.ParentCurrent, cell.Principal.Id)));
                var inherited = !row.IsUnique || reset;
                var tip = set is not null ? "Pending change" : reset ? "Will inherit from the parent" : inherited ? "Inherited from the parent" : "Set on this item";
                cell.Update(roles, inherited, pending, $"{cell.Principal.Title}: {tip}");
            }
        }
    }

    private void RebuildPerson()
    {
        PersonRows.Clear();
        if (_scan is null || _selectedPerson is null) return;

        var web = RolesFor(_scan.WebAssignments, _selectedPerson.Id);
        if (web.Count > 0) PersonRows.Add(new PersonRow("(site default)", "Site", string.Join(", ", web.Select(r => r.Name))));
        foreach (var e in _scan.Entries)
        {
            var roles = RolesFor(e.Assignments, _selectedPerson.Id);
            if (roles.Count > 0) PersonRows.Add(new PersonRow(e.DisplayPath, e.TypeLabel, string.Join(", ", roles.Select(r => r.Name))));
        }

        PersonNote = $"{_selectedPerson.Title} has an entry on {PersonRows.Count} item{(PersonRows.Count == 1 ? "" : "s")}. This lists direct entries only. Access that comes through membership of a group isn't expanded yet.";
        Raise(nameof(PersonNote));
    }

    private static string Relative(ScanResult scan, string serverRelative)
    {
        var root = scan.WebServerRelativeUrl.TrimEnd('/');
        var text = root.Length > 0 && serverRelative.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? serverRelative[root.Length..] : serverRelative;
        return text.TrimStart('/');
    }

    private static List<RoleDefinition> RolesFor(IEnumerable<RoleAssignment> list, int principalId) =>
        list.Where(a => a.Principal.Id == principalId).SelectMany(a => a.EffectiveRoles).DistinctBy(r => r.Id).ToList();

    private static bool SameRoles(List<RoleDefinition> a, List<RoleDefinition> b) =>
        a.Count == b.Count && a.All(x => b.Any(y => y.Id == x.Id));
}

