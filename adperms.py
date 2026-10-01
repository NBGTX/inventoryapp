"""On-prem AD group membership: search users, list direct groups, compare two users, copy groups.

Reads run as the signed-in Windows user (Kerberos) through .NET DirectorySearcher via powershell.exe, like adlookup.py
(no RSAT needed). Writes need the person's own admin account (adm.<name>.pa, YubiKey / smart card): the write script is
started with `runas /netonly /smartcard`, which makes only its NETWORK calls (LDAP) use the smart card identity. Windows
asks for the PIN in its own window; the app never sees the PIN. The script reports back through a temp file.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_NEW_CONSOLE = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
MAX_COPY = 100

# group types we never offer to copy: they are not security groups (distribution lists) or are built-in
_SECURITY_FLAG = 0x80000000

_READ_PS = r'''
param([string]$InFile)
$ErrorActionPreference = "Stop"
function Fail($m) { Write-Output (@{ __error__ = $m } | ConvertTo-Json -Compress); exit 0 }
function Esc([string]$s) { return $s.Replace('\', '\5c').Replace('*', '\2a').Replace('(', '\28').Replace(')', '\29') }
try { $cfg = Get-Content -Raw -LiteralPath $InFile | ConvertFrom-Json } catch { Fail "bad input: $($_.Exception.Message)" }
$root = New-Object System.DirectoryServices.DirectoryEntry("LDAP://$($cfg.domain)")
function NewSearcher($filter, $size) {
  $s = New-Object System.DirectoryServices.DirectorySearcher($root)
  $s.Filter = $filter
  $s.SizeLimit = $size
  $s.ClientTimeout = [TimeSpan]::FromSeconds(25)
  $s.ServerTimeLimit = [TimeSpan]::FromSeconds(25)
  return $s
}
function One($p, $k) { if ($p[$k] -and $p[$k].Count -gt 0) { return [string]$p[$k][0] } else { return "" } }
try {
  if ($cfg.mode -eq "search") {
    $q = Esc ([string]$cfg.q)
    $s = NewSearcher "(&(objectCategory=person)(objectClass=user)(|(anr=$q)(sAMAccountName=$q*)))" 20
    foreach ($p in "distinguishedName","sAMAccountName","displayName","userPrincipalName","userAccountControl","title","department") { $null = $s.PropertiesToLoad.Add($p) }
    $out = @()
    foreach ($r in $s.FindAll()) {
      $p = $r.Properties
      $uac = 0; if ($p["useraccountcontrol"].Count -gt 0) { $uac = [int]$p["useraccountcontrol"][0] }
      $out += @{ dn = (One $p "distinguishedname"); sam = (One $p "samaccountname"); name = (One $p "displayname"); upn = (One $p "userprincipalname");
                 title = (One $p "title"); dept = (One $p "department"); enabled = (($uac -band 2) -eq 0) }
    }
    Write-Output (@{ users = $out } | ConvertTo-Json -Depth 4 -Compress)
  } elseif ($cfg.mode -eq "groups") {
    $dn = Esc ([string]$cfg.dn)
    $s = NewSearcher "(&(objectCategory=group)(member=$dn))" 0
    $s.PageSize = 500
    foreach ($p in "distinguishedName","cn","description","groupType","adminCount") { $null = $s.PropertiesToLoad.Add($p) }
    $out = @()
    foreach ($r in $s.FindAll()) {
      $p = $r.Properties
      $gt = 0; if ($p["grouptype"].Count -gt 0) { $gt = [int]$p["grouptype"][0] }
      $ac = 0; if ($p["admincount"].Count -gt 0) { $ac = [int]$p["admincount"][0] }
      $out += @{ dn = (One $p "distinguishedname"); name = (One $p "cn"); desc = (One $p "description"); security = (($gt -band -2147483648) -ne 0); privileged = ($ac -eq 1) }
    }
    Write-Output (@{ groups = $out } | ConvertTo-Json -Depth 4 -Compress)
  } else { Fail "unknown mode" }
} catch { Fail "AD query failed: $($_.Exception.Message)" }
'''

# Runs under the admin account's smart card identity. ASCII only (Windows PowerShell 5.1).
_WRITE_PS = r'''
param([string]$InFile, [string]$OutFile)
$res = @{ done = @(); failed = @(); who = ""; error = "" }
try {
  $cfg = Get-Content -Raw -LiteralPath $InFile | ConvertFrom-Json
  $res.who = [string][Security.Principal.WindowsIdentity]::GetCurrent().Name
  foreach ($g in $cfg.groups) {
    try {
      $e = New-Object System.DirectoryServices.DirectoryEntry("LDAP://$($cfg.domain)/$g")
      $null = $e.Properties["member"].Add([string]$cfg.user)
      $e.CommitChanges()
      $res.done += [string]$g
    } catch {
      $m = $_.Exception.Message
      if ($_.Exception.InnerException) { $m = $_.Exception.InnerException.Message }
      if ($m -match "already exists|ENTRY_EXISTS|0x80071392") { $res.done += [string]$g } else { $res.failed += @{ dn = [string]$g; error = $m } }
    }
  }
} catch { $res.error = $_.Exception.Message }
($res | ConvertTo-Json -Depth 4 -Compress) | Set-Content -LiteralPath $OutFile -Encoding UTF8
'''


def _tmp(suffix: str, text: str | None = None) -> str:
    fd, p = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        if text is not None:
            f.write(text)
    return p


def _read(payload: dict, timeout: int = 60) -> dict:
    in_p = ps_p = None
    try:
        in_p = _tmp(".json", json.dumps(payload))
        ps_p = _tmp(".ps1", _READ_PS)
        proc = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps_p, "-InFile", in_p],
                              capture_output=True, text=True, timeout=timeout, creationflags=_NO_WINDOW)
        txt = (proc.stdout or "").strip()
        if not txt:
            return {"__error__": (proc.stderr or "no output from AD query").strip()[:300]}
        data = json.loads(txt)
        if isinstance(data, dict) and "__error__" in data:
            return {"__error__": str(data["__error__"])[:300]}
        return data
    except subprocess.TimeoutExpired:
        return {"__error__": "AD query timed out (are you on the corporate network or VPN?)"}
    except Exception as e:
        return {"__error__": str(e)[:300]}
    finally:
        for p in (in_p, ps_p):
            try:
                if p:
                    os.remove(p)
            except OSError:
                pass


def _listify(v) -> list:
    """PowerShell's ConvertTo-Json turns a one-item array into a bare object."""
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def search_users(q: str, domain: str) -> dict:
    q = (q or "").strip()
    if len(q) < 2:
        return {"users": []}
    r = _read({"mode": "search", "q": q, "domain": domain})
    if "__error__" in r:
        return r
    return {"users": sorted(_listify(r.get("users")), key=lambda u: (u.get("name") or u.get("sam") or "").lower())}


