using System.Windows;

namespace SpPerm.App;

public partial class App : Application
{
    public App()
    {
        DispatcherUnhandledException += (_, e) =>
        {
            MessageBox.Show(
                $"Something unexpected went wrong.\n\n{e.Exception.Message}",
                "SharePoint permissions manager", MessageBoxButton.OK, MessageBoxImage.Error);
            e.Handled = true;
        };
    }
}
