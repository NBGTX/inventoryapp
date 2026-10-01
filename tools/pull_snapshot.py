"""Pull a READ-ONLY snapshot of production into the local sandbox - without launching the app.

Why: launching the app runs sync with commit on against whatever data mode is active
(default: Live = production). Use this first, then --switch-local so the next app launch
writes only to this PC.

Reads : the division's SharePoint lists (old per-division site) and its hub folder.
Writes: only the local sandbox under %LOCALAPPDATA%\\NBG Hub\\local\\<division>\\.
        Nothing is written to SharePoint or the shared hub folder.

Usage (project root, same Python as the app):
    python tools\\pull_snapshot.py                  # snapshot division nbgw
    python tools\\pull_snapshot.py --switch-local   # ...and make the app start in Local data mode
    python tools\\pull_snapshot.py --division nbgtx
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--division", default="nbgw")
    ap.add_argument("--hub-only", action="store_true",
                    help="copy only the hub JSON folder (no SharePoint / sign-in needed)")
    ap.add_argument("--switch-local", action="store_true", help="afterwards set the app's data mode to Local")
    args = ap.parse_args()

    import graph

    gc = graph.GraphClient()
    gc.set_division(args.division)
    gc.data_mode = "live"            # read production for the snapshot
    if args.hub_only:
        r = gc.snapshot_hub()
        print("Hub folder copied (no SharePoint access used).")
        print("  from:", r["source"])
        print("  to  :", r["dest"], f"({r['files']} files)")
        return 0
    print(f"Division: {gc.division['id']}  ({gc.division['name']})")
    print("Source  :", gc.division.get("sharepoint_hostname"), gc.division.get("site_path"), "(read-only)")
    print("Signing in (a Microsoft sign-in window will open) ...")
    gc.sign_in(interactive=True)
    print("Pulling read-only snapshot ...")
    info = gc.snapshot_prod()
    print("Counts  :", info["counts"])
    print("Taken   :", info["taken_at"], " by", info["taken_by"] or "(unknown)")
    print("Saved to:", info["path"])
    if args.switch_local:
        gc.set_data_mode("local")
        print("Data mode set to LOCAL: the app will start on the local copy.")
    else:
        print("Data mode unchanged (the app still starts Live). Re-run with --switch-local to change it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
