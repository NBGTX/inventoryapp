#!/usr/bin/env python3
"""
Intune Sync - keep the In Use list mirroring the NBGW Intune fleet.

Pulls every Intune managed device in the NBGW device category (see
graph.get_intune_category_devices) and reconciles it into the In Use SharePoint list:
  - device not yet in In Use  -> add it (and remove it from New Stock if present)
  - device already in In Use   -> refresh the Intune-authoritative fields
                                  (primary user, OS version, OS install/enrolled,
                                  device name) and fill blanks (model, site, storage)

Vendor-supplied specs (CPU/RAM/warranty) already on a row are preserved. Runs from:
  - the desktop app's "Sync now" button and its silent background refresh on open
  - a manual CLI run below

Run manually:
    python sync.py            # dry run - reports what WOULD change
    python sync.py --commit   # apply
"""
from __future__ import annotations

import sys

import vendors
from graph import GraphClient, GraphError

# Intune is authoritative for these; always refresh from the device record.
_AUTH_FIELDS = ("user", "os_version", "os_install", "device_name")
# These we only fill when the In Use row is blank (don't clobber nicer stored values).
_FILL_FIELDS = ("model", "manufacturer", "storage", "site_tag")
_MAX_FAIL_STREAK = 5


def run_sync(gc: GraphClient, commit: bool = False) -> dict:
    """Reconcile In Use with the NBGW Intune fleet.

    Returns {"moved": [added dicts], "added": n, "updated": n, "refreshed": n,
             "count": devices_seen, "skipped": 0, "deduped": n, "errors": [...]}.
    ("moved"/"refreshed" kept for the existing UI, which reads their counts.)
    """
    added, updated, errors = [], [], []
    if commit and getattr(gc, "_central", False) and not gc._local:
        import schema
        bad = schema.problems(gc, ("new_stock", "in_use", "log"))
        if bad:      # refuse to write into lists whose columns the app cannot fill (every write would 400)
            lines = "; ".join(f"{n}: {', '.join(v)}" for n, v in bad.items())
            return {"moved": [], "added": 0, "updated": 0, "refreshed": 0, "count": 0, "skipped": 0, "deduped": 0,
                    "errors": ["Central lists need fixing before a sync can write - " + lines +
                               ". Run: python tools\\check_central.py"]}
    try:
        devices = gc.get_intune_category_devices()
    except GraphError as e:
        return {"moved": [], "added": 0, "updated": 0, "refreshed": 0,
                "count": 0, "skipped": 0, "deduped": 0, "errors": [str(e)]}

    # Safety rail: an empty answer from Intune must never read as "the whole fleet left". Nothing is changed
    # (dedupe included) when Intune returns no devices but the division already has rows.
    if not devices and gc._items_raw("in_use"):
        return {"moved": [], "added": 0, "updated": 0, "refreshed": 0, "count": 0, "skipped": 0, "deduped": 0,
                "errors": ["Intune returned 0 devices for this division, but it already has rows. Nothing was changed "
                           "(check the Intune category name and your Intune role)."]}

    # Self-heal duplicate In Use rows first (see dedupe_in_use for why they occur),
    # then build the reconcile index from the SURVIVING items — reuses this one raw
    # read instead of fetching the list twice.
    in_use_raw = gc._items_raw("in_use")
    dedupe = dedupe_in_use(gc, commit=commit, items=in_use_raw)
    errors.extend(dedupe.get("errors", []))
    removed_ids = set(dedupe.get("removed_ids", []))
    if removed_ids:
        in_use_raw = [it for it in in_use_raw if it.get("id") not in removed_ids]

    def index(items):
        m = {}
        for it in items:
            s = (it.get("fields", {}).get("Title") or "").strip().lower()
            if s:
                m[s] = it
        return m

    in_use = index(in_use_raw)
    stock = index(gc._items_raw("new_stock"))

    streak = 0                      # consecutive write failures: stop early instead of hammering SharePoint
    for dev in devices:
        if streak >= _MAX_FAIL_STREAK:
            errors.append(f"Stopped after {_MAX_FAIL_STREAK} consecutive write failures (see the first error above).")
            break
        n_err = len(errors)
        serial = (dev.get("serial") or "").strip()
        if not serial:
            continue
        sl = serial.lower()

        if sl in in_use:
            item = in_use[sl]
            cur = gc._row(item["fields"], "in_use")
            updates = {}
            for fld in _AUTH_FIELDS:
                newv = (dev.get(fld) or "").strip()
                if newv and newv != (cur.get(fld) or "").strip():
                    updates[fld] = newv
            for fld in _FILL_FIELDS:
                newv = (dev.get(fld) or "").strip()
                if newv and not (cur.get(fld) or "").strip():
                    updates[fld] = newv
            # last check-in: refresh only when the DAY changes (avoids a write every sync)
            nl = (dev.get("last_checkin") or "").strip()
            if nl and nl[:10] != (cur.get("last_checkin") or "")[:10]:
                updates["last_checkin"] = nl
            if not updates:
                continue
            if commit:
                try:
                    gc.update_item("in_use", item["id"], updates)
                    updated.append(serial)
                except GraphError as e:
                    errors.append(f"{serial}: {e}")
            else:
                updated.append(serial)
        else:
            if commit:
                try:
                    gc.add_in_use(dev)
                    if sl in stock:
                        gc.delete_item("new_stock", stock[sl]["id"])
                    added.append({"serial": serial, "manufacturer": dev.get("manufacturer", ""),
                                  "model": dev.get("model", ""), "user": dev.get("user", "")})
                except GraphError as e:
                    errors.append(f"{serial}: {e}")
            else:
                added.append({"serial": serial, "manufacturer": dev.get("manufacturer", ""),
                              "model": dev.get("model", ""), "user": dev.get("user", "")})
        streak = streak + 1 if len(errors) > n_err else 0

    # one summary audit entry per sync run (not one per device)
    if commit and (added or updated):
        gc.add_log("Sync", "", "", actor=getattr(gc, "account_name", "") or "",
                   details=f"Intune ({gc.division['intune_category']} device category): {len(added)} added, {len(updated)} updated")

    return {"moved": added, "added": len(added), "updated": len(updated),
            "refreshed": len(updated), "count": len(devices), "skipped": 0,
            "deduped": dedupe["removed"], "errors": errors}


