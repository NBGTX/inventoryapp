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


MAX_FILES_PER_POST = 5
MAX_FILES_PER_ISSUE = 20
MAX_BYTES = 5 * 1024 * 1024
# Only these types are accepted (no scripts, archives or programs). Checked by name AND by the file's first bytes.
ALLOWED = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
           "bmp": "image/bmp", "pdf": "application/pdf", "txt": "text/plain", "log": "text/plain", "csv": "text/csv"}
_MAGIC = {"png": (b"\x89PNG\r\n\x1a\n",), "jpg": (b"\xff\xd8\xff",), "jpeg": (b"\xff\xd8\xff",), "gif": (b"GIF87a", b"GIF89a"),
          "bmp": (b"BM",), "pdf": (b"%PDF-",)}


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


def check_attachment(name: str, b64: str) -> tuple:
    """Validate one uploaded file. Returns (clean_name, mime, bytes). Raises IssueError with a message the person can act on."""
    import base64
    import binascii
    clean = re.sub(r"[^A-Za-z0-9._ -]", "_", str(name or "").replace("\\", "/").split("/")[-1]).strip(" .")[:80] or "file"
    ext = clean.rsplit(".", 1)[-1].lower() if "." in clean else ""
    if ext not in ALLOWED:
        raise IssueError(f"'{clean}': this kind of file is not accepted. Use a picture (png, jpg, gif, webp, bmp), pdf, txt, log or csv.")
    try:
        data = base64.b64decode(str(b64 or ""), validate=True)
    except (binascii.Error, ValueError):
        raise IssueError(f"'{clean}' could not be read.")
    if not data:
        raise IssueError(f"'{clean}' is empty.")
    if len(data) > MAX_BYTES:
        raise IssueError(f"'{clean}' is too big ({MAX_BYTES // (1024 * 1024)} MB at most).")
    if ext in _MAGIC and not any(data.startswith(m) for m in _MAGIC[ext]):
        raise IssueError(f"'{clean}' is not really a .{ext} file.")
    if ext == "webp" and not (data[:4] == b"RIFF" and data[8:12] == b"WEBP"):
        raise IssueError(f"'{clean}' is not really a .webp file.")
    if ext in ("txt", "log", "csv") and b"\x00" in data:
        raise IssueError(f"'{clean}' is not a text file.")
    return clean, ALLOWED[ext], data


def attachment_meta(att_id: str, name: str, mime: str, size: int, by: str) -> dict:
    return {"id": att_id, "name": name, "type": mime, "size": size, "by": by, "at": now_iso()}


def blob_name(issue_id: str, att_id: str, name: str) -> str:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else "bin"
    return f"{re.sub(r'[^A-Za-z0-9-]', '', issue_id)}-{re.sub(r'[^A-Za-z0-9-]', '', att_id)}.{ext}"


def all_attachments(issue: dict) -> list:
    out = list(issue.get("attachments") or [])
    for c in issue.get("comments") or []:
        out += list(c.get("attachments") or [])
    return out


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
            "comments": len(issue.get("comments") or []), "files": len(all_attachments(issue)),
            "voted": me in (issue.get("votes") or []), "watching": me in (issue.get("watchers") or []),
            "mine": me in ((issue.get("reporter") or {}).get("upn", ""), ((issue.get("assignee") or {}).get("upn", "")))}


def apply_comment(issue: dict, by: dict, text: str, attachments: list | None = None) -> None:
    now = now_iso()
    body = clean_text(text, "comment", required=not attachments)
    c = {"id": "c-" + uuid.uuid4().hex[:8], "by": by.get("name", ""), "upn": by.get("upn", ""), "at": now, "text": body}
    if attachments:
        c["attachments"] = attachments
    issue.setdefault("comments", []).append(c)
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
