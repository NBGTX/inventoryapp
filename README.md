# NBG Hub

A Windows desktop app for the **NBGW Systems/IT team** at Nucor Buildings Group West (**LTR** = Lathrop, CA; **BRI** = Brigham City, UT). It combines the team's computer inventory, endpoint-provisioning checklists, and a set of admin tools in one signed-in window.

It's built with **Python 3.12 + pywebview (Edge WebView2)** and shipped as a single `NBG Hub.exe` built by PyInstaller. Each user signs in with their **own Nucor account**: Entra ID via MSAL, public client, PKCE. **No secret is stored in the app code.**

| Document | For |
|---|---|
| **README.md** (this file) | What it is, quick start, build and release |
| **[HANDOFF.md](HANDOFF.md)** | The full developer handoff: architecture, decisions, data stores, known issues, roadmap, open questions |
| **[CLAUDE.md](CLAUDE.md)** | Condensed rules and context for Claude Code |
| **[docs/MIGRATION.md](docs/MIGRATION.md)** | Multi-division / central SharePoint store: design, decisions, cutover plan |
| **[docs/MANUAL_LIST_SETUP.md](docs/MANUAL_LIST_SETUP.md)** | Step-by-step creation of the central lists (+ `docs/CentralLists_Import.xlsx`) |

> **Update 2026-10 (v2026.10.01, in development): multi-division.** The app is no longer NBGW-only. Everything
> division-specific (Entra `companyName`, Intune category, sites and their city/device prefixes, AD domain, SQL
> server) lives in a **division registry**, and a header dropdown switches divisions. When `config.json` has a
> `central` block, all divisions share one SharePoint site (devices, audit log, hub data, registry, master
> settings, each row stamped with `Division`). Without it the app behaves as the single-division v2026.09.29.
> The text below still describes the single-division app in places (NBGW names, `SystemsData` JSON); where it
> disagrees, CLAUDE.md and docs/MIGRATION.md win.
>
> `config.json` additions (names only): `central` {`site_host`, `site_path`, `lists`}, optional `divisions`
> (fallback registry), optional `super_admins` (emails), `logs_folder` (legacy hub folder). The Lenovo key can move
> to the in-app **Master settings** panel (super admin). `tenant_id` / `client_id` / `central` must stay in the file.
>
> Developer tools: `tools\pull_snapshot.py` (read-only copy of production to the local sandbox),
> `tools\load_central.py` (snapshot to central lists, dry run by default), `tools\bump_version.py`,
> `tools\Setup-CentralLists.ps1`. Tests: `python -m unittest discover -s tests`.

---

## Features

| View | What it does |
|---|---|
| **Dashboard** | KPI tiles with drill-downs for in use / in stock, hot spares, no-UPN, warranties ≤90 days, upgrade forecast, no Intune check-in 30+ days (with where the device still exists — AD, Entra, Intune), no MFA, and not-NBGW |
| **Endpoint Provisioning** | New-computer and new-user setup checklists per department. They resume where you left off, progress is shared with the team, you can reserve a stock device, and each finished setup produces an HTML record |
| **Devices** | The SharePoint **New Stock** / **In Use** lists plus a **Boneyard** tab. Add machines with Lenovo spec/warranty lookup, edit, move, remove. Also: Sync now, Populate MFA, Master sync, and the activity log |
| **Upgrades** | Per-site upgrade queue. CPUs 5+ years old are added automatically. Set priorities, drag to reorder, link a setup |
| **Software** | Intune app inventory by user and department. The top 10 apps in each department are mandatory automatically, with manual overrides. Compliance is checked against the latest version |
| **BG Tools** | **Timesheet Fix** (unlock a locked timesheet week in SQL), **Permissions Finder** (every Entra group a person is in, with a Division filter), **Missing Groups** (groups a person or department lacks versus NBGW peers) |
| **NBT Sites / Project Hub** | Launchers for Nucor web tools |
| **Configuration** | PIN-gated. Model→department map, NBT Sites editor, Group baselines, storage info |

---

## ⚠ Read before you run it

- **The real app changes production data.** About 4 s after launch it reconciles In Use with Intune, enriches rows, and runs the Boneyard sweep, all against the live SharePoint lists. The dashboard also writes the shared upgrade list. There is no test environment. For UI work, use the **Mock preview** below.
- **Where shared data goes depends on how you run it.** The exe uses `<exe folder>\SystemsData\_EndpointHub`. `python app.py` uses `<project>\SystemsData\…`, which is **not** the live data. See HANDOFF §0.
- **`config.json` holds a real secret** (`lenovo_client_id`). It is gitignored. Never commit or print it.
- **This folder is not under version control yet.** Put it in git before you change anything.

---

## Prerequisites (per user)

Everything runs with the signed-in user's own (delegated) permissions, so **each user** needs the following:

