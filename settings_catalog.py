"""Known settings, so the Settings screens can offer forms instead of free text.

CATALOG: master settings the app understands (stored in Inventory - Master Settings).
TIMEZONES: IANA zones offered for divisions (the UI shows a dropdown, never free text).
"""
from __future__ import annotations

TIMEZONES = [
    ("America/New_York", "Eastern (US & Canada)"),
    ("America/Chicago", "Central (US & Canada)"),
    ("America/Denver", "Mountain (US & Canada)"),
    ("America/Phoenix", "Arizona (no daylight saving)"),
    ("America/Los_Angeles", "Pacific (US & Canada)"),
    ("America/Anchorage", "Alaska"),
    ("Pacific/Honolulu", "Hawaii"),
    ("America/Halifax", "Atlantic (Canada)"),
    ("America/Mexico_City", "Central Mexico"),
    ("UTC", "UTC"),
]
_TZ_IDS = {z for z, _ in TIMEZONES}


def valid_timezone(tz: str) -> bool:
    return tz in _TZ_IDS


PROJECT_HUB_DEFAULT = "https://projecthub-dev.nucorservices.com/"


def clean_url(v) -> str:
    """'' (= use the default) or a tidy https:// address. Raises ValueError for anything else."""
    from urllib.parse import urlparse
    v = str(v or "").strip()
    if not v:
        return ""
    if len(v) > 300:
        raise ValueError("That address is too long.")
    u = urlparse(v if "://" in v else "https://" + v)
    if u.scheme != "https" or not u.hostname or "." not in u.hostname or u.username or u.password or any(c.isspace() for c in v):
        raise ValueError("Enter a web address starting with https:// (no spaces, no user name or password).")
    return u.geturl()


def zones() -> list:
    return [{"id": z, "label": label} for z, label in TIMEZONES]


# kind: secret (hidden, replace-only) | text | choice (options) | number
CATALOG = [
    {"key": "lenovo_client_id", "group": "Vendor APIs", "label": "Lenovo warranty API client ID",
     "kind": "secret", "secret": True, "status": "active",
     "help": "Lets the app look up Lenovo warranty dates and specs by serial number. Stored hidden; "
             "it is never shown again after you save it."},
    {"key": "dell_client_id", "group": "Vendor APIs", "label": "Dell TechDirect client ID",
     "kind": "secret", "secret": True, "status": "active",
     "help": "Dell warranty end date and model by service tag. Get it in Dell TechDirect: register an API app and "
             "authorise it for the Warranty API. Dell gives no CPU/RAM/storage."},
    {"key": "dell_client_secret", "group": "Vendor APIs", "label": "Dell TechDirect client secret",
     "kind": "secret", "secret": True, "status": "active",
     "help": "Pairs with the Dell client ID."},
    {"key": "hp_client_id", "group": "Vendor APIs", "label": "HP warranty API key",
     "kind": "secret", "secret": True, "status": "active",
     "help": "HP warranty end date and model by serial number. Request the key from HP (warrantyapi.customers@hp.com or "
             "your HP account manager). Not yet tested against HP's live service: after saving, run "
             "python tools/vendor_probe.py hp <serial> once."},
    {"key": "hp_client_secret", "group": "Vendor APIs", "label": "HP warranty API secret",
     "kind": "secret", "secret": True, "status": "active",
     "help": "Pairs with the HP key."},
    {"key": "default_timezone", "group": "Regional", "label": "Default time zone",
     "kind": "choice", "secret": False, "options": zones(), "status": "active",
     "help": "Used by every division that has not picked its own time zone. Blank = each PC's own time zone."},
    {"key": "project_hub_url", "group": "Regional", "label": "Default Project Hub address",
     "kind": "url", "secret": False, "status": "active",
     "help": "Where the Project Hub sidebar item opens for divisions that have not set their own address (Settings > General). "
             "Blank = " + PROJECT_HUB_DEFAULT},
    {"key": "intune_enrich_per_sync", "group": "Sync", "label": "Vendor lookups per sync run",
     "kind": "number", "secret": False, "min": 0, "max": 500, "default": 75, "status": "active",
     "help": "How many devices get a Lenovo/Dell/HP spec lookup in one sync. Lower = gentler on vendor APIs, slower to fill in."},
    {"key": "latest_version", "group": "Releases", "label": "Latest released version",
     "kind": "version", "secret": False, "status": "active",
     "help": "The newest NBG Hub build, for example 2026.10.15. Techs on an older build see an 'Update available' notice."},
    {"key": "min_version", "group": "Releases", "label": "Oldest allowed version",
     "kind": "version", "secret": False, "status": "active",
     "help": "Builds older than this show a red 'Update required' notice. Raise it when a release changes how data is stored."},
    {"key": "stale_checkin_days", "group": "Sync", "label": "Flag devices not seen for (days)",
     "kind": "number", "secret": False, "min": 1, "max": 365, "default": 30, "status": "active",
     "help": "Intune devices with no check-in for longer than this are flagged stale."},
]
_BY_KEY = {c["key"]: c for c in CATALOG}


