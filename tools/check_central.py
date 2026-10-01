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

# list key -> {display name: expectation}. 'text' = single line, 'note' = multiple lines (plain),
# 'any' = text or number or yes/no accepted by the app (Rev, Enabled).
DEV = {"Division": "text*", "Manufacturer": "text", "Model": "text", "Site Tag": "text", "CPU": "text",
       "Memory (RAM)": "text", "Storage": "text", "Warranty Expiration": "text"}
SPEC = {
    "divisions": {"Display Name": "text", "Company Name": "text", "Intune Category": "text", "SharePoint Host": "text",
                  "Site Path": "text", "AD Domain": "text", "SQL Server": "text", "Sites JSON": "note",
                  "Access JSON": "note", "Enabled": "any"},
    "new_stock": {**DEV, "Status": "text", "Date Added": "text"},
    "in_use": {**DEV, "Device Name": "text", "Primary User": "text", "OS Version": "text", "OS Install Date": "text",
               "Last Sign In": "text", "MFA": "text"},
    "model_specs": {"CPU": "text", "Memory (RAM)": "text"},
    "log": {"Division": "text*", "Action": "text", "Serial": "text", "Model": "text", "Actor": "text",
            "Details": "note", "LoggedAt": "text"},
    "hub_items": {"Division": "text*", "Kind": "text*", "Item Id": "text", "Payload": "note", "Rev": "any"},
    "master_settings": {"Value": "note", "Secret": "text", "Description": "text"},
}
# 'text*' = single-line text AND must be indexed


def kind_of(col: dict) -> str:
    for k in ("text", "number", "dateTime", "boolean", "choice", "lookup", "currency", "personOrGroup"):
        if k in col:
            if k == "text":
                return "note" if col["text"].get("allowMultipleLines") else "text"
            return k
    return "other"


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
    site = gc._ensure_site()
    problems = 0
    for key, spec in SPEC.items():
        name = gc.cfg["lists"][key]
        try:
            lid = gc._list_id(key)
        except Exception:
            print(f"[MISSING LIST] {name}")
            problems += 1
            continue
        cols = gc._get_all(f"{GRAPH}/sites/{site}/lists/{lid}/columns")
        by = {str(c.get("displayName") or "").strip().lower(): c for c in cols}
        notes = []
        for disp, want in spec.items():
            c = by.get(disp.lower())
            if not c:
                notes.append(f"missing column '{disp}'")
                continue
            have = kind_of(c)
            w = want.rstrip("*")
            if w == "any":
                if have not in ("text", "number", "boolean"):
                    notes.append(f"'{disp}' is {have}; use Single line of text")
            elif have != w:
                fix = {"text": "Single line of text", "note": "Multiple lines of text (plain text)"}[w]
                notes.append(f"'{disp}' is {have}; change to {fix}")
            if want.endswith("*") and not c.get("indexed"):
                notes.append(f"'{disp}' is not indexed (List settings > Indexed columns)")
        if notes:
            problems += len(notes)
            print(f"[FIX ] {name}")
            for n in notes:
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
