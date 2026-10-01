# CLAUDE.md — NBG Hub

Windows desktop app for NBGW Systems/IT (Nucor Buildings Group West; sites LTR = Lathrop CA, BRI = Brigham City UT). Full context: **HANDOFF.md** (read §0, §11 before non-trivial change). Open risks and stale docs: **ROADMAP.md**.

- **Stack:** Python 3.12 + pywebview 6 (WebView2), one exe via PyInstaller. Vanilla JS, no framework.
- **Status:** production (v2026.09.29). No git, no tests, no CI.

Be concise in all responses.

**Git:** after every change set, commit and push to `origin main` (repo `NBGTX/inventoryapp`). Never commit `config.json`, token cache, or `SystemsData/`.

## Architecture

```
web/index.html + app.js + styles.css   Backend.call("m", …) → window.pywebview.api.m(…) | no pywebview → Mock.m(…)
app.py   class Api  → every method returns {"ok": True, …} or self._fail(e)
   graph.py  GraphClient: MSAL delegated → Graph (Intune/Entra), SharePoint lists, Lenovo API
   sync.py   run_sync, enrich, master_sync, populate_mfa
   hub.py    shared JSON: <exe dir>\SystemsData\_EndpointHub\ (OneDrive-synced, NO locking)
   adlookup.py / sqltools.py   PowerShell+.NET → AD (bg.nucorsteel.local) / SQL BGBRISQL07
```

| Data | Store |
|---|---|
| Devices, audit log | SharePoint `nucor.sharepoint.com/sites/NBGW/systems` |
| Setups, upgrades, hot spares, baselines, sites + PIN, software cache | Hub JSON |
| Timesheet week locks | SQL `NBSTimesheet.dbo.WeekLocked` |

## Commands (PowerShell)

```powershell
python -m http.server 8810 --directory web   # SAFE: Mock backend, no network writes
python app.py                                # REAL: writes production within seconds (Rule 2)
python sync.py                               # dry-run Intune→In Use reconcile
python poc\inspect_lists.py                  # SharePoint column names (read-only)
Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue; powershell -ExecutionPolicy Bypass -File build.ps1   # → dist\NBG Hub.exe
```

Build: `build.ps1:30` hardcodes python path; needs `config.json`; close app first; PyInstaller logs to stderr (no `$ErrorActionPreference='Stop'`); delete `build\` first. Release steps: HANDOFF.

## Rules (must follow)

1. **Never open, print, log or commit secrets.** `config.json` has `lenovo_client_id` (real secret): read key names only. Token cache: `%LOCALAPPDATA%\NBG Hub\.token_cache.bin`. Never hardcode keys.
2. **No production writes without explicit approval:** running `python app.py` or the exe (launch runs `run_sync` → `enrich_inventory` → `boneyard_sweep` with commit on), `sync.py --commit`, any call to `Api` write methods, `hub.save_*`, `gc.add_*`/`update_item`/`delete_item`, `ts_unlock`. Prefer Mock, dry-run flags (`commit=False`, `dry_run=True`), read-only probes.
3. **Bump version every build:** `version.py` `APP_VERSION`, `version.txt` (`filevers`/`prodvers` + `FileVersion`/`ProductVersion`), Mock strings (`web/app.js` ~line 41). Format `YYYY.MM.DD`, then `.2`, `.3`.
4. **Every new `Api` method needs a Mock twin** in `web/app.js` (`const Mock` ~20-279, or `Object.assign(Mock, …)` ~4305-4564). Missing Python method silently falls back to Mock.
5. **Timesheet unlock must not change `ModifiedBy`/`ModifiedDate`.** Only `Locked = 0 … AND Locked = 1` (`app.py:861-866`). Blake's requirement.
6. **Scope people by Entra `companyName eq 'Nucor Buildings Group West'`**, never department or email domain. Scope devices by Intune category `NBGW`.
7. **Destructive/bulk ops behind `commit`/`dry_run`; one audit entry per run** (`gc.add_log` or `hub._change`).

## Conventions

- **Api methods:** try/except → `{"ok": …}`, never raise to JS. Lazy-import local modules; add to `build.ps1 --hidden-import`. Graph via `gc._req`/`gc._get_all`. Advanced queries need `ConsistencyLevel: eventual` + `$count=true` on every page (`Api._users_where`). Escape OData with `Api._odq`. Batch lookups 20 at a time via `$batch`. HTTPS needs `truststore.inject_into_ssl()`; never `verify=False`.
- **Shared JSON:** only via `hub.py` (atomic writes). Last-writer-wins: one file per item for concurrent edits. No timer writes.
- **Frontend:** one global object per feature (`App`, `Dashboard`, `BGTools`, `Depts`, `Hub`, `Upgrade`, `Software`, `Sites`, `HotSpares`, `Drill`). Template strings into `innerHTML`, inline `onclick="Obj.method()"`. `esc()` text, `attr()` attributes; `attr()` does not escape `'`.
- **CSS:** `:root` vars `styles.css:1-6`, dark only, feature prefix (`pb-`, `miss-`, `bgt-`, `hs-`, `up-`, `liv-`, `cfg-`).
- **SharePoint:** columns by display name via `FIELD_ALIASES` (`graph.py:52-71`); serial = `Title`. In Use rows: `gc._row(fields, "in_use", in_use=True)` or user is blank.

## Gotchas

- **Data path depends on run mode** (`hub._app_dir`): exe → `<exe dir>\SystemsData` (live); python/scripts → `<project>\SystemsData` (**not live**, stale). Live from script: `api._hub = Hub(logs_folder=r"…\Systems Home - Inventory Desktop App\dist\SystemsData")`.
- Mock preview caches hard: fresh port, or `fetch('/app.js',{cache:'no-store'})`.
- One Graph failure disables a capability flag (`_has_dir_read` etc.) until restart.
- New unconsented sign-in scope (`graph.py:72-100`) gives every user "Approval required".
- Don't iframe SSO/MSAL sites (redirect loop). Use browser or "fullview".
- AD `cn=` lookups from agent shell are flaky; only the interactive exe is authoritative.
- Co-managed devices have no Intune user; owner = Entra registeredOwners.
- PowerShell helper scripts: ASCII only (em-dash broke 5.1).