1. **An Intune RBAC role that can read devices, scoped to all devices.** The built-in *Help Desk Operator* role is enough.
   - With no role you get a **403**.
   - With a group-scoped role you **silently see only some devices**.
   - **Test with a normal, non-admin account.** An admin sees everything and hides the problem. `poc\test_intune_signin.py` checks exactly this.
2. **SharePoint Contribute** on `https://nucor.sharepoint.com/sites/NBGW/systems` (the device lists and the log list).
3. **Timesheet Fix only:** SQL rights on `BGBRISQL07`, for reading `NBSEmployeeInfo.dbo.SAP_Interface` and updating `NBSTimesheet.dbo.WeekLocked`.
4. **The corporate network**, for the on-prem AD lookups (`bg.nucorsteel.local`).
5. **The Edge WebView2 runtime.** It ships with Windows 11.

### Azure app registration (one-time; needs an Entra admin; **already done**)

The app uses the single-tenant registration **"Inventory Dashboard"**:

1. **Authentication → Mobile and desktop applications** platform, with redirect URI `http://localhost`. It must be this platform type, not *Web* or *SPA*.
2. **Allow public client flows = Yes.**
3. **Delegated Microsoft Graph permissions, with admin consent granted.**
   - **Core:** `User.Read`, `DeviceManagementManagedDevices.Read.All`, `Sites.ReadWrite.All`.
   - **Optional:** `Directory.Read.All`, `User.Read.All`, `AuditLog.Read.All`, `UserAuthenticationMethod.Read.All`. These light up Entra, Missing Groups, city→site and MFA.
   - The app requests all of them and **falls back to core** if they aren't granted (`graph.py:72-100, 226-264`).
   - **Never add an unconsented scope to the request.** Every user would then hit "Approval required".

---

## Quick start (developer)

### 1. Install Python 3.12 and the dependencies
```powershell
winget install --id Python.Python.3.12 -e --scope user
python -m pip install -r requirements.txt
python -m pip install pythonnet clr_loader pyinstaller
```

**If the corporate proxy breaks pip** (hash-mismatch or "tampered" errors), the proxy is truncating burst downloads. Install the packages one at a time:
```powershell
foreach ($p in 'certifi','idna','urllib3','charset-normalizer','requests','pyjwt','msal','truststore',
               'proxy_tools','bottle','typing_extensions','clr_loader','pythonnet','pywebview','pyinstaller') {
  python -m pip install --no-deps --no-cache-dir $p
}
```

If a wheel still fails:
1. Download it once: `curl.exe -L --ssl-no-revoke -o <file> <pypi-url>`.
2. Install it from the local file: `python -m pip install --no-index --find-links . <pkg>`.

Also note: in Git Bash, Python isn't on the PATH. Use PowerShell.

### 2. Configure
```powershell
copy config.example.json config.json
```
- Fill in `tenant_id`, `client_id` and `lenovo_client_id`. Get them from the project owner through a secure channel.
- Optional keys (data-folder override, Intune category/OS, SQL server, AD domain, division lists) are documented in **HANDOFF §6**.

### 3. Run the UI safely against the Mock backend
```powershell
python -m http.server 8810 --directory web
# open http://localhost:8810  — every Backend.call goes to the in-browser Mock; nothing touches Microsoft or SQL
```
The browser caches `app.js` aggressively. Use a fresh port, or hard-reload, after edits.

### 4. Read-only checks against the real tenant
```powershell
python poc\test_intune_signin.py [serial]   # sign-in + Intune + SharePoint read proof (uses poc\config.json)
python poc\inspect_lists.py                 # SharePoint column display → internal names
python sync.py                              # DRY RUN of the Intune → In Use reconcile (python sync.py --commit WRITES)
```

### 5. Run the real app from source (changes production data)
```powershell
python app.py
```

There are **no automated tests yet**. See the roadmap in HANDOFF §14.

---

## Build and release

```powershell
# 1. Bump the version everywhere (every build):   python tools\bump_version.py
#    (version.py, version.txt, Mock strings; build.ps1 refuses to build if they disagree)
# 2. Python 3.12 is found via "py -3.12"; or pass -Python <path\python.exe>, or set NBG_PYTHON.
#    build.ps1 also runs the offline tests first (-SkipTests to bypass).
# 3. Clean build (PyInstaller can reuse a stale cache):
Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue
powershell -ExecutionPolicy Bypass -File build.ps1        # -> dist\NBG Hub.exe  (+ dist\config.json)
```

About the build:
- `build.ps1` copies `config.json` beside the exe, so `config.json` must exist before you build. It is not bundled into the exe.
- `-OneDir` makes a folder build, which gets fewer antivirus false positives.
- **`-Deploy` (copy to `C:\Program Files\NBG`) is not safe as is.** Shared data lives beside the exe, so it would split the team's data (HANDOFF §7).

