using System.Diagnostics;
using System.IO;
using System.Windows.Input;
using Microsoft.Identity.Client;
using Microsoft.Win32;
using SpPerm.Core;

namespace SpPerm.App;

public sealed class MainViewModel : ObservableObject
{
    private readonly AppConfig _config = AppConfig.Load();
    private readonly SettingsStore _settings = SettingsStore.Load();
    private readonly ChangeLogStore _log = new(Path.Combine(AppConfig.DataDirectory, "changes"));
    private AuthService? _auth;
    private string _authHost = "";
    private CancellationTokenSource? _cts;

    private string _siteUrl = "";
    private string _statusText = "Enter your SharePoint site address and select Connect.";
    private string _signedInText = "Not signed in";
    private string _bannerText = "";
    private bool _isBusy;
    private bool _isIndeterminate;
    private double _progressValue;
    private bool _hasScan;
    private int _selectedTab;
    private int _pendingCount;
    private string _pendingSummary = "No pending changes";
    private bool _canUndo;

    public PlanBuilder Plan { get; } = new();

    public CleanupViewModel Cleanup { get; }

    public MatrixViewModel Matrix { get; }

    public ISharePointClient? Client { get; private set; }

    public ScanResult? Scan { get; private set; }

    public bool IsDemo { get; private set; }

    public string VersionText { get; } = "v" + (typeof(MainViewModel).Assembly.GetName().Version?.ToString(3) ?? "1.0");

    public string SiteUrl { get => _siteUrl; set => Set(ref _siteUrl, value); }

    public string StatusText { get => _statusText; set => Set(ref _statusText, value); }

    public string SignedInText { get => _signedInText; set => Set(ref _signedInText, value); }

    public string BannerText
    {
        get => _bannerText;
        set
        {
            if (Set(ref _bannerText, value)) Raise(nameof(HasBanner));
        }
    }

    public bool HasBanner => !string.IsNullOrEmpty(_bannerText);

    public bool IsBusy { get => _isBusy; set => Set(ref _isBusy, value); }

    public bool IsIndeterminate { get => _isIndeterminate; set => Set(ref _isIndeterminate, value); }

    public double ProgressValue { get => _progressValue; set => Set(ref _progressValue, value); }

    public bool HasScan { get => _hasScan; set => Set(ref _hasScan, value); }

    public int SelectedTab { get => _selectedTab; set => Set(ref _selectedTab, value); }

    public int PendingCount { get => _pendingCount; private set => Set(ref _pendingCount, value); }

    public string PendingSummary { get => _pendingSummary; private set => Set(ref _pendingSummary, value); }

    public bool CanUndo { get => _canUndo; private set => Set(ref _canUndo, value); }

    public ICommand ConnectCommand { get; }

    public ICommand DemoCommand { get; }

    public ICommand RescanCommand { get; }

    public ICommand ApplyCommand { get; }

    public ICommand DiscardCommand { get; }

    public ICommand UndoCommand { get; }

    public ICommand ExportCommand { get; }

    public ICommand OpenLogCommand { get; }

    public ICommand SignOutCommand { get; }

    public ICommand CancelCommand { get; }

    public MainViewModel()
    {
        Cleanup = new CleanupViewModel(this);
        Matrix = new MatrixViewModel(this);
        _siteUrl = _settings.LastSiteUrl;

        ConnectCommand = new AsyncRelayCommand(ConnectAsync, () => !IsBusy);
        DemoCommand = new AsyncRelayCommand(LoadDemoAsync, () => !IsBusy);
        RescanCommand = new AsyncRelayCommand(() => RunBusyAsync("Scanning…", ScanCoreAsync), () => !IsBusy && Client is not null);
        ApplyCommand = new AsyncRelayCommand(ApplyAsync, () => !IsBusy && PendingCount > 0);
        DiscardCommand = new RelayCommand(() => Plan.Clear(), () => !IsBusy && PendingCount > 0);
        UndoCommand = new AsyncRelayCommand(UndoAsync, () => !IsBusy && CanUndo);
        ExportCommand = new RelayCommand(ExportExcel, () => Scan is not null);
        OpenLogCommand = new RelayCommand(OpenLogFolder);
        SignOutCommand = new AsyncRelayCommand(SignOutAsync, () => !IsBusy && _auth is not null);
        CancelCommand = new RelayCommand(() => _cts?.Cancel(), () => IsBusy);

        Plan.Changes.CollectionChanged += (_, _) =>
        {
            PendingCount = Plan.Changes.Count;
            var folders = Plan.Changes.Select(c => c.Target).Distinct().Count();
            PendingSummary = PendingCount == 0
                ? "No pending changes"
                : $"{PendingCount} change{(PendingCount == 1 ? "" : "s")} across {folders} folder{(folders == 1 ? "" : "s")}";
        };
    }

