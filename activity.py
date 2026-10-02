"""One activity feed from every place the app records what people did.

Three sources, all already written elsewhere:
  * the Inventory "Activity Log" SharePoint list (device events, syncs)         -> scope "Devices"
  * the division's hub change events (upgrade list, settings of this division) -> scope "Division"
  * the platform hub change events (sites, roles, issues, sign-ins ...)        -> scope "Platform"
This module only reads and normalises them; it never writes.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

# first match wins; the text tested is "<target> <action>" lower-cased
_AREA_RULES = [
    ("sign in", "Access"), ("signed", "Access"), ("super admin", "Access"), ("role access", "Access"),
    ("nbt site", "NBT Sites"), ("upgrade", "Upgrades"), ("software", "Software"), ("mfa", "Teammates"),
    ("timesheet", "BG Tools"), ("ad add", "BG Tools"), ("ad copy", "BG Tools"),
    ("issue", "Issues"), ("setup", "Provisioning"), ("checklist", "Provisioning"),
    ("hot spare", "Devices"), ("coil", "Devices"), ("bulk", "Devices"), ("device", "Devices"),
    ("division", "Settings"), ("master setting", "Settings"), ("setting", "Settings"), ("scope", "Settings"),
    ("baseline", "Settings"), ("department", "Settings"), ("data mode", "Settings"), ("snapshot", "Settings"),
]
_SYNC_WORDS = ("sync", "enriched", "dedupe", "boneyard")


def area_of(text: str) -> str:
    t = (text or "").lower()
    for needle, area in _AREA_RULES:
        if needle in t:
            return area
    return "Other"


def parse_ts(s) -> datetime | None:
    """ISO text -> aware datetime (a time without an offset is taken as local time). None if unreadable."""
    s = str(s or "").strip()
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.astimezone()


def _inv(e: dict) -> dict:
    act = str(e.get("action") or "")
    area = "Sync" if any(w in act.lower() for w in _SYNC_WORDS) else "Devices"
    return {"when": e.get("when", ""), "area": area, "action": act, "target": e.get("serial", "") or "",
            "detail": e.get("details", "") or "", "who": e.get("actor", "") or "", "scope": "Devices",
            "model": e.get("model", "") or ""}


def _chg(e: dict, scope: str) -> dict:
    target = str(e.get("target") or "")
    return {"when": e.get("when", ""), "area": area_of(target + " " + str(e.get("action") or "")), "action": target or str(e.get("action") or ""),
            "target": "", "detail": e.get("detail", "") or "", "who": e.get("user", "") or "", "scope": scope,
            "machine": e.get("machine", "") or ""}


def build(inventory, division_changes, platform_changes, days: int = 0, now: datetime | None = None, limit: int = 3000) -> dict:
    """Merge the three sources, newest first. days = 0 means everything. Returns {entries, total, truncated}."""
    rows = [_inv(e) for e in (inventory or []) if isinstance(e, dict)]
    rows += [_chg(e, "Division") for e in (division_changes or []) if isinstance(e, dict)]
    rows += [_chg(e, "Platform") for e in (platform_changes or []) if isinstance(e, dict)]
    for r in rows:
        r["_t"] = parse_ts(r["when"])
    if days and days > 0:
        cut = (now or datetime.now(timezone.utc)) - timedelta(days=int(days))
        rows = [r for r in rows if r["_t"] is not None and r["_t"] >= cut]
    floor = datetime.min.replace(tzinfo=timezone.utc)
    rows.sort(key=lambda r: r["_t"] or floor, reverse=True)
    total = len(rows)
    for r in rows:
        r.pop("_t", None)
    return {"entries": rows[:limit], "total": total, "truncated": total > limit}