**Release** (current practice):
1. Close the app (a running exe is locked).
2. Copy `dist\NBG Hub.exe` into the synced SharePoint library `…\Nucor\Systems Home - Inventory Desktop App\dist\`. The team runs the exe from there, and the shared data sits beside it in `SystemsData\_EndpointHub\`.
3. Check the version in the sidebar, then open **Versions in use** (click the version line) to see who is running which build.

**Security warnings on the exe:**
- The exe is unsigned. SmartScreen shows "Unknown Publisher", and Defender has flagged the onefile build as an ML false positive (`Bearfoos.B!ml`).
- The durable fix is a Nucor code-signing certificate, or deploying through Intune as a Win32 app. If you do either, set `logs_folder` so the data stays shared.

---

## Project layout

```
app.py        pywebview entry point; class Api = every method the UI can call; main()
graph.py      MSAL sign-in + Microsoft Graph (Intune, Entra, reports) + SharePoint lists + Lenovo API
sync.py       Intune → In Use reconcile (with duplicate cleanup), enrichment, MFA, master sync; CLI
hub.py        shared JSON store in <data>\_EndpointHub (setups, upgrades, hot spares, baselines, …)
adlookup.py   on-prem AD computer lookup (PowerShell + .NET DirectorySearcher, Kerberos)
sqltools.py   parameterized SQL Server access (PowerShell + .NET SqlClient, Integrated Security)
cpu.py        CPU model → release year (drives "needs upgrade")
version.py / version.txt   app version (sidebar + exe metadata)
web/          index.html, app.js (all UI logic + the Mock backend), styles.css
poc/          read-only sign-in proof and list-column dump
build.ps1     PyInstaller build
config.example.json        config template (placeholders only)
```

---

## Integrations and data

- **SharePoint** (`/sites/NBGW/systems`)
  - Lists: **NBGW Computers New Stock** (Boneyard devices are rows with `Status = Boneyard`), **NBGW Computers In Use**, and **NBGW Inventory Log**.
  - Columns are matched **by display name at runtime** (`FIELD_ALIASES` in `graph.py`), so a renamed column doesn't silently drop data. The serial is always `Title`.
  - Nothing enforces unique serials, so every sync starts by removing duplicate rows.
  - *Model Spec References* is no longer used.
- **Activity log list.** The app tries to create **NBGW Inventory Log** itself, but that needs site *Manage Lists / Full Control* rights. If it can't, a site owner creates it once: a blank list named `NBGW Inventory Log` with single-line text columns **Action, Serial, Model, Actor, Details, LoggedAt**. After that, Contribute is enough.
- **Intune.** The fleet is the device category **`NBGW`**, Windows only by default. Software inventory comes from the Intune `AppInvRawData` export, which takes minutes.
- **Entra.** People in scope are defined by `companyName = "Nucor Buildings Group West"`. Department names are shared with other divisions, so the app never scopes by department alone.
- **Shared team data.** JSON files in the OneDrive-synced `_EndpointHub` folder: no auth, atomic writes, **no locking**.
- **Vendors.**
  - **Lenovo** is live (`supportapi.lenovo.com/v2.5` product + warranty). Its key is `lenovo_client_id` in `config.json`.
  - **Dell** is a placeholder (`lookup_dell`) until a TechDirect API key arrives.
- **SQL / AD.** Accessed through PowerShell with the user's own Windows credentials. No stored credentials.

---

## Unattended sync (still open)

A desktop app only runs when someone opens it. Today every client syncs on launch. The options for an always-on sync:

- **Target:** a timer-triggered **Azure Function** running `sync.run_sync()` with a **Managed Identity** (app-only Graph, no stored secret). This follows Nucor's preference for managed identity in deployed apps. After that, client-side sync can become opt-in.
- **Interim:** keep the legacy Stock Sync Power Automate flow, re-owned from its personal owner to a service account. Whether it still runs is unconfirmed; see HANDOFF §15.
- **Stopgap only:** `python sync.py --commit` from Task Scheduler on one always-on PC.

---

## Security and design notes

- **No secrets in source.**
  - Graph auth is a public client with PKCE, so there is no client secret at all.
  - `tenant_id` and `client_id` are identifiers.
  - The one real secret, `lenovo_client_id`, lives only in the gitignored `config.json`. That file currently ships inside the shared `dist\` folder; see HANDOFF §11 and §15.
- **Corporate TLS inspection.** `graph.py` calls `truststore.inject_into_ssl()` so HTTPS verifies against the Windows certificate store, which holds the proxy's root CA. Verification is never disabled (`verify=False` is never used).
- **Token cache.** Stored at `%LOCALAPPDATA%\NBG Hub\.token_cache.bin`, encrypted with Windows DPAPI (`securecache.py`, current user + machine only). An old plaintext cache is migrated automatically on the next sign-in; an undecryptable cache just means signing in again.
- **Configuration PIN.** It's a UI lock only, not access control.
- **Known issues and roadmap.** See HANDOFF §11 (ranked issues: Boneyard false positives, config reseed, full-window site bridge exposure, boot race, shared-file locking) and §14.
