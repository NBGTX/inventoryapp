# NBGW Hub — Developer Handoff

> **Prepared:** 2026-09-30, by Claude Code, for the handoff from Blake Stevenson (NBGW IT) to the next developer.
> **Covers:** **v2026.09.29** (built and deployed 2026-09-29).
> **Project folder ("project root"):** `C:\Users\Blake.Stevenson\OneDrive - Nucor\Documents\Claude\Inventory Desktop App\`. **This folder is not a git repository.**
> **Line numbers** are accurate for v2026.09.29 and will drift as the code changes. Each one is paired with a function or object name so you can find it with a search.

### Evidence tags used throughout

| Tag | Meaning |
|---|---|
| **(V)** | Verified directly in the code or on disk while this document was written (2026-09-30). A `file:line` is given. |
| **(L)** | Verified live against the Nucor tenant in the sessions of 2026-09-25 → 09-29 (read-only probe scripts, plus the fixes applied then). |
| **(H)** | From project history: conversation logs, Claude memory notes, `README.md`, or `NBGW Hub - Deployment and Update Guide.docx`. Dated where possible. **Not re-verified.** |
| **(?)** | Unknown or unconfirmed. A human needs to answer. Every one of these is collected in §16. |

---

## 0. First-day briefing: 10 things to know before touching anything

1. **There is no version control.**
   - The OneDrive folder above is the only real copy (V: `git rev-parse` fails).
   - `C:\Program Files\NBG\Inventory Desktop App\` is an **abandoned 2026-07-28 snapshot**. Its `app.py` is 23 KB against 78 KB today (V). Ignore it.
   - **First action:** `git init` and commit. `.gitignore` already excludes `config.json`, token caches, `build/`, `dist/` and `*.spec` (V: `.gitignore`).

2. **Running the app changes production data.**
   - About 4 s after launch the UI runs `run_sync`, then `enrich_inventory`, then `boneyard_sweep`, all with commit on (V: `web/app.js:318-366`). Together these add, update, **delete** and move SharePoint rows.
   - Every dashboard load **writes** the shared upgrade list (V: `app.py:1489-1490`), and the dashboard refreshes every 45 s and on window focus (V: `app.js:4617-4618`).
   - There is **no test tenant or staging list**. Do UI work in the browser Mock preview (§5.6). Do backend work with read-only probes or the dry-run flags.

3. **Where it runs and how releases ship.**
   - The team runs `C:\Users\Blake.Stevenson\Nucor\Systems Home - Inventory Desktop App\dist\NBGW Hub.exe`, which sits in a OneDrive-synced SharePoint library (V). It is running v2026.09.29.
   - Shared team data lives beside that exe, in `dist\SystemsData\_EndpointHub\` (V: `hub.py:87-93`).
   - To release: build in the project `dist\`, **close the app** (a running exe is locked), then copy the exe over. There is no installer and no CI.

4. **The shared-data folder depends on how the code is run** (V: `hub.py:48-53`).
   - Frozen exe: the folder is the exe's own folder.
   - `python app.py` or any script: the folder is the project root.
   - So a script writes to `<project>\SystemsData\`, **not** to live data. This caused a real incident on 2026-09-25 (H).
   - To target live data from a script: `api._hub = Hub(logs_folder=r"<live dist>\SystemsData")`.

5. **Secrets live only in `config.json`.** It is gitignored and sits beside `app.py` or the exe (V).
   - `lenovo_client_id` is a real secret (a vendor API key).
   - `tenant_id` and `client_id` are app identifiers.
   - The MSAL token cache is stored **in plaintext** at `%LOCALAPPDATA%\NBGW Hub\.token_cache.bin` (V: `graph.py:118, 182-196`).
   - Never print or commit either file. Get a `config.json` from Blake (?).

6. **Every permission is delegated: the app acts as whoever is signed in.** You personally need:
   - An Intune RBAC role that can read **all** managed devices.
   - SharePoint Contribute on `/sites/NBGW/systems`.
   - SQL rights on `BGBRISQL07` (for Timesheet Fix only).
   - The corporate network (for the AD lookups).

   Tenant admin consent for the app's scopes already exists; Directory.Read.All worked on 2026-09-29 (L). If a role is missing you get partial or empty data, **sometimes with no error**.

7. **"NBGW" means different things for devices and for people.**
   - **Devices:** the Intune *device category* `NBGW` (V: `graph.py:473, 943`).
   - **People:** Entra `companyName == "Nucor Buildings Group West"` (V: `app.py:1008`).
   - Department names such as "Detailing Dept NBS" are **shared with other divisions** (NBGTX Terrell, NBSIN Waterloo), and so is the `@nucor.com` domain. **Never scope people by department or email domain alone** (fixed 2026-09-29 (L)).

8. **Every backend method has a Mock twin, and the real app falls back to it silently.**
   - `Backend.call` uses `Mock` whenever `window.pywebview.api[method]` doesn't exist (V: `app.js:9-17`). A renamed or missing Python method therefore shows demo data instead of an error.
   - When you add an `Api` method, **add a Mock entry too**.
   - The browser preview caches `app.js` aggressively (§12).

9. **The build ritual.**
   1. Bump the version in **both** `version.py` and `version.txt`, every build. This is Blake's standing rule; format `YYYY.MM.DD`, then `.2`, `.3` for later builds the same day.
   2. Delete `build\`. PyInstaller reuses its cache and has shipped stale code before (H).
   3. Fix the hardcoded Python path in `build.ps1:30` (V).
   4. Close the app.
   5. Run `powershell -ExecutionPolicy Bypass -File build.ps1`.

   PyInstaller logs to **stderr**, so wrapping the build in `$ErrorActionPreference='Stop'` makes it "fail" (H).

10. **Handle-with-care zones** (details in §11):
    - **Boneyard auto-retire.** It moves and deletes SharePoint rows automatically, and it has false-positive paths.
    - **Shared config reseed.** It can overwrite the team's checklist config with defaults.
    - **Full-window NBT Sites.** External pages there can reach the Python API.
    - **Timesheet unlock.** This is an UPDATE against the production SQL database, and it **must not** change ModifiedBy or ModifiedDate. That was Blake's explicit requirement, and the code honours it (V: `app.py:861-866`).

---

## 1. Project overview

### What it is

- **NBGW Hub** is a Windows desktop app for the **NBGW Systems (IT) team** at **Nucor Buildings Group West**, which has two sites: **LTR** (Lathrop, CA) and **BRI** (Brigham City, UT).
- It is built with Python and pywebview (Edge WebView2) and shipped as a single `.exe` by PyInstaller.
- On 2026-07-23 it merged two earlier tools (H):
  - an inventory app that replaced a SharePoint + Copilot "Chip" agent + Power Automate system, and
  - a C# "Endpoint Hub" setup-checklist tool.

**Features, in sidebar order** (V: `web/index.html:18-52`):

| View | What it does | Main code |
|---|---|---|
| **Dashboard** | KPI tiles with drill-downs (see below). | `Dashboard` `app.js:1416`; `Api.get_dashboard` `app.py:1363` |
| **Endpoint Provisioning** | New-computer and new-user setup checklists per department. They resume where you left off, progress is shared, you can reserve a stock device, and each setup produces an HTML record. | `Hub` `app.js:3629`; `hub.py` setups |
| **Devices** | The SharePoint **New Stock** and **In Use** lists plus a **Boneyard** tab. Add machines (with vendor spec lookup), edit, move, remove. Buttons: Sync now, Populate MFA, Master sync, Log. | `App`, `Wizard`, `DeleteView` `app.js:282-1018` |
| **Upgrades** | Upgrade queue per site. Devices with a CPU 5+ years old are queued automatically. Priorities, drag to reorder, links to a setup. | `Upgrade` `app.js:2807`; `hub.py` upgrades |
| **Software** | Intune app inventory by user and department. The top 10 apps per department are mandatory automatically, with manual overrides. Compliance is judged against the **latest** version only. | `Software`, `SWLogic` `app.js:2565-2798` |
| **BG Tools** | **Timesheet Fix** (SQL week unlock), **Permissions Finder** (a person's Entra groups, with a Division filter), **Missing Groups** (compares people against department group baselines). | `BGTools` `app.js:2148`; `app.py:804-1240` |
| **NBT Sites** | Launcher for Nucor web tools. Each site opens in the system browser, full-window inside the app, a separate window, or embedded. | `Sites` `app.js:1141` |
| **Project Hub** | Opens Project Hub (**DEV** URL) in the default browser. | `ProjectHub` `app.js:1113` |
| **Configuration** (sidebar footer, PIN-gated) | Tabs: Model→Department map, NBT Sites editor, Group baselines, Storage info. | `Depts` `app.js:3066` |

Dashboard tiles and their drill-downs:
- In use / in stock
- Hot spares
- No UPN set
- Warranty ≤90 days
- Upgrade forecast
- No Intune check-in in 30+ days. Shows whether the device still exists in AD, Entra and Intune, and offers "Retire to Boneyard".
- No MFA
- Not part of NBGW

Also: a "Report bug / feature" modal, a "Versions in use" list (click the version line in the sidebar), and a Hot Spares modal.

### Who uses it

- NBGW Systems techs.
- The live `nbgw-app-clients.json` shows at least two machines running it: Blake's `BGPF5MDA4B` and `BGBRISKELLY01` (V).
- The full list of users and who should hold the Configuration PIN is not recorded (?).

### Current status

- In production use (V: the live exe is v2026.09.29).
- Developed iteratively with Claude Code from July to September 2026; most features date from August and September (H).
- **No tests, no CI, no version control** (V).

### What "done" looks like

This was **never formally defined** (?). Proposed from the history, for Blake or the new owner to confirm:
1. The legacy Power Automate flows are retired, and In Use sync runs **unattended on a schedule** instead of on every client launch.
2. The exe is code-signed or installed through a managed channel, and the shared-data path is preserved (see §7).
3. The code is in version control with minimal automated tests.
4. Dell lookups and the MFA column work.
5. The Boneyard, config-reseed and full-window hardening items in §11 are closed.

---

## 2. Architecture

### Components

```
┌────────────────────── NBGW Hub.exe  (PyInstaller --onefile --windowed) ──────────────────────┐
│ web/ (index.html · app.js · styles.css) rendered in Edge WebView2                              │
│    Backend.call("method", …) ─► window.pywebview.api.method(…)   (falls back to Mock!)         │
│                                   │  pywebview js_api bridge — each JS call runs on its own    │
│                                   ▼  Python thread (hence the sign-in lock in graph.py)        │
│ app.py  class Api  — thin façade, every method returns {"ok": bool, …}                        │
│    ├─ graph.py  GraphClient ─► MSAL PublicClientApplication (delegated, PKCE, no secret)       │
│    │      ├─► Microsoft Graph v1.0: Intune managedDevices + export jobs, Entra users/groups/   │
│    │      │   devices, auth-method & registration reports, $batch                               │
│    │      ├─► SharePoint lists  nucor.sharepoint.com /sites/NBGW/systems                        │
│    │      └─► Lenovo support API v2.5 (specs + warranty; key = lenovo_client_id)                │
│    ├─ sync.py   reconcile In Use ⇄ Intune (dedupe, add/refresh, enrich, MFA, master sync)      │
│    ├─ hub.py    shared JSON store  <exe dir>\SystemsData\_EndpointHub  (OneDrive-synced,       │
│    │            no auth, atomic writes, NO locking)                                             │
│    ├─ adlookup.py ─► powershell.exe ─► .NET DirectorySearcher ─► on-prem AD bg.nucorsteel.local │
│    └─ sqltools.py ─► powershell.exe ─► .NET SqlClient ─► SQL Server BGBRISQL07 (Integrated Sec.)│
└───────────────────────────────────────────────────────────────────────────────────────────────┘
 config.json beside the exe (secrets)   ·   token cache %LOCALAPPDATA%\NBGW Hub\.token_cache.bin