    private async Task ConnectAsync()
    {
        if (!SiteUrlHelper.TryNormalize(SiteUrl, out var site, out var host, out var error))
        {
            StatusText = error;
            return;
        }

        if (!_config.IsConfigured)
        {
            BannerText = "This copy isn't set up for sign-in yet. Add the app registration's Client ID to appsettings.json next to the program (see the README), or try the demo data.";
            StatusText = "Sign-in isn't configured.";
            return;
        }

        await RunBusyAsync("Signing in…", async ct =>
        {
            if (_auth is null || _authHost != host)
            {
                _auth = await AuthService.CreateAsync(_config, host);
                _authHost = host;
            }

            var result = await _auth.SignInAsync(ct);
            SignedInText = $"Signed in as {_auth.Account}";

            var client = new SharePointRestClient(site, _auth.GetTokenAsync);
            StatusText = "Checking your permissions…";
            var capability = await client.ProbeCapabilitiesAsync(ct);
            var scopes = AuthService.ScopesFromToken(result.AccessToken);

            var notes = new List<string>();
            if (scopes.Count > 0 && !scopes.Contains("AllSites.FullControl", StringComparer.OrdinalIgnoreCase))
                notes.Add($"Your sign-in token doesn't include AllSites.FullControl (it has: {string.Join(", ", scopes)}). You can look around, but changes will be refused until an admin grants it.");
            if (!capability.CanManagePermissions)
                notes.Add(capability.Detail);
            BannerText = string.Join(" ", notes);

            Client = client;
            IsDemo = false;
            SiteUrl = site;
            _settings.LastSiteUrl = site;
            _settings.Save();
            Plan.Clear();
            await ScanCoreAsync(ct);
        });
    }

    private Task LoadDemoAsync() => RunBusyAsync("Loading demo data…", async ct =>
    {
        var fake = DemoData.Create();
        Client = fake;
        IsDemo = true;
        SiteUrl = fake.SiteUrl;
        SignedInText = "Demo mode (not signed in)";
        BannerText = "You're looking at sample data. Nothing here touches a real SharePoint site.";
        Plan.Clear();
        await ScanCoreAsync(ct);
    });

    private async Task ScanCoreAsync(CancellationToken ct)
    {
        var progress = new Progress<ScanProgress>(ReportProgress);
        var scan = await new ScanService(Client!).ScanAsync(progress, ct);
        Scan = scan;
        HasScan = true;
        Cleanup.Load(scan);
        Matrix.Load(scan);
        StatusText = $"Scanned {scan.ItemsScanned:N0} items. {scan.Entries.Count:N0} have their own permissions.";
        await RefreshUndoAsync();
    }

    private async Task ApplyAsync()
    {
        if (Client is null || Plan.Changes.Count == 0) return;

        var changes = Plan.Changes.ToList();
        var folders = changes.Select(c => c.Target).Distinct().Count();
        var notes = new List<string>();
        var resets = changes.OfType<ResetToInherit>().Count();
        if (resets > 0)
            notes.Add($"{resets} folder{(resets == 1 ? "" : "s")} will stop using their own permissions and take the parent's instead. What they have now is saved in the change log, so you can undo it.");
        var resetTargets = changes.OfType<ResetToInherit>().Select(r => r.Target).ToHashSet();
        var linkedResets = Scan?.Entries.Count(e => resetTargets.Contains(e.Ref) && e.HasSharingLinks) ?? 0;
        if (linkedResets > 0)
            notes.Add($"{linkedResets} of the items being reset have sharing links. Resetting removes those links, so anyone using them loses access.");
        if (changes.OfType<SetRole>().Any())
            notes.Add("A folder that currently inherits will stop inheriting first. Its existing access is copied over, so nobody loses access by accident.");
        if (IsDemo) notes.Add("Demo mode: these changes only affect the sample data.");

        var confirmed = Dialogs.Review(
            "Review changes",
            $"{changes.Count} change{(changes.Count == 1 ? "" : "s")} across {folders} folder{(folders == 1 ? "" : "s")}. Nothing is applied until you confirm.",
            changes.Select(c => c.Describe()),
            notes,
            "Apply changes");
        if (!confirmed) return;

        string? summary = null;
        await RunBusyAsync("Applying changes…", async ct =>
        {
            var actor = (await Client.GetCurrentUserAsync(ct)).Title;
            var batch = await new ChangeExecutor(Client, _log, actor).ExecuteAsync(changes, new Progress<ScanProgress>(ReportProgress), ct);
            Plan.Clear();

            summary = $"Changed {batch.ChangedCount} of {batch.Targets.Count} folder{(batch.Targets.Count == 1 ? "" : "s")}."
                + (batch.FailureCount > 0 ? $" {batch.FailureCount} failed." : "");
            if (batch.FailureCount > 0)
                Dialogs.Error(summary + "\n\n" + string.Join("\n", batch.Targets.Where(t => t.Error is not null).Select(t => $"• {t.Path}: {t.Error}")));

            await ScanCoreAsync(ct);
            StatusText = $"{summary} Rescanned: {Scan!.Entries.Count:N0} items now have their own permissions.";
        });
    }

