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
    {"key": "auto_sync", "group": "Sync", "label": "Sync automatically when the app opens",
     "kind": "choice", "secret": False, "status": "active",
     "options": [{"id": "on", "label": "On (default)"}, {"id": "off", "label": "Off - only the Sync buttons sync"}],
     "help": "With it on, opening the app starts a sync for the division you are in. Turn it off to stop that on every PC "
             "(the NBG_NO_AUTOSYNC setting on a single PC still wins)."},
    {"key": "upgrade_cpu_years", "group": "Upgrades", "label": "Queue for upgrade: processor older than (years)",
     "kind": "number", "secret": False, "min": 0, "max": 15, "default": 5, "status": "active",
     "help": "A device whose processor generation was released this many years ago or more is added to the Upgrade list. "
             "0 turns this rule off. Needs the device's CPU to be known."},
    {"key": "upgrade_warranty_months", "group": "Upgrades", "label": "Queue for upgrade: warranty ended at least (months)",
     "kind": "number", "secret": False, "min": 0, "max": 60, "default": 0, "status": "active",
     "help": "A device whose warranty ended this many months ago or more is added to the Upgrade list. 0 (the default) turns "
             "this rule off. Works for any maker, because it only needs the warranty date."},
    {"key": "notify_webhook_url", "group": "Notifications", "label": "Notification webhook (sends the e-mails)",
     "kind": "secret", "secret": True, "status": "active",
     "help": "The address of a Power Automate flow (trigger: 'When an HTTP request is received') that e-mails or Teams-messages "
             "the people the app names. Stored hidden. Without it, issue e-mails can only be sent if the signed-in user's token "
             "already has Mail.Send, which it normally does not."},
    {"key": "ad_domain_controller", "group": "Directory", "label": "Domain controller for Copy Permissions",
     "kind": "text", "secret": False, "status": "active",
     "help": "The one on-premises AD server that BG Tools > Copy Permissions reads from and writes to, for example "
             "BGDALDCRW02.bg.nucorsteel.local. Using one server means a change is visible straight away. Blank = let Windows pick one "
             "(a read can then miss a change that has not replicated yet)."},
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
    if key == "notify_webhook_url":
        return clean_url(v)
    if key == "ad_domain_controller":
        import re
        if v and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.\-]{1,200}", v):
            raise ValueError("Enter a server name such as BGDALDCRW02.bg.nucorsteel.local (letters, digits, dots and dashes only).")
        return v
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


# ---- per-division options kept in the division's preferences document (Settings > General) ----
DEVICE_OS = [("windows", "Windows computers only"), ("all", "All device types (phones, tablets, Macs too)")]
HOT_SPARE_DEFAULT = ["Detailing", "Engineering"]          # "Other" is always added as the catch-all


def valid_device_os(v: str) -> bool:
    return v in {k for k, _ in DEVICE_OS}


def clean_depts(raw) -> list:
    """Hot spare department names: tidy, de-duplicated, never 'Other' (always present), at most 12. Raises ValueError."""
    out = []
    for d in raw or []:
        d = " ".join(str(d).split())
        if not d:
            continue
        if len(d) > 30:
            raise ValueError(f"'{d[:30]}...' is too long (30 characters at most).")
        if d.lower() == "other" or d.lower() in [x.lower() for x in out]:
            continue
        out.append(d)
    if len(out) > 12:
        raise ValueError("At most 12 departments.")
    return out


# ---- platform-wide people-search scopes for BG Tools (Settings > Platform > Search scopes) ----
def clean_scopes(data) -> dict:
    """{"brands": [{label, domain}], "divisions": [{label, company}]}, validated. Raises ValueError."""
    import re
    if not isinstance(data, dict):
        raise ValueError("Search scopes must have brands and divisions.")
    brands, divs = [], []
    for b in data.get("brands") or []:
        label = " ".join(str((b or {}).get("label") or "").split())
        dom = str((b or {}).get("domain") or "").strip().lower()
        if not label and not dom:
            continue
        if not label or not re.match(r"^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$", dom):
            raise ValueError(f"Brand '{label or dom}': needs a name and an email domain such as example.com.")
        if dom not in [x["domain"] for x in brands]:
            brands.append({"label": label[:60], "domain": dom})
    for d in data.get("divisions") or []:
        label = " ".join(str((d or {}).get("label") or "").split())
        co = " ".join(str((d or {}).get("company") or "").split())
        if not label and not co:
            continue
        if not label or not co:
            raise ValueError(f"Division '{label or co}': needs a name and the exact Entra company name.")
        if co.lower() not in [x["company"].lower() for x in divs]:
            divs.append({"label": label[:60], "company": co[:80]})
    if len(brands) > 40 or len(divs) > 40:
        raise ValueError("At most 40 entries in each list.")
    return {"brands": brands, "divisions": divs}