```

- `app.py`: pywebview entry point; `Api` is exposed at `app.py:78-79`; `main()` is at `app.py:1560-1597` (V).
- `graph.py`: auth and all Graph/SharePoint/vendor access (V).
- `hub.py`: port of the C# Endpoint Hub's file store, same folder layout (V: `hub.py:2-21`).
- `sync.py`: reconciliation plus a CLI (V: `sync.py:2-19`).
- `adlookup.py`, `sqltools.py`: PowerShell shims (V).
- `cpu.py`: CPU model → release year, used for "Needs upgrade" (V).
- `version.py`: `APP_VERSION` (V).

### Systems of record

| Data | Lives in | Written by |
|---|---|---|
| Device inventory (New Stock, In Use; Boneyard is a New Stock row with `Status=Boneyard`) | SharePoint lists | `graph.py` add/update/delete, `sync.py`, `Api` device methods |
| Activity/audit log for device actions | SharePoint list "NBGW Inventory Log" | `graph.add_log` (`graph.py:1285`, never raises) |
| Device presence (source of truth) | Intune, Entra, on-prem AD | read-only |
| Setups, upgrades, hot spares, boneyard snapshots, model→dept map, NBT sites + PIN, software cache + rules, group baselines, client versions, program-change log, feedback | Shared JSON in `_EndpointHub\` (§8.2) | `hub.py` |
| Timesheet week locks | SQL `NBSTimesheet.dbo.WeekLocked` | `Api.ts_unlock` |
| Employee lookup | SQL `NBSEmployeeInfo.dbo.SAP_Interface` | read-only |

### Main data flows

**Startup** (V: `app.js:4608-4620`, `289-366`)
1. `pywebviewready` → `_boot(true)`. As a fallback, 300 ms after `load` → `_boot(false)`, which is Mock mode (**a bug**, see §11).
2. `_boot` runs, in order:
   - `Hub.boot()`: loads the checklist config, or seeds defaults.
   - `Sites.boot()`
   - `Depts.load()`
   - `Dashboard.load()`
   - `App.init()` → `get_status`. If signed in, `startup()`: paint from the localStorage cache, then `reload()`, then 4 s later `backgroundSync()`.
   - `setInterval(refreshShared, 45000)`, plus a `refreshShared` on window focus.
3. `backgroundSync` runs `run_sync` → reload → `enrich_inventory` → reload → `boneyardSweep` (V: `app.js:334-366`).

**In Use sync** (V: `sync.py:32-120`)
1. `dedupe_in_use` runs first. It keeps the row with the freshest check-in and deletes the others.
2. Pull the Intune devices whose category is `NBGW` and OS is `Windows`.
3. For each device:
   - **Missing from In Use:** add it, and **delete its New Stock row**.
   - **Already present:** always refresh user, OS version, OS install date and device name. Fill model, manufacturer, storage and site only if they are blank. Update last check-in only when the date changes.
4. Write one audit log entry per run.

**Boneyard** (V: `app.py:709-802`, `614-668`)
1. Candidates are In Use rows stale for more than 30 days.
2. `locate_devices` checks each one: Intune by serial, Entra by hostname, AD by hostname.
3. Guards: AD reachable, Entra "on", Intune queried, and at least one known-active "control" device found in AD.
4. A device absent from all three is moved to New Stock with `Status=Boneyard`, and a snapshot goes to `nbgw-boneyard.json`.
5. Boneyarded devices that reappear are restored automatically.

**Missing Groups**
1. Baselines: `perm_analyze_dept` takes the NBGW-company members of a department, gets their transitive groups through batched `$batch` calls of 20, and tallies them (V: `app.py:1125-1166`, `graph.py:559`).
2. Groups held by at least the threshold (0.7) are marked "expected". Only groups held by at least 20% **and** at least 2 people are stored.
3. `perm_missing_for_user` / `perm_missing_in_dept` compare people against the expected list. Non-NBGW people are refused, not compared (V: `app.py:1168-1240`).

**Timesheet Fix** (V: `app.py:805-877`)
1. `ts_search`: LIKE search on `SAP_Interface`.
2. `ts_weeks`: the last 8 `WeekLocked` rows.
3. `ts_unlock`: `UPDATE … SET Locked = 0 WHERE … AND Locked = 1`. It is parameterized and writes an audit entry to the hub change log.

### Key design decisions and rejected alternatives

| Decision | Rejected alternatives and why | Source |
|---|---|---|
| Python + pywebview desktop app replacing the Copilot/Power Automate front end; the SharePoint lists stay the system of record | Keep Power Automate plus the app-only secret (needed Premium and a stored secret). A fully local no-Azure build using files + vendor APIs (built, then deleted, because Blake wanted live Intune and SharePoint). The C# Endpoint Hub as the base (Python already had MSAL, Graph, the shell and packaging). | (H) 07-02, 07-21, 07-23 |
| Delegated MSAL **public client** (PKCE, no secret); each user acts with their own rights | App-only client secret (a secret in a desktop app, and too broad). | (H) 07-02; (V) `graph.py:219-238` |
| Lazy sign-in: Dashboard and Provisioning work signed-out | Force sign-in at launch. | (H) 07-23 |
| The fleet is the Intune **device category** `NBGW`, filtered server-side | Scope tags (`roleScopeTagIds` can't be used in `$select`; Graph returns 400). | (H) 07-23 |
| Vendor specs come from the official **Lenovo API** on every add | Scraping Dell/Lenovo websites (Dell blocks bots; marked "don't revisit"). The Model Spec References list (dropped). | (H) 07-02, 07-22 |
| Shared team state is **JSON files in a OneDrive-synced folder** beside the exe | SharePoint lists via Graph (recommended at the time but not done), JSON in a SharePoint library via Graph, Azure Table or Dataverse. The file store won on simplicity and no-auth. **Its no-locking weakness is now visible** (§11). | (H) 08-04, 08-07 |
| Default data folder is `<exe dir>\SystemsData` (in code, not config) so updating means just replacing the exe | The old per-user `%USERPROFILE%\Nucor\…` default (everyone saw different data). Pinning the path in config.json. | (H) 08-07; (V) `hub.py:87-92` |
| NBT Sites: SSO sites open in the system browser; Intune and Entra open **full-window** in the app with an injected Back button | Iframes (SSO redirect loops). A WebView2 SameSite flag (didn't help). Separate windows (Blake wanted them in-app). | (H) 07-24, 07-28 |
| Software inventory from the Intune **AppInvRawData export job** | `detectedApps?$expand` (throttled immediately). | (H) 08-11 |
| Boneyard: **instant** auto-retire when a device is absent from AD, Entra and Intune, with self-heal and one-click Restore | A grace period, or manual-only. Blake chose instant. | (H) 09-21, 09-23 |
| Duplicate In Use rows are fixed with a **dedupe at the start of every sync** | A cross-client lock (no shared lock mechanism exists). | (L) 09-28; (V) `sync.py:123` |
| Group baselines are scoped by Entra **`companyName`**, over **all** groups, at a 70% threshold | Department name alone (shared across divisions). Email domain (everyone is `@nucor.com`). The NBGW Intune device roster (includes NBT IT, NTS, NIPG and others). BomsNet groups only (Blake asked for all groups). | (L) 09-25, 09-29 |
| Permissions Finder "tenant switcher" is a **Division dropdown** (companyName, or email domain for separate brands) | A real tenant switch (every BG location is in the one Nucor tenant). A domain-only filter (can't separate NBGW from NBGTX). | (L) 09-25, 09-29 |
| AD and SQL through **PowerShell + .NET** with the user's Kerberos credentials | RSAT modules or stored SQL credentials. | (H) 09-21; (V) `adlookup.py`, `sqltools.py` |
| CPU age from a **generation → release-year table** | Per-SKU lookup (thousands of brittle entries). | (H) 07-24; (V) `cpu.py` |
| Versioning `YYYY.MM.DD(.N)` shown in the sidebar, plus a "Versions in use" registry | None recorded. | (H) 09-21, 09-25 |

---

## 3. Tech stack and versions

Versions below are installed on Blake's machine per `pip list`, 2026-09-30 (V).

| Layer | Details |
|---|---|
| Language | **Python 3.12.10** (Windows, user install). JavaScript ES2017+ (`"use strict"`, no modules). HTML, CSS. |
| Desktop shell | **pywebview 6.2.1** on Edge **WebView2**, via **pythonnet 3.1.0** and **clr_loader 0.3.1**. Also needs bottle 0.13.4 and proxy_tools 0.1.0. |
| Auth | **msal 1.37.0**, public client. |
| HTTP | **requests 2.34.2** (urllib3 2.7.0, certifi 2026.6.17), plus **truststore 0.10.4**, which is required to work through the corporate TLS-inspecting proxy. |
| Packaging | **PyInstaller 6.21.0** with pyinstaller-hooks-contrib 2026.6. Also cffi 2.0.0, setuptools 82.0.1, packaging 26.2. |
| Frontend | Vanilla JS, one 4,620-line `app.js`. No framework, bundler, npm or TypeScript. |
| OS dependencies | Windows 10/11, the WebView2 runtime, and **Windows PowerShell 5.1** (`powershell.exe`, used by `adlookup.py` and `sqltools.py`). |
| External services | Microsoft Graph v1.0, SharePoint Online, Intune, Entra ID, Lenovo `supportapi.lenovo.com/v2.5`, SQL Server `BGBRISQL07`, on-prem AD `bg.nucorsteel.local`, the OneDrive sync client. |

Notes on `requirements.txt`:
- It pins **minimums only** (`msal>=1.31`, `requests>=2.32`, `pywebview>=5.3`, `truststore>=0.10`) (V).
- It omits pythonnet, clr_loader, bottle, proxy_tools, cffi and pyinstaller. pywebview pulls most of those in; the build-time packages you install separately.
- For reproducible builds, freeze the list above into a lock file.

---

## 4. Directory structure

```
Inventory Desktop App\              (project root — not a git repo)
├─ app.py            1605 lines  pywebview entry; class Api (all JS-callable methods); main()
├─ graph.py          1316        GraphClient: MSAL, Graph, SharePoint, Intune, Entra, MFA, Lenovo
├─ hub.py             832        Hub: shared JSON store (_EndpointHub), atomic writes, change log
├─ sync.py            519        run_sync / dedupe_in_use / enrich_in_use / master_sync / populate_mfa (+ CLI)
├─ adlookup.py        119        on-prem AD computer lookup via PowerShell
├─ sqltools.py         90        parameterized SQL via PowerShell + SqlClient
├─ cpu.py              71        CPU model → release year
├─ version.py                    APP_VERSION  (bump every build, with version.txt)
├─ version.txt                   PyInstaller version resource (FileVersion/ProductVersion)
├─ build.ps1                     the build script (onefile default; -OneDir; -Deploy)
├─ requirements.txt              runtime deps (minimums only)
├─ config.example.json           template: placeholders only, safe to share
├─ config.json                   REAL config incl. secrets — gitignored, never commit/print
├─ .gitignore
├─ README.md                     quick start, prerequisites, build/release (rewritten 2026-09-30 from this doc)
├─ NBGW Hub - Deployment and Update Guide.docx   options A/B/C for distribution (A and C never built)
├─ NBGW Hub.spec                 regenerated by every build (gitignored)
├─ NBGW Inventory.spec           stale leftover from the old name — safe to delete (?)
├─ web\
│  ├─ index.html      318        shell: sidebar nav + one <section class="appview"> per view
│  ├─ app.js         4620        ALL UI logic + the Mock backend
│  └─ styles.css      676        dark theme, CSS custom properties
├─ poc\
│  ├─ test_intune_signin.py      manual sign-in + Intune/SharePoint read proof (needs poc\config.json)
│  ├─ inspect_lists.py           dumps SharePoint list columns (display → internal) + a sample item
│  └─ config.example.json
├─ SystemsData\_EndpointHub\     ⚠ script-mode/test data — NOT live (stale baselines etc.)
├─ dist\                         build output: NBGW Hub.exe + config.json (+ a test SystemsData\)
└─ build\                        PyInstaller cache — delete before release builds
```

**Most important files, in reading order:**
1. `app.py`: `Api`, especially `get_dashboard`, `boneyard_sweep`, and the BG Tools section `app.py:804-1240`.
2. `graph.py`: auth (`graph.py:198-264`), `_req` retries (`graph.py:284-325`), and `FIELD_ALIASES` (`graph.py:52-71`).
3. `sync.py`.
4. `hub.py`: path resolution and the file list.
5. `web/app.js`: `Backend`/`Mock` (lines 9-279), `App`, `Dashboard`, `Depts`, `Hub`, and `_boot` (line 4608).

**Outside the project folder:**

| Path | What it is |
|---|---|
| `C:\Users\Blake.Stevenson\Nucor\Systems Home - Inventory Desktop App\dist\` | **LIVE** exe, config and team data (V) |
| `%LOCALAPPDATA%\NBGW Hub\.token_cache.bin` | Per-user token cache (V: `graph.py:118`) |
| `%LOCALAPPDATA%\NBGW-Endpoint-Hub\config-history\` | Local backups of each checklist-config save (V: `hub.py:108-109, 216-220`) |
| `C:\Users\Blake.Stevenson\OneDrive - Nucor\.claude\launch.json` | Blake's Claude preview config `nbgw-hub-web` (port 8810, hardcoded path) (V) |
| `C:\Program Files\NBG\Inventory Desktop App\` | Abandoned 07-28 source snapshot (V) |

---

## 5. Local setup

There is nothing to clone yet, because there is no repository.

### 5.1 Get the code
- **Now:** copy the project folder from Blake's OneDrive share.
- **Once git exists:** clone the new repository (§14 step 1).
- **Do not copy** `config.json`, `dist\`, `build\`, `SystemsData\` or any `.token_cache.bin`.

### 5.2 Install Python 3.12 (Windows, per-user)
```powershell
winget install --id Python.Python.3.12 -e --scope user
```
Python is **not** on Git Bash's PATH on Nucor machines. Use PowerShell or the full path to `python.exe` (H).

### 5.3 Install dependencies (corporate proxy)
```powershell
python -m pip install -r requirements.txt
python -m pip install pythonnet clr_loader pyinstaller   # build + WebView2 bridge
```
The Nucor proxy inspects TLS and blocks bursts of downloads (H: 07-21; memory "windows-python-proxy-install"). If `pip` fails:
- Install one package at a time with `--no-deps --no-cache-dir`, spacing the commands out.
- Or download wheels with `curl.exe -L -C - --ssl-no-revoke <url>` and install them with `pip install --no-index --find-links <dir>`.
- Blake had to copy `cffi`, `setuptools` and `packaging` out of a local Codex runtime cache because the proxy wouldn't serve them at all (H).

### 5.4 Configure
1. Copy `config.example.json` to `config.json` in the project root.
2. Fill in `tenant_id`, `client_id` and `lenovo_client_id`. Get them from Blake or the app registration owner, through a secure channel (?).
3. Optional keys are listed in §6.

Sign-in fails fast if `tenant_id` or `client_id` is blank or still starts with `PASTE` (V: `graph.py:144-146`).

### 5.5 Run from source (real backend — this changes production data, see §0 item 2)
```powershell
python app.py
```
- A window opens titled "NBGW Hub", 1500×900 (V: `app.py:1577-1584`). Sign-in is interactive MSAL in the system browser.
- Shared data goes to `<project>\SystemsData\_EndpointHub\` (§0 item 4).

### 5.6 Run the UI with the Mock backend (safe — no Microsoft or SQL calls)
```powershell
python -m http.server 8810 --directory web
# open http://localhost:8810
```
- `Backend.real` stays `false` outside pywebview, so every call goes to `Mock` (V: `app.js:9-17`).
- **Caching:** the preview caches `app.js` and `styles.css` hard. Use a fresh port or a hard reload, or confirm with `fetch('/app.js',{cache:'no-store'})` (H).

### 5.7 Proof-of-concept and diagnostic scripts (read-only)
```powershell
python poc\test_intune_signin.py [serial]   # needs poc\config.json (keys: tenant_id, client_id, sharepoint_hostname, site_path)
python poc\inspect_lists.py                 # dump real SharePoint column names
python sync.py                              # DRY RUN of run_sync (prints what would change; interactive sign-in)
```
`python sync.py --commit` **writes** to production (V: `sync.py:495-509`).

### 5.8 Tests
**There are none** (V). Before a release, the usual checks were:
- `python -c "import ast; [ast.parse(open(f,encoding='utf-8').read()) for f in ('app.py','graph.py','hub.py','sync.py')]"`
- Exercising the UI in the Mock preview.
- Targeted read-only probe scripts, for example the dry-run `dedupe_in_use(gc, commit=False)`.

Node.js is not installed on Blake's machine, so `node --check web/app.js` wasn't available (V).

### 5.9 Build
```powershell
# 1. bump version.py APP_VERSION + version.txt (filevers/prodvers tuples AND the two strings)
# 2. edit build.ps1:30 so $py points at YOUR python.exe
Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue
powershell -ExecutionPolicy Bypass -File build.ps1          # -> dist\NBGW Hub.exe + dist\config.json
# options: -OneDir (folder build; fewer AV false positives)  -Deploy (see §7 caveat)
```
- `build.ps1` copies the project `config.json` into `dist\` (V: `build.ps1:43`). **A `config.json` must exist before you build.**
- New local modules that are imported lazily must be added to `--hidden-import` (V: `build.ps1:39`; currently `hub`, `adlookup`, `sqltools`, `version`).

---

## 6. Environment and configuration

### 6.1 `config.json` keys

`config.json` sits beside `app.py` or the exe. It is read by `graph.load_config`, which uses the exe's folder when frozen (V: `graph.py:109-112, 136`), and separately by `hub.py`, only for `logs_folder` (V: `hub.py:56-67`).

| Key | Purpose | Default / required | Where read |
|---|---|---|---|
| `tenant_id` | Entra tenant for the MSAL authority | **required** | `graph.py:144-146, 220` |
| `client_id` | App registration "Inventory Dashboard" (public client) | **required** | `graph.py:144-146, 219` |
| `lenovo_client_id` | **SECRET**: Lenovo support API ClientID header | optional; Lenovo lookup returns None without it | `graph.py:1036-1040` |
| `sharepoint_hostname` | SharePoint host | `nucor.sharepoint.com` | `graph.py:343` |
| `site_path` | SharePoint site | `/sites/NBGW/systems` | `graph.py:344` |
| `lists.new_stock` / `lists.in_use` / `lists.model_specs` | List display names ("NBGW Computers New Stock", "NBGW Computers In Use", "Model Spec References") | **required** (KeyError if missing) | `graph.py:355` |
| `lists.log` | Audit log list name | `NBGW Inventory Log` | `graph.py:1252` |
| `site_tags` | Present in the config files but **never read** | — | (V: unused) |
| `logs_folder` | Overrides the shared data folder (env vars allowed; a relative path resolves against the exe folder) | `<exe dir>\SystemsData` | `hub.py:63, 79-92` |
| `intune_device_category` | Intune device category that defines the fleet | `NBGW` | `graph.py:473, 943` |
| `intune_device_os` | OS filter; `""`, `all`, `*` or `any` means every OS | `Windows` | `graph.py:944-945` |
| `intune_enrich_per_sync` | Maximum vendor lookups per sync | `75` | `sync.py:195` |
| `ad_domain` | On-prem AD domain | `bg.nucorsteel.local` | `app.py:647, 669` |
| `timesheet_sql_server` | SQL server for Timesheet Fix | `BGBRISQL07` | `app.py:806` |
| `permission_locations` | `[{label, domain}]` list of BG brands (email domains) | 13 built-ins | `app.py:883-897, 914-916` |
| `permission_divisions` | `[{label, company}]` list of divisions (companyName) | NBGW, NBGTX, NBSIN, NBGSC | `app.py:898-907, 919-921` |

The current live and project `config.json` both contain only the 7 base keys: `client_id`, `lenovo_client_id`, `lists`, `sharepoint_hostname`, `site_path`, `site_tags`, `tenant_id`. Every optional key therefore uses its default (V).

### 6.2 Environment variables
- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`: **set by the app itself**. It appends `--disable-features=SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure` (V: `app.py:1567-1569`). This was a leftover attempt to make SSO work inside an iframe (H).
- `LOCALAPPDATA`, `USERNAME`, `COMPUTERNAME`: used for the token cache, config history, and the change-log actor/machine (V: `graph.py:118`, `hub.py:40-41, 108`).
- No `.env` file is used. No other environment variables are read (V).

