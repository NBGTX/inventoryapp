using System.Collections.ObjectModel;
using System.Windows.Input;
using System.Windows.Media;
using SpPerm.Core;

namespace SpPerm.App;

public sealed record Chip(string Text, Brush Background, Brush Foreground);

public sealed class EntryRow : ObservableObject
{
    private bool _isSelected;
    private string _pendingText = "";

    public UniqueEntry Entry { get; }

    public IReadOnlyList<Chip> Chips { get; }

    public string Path => Entry.DisplayPath;

    public string Leaf => Entry.DisplayPath.Split('/').Last();

    public string Location => Entry.DisplayPath.Contains('/') ? Entry.DisplayPath[..Entry.DisplayPath.LastIndexOf('/')] : "";

    public string Subtext => $"{Entry.TypeLabel} · compared with {ParentName(Entry)}";

    public static string ParentName(UniqueEntry e) => e.ParentRef.Kind == SecurableKind.Web ? "the site" : e.ParentDisplayPath;

    public string Glyph => Entry.IsLibraryRoot ? "" : Entry.IsFolder ? "" : "";

    public string LastChanged
    {
        get
        {
            var d = Entry.Details;
            if (d?.Modified is null) return "";
            return string.IsNullOrEmpty(d.ModifiedBy) ? $"{d.Modified:MMM d, yyyy}" : $"{d.ModifiedBy} · {d.Modified:MMM d, yyyy}";
        }
    }

    public bool IsSelected { get => _isSelected; set => Set(ref _isSelected, value); }

    public string PendingText { get => _pendingText; set => Set(ref _pendingText, value); }

    public EntryRow(UniqueEntry entry)
    {
        Entry = entry;
        var chips = new List<Chip>();
        var diff = entry.Diff;
        if (diff.IsIdentical)
        {
            chips.Add(new Chip("Same as parent", Palette.ChipGrayBg, Palette.ChipGrayFg));
            if (entry.SafeToReset) chips.Add(new Chip("Safe to reset", Palette.ChipPaleBg, Palette.ChipPaleFg));
        }
        else
        {
            if (diff.AddedCount > 0) chips.Add(new Chip($"+{diff.AddedCount} added", Palette.ChipGreenBg, Palette.ChipGreenFg));
            if (diff.RemovedCount > 0) chips.Add(new Chip($"{diff.RemovedCount} removed", Palette.ChipRedBg, Palette.ChipRedFg));
            if (diff.ChangedCount > 0) chips.Add(new Chip($"{diff.ChangedCount} changed", Palette.ChipAmberBg, Palette.ChipAmberFg));
        }

        if (entry.HasSharingLinks) chips.Add(new Chip("Sharing link", Palette.ChipAmberBg, Palette.ChipAmberFg));
        if (entry.HasExternal) chips.Add(new Chip("External user", Palette.ChipAmberBg, Palette.ChipAmberFg));
        Chips = chips;
    }
}

public sealed class DetailRow : ObservableObject
{
    private string _pendingText = "";

    public Principal Principal { get; }

    public string Name => Principal.Title;

    public string KindText => Principal.KindLabel;

    public string Level { get; }

    public string StatusText { get; }

    public Brush StatusBrush { get; }

    public bool CanRemove { get; }

    public bool IsStruck { get; }

    public ICommand RemoveCommand { get; }

    public string PendingText { get => _pendingText; set { if (Set(ref _pendingText, value)) Raise(nameof(HasPending)); } }

    public bool HasPending => _pendingText.Length > 0;

    public DetailRow(DiffRow row, Action<Principal> remove)
    {
        Principal = row.Principal;
        Level = row.Status == DiffStatus.Removed ? row.ParentLevel : row.Level;
        IsStruck = row.Status == DiffStatus.Removed;
        CanRemove = row.Status != DiffStatus.Removed;
        (StatusText, StatusBrush) = row.Status switch
        {
            DiffStatus.Added => ("Added here", Palette.ChipGreenFg),
            DiffStatus.Removed => ("Removed here", Palette.ChipRedFg),
            DiffStatus.Changed => ($"Changed (parent: {row.ParentLevel})", Palette.ChipAmberFg),
            _ => ("Same as parent", Palette.Muted),
        };
        RemoveCommand = new RelayCommand(() => remove(Principal), () => CanRemove);
    }
}

public sealed class CleanupViewModel : ObservableObject
{
    private readonly MainViewModel _main;
    private List<EntryRow> _all = new();
    private int _filter;
    private string _search = "";
    private EntryRow? _selected;
    private int _checkedCount;

    public ObservableCollection<EntryRow> Rows { get; } = new();

    public ObservableCollection<DetailRow> DetailRows { get; } = new();

    public string TotalItemsText { get; private set; } = "0";

    public string UniqueText { get; private set; } = "0";

    public string UniqueSubText { get; private set; } = "";

    public string DirectText { get; private set; } = "0";

    public string DirectSubText { get; private set; } = "";

    public string LinksText { get; private set; } = "0";