def dedupe_in_use(gc: GraphClient, commit: bool = True, items: list[dict] | None = None) -> dict:
    """Self-heal duplicate serials in the In Use SharePoint list.

    ROOT CAUSE: `run_sync` decides "add this device" from a single point-in-time read
    of the list. SharePoint's Title (serial) column has no uniqueness constraint, and
    there's no cross-process lock, so if two sync runs overlap (two people/machines with
    the app open around the same launch window, each firing their own backgroundSync a
    few seconds after startup) both can read the list BEFORE the other's write lands,
    both conclude the same newly-missing device isn't there yet, and both POST it —
    creating two identical items for one serial. Confirmed live 2026-09-28: 10 serials
    had 2-3 duplicate items each, all created within a few minutes of each other in a
    handful of distinct incidents.

    For every serial with more than one item, keeps the ONE with the freshest
    `last_checkin` (Intune-authoritative; ties/blanks fall back to the most recently
    modified item) and deletes the rest. Runs as part of every `run_sync` so any
    duplicate that slips through gets cleaned up automatically on the next sync —
    same self-healing pattern as the Boneyard sweep. Pass `items` to reuse an
    already-fetched raw list (run_sync does); omit it to fetch fresh.
    Returns {"removed": n, "serials": [...], "errors": [...]}.
    """
    raw = items if items is not None else gc._items_raw("in_use")
    groups: dict[str, list[dict]] = {}
    for it in raw:
        s = (it.get("fields", {}).get("Title") or "").strip().lower()
        if s:
            groups.setdefault(s, []).append(it)

    removed, serials, errors = [], [], []
    for s, its in groups.items():
        if len(its) < 2:
            continue

        def sort_key(it):
            row = gc._row(it.get("fields", {}), "in_use", in_use=True)
            return ((row.get("last_checkin") or ""), (it.get("lastModifiedDateTime") or ""))

        its.sort(key=sort_key, reverse=True)
        keeper, extras = its[0], its[1:]
        serials.append(gc._row(keeper.get("fields", {}), "in_use", in_use=True).get("serial", s))
        for it in extras:
            # Recorded as "removed" either way (commit=False previews what WOULD be
            # removed) so a caller reusing `items` can exclude these ids from its own
            # index without a second list read.
            removed.append(it["id"])
            if commit:
                try:
                    gc.delete_item("in_use", it["id"])
                except GraphError as e:
                    errors.append(f"{s}: {e}")

    if commit and removed and not errors:
        gc.add_log("Dedupe", "", "", actor=getattr(gc, "account_name", "") or "",
                   details=f"In Use: removed {len(removed)} duplicate row(s) across "
                           f"{len(serials)} serial(s): {', '.join(serials[:10])}"
                           f"{' …' if len(serials) > 10 else ''}")
    return {"removed": len(removed), "serials": serials, "removed_ids": removed, "errors": errors}


