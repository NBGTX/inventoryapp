# NBG Hub Roadmap

**Current baseline:** v2026.10.20. This file is the current backlog; older roadmap and status sections in `HANDOFF.md` and `README.md` contain outdated claims.

## Next product feature

### OT network discovery — planned, deliberately not started

Build division-owned scan targets tied to division sites. Each target should support approved IP ranges/subnets, exclusions, owner, schedule, and scan history/status. Discovery must be low impact for OT networks, require explicit target approval, and show findings for review before adding or changing inventory records.

**Deployment constraint:** reliable scheduled scans need a scanner service or always-on host reachable from each target network. A scan started by the desktop app only works while that app is open and connected to that network. Choose scanner placement and network/security approvals before implementation.

## Open reliability and security work

1. **Protect checklist data from read failures.** `hub.py` returns `None` both when a checklist is absent and when an existing file/document cannot be read. `Hub.boot()` treats either case as permission to seed defaults and save them. Distinguish missing from unreadable; seed only when missing. Preserve the existing checklist on every read/parse error.
2. **Isolate external full-window pages from the app API.** `app.py` opens configured external sites in the same pywebview window with the full `js_api` attached. The injected Back button calls `site_back`; other API methods are also exposed to that page context. Use a restricted bridge or open external sites without the app bridge. Review allowed full-window sites and custom-site permissions.
3. **Harden concurrent shared-document edits.** Central SharePoint hub documents use revision checks, while legacy file-backed documents rely on atomic replacement without a cross-process lock. Keep writes conflict-aware, surface conflicts clearly, and avoid reintroducing periodic writes. Treat legacy OneDrive conflict copies as a migration/cleanup task if that storage mode is still in use.

## Sync and operations

5. **Finish unattended sync safety rails.** Manual “Sync all divisions,” run locks, and last-sync status are implemented. Remaining design in `docs/UNATTENDED_SYNC.md`: abort when a division's Intune result is unexpectedly low (proposed 70% of prior count), cap changes per run, then build an app-only runner with managed identity, scheduled hosting, and Teams alerts. Requires Entra consent, Azure/server ownership, and a Teams destination.
6. **Add CI.** Git and offline tests exist; no CI workflow is present. Add a small pipeline for the existing offline test suite and build checks.

## Conditional integrations and cleanup

7. **Dell TechDirect specs lookup.** Connector is present, but useful lookups depend on an authorized TechDirect API credential and vendor access. Resume when those are available; keep secrets out of installer and shared files.
8. **Reconcile stale project documentation.** `HANDOFF.md`, `README.md`, and `docs/PROJECT_STATE.md` include old versions, architecture notes, or completed work as open. Update them against the current app, or label historical material clearly, so future releases do not revive fixed items.

## Completed or removed from active backlog

- Boneyard checks now fail closed when AD, Entra, or Intune cannot be verified; candidates need serial and hostname, and an active control device validates source results.
- Manual sync-all, per-division sync locks, and last-sync visibility are implemented.
- Git and offline tests are present. The old “no git/no tests” roadmap claim was incorrect; CI is still absent.
- Upgrade-list auto-add now writes only when it adds entries; the old claim that every dashboard load writes the list was stale.
- OT register, CSV import/value matching, stale-data indicators/reminders, and configurable site-level Entra/Intune scopes are part of the current app; they are not open roadmap items.
- Desktop startup no longer falls back to Mock after a short timer; silent sign-in now reuses the previously selected account instead of whichever cached account MSAL lists first.
