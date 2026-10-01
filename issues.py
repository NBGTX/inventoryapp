"""Bug / feature tracker: one platform-wide board shared by every division.

Issues are small JSON documents in the platform pseudo-hub (hub.platform_hub_for), one document per issue under
`issues/`. Anyone signed in can report, comment, vote and watch; super admins triage (status, assignee, delete).
Notifications are decided here (who should hear about what) and delivered by notify.py.
All validation is server-side; the page only displays.
"""
from __future__ import annotations

import datetime as _dt
import re
import uuid

STATUSES = [("open", "Open"), ("planned", "Planned"), ("in_progress", "In progress"), ("done", "Done"), ("wont_do", "Won't do")]
STATUS_IDS = [s for s, _ in STATUSES]
CLOSED = {"done", "wont_do"}
TYPES = ["bug", "feature"]
EVENTS = ["new", "status", "comment"]
LIMITS = {"title": 120, "detail": 8000, "comment": 4000}


class IssueError(Exception):
    """A problem the person can fix (shown as-is in the app)."""


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds") + "Z"


def clean_text(v, kind: str, required: bool = False) -> str:
    t = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(v or "")).strip()
    if required and not t:
        raise IssueError({"title": "Add a short title.", "comment": "Write a comment first."}.get(kind, "That is required."))
    if len(t) > LIMITS[kind]:
        raise IssueError(f"That is too long ({LIMITS[kind]} characters at most).")
    return t


def person(upn: str, name: str = "") -> dict:
    return {"upn": (upn or "").strip().lower(), "name": (name or upn or "").strip()}


def short_id(issue_id: str) -> str:
    return "#" + (issue_id or "")[-6:].upper()


def new_issue(kind: str, title: str, detail: str, reporter: dict, division: dict, version: str = "") -> dict:
    if kind not in TYPES:
        raise IssueError("Choose Bug or Feature request.")
    now = now_iso()
    iid = "iss-" + _dt.datetime.now().strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6]
    return {
        "id": iid, "type": kind, "title": clean_text(title, "title", True), "detail": clean_text(detail, "detail"),
        "status": "open", "reporter": reporter, "division": {"id": division.get("id", ""), "name": division.get("name", "")},
        "version": version, "created_at": now, "updated_at": now, "assignee": None,
        "votes": [], "watchers": [], "comments": [],
        "history": [{"at": now, "by": reporter.get("name", ""), "action": "created", "detail": f"{kind} reported"}],
    }


def summary(issue: dict, me: str = "") -> dict:
    me = (me or "").lower()
    return {"id": issue["id"], "short": short_id(issue["id"]), "type": issue.get("type", "bug"), "title": issue.get("title", ""),
            "status": issue.get("status", "open"), "reporter": issue.get("reporter") or {}, "division": issue.get("division") or {},
            "created_at": issue.get("created_at", ""), "updated_at": issue.get("updated_at", ""),
            "assignee": issue.get("assignee"), "votes": len(issue.get("votes") or []),
            "comments": len(issue.get("comments") or []),
            "voted": me in (issue.get("votes") or []), "watching": me in (issue.get("watchers") or []),
            "mine": me in ((issue.get("reporter") or {}).get("upn", ""), ((issue.get("assignee") or {}).get("upn", "")))}


def apply_comment(issue: dict, by: dict, text: str) -> None:
    now = now_iso()
    issue.setdefault("comments", []).append({"id": "c-" + uuid.uuid4().hex[:8], "by": by.get("name", ""), "upn": by.get("upn", ""),
                                             "at": now, "text": clean_text(text, "comment", True)})
    issue["updated_at"] = now
    if by.get("upn") and by["upn"] not in issue.setdefault("watchers", []):
        issue["watchers"].append(by["upn"])                    # commenting subscribes you to the thread


def toggle(issue: dict, field: str, upn: str) -> bool:
    """Add/remove `upn` in issue[field] (votes / watchers). Returns True if now present."""
    lst = issue.setdefault(field, [])
    if upn in lst:
        lst.remove(upn)
        return False
    lst.append(upn)
    return True


def apply_triage(issue: dict, by: dict, fields: dict) -> list:
    """Status / assignee changes by a triager. Returns the list of events worth telling people about ([] if nothing changed)."""
    events, now = [], now_iso()
    if "status" in fields and fields["status"] != issue.get("status"):
        if fields["status"] not in STATUS_IDS:
            raise IssueError("Pick a status from the list.")
        old = issue.get("status")
        issue["status"] = fields["status"]
        issue.setdefault("history", []).append({"at": now, "by": by.get("name", ""), "action": "status", "detail": f"{old} -> {fields['status']}"})
        events.append("status")
    if "assignee" in fields:
        a = fields["assignee"]
        new = person((a or {}).get("upn", ""), (a or {}).get("name", "")) if a and (a or {}).get("upn") else None
        if (new or {}).get("upn") != (issue.get("assignee") or {}).get("upn"):
            issue["assignee"] = new
            issue.setdefault("history", []).append({"at": now, "by": by.get("name", ""), "action": "assigned",
                                                    "detail": (new or {}).get("name") or "unassigned"})
            events.append("status")
    if events:
        issue["updated_at"] = now
    return events


def apply_edit(issue: dict, by: dict, fields: dict) -> bool:
    changed = False
    if "title" in fields:
        t = clean_text(fields["title"], "title", True)
        changed |= t != issue.get("title")
        issue["title"] = t
    if "detail" in fields:
        d = clean_text(fields["detail"], "detail")
        changed |= d != issue.get("detail")
        issue["detail"] = d
    if "type" in fields and fields["type"] in TYPES and fields["type"] != issue.get("type"):
        issue["type"] = fields["type"]
        changed = True
    if changed:
        issue["updated_at"] = now_iso()
        issue.setdefault("history", []).append({"at": issue["updated_at"], "by": by.get("name", ""), "action": "edited", "detail": ""})
    return changed


def legacy_to_issue(fb: dict, division: dict) -> dict:
    """Convert an old per-division feedback record into an issue (keeps its date and reporter)."""
    when = fb.get("at") or now_iso()
    who = fb.get("by") or "unknown"
    return {
        "id": "iss-legacy-" + re.sub(r"[^A-Za-z0-9]", "", str(fb.get("id") or uuid.uuid4().hex))[-14:] + "-" + (division.get("id") or "x")[:6],
        "legacy_id": fb.get("id", ""), "type": fb.get("type") if fb.get("type") in TYPES else "bug",
        "title": (fb.get("title") or "(untitled)")[:LIMITS["title"]], "detail": (fb.get("detail") or "")[:LIMITS["detail"]],
        "status": "done" if fb.get("status") == "closed" else "open",
        "reporter": {"upn": "", "name": who}, "division": {"id": division.get("id", ""), "name": division.get("name", "")},
        "version": "", "created_at": when, "updated_at": when, "assignee": None, "votes": [], "watchers": [], "comments": [],
        "history": [{"at": when, "by": who, "action": "created", "detail": "imported from the old Report bug / feature list"}],
    }