### 6.3 Settings that live in the shared hub, not in config
Changing these affects **every user**, immediately.
- **Configuration PIN** and the NBT Sites list: `nbgw-nbt-sites.json`. The default PIN is hardcoded at `app.js:1160` (value intentionally omitted here) (V).
- **Group baseline threshold, company scope and departments:** `nbgw-perm-baselines.json`. Keys `threshold` (0.7), `company` ("Nucor Buildings Group West"), `keyword` ("" means all groups) (V: `app.py:1011-1024`).
- **Checklist config:** `nbgw-endpoint-hub-config.json`.

### 6.4 Constants in code that act as configuration
- `_PERM_THRESHOLD_DEFAULT = 0.7`, `_PERM_STORE_MIN_PCT = 0.2`, `_PERM_COMPANY_DEFAULT`, `_PERM_MIN_MEMBERS = 5` (V: `app.py:996-1009`).
- `AUTO_MANDATORY_TOP = 10` (V: `app.js:2569`).
- `ProjectHub.URL` is the **DEV** URL (V: `app.js:1114`).
- Hostname prefix → site: `BGLTR`/`BGCCN`/`BGMOD` → LTR, `BGBRI` → BRI (V: `graph.py:841-850`).
- Stale threshold: 30 days (V: `app.py` stale check-in logic).

