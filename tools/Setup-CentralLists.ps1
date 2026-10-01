<#
.SYNOPSIS
  Creates the NBGW Hub CENTRAL SharePoint lists (multi-division) on the main IT site.

.DESCRIPTION
  DRY RUN by default: connects read-only, shows what it WOULD create. Nothing is
  written until you pass -Commit. Safe to re-run: existing lists are kept and only
  missing columns are added. It never deletes or edits existing data.

  Lists created (prefix is configurable):
    <Prefix> - Divisions         registry of divisions (tenants)
    <Prefix> - New Stock         devices in stock      (+ Division column)
    <Prefix> - In Use            devices in use        (+ Division column)
    <Prefix> - Model Specs       model -> cpu/ram      (shared by all divisions)
    <Prefix> - Activity Log      audit trail           (+ Division column)
    <Prefix> - Hub Items         one row per hub item  (upgrade, hot spare, ...)
    <Prefix> - Hub Files         document library for large blobs (setup HTML, ...)

  Column DISPLAY names match the app's FIELD_ALIASES (graph.py), so the app's
  column resolver finds them with no code change. See docs\MIGRATION.md.

.PARAMETER SiteUrl   Central site URL.
.PARAMETER Prefix    List name prefix. Default 'Inventory'.
.PARAMETER Commit    Actually create lists/columns. Without it: dry run only.
.PARAMETER SeedNbgw  With -Commit: also add the NBGW row to the Divisions list.

.EXAMPLE
  .\Setup-CentralLists.ps1                      # dry run
  .\Setup-CentralLists.ps1 -Commit -SeedNbgw    # create + seed NBGW

.NOTES
  Needs: Install-Module Microsoft.Graph.Authentication -Scope CurrentUser
  Needs: Owner / Manage Lists on the site. Delegated scope Sites.ReadWrite.All
  (the same scope the desktop app already uses). ASCII only on purpose (PS 5.1).
