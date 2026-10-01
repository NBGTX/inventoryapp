# CLAUDE.md — NBG Hub

Windows desktop app for Nucor Buildings Group Systems/IT, **multi-division** (NBGW = first division; sites LTR = Lathrop CA, BRI = Brigham City UT). Moving from per-division SharePoint + OneDrive JSON to one **central store** with division switching. Plan, decisions, cutover: **docs/MIGRATION.md**. Old single-division context: **HANDOFF.md** (read §0, §11 before non-trivial change; names/paths there predate the rename and central store). Open risks: **ROADMAP.md**.

- **Stack:** Python 3.12 + pywebview 6 (WebView2), one exe via PyInstaller. Vanilla JS, no framework.
- **Status:** v2026.10.01 in development (multi-division). Production exe in the field is still v2026.09.29. Git in use. Offline tests in `tests/`. No CI.
- **Parked:** `webapp/` (ASP.NET Core 8 port, Windows auth, SQLite) + `web/web-shim.js`. Do not extend unless asked.

Be concise in all responses.

**Git:** after every change set, commit and push to `origin main` (repo `NBGTX/inventoryapp`). Never commit `config.json`, token cache, `SystemsData/`, or local snapshots.

## Architecture

```
web/index.html + app.js + styles.css   Backend.call("m", …) → window.pywebview.api.m(…) | no pywebview → Mock.m(…)
app.py   class Api  → every method returns {"ok": True, …} or self._fail(e)
   graph.py     GraphClient: MSAL delegated → Graph (Intune/Entra), SharePoint lists, Lenovo API.
                Division overlay (_apply_division), central filter/stamp, master settings, registry, local mode
   divisions.py division registry (config.json fallback), site/city/device mapping helpers
   hub.py       hub documents (JSON API). I/O layer: files OR hubstore rows
   hubstore.py  SharePointHubStore: hub docs as rows in Hub Items (chunked, Rev conflict check); setup HTML → Hub Files library
   localstore.py/paths.py   local snapshot sandbox (SQLite) under %LOCALAPPDATA%\NBG Hub
   sync.py      run_sync, enrich, master_sync, populate_mfa
   adlookup.py / sqltools.py   PowerShell+.NET → AD / SQL (per-division server from registry)
tools/   Setup-CentralLists.ps1, pull_snapshot.py, load_central.py, bump_version.py
tests/   offline unittest suite (python -m unittest discover -s tests)
```

| Data | Store |
|---|---|
| Devices, audit log, model specs | Central site lists `Inventory - New Stock/In Use/Model Specs/Activity Log` (rows carry `Division`) — when `config.json` has `central`. Else the legacy per-division site |
| Hub docs (setups, upgrades, hot spares, baselines, sites + PIN, software cache, changes, feedback) | `Inventory - Hub Items` rows (central) — else JSON under `SystemsData\_EndpointHub[_<id>]\` |
| Division registry | `Inventory - Divisions` list (central wins) + `config.json divisions` fallback |
| Master settings (secrets, `super_admins`) | `Inventory - Master Settings` (Owners edit; readable by app users). `config.json` is the fallback |
| Timesheet week locks | SQL `NBSTimesheet.dbo.WeekLocked` (server from the division) |
| Local sandbox | `%LOCALAPPDATA%\NBG Hub\local\<division>\` (`local.db` + hub copy). Mode in `data_mode.txt` |

Central site: `https://nucor.sharepoint.com/sites/NBGTX.nbghubdata` (NBG Hub Data).

## Commands (PowerShell, from the project root)

```powershell
python -m unittest discover -s tests                 # offline tests (no network, no real config)
python -m http.server 8810 --directory web           # SAFE: Mock backend, no network writes
python tools\pull_snapshot.py --hub-only             # copy hub folder to the local sandbox (no sign-in)
python tools\pull_snapshot.py --switch-local         # read-only prod snapshot, then start the app in Local mode
python tools\load_central.py                         # DRY RUN: snapshot → central lists (add --hub / --hub-only)
python tools\load_central.py --commit                # writes central lists (approval needed)
python tools\bump_version.py                         # next version everywhere; --check to verify
python app.py                                        # REAL: writes within seconds (Rule 2)
powershell -ExecutionPolicy Bypass -File build.ps1   # tests + version check, then PyInstaller → dist\NBG Hub.exe
```

