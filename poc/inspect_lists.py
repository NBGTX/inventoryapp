#!/usr/bin/env python3
"""
Diagnostic: dump each list's columns (display name -> internal name) and one
sample item's raw fields. Run this if a field (e.g. the assigned user) shows
blank in the app, so we can see the real column names/values.

    python poc\\inspect_lists.py
"""
import os
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from graph import GRAPH, GraphClient  # noqa: E402

gc = GraphClient()
gc.sign_in(interactive=True)
site = gc._ensure_site()

for key in ("new_stock", "in_use", "model_specs"):
    print(f"\n===== {key} =====")
    try:
        lid = gc._list_id(key)
    except Exception as e:
        print(f"  (could not resolve list: {e})")
        continue
    cols = gc._get_all(f"{GRAPH}/sites/{site}/lists/{lid}/columns?$select=name,displayName")
    print("  COLUMNS  (displayName -> internal name):")
    for c in cols:
        print(f"    {str(c.get('displayName')):32} -> {c.get('name')}")
    items = gc._get_all(f"{GRAPH}/sites/{site}/lists/{lid}/items?expand=fields&$top=1")
    if items:
        print("  SAMPLE ITEM fields:")
        for k, v in items[0].get("fields", {}).items():
            print(f"    {k:32} = {v!r}")
    else:
        print("  (no items)")

print("\nDone.")