#>
[CmdletBinding()]
param(
    [string]$SiteUrl = 'https://nucor.sharepoint.com/sites/bg.ter.O365.TERALIT',
    [string]$Prefix = 'Inventory',
    [switch]$Commit,
    [switch]$SeedNbgw
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- helpers ----
function Col {
    param([string]$Name, [string]$Display, [string]$Type = 'text', [switch]$Indexed)
    $c = @{ name = $Name; displayName = $Display }
    switch ($Type) {
        'text'   { $c.text = @{} }
        'note'   { $c.text = @{ allowMultipleLines = $true; textType = 'plain' } }
        'number' { $c.number = @{} }
        'bool'   { $c.boolean = @{} }
        default  { throw "Unknown column type $Type" }
    }
    if ($Indexed) { $c.indexed = $true }
    return $c
}

function Graph-All {
    param([string]$Uri)
    $out = @()
    while ($Uri) {
        $r = Invoke-MgGraphRequest -Method GET -Uri $Uri
        if ($r.value) { $out += $r.value }
        $Uri = $r.'@odata.nextLink'
    }
    return $out
}

# ------------------------------------------------------------ definitions ----
# Device columns shared by New Stock / In Use (display names = FIELD_ALIASES).
$devCommon = @(
    (Col 'Division' 'Division' 'text' -Indexed),
    (Col 'Manufacturer' 'Manufacturer'),
    (Col 'Model' 'Model'),
    (Col 'SiteTag' 'Site Tag'),
    (Col 'CPU' 'CPU'),
    (Col 'MemoryRAM' 'Memory (RAM)'),
    (Col 'Storage' 'Storage'),
    (Col 'Warranty' 'Warranty Expiration')
)

$defs = @(
    @{ Key = 'divisions'; Name = "$Prefix - Divisions"; Template = 'genericList'; Columns = @(
        (Col 'DisplayName' 'Display Name'),
        (Col 'CompanyName' 'Company Name'),
        (Col 'IntuneCategory' 'Intune Category'),
        (Col 'SharePointHost' 'SharePoint Host'),
        (Col 'SitePath' 'Site Path'),
        (Col 'AdDomain' 'AD Domain'),
        (Col 'SqlServer' 'SQL Server'),
        (Col 'SitesJson' 'Sites JSON' 'note'),
        (Col 'AccessJson' 'Access JSON' 'note'),
        (Col 'Enabled' 'Enabled' 'bool')) },

    @{ Key = 'new_stock'; Name = "$Prefix - New Stock"; Template = 'genericList';
       Columns = ($devCommon + @(
        (Col 'Status' 'Status'),
        (Col 'DateAdded' 'Date Added'))) },

    @{ Key = 'in_use'; Name = "$Prefix - In Use"; Template = 'genericList';
       Columns = ($devCommon + @(
        (Col 'DeviceName' 'Device Name'),
        (Col 'PrimaryUser' 'Primary User'),
        (Col 'OSVersion' 'OS Version'),
        (Col 'OSInstallDate' 'OS Install Date'),
        (Col 'LastSignIn' 'Last Sign In'),
        (Col 'MFA' 'MFA'))) },

    @{ Key = 'model_specs'; Name = "$Prefix - Model Specs"; Template = 'genericList'; Columns = @(
        (Col 'CPU' 'CPU'),
        (Col 'MemoryRAM' 'Memory (RAM)')) },

    @{ Key = 'log'; Name = "$Prefix - Activity Log"; Template = 'genericList'; Columns = @(
        (Col 'Division' 'Division' 'text' -Indexed),
        (Col 'Action' 'Action'),
        (Col 'Serial' 'Serial'),
        (Col 'Model' 'Model'),
        (Col 'Actor' 'Actor'),
        (Col 'Details' 'Details' 'note'),
        (Col 'LoggedAt' 'LoggedAt')) },

    @{ Key = 'hub_items'; Name = "$Prefix - Hub Items"; Template = 'genericList'; Columns = @(
        (Col 'Division' 'Division' 'text' -Indexed),
        (Col 'Kind' 'Kind' 'text' -Indexed),
        (Col 'ItemId' 'Item Id'),
        (Col 'Payload' 'Payload' 'note'),
        (Col 'Rev' 'Rev' 'number')) },

    @{ Key = 'hub_files'; Name = "$Prefix - Hub Files"; Template = 'documentLibrary'; Columns = @(
        (Col 'Division' 'Division' 'text' -Indexed),
        (Col 'Kind' 'Kind'),
        (Col 'ItemId' 'Item Id')) }
)

# -------------------------------------------------------------------- main ----
$mode = if ($Commit) { 'COMMIT' } else { 'DRY RUN (nothing is written)' }
Write-Host "== NBGW Hub central lists: $mode ==" -ForegroundColor Cyan

if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
    throw "Missing module. Run: Install-Module Microsoft.Graph.Authentication -Scope CurrentUser"
}
Import-Module Microsoft.Graph.Authentication
Connect-MgGraph -Scopes 'Sites.ReadWrite.All' -NoWelcome | Out-Null

$u = [uri]$SiteUrl
$spHost = $u.Host
$spPath = $u.AbsolutePath.TrimEnd('/')
$site = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/sites/${spHost}:${spPath}"
Write-Host ("Site: {0}  ({1})" -f $site.displayName, $site.webUrl)
$siteId = $site.id

$existing = Graph-All "https://graph.microsoft.com/v1.0/sites/$siteId/lists?`$select=id,name,displayName&`$top=200"
$created = @()