def enrich_in_use(gc: GraphClient, commit: bool = True, cap: int | None = None) -> dict:
    """Fill blanks on In Use rows: (a) primary user from Intune when blank, (b) site
    from that user's city when site is blank, and (c) cpu/ram/warranty from the vendor
    (Lenovo today) when those are missing.

    Only touches rows that are actually missing the field, so a fully-populated device
    is never re-queried. Vendor calls are bounded to `cap` per run (config
    `intune_enrich_per_sync`, default 75) so a large fleet fills in across a few syncs.
    Site lookups are cheap (cached per user) and unbounded. Dell is skipped until its
    API key arrives. Returns {enriched, sites, remaining, errors}.
    """
    if cap is None:
        import settings_catalog
        cap = settings_catalog.number(gc, "intune_enrich_per_sync")
    enriched = sites = users = candidates = ulooks = mfas = 0
    errors = []
    # MFA registration report: pulled at most ONCE per run and only if some row
    # actually needs it (lazy). Cached on the client too. {} when the scope/role
    # isn't available, so the MFA cell just stays blank.
    _mfa = {"map": None, "loaded": False}

    def mfa_map() -> dict:
        if not _mfa["loaded"]:
            _mfa["loaded"] = True
            try:
                _mfa["map"] = gc.mfa_registration_map()
            except Exception:
                _mfa["map"] = {}
        return _mfa["map"] or {}

    for item in gc._items_raw("in_use"):
        f = item.get("fields", {})
        serial = (f.get("Title") or "").strip()
        if not serial:
            continue
        cur = gc._row(f, "in_use")
        updates = {}

        # (a) primary user: fill it when the row is blank. Prefer the Intune
        #     userPrincipalName; if that's empty (common on co-managed devices), fall
        #     back to the Azure AD device's registered owner (needs Directory.Read.All).
        user = (cur.get("user") or "").strip()
        owner_loc = None  # {city, office} if we resolved the user via the AAD owner
        if not user and ulooks < cap:
            ulooks += 1
            try:
                dev = gc.lookup_intune(serial)
            except Exception:
                dev = None
            if dev:
                u = (dev.get("user") or "").strip()
                if not u and dev.get("aad_device_id"):
                    owner = gc._device_owner(dev["aad_device_id"])
                    if owner and owner.get("upn"):
                        u = owner["upn"]
                        owner_loc = {"city": owner.get("city", ""), "office": owner.get("office", "")}
                if u:
                    user = u
                    updates["user"] = u
                    if not cur.get("os_version") and dev.get("os_version"):
                        updates["os_version"] = dev["os_version"]
                    if not cur.get("os_install") and dev.get("os_install"):
                        updates["os_install"] = dev["os_install"]

        # (b) site from that user's city, only when site is blank:
        #     Lathrop -> LTR, Brigham -> BRI (NBGW). For a user whose city is neither,
        #     store their office location instead so the row shows where they actually
        #     are (these count as "not part of NBGW" on the dashboard). Needs
        #     Directory.Read.All; silently skipped until that read is consented.
        if not (cur.get("site_tag") or "").strip() and user:
            loc = owner_loc
            if loc is None:
                try:
                    loc = gc._user_location(user)
                except Exception:
                    loc = None
            if loc:
                site = gc._city_to_site(loc.get("city", ""))
                if site:
                    updates["site_tag"] = site
                else:
                    office = (loc.get("office") or loc.get("city") or "").strip()
                    if office:
                        updates["site_tag"] = office

        # (c) vendor (Lenovo / Dell / HP) specs + warranty, only when missing (bounded by cap).
        #     Dell and HP only supply model + warranty, so for them look up only while the warranty is blank;
        #     otherwise every run would re-query them for cpu/ram they can never give.
        did_specs = False
        _vend = vendors.vendor_of(cur.get("manufacturer") or "")
        _need = (not (cur.get("cpu") and cur.get("ram") and cur.get("warranty"))) if _vend == "lenovo" else (not cur.get("warranty"))
        if _vend and _need:
            candidates += 1
            if enriched < cap:
                try:
                    info = gc.lookup_vendor(serial, cur.get("manufacturer") or "")
                except Exception as e:
                    info, _ = None, errors.append(f"{serial}: {e}")
                if info:
                    if not cur.get("cpu") and info.get("cpu"):
                        updates["cpu"] = info["cpu"]
                    if not cur.get("ram") and info.get("ram"):
                        updates["ram"] = info["ram"]
                    if not cur.get("storage") and info.get("storage"):
                        updates["storage"] = info["storage"]
                    if not cur.get("warranty") and info.get("warranty_end"):
                        updates["warranty"] = info["warranty_end"]
                    did_specs = any(k in updates for k in ("cpu", "ram", "storage", "warranty"))

        # (d) MFA registered: fill ONLY when this row's MFA cell is blank, then it's
        #     persisted to the list and never queried again (per Blake's request).
        #     Uses the one-shot bulk report keyed by the user's UPN.
        if not (cur.get("mfa") or "").strip() and user:
            info = mfa_map().get(user.strip().lower())
            if info:
                updates["mfa"] = "Yes" if info["registered"] else "No"

        if not updates:
            continue
        if commit:
            try:
                gc.update_item("in_use", item["id"], updates)
            except GraphError as e:
                errors.append(f"{serial}: {e}")
                continue
        if did_specs:
            enriched += 1
        if "site_tag" in updates:
            sites += 1
        if "user" in updates:
            users += 1
        if "mfa" in updates:
            mfas += 1

    remaining = max(0, candidates - enriched)
    if commit and (enriched or sites or users or mfas):
        gc.add_log("Enriched", "", "", actor=getattr(gc, "account_name", "") or "",
                   details=f"user for {users}, site for {sites}, MFA for {mfas}, specs for {enriched} device(s); {remaining} specs pending")
    return {"enriched": enriched, "sites": sites, "users": users, "mfas": mfas,
            "remaining": remaining, "errors": errors}


