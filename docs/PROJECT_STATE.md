# NBG Hub: project state and handoff

Read this first when starting a new chat. `CLAUDE.md` has the rules; this file has the picture. Written 2026-10-02 at v2026.10.02.

## Where things stand
- **v2026.10.02** is built: `release\NBG-Hub-Setup-2026.10.02.exe` (SHA256 `313f08e0...0c2b` is in the `.sha256` beside it). Unsigned. **Not yet smoke-tested on a clean PC, not handed out, not tagged** (`git tag v2026.10.02` is still to do).
- All work is committed and pushed to `origin main` (repo `NBGTX/inventoryapp`). 320 offline tests pass.
- Divisions: NBGW (first division, old per-division SharePoint), NBG - Terrell (`nbgtx`). Everything runs from the **central store** (`https://nucor.sharepoint.com/sites/NBGTX.nbghubdata`). NBGW's data was test-loaded into central on 2026-10-01.

## What exists, where it lives
| Feature | Code | Stored in |
|---|---|---|
| Devices (tabs, filters, bulk select, remembered view, deploy / manufacture dates) | `App`, `Bulk`, `DeviceDates`, `Filt` in `web/app.js` | central lists; dates in hub doc `device-dates` ({serial: {deploy, mfg}}); view memory in browser `nbg_dev_view_<division>` |
| Deploy date stamped by sync | `sync.record_deploy_dates` (stock or boneyard -> In use; never overwrites a manual date) | `device-dates` |
| Teammates (people + MFA, person window, multi-select, e-mail drafts) | `People` in `web/app.js`, `sync.build_people`, `Api.mfa_people_*`, `Api.open_mailto` | hub doc `mfa-people` (per division) |
| Software (one row per app, versions underneath, who-has-it with version filter, Mandatory apps window) | `Software`, `SWLogic`, `Drill` | software cache + rules doc (`rules` + `auto`) in the division hub |
| Upgrades (stat cards, filters, by-model view, bulk actions) | `Upgrade`, `hub.bulk_upgrades`, `upgrade_rules.py` | division hub docs |
| Activity page (admins; Platform rows super admins only) | `activity.py`, `Api.activity_get`, `Api._audit`, `_AUDIT` wrappers at the bottom of `app.py` | the three change feeds: Activity Log list + division hub `changes` + platform hub `changes` |
| BG Tools (Timesheet Fix, Coil Cards, Permissions Finder, Missing Groups, Copy Permissions) | `BGTools`, `CopyPerms`, `AdKey`, `adperms.py`, `adlookup.py`, `sqltools.py` | AD (on-prem), SQL |
| NBT Sites (platform-wide, icon picker) | `Sites`, `IconPicker`, `Api.hub_get_sites/hub_save_sites` | platform doc `nbt-sites` |
| Issues board + sidebar count badges | `web/issues.js`, `issues.py`, `notify.py`, `Badges` | platform pseudo-hub (`issues/` docs) |
| Settings (General, Sites, SQL, Access, Platform sections), roles, role access | `web/settings.js`, `settings_catalog.py` | master settings list, division registry |
| My default division | `Api.get_my_prefs/save_my_prefs` | platform doc `user-prefs` ({upn: {default_division}}) |
| Data Live / Local button (super admins only; going back to Live is open to all) | `DataMode`, `Api.set_data_mode` | `%LOCALAPPDATA%\NBG Hub\data_mode.txt` |
| Installer | `build.ps1`, `installer/NBG-Hub.iss`, `selftest.py`, `docs/BUILD_AND_DEPLOY.md` | `release\` (git-ignored) |

Hub documents (named docs, via `Hub.get_named/put_named`): division hub = `device-dates`, `mfa-people`, `upgrade-ignore`, `division-prefs`, software cache and rules; platform hub (`platform_hub_for(gc)`) = `nbt-sites`, `user-prefs`, `search-scopes`, `issue-subscribers`, `issues/*`.

## Decisions worth remembering (and why)
- **Mail.Send is never requested** (would trigger admin consent for everyone). Notifications go through the Power Automate webhook `notify_webhook_url`.
- **AD writes use the person's own YubiKey account.** The machine is not domain joined, so `runas /smartcard` does not work (it can only offer one certificate). Instead the write script binds with the chosen certificate (`CredMarshalCredential`, thumbprint from `certutil -silent -scinfo`) and the PIN is typed in a separate console window; the app never sees it. A wrong PIN stops the run (no retries). Master setting `ad_domain_controller` pins one domain controller (`BGDALDCRW02.bg.nucorsteel.local`) so a write is visible at once.
- **Deploy / manufacture dates and MFA are NOT list columns.** They are small hub documents keyed by serial / person. No SharePoint schema change; the dates follow a machine between lists. Real columns are a possible later step.
- **MFA is a person's attribute**, so it has its own page (Teammates); the Devices MFA column reads from that list.
- **Activity**: Platform rows (roles, super admins, master setting names, sign-ins, NBT Sites, issues) are sent only to super admins by the server. Master setting values are never recorded.
- **Tests switch the audit write off** (`tests/_env.py`); `tests/test_activity.py` turns it back on.
- **Searchable filters** (`Filt`) keep the real `<select class="filt">` hidden as the source of truth.
- **Coil Cards (BG Tools; `coilcards.py`, `Api.coil_card_*`)** deletes a coil card and restores it from a backup, in the plant `CoilCard` SQL database. Facts found by inspecting the schema (the app's own `Card_Delete_*` / `CardTracking_Delete_*` procs are encrypted and are not used):
  - The only foreign key to `dbo.Card` is `dbo.CoilTracking.CoilID` -> `Card.NBSNumber` (NO ACTION), so delete order is `CoilTracking` rows, then the `Card` row, in ONE transaction that rolls back unless exactly one card goes. `RejectCoil`, `TransferLog`, `CoilExceptions`, `CoilFinder`, `OrphanedCoilTrackingData`, `Card_Tombstone` were empty and have no FK, so they are ignored. `cdc.*` tables are SQL Server Change Data Capture: never touch. No app triggers on `Card`/`CoilTracking`; no soft-delete rows exist (`IsDeleted` is unused), so the tool hard-deletes. `Card_Tombstone` (NBSNumber, DeletionDate) is deliberately NOT written (unknown downstream effect); it is a one-line add in `coilcards.delete` if wanted.
  - **Backup before delete**: both row sets go to the Hub Files library (`Hub.put_attachment`, file `coilcard-backup-<card>-<yyyymmdd-hhmmss>.json`, `format: 2`) and are read back; a failed upload or verify aborts the delete. Backups use `sqltools.run(..., exact=True)` (NULLs kept, ISO dates, `0x` hex bytes, untrimmed) so **Restore** re-inserts the rows unchanged: it reads `sys.columns`, skips computed/timestamp columns, handles identity columns, refuses if the card or any tracking row exists, and rolls back unless every row goes in. Dates restore to the millisecond (fine for `smalldatetime`/`datetime`).
  - **SQL identity**: SQL runs as the **Windows account that started the app** (`Integrated Security`), NOT the Entra `adm.*` account used for Graph. The server is the ACTIVE division's `sql_server` (Settings > Directory & SQL). Being on the wrong division gives "Cannot open database CoilCard ... login failed" (it happened once). Access to `CoilCard` comes from a Windows group (e.g. `BG\bg.ter.sd.it`) with DELETE/INSERT on the tables.
  - Master settings (catalog, group Directory/Tools): `coilcard_db` (default `CoilCard`), `coilcard_card_table` (`dbo.Card`), `coilcard_tracking_table` (`dbo.CoilTracking`), `coilcard_untested_label` (heading shows "(Untested)" until set to `off`). One tool tile "Coil Cards" with Delete / Restore tabs, one help box (`bgt-coilcard`). Disabled in Local data mode. One audit entry per delete / restore (`hub._change`). Tests: `tests/test_coilcards.py`.
- Org instructions: Entra ID for auth; LLM endpoints from Azure AI Foundry with managed identity (none used yet); Nucor Brand Kit for public/branded artifacts. The user declined the Nucor architecture-guidance offer: do not raise it again.

## Open items (nothing here is done)
1. **Release 2026.10.02**: smoke test on a clean PC (checklist in `docs/BUILD_AND_DEPLOY.md`), hand out the `.exe` + `.sha256`, set Settings > Platform > Integrations > Releases > *Latest released version*, then `git tag v2026.10.02` and push the tag.
2. **NBGW go-live**: tell NBGW to stop using their old site/exe, take a fresh snapshot, `load_central.py --hub` dry run, then `--commit` (needs approval), spot-check counts. See `docs/MIGRATION.md`.
3. **Unattended nightly sync**: decisions pending (Entra consent, which server/owner runs it, Teams or webhook for failures). See `docs/UNATTENDED_SYNC.md`.
4. **Notification webhook** (Power Automate flow) not created yet.
5. **Dell and HP keys** not entered; the HP response parser is unverified (use `tools/vendor_probe.py`).
6. **Terrell upgrade list is empty** until CPU data is filled (Dashboard > Missing specs) or a warranty rule is set (Settings > Platform > Integrations > Upgrades).
7. **AD tools**: set `ad_domain_controller` in master settings; "Add to AD" from Missing Groups has not been run against live AD (Copy Permissions was, once). Teammates > Refresh from Entra falls back to one Entra call per person when the bulk report is unavailable (slow).
8. **NBT Sites**: a super admin should open Settings > Platform > NBT Sites once and save, so the platform-wide list exists on purpose (until then each division shows its own old list).
9. **Code-signing certificate**: none yet; installs show the SmartScreen warning.
10. Ideas not done: Devices "Log" button -> Activity page; remember the last mail button; more badge sources (upgrades queued, missing specs); real SharePoint columns for deploy/manufacture dates; bundle SVG colour icons for NBT Sites.
11. **Coil Cards never run against real data**: do a delete + restore of a throwaway card, compare the `Card` / `CoilTracking` rows before and after, then set master setting "Mark Coil Cards as (Untested)" to Off. To find a test card: `SELECT TOP 20 CoilID, COUNT(*) FROM dbo.CoilTracking GROUP BY CoilID ORDER BY COUNT(*)`.

## How to work in this repo
- Commands, rules and conventions: `CLAUDE.md`. Build and deploy: `docs/BUILD_AND_DEPLOY.md`.
- The user wants short answers, a commit and push after every change set (trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), and the app **restarted** after each change so they can see it. Restart: stop `python ... app.py`, then in PowerShell `$env:NBG_NO_AUTOSYNC='1'; Start-Process py -ArgumentList '-3.12','app.py' -WorkingDirectory <project> -WindowStyle Hidden`.
- Never launch the app in Live mode without the user's say-so for anything that writes (Rule 2); `NBG_NO_AUTOSYNC=1` stops the launch sync.
- Check UI changes in the Mock preview: `python -m http.server <fresh port> --directory web`, then drive it with the browser tool's JavaScript (screenshots time out in that pane). Stop the server afterwards.
- Why restart: pywebview loads `app.py` once, web files reload from disk. A new `Api` method used before a restart silently falls back to the Mock (symptom: a real card "not found", Mock-only data).
- Write edit scripts with the Write tool; bash heredocs turn `\n` and backslashes into real characters.
- Do not mention the old NBGW site access problem (resolved).

## Moving the project folder
**Not in git, so copy or recreate by hand:**
- `config.json` (tenant, client id, central site; may hold secrets: copy the file, never paste it anywhere).
- `SystemsData\` (local snapshot of the old owner's hub data).
- `installer\assets\` (cached WebView2 installer, 203 MB; the build re-downloads it if missing).
- `release\` (built installers), `dist\`, `build\` (regenerated by the build).
- `.venv-build\` holds absolute paths: **delete it** after the move; the next build recreates it.

**Lives outside the folder and stays put:** `%LOCALAPPDATA%\NBG Hub\` (token cache, chosen division, data mode, local snapshots, `boot.log`), `%LOCALAPPDATA%\Programs\NBG Hub\` (installed app).

**Claude's side:** project memory is keyed by the folder path. Copy `C:\Users\<you>\.claude\projects\<old-path-key>\memory\` into the new path's `memory\` folder, or tell the new chat to read this file. Old transcripts are in the same `projects` folder.

**After moving:** `git status` (the remote is unchanged), `py -3.12 -m unittest discover -s tests` (should pass), `python tools\signin.py` to confirm sign-in and access, then build as usual.
