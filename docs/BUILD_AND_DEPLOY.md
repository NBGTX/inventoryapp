# NBG Hub: build and deploy

One command builds a tested installer. Techs run the installer; it needs no administrator rights and includes the Microsoft Edge WebView2 runtime.

## What a release is

`release\NBG-Hub-Setup-<version>.exe` (plus a `.sha256` file). It installs the PyInstaller **folder** build to `%LOCALAPPDATA%\Programs\NBG Hub`, adds a Start Menu shortcut (desktop shortcut optional), and silently installs the WebView2 runtime only if the PC lacks it. Running a newer installer over an older one upgrades in place.

| Where | What | Touched by updates? |
|---|---|---|
| `%LOCALAPPDATA%\Programs\NBG Hub\` | The app, plus the shipped `config.json` | Replaced on every update |
| `%LOCALAPPDATA%\NBG Hub\` | Sign-in token cache, chosen division, data mode, local snapshots, `boot.log`, optional `config.json` override | Never touched (kept on uninstall too) |

**Config has two layers.** The shipped `config.json` (tenant, client id, central site) is the base. A `config.json` in `%LOCALAPPDATA%\NBG Hub\` overrides it key by key (nested objects such as `central` merge). Use the override for a one-PC exception; do not edit the installed one, an update replaces it.

## One-time setup on the build PC

1. Python 3.12 (`py -3.12`). The build creates its own pinned environment (`.venv-build`, from `requirements.lock.txt`), so nothing else needs installing.
2. Inno Setup 6: `winget install JRSoftware.InnoSetup`
3. `config.json` in the project folder, filled in for production. The build **scrubs secrets out of a copy** (for example a leftover `lenovo_client_id`) and ships only the copy. Secrets live in Master Settings (Settings > Platform > Integrations).
4. First build downloads the WebView2 offline installer (about 170 MB) from Microsoft into `installer\assets\` and verifies Microsoft's signature on it. It is cached after that and is not committed to git.
5. Only if signing: the Windows SDK (`signtool.exe`) and the code-signing certificate in your certificate store.

## Cutting a release

1. Make sure everything is committed and pushed to `origin main`.
2. `python tools\bump_version.py` (updates `version.py`, `version.txt`, mock strings). Commit and push.
3. Close the running app, then:

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

The script stops at the first problem. In order it:

1. finds Python 3.12 and builds in the pinned environment;
2. checks the version files agree;
3. runs the offline tests;
4. scrubs and scans the config that will ship;
5. runs PyInstaller (folder build);
6. **runs the built exe with `--selftest`**: imports every module and checks every web file, so a missing `--hidden-import` or asset fails the build and not a tech's PC;
7. downloads and verifies WebView2 if needed, compiles the installer, and writes the SHA256.

Flags: `-NoInstaller` (app folder only), `-Sign` (Authenticode signing), `-SkipTests` (emergencies), `-Python <path>`.

4. Tag the release: `git tag v<version>` and `git push origin v<version>`.

## Smoke test before handing out

On a PC that is not the build PC (ideally one without WebView2 and without Python):

- [ ] Installer runs without a UAC prompt, finishes, app launches.
- [ ] Sign in works; the header shows the right division; the dashboard shows that division's data.
- [ ] Settings opens; the version in the sidebar footer matches the release.
- [ ] A plain-user account sees only the sections Role access gives it.
- [ ] Re-run the installer over itself: it upgrades, and you stay signed in.
- [ ] Uninstall removes the app and shortcuts.

## Handing out

For now, send the installer file (and its `.sha256`). Tell people to verify nothing else, just run it. Then, in the app, set **Settings > Platform > Integrations & options > Releases > Latest released version** to the new version. Techs on older builds see an "Update available" notice. Raise **Oldest allowed version** when a release changes how data is stored; older builds then show a red "Update required" notice.

**Unsigned builds.** Until Nucor has a code-signing certificate, Windows SmartScreen shows "Windows protected your PC" on first run: choose **More info > Run anyway**. Defender may also flag a PyInstaller program. The folder build (which this uses) is flagged much less than a single-file exe. Signing the app and the installer (`-Sign`) is the real fix; until then IT can allow the file hash from the `.sha256` or have the false positive reviewed by Microsoft.

## Rollback

Keep the previous `NBG-Hub-Setup-<version>.exe` files. To roll back, uninstall (or install over) with the older installer, then lower **Latest released version** to match. User data is kept, and per-user settings are not version-specific.

## Later: Intune

The installer is already managed-deployment friendly:

- Silent install: `NBG-Hub-Setup-<ver>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART`
- Per-user app, so deploy in **user** context.
- Detection rule: file `%LOCALAPPDATA%\Programs\NBG Hub\NBG Hub.exe`, version greater than or equal to the release version (or the Uninstall registry key under `HKCU`, AppId `{6F1D2C54-3B7A-4E58-9A1C-0B8E5D4F7A21}`).
- Wrap with the Microsoft Win32 Content Prep Tool to get a `.intunewin`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Build stops at "Self-test FAILED" | Read the `FAIL` lines; usually a new module missing from `selftest.MODULES` or a new web file missing from `selftest.WEB_FILES` |
| Build stops at the config scan | A secret is in `config.json`: move it to Master Settings and blank it |
| `pip` cannot download | Corporate proxy/certificate: set `PIP_CERT` or run on the corporate network |
| App says WebView2 is missing | Re-run the installer (it includes the runtime) |
| App opens but data is for the wrong division or blank | Read `%LOCALAPPDATA%\NBG Hub\boot.log` (account, role, visible divisions per launch) |
