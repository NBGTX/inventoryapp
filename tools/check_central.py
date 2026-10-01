"""Check the central SharePoint lists against what the app expects (read-only).

SharePoint's "New list from Excel" guesses column types. A guessed Number/Date column makes every
text write fail with "400 badArgument" (the sync then adds 0 rows). This tool lists, per list:
  - missing columns (by display name),
  - columns of the wrong type (with the exact fix),
  - missing indexes on Division / Kind.

    python tools\\check_central.py

Reads only. Exit code 1 when something needs fixing.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def main() -> int:
    import graph
    from graph import GRAPH

    gc = graph.GraphClient()
    gc.set_division("nbgw", persist=False)
    gc.data_mode = "live"
    if not gc._central:
        print('config.json has no "central" block.')
        return 2
    gc.sign_in(interactive=True)
    print(f"Signed in as {gc.account_upn}; central site {gc.cfg['site_path']}\n")
    import schema
    found = schema.problems(gc)
    problems = sum(len(v) for v in found.values())
    for key in schema.SPEC:
        name = gc.cfg["lists"][key]
        if name in found:
            print(f"[FIX ] {name}")
            for n in found[name]:
                print("        -", n)
        else:
            print(f"[ OK ] {name}")
    print()
    if problems:
        print(f"{problems} problem(s). Fix in SharePoint: open the list > gear > List settings > click the column name >")
        print("change 'Column type' (a Number/Date column converts to text; an empty list loses nothing).")
        return 1
    print("All central lists match what the app expects.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
