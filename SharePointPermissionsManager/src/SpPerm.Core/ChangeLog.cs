using System.Text.Json;
using System.Text.Json.Serialization;

namespace SpPerm.Core;

public sealed record RoleSnapshot(int Id, string Name, int RoleTypeKind);

public sealed record PrincipalSnapshot(int Id, string Title, string LoginName, string? Email, PrincipalKind Kind, List<RoleSnapshot> Roles);

public sealed class TargetRecord
{
    public SecurableRef Target { get; set; } = SecurableRef.Web;

    public string Path { get; set; } = "";

    public bool WasUnique { get; set; }

    public bool Mutated { get; set; }

    public List<PrincipalSnapshot> Before { get; set; } = new();

    public List<string> Actions { get; set; } = new();

    public string? Error { get; set; }
}

public sealed class BatchRecord
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public DateTime StartedAt { get; set; } = DateTime.Now;

    public DateTime? FinishedAt { get; set; }

    public DateTime? UndoneAt { get; set; }

    public string Actor { get; set; } = "";

    public string SiteUrl { get; set; } = "";

    public List<TargetRecord> Targets { get; set; } = new();

    public int FailureCount => Targets.Count(t => t.Error is not null);

    public int ChangedCount => Targets.Count(t => t.Mutated);
}

public sealed class ChangeLogStore
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    private readonly string _directory;

    public ChangeLogStore(string directory)
    {
        _directory = directory;
        Directory.CreateDirectory(directory);
    }

    public string DirectoryPath => _directory;

    public async Task SaveAsync(BatchRecord batch)
    {
        var file = Path.Combine(_directory, $"{batch.StartedAt:yyyyMMdd-HHmmss}-{batch.Id:N}.json");
        await File.WriteAllTextAsync(file, JsonSerializer.Serialize(batch, Options));
    }

    public async Task<IReadOnlyList<BatchRecord>> ListAsync(string? siteUrl = null)
    {
        var result = new List<BatchRecord>();
        foreach (var file in Directory.EnumerateFiles(_directory, "*.json").OrderByDescending(f => f))
        {
            try
            {
                var batch = JsonSerializer.Deserialize<BatchRecord>(await File.ReadAllTextAsync(file), Options);
                if (batch is null) continue;
                if (siteUrl is null || string.Equals(batch.SiteUrl, siteUrl, StringComparison.OrdinalIgnoreCase)) result.Add(batch);
            }
            catch (JsonException) { }
        }

        return result;
    }
}
