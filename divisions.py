"""Division (tenant) registry: everything that used to be hardcoded for NBGW.

Source today: `divisions` list in config.json. If absent, one division ("nbgw") is
synthesized from the legacy config keys + defaults, so existing installs behave
exactly as before. Later the same shape can be loaded from a central SharePoint list.

Division keys:
  id, name, company_name (Entra companyName), intune_category, sharepoint_hostname,
  site_path, lists, ad_domain, sql_server, legacy_data (True = keep the original
  _EndpointHub folder), sites: [{code, name, city_prefixes[], device_prefixes[]}]
"""
from __future__ import annotations

import copy
import os
import re

DEFAULT_ID = "nbgw"

_NBGW_DEFAULT = {
    "id": "nbgw",
    "name": "NBGW - Nucor Buildings Group West",
    "company_name": "Nucor Buildings Group West",
    "intune_category": "NBGW",
    "sharepoint_hostname": "nucor.sharepoint.com",
    "site_path": "/sites/NBGW/systems",
    "lists": {},
    "ad_domain": "bg.nucorsteel.local",
    "sql_server": "BGBRISQL07",
    "legacy_data": True,
    "sites": [
        {"code": "LTR", "name": "Lathrop, CA", "city_prefixes": ["lathrop"],
         "device_prefixes": ["BGLTR", "BGCCN", "BGMOD"]},
        {"code": "BRI", "name": "Brigham City, UT", "city_prefixes": ["brigham"],
         "device_prefixes": ["BGBRI"]},
    ],
}


def _legacy(cfg: dict) -> dict:
    """NBGW division built from the old flat config.json keys."""
    d = copy.deepcopy(_NBGW_DEFAULT)
    for src, dst in (("sharepoint_hostname", "sharepoint_hostname"), ("site_path", "site_path"),
                     ("lists", "lists"), ("intune_device_category", "intune_category"),
                     ("ad_domain", "ad_domain"), ("timesheet_sql_server", "sql_server")):
        if cfg.get(src):
            d[dst] = cfg[src]
    return d


def load_registry(cfg: dict) -> list[dict]:
    divs = cfg.get("divisions")
    if not isinstance(divs, list) or not divs:
        return [_legacy(cfg)]
    out = []
    for raw in divs:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        d = copy.deepcopy(_NBGW_DEFAULT if raw["id"] == DEFAULT_ID else {})
        d.update(raw)
        d.setdefault("name", d["id"])
        d.setdefault("company_name", d["name"])
        d.setdefault("lists", {})
        d.setdefault("sites", [])
        d.setdefault("legacy_data", False)
        out.append(d)
    return out or [_legacy(cfg)]


def find(registry: list[dict], div_id: str | None) -> dict:
    for d in registry:
        if d["id"] == div_id:
            return d
    return registry[0]


def public(d: dict) -> dict:
    """Division fields safe/useful to send to the UI."""
    return {"id": d["id"], "name": d["name"], "company_name": d["company_name"],
            "sites": [{"code": s["code"], "name": s.get("name", s["code"])} for s in d.get("sites", [])]}


def site_codes(d: dict) -> list[str]:
    return [s["code"].upper() for s in d.get("sites", [])]


def site_from_name(d: dict, device_name: str) -> str:
    n = (device_name or "").upper()
    for s in d.get("sites", []):
        if any(n.startswith(p.upper()) for p in s.get("device_prefixes", [])):
            return s["code"].upper()
    return ""


def city_to_site(d: dict, city: str) -> str:
    c = (city or "").strip().lower()
    for s in d.get("sites", []):
        if any(c.startswith(p.lower()) for p in s.get("city_prefixes", [])):
            return s["code"].upper()
    return ""


def site_bucket(d: dict, site: str) -> str:
    """A site code if it belongs to the division, else "Other"."""
    s = (site or "").strip().upper()
    return s if s in site_codes(d) else "Other"


def hub_folder_name(d: dict) -> str:
    if d.get("legacy_data"):
        return "_EndpointHub"
    return "_EndpointHub_" + re.sub(r"[^A-Za-z0-9_-]", "_", d["id"])


# ---- per-user selection (local to the machine; not shared) -------------------
def _sel_path() -> str:
    import paths
    base = paths.user_dir()
    return os.path.join(base, "division.txt")


def load_selection() -> str | None:
    try:
        with open(_sel_path(), encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def save_selection(div_id: str) -> None:
    try:
        os.makedirs(os.path.dirname(_sel_path()), exist_ok=True)
        with open(_sel_path(), "w", encoding="utf-8") as f:
            f.write(div_id)
    except OSError:
        pass
