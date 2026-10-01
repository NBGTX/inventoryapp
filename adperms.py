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
    $s = NewSearcher "(&(objectCategory=person)(objectClass=user)(|(anr=$q)(sAMAccountName=$q*)))" 80
    foreach ($p in "distinguishedName","sAMAccountName","displayName","userPrincipalName","userAccountControl","title","department","company") { $null = $s.PropertiesToLoad.Add($p) }
    $out = @()
    foreach ($r in $s.FindAll()) {
      $p = $r.Properties
      $uac = 0; if ($p["useraccountcontrol"].Count -gt 0) { $uac = [int]$p["useraccountcontrol"][0] }
      $out += @{ dn = (One $p "distinguishedname"); sam = (One $p "samaccountname"); name = (One $p "displayname"); upn = (One $p "userprincipalname");
                 title = (One $p "title"); company = (One $p "company"); dept = (One $p "department"); enabled = (($uac -band 2) -eq 0) }
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

# Runs in its own console window. Binds to AD with ONE chosen smart card certificate: the PIN is typed here,
# in this window (hidden input), never in the app. ASCII only (Windows PowerShell 5.1).
_WRITE_PS = r'''
param([string]$InFile, [string]$OutFile)
$res = @{ done = @(); failed = @(); who = ""; error = "" }
function Save() { ($res | ConvertTo-Json -Depth 4 -Compress) | Set-Content -LiteralPath $OutFile -Encoding UTF8 }
try {
  Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class NbgCred {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredMarshalCredential(int t, IntPtr c, out IntPtr m);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr b);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  public static void Front() { IntPtr h = GetConsoleWindow(); if (h != IntPtr.Zero) { ShowWindow(h, 9); SetForegroundWindow(h); } }
  public static string Marshal(byte[] hash) {
    IntPtr p = System.Runtime.InteropServices.Marshal.AllocHGlobal(24);
    try {
      System.Runtime.InteropServices.Marshal.WriteInt32(p, 24);
      System.Runtime.InteropServices.Marshal.Copy(hash, 0, new IntPtr(p.ToInt64() + 4), 20);
      IntPtr m; if (!CredMarshalCredential(1, p, out m)) throw new Exception("CredMarshalCredential failed " + System.Runtime.InteropServices.Marshal.GetLastWin32Error());
      string s = System.Runtime.InteropServices.Marshal.PtrToStringUni(m); CredFree(m); return s;
    } finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(p); }
  }
}
"@
  [NbgCred]::Front()
  $cfg = Get-Content -Raw -LiteralPath $InFile | ConvertFrom-Json
  $hash = New-Object byte[] 20
  for ($i = 0; $i -lt 20; $i++) { $hash[$i] = [Convert]::ToByte($cfg.thumb.Substring($i * 2, 2), 16) }
  $cred = [NbgCred]::Marshal($hash)
  Write-Host ""
  Write-Host "NBG Hub: add $($cfg.groups.Count) group(s) to a user as $($cfg.account)" -ForegroundColor Cyan
  $sec = Read-Host "Enter the YubiKey PIN (typing is hidden)" -AsSecureString
  $pin = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  $res.who = [string]$cfg.account
  $auth = [System.DirectoryServices.AuthenticationTypes]::Secure
  foreach ($g in $cfg.groups) {
    try {
      $e = New-Object System.DirectoryServices.DirectoryEntry("LDAP://$($cfg.domain)/$g", $cred, $pin, $auth)
      $e.RefreshCache()
      $null = $e.Properties["member"].Add([string]$cfg.user)
      $e.CommitChanges()
      $res.done += [string]$g
    } catch {
      $m = $_.Exception.Message
      if ($_.Exception.InnerException) { $m = $_.Exception.InnerException.Message }
      if ($m -match "already exists|ENTRY_EXISTS|0x80071392") { $res.done += [string]$g }
      else {
        $res.failed += @{ dn = [string]$g; error = $m }
        if ($m -match "logon failure|credentials|PIN|0x8009002D|0x8009000B|incorrect") { break }   # never retry a wrong PIN
      }
    }
  }
} catch { $res.error = $_.Exception.Message }
Save
'''


# Lists the sign-in certificates Windows knows (public data only: no key is opened, no PIN, nothing signed).
# Which of them are on the inserted card is decided from `certutil -silent -scinfo`. ASCII only (Windows PowerShell 5.1).
_CERTS_PS = r'''
$out = @()
Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue | ForEach-Object {
  $eku = @($_.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId })
  if ($eku -contains "1.3.6.1.4.1.311.20.2.2" -or $eku -contains "1.3.6.1.5.5.7.3.2") {
    $san = $_.Extensions | Where-Object { $_.Oid.Value -eq "2.5.29.17" }
    if ($san -and ($san.Format($false) -match "Principal Name=([^,\s]+)")) {
      $out += @{ thumb = $_.Thumbprint.ToLower(); upn = $Matches[1]; cn = ($_.Subject -replace ",.*$", "" -replace "^CN=", "");
                 expires = $_.NotAfter.ToString("yyyy-MM-dd"); valid = ($_.NotAfter -gt (Get-Date)) }
    }
  }
}
Write-Output (@{ certs = $out } | ConvertTo-Json -Depth 4 -Compress)
'''


def _card_hashes() -> set:
    """SHA1 thumbprints of the certificates on the cards inserted now. `-silent` keeps Windows from asking for a PIN."""
    try:
        p = subprocess.run(["certutil", "-silent", "-scinfo"], capture_output=True, text=True, timeout=30, creationflags=_NO_WINDOW)
    except Exception:
        return set()
    return parse_scinfo(p.stdout or "")


def parse_scinfo(text: str) -> set:
    import re
    out, reader = set(), ""
    for line in text.splitlines():
        m = re.search(r"Reader:\s*(.+)$", line)
        if m:
            reader = m.group(1).strip().lower()
        m = re.search(r"Cert Hash\(sha1\):\s*([0-9a-fA-F ]{40,60})", line)
        if m and "hello" not in reader:
            out.add(m.group(1).replace(" ", "").lower())
    return out


def smartcard_accounts(timeout: int = 30) -> dict:
    """Distinct, unexpired sign-in certificate accounts whose key is on a card inserted now (UPN + thumbprint)."""
    ps_p = None
    try:
        ps_p = _tmp(".ps1", _CERTS_PS)
        proc = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps_p],
                              capture_output=True, text=True, timeout=timeout, creationflags=_NO_WINDOW)
        txt = (proc.stdout or "").strip()
        if not txt:
            return {"__error__": (proc.stderr or "no output").strip()[:200]}
        on_card = _card_hashes()
        seen, out = set(), []
        for c in _listify(json.loads(txt).get("certs")):
            u = (c.get("upn") or "").strip()
            if u and c.get("valid") and (c.get("thumb") or "") in on_card and u.lower() not in seen:
                seen.add(u.lower())
                out.append({"upn": u, "cn": c.get("cn", ""), "expires": c.get("expires", ""), "thumb": c["thumb"]})
        return {"accounts": sorted(out, key=lambda x: x["upn"].lower())}
    except Exception as e:
        return {"__error__": str(e)[:200]}
    finally:
        try:
            if ps_p:
                os.remove(ps_p)
        except OSError:
            pass


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