---

## 7. Deployment

**Current practice** (V for paths; H for process):
1. Build in the project folder (§5.9) → `dist\NBGW Hub.exe`.
2. Ask users to close the app. At minimum Blake closes his own copy, because OneDrive replaces the file for everyone; whether other users' open copies block the sync is unknown (?).
3. Copy the exe to `C:\Users\Blake.Stevenson\Nucor\Systems Home - Inventory Desktop App\dist\`. That library syncs to the team, who run the exe from their synced copy.
4. `config.json` already sits beside the live exe. Only copy it if its contents changed.
5. Check the sidebar version and the "Versions in use" list (`nbgw-app-clients.json`).

**There is no CI/CD, installer, or auto-update** (V).

**These paths are Blake's local OneDrive sync locations.**
- `C:\Users\Blake.Stevenson\Nucor\Systems Home - Inventory Desktop App\` is how a SharePoint document library appears on Blake's machine. On yours it will be `C:\Users\<you>\Nucor\Systems Home - Inventory Desktop App\`, once the library is shared with you and synced (or added as a shortcut).
- The SharePoint site and library URL behind it is not recorded (?).
- The project folder is under Blake's personal OneDrive (`OneDrive - Nucor\Documents\Claude\…`). Move the source to git (§14) rather than relying on sharing that folder.

**`build.ps1 -Deploy`** copies to `C:\Program Files\NBG` (V: `build.ps1:49-62`). **Don't use it as is.** The data folder defaults to *beside the exe*, so a Program Files install would give each machine its own non-shared, probably read-only, data, unless `logs_folder` is set to the shared path. The same applies to the Deployment Guide's "Option C" (Intune Win32 app installed to `%LOCALAPPDATA%`) (H). The guide's "Option A" auto-updater (`_release\latest.json`) was never built (V: no such code).

**Location history:** the live folder moved on 2026-09-29, from `Nucor\Systems Home - Computer and User setup logs\Inventory Desktop App\` to `Nucor\Systems Home - Inventory Desktop App\` (V/L). The old path now holds no app.

**Defender:** the onefile exe has been flagged as `Trojan:Win32/Bearfoos.B!ml` (an ML false positive) (H 07-28). Mitigations already built in: version metadata and `--noupx`. The durable fix is code signing plus an allow-by-certificate indicator. A hash-based allow has to be redone for every build. Current Defender status is unknown (?).

---

## 8. Data stores (there is no traditional database)

### 8.1 SharePoint lists (site `nucor.sharepoint.com/sites/NBGW/systems`)

| List (config key) | Role |
|---|---|
| "NBGW Computers New Stock" (`new_stock`) | Deployable stock, plus Boneyard rows (`Status` column: `Stock` or `Boneyard`) |
| "NBGW Computers In Use" (`in_use`) | Mirror of the Intune NBGW fleet, plus vendor specs and MFA |
| "NBGW Inventory Log" (`log`) | Audit log. Columns: Action, Serial, Model, Actor, Details, LoggedAt (single-line text). The app tries to create it; delegated users usually can't, so a site owner creates it (V: `graph.py:1248-1283`). |
| "Model Spec References" (`model_specs`) | **Unused.** The helpers `lookup_model_spec` and `add_model_spec` have no callers (V). |

How columns are handled:
- Columns are resolved **at runtime by display name** through `FIELD_ALIASES` (V: `graph.py:52-71, 397-417`). The 16 logical fields are serial, manufacturer, model, site_tag, cpu, ram, storage, user, device_name, os_version, os_install, last_checkin, date_added, warranty, mfa and status. `serial` is always `Title`.
- Run `poc\inspect_lists.py` to see the real internal names.

Known column facts (H):
- "Primary User" was changed from a person column to **single-line text** (confirmed 2026-07-24). Graph can't reliably write person columns.
- `OSInstallDate` is a dateTime column. Intune has no real OS-install date, so `enrolledDateTime` is used as a stand-in.
- Blake added the MFA and "Last sign in" columns.
- Whether the "Warranty Expiration" column exists is not confirmed (?).

Things to know when working with these lists:
- **No uniqueness on serial (Title).** That is why the dedupe step exists (§11).
- `_items_raw` reads the **whole list** each time (500 per page). `find_by_serial` scans the full list (V: `graph.py:1115-1126`). This is fine at about 480 rows.

### 8.2 Shared JSON store `<data>\_EndpointHub\` (V: `hub.py:93-107` and methods)

| File / folder | Contents |
|---|---|
| `nbgw-endpoint-hub-config.json` | Checklist definitions (user, computer base, departments) |
| `setups\<id>.json` | One file per setup (resumable). `cancel_setup` **deletes** the file. The HTML records go to `<data>\` |
| `changes\<stamp>-<user>-<hex>.json` | Program-change audit log, one file per event |
| `feedback\fb-<stamp>-<hex>.json` | Bug and feature reports |
| `nbgw-model-departments.json` | `{departments, map: {model: dept}}` |
| `nbgw-nbt-sites.json` | `{categories, sites, pin}` |
| `nbgw-upgrade-list.json`, `nbgw-upgrade-log.json` | Upgrade queue, and the log of completed upgrades |
| `nbgw-software-inventory.json` (about 3.6 MB), `nbgw-software-rules.json` | Intune app export cache; mandatory-app overrides |
| `nbgw-hot-spares.json` | Hot spares (LTR/BRI × Detailing/Engineering/Other) |
| `nbgw-boneyard.json` | Snapshots of retired devices (used for Restore) |
| `nbgw-app-clients.json` | Machine / user / version heartbeat |
| `nbgw-perm-baselines.json` (about 438 KB) | Group baselines (§8.4) |

How the store behaves:
- **Writes are atomic** (temp file + fsync + `os.replace`) but there is **no locking**. Only `setups\`, `changes\` and `feedback\` use one file per item. The single-file stores are last-writer-wins.
- **OneDrive conflict copies already exist in live data:** `nbgw-app-clients-BGBRISKELLY01.json` and `nbgw-upgrade-list-BGPF5MDA4B.json` (V). Someone has to reconcile them and delete the extras (?).

### 8.3 SQL Server `BGBRISQL07` (Integrated Security; the user's own rights)

Columns below are as used by the queries; the schema was probed on 2026-09-21 (V: `app.py:815-866`; L).

| Table | Access | Columns used |
|---|---|---|
| `NBSEmployeeInfo.dbo.SAP_Interface` | Read | `EmployeeID`, `FirstName`, `LastName`, `Department` |
| `NBSTimesheet.dbo.WeekLocked` | Read, and `UPDATE Locked` | `EmployID` (char), `FiscalYear`, `FiscalWeek`, `Locked` (bit), `ModifiedBy`, `ModifiedDate` |

The unlock deliberately leaves `ModifiedBy` and `ModifiedDate` untouched (Blake's rule). The `ts_unlock` docstring at `app.py:849-850` still claims otherwise and is stale (V).

### 8.4 Group-baseline document shape
```json
{ "keyword": "", "threshold": 0.7, "company": "Nucor Buildings Group West",
  "departments": { "<Entra department>": { "updated": "ISO", "total": 80, "company": "…",
      "groups": [ { "name": "…", "count": 73, "pct": 0.912, "expected": true } ] } } }