    public string LinksSubText { get; private set; } = "";

    public string AllLabel { get; private set; } = "All";

    public string SafeLabel { get; private set; } = "Safe to reset";

    public string DirectLabel { get; private set; } = "Direct users";

    public string ExternalLabel { get; private set; } = "External users";

    public string LinksLabel { get; private set; } = "Sharing links";

    public string DiffersLabel { get; private set; } = "Differs from parent";

    public string ListHeader { get; private set; } = "";

    public int Filter
    {
        get => _filter;
        set
        {
            if (Set(ref _filter, value)) ApplyFilter();
        }
    }

    public string Search
    {
        get => _search;
        set
        {
            if (Set(ref _search, value)) ApplyFilter();
        }
    }

    public EntryRow? Selected
    {
        get => _selected;
        set
        {
            if (Set(ref _selected, value)) BuildDetail();
        }
    }

    public bool HasDetail => _selected is not null;

    public string DetailTitle => _selected?.Path ?? "";

    public string DetailSubtitle => _selected is null ? "" : $"{_selected.Entry.TypeLabel} · compared with {EntryRow.ParentName(_selected.Entry)}";

    public string DetailBanner { get; private set; } = "";

    public int CheckedCount { get => _checkedCount; private set { if (Set(ref _checkedCount, value)) Raise(nameof(BarText)); } }

    public string BarText => CheckedCount > 0
        ? $"{CheckedCount} selected"
        : _selected is not null ? "1 highlighted" : "Tick folders to act on several at once";

    public ICommand SetFilterCommand { get; }

    public ICommand ResetSelectedCommand { get; }

    public ICommand AddPeopleCommand { get; }

    public ICommand RemoveUserCommand { get; }

    public ICommand SelectSafeCommand { get; }

    public ICommand ClearSelectionCommand { get; }

    public ICommand ResetThisCommand { get; }

    public ICommand AddPeopleHereCommand { get; }

    public CleanupViewModel(MainViewModel main)
    {
        _main = main;
        SetFilterCommand = new RelayCommand(p => Filter = int.Parse(p!.ToString()!));
        ResetSelectedCommand = new RelayCommand(() => QueueReset(Targets()), () => Targets().Count > 0);
        AddPeopleCommand = new RelayCommand(() => AddPeople(Targets()), () => Targets().Count > 0);
        RemoveUserCommand = new RelayCommand(() => RemoveUser(Targets()), () => Targets().Count > 0);
        SelectSafeCommand = new RelayCommand(SelectSafe, () => _all.Any(r => r.Entry.SafeToReset));
        ClearSelectionCommand = new RelayCommand(ClearSelection, () => CheckedCount > 0);
        ResetThisCommand = new RelayCommand(() => QueueReset(new List<EntryRow> { _selected! }), () => _selected is not null);
        AddPeopleHereCommand = new RelayCommand(() => AddPeople(new List<EntryRow> { _selected! }), () => _selected is not null);
        _main.Plan.Changes.CollectionChanged += (_, _) => RefreshPending();
    }

    public void Load(ScanResult scan)
    {
        foreach (var r in _all) r.PropertyChanged -= OnRowChanged;
        _all = scan.Entries.Select(e => new EntryRow(e)).ToList();
        foreach (var r in _all) r.PropertyChanged += OnRowChanged;

        var directGrants = scan.Entries.Sum(e => e.Assignments.Count(a => !a.IsLimitedOnly && a.Principal.IsUser));
        var directFolders = scan.Entries.Count(e => e.HasDirectUsers);
        var links = scan.Entries.SelectMany(e => e.Assignments).Where(a => !a.IsLimitedOnly && a.Principal.IsSharingLink).Select(a => a.Principal.Id).Distinct().Count();
        var linkFolders = scan.Entries.Count(e => e.HasSharingLinks);
        var externalFolders = scan.Entries.Count(e => e.HasExternal);
        var safe = scan.Entries.Count(e => e.SafeToReset);

        TotalItemsText = scan.ItemsScanned.ToString("N0");
        UniqueText = scan.Entries.Count.ToString("N0");
        UniqueSubText = safe == 1 ? "1 safe to reset" : $"{safe} safe to reset";
        DirectText = directGrants.ToString("N0");
        DirectSubText = $"across {directFolders:N0} item{(directFolders == 1 ? "" : "s")}";
        LinksText = links.ToString("N0");
        LinksSubText = $"on {linkFolders:N0} item{(linkFolders == 1 ? "" : "s")}";
        AllLabel = $"All with own permissions {scan.Entries.Count}";
        SafeLabel = $"Safe to reset {safe}";
        DirectLabel = $"Direct users {scan.Entries.Count(e => e.HasDirectUsers)}";
        ExternalLabel = $"External users {externalFolders}";
        LinksLabel = $"Sharing links {linkFolders}";
        DiffersLabel = $"Differs from parent {scan.Entries.Count(e => !e.Diff.IsIdentical)}";
        RaiseAll();

        ApplyFilter();
        RefreshPending();
    }

