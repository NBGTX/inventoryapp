"""Who am I, and what can this account reach? (read-only)

The app signs in as whatever account you pick. If you have a normal account and an admin account
(for example adm.<name>.azure@nucor.onmicrosoft.com) only one may hold the Intune role / NBGW site
access. This tool shows which account is cached and tests each resource the app needs.

    python tools\\signin.py               # check the cached account
    python tools\\signin.py --switch      # sign out, pick another account in the browser, then check

Reads only: counts and HTTP status. Prints no tokens and no device/user data.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def check(label: str, fn) -> bool:
    try:
        detail = fn()
        print(f"  [ OK ] {label}" + (f"  ({detail})" if detail else ""))
        return True
    except Exception as e:                      # GraphError text already explains 403/401
        msg = str(e).replace("\n", " ")
        print(f"  [FAIL] {label}  -> {msg[:170]}")
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--switch", action="store_true", help="sign out first and choose another account")
    ap.add_argument("--division", default="nbgw")
    args = ap.parse_args()

    import graph
    from graph import GRAPH

    gc = graph.GraphClient()
    gc.set_division(args.division, persist=False)
    gc.data_mode = "live"
    if args.switch:
        gc.sign_out()
        print("Signed out. A browser window opens: choose the account you want to use.")
    gc.sign_in(interactive=True)
    print(f"\nSigned in as: {gc.account_upn}  ({gc.account_name})")
    print(f"Super admin in this app: {gc.is_super_admin()}")
    try:
        gc.refresh_registry(force=True)
        vis = [d["id"] for d in gc.visible_registry()]
        print("Divisions this account can see:", ", ".join(vis) or "(none)", "  of", len(gc.registry), "total")
    except Exception as e:
        print("Could not read divisions:", str(e)[:120])
    print()

    central = gc._base_cfg.get("central") or {}
    if central.get("site_path"):
        def central_site():
            gc._get(f"{GRAPH}/sites/{central.get('site_host') or 'nucor.sharepoint.com'}:{central['site_path']}")
            return central["site_path"]
        check("Central site (NBG Hub Data) readable", central_site)

        def central_write():
            gc._use_legacy = False
            gc._apply_division()
            return f"{len(gc._items_raw('divisions'))} Divisions row(s)"
        check("Central Divisions list readable", central_write)

    snap = gc.clone_for_snapshot()
    snap.data_mode = "live"        # never the local sandbox: this check must hit the real site
    snap._use_legacy = True
    snap._apply_division()
    snap._reset_caches()

    def legacy_lists():
        parts = []
        for key in ("new_stock", "in_use"):
            parts.append(f"{key} {len(snap._items_raw(key))}")
        return f"{snap.cfg['site_path']}: " + ", ".join(parts)
    check("Old NBGW site lists readable (needed for the snapshot)", legacy_lists)

    def intune():
        gc._get(f"{GRAPH}/deviceManagement/managedDevices?$top=1&$select=id")
        return "managed devices readable"
    check("Intune managed devices readable", intune)

    print("\nIf Intune / old-site checks fail here but you know an admin account has the role,")
    print("run:  python tools\\signin.py --switch   and pick the admin account.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
