"""Load a division's local snapshot into the CENTRAL SharePoint lists.

Source : the local snapshot (Data: Live -> pull a snapshot in the app first). The snapshot is a
         read-only copy of the old per-division site, so this never touches the old site.
Target : the central site (config.json "central") - New Stock, In Use, Model Specs, Activity Log.
         Rows are stamped with Division. Hub JSON is NOT loaded here (needs the Hub Items swap).

DRY RUN by default (reads the central lists, prints what it would add / skip).
Writes only with --commit. Idempotent: rows already in the central list for this division
(devices by serial, model specs by model, log rows by when+action+serial) are skipped.
--wipe first DELETES this division's existing rows from the target lists (use for test data).

Usage (from the project root, same Python as the app):
    python tools\\load_central.py                       # dry run, division nbgw
    python tools\\load_central.py --commit              # load
    python tools\\load_central.py --commit --wipe       # clear this division's central rows, then load
One audit entry is written per committed run.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BATCH = 20   # Graph $batch limit
KEYS = ("new_stock", "in_use", "model_specs", "log")
LOGICAL_SKIP = {"division"}


def _src_internal(colmap: dict, aliases: list[str]) -> str | None:
    """Same matching as GraphClient._internal_for, against the SNAPSHOT's column map."""
    for a in aliases:
        if a in colmap:
            return colmap[a]
    for disp, intern in colmap.items():
        if any(a in disp for a in aliases):
            return intern
    return None


def _to_logical(item: dict, colmap: dict, aliases_by_logical: dict) -> dict:
    """Snapshot item -> {logical field: value}. Title is the serial / model name."""
    f = item.get("fields", {}) or {}
    out = {"serial": f.get("Title") or ""}
    for logical, aliases in aliases_by_logical.items():
        if logical in LOGICAL_SKIP or logical == "serial":
            continue
        col = _src_internal(colmap, aliases)
        if col and f.get(col) not in (None, ""):
            out[logical] = f.get(col)
    return out


def _log_fields(item: dict) -> dict:
    f = item.get("fields", {}) or {}
    keep = ("Title", "Action", "Serial", "Model", "Actor", "Details", "LoggedAt")
    return {k: f[k] for k in keep if f.get(k) not in (None, "")}


def _key_of(key: str, fields: dict) -> str:
    if key == "log":
        return "|".join(str(fields.get(k, "")).strip().lower() for k in ("LoggedAt", "Action", "Serial"))
    return str(fields.get("Title", "")).strip().lower()


def plan(gc, store, division_id: str) -> dict:
    """Build the load plan. Reads the central lists only. Returns
    {key: {"add": [fields...], "skip": n, "existing": [item ids of this division]}}."""
    import graph
    out = {}
    for key in KEYS:
        src = store.items(key)
        existing = gc._items_raw(key)     # division-filtered for new_stock / in_use / log
        have = {}
        for it in existing:
            have[_key_of(key, it.get("fields", {}) or {})] = it.get("id")
        add, skip = [], 0
        colmap = store.colmap(key)
        for item in src:
            if key == "log":
                fields = _log_fields(item)
            else:
                logical = _to_logical(item, colmap, graph.FIELD_ALIASES)
                fields = gc._fields_for(key, logical)
                fields.setdefault("Title", logical.get("serial", ""))
            if not fields.get("Title"):
                skip += 1
                continue
            if _key_of(key, fields) in have:
                skip += 1
            else:
                add.append(fields)
        out[key] = {"add": add, "skip": skip, "existing": list(have.values())}
    return out


def _batch_post(gc, key: str, rows: list[dict]) -> int:
    import graph
    site = gc._ensure_site()
    lid = gc._ensure_log_list() if key == "log" else gc._list_id(key)
    div_col = (gc._internal_for(key, "division") or "Division") if key in ("new_stock", "in_use", "log") else None
    failed = 0
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        reqs = []
        for n, fields in enumerate(chunk):
            f = dict(fields)
            if div_col:
                f[div_col] = gc.division["id"]
            reqs.append({"id": str(n), "method": "POST", "url": f"/sites/{site}/lists/{lid}/items",
                         "headers": {"Content-Type": "application/json"}, "body": {"fields": f}})
        for attempt in range(4):
            resp = gc._req("POST", f"{graph.GRAPH}/$batch", json={"requests": reqs}).json()
            bad = [r for r in resp.get("responses", []) if r.get("status", 500) >= 300]
            retry = [reqs[int(r["id"])] for r in bad if r.get("status") in (429, 503, 504)]
            failed_now = len(bad) - len(retry)
            if not retry:
                failed += failed_now
                break
            failed += failed_now
            reqs = retry
            time.sleep(2 * (attempt + 1))
        else:
            failed += len(reqs)
        print(f"    {key}: {min(i + BATCH, len(rows))}/{len(rows)}", end="\r")
    print()
    return failed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--division", default="nbgw")
    ap.add_argument("--commit", action="store_true", help="actually write (default: dry run)")
    ap.add_argument("--wipe", action="store_true", help="with --commit: delete this division's central rows first")
    args = ap.parse_args()

    import graph
    import localstore

    gc = graph.GraphClient()
    if not gc._base_cfg.get("central", {}).get("site_path"):
        print('config.json has no "central" block (site_host / site_path). Add it first.')
        return 2
    gc.set_division(args.division)
    gc.data_mode = "live"           # target = central lists, never the local sandbox
    gc._reset_caches()
    store = localstore.LocalStore(args.division)
    if not store.has_snapshot():
        print("No local snapshot for this division. In the app: Data: Live -> pull a fresh copy.")
        return 2
    info = store.info()
    print(f"Division : {gc.division['id']}  ({gc.division['name']})")
    print(f"Snapshot : taken {info['taken_at']}  counts {info['counts']}")
    print(f"Target   : {gc.cfg['sharepoint_hostname']}{gc.cfg['site_path']}")
    print("Mode     :", "COMMIT" + (" + WIPE" if args.wipe else "") if args.commit else "DRY RUN (nothing is written)")
    print("Signing in ...")
    gc.sign_in(interactive=True)

    p = plan(gc, store, args.division)
    print()
    for key in KEYS:
        print(f"  {key:12} add {len(p[key]['add']):6}   already there/skip {p[key]['skip']:6}   "
              f"existing rows for division {len(p[key]['existing']):6}")
    if not args.commit:
        print("\nDry run only. Re-run with --commit to load.")
        return 0

    if args.wipe:
        print("\nWiping this division's existing central rows ...")
        for key in KEYS:
            if key == "model_specs":
                continue            # shared list: never wipe
            for iid in p[key]["existing"]:
                gc.delete_item(key, iid)
        p = plan(gc, store, args.division)      # re-plan against the now-empty division
    failed = 0
    for key in KEYS:
        if p[key]["add"]:
            print(f"  loading {key} ...")
            failed += _batch_post(gc, key, p[key]["add"])
    total = sum(len(p[k]["add"]) for k in KEYS)
    gc.add_log("Central load", "", "", actor=gc.account_name or "",
               details=f"division={args.division} added={total} failed={failed} wipe={args.wipe}")
    print(f"\nDone. Added {total - failed}, failed {failed}.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