# Fields FORCE-refreshed from Intune on a master sync (overwrite even when already set).
_MASTER_INTUNE_FIELDS = ("user", "device_name", "os_version", "os_install", "last_checkin", "storage")


def master_sync(gc: GraphClient, commit: bool = True) -> dict:
    """Deliberate, unbounded FULL refresh of every In Use row from source, OVERWRITING
    stored values (unlike the conservative fill-when-blank background sync). Driven by
    the "Master sync" button. Refreshes:
      - primary user, device name, OS version/install, last check-in, storage  <- Intune
        (Azure AD registered owner as the user fallback for co-managed devices)
      - CPU / RAM / storage / warranty / model                                 <- Lenovo
      - MFA registered ("Yes"/"No")                                            <- auth report
    Site tag is left alone (it can be a manual pick). Reconciles the fleet first (adds any
    missing devices) via run_sync. Uses one bulk Intune pull + one bulk MFA report; Lenovo
    is per-device, which is why a big fleet can take a few minutes. Only changed fields are
    written. Returns per-field change counts + base run_sync counts + errors.
    """
    errors: list = []
    base = run_sync(gc, commit=commit)          # add missing devices + baseline auth refresh
    errors.extend(base.get("errors", []))

    # bulk source maps (cheap: one paged call each)
    intune: dict = {}
    try:
        for d in gc.get_intune_category_devices():
            s = (d.get("serial") or "").strip().lower()
            if s:
                intune[s] = d
    except GraphError as e:
        errors.append(f"Intune fleet: {e}")
    try:
        mfa = gc.mfa_registration_map()
    except Exception:
        mfa = {}

    counts = {"user": 0, "checkin": 0, "os": 0, "storage": 0, "specs": 0, "mfa": 0}
    rows = 0

    for item in gc._items_raw("in_use"):
        f = item.get("fields", {})
        serial = (f.get("Title") or "").strip()
        if not serial:
            continue
        rows += 1
        cur = gc._row(f, "in_use", in_use=True)
        updates: dict = {}

        dev = intune.get(serial.lower())
        if dev is None:                          # row outside the NBGW category pull
            try:
                dev = gc.lookup_intune(serial)
            except Exception:
                dev = None
        if dev:
            for fld in _MASTER_INTUNE_FIELDS:
                nv = (dev.get(fld) or "").strip()
                if nv and nv != (cur.get(fld) or "").strip():
                    updates[fld] = nv
            # user fallback: Azure AD device registered owner (co-managed, no Intune user)
            if not (dev.get("user") or "").strip() and dev.get("aad_device_id"):
                try:
                    owner = gc._device_owner(dev["aad_device_id"])
                except Exception:
                    owner = None
                if owner and owner.get("upn") and owner["upn"] != (cur.get("user") or "").strip():
                    updates["user"] = owner["upn"]

        # specs / warranty / model from the maker's API (overwrite)
        manu = (cur.get("manufacturer") or (dev.get("manufacturer") if dev else "") or "")
        if vendors.vendor_of(manu):
            try:
                info = gc.lookup_vendor(serial, manu)
            except Exception as e:
                info, _ = None, errors.append(f"{serial}: {e}")
            if info:
                for logical, key in (("cpu", "cpu"), ("ram", "ram"),
                                     ("storage", "storage"), ("model", "model")):
                    nv = (info.get(key) or "").strip()
                    if nv and nv != (cur.get(logical) or "").strip():
                        updates[logical] = nv
                w = (info.get("warranty_end") or "").strip()
                if w and w != (cur.get("warranty") or "").strip():
                    updates["warranty"] = w

        # MFA registered (overwrite): bulk report if the role allows it, else the
        # per-user authentication-methods read (needs UserAuthenticationMethod.Read.All
        # + the runner's auth-admin role). Skips silently when neither is available.
        u = (updates.get("user") or cur.get("user") or "").strip()
        if u:
            nv = gc.mfa_status(u, mfa)
            if nv and nv != (cur.get("mfa") or "").strip():
                updates["mfa"] = nv

        if not updates:
            continue
        if commit:
            try:
                gc.update_item("in_use", item["id"], updates)
            except GraphError as e:
                errors.append(f"{serial}: {e}")
                continue
        if "user" in updates:
            counts["user"] += 1
        if "last_checkin" in updates:
            counts["checkin"] += 1
        if "os_version" in updates or "os_install" in updates:
            counts["os"] += 1
        if "storage" in updates:
            counts["storage"] += 1
        if any(k in updates for k in ("cpu", "ram", "warranty", "model")):
            counts["specs"] += 1
        if "mfa" in updates:
            counts["mfa"] += 1

    if commit:
        gc.add_log("Master sync", "", "", actor=getattr(gc, "account_name", "") or "",
                   details=(f"{rows} rows; user {counts['user']}, check-in {counts['checkin']}, "
                            f"OS {counts['os']}, storage {counts['storage']}, specs {counts['specs']}, "
                            f"MFA {counts['mfa']}; added {base.get('added', 0)}"))
    return {"rows": rows, "counts": counts, "added": base.get("added", 0),
            "updated": base.get("updated", 0), "errors": errors}


