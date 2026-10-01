"""Expected shape of the central SharePoint lists, and a checker.

SharePoint's "New list from Excel" guesses column types; a Number/Date column makes every text write
fail with "400 badArgument". The sync calls problems() before it writes, and tools/check_central.py
prints the same findings with fixes.
"""
from __future__ import annotations

DEV = {"Division": "text*", "Manufacturer": "text", "Model": "text", "Site Tag": "text", "CPU": "text",
       "Memory (RAM)": "text", "Storage": "text", "Warranty Expiration": "text"}

# list key -> {display name: expectation}
#   text   = single line of text          text*  = single line of text AND indexed
#   note   = multiple lines (plain text)  any    = text, number or yes/no (Rev, Enabled)
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
FIX_TEXT = {"text": "Single line of text", "note": "Multiple lines of text (plain text)"}


def kind_of(col: dict) -> str:
    for k in ("text", "number", "dateTime", "boolean", "choice", "lookup", "currency", "personOrGroup"):
        if k in col:
            if k == "text":
                return "note" if col["text"].get("allowMultipleLines") else "text"
            return k
    return "other"


def list_problems(columns: list, spec: dict) -> list:
    """Notes for one list given its Graph column definitions."""
    by = {str(c.get("displayName") or "").strip().lower(): c for c in columns}
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
            notes.append(f"'{disp}' is {have}; change to {FIX_TEXT[w]}")
        if want.endswith("*") and not c.get("indexed"):
            notes.append(f"'{disp}' is not indexed (List settings > Indexed columns)")
    return notes


def problems(gc, keys=None) -> dict:
    """{list display name: [notes]} for the lists in `keys` (default: all). Missing list -> note."""
    from graph import GRAPH
    out = {}
    site = gc._ensure_site()
    for key in (keys or SPEC):
        name = gc.cfg["lists"].get(key, key)
        try:
            lid = gc._list_id(key)
        except Exception:
            out[name] = ["list not found"]
            continue
        notes = list_problems(gc._get_all(f"{GRAPH}/sites/{site}/lists/{lid}/columns"), SPEC[key])
        if notes:
            out[name] = notes
    return out
