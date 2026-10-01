using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace NbgwHub.Web;

public record Division(string Id, string Name, string CompanyName, string IntuneCategory,
    string SpHostname, string SpSitePath, string AdDomain, string SqlServer,
    string SitesJson, string AccessJson, bool Enabled);

/// <summary>SQLite store: divisions (tenants), per-division hub documents, audit trail.</summary>
public class Db
{
    readonly string _cs;
    public Db(IConfiguration cfg, IWebHostEnvironment env)
    {
        var p = cfg["Data:Path"] ?? "App_Data/nbgwhub.db";
        if (!Path.IsPathRooted(p)) p = Path.Combine(env.ContentRootPath, p);
        Directory.CreateDirectory(Path.GetDirectoryName(p)!);
        _cs = $"Data Source={p}";
        Init();
    }

    public SqliteConnection Open()
    {
        var c = new SqliteConnection(_cs);
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;";
        cmd.ExecuteNonQuery();
        return c;
    }

    void Init()
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS divisions(
              id TEXT PRIMARY KEY, name TEXT NOT NULL, company_name TEXT NOT NULL,
              intune_category TEXT NOT NULL, sp_hostname TEXT, sp_site_path TEXT,
              ad_domain TEXT, sql_server TEXT, sites_json TEXT NOT NULL DEFAULT '[]',
              access_json TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS hub_docs(
              division_id TEXT NOT NULL, kind TEXT NOT NULL, doc_id TEXT NOT NULL, json TEXT NOT NULL,
              updated_utc TEXT NOT NULL, updated_by TEXT, PRIMARY KEY(division_id, kind, doc_id));
            CREATE TABLE IF NOT EXISTS audit(
              id INTEGER PRIMARY KEY AUTOINCREMENT, division_id TEXT, utc TEXT NOT NULL, actor TEXT, action TEXT, detail TEXT);
            """;
        cmd.ExecuteNonQuery();
        cmd.CommandText = "SELECT COUNT(*) FROM divisions";
        if ((long)cmd.ExecuteScalar()! == 0) SeedNbgw(c);
    }

    // Seed mirrors the values hardcoded in the desktop app (graph.py / app.py).
    static void SeedNbgw(SqliteConnection c)
    {
        var sites = JsonSerializer.Serialize(new[] {
            new { code = "LTR", name = "Lathrop, CA",      cityPrefix = "lathrop", devicePrefixes = new[] { "BGLTR", "BGCCN", "BGMOD" } },
            new { code = "BRI", name = "Brigham City, UT", cityPrefix = "brigham", devicePrefixes = new[] { "BGBRI" } } });
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            INSERT INTO divisions(id,name,company_name,intune_category,sp_hostname,sp_site_path,ad_domain,sql_server,sites_json)
            VALUES('nbgw','Nucor Buildings Group West','Nucor Buildings Group West','NBGW',
                   'nucor.sharepoint.com','/sites/NBGW/systems','bg.nucorsteel.local','BGBRISQL07',$sites)
            """;
        cmd.Parameters.AddWithValue("$sites", sites);
        cmd.ExecuteNonQuery();
    }

    static string S(SqliteDataReader r, int i) => r.IsDBNull(i) ? "" : r.GetString(i);

    public List<Division> Divisions()
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id,name,company_name,intune_category,sp_hostname,sp_site_path,ad_domain,sql_server,sites_json,access_json,enabled FROM divisions WHERE enabled=1 ORDER BY name";
        using var r = cmd.ExecuteReader();
        var l = new List<Division>();
        while (r.Read())
            l.Add(new Division(S(r, 0), S(r, 1), S(r, 2), S(r, 3), S(r, 4), S(r, 5), S(r, 6), S(r, 7), S(r, 8), S(r, 9), r.GetInt32(10) == 1));
        return l;
    }

    public JsonElement? GetDoc(string division, string kind, string id = "main")
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT json FROM hub_docs WHERE division_id=$d AND kind=$k AND doc_id=$i";
        cmd.Parameters.AddWithValue("$d", division);
        cmd.Parameters.AddWithValue("$k", kind);
        cmd.Parameters.AddWithValue("$i", id);
        var s = cmd.ExecuteScalar() as string;
        return s == null ? null : JsonDocument.Parse(s).RootElement.Clone();
    }

    public void PutDoc(string division, string kind, string id, string json, string actor)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            INSERT INTO hub_docs(division_id,kind,doc_id,json,updated_utc,updated_by) VALUES($d,$k,$i,$j,$u,$a)
            ON CONFLICT(division_id,kind,doc_id) DO UPDATE SET json=$j, updated_utc=$u, updated_by=$a
            """;
        cmd.Parameters.AddWithValue("$d", division);
        cmd.Parameters.AddWithValue("$k", kind);
        cmd.Parameters.AddWithValue("$i", id);
        cmd.Parameters.AddWithValue("$j", json);
        cmd.Parameters.AddWithValue("$u", DateTime.UtcNow.ToString("o"));
        cmd.Parameters.AddWithValue("$a", actor);
        cmd.ExecuteNonQuery();
    }

    public void Audit(string division, string actor, string action, string detail)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "INSERT INTO audit(division_id,utc,actor,action,detail) VALUES($d,$u,$a,$x,$t)";
        cmd.Parameters.AddWithValue("$d", division);
        cmd.Parameters.AddWithValue("$u", DateTime.UtcNow.ToString("o"));
        cmd.Parameters.AddWithValue("$a", actor);
        cmd.Parameters.AddWithValue("$x", action);
        cmd.Parameters.AddWithValue("$t", detail);
        cmd.ExecuteNonQuery();
    }
}
