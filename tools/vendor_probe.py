"""Try a vendor warranty lookup by hand (read-only; one HTTPS call to the vendor, nothing is written anywhere).

    python tools/vendor_probe.py dell <service-tag>
    python tools/vendor_probe.py hp <serial>
    python tools/vendor_probe.py lenovo <serial>

Uses the keys saved in Master Settings (needs a super-admin sign-in that can read them). Prints what the app would
use (model, warranty end date) and, for HP, the SHAPE of the raw response (key names only, no values) so the parser
can be adjusted if HP's layout differs. Keys are never printed.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def shape(node, depth=0):
    pad = "  " * depth
    if isinstance(node, dict):
        for k, v in node.items():
            kind = type(v).__name__
            print(f"{pad}{k}: {kind}")
            if isinstance(v, (dict, list)) and depth < 4:
                shape(v, depth + 1)
    elif isinstance(node, list) and node:
        print(f"{pad}[list of {len(node)}] first item:")
        shape(node[0], depth + 1)


def main(argv) -> int:
    if len(argv) != 3 or argv[1] not in ("dell", "hp", "lenovo"):
        print(__doc__)
        return 2
    vendor, serial = argv[1], argv[2]
    import graph
    import vendors
    gc = graph.GraphClient()
    gc.sign_in(interactive=False)
    gc.refresh_registry(force=True)
    have = {k: bool(gc.get_setting(k)) for k in ("dell_client_id", "dell_client_secret", "hp_client_id", "hp_client_secret", "lenovo_client_id")}
    print("keys present:", {k: v for k, v in have.items() if k.startswith(vendor)})
    out = {"dell": gc.lookup_dell, "hp": gc.lookup_hp, "lenovo": gc.lookup_lenovo}[vendor](serial)
    print("app would use:", out)
    if vendor == "hp" and gc.get_setting("hp_client_id"):
        import requests
        try:
            vendors.clear_tokens()
            t = requests.post(vendors.HP_TOKEN_URL, json={"apiKey": gc.get_setting("hp_client_id"), "apiSecret": gc.get_setting("hp_client_secret"),
                                                          "grantType": "client_credentials", "scope": "warranty"}, timeout=20)
            print("token request:", t.status_code)
            tok = (t.json() or {}).get("access_token") or (t.json() or {}).get("accessToken") if t.ok else ""
            if tok:
                r = requests.post(vendors.HP_QUERIES_URL, json=[{"sn": serial}], headers={"Authorization": f"Bearer {tok}"}, timeout=30)
                print("queries request:", r.status_code)
                if r.ok:
                    print("response shape:")
                    shape(r.json())
        except Exception as e:
            print("probe error:", type(e).__name__)
    return 0 if out else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