Build: needs Python 3.12 (`py -3.12`, `-Python <exe>` or `NBG_PYTHON`), `config.json`, app closed, `build\` deleted first. Release steps: HANDOFF (paths there are the old owner's).

## Rules (must follow)

1. **Never open, print, log or commit secrets.** `config.json` may hold `lenovo_client_id` (real secret): read key names only. Token cache: `%LOCALAPPDATA%\NBG Hub\.token_cache.bin`. Never hardcode keys. Master-setting values are never logged.
2. **No production writes without explicit approval:** running `python app.py` or the exe in **Live** mode (launch runs `run_sync` → `enrich_inventory` → `boneyard_sweep` with commit on), `sync.py --commit`, `tools\load_central.py --commit`, any call to `Api` write methods, `hub.save_*`, `gc.add_*`/`update_item`/`delete_item`, `set_master_setting`, `save_division`, `ts_unlock`. Prefer Mock, **Local data mode** (writes stay on the PC; ts_unlock blocked), dry-run flags, read-only probes. Default mode is Live: run `pull_snapshot.py --switch-local` before launching the app.
3. **Bump version every build:** `python tools\bump_version.py` (updates `version.py`, `version.txt`, Mock strings); `build.ps1` fails if they disagree.
4. **Every new `Api` method needs a Mock twin** in `web/app.js` (`const Mock`, or an `Object.assign(Mock, …)` block). Missing Python method silently falls back to Mock.
5. **Timesheet unlock must not change `ModifiedBy`/`ModifiedDate`.** Only `Locked = 0 … AND Locked = 1`. Blake's requirement.
6. **Scope people/devices by the active division**, never hardcode: Entra `companyName` = `division.company_name`; Intune category = `division.intune_category`; sites/prefixes from `division.sites`. Never scope by department or email domain.
7. **Destructive/bulk ops behind `commit`/`dry_run`; one audit entry per run** (`gc.add_log` or `hub._change`).
8. **New code needs offline tests** in `tests/` (fakes via `tests/_env.py`); run them before commit.

## Conventions

- **Api methods:** try/except → `{"ok": …}`, never raise to JS. Lazy-import local modules; add to `build.ps1 --hidden-import`. Graph via `gc._req`/`gc._get_all`. Advanced queries need `ConsistencyLevel: eventual` + `$count=true` on every page (`Api._users_where`). Escape OData with `Api._odq`. Batch lookups 20 at a time via `$batch`. HTTPS needs `truststore.inject_into_ssl()`; never `verify=False`.
- **Divisions:** use `Divisions.codes()/bucket()/cls()/label()` in JS and `divisions.*` helpers in Python; no literal `LTR`/`BRI` in logic (Mock data aside). Division-scoped lists are `new_stock`, `in_use`, `log` (`graph._DIVISION_SCOPED`); `model_specs` is shared.
- **Hub data:** only through `Hub` methods (JSON API unchanged). Central: `HubConflict` means someone else saved first — reload and retry. Docs over ~50k chars are chunked automatically.
- **Frontend:** one global object per feature (`App`, `Dashboard`, `Divisions`, `DataMode`, `MasterSettings`, `DivisionAdmin`, `BGTools`, `Depts`, `Hub`, `Upgrade`, `Software`, `Sites`, `HotSpares`, `Drill`). Template strings into `innerHTML`, inline `onclick="Obj.method()"`. `esc()` text, `attr()` attributes; `attr()` does not escape `'`.
- **CSS:** `:root` vars `styles.css:1-6`, dark only, feature prefix (`pb-`, `miss-`, `bgt-`, `hs-`, `up-`, `liv-`, `cfg-`, `dm-`, `ms-`).
- **SharePoint:** columns by display name via `FIELD_ALIASES` (`graph.py`); serial = `Title`. In Use rows: `gc._row(fields, "in_use", in_use=True)` or user is blank.
- **Settings page** (`web/settings.js`, sidebar Settings; replaces the old Configuration PIN modal + Master settings/Divisions modals). Rail: tenant sections (General+time zone, Sites, Directory & SQL, Model departments, NBT Sites, Group baselines, Storage; the last four are `Depts` rendered in page mode) and super-admin Platform sections (Divisions editor, Super admins, Integrations). No PIN: gate by role later. Tenant edits go through `Api.save_own_division` (only sites/AD/SQL names of the ACTIVE division); identity/access/visibility stay `save_division` (super admin). Master settings are a catalog (`settings_catalog.py`: label/help/kind/validation); add new settings THERE and they get a form automatically. Time zone = hub doc `division-prefs` (+ master `default_timezone`); JS formats times via `Tz`.
- **Managing admins/access (in-app, super admin):** Master settings > Super admins (type-ahead over Entra; stored in the `super_admins` Master Settings row; `config.json super_admins` is the un-removable bootstrap; you cannot remove yourself). Division visibility: Settings > Who has access (tenant: people+groups, cannot grant "everyone" or lock itself out) or Platform > Divisions > Access (super admin) = people (emails) and/or Entra groups (`group:<id>|<name>` in Access JSON; membership read via `/me/transitiveMemberOf`, fails closed). Type-ahead = `Api.user_lookup` -> `GraphClient.directory_lookup`.
- **Roles** (per division, in Access JSON): `a@x.com` / `group:<id>|<name>` = user; `admin:` prefix = division admin; `*` = everyone (user only). `GraphClient.division_role()` -> super/admin/user/''. Plain users see Settings > General (read-only), Model departments, NBT Sites; admins also Who has access, Sites, Directory & SQL, Group baselines, Storage, time zone. Audience per section = `Settings.SECTIONS` (settings.js); server side: `require_division_admin()` guards save_own_division, save_division_prefs, perm_save_baselines. Admins cannot demote themselves or grant/undo `*`. Super admins promote the first admin (Platform > Divisions > Access).
- **Authority:** super admins = `super_admins` master row or `config.json super_admins`; division visibility = Divisions `Access JSON` (emails, `group:` entries, `*` = everyone; EMPTY = super admins only). Both are app-side checks; SharePoint site access still exposes all rows.

