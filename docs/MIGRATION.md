# Migration to a central, multi-division SharePoint store

Status: **planning / build-out** (started 2026-10-01). Production (v2026.09.29, run by the previous owner) is untouched.

## 1. Goal

Today the app is NBGW-only: devices and the audit log live in the NBGW SharePoint site, and shared "hub" data lives in JSON files in a OneDrive-synced folder with no locking.

Target: one **central** SharePoint site that every division's users can reach, holding all divisions' data, with division switching inside the app. NBGW's existing data is carried over so nobody starts from scratch.

| | Today | Target |
|---|---|---|
| Devices, audit log | `nucor.sharepoint.com/sites/NBGW/systems` (NBGW lists) | Central site, shared lists with a `Division` column |
| Hub data (setups, upgrades, hot spares, baselines, sites + PIN, software cache) | JSON files in `SystemsData\_EndpointHub\` (OneDrive sync, last-writer-wins) | `Hub Items` list (one row per item) plus a `Hub Files` library for large blobs |
| Division config (companyName, Intune category, site list, AD/SQL) | Hardcoded for NBGW in `graph.py` / `app.py` / `hub.py` / `web/app.js` | `Divisions` list (and `divisions` in config.json as a fallback) |
| Timesheet week locks | SQL `NBSTimesheet.dbo.WeekLocked` | Unchanged |

**Central site:** `https://nucor.sharepoint.com/sites/NBGTX.nbghubdata` (dedicated site "NBG Hub Data"; owner: the project owner).

## 2. Decisions and deliberate modifications

These differ from a 1:1 copy of the NBGW structure on purpose.

1. **One shared set of lists with a `Division` column** (not a list set per division). Simpler to administer and report across divisions. Division rows are separated by an indexed `Division` column; the app filters every read/write by the active division.
2. **`Division` column is indexed** on the large lists so filtered queries stay fast and stay under the 5,000-item list view threshold.
3. **Hub JSON becomes one row per item**, not one file per list. SharePoint multi-line text holds roughly 63k characters, and one-row-per-item removes the last-writer-wins problem described in CLAUDE.md. Large blobs (setup HTML) go to the `Hub Files` library.
4. **Column display names are identical to today's** (`Site Tag`, `Memory (RAM)`, `Primary User`, ...), so `FIELD_ALIASES` in `graph.py` resolves them with no code change. Internal names are clean (`MemoryRAM`) rather than SharePoint-mangled (`Memory_x0028_RAM_x0029_`).
5. **All new columns are plain text** (including dates), matching how the app writes ISO strings today. Typed date columns are a later improvement; changing them now risks breaking `_row()` parsing and the loader.
6. **`Model Specs` is shared** (no `Division` column): a model's CPU/RAM is the same for every division.
7. **`Divisions` list is the registry** (companyName, Intune category, site/city/device prefixes, AD domain, SQL server, access list). `config.json` `divisions` stays as an offline fallback. `Enabled` lets a division be hidden without deleting it.
8. **Local snapshot mode** (`localstore.py`) is the test bed: the live NBGW data is pulled read-only into SQLite on the developer's PC, and all writes stay local until cutover.
9. **Secrets never go in lists, config in git, or the repo.** The Lenovo key stays in `config.json` (gitignored).

## 3. Central lists (created by `tools\Setup-CentralLists.ps1`)

Prefix defaults to `Inventory`. Column display name (internal name) in parentheses where they differ.

| List | Columns (besides `Title`) |
|---|---|
| `Inventory - Divisions` | Display Name, Company Name, Intune Category, SharePoint Host, Site Path, AD Domain, SQL Server, Sites JSON (note), Access JSON (note), Enabled (yes/no). `Title` = division id (e.g. `nbgw`). |
| `Inventory - New Stock` | **Division** (indexed), Manufacturer, Model, Site Tag, CPU, Memory (RAM), Storage, Warranty Expiration, Status, Date Added. `Title` = serial. |
| `Inventory - In Use` | **Division** (indexed), Device Name, Manufacturer, Model, Site Tag, Primary User, CPU, Memory (RAM), Storage, OS Version, OS Install Date, Last Sign In, Warranty Expiration, MFA. `Title` = serial. |
| `Inventory - Model Specs` | CPU, Memory (RAM). `Title` = model. |
| `Inventory - Activity Log` | **Division** (indexed), Action, Serial, Model, Actor, Details (note), LoggedAt. |
| `Inventory - Hub Items` | **Division** (indexed), **Kind** (indexed), Item Id, Payload (note, JSON), Rev (number). `Title` = `division:kind:id`. |
| `Inventory - Hub Files` (library) | **Division** (indexed), Kind, Item Id. |

Hub `Kind` values map to today's files: `upgrade`, `upgrade_log`, `hot_spare`, `boneyard`, `setup`, `change`, `feedback`, `client`, `perm_baselines`, `software`, `software_rules`, `sites`, `model_departments`, `config`.

### Running the setup script

```powershell
Install-Module Microsoft.Graph.Authentication -Scope CurrentUser   # once
.\tools\Setup-CentralLists.ps1                    # DRY RUN: shows what would be created
.\tools\Setup-CentralLists.ps1 -Commit -SeedNbgw  # create lists/columns and add the NBGW division row
```

- Dry run by default. Re-runnable: existing lists are kept; only missing columns are added. It never deletes or edits data.
- If your tenant blocks the Graph PowerShell app ("Approval required"), create the lists by hand from the table above, or ask an admin to consent to the Microsoft Graph Command Line Tools app for `Sites.ReadWrite.All`.
- If the script warns a column is not indexed, index it in the UI: List settings > Indexed columns.

