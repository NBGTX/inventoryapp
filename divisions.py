"""Division (tenant) registry: everything that used to be hardcoded for NBGW.

Source today: `divisions` list in config.json. If absent, one division ("nbgw") is
synthesized from the legacy config keys + defaults, so existing installs behave
exactly as before. Later the same shape can be loaded from a central SharePoint list.

Division keys:
  id, name, company_name (Entra companyName), intune_category, sharepoint_hostname,
  site_path, lists, ad_domain, sql_server, timesheet_db, timesheet_table, employee_db, employee_table,
  legacy_data (True = keep the original
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
    "timesheet_db": "NBSTimesheet", "timesheet_table": "dbo.WeekLocked",
    "employee_db": "NBSEmployeeInfo", "employee_table": "dbo.SAP_Interface",
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
    d["sites"] = clean_sites(d.get("sites"), d.get("company_name"), d.get("intune_category"))
    return d


_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,19}$")
_CODE_RE = re.compile(r"^[A-Z0-9]{2,6}$")


def valid_id(div_id) -> bool:
    return bool(_ID_RE.match(str(div_id or "")))


def clean_sites(sites, company_name="", intune_category="") -> list[dict]:
    """Keep only well-formed sites. A code ends up in HTML attributes and CSS classes, so anything
    that is not 2-6 letters/digits is dropped (the registry can be edited by many people)."""
    out, seen = [], set()
    for s in sites if isinstance(sites, list) else []:
        if not isinstance(s, dict):
            continue
        code = str(s.get("code") or "").strip().upper()
        if not _CODE_RE.match(code) or code == "OTHER" or code in seen:
            continue
        seen.add(code)
        lst = lambda v: [str(x).strip() for x in (v or []) if str(x).strip()] if isinstance(v, list) else []
        companies = lst(s.get("company_names")) if isinstance(s.get("company_names"), list) else ([str(company_name).strip()] if company_name else [])
        categories = lst(s.get("intune_categories")) if isinstance(s.get("intune_categories"), list) else ([str(intune_category).strip()] if intune_category else [])
        out.append({"code": code, "name": str(s.get("name") or code).strip(),
                    "city_prefixes": lst(s.get("city_prefixes")), "device_prefixes": lst(s.get("device_prefixes")),
                    "company_names": companies, "intune_categories": categories})
    return out


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
        if not valid_id(d["id"]):
            continue
        d["sites"] = clean_sites(d.get("sites"), d.get("company_name"), d.get("intune_category"))
        companies = company_names(d)
        categories = intune_categories(d)
        if companies:
            d["company_name"] = companies[0]
        if categories:
            d["intune_category"] = categories[0]
        out.append(d)
    return out or [_legacy(cfg)]


def find(registry: list[dict], div_id: str | None) -> dict:
    for d in registry:
        if d["id"] == div_id:
            return d
    return registry[0]


def public(d: dict) -> dict:
    """Division fields safe/useful to send to the UI."""
    companies = company_names(d)
    categories = intune_categories(d)
    return {"id": d["id"], "name": d["name"], "company_name": (companies[0] if companies else d.get("company_name", "")),
            "company_names": companies, "intune_category": (categories[0] if categories else d.get("intune_category", "")),
            "intune_categories": categories,
            "ad_domain": d.get("ad_domain", ""), "has_timesheet": all(d.get(k) for k in ("sql_server", "timesheet_db", "timesheet_table", "employee_db", "employee_table")),
            "sites": [{"code": s["code"], "name": s.get("name", s["code"]),
                       "company_names": list(s.get("company_names") or []),
                       "intune_categories": list(s.get("intune_categories") or [])} for s in d.get("sites", [])]}


def company_names(d: dict) -> list[str]:
    """Unique Entra companyName values assigned across division sites."""
    values = []
    for site in d.get("sites", []):
        for value in site.get("company_names", []):
            value = str(value or "").strip()
            if value and value.casefold() not in {x.casefold() for x in values}:
                values.append(value)
    if not values and d.get("company_name"):
        values.append(str(d["company_name"]).strip())
    return values


def intune_categories(d: dict) -> list[str]:
    """Unique Intune device categories assigned across division sites."""
    values = []
    for site in d.get("sites", []):
        for value in site.get("intune_categories", []):
            value = str(value or "").strip()
            if value and value.casefold() not in {x.casefold() for x in values}:
                values.append(value)
    if not values and d.get("intune_category"):
        values.append(str(d["intune_category"]).strip())
    return values


def site_codes(d: dict) -> list[str]:
    return [s["code"].upper() for s in d.get("sites", [])]


def _only_site(d: dict) -> str:
    """A division with exactly ONE site puts every device and person there, whatever the name or city says."""
    sites = d.get("sites", [])
    return sites[0]["code"].upper() if len(sites) == 1 else ""


def site_from_name(d: dict, device_name: str) -> str:
    n = (device_name or "").upper()
    for s in d.get("sites", []):
        if any(n.startswith(p.upper()) for p in s.get("device_prefixes", [])):
            return s["code"].upper()
    return _only_site(d)


def city_to_site(d: dict, city: str) -> str:
    c = (city or "").strip().lower()
    for s in d.get("sites", []):
        if any(c.startswith(p.lower()) for p in s.get("city_prefixes", [])):
            return s["code"].upper()
    return _only_site(d)


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


# ---- access-list entries -----------------------------------------------------
# A division's access list holds strings: "a@x.com", "group:<id>|<name>", "*" (everyone), and the same
# with an "admin:" prefix to make that person/group a division admin ("admin:a@x.com").
def acl_entry(a) -> str:
    """Normalised entry ('' if empty): emails lowercased, group display names keep their case."""
    a = str(a or "").strip()
    admin = a.lower().startswith("admin:")
    if admin:
        a = a[6:].strip()
    if not a:
        return ""
    if a == "*":
        return "*"                                   # "everyone" is never an admin role
    a = a if a.lower().startswith("group:") else a.lower()
    return "admin:" + a if admin else a


def acl_parts(e) -> tuple:
    """(is_admin, body) of a normalised entry."""
    e = str(e or "")
    if e.lower().startswith("admin:"):
        return True, e[6:]
    return False, e