def in_scope(u: dict, companies: list) -> bool:
    """Keep people whose AD company is one of `companies`. Admin accounts (adm.*) have no company, so blank passes."""
    co = (u.get("company") or "").strip().lower()
    return not co or co in {c.strip().lower() for c in companies if c}


def search_users(q: str, domain: str, companies: list | None = None) -> dict:
    q = (q or "").strip()
    if len(q) < 2:
        return {"users": []}
    r = _read({"mode": "search", "q": q, "domain": domain})
    if "__error__" in r:
        return r
    us = _listify(r.get("users"))
    if companies:
        us = [u for u in us if in_scope(u, companies)]
    return {"users": sorted(us, key=lambda u: (u.get("name") or u.get("sam") or "").lower())[:20]}


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
    """Security groups and distribution lists are both ordinary AD groups with a `member` list: both can be copied."""
    return bool(g.get("dn"))


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
    """Add `user_dn` to each group, bound with the smart card certificate of `account` (UPN picked from the inserted key).
    A console window opens, asks for the PIN once (hidden input, never seen by this app) and reports back via a temp file."""
    if not group_dns:
        return {"done": [], "failed": [], "who": ""}
    card = smartcard_accounts()
    if "__error__" in card:
        return {"__error__": card["__error__"]}
    me = next((a for a in card["accounts"] if a["upn"].lower() == (account or "").strip().lower()), None)
    if me is None:
        return {"__error__": "That account was not found on the inserted YubiKey. Insert the key and pick the account from the list."}
    in_p = ps_p = out_p = None
    try:
        in_p = _tmp(".json", json.dumps({"domain": domain, "user": user_dn, "groups": list(group_dns), "thumb": me["thumb"], "account": me["upn"]}))
        ps_p = _tmp(".ps1", _WRITE_PS)
        out_p = _tmp(".json")
        os.remove(out_p)                                   # the script creates it; its existence means "finished"
        subprocess.Popen(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps_p, "-InFile", in_p, "-OutFile", out_p],
                         creationflags=_NEW_CONSOLE)
        import time
        end = time.time() + timeout
        while not os.path.exists(out_p) and time.time() < end:
            time.sleep(0.5)
        if not os.path.exists(out_p):
            return {"__error__": "No answer from the PIN window (closed, or no PIN entered in time)."}
        time.sleep(0.3)
        with open(out_p, encoding="utf-8-sig") as f:
            r = json.loads(f.read() or "{}")
        if r.get("error"):
            return {"__error__": str(r["error"])[:300]}
        return {"done": _listify(r.get("done")), "failed": _listify(r.get("failed")), "who": r.get("who", "")}
    except Exception as e:
        return {"__error__": str(e)[:300]}
    finally:
        for p in (in_p, ps_p, out_p):
            try:
                if p:
                    os.remove(p)
            except OSError:
                pass