## 4. App changes still required (not done yet)

| # | Change | Where |
|---|---|---|
| A | **Division filtering**: every list read filters `Division eq '<id>'`; every create sets `Division`. | `graph.py` `_items_raw`, `_create_item`, `find_by_serial`, `get_log` |
| B | **Central site config + registry. Done:** `central` in config.json; divisions read from the `Divisions` list (central wins over config.json; `Enabled = No` hides a division; `Access JSON` = list of emails, `group:<id>|<name>` entries or `*` (everyone); empty = super admins only; super admins see all). Access is an app-side filter only. | `graph.py` `refresh_registry`, `visible_registry` |
| C | **Hub storage swap. Done:** `Hub` reads/writes `Hub Items` rows via `hubstore.py` when the central site is configured (JSON files otherwise). Documents over ~50k chars are split into chunk rows; each write bumps `Rev`, and a stale editor gets a conflict error instead of silently overwriting. Setup HTML is stored as `blob` rows for now (a `Hub Files` library upload is a later improvement). | `hub.py`, `hubstore.py` |
| D | **UI. Done:** sites, tabs, charts and labels come from the active division; sidebar-header switcher when a user has 2+ divisions. | `web/app.js` `Divisions` |
| E | **Loader** from the local snapshot into the central lists (section 5). **Done:** `tools\load_central.py` (dry-run default, `--commit`, `--wipe`). Hub JSON: `--hub` / `--hub-only` (needs C, done). | `tools\load_central.py` |
| F | Bump version on release (`version.py`, `version.txt`, Mock strings). | Rule 3 |

Done so far: division registry (`divisions.py`), division-aware Graph/Hub/site mapping, `get_divisions` / `switch_division`, local snapshot mode (`localstore.py`).

## 5. Data migration (NBGW live data to central)

Source of truth for the load is the **local snapshot**, which is a read-only copy of NBGW production (lists and hub folder), so the load never touches the NBGW site.

1. Build and test the app against the local snapshot (current state).
2. Create the central lists with the script. Load a handful of rows to test (use a throwaway `Division` such as `test`).
3. Write the loader. It must be: **idempotent** (re-running does not duplicate; key = `Division` + serial for devices, `Division:kind:id` for hub items), **dry-run by default** with a `--commit` flag, and log one audit entry per run (Rule 7).
4. Loader mapping:
   - `new_stock` / `in_use` rows: copy fields by display name, set `Division = nbgw`.
   - Activity log: copy rows, set `Division = nbgw`, preserve `LoggedAt`.
   - Model specs: copy as-is (deduplicate by model).
   - Hub JSON: split each file into items (upgrade list to many `upgrade` rows, hot spares to many `hot_spare` rows, and so on); `setups` HTML to `Hub Files`.
5. **Cutover** (needs a short freeze):
   1. Tell users of the current exe to stop (or switch to read-only).
   2. Pull a final snapshot.
   3. Wipe the central test data (rows with `Division = nbgw` and `test`), then run the loader with `--commit`.
   4. Spot-check counts: snapshot vs central, per list.
   5. Release the new build pointing at the central site.
6. **Rollback**: the old NBGW lists and `SystemsData\_EndpointHub\` are left intact and read-only after cutover. Reverting means running the previous exe (v2026.09.29). Keep them for at least 30 days.

### Known risks

- Anything written to the old lists after the final snapshot is lost unless the freeze is respected. Re-pull and re-run the loader if there is any doubt (the loader is idempotent).
- The old exe keeps writing to the old site until everyone updates. Announce the cutover.
- Records with a blank `Site Tag` or a user outside the division's sites keep working; they appear as `Other`.
- Permissions: users need Contribute on the central site. Per-division isolation is enforced by the app, not SharePoint (everyone with site access can read all divisions' rows). If strict isolation is required later, use a separate site or list set per division.
- Co-managed devices, the Intune category and the Entra `companyName` scope (CLAUDE.md rules 6 and 7) still apply per division.

## 6. Open items

- Confirm the owner can consent to / use the Graph PowerShell app in this tenant (script prerequisite).
- Division list for onboarding: for each, Entra `companyName`, Intune device category, sites (code, city, device prefix), AD domain, SQL server, access list.
- Decide who maintains the `Divisions` list (the access list controls who sees which division in the switcher).

## 7. Manual alternative

If the Graph PowerShell app is not available, create the lists by hand: see [MANUAL_LIST_SETUP.md](MANUAL_LIST_SETUP.md).

## 8. Note: typed vs text columns

The PowerShell script creates `Enabled` as Yes/No and `Rev` as Number. The manual/Excel route leaves them as text (SharePoint cannot convert text to Yes/No or Number). The app code must accept both (`Enabled`: true/"yes"/"true"/1; `Rev`: int or numeric string).

## 9. Adding a division

1. Add a row to `Inventory - Divisions` on the central site: Title = short id (lowercase, e.g. `nbgtx`), Display Name, Company Name (exact Entra `companyName`), Intune Category, SharePoint Host + Site Path (the old per-division site, only needed as a migration source), AD Domain, SQL Server, Sites JSON (code, name, city_prefixes, device_prefixes), Access JSON (`[]` = super admins only, `["*"]` = everyone, or `["a@nucor.com"]`), Enabled = Yes.
2. Users see it in the header switcher within about 5 minutes (restart the app to see it immediately).
3. Load the division's existing data with the loader: `python tools\load_central.py --division <id>` (needs a snapshot of that division's old site).
