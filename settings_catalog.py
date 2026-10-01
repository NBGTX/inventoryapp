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


def zones() -> list:
    return [{"id": z, "label": label} for z, label in TIMEZONES]


# kind: secret (hidden, replace-only) | text | choice (options) | number
CATALOG = [
    {"key": "lenovo_client_id", "group": "Vendor APIs", "label": "Lenovo warranty API client ID",
     "kind": "secret", "secret": True, "status": "active",
     "help": "Lets the app look up Lenovo warranty dates and specs by serial number. Stored hidden; "
             "it is never shown again after you save it."},
    {"key": "dell_client_id", "group": "Vendor APIs", "label": "Dell TechDirect client ID",
     "kind": "secret", "secret": True, "status": "planned",
     "help": "For Dell warranty and spec lookups. Stored now so it is ready; the lookup itself is not wired up yet."},
    {"key": "dell_client_secret", "group": "Vendor APIs", "label": "Dell TechDirect client secret",
     "kind": "secret", "secret": True, "status": "planned",
     "help": "Pairs with the Dell client ID."},
    {"key": "hp_client_id", "group": "Vendor APIs", "label": "HP warranty API client ID",
     "kind": "secret", "secret": True, "status": "planned",
     "help": "For HP warranty lookups. Stored now so it is ready; the lookup itself is not wired up yet."},
    {"key": "hp_client_secret", "group": "Vendor APIs", "label": "HP warranty API client secret",
     "kind": "secret", "secret": True, "status": "planned",
     "help": "Pairs with the HP client ID."},
    {"key": "default_timezone", "group": "Regional", "label": "Default time zone",
     "kind": "choice", "secret": False, "options": zones(), "status": "active",
     "help": "Used by every division that has not picked its own time zone. Blank = each PC's own time zone."},
    {"key": "intune_enrich_per_sync", "group": "Sync", "label": "Vendor lookups per sync run",
     "kind": "number", "secret": False, "min": 0, "max": 500, "default": 75, "status": "active",
     "help": "How many devices get a Lenovo/Dell/HP spec lookup in one sync. Lower = gentler on vendor APIs, slower to fill in."},
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