    private void ApplyFilter()
    {
        var keep = _selected?.Entry.Ref;
        IEnumerable<EntryRow> rows = _all;
        rows = _filter switch
        {
            1 => rows.Where(r => r.Entry.SafeToReset),
            2 => rows.Where(r => r.Entry.HasDirectUsers),
            3 => rows.Where(r => r.Entry.HasExternal),
            4 => rows.Where(r => !r.Entry.Diff.IsIdentical),
            5 => rows.Where(r => r.Entry.HasSharingLinks),
            _ => rows,
        };
        if (!string.IsNullOrWhiteSpace(_search))
            rows = rows.Where(r => r.Path.Contains(_search.Trim(), StringComparison.OrdinalIgnoreCase));

        Rows.Clear();
        foreach (var r in rows) Rows.Add(r);
        ListHeader = $"{Rows.Count:N0} of {_all.Count:N0} items shown";
        Raise(nameof(ListHeader));
        Selected = Rows.FirstOrDefault(r => r.Entry.Ref == keep);
        UpdateChecked();
    }

    private void OnRowChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(EntryRow.IsSelected)) UpdateChecked();
    }

    private void UpdateChecked() => CheckedCount = _all.Count(r => r.IsSelected);

    private List<EntryRow> Targets()
    {
        var ticked = _all.Where(r => r.IsSelected).ToList();
        if (ticked.Count > 0) return ticked;
        return _selected is null ? new List<EntryRow>() : new List<EntryRow> { _selected };
    }

    private void SelectSafe()
    {
        foreach (var r in _all) r.IsSelected = r.Entry.SafeToReset;
        Filter = 1;
    }

    private void ClearSelection()
    {
        foreach (var r in _all) r.IsSelected = false;
    }

    private void QueueReset(List<EntryRow> rows)
    {
        foreach (var r in rows) _main.Plan.Reset(r.Entry.Ref, r.Entry.DisplayPath);
    }

    private void AddPeople(List<EntryRow> rows)
    {
        if (_main.Client is null || _main.Scan is null) return;
        var text = rows.Count == 1 ? rows[0].Path : $"{rows.Count} items selected";
        if (Dialogs.PickPeople(_main.Client, _main.Scan.AssignableRoles, $"They'll be added to: {text}") is not { } pick) return;
        foreach (var r in rows) _main.Plan.SetRole(r.Entry.Ref, r.Entry.DisplayPath, pick.Principal, pick.Role);
    }

    private void RemoveUser(List<EntryRow> rows)
    {
        var people = rows
            .SelectMany(r => r.Entry.Assignments)
            .Where(a => !a.IsLimitedOnly)
            .Select(a => a.Principal)
            .DistinctBy(p => p.Id)
            .OrderBy(p => p.Title, StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (people.Count == 0) return;

        var index = Dialogs.Choose(
            "Remove a person or group",
            $"Who should be removed from the {(rows.Count == 1 ? "selected item" : rows.Count + " selected items")}?",
            people.Select(p => $"{p.Title}   ({p.KindLabel})"),
            "Add to changes");
        if (index < 0) return;

        var person = people[index];
        foreach (var r in rows.Where(r => r.Entry.Assignments.Any(a => a.Principal.Id == person.Id && !a.IsLimitedOnly)))
            _main.Plan.SetRole(r.Entry.Ref, r.Entry.DisplayPath, person, null);
    }

    private void BuildDetail()
    {
        DetailRows.Clear();
        if (_selected is not null)
        {
            foreach (var row in _selected.Entry.Diff.Rows)
                DetailRows.Add(new DetailRow(row, p => _main.Plan.SetRole(_selected.Entry.Ref, _selected.Entry.DisplayPath, p, null)));
            var d = _selected.Entry.Diff;
            DetailBanner = _selected.Entry.IsLibraryRoot
                ? $"This library has its own permissions. {d.Summary}."
                : d.IsIdentical
                    ? "Has its own permissions, but they match the parent exactly. Resetting is safe."
                    : $"Has its own permissions that differ from the parent: {d.Summary}.";
        }

        Raise(nameof(HasDetail));
        Raise(nameof(DetailTitle));
        Raise(nameof(DetailSubtitle));
        Raise(nameof(DetailBanner));
        Raise(nameof(BarText));
        RefreshPending();
    }

    private void RefreshPending()
    {
        var plan = _main.Plan;
        foreach (var r in _all)
        {
            if (plan.IsResetPending(r.Entry.Ref)) r.PendingText = "Reset";
            else
            {
                var n = plan.Changes.OfType<SetRole>().Count(s => s.Target == r.Entry.Ref);
                r.PendingText = n == 0 ? "" : n == 1 ? "1 change" : $"{n} changes";
            }
        }

        if (_selected is null) return;
        foreach (var d in DetailRows)
        {
            var set = plan.FindSetRole(_selected.Entry.Ref, d.Principal.Id);
            d.PendingText = set is null ? "" : set.Role is null ? "Will be removed" : $"Will become {set.Role.Name}";
        }
    }
}