    private async Task UndoAsync()
    {
        if (Client is null) return;
        var batch = await FindUndoableAsync();
        if (batch is null)
        {
            Dialogs.Info("There's nothing to undo for this site.");
            return;
        }

        var lines = batch.Targets.Where(t => t.Mutated).Select(t => $"{t.Path}: {string.Join("; ", t.Actions)}");
        var confirmed = Dialogs.Review(
            "Undo the last batch",
            $"Applied {batch.StartedAt:g} by {batch.Actor}. This puts each folder back the way it was before.",
            lines,
            new[] { "Anything someone else changed in these folders since then is overwritten by the earlier state." },
            "Undo changes");
        if (!confirmed) return;

        await RunBusyAsync("Undoing changes…", async ct =>
        {
            var actor = (await Client.GetCurrentUserAsync(ct)).Title;
            var result = await new ChangeExecutor(Client, _log, actor).UndoAsync(batch, new Progress<ScanProgress>(ReportProgress), ct);
            if (result.Failures > 0) Dialogs.Error("Some entries couldn't be restored:\n\n" + string.Join("\n", result.Messages.Where(m => m.StartsWith("Skipped") || m.StartsWith("Couldn't"))));
            await ScanCoreAsync(ct);
            StatusText = result.Failures == 0 ? $"Undone. {StatusText}" : $"Undone with {result.Failures} problem(s). {StatusText}";
        });
    }

    private async Task<BatchRecord?> FindUndoableAsync()
    {
        if (Client is null) return null;
        var batches = await _log.ListAsync(Client.SiteUrl);
        return batches.FirstOrDefault(b => b.UndoneAt is null && b.ChangedCount > 0);
    }

    private async Task RefreshUndoAsync() => CanUndo = await FindUndoableAsync() is not null;

    private void ExportExcel()
    {
        if (Scan is null) return;
        var dialog = new SaveFileDialog
        {
            Filter = "Excel workbook (*.xlsx)|*.xlsx",
            FileName = $"SharePoint permissions {DateTime.Now:yyyy-MM-dd}.xlsx",
        };
        if (dialog.ShowDialog() != true) return;

        try
        {
            ExcelExporter.Export(Scan, dialog.FileName);
            StatusText = $"Exported to {dialog.FileName}";
        }
        catch (IOException ex)
        {
            Dialogs.Error("Couldn't save the file. If it's open in Excel, close it and try again.\n\n" + ex.Message);
        }
    }

    private void OpenLogFolder()
    {
        Directory.CreateDirectory(_log.DirectoryPath);
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{_log.DirectoryPath}\"") { UseShellExecute = true });
    }

    private async Task SignOutAsync()
    {
        if (_auth is null) return;
        await _auth.SignOutAsync();
        _auth = null;
        _authHost = "";
        Client = null;
        Scan = null;
        HasScan = false;
        BannerText = "";
        Plan.Clear();
        SignedInText = "Not signed in";
        StatusText = "Signed out.";
    }

    private void ReportProgress(ScanProgress p)
    {
        if (p.Total > 0)
        {
            IsIndeterminate = false;
            ProgressValue = 100.0 * Math.Min(p.Done, p.Total) / p.Total;
            StatusText = $"{p.Phase}… {p.Done:N0} of {p.Total:N0}";
        }
        else
        {
            IsIndeterminate = true;
            StatusText = $"{p.Phase}…";
        }
    }

    private async Task RunBusyAsync(string status, Func<CancellationToken, Task> work)
    {
        _cts = new CancellationTokenSource();
        IsBusy = true;
        IsIndeterminate = true;
        StatusText = status;
        try
        {
            await work(_cts.Token);
        }
        catch (OperationCanceledException)
        {
            StatusText = "Cancelled.";
        }
        catch (Exception ex)
        {
            ReportError(ex);
        }
        finally
        {
            IsBusy = false;
            IsIndeterminate = false;
            _cts.Dispose();
            _cts = null;
        }
    }

    private void ReportError(Exception ex)
    {
        var text = ex.Message;
        if (ex is MsalException msal)
        {
            if (text.Contains("AADSTS65001", StringComparison.Ordinal) || text.Contains("AADSTS90094", StringComparison.Ordinal))
                BannerText = "An admin hasn't approved this app for SharePoint yet. Ask your Entra admin to grant admin consent for AllSites.FullControl.";
            else if (text.Contains("AADSTS50011", StringComparison.Ordinal) || text.Contains("redirect", StringComparison.OrdinalIgnoreCase))
                BannerText = "The app registration doesn't accept this sign-in address. In Entra, add http://localhost under Mobile and desktop applications.";
            text = "Sign-in didn't finish. " + text.Split('\n')[0];
        }

        StatusText = text;
    }
}
