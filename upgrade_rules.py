"""Which devices need an upgrade, and which are missing data that decides it.

Pure functions (no network) so the dashboard, the sync and the tests all agree.

A device qualifies for the Upgrade list when ANY enabled rule matches:
  * CPU age:       its processor generation was released `cpu_years` or more years ago (needs the CPU value);
  * Warranty:      its warranty ended at least `warranty_months` months ago (needs the warranty date).
A rule set to 0 is off. The default priority (1-5) comes from the oldest evidence found.
"""
from __future__ import annotations

from datetime import date

from cpu import release_year


def parse_date(v):
    s = str(v or "").strip()[:10]
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def months_between(earlier: date, later: date) -> int:
    """Whole months from `earlier` to `later` (0 if later is before earlier)."""
    m = (later.year - earlier.year) * 12 + (later.month - earlier.month) - (1 if later.day < earlier.day else 0)
    return max(0, m)


def _warranty_priority(months_past: int) -> int:
    return 2 if months_past < 12 else 3 if months_past < 24 else 4 if months_past < 36 else 5


def evaluate(tagged, cpu_years: int = 5, warranty_months: int = 0, today: date | None = None) -> list:
    """`tagged` = [(row, source), ...]. Returns the devices that need an upgrade, oldest evidence first."""
    today = today or date.today()
    out = []
    for r, src in tagged:
        serial = (r.get("serial") or "").strip()
        if not serial:
            continue
        reasons, prios = [], []
        year = age = months_past = None
        cy = release_year(r.get("cpu"))
        if cpu_years and cy and (today.year - cy) >= cpu_years:
            year, age = cy, today.year - cy
            reasons.append(f"processor released {cy} ({age} yrs old)")
            prios.append(max(1, min(5, age - 3)))
        wd = parse_date(r.get("warranty"))
        if warranty_months and wd:
            mp = months_between(wd, today)
            if wd < today and mp >= warranty_months:
                months_past = mp
                reasons.append(f"warranty ended {wd.isoformat()} ({mp} months ago)")
                prios.append(_warranty_priority(mp))
        if not reasons:
            continue
        out.append({"serial": serial, "model": r.get("model", ""), "cpu": r.get("cpu", ""), "user": r.get("user", ""),
                    "site": r.get("site_tag", ""), "device_name": r.get("device_name", ""),
                    "year": year, "age": age, "warranty": wd.isoformat() if wd else "", "months_past": months_past,
                    "reasons": reasons, "priority": max(prios), "source": src})
    out.sort(key=lambda x: (x["year"] or 9999, -(x["months_past"] or 0), x["serial"]))
    return out


_VIRTUAL = ("vmware", "virtual", "qemu", "xen", "parallels")


def missing_specs(tagged) -> list:
    """Devices with no CPU, RAM or warranty date recorded, so a person can fill them in. Virtual machines are skipped."""
    out = []
    for r, src in tagged:
        serial = (r.get("serial") or "").strip()
        maker = (r.get("manufacturer") or "").lower()
        if not serial or any(v in maker for v in _VIRTUAL):
            continue
        missing = [label for key, label in (("cpu", "CPU"), ("ram", "RAM"), ("warranty", "Warranty")) if not str(r.get(key) or "").strip()]
        if missing:
            out.append({"serial": serial, "device_name": r.get("device_name", ""), "model": r.get("model", ""),
                        "manufacturer": r.get("manufacturer", ""), "user": r.get("user", ""), "site": r.get("site_tag", ""),
                        "missing": missing, "source": src,
                        "cpu": r.get("cpu", ""), "ram": r.get("ram", ""), "warranty": r.get("warranty", "")})
    out.sort(key=lambda x: (-len(x["missing"]), x["manufacturer"], x["serial"]))
    return out