```
The live file was rebuilt on 2026-09-29: 23 NBGW departments from 589 NBGW teammates (L). The comment at `hub.py:298` still says `domain` where the code writes `company` (V: stale comment).

### 8.5 Migrations, seed data, and order of operations

There are **no migrations**. JSON readers tolerate missing keys, and the SharePoint columns are resolved by name. The order that matters:
1. Azure app registration + admin consent (**done**, H/L).
2. The SharePoint lists and their columns exist, including the `Status` column on New Stock (Boneyard depends on it) and the log list (created by a site owner).
3. Each user holds the Intune RBAC role and SharePoint Contribute.
4. `config.json` sits beside the app.
5. On first launch the app creates the hub folders (V: `hub.py:109-115`). `Hub.boot` seeds a default checklist config if none exists (V: `app.js:3645-3649`; **see §11 #3**).
6. **Missing Groups** needs baselines first: Configuration → Group baselines → "⟳ Rebuild from NBGW directory".
7. **Software** needs a "Refresh from Intune" first. The export takes minutes (H).

---

## 9. External integrations

| Service | Used for | Credentials |
|---|---|---|
| **Entra ID / MSAL** | Interactive and silent sign-in. The public client app registration is named "Inventory Dashboard", single-tenant, with the "Mobile and desktop" redirect `http://localhost` and public client flows allowed (H). | IDs in `config.json`. The token cache is at `%LOCALAPPDATA%\NBGW Hub\` in **plaintext** (V: `graph.py:182-196`; DPAPI hardening noted as a to-do). |
| **Graph: Intune** | The fleet (`deviceCategoryDisplayName eq 'NBGW'`), per-serial presence, the software export job | Delegated `DeviceManagementManagedDevices.Read.All` **plus a per-user Intune RBAC role** (Help Desk Operator or better, scoped to all devices). Without the role: a 403, or a silently partial list (H; V: `graph.py:312-319`). |
| **Graph: Entra** | Users, groups (`transitiveMemberOf` via `$batch`), devices, registered owners, user city/office/department | Delegated `Directory.Read.All` (working 2026-09-29, L) and `User.Read.All` |
| **Graph: reports and auth methods** | MFA status (report or per-user methods) | `AuditLog.Read.All`, `UserAuthenticationMethod.Read.All` are consented (H), **plus a directory role** (Global Reader or similar) that was still missing as of 2026-08-12, so MFA may be blocked (H/?) |
| **SharePoint Online** | Device lists and the log | Delegated `Sites.ReadWrite.All`, limited by the user's list permission (Contribute) |
| **Lenovo support API** | `POST /v2.5/product` (specs) and `/v2.5/warranty` (V: `graph.py:46-47, 1029-1079`) | `lenovo_client_id` in `config.json`, **shipped in the shared `dist\` folder** (§11) |
| **Dell** | Placeholder; `lookup_dell` returns None (V: `graph.py:1080-1084`) | TechDirect key still pending (H) |
| **On-prem AD** | Is a computer still in AD (Boneyard, stale drill-down) | The user's Kerberos session. Needs the corporate network (V: `adlookup.py`) |
| **SQL Server** | Timesheet Fix | Integrated Security (V: `sqltools.py:23`). Rights for anyone other than Blake are undocumented (?) |
| **OneDrive sync client** | Shares the exe and the JSON store across the team | The user's OneDrive / SharePoint library access |
| **Web portals** (NBT Sites, Project Hub) | Links only | The user's browser SSO |

The scope lists are in `graph.py:72-100` (V). Sign-in requests core + optional scopes and falls back to core scopes only. The scopes actually granted are read from the token's `scp` claim (V: `graph.py:226-264`).

---

## 10. Conventions

### Backend
- **Every `Api` method** wraps its work in try/except and returns `{"ok": True, …}` or `self._fail(e)` → `{"ok": False, "error": str}` (V: `app.py:99-101`). Never raise to JS.
- **Lazy imports** keep startup fast; for example `graph` is imported inside `_client()` so the window opens before sign-in (V: `app.py:82`). Add any new lazily-imported module to `build.ps1 --hidden-import`.
- **Graph access goes through `gc._req` / `gc._get_all`**, which handle retries and friendly errors. Advanced queries (`$search`, `endsWith`, `companyName`) need the header `ConsistencyLevel: eventual` plus `$count=true` **on every page** (see `_users_where`, `app.py:1030`).
- Escape OData string literals with `_odq` (`app.py`). Batch with `$batch` in groups of 20.
- **Shared-state writes go through `hub.py`** (atomic temp + replace), with **one audit entry per operation or run**, not one per item.
- **Destructive or bulk operations take a `commit` / `dry_run` flag.** Keep new ones that way.
- **Diagnostics are read-only unless Blake approves writes** (H: he rejected a test write on 07-24).
- **Scope people by `companyName`**; scope devices by the Intune category.

### Frontend
- One global object per feature (`App`, `Dashboard`, `BGTools`, `Depts`, …). The UI is rendered with template strings into `innerHTML`, and handlers are inline `onclick="Obj.method()"` strings.
- Always escape with `esc()` for text and `attr()` for attributes (V: `app.js:4-5`). Note that `attr()` does not escape `'`; see §11.
- **Every `Backend.call` method needs a `Mock` implementation** (Mock blocks at `app.js:20-279` and `4305-4564`). All 68 calls currently have both a Mock and a Python implementation (V).
- CSS: use the custom properties in `:root` (`styles.css:1-6`: `--dark`, `--darker`, `--med`, `--card`, `--border`, `--text`, `--muted`, `--red`, `--amber`, …) and a **per-feature class prefix** (`pb-` baselines, `miss-` Missing Groups, `bgt-` BG Tools, `hs-` hot spares, `up-` upgrades, `liv-` "living in" chips). Dark theme only.

