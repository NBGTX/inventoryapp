using System.Windows;
using System.Windows.Controls;
using SpPerm.Core;

namespace SpPerm.App;

public partial class ReviewDialog : Window
{
    public ReviewDialog(string heading, string summary, IEnumerable<string> lines, IEnumerable<string> notes, string confirmText)
    {
        InitializeComponent();
        Owner = Application.Current.MainWindow;
        HeadText.Text = heading;
        SummaryText.Text = summary;
        Lines.ItemsSource = lines.ToList();
        var noteList = notes.ToList();
        Notes.ItemsSource = noteList;
        NotesBox.Visibility = noteList.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        ConfirmButton.Content = confirmText;
    }

    private void OnConfirm(object sender, RoutedEventArgs e) => DialogResult = true;
}

public sealed record PickItem(string Display, PrincipalCandidate Candidate, Principal? Known);

public partial class PickPeopleDialog : Window
{
    private readonly ISharePointClient _client;
    private IReadOnlyList<Principal>? _groups;

    public Principal? ResultPrincipal { get; private set; }

    public RoleDefinition? ResultRole { get; private set; }

    public PickPeopleDialog(ISharePointClient client, IEnumerable<RoleDefinition> roles, string targetText)
    {
        InitializeComponent();
        Owner = Application.Current.MainWindow;
        _client = client;
        TargetText.Text = targetText;
        var list = roles.ToList();
        RoleBox.ItemsSource = list;
        RoleBox.SelectedItem = list.FirstOrDefault(r => r.Name == "Read") ?? list.FirstOrDefault();
        Loaded += (_, _) => SearchBox.Focus();
    }

    private async void OnSearch(object sender, RoutedEventArgs e)
    {
        var query = SearchBox.Text.Trim();
        if (query.Length < 2)
        {
            ShowMessage("Type at least two letters of a name or email.");
            return;
        }

        ShowMessage("Searching…");
        try
        {
            _groups ??= await _client.GetSiteGroupsAsync(CancellationToken.None);
            var items = new List<PickItem>();
            foreach (var g in _groups.Where(g => g.Title.Contains(query, StringComparison.OrdinalIgnoreCase)))
                items.Add(new PickItem($"{g.Title}   (site group)", new PrincipalCandidate(g.Title, g.LoginName, null, g.Kind, g.Id), g));
            foreach (var c in await _client.SearchPrincipalsAsync(query, CancellationToken.None))
            {
                var kind = c.Kind == PrincipalKind.User ? "person" : "group";
                items.Add(new PickItem($"{c.DisplayName}   ({kind}{(c.Email is null ? "" : ", " + c.Email)})", c, null));
            }

            Results.ItemsSource = items;
            ShowMessage(items.Count == 0 ? "No matches. Try part of the person's email address." : "");
            if (items.Count > 0) Results.SelectedIndex = 0;
        }
        catch (SharePointException ex)
        {
            ShowMessage(ex.Message);
        }
    }

    private async void OnAdd(object sender, RoutedEventArgs e)
    {
        if (Results.SelectedItem is not PickItem item || RoleBox.SelectedItem is not RoleDefinition role)
        {
            ShowMessage("Search for a person or group, select one, and pick a permission level.");
            return;
        }

        try
        {
            ResultPrincipal = item.Known ?? await _client.EnsureUserAsync(item.Candidate.LoginName, CancellationToken.None);
            ResultRole = role;
            DialogResult = true;
        }
        catch (SharePointException ex)
        {
            ShowMessage(ex.Message);
        }
    }

    private void OnSearchKey(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == System.Windows.Input.Key.Enter) OnSearch(sender, e);
    }

    private void ShowMessage(string text)
    {
        MessageText.Text = text;
        MessageText.Visibility = text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
    }
}

public partial class ChooseDialog : Window
{
    public int SelectedIndexResult { get; private set; } = -1;

    public ChooseDialog(string title, string prompt, IEnumerable<string> options, string confirmText)
    {
        InitializeComponent();
        Owner = Application.Current.MainWindow;
        Title = title;
        PromptText.Text = prompt;
        List.ItemsSource = options.ToList();
        ConfirmButton.Content = confirmText;
        if (List.Items.Count > 0) List.SelectedIndex = 0;
    }

    private void OnConfirm(object sender, RoutedEventArgs e)
    {
        if (List.SelectedIndex < 0) return;
        SelectedIndexResult = List.SelectedIndex;
        DialogResult = true;
    }
}

public static class Dialogs
{
    private static Window? Owner => Application.Current.MainWindow;

    public static bool Review(string heading, string summary, IEnumerable<string> lines, IEnumerable<string> notes, string confirmText) =>
        new ReviewDialog(heading, summary, lines, notes, confirmText).ShowDialog() == true;

    public static (Principal Principal, RoleDefinition Role)? PickPeople(ISharePointClient client, IEnumerable<RoleDefinition> roles, string targetText)
    {
        var dialog = new PickPeopleDialog(client, roles, targetText);
        return dialog.ShowDialog() == true && dialog.ResultPrincipal is { } p && dialog.ResultRole is { } r ? (p, r) : null;
    }

    public static int Choose(string title, string prompt, IEnumerable<string> options, string confirmText)
    {
        var dialog = new ChooseDialog(title, prompt, options, confirmText);
        return dialog.ShowDialog() == true ? dialog.SelectedIndexResult : -1;
    }

    public static void Info(string message) =>
        MessageBox.Show(Owner, message, "SharePoint permissions manager", MessageBoxButton.OK, MessageBoxImage.Information);

    public static void Error(string message) =>
        MessageBox.Show(Owner, message, "SharePoint permissions manager", MessageBoxButton.OK, MessageBoxImage.Warning);
}
