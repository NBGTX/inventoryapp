# ROADMAP — NBGW Hub

Open risks and cleanup moved out of CLAUDE.md. Details: HANDOFF.md §11.

## Known high-risk areas (fix order = priority)

1. **Boneyard false positives.**
   - `intune_presence_map` and `entra_device_map` swallow Graph errors and return partial results, while the guards still report success (`app.py:630-637`, `graph.py:514-518, 542-547`).
   - Blank hostnames skip the AD and Entra checks.
   - Result: a live device can be auto-retired.
   - Fix: return an error flag on partial results; abort the sweep when set; treat a blank hostname as "skip device", not "pass".
2. **Config reseed.** `hub.get_config()` returns `None` on any read error, and then `Hub.boot` (`web/app.js:3644-3649`) overwrites the team's checklist config with defaults.
   - Fix: separate "missing" from "read error"; reseed only on missing.
3. **Full-window sites get the full Python bridge.** `_BACK_JS` calls `window.pywebview.api.site_back()` from external pages (`app.py:1539-1557`). Custom sites can be added in fullview mode without the PIN (`web/app.js:1248-1271`).
   - Fix: expose only `site_back` to external pages; require the PIN for custom sites.
4. **Boot race.** If `pywebviewready` arrives more than 300 ms after `load`, the app boots permanently in Mock mode (`web/app.js:4619-4620`).
   - Fix: wait on `pywebviewready` with a long timeout before falling back to Mock.
5. **No locking on shared JSON.** OneDrive conflict copies already exist in live data, and the dashboard writes the upgrade list on every load (`app.py:1489-1490`).
   - Fix: one file per item; write only on change.
6. **The Configuration PIN is enforced only in the browser code.** It's a UI lock, not security.
   - Fix: enforce in `Api`, or document as UI-only.

## Stale docs and leftovers (cleanup)

- `app.py` module docstring.
- `ts_unlock` docstring (see CLAUDE.md rule 5 for real behavior).
- `hub.py:298` says `domain`; the code writes `company`.
- Comments mentioning "BomsNet baselines" (now covers all groups).
- `NBGW Inventory.spec` (leftover; delete).
- Project `SystemsData\` and `dist\SystemsData\` hold stale test data.

## Missing infrastructure

- No git, no tests, no CI.
- Entra ID auth and Foundry guidance: see Nucor architecture guidance before any wider rollout.
