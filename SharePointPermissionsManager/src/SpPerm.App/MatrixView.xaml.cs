using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;

namespace SpPerm.App;

public partial class MatrixView : UserControl
{
    private readonly List<DataGridColumn> _dynamic = new();

    public MatrixView()
    {
        InitializeComponent();
        DataContextChanged += (_, e) =>
        {
            if (e.OldValue is MatrixViewModel old) old.ColumnsChanged -= RebuildColumns;
            if (e.NewValue is MatrixViewModel vm)
            {
                vm.ColumnsChanged += RebuildColumns;
                RebuildColumns();
            }
        };
    }

    private void RebuildColumns()
    {
        foreach (var column in _dynamic) MatrixGrid.Columns.Remove(column);
        _dynamic.Clear();
        if (DataContext is not MatrixViewModel vm) return;

        for (var j = 0; j < vm.Columns.Count; j++)
        {
            var principal = vm.Columns[j];
            var header = new TextBlock
            {
                Text = principal.Title,
                TextAlignment = TextAlignment.Center,
                TextWrapping = TextWrapping.Wrap,
                MaxWidth = 92,
                ToolTip = $"{principal.Title} ({principal.KindLabel})",
            };
            var column = new DataGridTemplateColumn
            {
                Header = header,
                Width = 100,
                CellTemplate = CellTemplate(j),
            };
            MatrixGrid.Columns.Add(column);
            _dynamic.Add(column);
        }
    }

    private DataTemplate CellTemplate(int index)
    {
        var button = new FrameworkElementFactory(typeof(Button));
        button.SetBinding(Button.ContentProperty, new Binding($"Cells[{index}].Label"));
        button.SetBinding(Control.BackgroundProperty, new Binding($"Cells[{index}].Background"));
        button.SetBinding(Control.ForegroundProperty, new Binding($"Cells[{index}].Foreground"));
        button.SetBinding(Control.BorderBrushProperty, new Binding($"Cells[{index}].Border"));
        button.SetBinding(Control.BorderThicknessProperty, new Binding($"Cells[{index}].BorderWidth"));
        button.SetBinding(FrameworkElement.ToolTipProperty, new Binding($"Cells[{index}].Tip"));
        button.SetValue(FrameworkElement.TagProperty, index);
        button.SetValue(FrameworkElement.MinWidthProperty, 66.0);
        button.SetValue(FrameworkElement.MarginProperty, new Thickness(2, 3, 2, 3));
        button.SetValue(Control.PaddingProperty, new Thickness(4, 3, 4, 3));
        button.SetValue(Control.FontSizeProperty, 11.0);
        button.AddHandler(System.Windows.Controls.Primitives.ButtonBase.ClickEvent, new RoutedEventHandler(OnCellClick));
        return new DataTemplate { VisualTree = button };
    }

    private void OnCellClick(object sender, RoutedEventArgs e)
    {
        if (sender is not Button button || button.DataContext is not MatrixRow row || DataContext is not MatrixViewModel vm) return;
        if (!row.IsEditable || button.Tag is not int index || index >= row.Cells.Length) return;

        var cell = row.Cells[index];
        var menu = new ContextMenu { PlacementTarget = button, Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom };

        var none = new MenuItem { Header = "No access" };
        none.Click += (_, _) => vm.Choose(row, cell, null);
        menu.Items.Add(none);
        menu.Items.Add(new Separator());
        foreach (var role in vm.Roles)
        {
            var item = new MenuItem { Header = role.Name };
            var captured = role;
            item.Click += (_, _) => vm.Choose(row, cell, captured);
            menu.Items.Add(item);
        }

        menu.IsOpen = true;
    }
}
