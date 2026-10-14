using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace SpPerm.App;

public partial class MainWindow : Window
{
    private readonly MainViewModel _vm = new();

    public MainWindow()
    {
        InitializeComponent();
        DataContext = _vm;
        Title = $"SharePoint permissions manager {_vm.VersionText}";

        var args = Environment.GetCommandLineArgs();
        var snapshotAt = Array.FindIndex(args, a => a.Equals("--snapshot", StringComparison.OrdinalIgnoreCase));
        Loaded += async (_, _) =>
        {
            if (snapshotAt >= 0 && snapshotAt + 1 < args.Length) await RunSnapshotsAsync(args[snapshotAt + 1]);
            else if (args.Contains("--demo", StringComparer.OrdinalIgnoreCase)) _vm.DemoCommand.Execute(null);
        };
    }

    // Developer aid: renders the demo screens to PNG files (works without a visible desktop) and exits.
    private async Task RunSnapshotsAsync(string directory)
    {
        Directory.CreateDirectory(directory);
        _vm.DemoCommand.Execute(null);
        for (var i = 0; i < 100 && !_vm.HasScan; i++) await Task.Delay(100);

        _vm.Cleanup.Selected = _vm.Cleanup.Rows.FirstOrDefault(r => r.Path.EndsWith("2026 budget", StringComparison.OrdinalIgnoreCase));
        await Save(Path.Combine(directory, "1-cleanup.png"));

        _vm.Cleanup.SelectSafeCommand.Execute(null);
        _vm.Cleanup.ResetSelectedCommand.Execute(null);
        await Save(Path.Combine(directory, "2-cleanup-pending.png"));
        _vm.Plan.Clear();

        _vm.SelectedTab = 1;
        var vendor = _vm.Matrix.Rows.First(r => r.Name == "Vendor contracts");
        var edit = _vm.Matrix.Roles.First(r => r.Name == "Edit");
        _vm.Matrix.Choose(vendor, vendor.Cells.First(c => c.Principal.Title == "Contractors"), edit);
        var safety = _vm.Matrix.Rows.First(r => r.Name == "Onboarding");
        _vm.Matrix.Choose(safety, safety.Cells.First(c => c.Principal.Title == "Demo Visitors"), _vm.Matrix.Roles.First(r => r.Name == "Read"));
        await Save(Path.Combine(directory, "3-matrix.png"));

        Application.Current.Shutdown();
    }

    private async Task Save(string file)
    {
        await Dispatcher.Yield(DispatcherPriority.ApplicationIdle);
        UpdateLayout();
        await Task.Delay(300);
        var width = (int)ActualWidth;
        var height = (int)ActualHeight;
        var bitmap = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(this);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        await using var stream = File.Create(file);
        encoder.Save(stream);
    }
}