### Process
- **Bump the version on every build**, in both files. The format is `YYYY.MM.DD`, then `.2`, `.3` for later builds the same day.
- Keep `web/`, `Mock` and the Python `Api` in sync.
- Verify UI changes in the Mock preview. Verify backend changes with dry runs.

### Patterns to avoid
- Running write scripts against live data without approval.
- Scoping people by department name or email domain.
- Printing `config.json` values.
- Using `verify=False` (use `truststore`).
- Adding scopes that aren't consented to the interactive request. That brings back the "Approval required" prompt for every user (H 07-29).
- Iframing any SSO or MSAL site.
- Writing single-file hub JSON on a timer.
- Relying on the Configuration PIN as security. It is a UI lock only.

---

## 11. Known issues, bugs, and technical debt (most important first)

| # | Issue | Evidence | Impact / suggested fix |
|---|---|---|---|
| 1 | **No version control, no tests, no CI** | (V) | Any bad edit is unrecoverable, and there is no regression safety. **Fix on day 1** (§14). |
| 2 | **Boneyard auto-retire can false-positive.** `intune_ok=True` is set whenever `intune_presence_map` returns, but that function swallows `GraphError` and skips failed batch sub-responses, returning *partial* results (V: `app.py:630-631`, `graph.py:514-518`). `entra_device_map` does the same while `entra_state` stays `"on"` (V: `graph.py:542-547`, `app.py:637`). An In Use row with a **blank hostname** is automatically "absent" from AD and Entra (V: `app.py:658-665`). The control-device guard only validates AD. The AD `cn=` filter is also unescaped (V: `adlookup.py:55`). | (V) | A transient Graph failure or throttle can move a **live** device to Boneyard. Self-heal and Restore mitigate this. **Fix:** make those map functions raise (or return an ok flag) on any failure, skip blank-hostname candidates, and consider requiring two consecutive sweeps before retiring. |
| 3 | **The shared checklist config can be overwritten with defaults.** `hub.get_config()` returns `None` on *any* read error, such as OneDrive holding the file or a half-synced file (V: `hub.py:204-209`). `Hub.boot` then saves `makeDefaults()` over it for the whole team (V: `app.js:3644-3649`). | (V) | Data loss of the customised checklists. Recovery is only from some machine's `%LOCALAPPDATA%\NBGW-Endpoint-Hub\config-history\`. **Fix:** tell "missing" apart from "unreadable" and never auto-seed when the file exists. |
| 4 | **External pages opened full-window can reach the entire Python API.** The injected Back button calls `window.pywebview.api.site_back()` from third-party pages, which relies on the bridge being present (V: `app.py:1539-1557`, `354-365`). Any user can add a **Custom** site in "In-app (full window)" mode **without the PIN**, and it is saved to the shared sites file for everyone (V: `app.js:1248-1271`). The API includes `ts_unlock` (a SQL write), `delete_machine`, and more. | (V design; exploitability **not tested**) | **Fix:** allow full-window only for an allow-list of Microsoft domains; open other sites in the browser or in a separate window without `js_api`; require the PIN for Custom sites. |
| 5 | **Boot race → permanent Mock mode.** If `pywebviewready` fires more than 300 ms after `load`, `_boot(false)` wins and the real boot is blocked by `_started` (V: `app.js:4608-4620`). | (V code; how often it happens is unknown) | The app would show demo data ("Demo User (mock data)"). **Fix:** in the exe, wait for `window.pywebview`, or re-boot as real when `pywebviewready` arrives. |
| 6 | **Silent Mock fallback in real mode** (V: `app.js:12-15`). | (V) | A missing or renamed Api method shows fake data instead of an error. **Fix:** in real mode, return `{ok:false, error}`. |
| 7 | **The shared JSON store has no locking.** OneDrive conflict copies exist in live data (V: §8.2). Every dashboard load auto-writes the upgrade list (V: `app.py:1489-1490`) and the dashboard refreshes every 45 s. | (V) | Lost updates and forked files. **Fix:** reconcile the conflict copies now; stop writing on a timer; move to per-item files or SharePoint lists/Dataverse. |
| 8 | **Sync runs on every client launch; there is no unattended job.** Concurrent clients created duplicate rows (fixed by the dedupe step, L 09-28), and moves are not atomic (add, then delete) (V: `app.py:233-234, 249-254, 679-684`). | (V/H) | Planned but never built: an Azure Function with managed identity (V: comment `sync.py:515-519`; H 07-02). |
| 9 | **Secrets handling.** The token cache is plaintext (V: `graph.py:182-196`). If `%LOCALAPPDATA%` fails, the cache falls back to the exe folder, which may be the shared folder (V: `graph.py:119-122`). The Lenovo key ships in the synced `dist\config.json` (V). | (V) | Use DPAPI via `msal-extensions`. Move the Lenovo key out of the shared folder. Review against the org secret rules (§15). |
| 10 | **The Configuration PIN is enforced only in the browser code** (V: `app.js:3150-3154`; stored in shared `nbgw-nbt-sites.json`). | (V) | A UI lock, not access control. Fine if understood that way. |
| 11 | **SQL connects with `TrustServerCertificate=True`** (V: `sqltools.py:23`), and PowerShell runs with `-ExecutionPolicy Bypass` from `%TEMP%` (V: `adlookup.py:94-99`, `sqltools.py:68-73`). | (V) | Low risk; a hardening item. |
| 12 | **Errors are invisible outside the Devices view.** `App.error` writes to the Devices banner, but Software, Upgrade, Config and Sites call it too (V: `app.js:814-817`). | (V) | Failures look like nothing happened. Show a toast or modal instead. |
| 13 | **Drill-down counts can differ from tile counts.** The server excludes reserved and hot-spare stock; the client drills don't (V: `app.js:1867, 1899` vs `app.py:1382-1410`). | (V) | Confusing numbers. |
| 14 | **`attr()` escapes `&` and `"` only**, yet it is used inside single-quoted inline JS about 26 times (V). `Sites._card` inserts `s.icon` raw (V: `app.js:1196, 1322`). | (V) | A name containing `'` breaks its button. There is some injection surface via shared sites data. |
| 15 | **Build fragility.** `build.ps1:30` hardcodes Blake's Python path; `build\` isn't cleared; `-Deploy` breaks shared data (§7). | (V) | Parameterize the Python path, add a `-Clean` switch, and fix or remove `-Deploy`. |
| 16 | **Stale code comments.** The `ts_unlock` docstring (`app.py:849-850`); the module docstring (`app.py:3-11`, still "NBGW Inventory" and Intune lookup); `hub.py:298` (`domain`); `graph.py:778-779` (claims streaming; the whole file is loaded at `:782`). `README.md` was rewritten on 2026-09-30. | (V) | Misleading. Fix them when you next touch those files. |
| 17 | **Dead code.** Python: `assign_machine`, `lookup_model_spec`, `add_model_spec`, `intune_lastsync_map`, `cpu.age_years`, `_PERM_KEYWORD_DEFAULT`, `Hub.HOT_SPARE_DEPTS`, the unused `domain` parameters on the `perm_*` methods, `site_tags`. JS: the old `hubview-feedback` sub-view plus `.fb-*` CSS, the `appview-projecthub` section with `ProjectHub.load/reload`, `drillNeedsUpgrade`, `bar()`, `drillSite`, `_stockCols`, `Sites.openBrowser`. Unused CSS: `header`, `.brand`, `.session`, `.scan-row`, `.warr-up*`, `var(--mono)`. | (V, per caller greps) | Remove once you are under git. |
| 18 | **Duplication.** LTR/BRI/Other bucketing appears 4 times; `SWLogic.deptKey` and `Software.deptKeyOf` are identical; `backgroundSync` and `runSync` repeat the same flow; there are two modal systems (`#modalRoot` and `#modalBg`). "BomsNet" naming remains in comments and CSS (V: `app.js:2344, 2479, 3176`). | (V) | Low. Clean up opportunistically. |
| 19 | **Feature gaps.** Dell lookup is a stub. MFA may be blocked by a missing directory role. Phones and tablets are excluded. The Intune read was never tested with a non-admin account. A real timesheet unlock was never exercised during development. | (H/V) | See §13 and §15. |
| 20 | **`input()` in `__main__`** runs in a windowless exe (V: `app.py:1600-1605`; spec `console=False`). | (V) | A startup crash probably exits silently. Log to a file instead. |