def entry(key: str):
    return _BY_KEY.get(key)


def check_value(key: str, value: str) -> str:
    """Validate a value for a catalog setting; returns the cleaned value or raises ValueError."""
    c = _BY_KEY.get(key)
    v = (value or "").strip()
    if not c:
        return value
    if c["kind"] == "choice" and v and v not in {o["id"] for o in c["options"]}:
        raise ValueError(f"'{v}' is not an allowed value for {c['label']}.")
    if c["kind"] == "url":
        return clean_url(v)
    if c["kind"] == "version":
        import version
        if v and not version.parse(v):
            raise ValueError(f"{c['label']} must look like 2026.10.15 (or 2026.10.15.2).")
        return v
    if c["kind"] == "number":
        if not v:
            return ""                                   # blank = back to the built-in default
        try:
            n = int(v)
        except ValueError:
            raise ValueError(f"{c['label']} must be a whole number.")
        if not c["min"] <= n <= c["max"]:
            raise ValueError(f"{c['label']} must be between {c['min']} and {c['max']}.")
        return str(n)
    return v


def number(gc, key: str) -> int:
    """Current value of a numeric catalog setting (master row > config.json > built-in default)."""
    c = _BY_KEY[key]
    try:
        n = int(str(gc.get_setting(key, "") or "").strip())
        if c["min"] <= n <= c["max"]:
            return n
    except (TypeError, ValueError):
        pass
    return c["default"]


# ---- which Settings sections each division role may open (edited under Platform > Role access) ----
# General is always visible to everyone (read-only for users). Super admins always see everything.
SECTIONS = [("models", "Model departments"), ("links", "NBT Sites"), ("access", "Who has access"), ("sites", "Sites"),
            ("sql", "Directory & SQL"), ("perms", "Group baselines"), ("storage", "Storage")]
ROLE_ACCESS_KEY = "role_access"


def default_role_access() -> dict:
    return {"user": [], "admin": [s for s, _ in SECTIONS]}


def parse_role_access(raw) -> dict:
    """JSON from the Master Settings row -> {"user": [...], "admin": [...]} (unknown ids dropped; bad/missing -> defaults)."""
    import json
    ids = {s for s, _ in SECTIONS}
    try:
        d = json.loads(raw) if isinstance(raw, str) and raw.strip() else None
        if not isinstance(d, dict):
            raise ValueError
        return {r: [s for s, _ in SECTIONS if s in (d.get(r) or []) and s in ids] for r in ("user", "admin")}
    except Exception:
        return default_role_access()


def clean_role_access(matrix) -> dict:
    if not isinstance(matrix, dict):
        raise ValueError("Role access must be an object like {user: [...], admin: [...]}.")
    ids = {s for s, _ in SECTIONS}
    out = {}
    for r in ("user", "admin"):
        vals = matrix.get(r) or []
        bad = [v for v in vals if v not in ids]
        if bad:
            raise ValueError(f"Unknown section: {bad[0]}")
        out[r] = [s for s, _ in SECTIONS if s in vals]
    return out
