# Unattended sync: design

Status: **proposal, not built**. Needs three decisions from you (section 6).

## 1. What runs today

The sync is a side effect of someone opening the app. About 4 seconds after launch the UI runs `run_sync`, then `enrich_inventory`, then `boneyard_sweep`, all with commit on (`sync.py`, `app.py`). So:

- Data is only as fresh as the last time someone opened the app.
- Every user who opens the app runs it, so several can run at once (the code relies on idempotent writes, not locks).
- It runs as that user, with that user's Intune and SharePoint rights.
- With multiple divisions, the sync only covers the division the user happens to have selected.

`sync.py` already has a CLI (`python sync.py` = dry run, `--commit` = apply), but it signs in interactively, so it cannot run on a schedule.

## 2. Goal

A scheduled job, with no person present, that for every enabled division:

1. Reads that division's Intune devices (device category = `division.intune_category`).
2. Reconciles the central `Inventory - In Use` list (add/update/dedupe/enrich), exactly as `run_sync` does today.
3. Optionally runs the boneyard sweep.
4. Writes ONE audit entry per division per run (CLAUDE.md Rule 7) and a status record the app can show ("last sync 02:00, +3 / ~12 / -0").
5. Fails safely: it must never mass-delete because Intune returned a bad or partial answer.

The app's launch sync then becomes optional (or only a manual "Sync now" button).

## 3. The hard part: who does the job sign in as?

Today everything is **delegated** (acts as the signed-in person). A scheduled job has no person. Options:

| | A. Service account, delegated | B. App-only (client credentials + certificate) | C. Azure Automation / Function with managed identity |
|---|---|---|---|
| New Entra setup | None (use the existing app registration) | New app registration or new permissions on the web registration; admin consent | Azure subscription + resource + managed identity + permissions |
| Permissions needed | Account holds an Intune read role + Contribute on the central site | Application permissions: `DeviceManagementManagedDevices.Read.All`, `Sites.Selected` (central site only), `User.Read.All` (+ `Directory.Read.All` if used) | Same as B, assigned to the managed identity |
| Secret handling | Refresh token cached (DPAPI) under the service account; expires after about 90 days idle; breaks if Conditional Access/MFA applies | Certificate in the machine store (no secret in files) | No secret at all |
| Risk | Breaks silently when the token or the account password changes; a shared human-like account | Needs an admin to consent; clean and auditable | Needs Azure; most moving parts |
| Fits Nucor guidance | Weak (shared account) | Good | Best (managed identity preferred) |
| Effort | Smallest | Medium | Largest |

**Recommendation:** B (app-only with a certificate), run by a scheduled task on a domain server. It needs one admin consent, but it avoids a shared account and it is the same identity the web version would need later. Fall back to A only to get moving before consent arrives.

Other Graph reads the sync uses (user city/department for site resolution, registered owners for co-managed devices) are covered by `User.Read.All` / `Directory.Read.All` application permissions. The MFA populate step needs `UserAuthenticationMethod.Read.All` and an auth-reader role; keep MFA out of the unattended job at first.

## 4. Code changes

1. **Auth mode in `GraphClient`**: `auth_mode: "delegated" | "app"` (config). App mode uses MSAL `ConfidentialClientApplication` with a certificate, `acquire_token_for_client`, scope `https://graph.microsoft.com/.default`. Everything else (`_req`, paging, throttling) is unchanged. `account_name` = the app's name for audit entries.
2. **Multi-division runner** `tools/run_sync.py`:
   - `--division <id>` or `--all`, **dry run by default**, `--commit` to write.
   - Loops the visible/enabled divisions: `set_division(id, persist=False)`, then `run_sync` / `dedupe` / `enrich` (and `boneyard_sweep` only with `--sweep`).
   - One audit entry per division per run (already how `run_sync` logs).
3. **Safety rails (new, important when nobody is watching)**
   - Abort a division if Intune returns 0 devices, or fewer than 70% of the previous run's count (a throttled or partial answer must not look like "everything left").
   - Cap changes per run (for example no more than 20% of rows added/updated/removed); above that, stop and alert instead of writing.
   - The boneyard sweep (which deletes) stays off by default in unattended mode.
   - `--max-runtime` so a hung run is killed.
4. **Run lock**: a row in `Hub Items` (kind `sync-lock`, per division) with a start time; another run skips if the lock is younger than the runtime limit. This also lets the app's launch sync detect "a scheduled run is in progress" and skip.
5. **Status record**: kind `sync-status` per division (start, end, counts, ok/error). The dashboard shows "Last sync: ..." and warns when it is older than 36 hours.
6. **Alerts**: on failure or threshold abort, send an email or Teams message. This needs `Mail.Send` (application) or a Teams incoming webhook (no Graph permission, a URL stored as a Master Setting). Decide which in section 6.
7. **Tests**: the same offline style as `tests/` (fake Intune + fake lists), including the abort thresholds and the lock.

## 5. Where it runs

A domain-joined Windows server (the IIS box is a candidate) with a scheduled task, for example nightly at 02:00, plus an hourly light run if wanted. Python 3.12 and the repo (or a PyInstaller build of the runner). Outbound HTTPS to Graph and login.microsoftonline.com. The server does not need AD or SQL access for the sync itself.

Later (web version): the same runner becomes a hosted background service in the ASP.NET app with the same app-only identity.

## 6. Decisions needed

1. **Identity**: A (service account), B (app-only certificate), or C (Azure managed identity)? Who can grant admin consent for B?
2. **Where it runs**: which server, and who owns the scheduled task?
3. **Alerts**: email, Teams webhook, or just the status shown in the app?
4. **Sweep**: keep the delete sweep manual-only (recommended) or schedule it too?
5. **Schedule**: nightly only, or hourly?

## 7. Interim step that needs no decision

Add the Run lock and status record first (items 4 and 5). They make the existing launch sync safer today (no overlapping runs, visible "last sync") and are required by the scheduled job anyway.