def populate_mfa(gc: GraphClient, commit: bool = True, force: bool = False) -> dict:
    """Fill the In Use 'MFA' column from the user's registered auth methods.
    Uses the bulk registration report if the role allows it, else the per-user
    authentication-methods read (UserAuthenticationMethod.Read.All + the runner's
    auth-admin role). Fill-when-blank by default; force=True re-checks every row.
    Faster than master_sync because it only touches MFA (no Intune/Lenovo passes).
    Returns {checked, filled, yes, no, unresolved, errors}."""
    errors: list = []
    try:
        mmap = gc.mfa_registration_map()
    except Exception:
        mmap = {}
    checked = filled = yes = no = unresolved = 0
    for item in gc._items_raw("in_use"):
        f = item.get("fields", {})
        serial = (f.get("Title") or "").strip()
        if not serial:
            continue
        cur = gc._row(f, "in_use", in_use=True)
        if not force and (cur.get("mfa") or "").strip():
            continue
        u = (cur.get("user") or "").strip()
        if not u:
            continue
        checked += 1
        nv = gc.mfa_status(u, mmap)
        if not nv:
            unresolved += 1
            continue
        if nv == (cur.get("mfa") or "").strip():
            continue                       # already correct (force re-check, no change)
        if commit:
            try:
                gc.update_item("in_use", item["id"], {"mfa": nv})
            except GraphError as e:
                errors.append(f"{serial}: {e}")
                continue
        filled += 1
        if nv == "Yes":
            yes += 1
        else:
            no += 1
    if commit and filled:
        gc.add_log("MFA", "", "", actor=getattr(gc, "account_name", "") or "",
                   details=f"populated MFA for {filled} device(s) (Yes {yes}, No {no}); {unresolved} unresolved")
    return {"checked": checked, "filled": filled, "yes": yes, "no": no,
            "unresolved": unresolved, "errors": errors}