---

## 12. Gotchas and non-obvious behavior

**Network and platform**
- **Corporate TLS proxy.** Any Python making HTTPS calls must run `truststore.inject_into_ssl()`, which `graph.py:35-43` does. Never use `verify=False` (V/H).
- **AD lookups from a Claude or subprocess shell are unreliable.** Specific `cn=` lookups intermittently say "not found". Only the interactive exe is authoritative (H 09-23). Off the corporate network, AD reports devices as missing (the sentinel search guards against this; V `adlookup.py:46-49`).
- **Co-managed devices have no user in Intune.** The real owner is the Entra device's registered owner (`graph._device_owner`) (H 07-24).
- **External and guest users** (`nbsut.com`, `americanbuildings.com`, `cbcsteelbuildings.com`) have no Nucor city or MFA data (H).
- **Always call `gc._row(fields, "in_use", in_use=True)`** for In Use rows. Without `in_use=True`, the user field silently comes back empty; this once produced a bogus "0 of 466 have users" finding (H 07-24).

**Microsoft Graph**
- `_req` retries 401 (after dropping the token), and 429/503 (honouring `Retry-After`).
- One `GraphError` switches a capability flag off (`_has_dir_read` etc.) **for the rest of the session** (V: `graph.py:543, 626, 647, 685`). If a feature goes dormant mid-session, restart the app.
- MSAL's `result['scope']` can be stale for cached tokens, so granted scopes are read from the JWT `scp` claim (V: `graph.py:247-256`; H 08-12).
- MSAL and the token cache aren't thread-safe, and pywebview runs each JS call on its own thread. `_sign_lock` prevents a sign-in stampede that used to hang startup (V: `graph.py:163, 212-215`; H 08-27).

**Shared data and OneDrive**
- **Script mode and exe mode use different data folders** (§0 item 4).
- **The live folder moved on 2026-09-29** (§7). If a user says "it's empty", check which folder they are running from.
- The project's own `SystemsData\` and `dist\SystemsData\` hold **old test data**, including pre-2026-09-29 group baselines built across all divisions. Don't mistake them for live data.

**Build**
- A running exe is locked, so close the app before copying a new build.
- Keep helper PowerShell scripts **ASCII-only**; an em-dash broke PowerShell 5.1 parsing (H 09-25). Don't wrap PyInstaller output in `$ErrorActionPreference='Stop'` because it logs to stderr.
- **PyInstaller reuses `build\`**; delete it before release builds (H 07-29).

**Frontend and preview**
- The browser preview caches `index.html` and `app.js`, and the preview tool may strip query strings. Serve `web\` from a fresh port, or use `fetch('/app.js', {cache:'no-store'})` to confirm the new code is being served (H).
- pywebview's default `private_mode` makes localStorage per session, so treat `nbgw_inv` and `nbgw_hub_draft_v2` as caches only (H 08-04; V `app.js:323, 3634`).

**Don't touch these without reading why**

| Area | Why |
|---|---|
| `ts_unlock` SQL (`app.py:861-866`) | It must not change `ModifiedBy` / `ModifiedDate` (Blake). The `AND Locked = 1` guard makes it idempotent. |
| `dedupe_in_use` at the start of `run_sync` (`sync.py:49-54`) | This is the only protection against duplicate rows from concurrent clients. |
| `_PERM_COMPANY_DEFAULT` scoping (`app.py:1003-1009`, `_dept_users`) | Removing it reintroduces cross-division contamination. |
| `_sign_lock` and the token-expiry logic (`graph.py:198-264`) | Fixes for the idle sign-in popup and the startup hang (H 08-26/27). |
| The Boneyard AD "control device" guard (`app.py:778-783`) | Blake's PC is Entra-joined, not domain-joined, so the older "find my own PC in AD" guard failed. The control guard replaced it (H 09-23). |
| The interactive scope list (`graph.py:72-100, 226-238`) | Adding an unconsented scope makes every user see "Approval required". |

---

## 13. In-progress work

- **Branches and uncommitted changes:** not applicable, since there is no git (V). Treat the whole folder as uncommitted.
- **TODO/FIXME/HACK/XXX markers:** there are **none** in the source (V: grep). The implicit to-dos are the DPAPI note (`graph.py:183`), the `lookup_dell` placeholder (`graph.py:1081`), and the Azure Function/Task Scheduler note (`sync.py:515-519`).
- **Deployed:** v2026.09.29 is live (V). The 2026-09-29 NBGW-scoping fix and the 2026-09-28 dedupe fix are both shipped. The live group baselines were rebuilt on 2026-09-29 (L). A backup of the old file was kept only in a temporary session folder, which may be gone (?).
- **Half-finished or never finished (H unless noted):**
  - Dell TechDirect integration: `lookup_dell` stub; waiting on the key (V stub).
  - MFA column: code done; blocked on a directory role for the signing-in account (as of 08-12; current status unknown).
  - Unattended nightly sync (Azure Function + managed identity): designed, not built.
  - Deployment Guide Options A (auto-update) and C (Intune Win32): documented, not built (V: no code).
  - Warranty Expiration column: never confirmed.
  - Phones and tablets in the fleet: deferred ("later phase"); controlled by `intune_device_os`.
  - Site naming variants `NBTLTR`/`NBTBRI`, and whether WAT/CCPG/TH are real sites: undecided.
  - OneDrive conflict copies in live data: need reconciling (V).
- **Recently changed areas that deserve a second look:**
  - The Group baselines "⟳ Rebuild from NBGW directory" button: verified in the Mock preview; the live rebuild was done by script, **not** through the button.
  - The Permissions Finder Division dropdown.
  - The Missing Groups NBGW-only search.

---

## 14. Roadmap (priority order)

**First week**
1. **Put it under git** and push to a Nucor-approved remote (?). Commit as-is first, then remove the dead code in a separate commit.
2. **Fix §11 #3 (config reseed).** It's small and prevents team-wide data loss.
3. **Harden Boneyard (§11 #2).** Propagate partial Graph failures, skip blank hostnames, and consider a two-sweep confirmation.
4. **Close the full-window API exposure (§11 #4).** Domain allow-list, PIN for Custom sites.
5. **Fix the boot race and the silent Mock fallback (§11 #5, #6).**
6. **Reconcile the OneDrive conflict copies** and stop the upgrade-list write that runs on every dashboard load (§11 #7).

**Next**

7. **Minimal tests:** pytest for pure logic (reconcile with a fake GraphClient, dedupe, baseline tally, `cpu.py`, SWLogic ported or tested through the browser). Add a CI job that at least compiles the Python and syntax-checks `app.js`.
8. **Unattended sync** as an Azure Function with managed identity (the org rule prefers managed identity). Then make client-side sync opt-in so every launch stops writing to production.
9. **Secrets:** DPAPI token cache; move the Lenovo key out of the shared folder.
10. **Distribution:** code signing (fixes the Defender false positive), or an Intune Win32 package with `logs_folder` pointing at the shared location.
11. **Move shared state off single JSON files** (SharePoint lists, Dataverse, or per-item files).

**Backlog**

12. Dell API.
13. MFA (get the directory role).
14. Phones and tablets.
15. `NBTLTR` naming.
16. Show errors outside the Devices view.
17. Consolidate duplicated helpers.
18. Fix the stale docstrings and comments (§11 #16). The README itself was rewritten on 2026-09-30.
19. Pin dependency versions.

---

## 15. Open questions and pending decisions

1. **Where should the git remote live** (Azure DevOps or GitHub org), and who owns it?
2. **Is instant Boneyard retirement still the desired policy** once the false-positive paths are known, or should there be a grace period?
3. **Unattended sync:** approve building the Azure Function with managed identity? Is the legacy Power Automate flow (once owned by robert.nelson) still running, and are the Copilot "Chip" agent and the old flows fully retired (H 07-02)?
4. **Secrets policy:** the Lenovo ClientID is distributed through the shared folder. Is that acceptable under Nucor rules, or should it move to a service or Key Vault? (Org rule: never hardcode keys; managed identity is preferred for deployed apps.)
5. **Nucor architecture guidance is available** (org policy). Blake declined a formal pass earlier (H). Does the new owner want to apply it as the app heads toward managed deployment?
6. **The Configuration PIN:** hand it over out-of-band and consider rotating it. Who should hold it?
7. **Project Hub:** should it point at the DEV or the PROD URL? It is DEV today (V: `app.js:1114`).
8. **Scope expansion:** add other Intune categories (NIPG was declined 07-24) or device types?
9. **Timesheet Fix governance:** who may unlock weeks, and should unlocks also be logged in SQL?
10. **The group-baseline threshold:** 70% yields 55–113 "expected" groups per department. Should it be raised to 85–90% to cut noise?

---

## 16. Things I could not determine (Blake: please fill in)

- [ ] The full list of current users and machines, and who holds the Configuration PIN.
- [ ] How the new developer gets `config.json` (secure channel), and who owns and can rotate the **Lenovo key**.
- [ ] Who owns the **"Inventory Dashboard" app registration** and can grant consent.
- [ ] The new developer's own roles: Intune RBAC, SharePoint Contribute or Owner on `/sites/NBGW/systems`, SQL rights on `BGBRISQL07`.
- [ ] Whether **MFA** works today (was the directory role granted after 08-12?).
- [ ] Whether the **Warranty Expiration** SharePoint column exists.
- [ ] Current **Defender** status of the exe and any allow indicators in place.
- [ ] Whether the legacy **Power Automate flows / Copilot agent** are still running.
- [ ] Whether other users' open copies of the exe block the OneDrive update when you release.
- [ ] The **SharePoint site and library URL** behind the synced `Systems Home - Inventory Desktop App` folder, and who can grant the new developer edit access to it.
- [ ] Which copy is correct for `nbgw-app-clients-BGBRISKELLY01.json` and `nbgw-upgrade-list-BGPF5MDA4B.json` in the live hub.
- [ ] Whether `C:\Program Files\NBG\Inventory Desktop App\`, the project `SystemsData\` / `dist\SystemsData\` test data, and `NBGW Inventory.spec` can be deleted.
- [ ] The formal definition of "done" and the support expectations for the tool.
- [ ] Whether any real **timesheet unlock** has been run in production, and whether a non-admin account has tested Intune access.

---

## Appendix A: Context-transfer prompt (paste as the new developer's first message to Claude Code)

```text
You are taking over "NBGW Hub", a Python + pywebview (WebView2) Windows desktop app used by the
NBGW Systems/IT team at Nucor Buildings Group West. The previous developer (Blake Stevenson) built it
with Claude Code and left a handoff package in the project root.

