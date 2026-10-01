"""Run lock + last-sync status, one pair per division, stored in that division's hub documents.

The lock stops two syncs of the SAME division overlapping (two techs opening the app, the "Sync all divisions"
button, later a scheduled job). It is a lease: a lock older than LOCK_TTL_MIN is treated as dead (the process
crashed) and can be taken over. The status record is what the app shows as "Last sync ...".

Best effort by design: if the lock/status documents cannot be read or written, the sync still runs (a hub
hiccup must not stop inventory work); `run_locked` then reports no holder.
"""
from __future__ import annotations

import datetime as _dt
import os
import socket
import uuid

LOCK_TTL_MIN = 30
STALE_HOURS = 36


def _now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)


def _iso(d: _dt.datetime) -> str:
    return d.isoformat(timespec="seconds") + "Z"


def _parse(s) -> _dt.datetime | None:
    try:
        return _dt.datetime.fromisoformat(str(s).rstrip("Z"))
    except (TypeError, ValueError):
        return None


def _machine() -> str:
    return os.environ.get("COMPUTERNAME") or socket.gethostname() or ""


def lock_is_live(lock) -> bool:
    t = _parse((lock or {}).get("started"))
    return bool(t) and (_now() - t) < _dt.timedelta(minutes=LOCK_TTL_MIN)


def acquire(hub, who: str):
    """(token, None) when we hold the lock; (None, holder_info) when someone else does."""
    try:
        cur = hub.get_sync_lock()
        if cur and lock_is_live(cur):
            return None, cur
        mine = {"token": uuid.uuid4().hex, "by": who or "", "machine": _machine(), "started": _iso(_now())}
        hub.put_sync_lock(mine)                        # central store: a concurrent writer raises HubConflict
        back = hub.get_sync_lock() or {}
        if back.get("token") != mine["token"]:
            return None, back
        return mine["token"], None
    except Exception as e:
        if e.__class__.__name__ == "HubConflict":      # somebody else grabbed it between our read and write
            try:
                return None, hub.get_sync_lock() or {"by": "another user"}
            except Exception:
                return None, {"by": "another user"}
        return "unlocked", None                        # hub unavailable: do not block the sync


def release(hub, token) -> None:
    if not token or token == "unlocked":
        return
    try:
        cur = hub.get_sync_lock() or {}
        if cur.get("token") == token:
            hub.clear_sync_lock()
    except Exception:
        pass


def record(hub, **fields) -> None:
    """Merge `fields` into the division's last-sync status. Never raises."""
    try:
        cur = hub.get_sync_status() or {}
        cur.update(fields)
        hub.put_sync_status(cur)
    except Exception:
        pass


def status(hub) -> dict:
    """The stored status plus `age_hours` and `stale` (older than STALE_HOURS or never run)."""
    try:
        st = dict(hub.get_sync_status() or {})
    except Exception:
        st = {}
    end = _parse(st.get("ended"))
    st["age_hours"] = round((_now() - end).total_seconds() / 3600, 1) if end else None
    st["stale"] = end is None or st["age_hours"] > STALE_HOURS
    st["never"] = end is None
    return st


def run_locked(hub, who: str, source: str, fn, summarize=None, merge: bool = False):
    """Run fn() under the division lock. Returns (result, None) or (None, holder_info) when the lock is held.
    On completion the status is recorded: `summarize(result)` -> dict of counts/errors. merge=True keeps the earlier
    started/ended-run fields and only adds `summarize`'s (used by the enrich step after the main sync)."""
    token, holder = acquire(hub, who)
    if token is None:
        return None, holder
    started = _now()
    result = None
    try:
        result = fn()
        return result, None
    finally:
        try:
            extra = (summarize(result) if (summarize and result is not None) else {"ok": False, "errors": ["did not finish"]})
            fields = dict(extra)
            if merge:
                fields["ended"] = _iso(_now())
            else:
                fields.update(started=_iso(started), ended=_iso(_now()), by=who or "", source=source, machine=_machine(),
                              seconds=int((_now() - started).total_seconds()))
            record(hub, **fields)
        finally:
            release(hub, token)