## Gotchas

- **Local hub data path**: python/scripts read `<project>\SystemsData` (**snapshot of the old owner's data, not live**). Exe reads `<exe dir>\SystemsData`. Central mode ignores both.
- A `config.json` JSON syntax error (missing comma) stops the app at load: check with `python -c "import json;json.load(open('config.json'))"`.
- Mock preview caches hard: fresh port, or `fetch('/app.js',{cache:'no-store'})`. The 404 for `/api/ping` in the preview is the parked web shim.
- One Graph failure disables a capability flag (`_has_dir_read` etc.) until restart.
- New unconsented sign-in scope (`graph.py` SCOPES) gives every user "Approval required".
- Don't iframe SSO/MSAL sites (redirect loop). Use browser or "fullview".
- AD `cn=` lookups from agent shell are flaky; only the interactive exe is authoritative.
- Co-managed devices have no Intune user; owner = Entra registeredOwners.
- PowerShell helper scripts: ASCII only (em-dash broke 5.1).
- Agent shell: bash heredocs with backslashes/quotes get mangled. Write scripts with the Write tool, then run them. Edit CRLF files with the Edit tool or CRLF-aware scripts.
- **SharePoint list-from-Excel guesses column types** (made OS Install Date / Last Sign In / LoggedAt Number -> every write 400s, audit entries silently lost). After creating or editing central lists run `python tools\check_central.py`.
- **Which account?** Techs sign in with an admin account (`adm.<name>.azure@nucor.onmicrosoft.com`) that holds the Intune role and NBGW site access; the normal account usually does not. Interactive sign-in always shows the account picker. `python tools\signin.py [--switch]` shows who is cached and what it can reach. `super_admins` and Divisions `Access JSON` must list the UPN actually used (the adm one), and that account needs Contribute on the central site.
- Python 3.14 (this dev box) has no `pywebview`; tools and tests work, the app window does not. Use 3.12.