def user_groups(dn: str, domain: str) -> dict:
    r = _read({"mode": "groups", "dn": dn, "domain": domain})
    if "__error__" in r:
        return r
    gs = [g for g in _listify(r.get("groups")) if g.get("dn")]
    return {"groups": sorted(gs, key=lambda g: (g.get("name") or "").lower())}


def compare(src: list, dst: list) -> dict:
    """Split two direct-group lists into only-source / only-destination / both (by DN, case-insensitive)."""
    s = {g["dn"].lower(): g for g in src}
    d = {g["dn"].lower(): g for g in dst}
    return {"only_src": [s[k] for k in s if k not in d], "only_dst": [d[k] for k in d if k not in s],
            "both": [s[k] for k in s if k in d]}


def copyable(g: dict) -> bool:
    return bool(g.get("security", True))


def plan_copy(src: list, dst: list, wanted: list) -> dict:
    """Which of the `wanted` group DNs may be added: must be a security group the source is in and the destination is not."""
    s = {g["dn"].lower(): g for g in src}
    have = {g["dn"].lower() for g in dst}
    add, skipped = [], []
    for dn in dict.fromkeys(wanted or []):
        g = s.get((dn or "").lower())
        if g is None:
            skipped.append({"dn": dn, "why": "source user is not in this group"})
        elif dn.lower() in have:
            skipped.append({"dn": dn, "why": "destination already in this group"})
        elif not copyable(g):
            skipped.append({"dn": dn, "why": "not a security group"})
        else:
            add.append(g)
    return {"add": add, "skipped": skipped}


def write_groups(user_dn: str, group_dns: list, domain: str, account: str = "", timeout: int = 300) -> dict:
    """Add `user_dn` to each group as the smart-card admin account. Returns {done:[dn], failed:[{dn,error}], who}."""
    if not group_dns:
        return {"done": [], "failed": [], "who": ""}
    in_p = ps_p = out_p = None
    try:
        in_p = _tmp(".json", json.dumps({"domain": domain, "user": user_dn, "groups": list(group_dns)}))
        ps_p = _tmp(".ps1", _WRITE_PS)
        out_p = _tmp(".json")
        os.remove(out_p)                                   # the script creates it; its existence means "finished"
        inner = f'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{ps_p}" -InFile "{in_p}" -OutFile "{out_p}"'
        cmd = 'runas /netonly /smartcard ' + (f'/user:{account} ' if account else '') + '"' + inner.replace('"', '\\"') + '"'
        subprocess.run(cmd, timeout=60, creationflags=_NEW_CONSOLE)
        import time
        end = time.time() + timeout                        # runas returns when it starts the child, so wait for the result file
        while not os.path.exists(out_p) and time.time() < end:
            time.sleep(0.5)
        if not os.path.exists(out_p):
            return {"__error__": "No answer from the admin session. Was the PIN entered and the YubiKey inserted?"}
        time.sleep(0.3)
        with open(out_p, encoding="utf-8-sig") as f:
            r = json.loads(f.read() or "{}")
        if r.get("error"):
            return {"__error__": str(r["error"])[:300]}
        return {"done": _listify(r.get("done")), "failed": _listify(r.get("failed")), "who": r.get("who", "")}
    except subprocess.TimeoutExpired:
        return {"__error__": "Timed out waiting for the admin session."}
    except Exception as e:
        return {"__error__": str(e)[:300]}
    finally:
        for p in (in_p, ps_p, out_p):
            try:
                if p:
                    os.remove(p)
            except OSError:
                pass
