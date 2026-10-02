"""Parameterized SQL Server access for BG Tools (Timesheet Fix).

Runs queries via .NET SqlClient through powershell.exe with **Integrated Security**
— the signed-in tech's own Windows account, no credentials stored anywhere. Every
query is PARAMETERIZED (SqlParameter), never string-concatenated, so employee names
and week keys can't inject SQL. Read helpers return rows; the one write (unlock) uses
ExecuteNonQuery and reports the affected row count.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

_PS = r'''
param([string]$InFile)
$ErrorActionPreference = "Stop"
function Fail($m) { Write-Output (@{ __error__ = $m } | ConvertTo-Json -Compress); exit 0 }
function Fmt($v) {
  $ic = [Globalization.CultureInfo]::InvariantCulture
  if ($v -is [DateTime]) { return $v.ToString("yyyy-MM-ddTHH:mm:ss.fff", $ic) }
  if ($v -is [byte[]]) { return "0x" + (($v | ForEach-Object { $_.ToString("X2") }) -join "") }
  if ($v -is [bool]) { if ($v) { return "1" } else { return "0" } }
  return [Convert]::ToString($v, $ic)
}
try { $cfg = Get-Content -Raw -LiteralPath $InFile | ConvertFrom-Json } catch { Fail "bad input" }
$cs = "Server=$($cfg.server);Database=$($cfg.db);Integrated Security=True;TrustServerCertificate=True;Connect Timeout=15;Application Name=NBG Hub"
$cn = New-Object System.Data.SqlClient.SqlConnection $cs
try {
  $cn.Open()
  $cmd = $cn.CreateCommand()
  $cmd.CommandText = [string]$cfg.sql
  $cmd.CommandTimeout = 30
  if ($cfg.params) {
    foreach ($p in $cfg.params.PSObject.Properties) {
      $val = $p.Value; if ($null -eq $val) { $val = [DBNull]::Value }
      $null = $cmd.Parameters.AddWithValue("@" + $p.Name, $val)
    }
  }
  if ($cfg.nonquery) {
    Write-Output (@{ affected = [int]$cmd.ExecuteNonQuery() } | ConvertTo-Json -Compress)
  } else {
    $r = $cmd.ExecuteReader()
    $cols = @(); for ($i = 0; $i -lt $r.FieldCount; $i++) { $cols += $r.GetName($i) }
    $rows = @()
    while ($r.Read()) {
      $o = [ordered]@{}
      for ($i = 0; $i -lt $r.FieldCount; $i++) {
        $v = $r.GetValue($i)
        if ($cfg.exact) { $o[$cols[$i]] = $(if ($v -is [DBNull]) { $null } else { Fmt $v }) }
        else { $o[$cols[$i]] = $(if ($v -is [DBNull]) { "" } else { ([string]$v).Trim() }) }
      }
      $rows += $o
    }
    $r.Close()
    Write-Output (@{ rows = @($rows) } | ConvertTo-Json -Depth 5 -Compress)
  }
} catch { Fail $_.Exception.Message } finally { $cn.Close() }
'''


def run(server: str, db: str, sql: str, params: dict | None = None,
        nonquery: bool = False, timeout: int = 45, exact: bool = False) -> dict:
    """Execute one parameterized statement. Returns {"rows": [...]} for a query,
    {"affected": n} for a nonquery, or {"__error__": "<why>"} on failure.
    exact=True keeps NULL as None and writes dates (ISO), bits, bytes (0x..) and numbers
    in a culture-free form, untrimmed, so rows can be inserted back unchanged."""
    payload = {"server": server, "db": db, "sql": sql,
               "params": params or {}, "nonquery": bool(nonquery), "exact": bool(exact)}
    in_path = ps_path = None
    try:
        fd, in_path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        fd, ps_path = tempfile.mkstemp(suffix=".ps1")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(_PS)
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-File", ps_path, "-InFile", in_path],
            capture_output=True, text=True, timeout=timeout, creationflags=_NO_WINDOW,
        )
        txt = (proc.stdout or "").strip()
        if not txt:
            return {"__error__": (proc.stderr or "no output from SQL").strip()[:400] or "SQL unreachable"}
        return json.loads(txt)
    except subprocess.TimeoutExpired:
        return {"__error__": "SQL query timed out"}
    except Exception as e:
        return {"__error__": str(e)[:400]}
    finally:
        for p in (in_path, ps_path):
            try:
                if p:
                    os.remove(p)
            except OSError:
                pass
