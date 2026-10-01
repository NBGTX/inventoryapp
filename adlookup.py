"""On-prem Active Directory lookups for the NBGW Hub.

Used by the dashboard's "No Intune check-in" drill to show where a stale device
still LIVES (AD vs Entra vs Intune), which helps decide whether it needs cleanup.

We query on-prem AD (default domain bg.nucorsteel.local) with .NET's
DirectorySearcher via powershell.exe — no RSAT/ActiveDirectory module required,
and it authenticates as the signed-in user (Kerberos) on a domain-joined machine.
Read-only: it only searches for computer objects, never modifies anything.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile

# Reads {domain, names[]} from a JSON file, emits {NAME: {found, enabled,
# last_logon, os, dn}} as JSON. Kept as a file (not inline -command) to avoid
# any quoting pitfalls with the hostname list.
_PS = r'''
param([string]$InFile)
$ErrorActionPreference = "Stop"
function Fail($m) { Write-Output (@{ __error__ = $m } | ConvertTo-Json -Compress); exit 0 }
try {
  $cfg = Get-Content -Raw -LiteralPath $InFile | ConvertFrom-Json
  $domain = [string]$cfg.domain
} catch { Fail "bad input: $($_.Exception.Message)" }

$root = New-Object System.DirectoryServices.DirectoryEntry("LDAP://$domain")
function NewSearcher($filter, $size) {
  $s = New-Object System.DirectoryServices.DirectorySearcher($root)
  $s.Filter = $filter
  $s.SizeLimit = $size
  # Fail fast instead of hanging when there's no real DC line-of-sight (off VPN etc.)
  $s.ClientTimeout = [TimeSpan]::FromSeconds(20)
  $s.ServerTimeLimit = [TimeSpan]::FromSeconds(20)
  return $s
}

# SENTINEL: confirm AD is actually answering (not unreachable / silently empty).
# A broad computer search must return at least one result. This does NOT require the
# querying PC to be a domain member — it may be Entra/Azure-AD-joined — only that the
# directory responds. (Authoritativeness of specific cn= lookups is verified by the
# caller via known-active "control" devices, so a flaky DC can't cause false removals.)
try {
  $sen = NewSearcher "(objectCategory=computer)" 3
  if ($null -eq $sen.FindOne()) { Fail "AD returned no computers (unreachable?)" }
} catch { Fail "AD search unavailable: $($_.Exception.Message)" }

$out = @{}
foreach ($n in $cfg.names) {
  $rec = @{ found = $false }
  try {
    $s = NewSearcher "(&(objectCategory=computer)(cn=$n))" 1
    foreach ($p in "distinguishedName","lastLogonTimestamp","userAccountControl","operatingSystem") { $null = $s.PropertiesToLoad.Add($p) }
    $r = $s.FindOne()
    if ($null -ne $r) {
      $p = $r.Properties
      $uac = [int]($p["useraccountcontrol"][0])
      $last = ""
      $llt = $p["lastlogontimestamp"][0]
      if ($llt) { $last = [DateTime]::FromFileTimeUtc([Int64]$llt).ToString("yyyy-MM-dd") }
      $rec = @{
        found = $true
        enabled = (($uac -band 2) -eq 0)
        last_logon = $last
        os = [string]($p["operatingSystem"][0])
        dn = [string]($p["distinguishedName"][0])
      }
    }
  } catch { $rec = @{ found = $false } }
  $out[[string]$n] = $rec
}
Write-Output ($out | ConvertTo-Json -Depth 4 -Compress)
'''

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)   # don't flash a console


def ad_lookup(hostnames, domain: str = "bg.nucorsteel.local", timeout: int = 90) -> dict:
    """Return {hostname_lower: {found, enabled, last_logon, os, dn}} for the given
    hostnames from on-prem AD. On failure returns {"__error__": "<why>"}; when AD is
    simply unreachable (e.g. off the corporate network) that error lets the caller
    show "AD: unavailable" rather than falsely reporting devices as absent."""
    names = sorted({(h or "").strip() for h in (hostnames or []) if (h or "").strip()})
    if not names:
        return {}
    in_path = ps_path = None
    try:
        fd, in_path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"domain": domain, "names": names}, f)
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
            return {"__error__": (proc.stderr or "no output from AD query").strip()[:300]}
        data = json.loads(txt)
        if isinstance(data, dict) and "__error__" in data:
            return {"__error__": str(data["__error__"])[:300]}
        return {str(k).lower(): v for k, v in (data or {}).items()}
    except subprocess.TimeoutExpired:
        return {"__error__": "AD query timed out"}
    except Exception as e:
        return {"__error__": str(e)[:300]}
    finally:
        for p in (in_path, ps_path):
            try:
                if p:
                    os.remove(p)
            except OSError:
                pass