foreach ($d in $defs) {
    $hit = $existing | Where-Object { $_.displayName -eq $d.Name } | Select-Object -First 1
    if (-not $hit) {
        Write-Host ("[NEW ] {0}  ({1} columns)" -f $d.Name, $d.Columns.Count) -ForegroundColor Yellow
        if ($Commit) {
            $body = @{ displayName = $d.Name; list = @{ template = $d.Template }; columns = @($d.Columns) } |
                ConvertTo-Json -Depth 10
            $l = Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/sites/$siteId/lists" `
                -Body $body -ContentType 'application/json'
            $created += $d.Name
            $d.ListId = $l.id
        }
        continue
    }
    # list exists: add only the missing columns
    $d.ListId = $hit.id
    $have = Graph-All "https://graph.microsoft.com/v1.0/sites/$siteId/lists/$($hit.id)/columns?`$select=name,displayName"
    $haveNames = @($have | ForEach-Object { $_.name.ToLower(); $_.displayName.ToLower() })
    $missing = @($d.Columns | Where-Object { $haveNames -notcontains $_.name.ToLower() -and $haveNames -notcontains $_.displayName.ToLower() })
    if ($missing.Count -eq 0) {
        Write-Host ("[OK  ] {0}  (all columns present)" -f $d.Name) -ForegroundColor Green
        continue
    }
    Write-Host ("[ADD ] {0}  missing: {1}" -f $d.Name, (($missing | ForEach-Object { $_.displayName }) -join ', ')) -ForegroundColor Yellow
    if ($Commit) {
        foreach ($c in $missing) {
            Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/sites/$siteId/lists/$($hit.id)/columns" `
                -Body ($c | ConvertTo-Json -Depth 10) -ContentType 'application/json' | Out-Null
        }
    }
}

# ---- verify indexes on new lists (Graph may ignore 'indexed' on create) ----
if ($Commit) {
    foreach ($d in $defs) {
        if (-not $d.ListId) { continue }
        $cols = Graph-All "https://graph.microsoft.com/v1.0/sites/$siteId/lists/$($d.ListId)/columns?`$select=name,displayName,indexed"
        foreach ($want in ($d.Columns | Where-Object { $_.indexed })) {
            $c = $cols | Where-Object { $_.name -eq $want.name } | Select-Object -First 1
            if ($c -and -not $c.indexed) {
                Write-Warning ("'{0}' column '{1}' is not indexed. Index it in the SharePoint UI: List settings > Indexed columns." -f $d.Name, $want.displayName)
            }
        }
    }
}

# ---- seed NBGW into Divisions ----
if ($Commit -and $SeedNbgw) {
    $dv = $defs | Where-Object { $_.Key -eq 'divisions' }
    $rows = Graph-All "https://graph.microsoft.com/v1.0/sites/$siteId/lists/$($dv.ListId)/items?`$expand=fields"
    if ($rows | Where-Object { $_.fields.Title -eq 'nbgw' }) {
        Write-Host "[SEED] NBGW row already exists - skipped" -ForegroundColor Green
    } else {
        $sitesJson = '[{"code":"LTR","name":"Lathrop, CA","city_prefixes":["lathrop"],"device_prefixes":["BGLTR","BGCCN","BGMOD"]},' +
                     '{"code":"BRI","name":"Brigham City, UT","city_prefixes":["brigham"],"device_prefixes":["BGBRI"]}]'
        $f = @{
            Title = 'nbgw'; DisplayName = 'NBGW - Nucor Buildings Group West'
            CompanyName = 'Nucor Buildings Group West'; IntuneCategory = 'NBGW'
            SharePointHost = 'nucor.sharepoint.com'; SitePath = '/sites/NBGW/systems'
            AdDomain = 'bg.nucorsteel.local'; SqlServer = 'BGBRISQL07'
            SitesJson = $sitesJson; AccessJson = '[]'; Enabled = $true
        }
        Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/sites/$siteId/lists/$($dv.ListId)/items" `
            -Body (@{ fields = $f } | ConvertTo-Json -Depth 5) -ContentType 'application/json' | Out-Null
        Write-Host "[SEED] NBGW row added to Divisions" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Config for the app (config.json central store) - names only, no secrets:" -ForegroundColor Cyan
Write-Host ("  central_site_host : {0}" -f $spHost)
Write-Host ("  central_site_path : {0}" -f $spPath)
foreach ($d in $defs) { Write-Host ("  list {0,-12}: {1}" -f $d.Key, $d.Name) }
if (-not $Commit) { Write-Host "`nDry run only. Re-run with -Commit to create." -ForegroundColor Cyan }