def sync_all(gc: GraphClient, commit: bool = True, only: list | None = None, hub_factory=None) -> dict:
    """Run the normal reconcile + enrich for EVERY enabled division, one after another (super admins, manual).

    Each division gets its own client copy (shared sign-in), so the caller's active division and caches are never
    touched while this runs. The delete-capable boneyard sweep is NOT part of this. One audit entry per division.
    Returns {"ok": bool, "divisions": [{id, name, ok, count, added, updated, deduped, enriched, errors}]}."""
    out = []
    for d in list(gc.registry):
        if only is not None and d["id"] not in only:
            continue
        if d.get("enabled") is False:
            continue
        row = {"id": d["id"], "name": d.get("name", d["id"]), "ok": False, "count": 0, "added": 0, "updated": 0,
               "deduped": 0, "enriched": 0, "errors": []}
        out.append(row)
        try:
            c = gc.clone_for_snapshot()
            c.set_division(d["id"], persist=False)

            def body(c=c, row=row):
                r = run_sync(c, commit=commit)
                row.update(count=r.get("count", 0), added=len(r.get("moved", [])), updated=r.get("updated", 0),
                           deduped=r.get("deduped", 0))
                row["errors"] += [str(e)[:300] for e in r.get("errors", [])]
                if not row["errors"]:
                    e = enrich_in_use(c, commit=commit)
                    row["enriched"] = e.get("enriched", 0) + e.get("sites", 0)
                    row["errors"] += [str(x)[:300] for x in e.get("errors", [])]
                row["ok"] = not row["errors"]
                return row

            if commit:                                # a dry run takes no lock and leaves no status
                import synclock
                if hub_factory is None:
                    from hub import hub_for as hub_factory
                res, holder = synclock.run_locked(
                    hub_factory(c), gc.account_name or "", "sync all", body,
                    lambda r: {"ok": r["ok"], "count": r["count"], "added": r["added"], "updated": r["updated"],
                               "deduped": r["deduped"], "enriched": r["enriched"], "errors": r["errors"][:3]})
                if holder is not None:
                    row["skipped"] = True
                    row["errors"].append("Skipped: another sync is already running (" + (holder.get("by") or "someone") +
                                         ((" on " + holder["machine"]) if holder.get("machine") else "") + ").")
                    continue
            else:
                body()
            if commit:
                c.add_log("Sync (all divisions)", "", "", actor=gc.account_name or "",
                          details=f"{row['count']} devices seen; +{row['added']} ~{row['updated']} dedupe {row['deduped']} "
                                  f"enriched {row['enriched']}; {len(row['errors'])} error(s)")
        except Exception as e:
            row["errors"].append(str(e)[:300])
    return {"ok": bool(out) and all(r["ok"] for r in out), "divisions": out}