Before changing ANY code:

1. Read HANDOFF.md end to end, then CLAUDE.md. Treat items tagged (V) as verified in code, (L) as
   verified live, (H) as historical and not re-verified, (?) as unknown.

2. Verify the local setup WITHOUT touching production data:
   - Report `python --version` (expect 3.12.x) and whether these import: msal, requests, webview,
     truststore, clr (pythonnet). Do not install anything without asking me first — the corporate proxy
     needs special handling (HANDOFF §5.3).
   - Confirm config.json EXISTS beside app.py, but NEVER open, print, or log its values or any token cache.
   - Syntax-check the Python: python -c "import ast; [ast.parse(open(f,encoding='utf-8').read()) for f in ('app.py','graph.py','hub.py','sync.py','adlookup.py','sqltools.py','cpu.py')]"
   - Serve the UI against the Mock backend only: python -m http.server 8810 --directory web
     and confirm it loads with no console errors.
   - Check whether the folder is a git repository yet.
   - Do NOT run `python app.py`, `python sync.py --commit`, the built exe, or any script that writes to
     SharePoint, the shared _EndpointHub folder, or SQL. Running the real app changes production data
     within seconds of launch (HANDOFF §0 item 2).

3. Summarize your understanding back to me:
   - what the app does and who uses it,
   - the architecture and where each kind of data lives (SharePoint lists, shared JSON hub, SQL, Graph),
   - how releases are built and deployed today,
   - the top 5 risks from HANDOFF §11 in your own words,
   - anything in the docs that contradicts what you see in the code,
   - what you would do first and why.

4. Then STOP and wait for my confirmation before making any change. Every change after that must follow
   the conventions in CLAUDE.md: keep a Mock twin for every backend method, bump version.py and version.txt
   on every build, keep destructive operations behind commit/dry-run flags, and never print secrets.
```

---

## Appendix B: Backend method index (`class Api`, `app.py`)

The UI calls 68 distinct methods, and every one exists in both the Mock and `Api` (V). The table also lists three methods the UI never calls: `app_version`, `assign_machine` and `site_back` (the last is called only by the injected Back button). Line numbers are approximate as of v2026.09.29.

| Area | Methods (line) |
|---|---|
| Session and version | `get_status` 104, `app_version` 113 (unused by the UI), `register_client` 120, `get_clients` 132, `sign_in` 138, `sign_out` 146 |
| Devices | `get_inventory` 154, `lookup` 180, `add_machine` 211, `assign_machine` 222 (dead), `return_to_stock` 241, `delete_machine` 261, `set_site` 276, `my_site` 290, `update_stock` 301, `get_log` 378, `locate_devices` 614 |
| Sync | `run_sync` 385, `enrich_inventory` 392, `master_sync` 400, `populate_mfa` 410 |
| Windows and sites | `open_url_window` 331, `open_external` 343, `site_navigate` 354, `site_back` 367 |
| Software | `software_refresh` 420, `software_get` 433, `software_save_rules` 441 |
| Hub and setups | `hub_whoami` 450, `hub_get_config` 456, `hub_save_config` 462, `hub_get_setups` 469, `hub_save_setup` 475, `reservation_options` 481, `hub_cancel_setup` 1241, `hub_get_changes` 1247, `hub_get_feedback` 1253, `hub_add_feedback` 1259, `hub_open_folder` 1265, `hub_storage_info` 1272, `hub_get_departments` 1279, `hub_save_departments` 1285, `hub_get_sites` 1292, `hub_save_sites` 1298 |
| Hot spares | `get_hot_spares` 579, `add_hot_spare` 596, `update_hot_spare` 602, `remove_hot_spare` 608 |
| Boneyard | `restore_boneyard` 693, `boneyard_sweep` 709 (defaults to `dry_run=False`) |
| Timesheet | `ts_search` 808, `ts_weeks` 828, `ts_unlock` 848 |
| Permissions | `bg_locations` 909, `bg_user_search` 927, `bg_user_groups` 965 |
| Group baselines | `perm_get_baselines` 1043, `perm_save_baselines` 1049, `perm_dept_suggest` 1079, `perm_discover_departments` 1102, `perm_analyze_dept` 1125, `perm_missing_for_user` 1168, `perm_missing_in_dept` 1204 |
| Upgrades | `hub_get_upgrades` 1317, `hub_add_upgrade` 1324, `hub_save_upgrades` 1330, `hub_update_upgrade` 1336, `hub_begin_upgrade` 1342, `hub_remove_upgrade` 1348, `hub_complete_upgrade` 1354 |
| Dashboard | `get_dashboard` 1363 |

---

## Appendix C: How this document was verified

- **Direct inspection (2026-09-30):**
  - Directory listing.
  - `.gitignore`, `requirements.txt`, `build.ps1`, `NBGW Hub.spec`, `version.*`.
  - Config **key names only**. The live and project config values were compared by hash, never printed.
  - `pip list` versions.
  - The live deployment folder: exe version and hub file list.
  - `git` status.
  - Greps for hardcoded credentials (none found) and TODO markers (none found).
  - Targeted reads of `app.py` (Boneyard guards, `_BACK_JS`, `site_navigate`, `ts_unlock`, `__main__`), `graph.py` (log-list creation), `hub.py` (`get_config`), and `app.js` (boot, `Hub.boot`, Custom site quick-add).
- **Parallel read-only code surveys** of the backend and the frontend, cross-checking all 68 `Backend.call` names against the Mock and `Api`. Their key claims were spot-checked by hand.
- **Project history:** Claude memory notes (a dated log from 2026-07-02 to 2026-09-29), the pre-2026-09-30 `README.md`, and the Deployment Guide docx. Items from these are tagged **(H)**. The log is not strictly chronological, and some July "round" labels appear misdated.
- **Live verification (L):** read-only probe scripts and fixes during 2026-09-25 → 09-29 (dedupe, NBGW scoping, baseline rebuild).