def main_enrich(gc, commit: bool) -> None:
    """python sync.py --enrich [--commit] [--cap N]: fill blank user/site/specs/warranty/MFA on In Use rows."""
    cap = None
    if "--cap" in sys.argv:
        try:
            cap = int(sys.argv[sys.argv.index("--cap") + 1])
        except (IndexError, ValueError):
            print("--cap needs a number")
            return
    r = enrich_in_use(gc, commit=commit, cap=cap)
    print(f"\n{'COMMITTED' if commit else 'DRY RUN'} enrich ({gc.division['id']}): "
          f"specs/warranty for {r['enriched']} device(s), user for {r['users']}, site for {r['sites']}, "
          f"MFA for {r['mfas']}; {r['remaining']} specs still pending (vendor calls are capped per run: --cap N).")
    for e in r["errors"][:5]:
        print(f"  !! {str(e)[:300]}")
    if len(r["errors"]) > 5:
        print(f"  ... and {len(r['errors']) - 5} more error(s)")
    if not commit:
        print("\nRe-run with --commit to apply.")


def main() -> None:
    commit = "--commit" in sys.argv
    gc = GraphClient()
    gc.sign_in(interactive=True)
    if "--division" in sys.argv:          # python sync.py --division nbgtx [--enrich] [--commit]
        want = sys.argv[sys.argv.index("--division") + 1] if sys.argv.index("--division") + 1 < len(sys.argv) else ""
        gc.refresh_registry(force=True)
        gc.set_division(want, persist=False)
        if gc.division["id"] != want:
            print(f"Unknown division '{want}'. Known: {', '.join(d['id'] for d in gc.registry)}")
            return
    if "--enrich" in sys.argv:
        return main_enrich(gc, commit)
    result = run_sync(gc, commit=commit)

    print(f"\n{'COMMITTED' if commit else 'DRY RUN'} - saw {result['count']} {gc.division['intune_category']} device(s) in Intune; "
          f"{len(result['moved'])} {'added' if commit else 'would be added'} to In Use, "
          f"{result['updated']} {'updated' if commit else 'would update'}.")
    for m in result["moved"]:
        print(f"  + {m['serial']:<18} {m['manufacturer']} {m['model']}  {m['user']}")
    for e in result["errors"][:5]:
        print(f"  !! {str(e)[:400]}")
    if len(result["errors"]) > 5:
        print(f"  ... and {len(result['errors']) - 5} more error(s)")
    if not commit and (result["moved"] or result["updated"]):
        print("\nRe-run with --commit to apply.")


if __name__ == "__main__":
    main()

# Unattended note: a desktop app cannot own the nightly run. For "full replace",
# host this in a timer-triggered Azure Function using a Managed Identity (app-only
# Graph, no stored secret) so it runs without a signed-in user. As a stopgap it
# can run via Windows Task Scheduler on one always-on PC, but that reintroduces
# single-machine fragility and is not the target state.
