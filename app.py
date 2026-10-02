#!/usr/bin/env python3
"""
NBG Hub - desktop app entry point (reads Intune + SharePoint via Graph).

A pywebview shell that renders the Command Center UI (web/) and exposes a Python
API to the page. Each user signs in with their own Nucor account (MSAL public
client, PKCE, no secret). Inventory lives in the three SharePoint lists; serial
lookups use Intune (with a Lenovo/Dell vendor fallback for un-enrolled devices).

Run:      python app.py
Build:    build.ps1 -> dist/NBG Hub.exe (double-click; config.json sits beside it)
"""
from __future__ import annotations

import contextlib
import os
import re
import sys
import threading
import traceback
from datetime import date, datetime

from cpu import release_year as cpu_release_year

if getattr(sys, "frozen", False):
    HERE = os.path.dirname(sys.executable)
    _ASSET_BASE = getattr(sys, "_MEIPASS", HERE)
else:
    HERE = os.path.dirname(os.path.abspath(__file__))
    _ASSET_BASE = HERE


def _asset(*parts: str) -> str:
    return os.path.join(_ASSET_BASE, *parts)


def _parse_warranty(v):
    """Parse a warranty end date from the assorted formats the lists use."""
    v = (v or "").strip()
    if not v:
        return None
    v = v[:10] if ("T" in v or " " in v) else v
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d"):
        try:
            return datetime.strptime(v, fmt).date()
        except Exception:
            pass
    return None


def _warranty_summary(machines):
    """Bucket every machine's warranty by how soon it ends, for the dashboard."""
    today = date.today()
    b = {"expired": 0, "d0_30": 0, "d31_90": 0, "d91_180": 0, "beyond": 0, "none": 0}
    upcoming = []
    for m in machines:
        d = _parse_warranty(m.get("warranty"))
        if not d:
            b["none"] += 1
            continue
        days = (d - today).days
        if days < 0:
            b["expired"] += 1
        elif days <= 30:
            b["d0_30"] += 1
        elif days <= 90:
            b["d31_90"] += 1
        elif days <= 180:
            b["d91_180"] += 1
        else:
            b["beyond"] += 1
        if days <= 180:
            upcoming.append({"serial": m.get("serial", ""), "model": m.get("model", ""),
                             "warranty": d.isoformat(), "days": days})
    upcoming.sort(key=lambda x: x["days"])
    b["expiring_90"] = b["d0_30"] + b["d31_90"]
    b["upcoming"] = upcoming[:6]
    return b


class Api:
    """Exposed to JavaScript as window.pywebview.api."""

    def __init__(self):
        from graph import GraphClient  # lazy so the window can open before sign-in
        self._GraphClient = GraphClient
        self._gc = None
        self._hub = None
        self._site_view = False  # True while the main window is showing an NBT site
        self._busy = 0           # long write operations in flight (a division switch must wait)
        self._busy_lock = threading.Lock()

    @contextlib.contextmanager
    def _work(self):
        with self._busy_lock:
            self._busy += 1
        try:
            yield
        finally:
            with self._busy_lock:
                self._busy -= 1

    @staticmethod
    def _trace(msg: str) -> None:
        """Append one line to boot.log in the NBG Hub user folder (launch diagnostics: no tokens, no data)."""
        try:
            import paths
            import time as _t
            with open(os.path.join(paths.user_dir(), "boot.log"), "a", encoding="utf-8") as f:
                f.write(_t.strftime("%H:%M:%S ") + msg + chr(10))
        except Exception:
            pass

    _init_lock = threading.RLock()       # JS fires many Api calls at once at launch: build the client / hub exactly once

    def _client(self):
        if self._gc is None:
            with self._init_lock:
                if self._gc is None:
                    self._gc = self._GraphClient()
        return self._gc

    def _hubc(self):
        if self._hub is None:
            with self._init_lock:
                if self._hub is None:
                    self._hub = self._build_hub()
        return self._hub

    def _build_hub(self):
        from hub import hub_for
        return hub_for(self._client())

    # ---- super admins + directory type-ahead (super admin) ----------------------
    def user_lookup(self, query: str, kind: str = "user") -> dict:
        """Entra type-ahead for the admin screens (people or groups). Non-admins get no results."""
        try:
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": True, "results": []}
            return {"ok": True, "results": gc.directory_lookup(query, kind if kind in ("group", "company") else "user")}
        except Exception as e:
            return self._fail(e)

    def get_super_admins(self) -> dict:
        try:
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": True, "super_admin": False}
            return {"ok": True, "super_admin": True, **gc.super_admin_list()}
        except Exception as e:
            return self._fail(e)

    def save_super_admins(self, admins: list) -> dict:
        """Replace the editable super-admin list (super admin only; you cannot remove yourself)."""
        try:
            return {"ok": True, "admins": self._client().save_super_admins(admins or [])}
        except Exception as e:
            return self._fail(e)

    # ---- division admin (super admin) ----------------------------------------
    def get_division_admin(self) -> dict:
        try:
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": True, "super_admin": False, "divisions": []}
            return {"ok": True, "super_admin": True, "divisions": gc.division_rows()}
        except Exception as e:
            return self._fail(e)

    def save_division(self, division: dict) -> dict:
        """Create/update one division in the central Divisions list (super admin only)."""
        try:
            self._client().save_division_row(division or {})
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    # ---- master settings (super admin) ---------------------------------------
    def get_master_settings(self) -> dict:
        """Super admins: every setting (secret values masked). Others: just super_admin=False."""
        try:
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": True, "super_admin": False, "settings": []}
            rows = []
            for k, v in sorted(gc.master_settings(force=True).items()):
                rows.append({"key": k, "secret": v["secret"], "description": v["description"],
                             "is_set": bool(v["value"]),
                             "value": ("" if v["secret"] else v["value"])})
            import settings_catalog as sc
            known = {c["key"] for c in sc.CATALOG}
            cur = gc.master_settings()
            cat = []
            for c in sc.CATALOG:
                v = cur.get(c["key"]) or {}
                cat.append({**c, "is_set": bool(v.get("value")), "value": "" if c["secret"] else v.get("value", "")})
            return {"ok": True, "super_admin": True, "settings": rows, "catalog": cat,
                    "other": [r for r in rows if r["key"] not in known and r["key"] not in ("super_admins", sc.ROLE_ACCESS_KEY)]}
        except Exception as e:
            return self._fail(e)

    def set_master_setting(self, key: str, value: str, secret: bool = False, description: str = "") -> dict:
        """Create/update one master setting (super admin only). Value is never logged."""
        try:
            import settings_catalog as sc
            known = sc.entry((key or "").strip())
            if known:                                   # catalog settings: fixed secrecy/description, validated value
                value = sc.check_value(known["key"], value)
                secret, description = known["secret"], known["label"]
            self._client().set_setting(key, value, secret=bool(secret), description=description or "")
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    def get_update_info(self) -> dict:
        """This build vs the latest/minimum versions set under Platform > Integrations (master settings)."""
        try:
            import version
            gc = self._client()
            cur, latest, low = version.APP_VERSION, gc.get_setting("latest_version", ""), gc.get_setting("min_version", "")
            c, l, m = version.parse(cur), version.parse(latest), version.parse(low)
            return {"ok": True, "current": cur, "latest": latest if l else "", "min": low if m else "",
                    "update_available": bool(l and c < l), "update_required": bool(m and c < m)}
        except Exception as e:
            return self._fail(e)

    def _stale_limit(self) -> int:
        try:
            import settings_catalog
            return settings_catalog.number(self._client(), "stale_checkin_days")
        except Exception:
            return 30

    # ---- division preferences: time zone (any user of the division; super admins too) ----
    def get_division_prefs(self) -> dict:
        try:
            import settings_catalog as sc
            gc = self._client()
            prefs = self._hubc().get_prefs()
            tz = (prefs.get("timezone") or "").strip()
            tz = tz if sc.valid_timezone(tz) else ""
            dflt = (gc.get_setting("default_timezone") or "").strip()
            dflt = dflt if sc.valid_timezone(dflt) else ""
            try:
                ph = sc.clean_url(prefs.get("project_hub_url"))
            except ValueError:
                ph = ""                                  # a hand-edited bad value is ignored, never opened
            try:
                ph_def = sc.clean_url(gc.get_setting("project_hub_url")) or sc.PROJECT_HUB_DEFAULT
            except ValueError:
                ph_def = sc.PROJECT_HUB_DEFAULT
            dos = (prefs.get("device_os") or "").strip().lower()
            if not sc.valid_device_os(dos):
                dos = "all" if (gc.cfg.get("intune_device_os", "Windows") or "").strip().lower() in ("", "all", "*", "any") else "windows"
            try:
                depts = sc.clean_depts(prefs.get("hot_spare_depts"))
            except ValueError:
                depts = []
            return {"ok": True, "timezone": tz, "default": dflt, "effective": tz or dflt, "zones": sc.zones(),
                    "project_hub_url": ph, "project_hub_default": ph_def, "project_hub_effective": ph or ph_def,
                    "device_os": dos, "device_os_options": [{"id": k, "label": v} for k, v in sc.DEVICE_OS],
                    "hot_spare_depts": depts, "hot_spare_default": sc.HOT_SPARE_DEFAULT,
                    "hot_spare_effective": (depts or sc.HOT_SPARE_DEFAULT) + ["Other"]}
        except Exception as e:
            return self._fail(e)

    def save_division_prefs(self, timezone=None, project_hub_url=None, device_os=None, hot_spare_depts=None) -> dict:
        """Admin of the division (or super admin). Only the arguments that are given are changed;
        timezone "" / project_hub_url "" / hot_spare_depts [] mean 'use the default'."""
        try:
            import settings_catalog as sc
            gc = self._client()
            gc.require_division_admin()
            prefs_in = {}
            if timezone is not None:
                tz = (timezone or "").strip()
                if tz and not sc.valid_timezone(tz):
                    return {"ok": False, "error": "Pick a time zone from the list."}
                prefs_in["timezone"] = tz
            if project_hub_url is not None:
                try:
                    prefs_in["project_hub_url"] = sc.clean_url(project_hub_url)
                except ValueError as e:
                    return {"ok": False, "error": str(e)}
            if device_os is not None:
                if not sc.valid_device_os(device_os):
                    return {"ok": False, "error": "Pick which devices to sync from the list."}
                prefs_in["device_os"] = device_os
            if hot_spare_depts is not None:
                try:
                    prefs_in["hot_spare_depts"] = sc.clean_depts(hot_spare_depts)
                except ValueError as e:
                    return {"ok": False, "error": str(e)}
            if not prefs_in:
                return {"ok": True}
            hub = self._hubc()
            prefs = hub.get_prefs()
            prefs.update(prefs_in)
            hub.save_prefs(prefs, {"action": "save", "target": "Division preferences",
                                   "detail": ", ".join(f"{k} = {v or '(default)'}" for k, v in prefs_in.items())})
            gc.__dict__.pop("_prefs_cache", None)           # the sync reads the device filter from here
            return {"ok": True, **prefs_in}
        except Exception as e:
            return self._fail(e)

    # ---- Issues board: bugs and feature requests for the whole platform --------------
    _sync_notify = False          # tests set True so notifications run inline instead of in a background thread

    def _issue_hub(self):
        from hub import platform_hub_for
        return platform_hub_for(self._client())

    def _issue_user(self) -> dict:
        import issues
        gc = self._client()
        gc.sign_in(interactive=False)
        if not (gc.account_upn or "").strip():
            raise issues.IssueError("Sign in first.")
        return issues.person(gc.account_upn, gc.account_name)

    def _mutate_issue(self, iid: str, fn):
        """Read-change-write one issue, retrying if someone else saved it at the same moment."""
        import issues
        hub = self._issue_hub()
        for _ in range(3):
            doc = hub.get_issue(iid)
            if not doc:
                raise issues.IssueError("That issue no longer exists.")
            result = fn(doc)
            try:
                hub.put_issue(doc)
                return doc, result
            except Exception as e:
                if e.__class__.__name__ != "HubConflict":
                    raise
        raise issues.IssueError("Someone else changed this issue at the same moment. Try again.")

    def _notify(self, issue: dict, event: str, actor: dict, extra: str = "") -> None:
        """Tell the right people (best effort, in the background); the outcome is added to the issue's history."""
        import threading
        gc = self._client()

        def run():
            try:
                import issues
                import notify
                hub = self._issue_hub()
                subs = notify.subscribers_doc(hub.get_named("issue-subscribers"))
                to = notify.recipients(issue, event, subs, actor.get("upn", ""))
                if not to:
                    return
                subject, text, body = notify.render(issue, event, actor.get("name", ""), extra)
                res = notify.deliver(gc, to, subject, text, body, event, issue)
                note = (f"notified {res['sent']} by {res['via']}" if res["sent"] else
                        ("not sent: " + res["error"] if res["error"] else ""))
                if note:
                    def add(doc):
                        doc.setdefault("history", []).append({"at": issues.now_iso(), "by": "", "action": "notify", "detail": f"{event}: {note}"})
                    self._mutate_issue(issue["id"], add)
            except Exception:
                pass
        if self._sync_notify:
            run()
        else:
            threading.Thread(target=run, daemon=True).start()

    def _store_files(self, issue_id: str, files: list, existing: int, who: str) -> list:
        """Validate and upload attachments; returns their metadata. Nothing is uploaded if any file is refused."""
        import issues
        import uuid
        files = list(files or [])
        if len(files) > issues.MAX_FILES_PER_POST:
            raise issues.IssueError(f"At most {issues.MAX_FILES_PER_POST} files at a time.")
        if existing + len(files) > issues.MAX_FILES_PER_ISSUE:
            raise issues.IssueError(f"This issue already has too many files ({issues.MAX_FILES_PER_ISSUE} at most).")
        checked = [issues.check_attachment((f or {}).get("name"), (f or {}).get("data")) for f in files]
        hub = self._issue_hub()
        metas = []
        for name, mime, data in checked:
            att_id = "a-" + uuid.uuid4().hex[:8]
            hub.put_attachment(issues.blob_name(issue_id, att_id, name), data)
            metas.append(issues.attachment_meta(att_id, name, mime, len(data), who))
        return metas

    def issue_create(self, kind: str, title: str, detail: str = "", files: list = None) -> dict:
        try:
            import issues
            me = self._issue_user()
            gc = self._client()
            import version
            doc = issues.new_issue(kind, title, detail, me, {"id": gc.division["id"], "name": gc.division.get("name", "")}, version.APP_VERSION)
            doc["watchers"] = [me["upn"]]
            if files:
                doc["attachments"] = self._store_files(doc["id"], files, 0, me["name"])
            self._issue_hub().put_issue(doc)
            self._notify(doc, "new", me)
            return {"ok": True, "issue": issues.summary(doc, me["upn"])}
        except Exception as e:
            return self._fail(e)

    def issues_list(self) -> dict:
        try:
            import issues
            me = self._issue_user()
            gc = self._client()
            items = [issues.summary(d, me["upn"]) for d in self._issue_hub().list_issues()]
            items.sort(key=lambda x: x["updated_at"], reverse=True)
            return {"ok": True, "issues": items, "triage": gc.is_super_admin(), "me": me["upn"],
                    "statuses": [{"id": k, "label": v} for k, v in issues.STATUSES]}
        except Exception as e:
            return self._fail(e)

    def issue_counts(self, since: str = "") -> dict:
        """Numbers for the sidebar badge on Issues. `new` = issues nobody has triaged yet (the badge for super admins);
        `updates` = issues you reported, are assigned or watch that changed since `since` (ISO time) by someone else
        (the badge for everyone else)."""
        try:
            me = self._issue_user()
            gc = self._client()
            new = updates = 0
            for d in self._issue_hub().list_issues():
                if d.get("status") == "new":
                    new += 1
                involved = me["upn"] in (d.get("watchers") or []) or me["upn"] in ((d.get("reporter") or {}).get("upn"), (d.get("assignee") or {}).get("upn"))
                if involved and since and (d.get("updated_at") or "") > since:
                    last = max([(c.get("at", ""), c.get("upn", ""), c.get("by", "")) for c in d.get("comments") or []]
                               + [(h.get("at", ""), "", h.get("by", "")) for h in d.get("history") or [] if h.get("action") != "notify"] or [("", "", "")])
                    if last[1] != me["upn"] and last[2] != me["name"]:
                        updates += 1
            return {"ok": True, "new": new, "updates": updates, "triage": gc.is_super_admin()}
        except Exception as e:
            return self._fail(e)

    def issue_get(self, issue_id: str) -> dict:
        try:
            import issues
            me = self._issue_user()
            doc = self._issue_hub().get_issue(issue_id)
            if not doc:
                return {"ok": False, "error": "That issue no longer exists."}
            return {"ok": True, "issue": doc, "summary": issues.summary(doc, me["upn"]), "triage": self._client().is_super_admin(),
                    "can_edit": self._client().is_super_admin()}
        except Exception as e:
            return self._fail(e)

    def issue_comment(self, issue_id: str, text: str, files: list = None) -> dict:
        try:
            import issues
            me = self._issue_user()
            metas = []
            if files:
                cur = self._issue_hub().get_issue(issue_id)
                if not cur:
                    raise issues.IssueError("That issue no longer exists.")
                metas = self._store_files(issue_id, files, len(issues.all_attachments(cur)), me["name"])
            doc, _ = self._mutate_issue(issue_id, lambda d: issues.apply_comment(d, me, text, metas))
            note = issues.clean_text(text, "comment")[:500] or f"(attached {len(metas)} file(s))"
            self._notify(doc, "comment", me, note)
            return {"ok": True, "issue": doc}
        except Exception as e:
            return self._fail(e)

    def issue_attachment(self, issue_id: str, att_id: str) -> dict:
        """The bytes of one attachment as base64 (for the page to show or save). Any signed-in user."""
        try:
            import base64
            import issues
            self._issue_user()
            hub = self._issue_hub()
            doc = hub.get_issue(issue_id)
            meta = next((m for m in issues.all_attachments(doc or {}) if m.get("id") == att_id), None)
            if not meta:
                return {"ok": False, "error": "That file no longer exists."}
            data = hub.get_attachment(issues.blob_name(issue_id, att_id, meta["name"]))
            if data is None:
                return {"ok": False, "error": "The file could not be found in storage."}
            return {"ok": True, "name": meta["name"], "type": meta["type"], "size": len(data), "data": base64.b64encode(data).decode("ascii")}
        except Exception as e:
            return self._fail(e)

    def issue_vote(self, issue_id: str) -> dict:
        try:
            import issues
            me = self._issue_user()
            doc, on = self._mutate_issue(issue_id, lambda d: issues.toggle(d, "votes", me["upn"]))
            return {"ok": True, "voted": on, "votes": len(doc.get("votes") or [])}
        except Exception as e:
            return self._fail(e)

    def issue_watch(self, issue_id: str) -> dict:
        try:
            import issues
            me = self._issue_user()
            doc, on = self._mutate_issue(issue_id, lambda d: issues.toggle(d, "watchers", me["upn"]))
            return {"ok": True, "watching": on}
        except Exception as e:
            return self._fail(e)

    def issue_update(self, issue_id: str, fields: dict) -> dict:
        """Super admins only (status, assignee, title, description, type). Everyone else follows an issue with comments."""
        try:
            import issues
            me = self._issue_user()
            gc = self._client()
            fields = fields or {}
            sa = gc.is_super_admin()
            if not sa:
                return {"ok": False, "error": "Only a super admin can edit an issue or change its status. Add a comment instead."}

            def change(d):
                ev = issues.apply_triage(d, me, fields)
                issues.apply_edit(d, me, fields)
                return ev
            doc, events = self._mutate_issue(issue_id, change)
            if events:
                self._notify(doc, "status", me)
            return {"ok": True, "issue": doc}
        except Exception as e:
            return self._fail(e)

    def issue_delete(self, issue_id: str) -> dict:
        try:
            if not self._client().is_super_admin():
                return {"ok": False, "error": "Only a super admin can delete an issue."}
            import issues
            hub = self._issue_hub()
            doc = hub.get_issue(issue_id)
            hub.delete_issue(issue_id)
            for m in issues.all_attachments(doc or {}):
                hub.delete_attachment(issues.blob_name(issue_id, m.get("id", ""), m.get("name", "")))
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    def issues_import_legacy(self) -> dict:
        """Super admins: copy the old per-division 'Report bug / feature' lists onto the board (once per item)."""
        try:
            import issues
            from hub import hub_for
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": False, "error": "Only a super admin can import."}
            hub = self._issue_hub()
            have = {d.get("legacy_id") for d in hub.list_issues() if d.get("legacy_id")}
            added = 0
            for d in list(gc.registry):
                try:
                    c = gc.clone_for_snapshot()
                    c.set_division(d["id"], persist=False)
                    for fb in hub_for(c).get_feedback() or []:
                        key = fb.get("id")
                        if not key or key in have:
                            continue
                        hub.put_issue(issues.legacy_to_issue(fb, d))
                        have.add(key)
                        added += 1
                except Exception:
                    continue
            return {"ok": True, "imported": added}
        except Exception as e:
            return self._fail(e)

    # ---- who is told about issue events (super admins) ----
    def get_issue_notifications(self) -> dict:
        try:
            import issues
            import notify
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": True, "super_admin": False}
            hub = self._issue_hub()
            return {"ok": True, "super_admin": True, "subscribers": notify.subscribers_doc(hub.get_named("issue-subscribers")),
                    "events": issues.EVENTS, "webhook_set": bool(gc.get_setting("notify_webhook_url", "")), "can_mail": gc.can_send_mail()}
        except Exception as e:
            return self._fail(e)

    def save_issue_subscribers(self, subscribers: list) -> dict:
        try:
            import notify
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": False, "error": "Only a super admin can change who is notified."}
            clean = notify.subscribers_doc({"subscribers": subscribers})
            if len(clean) > 50:
                return {"ok": False, "error": "At most 50 people."}
            self._issue_hub().put_named("issue-subscribers", {"subscribers": clean})
            return {"ok": True, "subscribers": clean}
        except Exception as e:
            return self._fail(e)

    def issue_notify_test(self) -> dict:
        """Send a sample message to the current subscribers so the webhook/mail path can be checked."""
        try:
            import issues
            import notify
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": False, "error": "Only a super admin can send a test."}
            me = issues.person(gc.account_upn, gc.account_name)
            hub = self._issue_hub()
            subs = notify.subscribers_doc(hub.get_named("issue-subscribers"))
            demo = issues.new_issue("bug", "Test notification", "This is a test from Settings > Issue notifications.", me,
                                    {"id": gc.division["id"], "name": gc.division.get("name", "")}, "")
            to = [{"upn": s["upn"], "name": s["name"]} for s in subs] or [{"upn": me["upn"], "name": me["name"]}]
            subject, text, body = notify.render(demo, "new", me["name"])
            res = notify.deliver(gc, to, subject, text, body, "new", demo)
            if res["sent"]:
                return {"ok": True, "sent": res["sent"], "via": res["via"]}
            return {"ok": False, "error": res["error"] or "Nothing was sent."}
        except Exception as e:
            return self._fail(e)

    # ---- BG Tools people-search scopes (platform-wide; super admin edits) ----
    def _scopes(self) -> dict:
        """Saved scopes if any, else config.json, else the built-in lists."""
        gc = self._client()
        try:
            from hub import platform_hub_for
            saved = platform_hub_for(gc).get_named("search-scopes")
        except Exception:
            saved = None
        if saved and isinstance(saved, dict):
            return {"custom": True, "brands": saved.get("brands") or [], "divisions": saved.get("divisions") or []}
        cfg = gc.cfg
        brands = cfg.get("permission_locations")
        divs = cfg.get("permission_divisions")
        return {"custom": False,
                "brands": [{"label": b.get("label") or b.get("domain") or "", "domain": (b.get("domain") or "").strip().lower()}
                           for b in (brands if isinstance(brands, list) and brands else self._BG_LOCATIONS_DEFAULT) if isinstance(b, dict) and b.get("domain")],
                "divisions": [{"label": d.get("label") or d.get("company") or "", "company": (d.get("company") or "").strip()}
                              for d in (divs if isinstance(divs, list) and divs else self._BG_DIVISIONS_DEFAULT) if isinstance(d, dict) and d.get("company")]}

    def get_search_scopes(self) -> dict:
        try:
            if not self._client().is_super_admin():
                return {"ok": True, "super_admin": False}
            return {"ok": True, "super_admin": True, **self._scopes()}
        except Exception as e:
            return self._fail(e)

    def save_search_scopes(self, data: dict) -> dict:
        try:
            import settings_catalog as sc
            from hub import platform_hub_for
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": False, "error": "Only a super admin can change the search scopes."}
            try:
                clean = sc.clean_scopes(data)
            except ValueError as e:
                return {"ok": False, "error": str(e)}
            platform_hub_for(gc).put_named("search-scopes", clean)
            return {"ok": True, **clean}
        except Exception as e:
            return self._fail(e)

    # ---- tenant settings: the active division's own sites / AD / timesheet SQL ---------
    def get_my_role(self) -> dict:
        """Role in the active division + the Settings sections (beyond General) it may use."""
        try:
            gc = self._client()
            return {"ok": True, "role": gc.division_role(), "sections": gc.allowed_sections()}
        except Exception as e:
            return self._fail(e)

    def get_role_access(self) -> dict:
        """Super admins: the role x section matrix (Platform > Role access)."""
        try:
            import settings_catalog as sc
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": True, "super_admin": False}
            return {"ok": True, "super_admin": True, "sections": [{"id": s, "label": l} for s, l in sc.SECTIONS],
                    "matrix": sc.parse_role_access(gc.get_setting(sc.ROLE_ACCESS_KEY, ""))}
        except Exception as e:
            return self._fail(e)

    def save_role_access(self, matrix: dict) -> dict:
        try:
            import json
            import settings_catalog as sc
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": False, "error": "Only a super admin can change role access."}
            clean = sc.clean_role_access(matrix)
            gc.set_setting(sc.ROLE_ACCESS_KEY, json.dumps(clean), secret=False,
                           description="Settings sections each division role may use (edited in the app)")
            return {"ok": True, "matrix": clean}
        except Exception as e:
            return self._fail(e)

    def get_own_division(self) -> dict:
        try:
            gc = self._client()
            d = gc.division
            keys = ("sites", "access", "ad_domain", "sql_server", "timesheet_db", "timesheet_table", "employee_db", "employee_table")
            return {"ok": True, "id": d["id"], "name": d.get("name", ""), "company_name": d.get("company_name", ""),
                    "intune_category": d.get("intune_category", ""), "super_admin": gc.is_super_admin(), "role": gc.division_role(),
                    "can_edit": bool(gc._central) and gc.data_mode != "local",
                    **{k: (list(d.get(k) or []) if k in ("sites", "access") else (d.get(k) or "")) for k in keys}}
        except Exception as e:
            return self._fail(e)

    def save_own_division(self, data: dict) -> dict:
        """Save the tenant-level fields of the active division (any user of it; role gating comes later)."""
        try:
            self._client().save_own_division(data or {})
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    # ---- pickers for the division editor (super admin; read-only) ----------------
    def intune_categories(self) -> dict:
        try:
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": True, "categories": []}
            return {"ok": True, "categories": gc.intune_categories()}
        except Exception as e:
            return self._fail(e)

    _SQL_SERVER_RE = re.compile(r"^[A-Za-z0-9_.\\-]+$")
    _SQL_DB_RE = re.compile(r"^[A-Za-z0-9_-]+$")

    def sql_discover(self, server: str, database: str = "") -> dict:
        """Read-only: databases on a server, or tables of one database. Fills the editor's dropdowns."""
        try:
            gc = self._client()
            srv, db = (server or "").strip(), (database or "").strip()
            own = (gc.division.get("sql_server") or "").strip().lower()
            if not gc.is_super_admin() and not (gc.division_role() == "admin" and srv and srv.lower() == own):
                return {"ok": True, "items": []}            # tenants may browse only their own division's server
            if not self._SQL_SERVER_RE.match(srv):
                return {"ok": False, "error": "Server name has unexpected characters."}
            if db and not self._SQL_DB_RE.match(db):
                return {"ok": False, "error": "Database name has unexpected characters."}
            from sqltools import run
            if db:
                r = run(srv, db, "SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS n FROM INFORMATION_SCHEMA.TABLES "
                                 "WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY 1")
            else:
                r = run(srv, "master", "SELECT name AS n FROM sys.databases WHERE HAS_DBACCESS(name) = 1 "
                                       "AND database_id > 4 ORDER BY name")
            if "__error__" in r:
                return {"ok": False, "error": r["__error__"]}
            return {"ok": True, "items": [str(x.get("n") or "") for x in r.get("rows", []) if x.get("n")]}
        except Exception as e:
            return self._fail(e)

    def get_flags(self) -> dict:
        """UI switches. auto_sync=False (env NBG_NO_AUTOSYNC=1 or config.json "auto_sync": false) stops the
        launch-time background sync, so opening the app to look around writes nothing."""
        try:
            off = os.environ.get("NBG_NO_AUTOSYNC", "").strip() not in ("", "0", "false", "False")
            gc = self._client()
            cfg_off = gc._base_cfg.get("auto_sync") is False
            master_off = (gc.get_setting("auto_sync", "") or "").strip().lower() in ("off", "false", "no", "0")
            return {"ok": True, "auto_sync": not (off or cfg_off or master_off)}
        except Exception as e:
            return self._fail(e)

    # ---- data mode: live production vs local snapshot sandbox --------------
    def get_data_mode(self) -> dict:
        try:
            gc = self._client()
            return {"ok": True, "mode": gc.data_mode, "snapshot": gc._ls().info(),
                    "has_snapshot": gc._ls().has_snapshot()}
        except Exception as e:
            return self._fail(e)

    def pull_prod_snapshot(self) -> dict:
        """READ-ONLY pull of production lists + hub folder into the local sandbox."""
        try:
            gc = self._client()
            gc.sign_in(interactive=True)
            with self._work():
                info = gc.clone_for_snapshot().snapshot_prod()      # own state: live client untouched
            return {"ok": True, **info}
        except Exception as e:
            return self._fail(e)

    def set_data_mode(self, mode: str) -> dict:
        """Switch between "live" (production) and "local" (snapshot; all writes stay on
        this machine). Local needs a snapshot first."""
        try:
            gc = self._client()
            gc.set_data_mode(mode)
            self._hub = None
            return {"ok": True, "mode": gc.data_mode}
        except Exception as e:
            return self._fail(e)

    # ---- divisions (tenants) ----------------------------------------------
    def get_divisions(self) -> dict:
        """Divisions the registry offers + the active one (UI switcher)."""
        try:
            import divisions
            gc = self._client()
            if not gc.account_upn:               # the account decides which divisions are visible: know it first
                try:
                    gc.sign_in(interactive=False)
                except Exception:
                    pass
            gc.refresh_registry()
            if gc._div_changed:                    # registry refresh moved the active division
                gc._div_changed = False
                self._hub = None
            vis = gc.visible_registry()
            if not getattr(self, "_default_div_applied", False) and len(vis) > 1:   # once per launch: open in the person's chosen division
                self._default_div_applied = True
                try:
                    want = (self._my_prefs().get("default_division") or "")
                    if want and want != gc.division["id"] and want in [d["id"] for d in vis]:
                        gc.set_division(want)
                        self._hub = None
                except Exception:
                    pass
            self._trace(f"get_divisions: account={gc.account_upn!r} role={gc.division_role()} visible={[d['id'] for d in vis]} active={gc.division['id']}")
            if not vis:
                return {"ok": False, "error": "No division is available to your account. Ask a super admin for access."}
            if gc.division["id"] not in [d["id"] for d in vis]:
                gc.set_division(vis[0]["id"])      # saved choice no longer allowed
                self._hub = None
            return {"ok": True, "current": gc.division["id"],
                    "divisions": [divisions.public(d) for d in vis]}
        except Exception as e:
            return self._fail(e)

    # ---- personal preferences (platform doc `user-prefs`, keyed by sign-in) ----
    def _my_prefs(self) -> dict:
        from hub import platform_hub_for
        gc = self._client()
        doc = platform_hub_for(gc).get_named("user-prefs") or {}
        return (doc.get("users") or {}).get((gc.account_upn or "").lower()) or {}

    def get_my_prefs(self) -> dict:
        """The signed-in person's own options: which division the app opens in (only offered with 2+ divisions)."""
        try:
            gc = self._client()
            vis = [{"id": d["id"], "name": d.get("name", d["id"])} for d in gc.visible_registry()]
            want = self._my_prefs().get("default_division", "")
            return {"ok": True, "divisions": vis, "default_division": want if want in [d["id"] for d in vis] else ""}
        except Exception as e:
            return self._fail(e)

    def save_my_prefs(self, default_division: str = "") -> dict:
        try:
            from hub import platform_hub_for
            gc = self._client()
            who = (gc.account_upn or "").lower()
            if not who:
                return {"ok": False, "error": "Sign in first."}
            want = (default_division or "").strip()
            if want and want not in [d["id"] for d in gc.visible_registry()]:
                return {"ok": False, "error": "You do not have access to that division."}
            for attempt in range(3):
                try:
                    h = platform_hub_for(gc)
                    doc = h.get_named("user-prefs") or {}
                    users = dict(doc.get("users") or {})
                    mine = dict(users.get(who) or {})
                    if want:
                        mine["default_division"] = want
                    else:
                        mine.pop("default_division", None)
                    users[who] = mine
                    h.put_named("user-prefs", {"users": users})
                    break
                except HubConflict:
                    if attempt == 2:
                        raise
            return {"ok": True, "default_division": want}
        except Exception as e:
            return self._fail(e)

    def switch_division(self, div_id: str) -> dict:
        """Make `div_id` the active division. Local-only (no production writes): resets
        the Graph/Hub caches so the next call reads the new division's site and data."""
        try:
            import divisions
            gc = self._client()
            if self._busy:
                return {"ok": False, "error": "A sync is still running. Wait for it to finish, then switch division."}
            gc.refresh_registry()
            if div_id not in [d["id"] for d in gc.visible_registry()]:
                return {"ok": False, "error": f"Unknown division or no access: {div_id}"}
            gc.set_division(div_id)
            self._hub = None
            return {"ok": True, "current": div_id, "division": divisions.public(gc.division)}
        except Exception as e:
            return self._fail(e)

    @staticmethod
    def _fail(e: Exception) -> dict:
        return {"ok": False, "error": str(e)}

    # ---- session ----------------------------------------------------------
    def get_status(self) -> dict:
        try:
            gc = self._client()
            gc.sign_in(interactive=False)
            self._trace(f"get_status: signed in as {gc.account_upn!r}")
            return {"ok": True, "signed_in": True, "account": gc.account_name, "upn": gc.account_upn}
        except Exception:
            return {"ok": True, "signed_in": False, "account": None}

    # ---- version / client registry ---------------------------------------
    def app_version(self) -> dict:
        try:
            from version import APP_VERSION
        except Exception:
            APP_VERSION = "?"
        return {"ok": True, "version": APP_VERSION}

    def register_client(self) -> dict:
        """Record this machine + user + version to the shared hub on launch."""
        try:
            from version import APP_VERSION
        except Exception:
            APP_VERSION = "?"
        try:
            self._hubc().record_client(APP_VERSION)
        except Exception:
            pass
        return {"ok": True, "version": APP_VERSION}

    def get_clients(self) -> dict:
        try:
            return {"ok": True, "clients": self._hubc().get_clients()}
        except Exception as e:
            return self._fail(e)

    def sign_in(self) -> dict:
        try:
            gc = self._client()
            gc.sign_in(interactive=True)
            return {"ok": True, "account": gc.account_name}
        except Exception as e:
            return self._fail(e)

    def sign_out(self) -> dict:
        try:
            self._client().sign_out()
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    # ---- dashboard --------------------------------------------------------
    def get_inventory(self) -> dict:
        try:
            gc = self._client()
            all_stock = gc.get_new_stock()
            in_use = gc.get_in_use()
            try:
                snaps = self._hubc().get_boneyard()
            except Exception:
                snaps = {}
            in_stock, boneyard = [], []
            for r in all_stock:
                if (r.get("status") or "").strip().lower() == "boneyard":
                    snap = snaps.get((r.get("serial") or "").strip().upper(), {})
                    boneyard.append({**r, "device_name": snap.get("device_name", ""),
                                     "user": snap.get("user", ""), "last_checkin": snap.get("last_checkin", ""),
                                     "moved_at": snap.get("moved_at", ""), "moved_by": snap.get("moved_by", ""),
                                     "reason": snap.get("reason", "")})
                else:
                    in_stock.append(r)
            return {"ok": True, "new_stock": in_stock, "in_use": in_use, "boneyard": boneyard,
                    "counts": {"new_stock": len(in_stock), "in_use": len(in_use),
                               "boneyard": len(boneyard), "total": len(in_stock) + len(in_use)}}
        except Exception as e:
            return self._fail(e)

    # ---- add-machine wizard ----------------------------------------------
    def lookup(self, manufacturer: str, serial: str) -> dict:
        try:
            gc = self._client()
            serial = (serial or "").strip()
            if not serial:
                return {"ok": True, "status": "empty"}

            if gc.find_by_serial("new_stock", serial):
                return {"ok": True, "status": "duplicate", "where": "New Stock", "serial": serial}
            if gc.find_by_serial("in_use", serial):
                return {"ok": True, "status": "duplicate", "where": "In Use", "serial": serial}

            # Specs always come from the vendor API (Lenovo/Dell/HP), per machine.
            # Model Spec References is intentionally NOT consulted.
            vendor = gc.lookup_vendor(serial, manufacturer)
            v = vendor or {}
            if vendor:
                return {"ok": True, "status": "found", "serial": serial,
                        "manufacturer": manufacturer, "model": v.get("model", ""),
                        "cpu": v.get("cpu", ""), "ram": v.get("ram", ""),
                        "storage": v.get("storage", ""),
                        "warranty_end": v.get("warranty_end", ""),
                        "vendor_source": f"{manufacturer} API"}
            return {"ok": True, "status": "manual", "serial": serial,
                    "manufacturer": manufacturer, "model": "", "cpu": "", "ram": "",
                    "storage": "", "warranty_end": ""}
        except Exception as e:
            return self._fail(e)

    def add_machine(self, payload: dict) -> dict:
        try:
            gc = self._client()
            gc.add_new_stock(payload)
            gc.add_log("Added", payload.get("serial", ""), payload.get("model", ""),
                       actor=gc.account_name or "", details=f"Site {payload.get('site_tag', '')}".strip())
            return {"ok": True, "message": f"Added {payload.get('serial')} to New Stock."}
        except Exception as e:
            return self._fail(e)

    # ---- deploy / delete --------------------------------------------------
    def assign_machine(self, serial: str, user: str, reason: str = "") -> dict:
        """Move a machine from New Stock to In Use with an assigned user + reason."""
        try:
            gc = self._client()
            if not (user or "").strip():
                return {"ok": False, "error": "Enter the assigned user."}
            item = gc.find_by_serial("new_stock", serial)
            if not item:
                return {"ok": False, "error": f"{serial} is not in New Stock."}
            row = gc._row(item["fields"], "new_stock")
            row["user"] = user.strip()
            gc.add_in_use(row)
            gc.delete_item("new_stock", item["id"])
            details = f"Assigned to {user.strip()}." + (f" Reason: {reason.strip()}" if reason.strip() else "")
            gc.add_log("Deployed", serial, row.get("model", ""), actor=gc.account_name or "", details=details)
            return {"ok": True, "message": f"{serial} deployed to {user.strip()}."}
        except Exception as e:
            return self._fail(e)

    # ---- deploy / manufacture dates: one small hub document per division, keyed by serial ----
    def device_dates_get(self) -> dict:
        try:
            doc = self._hubc().get_named("device-dates") or {}
            return {"ok": True, "data": doc.get("dates") or {}}
        except Exception as e:
            return self._fail(e)

    def device_dates_set(self, serials, deploy=None, mfg=None) -> dict:
        """Record the deploy date and/or manufacture date (YYYY-MM-DD) for one or more devices.
        None = leave as is, "" = clear. Dates cannot be in the future."""
        try:
            import datetime
            sn = [str(s).strip() for s in ([serials] if isinstance(serials, str) else (serials or [])) if str(s).strip()]
            if not sn:
                return {"ok": False, "error": "No device selected."}
            if len(sn) > 500:
                return {"ok": False, "error": "At most 500 devices at a time."}

            def clean(v, label):
                if v is None:
                    return None
                v = str(v).strip()
                if v == "":
                    return ""
                try:
                    d = datetime.date.fromisoformat(v)
                except ValueError:
                    raise ValueError(f"{label} must be a date like 2026-09-30.")
                if d > datetime.date.today():
                    raise ValueError(f"{label} cannot be in the future.")
                if d.year < 1990:
                    raise ValueError(f"{label} looks wrong.")
                return v
            dep, mf = clean(deploy, "Deploy date"), clean(mfg, "Manufacture date")
            if dep is None and mf is None:
                return {"ok": False, "error": "Nothing to change."}
            h = self._hubc()
            for attempt in range(3):
                try:
                    doc = h.get_named("device-dates") or {}
                    dates = dict(doc.get("dates") or {})
                    for s in sn:
                        cur = dict(dates.get(s.lower()) or {})
                        for key, v in (("deploy", dep), ("mfg", mf)):
                            if v is None:
                                continue
                            if v:
                                cur[key] = v
                            else:
                                cur.pop(key, None)
                        if cur:
                            dates[s.lower()] = cur
                        else:
                            dates.pop(s.lower(), None)
                    h.put_named("device-dates", {"dates": dates})
                    break
                except Exception as ce:
                    if ce.__class__.__name__ != "HubConflict" or attempt == 2:      # someone saved first: reload and retry
                        raise
            try:
                bits = (f"deploy date {dep or 'cleared'}" if dep is not None else "") + (", " if dep is not None and mf is not None else "") + (f"manufacture date {mf or 'cleared'}" if mf is not None else "")
                h._change("Device dates", f"{self._actor() or 'NBG Hub'}: {bits} on {len(sn)} device(s)" + (f" ({', '.join(sn[:5])})" if len(sn) <= 5 else ""))
            except Exception:
                pass
            return {"ok": True, "data": dates}
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        except Exception as e:
            return self._fail(e)

    def bulk_audit(self, action: str, ok: int = 0, failed: int = 0, detail: str = "") -> dict:
        """One audit entry for a whole bulk run on the Devices page (each device is also logged by its own action)."""
        try:
            self._hubc()._change("Bulk " + str(action)[:40], f"{self._actor() or 'NBG Hub'}: {int(ok)} done, {int(failed)} failed. {str(detail)[:300]}")
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    def return_to_stock(self, serial: str, reason: str = "") -> dict:
        """Move a device from In Use back to New Stock (unassign it) instead of deleting."""
        try:
            gc = self._client()
            item = gc.find_by_serial("in_use", serial)
            if not item:
                return {"ok": False, "error": f"{serial} is not In Use."}
            row = gc._row(item["fields"], "in_use", in_use=True)
            gc.add_new_stock({
                "serial": serial, "manufacturer": row.get("manufacturer", ""), "model": row.get("model", ""),
                "site_tag": row.get("site_tag", ""), "cpu": row.get("cpu", ""), "ram": row.get("ram", ""),
                "storage": row.get("storage", ""), "warranty": row.get("warranty", ""),
            })
            gc.delete_item("in_use", item["id"])
            details = "Moved back to New Stock." + (f" Reason: {reason.strip()}" if reason.strip() else "")
            gc.add_log("Returned to Stock", serial, row.get("model", ""), actor=gc.account_name or "", details=details)
            return {"ok": True, "message": f"{serial} moved back to New Stock."}
        except Exception as e:
            return self._fail(e)

    def delete_machine(self, serial: str, reason: str = "") -> dict:
        try:
            gc = self._client()
            for key, label in (("new_stock", "New Stock"), ("in_use", "In Use")):
                item = gc.find_by_serial(key, serial)
                if item:
                    model = gc._row(item["fields"], key).get("model", "")
                    gc.delete_item(key, item["id"])
                    details = f"Removed from {label}." + (f" Reason: {reason.strip()}" if reason.strip() else "")
                    gc.add_log("Deleted", serial, model, actor=gc.account_name or "", details=details)
                    return {"ok": True, "message": f"{serial} removed."}
            return {"ok": False, "error": f"{serial} not found."}
        except Exception as e:
            return self._fail(e)

    def set_site(self, serial: str, site: str) -> dict:
        """Assign/correct the site tag on an in-stock machine."""
        try:
            gc = self._client()
            item = gc.find_by_serial("new_stock", serial)
            if not item:
                return {"ok": False, "error": f"{serial} is not in New Stock."}
            gc.update_item("new_stock", item["id"], {"site_tag": site})
            gc.add_log("Updated", serial, gc._row(item["fields"], "new_stock").get("model", ""),
                       actor=gc.account_name or "", details=f"Site set to {site}")
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    def my_site(self) -> dict:
        """Best-guess site (LTR/BRI) for the signed-in user, from their own Entra
        city/office — used to default the site when adding new stock."""
        try:
            gc = self._client()
            loc = gc.my_location()
            site = gc._city_to_site(loc.get("city", "")) or gc._city_to_site(loc.get("office", ""))
            return {"ok": True, "site": site, "city": loc.get("city", "")}
        except Exception as e:
            return self._fail(e)

    def update_stock(self, serial: str, fields: dict) -> dict:
        """Edit an in-stock device's fields (fix a mistake). `fields` maps logical
        field -> new value; only known fields are applied. Serial can be corrected
        too (it's the Title)."""
        try:
            gc = self._client()
            item = gc.find_by_serial("new_stock", serial)
            if not item:
                return {"ok": False, "error": f"{serial} is not in New Stock."}
            allowed = ("serial", "manufacturer", "model", "cpu", "ram", "storage", "warranty", "site_tag")
            upd = {k: v for k, v in (fields or {}).items() if k in allowed and v is not None}
            new_serial = (upd.get("serial") or "").strip()
            if "serial" in upd and not new_serial:
                return {"ok": False, "error": "Serial can't be blank."}
            # if renaming the serial, guard against colliding with another device
            if new_serial and new_serial.lower() != serial.lower():
                dup = gc.find_by_serial("new_stock", new_serial) or gc.find_by_serial("in_use", new_serial)
                if dup:
                    return {"ok": False, "error": f"{new_serial} already exists in inventory."}
            if not upd:
                return {"ok": True}
            gc.update_item("new_stock", item["id"], upd)
            model = upd.get("model") or gc._row(item["fields"], "new_stock").get("model", "")
            gc.add_log("Updated", new_serial or serial, model, actor=gc.account_name or "",
                       details="Edited " + ", ".join(sorted(upd.keys())))
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    # ---- NBT Sites: open an embedded web tool in its own app window -------
    def open_url_window(self, url: str, title: str = "") -> dict:
        """Open a URL in a new native pywebview window (inside the program, not
        the system browser). Used as a fallback when a portal refuses to be
        framed in an iframe."""
        try:
            import webview
            webview.create_window(title or "NBT Site", url=url,
                                  width=1200, height=820, min_size=(900, 600))
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    @staticmethod
    def _mailto_url(to, subject: str = "", body: str = "", limit: int = 1900) -> str:
        """A mailto: link for a draft. Raises ValueError for a bad address, no recipients, or a link too long for Windows."""
        import re
        from urllib.parse import quote
        addrs = [str(x).strip() for x in (to or []) if str(x).strip()]
        if not addrs:
            raise ValueError("Nobody to e-mail.")
        for x in addrs:
            if not re.fullmatch(r"[^@\s;,<>\"]+@[^@\s;,<>\"]+\.[^@\s;,<>\"]+", x):
                raise ValueError(f"'{x}' is not an e-mail address.")
        url = "mailto:" + ",".join(quote(x, safe="@") for x in addrs) + "?subject=" + quote(subject or "", safe="") + "&body=" + quote(body or "", safe="")
        if len(url) > limit:
            raise ValueError("Too many people (or too long a message) for one e-mail link.")
        return url

    def open_mailto(self, to, subject: str = "", body: str = "") -> dict:
        """Open a DRAFT in the PC's default mail app (classic or new Outlook, whichever is the default). Nothing is sent."""
        try:
            import os
            url = self._mailto_url(to, subject, body)
            os.startfile(url)
            return {"ok": True}
        except ValueError as e:
            return {"ok": False, "too_long": "Too many" in str(e), "error": str(e)}
        except Exception as e:
            return self._fail(e)

    def open_external(self, url: str) -> dict:
        """Open a URL in the user's DEFAULT system browser (Edge), which carries
        their Windows/Entra SSO — so sign-in portals auto-sign-in like normal web
        browsing. Used for sites set to 'browser' mode."""
        try:
            import webbrowser
            if not str(url or "").lower().startswith(("https://", "http://")):
                return {"ok": False, "error": "Only web addresses can be opened."}
            webbrowser.open(url)
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    def site_navigate(self, url: str, title: str = "") -> dict:
        """Navigate the MAIN window to an NBT site full-window (top-level, so
        sign-in works — an iframe can't). A "Back to NBG Hub" button is injected
        on load (see main()) to return without a separate pop-out window."""
        try:
            import webview
            self._site_view = True
            webview.windows[0].load_url(url)
            return {"ok": True}
        except Exception as e:
            self._site_view = False
            return self._fail(e)

    def site_back(self) -> dict:
        """Return the main window from an NBT site back to the app UI."""
        try:
            import webview
            self._site_view = False
            webview.windows[0].load_url(_asset("web", "index.html"))
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    # ---- log --------------------------------------------------------------
    def get_log(self) -> dict:
        try:
            return {"ok": True, "entries": self._client().get_log()}
        except Exception as e:
            return self._fail(e)

    # ---- sync -------------------------------------------------------------
    @staticmethod
    def _sync_summary(r: dict) -> dict:
        errs = [str(e)[:200] for e in (r.get("errors") or [])]
        return {"ok": not errs, "count": r.get("count", 0), "added": len(r.get("moved") or []), "updated": r.get("updated", 0),
                "deduped": r.get("deduped", 0), "errors": errs[:3]}

    @staticmethod
    def _locked(holder: dict) -> dict:
        h = {k: (holder or {}).get(k, "") for k in ("by", "machine", "started")}
        return {"ok": True, "moved": [], "added": 0, "updated": 0, "refreshed": 0, "count": 0, "skipped": 0, "deduped": 0,
                "enriched": 0, "sites": 0, "users": 0, "candidates": 0, "remaining": 0, "errors": [], "locked": h}

    def run_sync(self) -> dict:
        try:
            import synclock
            from sync import run_sync
            gc = self._client()
            res, holder = synclock.run_locked(self._hubc(), gc.account_name or "", "app", lambda: run_sync(gc, commit=True), self._sync_summary)
            return self._locked(holder) if holder is not None else {"ok": True, **res}
        except Exception as e:
            return self._fail(e)

    def get_sync_status(self) -> dict:
        """Last sync of the ACTIVE division (what the dashboard shows)."""
        try:
            import synclock
            return {"ok": True, **synclock.status(self._hubc())}
        except Exception as e:
            return self._fail(e)

    def get_sync_overview(self) -> dict:
        """Super admins: last sync of every enabled division."""
        try:
            import synclock
            from hub import hub_for
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": True, "super_admin": False, "divisions": []}
            out = []
            for d in gc.registry:
                if d.get("enabled") is False:
                    continue
                try:
                    c = gc.clone_for_snapshot()
                    c.set_division(d["id"], persist=False)
                    out.append({"id": d["id"], "name": d.get("name", d["id"]), **synclock.status(hub_for(c))})
                except Exception as e:
                    out.append({"id": d["id"], "name": d.get("name", d["id"]), "never": True, "stale": True, "error": str(e)[:200]})
            return {"ok": True, "super_admin": True, "divisions": out}
        except Exception as e:
            return self._fail(e)

    def sync_all_divisions(self) -> dict:
        """Super admins: reconcile + enrich every enabled division (manual 'sync everything'). Live data only."""
        try:
            from sync import sync_all
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": False, "error": "Only a super admin can sync every division."}
            if gc.data_mode == "local":
                return {"ok": False, "error": "Local data mode: switch to Live to sync."}
            if not gc._central:
                return {"ok": False, "error": "Syncing every division needs the central site."}
            gc.refresh_registry(force=True)
            r = sync_all(gc, commit=True)
            self._hub = None
            return {"ok": True, **r}
        except Exception as e:
            return self._fail(e)

    def enrich_inventory(self) -> dict:
        """Fill missing In Use specs/warranty from the vendor (bounded per call)."""
        try:
            import synclock
            from sync import enrich_in_use
            gc = self._client()
            res, holder = synclock.run_locked(
                self._hubc(), gc.account_name or "", "app", lambda: enrich_in_use(gc, commit=True),
                lambda r: {"enriched": r.get("enriched", 0) + r.get("sites", 0)}, merge=True)
            return self._locked(holder) if holder is not None else {"ok": True, **res}
        except Exception as e:
            return self._fail(e)

    def master_sync(self) -> dict:
        """Deliberate FULL refresh: overwrite every In Use row's Intune/Entra-sourced
        fields (primary user, specs, MFA, last check-in, OS) from source. Slower than
        the normal sync; unbounded. Driven by the 'Master sync' button."""
        try:
            from sync import master_sync
            return {"ok": True, **master_sync(self._client(), commit=True)}
        except Exception as e:
            return self._fail(e)

    def populate_mfa(self, force: bool = False) -> dict:
        """Fill the In Use 'MFA' column from each user's registered auth methods.
        Fast (MFA only); fill-when-blank unless force=True. Driven by 'Populate MFA'."""
        try:
            from sync import populate_mfa
            return {"ok": True, **populate_mfa(self._client(), commit=True, force=bool(force))}
        except Exception as e:
            return self._fail(e)

    # ---- People & MFA (one row per person; replaces the per-device MFA button) ----
    def mfa_people_get(self) -> dict:
        """The cached People & MFA list of the active division (no Entra call)."""
        try:
            return {"ok": True, "data": self._hubc().get_named("mfa-people")}
        except Exception as e:
            return self._fail(e)

    def mfa_people_refresh(self) -> dict:
        """Rebuild the People & MFA list from Entra (registration report) and the In Use devices; cache it for the division.
        Writes one small hub document, not device rows. Driven by 'Refresh from Entra'."""
        try:
            import datetime
            from sync import build_people
            gc = self._client()
            try:
                mmap = gc.mfa_registration_map(ttl=0)
            except TypeError:
                mmap = gc.mfa_registration_map()
            doc = build_people(gc, mmap)
            doc["generated_at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            doc["by"] = self._actor() or ""
            self._hubc().put_named("mfa-people", doc)
            try:
                self._hubc()._change("MFA list", f"{len(doc['people'])} people: {doc['yes']} registered, {doc['no']} not, {doc['unknown']} unknown ({doc['source']})")
            except Exception:
                pass
            return {"ok": True, "data": doc}
        except Exception as e:
            return self._fail(e)

    # ---- software inventory ----------------------------------------------
    def software_refresh(self) -> dict:
        """Pull the fleet software inventory from Intune (heavy) and cache it to the
        shared folder so normal use never re-queries. Driven by 'Refresh from Intune'."""
        try:
            gc = self._client()
            inv = gc.software_inventory()
            inv["has_dept"] = bool(getattr(gc, "_has_user_read", False))
            self._hubc().save_software(inv)
            return {"ok": True, "apps": len(inv.get("apps", [])), "devices": inv.get("devices", 0),
                    "generated_at": inv.get("generated_at", ""), "has_dept": inv["has_dept"]}
        except Exception as e:
            return self._fail(e)

    def software_get(self) -> dict:
        """Read the cached software inventory + mandatory-app rules (no Intune call)."""
        try:
            h = self._hubc()
            return {"ok": True, "data": h.get_software(), "rules": h.get_software_rules()}
        except Exception as e:
            return self._fail(e)

    @staticmethod
    def _clean_sw_auto(a) -> dict:
        """The automatic mandatory-app rule: top N apps per department, held by at least min_pct % of it, in departments
        with at least min_people people. Defaults keep the original behaviour (top 10, no minimum)."""
        a = a if isinstance(a, dict) else {}

        def num(k, default, lo, hi):
            try:
                v = int(float(a.get(k, default)))
            except (TypeError, ValueError):
                v = default
            return max(lo, min(hi, v))
        return {"top": num("top", 10, 0, 50), "min_pct": num("min_pct", 0, 0, 100), "min_people": num("min_people", 1, 1, 50)}

    def software_save_rules(self, rules: dict) -> dict:
        try:
            rules = dict(rules or {})
            h = self._hubc()
            if "auto" in rules:
                new = self._clean_sw_auto(rules["auto"])
                cur = self._clean_sw_auto((h.get_software_rules() or {}).get("auto"))
                if new != cur and self._client().division_role() not in ("super", "admin"):
                    return {"ok": False, "error": "Only division admins can change the automatic mandatory-app rules."}
                rules["auto"] = new
            return {"ok": True, **h.save_software_rules(rules, self._actor())}
        except Exception as e:
            return self._fail(e)

    # ======================================================================
    # ENDPOINT HUB (file-based; no sign-in) - the "setup runbooks" half
    # ======================================================================
    def hub_whoami(self) -> dict:
        try:
            return {"ok": True, **self._hubc().whoami()}
        except Exception as e:
            return self._fail(e)

    def hub_get_config(self) -> dict:
        """The division's checklists. When it has none yet, `seed` carries the platform TEMPLATE (or None = use the
        built-in defaults) so a new division starts from the template, not from NBGW's wording."""
        try:
            cfg = self._hubc().get_config()
            seed = None
            if not cfg:
                try:
                    from hub import template_hub_for
                    seed = template_hub_for(self._client()).get_config()
                except Exception:
                    seed = None
            return {"ok": True, "config": cfg, "seed": seed}
        except Exception as e:
            return self._fail(e)

    def hub_get_template_config(self) -> dict:
        """The platform template checklists (None = never customised; the built-in defaults apply)."""
        try:
            from hub import template_hub_for
            return {"ok": True, "config": template_hub_for(self._client()).get_config()}
        except Exception as e:
            return self._fail(e)

    def hub_save_template_config(self, config: dict, meta: dict = None) -> dict:
        """Super admins only."""
        try:
            from hub import template_hub_for
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": False, "error": "Only a super admin can change the template checklists."}
            if not isinstance(config, dict) or not all(k in config for k in ("user", "computerBase", "departments")):
                return {"ok": False, "error": "That is not a checklist set."}
            template_hub_for(gc).save_config(config, meta or {})
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    def hub_save_config(self, config: dict, meta: dict = None) -> dict:
        try:
            self._hubc().save_config(config, meta or {})
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    def hub_get_setups(self) -> dict:
        try:
            return {"ok": True, "setups": self._hubc().get_setups()}
        except Exception as e:
            return self._fail(e)

    def hub_save_setup(self, entry: dict, html: str = "", filename: str = "") -> dict:
        try:
            return {"ok": True, **self._hubc().save_setup(entry, html, filename)}
        except Exception as e:
            return self._fail(e)

    def reservation_options(self, exclude_setup_id: str = "") -> dict:
        """Available stock devices to reserve for a computer setup, grouped by the
        SAME department buckets as the In Stock By Department tile (model->dept map).
        Excludes devices already reserved by OTHER setups; keeps this setup's own
        reservation so it stays selectable."""
        try:
            gc = self._client()
            gc.sign_in(interactive=False)
        except Exception:
            return {"ok": False, "error": "Sign in on the Dashboard to reserve from stock."}
        try:
            new_stock = gc.get_new_stock()
        except Exception as e:
            return self._fail(e)
        hubc = self._hubc()
        try:
            dept_map = (hubc.get_model_departments() or {}).get("map") or {}
        except Exception:
            dept_map = {}
        try:
            reservations = hubc.active_reservations() or {}
        except Exception:
            reservations = {}
        by_dept = {}
        for r in new_stock:
            serial = (r.get("serial") or "").strip()
            if not serial:
                continue
            resv = reservations.get(serial)
            if resv and resv.get("setup_id") != exclude_setup_id:
                continue   # held by another setup — not available
            dep = dept_map.get((r.get("model") or "").strip()) or "Unassigned"
            by_dept.setdefault(dep, []).append(
                {"serial": serial, "model": r.get("model", ""), "site": r.get("site_tag", "")})
        for lst in by_dept.values():
            lst.sort(key=lambda x: (x.get("model", ""), x.get("serial", "")))
        return {"ok": True, "by_dept": by_dept}

    # ---- hot spares (imaged, ready-to-deploy loaners) --------------------
    def _enrich_hot_spares(self, gc, in_use, new_stock) -> list:
        """Join the hub's hot-spare records with live device data: cpu/ram/warranty
        from the SharePoint lists, and model/OS/last check-in/compliance from Intune
        (one cached bulk call). Also computes stale-check-in and non-compliance flags."""
        spares = self._hubc().get_hot_spares()
        if not spares:
            return []
        sp = {}
        for r in in_use:
            s = (r.get("serial") or "").strip().upper()
            if s:
                sp[s] = (r, "In Use")
        for r in new_stock:
            s = (r.get("serial") or "").strip().upper()
            if s and s not in sp:
                sp[s] = (r, "In Stock")
        try:
            idev = gc.intune_device_map()
        except Exception:
            idev = {}
        today = date.today()
        out = []
        for hs in spares:
            serial = (hs.get("serial") or "").strip()
            su = serial.upper()
            sprec, src = sp.get(su, (None, None))
            sprec = sprec or {}
            irec = idev.get(su) or {}
            last_checkin = irec.get("last_checkin") or sprec.get("last_checkin") or ""
            compliance = irec.get("compliance") or ""
            lc = (last_checkin or "")[:10]
            stale_days = None
            if lc:
                try:
                    stale_days = (today - date.fromisoformat(lc)).days
                except ValueError:
                    stale_days = None
            found = src if (irec and src) else ("Intune" if irec else (src or "Not found"))
            out.append({
                "id": hs.get("id"), "serial": serial,
                "hostname": hs.get("hostname") or irec.get("device_name") or sprec.get("device_name") or "",
                "site": (hs.get("site") or "").upper(), "dept": hs.get("dept") or "Other",
                "notes": hs.get("notes") or "",
                "added_by": hs.get("added_by", ""), "added_at": hs.get("added_at", ""),
                "updated_by": hs.get("updated_by", ""), "updated_at": hs.get("updated_at", ""),
                "model": irec.get("model") or sprec.get("model") or "",
                "cpu": sprec.get("cpu") or "", "ram": sprec.get("ram") or "",
                "storage": irec.get("storage") or sprec.get("storage") or "",
                "os_version": irec.get("os_version") or sprec.get("os_version") or "",
                "os_install": irec.get("os_install") or sprec.get("os_install") or "",
                "last_checkin": last_checkin, "warranty": sprec.get("warranty") or "",
                "compliance": compliance,
                "stale": bool(stale_days is not None and stale_days > self._stale_limit()),
                "stale_days": stale_days,
                "noncompliant": compliance.lower() not in ("", "compliant", "unknown", "configmanager"),
                "found_in": found,
            })
        return out

    def get_hot_spares(self) -> dict:
        try:
            gc = self._client()
            gc.sign_in(interactive=False)
            in_use = gc.get_in_use()
            new_stock = gc.get_new_stock()
            return {"ok": True, "spares": self._enrich_hot_spares(gc, in_use, new_stock)}
        except Exception:
            # not signed in / Graph unavailable — still return the raw records so the
            # tile shows what's logged (no live specs/compliance yet).
            try:
                raw = self._hubc().get_hot_spares()
                return {"ok": True, "offline": True,
                        "spares": [{**r, "found_in": "—", "stale": False, "noncompliant": False} for r in raw]}
            except Exception as e:
                return self._fail(e)

    def add_hot_spare(self, entry: dict) -> dict:
        try:
            return {"ok": True, **self._hubc().add_hot_spare(entry, self._actor())}
        except Exception as e:
            return self._fail(e)

    def update_hot_spare(self, spare_id: str, fields: dict) -> dict:
        try:
            return self._hubc().update_hot_spare(spare_id, fields or {}, self._actor())
        except Exception as e:
            return self._fail(e)

    def remove_hot_spare(self, spare_id: str, reason: str = "") -> dict:
        try:
            return self._hubc().remove_hot_spare(spare_id, reason, self._actor())
        except Exception as e:
            return self._fail(e)

    def locate_devices(self, devices: list) -> dict:
        """For each {serial, hostname}, report where it still LIVES — on-prem AD
        (bg.nucorsteel.local), Entra, and Intune. Used by the 'No Intune check-in'
        drill so you can tell at a glance whether a stale device is a real orphan
        (gone from AD) or just quiet. All three checks degrade independently:
        AD needs domain reachability, Entra needs Directory.Read.All, Intune needs
        sign-in — each simply reports 'unknown' when its source isn't available."""
        devices = devices or []
        hostnames = [(d.get("hostname") or "").strip() for d in devices]
        serials = [(d.get("serial") or "").strip() for d in devices]
        # --- Intune + Entra (Graph) ---
        intune, entra, entra_state, intune_ok = {}, {}, "off", False
        try:
            gc = self._client()
            gc.sign_in(interactive=False)
            try:
                intune = gc.intune_presence_map(serials)   # any-category, by serial
                intune_ok = True
            except Exception:
                intune = {}
            if gc._has_dir_read:
                try:
                    entra = gc.entra_device_map(hostnames)
                    entra_state = "on"
                except Exception:
                    entra_state = "error"
            else:
                entra_state = "needs Directory.Read.All"
        except Exception:
            entra_state = "signed out"
        # --- on-prem AD (PowerShell / DirectorySearcher) ---
        try:
            from adlookup import ad_lookup
            domain = (self._client().cfg.get("ad_domain") or "")
            if not domain:
                raise RuntimeError("No AD domain is configured for this division.")
            ad = ad_lookup(hostnames, domain)
        except Exception as e:
            ad = {"__error__": str(e)}
        ad_error = ad.pop("__error__", None) if isinstance(ad, dict) else None
        out = []
        for d in devices:
            serial = (d.get("serial") or "").strip()
            host = (d.get("hostname") or "").strip()
            skey = serial.upper()
            in_intune = bool(serial) and skey in intune
            erec = entra.get(host.lower()) if host else None
            arec = ad.get(host.lower()) if host else None
            out.append({
                "serial": serial, "hostname": host,
                "in_intune": in_intune, "intune_last_sync": (intune.get(skey) or "")[:10],
                "in_entra": bool(erec), "entra_enabled": (erec or {}).get("enabled"),
                "entra_last_signin": (erec or {}).get("last_signin", ""),
                "in_ad": bool(arec and arec.get("found")), "ad_enabled": (arec or {}).get("enabled"),
                "ad_last_logon": (arec or {}).get("last_logon", ""), "ad_ou": (arec or {}).get("dn", ""),
            })
        return {"ok": True, "devices": out, "entra_state": entra_state, "intune_ok": intune_ok,
                "ad_error": ad_error, "ad_domain": (self._client().cfg.get("ad_domain") or "")}

    # ---- Boneyard: retire devices gone from AD + Entra + Intune -----------
    def _boneyard_move(self, gc, serial: str, snap: dict) -> bool:
        """Move an In Use device to New Stock with Status=Boneyard, and record the
        display snapshot (former hostname/user/last-seen) in the hub. Returns True on move."""
        item = gc.find_by_serial("in_use", serial)
        if not item:
            return False
        row = gc._row(item["fields"], "in_use", in_use=True)
        gc.add_new_stock({"serial": serial, "manufacturer": row.get("manufacturer", ""),
                          "model": row.get("model", ""), "site_tag": row.get("site_tag", ""),
                          "cpu": row.get("cpu", ""), "ram": row.get("ram", ""),
                          "storage": row.get("storage", ""), "warranty": row.get("warranty", ""),
                          "status": "Boneyard"})
        gc.delete_item("in_use", item["id"])
        try:
            self._hubc().set_boneyard(serial, snap)
        except Exception:
            pass
        gc.add_log("Boneyard", serial, row.get("model", ""), actor=gc.account_name or "",
                   details="Auto-retired to Boneyard: not found in AD, Entra, or Intune.")
        return True

    def restore_boneyard(self, serial: str) -> dict:
        """Bring a device back from Boneyard: flip its New Stock Status back to Stock."""
        try:
            gc = self._client()
            item = gc.find_by_serial("new_stock", serial)
            if not item:
                self._hubc().remove_boneyard(serial)
                return {"ok": False, "error": f"{serial} not found in New Stock."}
            gc.update_item("new_stock", item["id"], {"status": "Stock"})
            self._hubc().remove_boneyard(serial)
            gc.add_log("Restored", serial, gc._row(item["fields"], "new_stock").get("model", ""),
                       actor=gc.account_name or "", details="Restored from Boneyard to Stock.")
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    def boneyard_sweep(self, dry_run: bool = False) -> dict:
        """Auto-retire In Use devices that are gone from ALL THREE of AD, Entra and
        Intune (stale 30+ days = the only candidates that can be absent from Intune),
        and self-heal — restore any boneyarded device that has come back to life.

        SAFETY: moves nothing unless all three sources were actually verifiable this
        run (AD reachable, Entra scope granted, Intune query ok) and the New Stock
        Status column exists. Any doubt -> skip. All moves are logged and reversible."""
        try:
            gc = self._client()
            gc.sign_in(interactive=False)
        except Exception:
            return {"ok": False, "error": "Sign in required."}
        if not gc._internal_for("new_stock", "status"):
            return {"ok": True, "skipped": "New Stock has no Status column", "added": [], "restored": []}
        try:
            in_use = gc.get_in_use()
            all_stock = gc.get_new_stock()
        except Exception as e:
            return self._fail(e)
        today = date.today()

        def _stale(r):
            lc = (r.get("last_checkin") or "")[:10]
            if not lc:
                return False
            try:
                return (today - date.fromisoformat(lc)).days > 30
            except ValueError:
                return False

        candidates = [r for r in in_use if _stale(r)]
        boneyard_rows = [r for r in all_stock if (r.get("status") or "").strip().lower() == "boneyard"]
        snaps = self._hubc().get_boneyard()

        # CONTROL devices: In Use machines that checked into Intune in the last 10 days
        # are certainly still alive and (for bg-domain machines) present in on-prem AD.
        # We look them up too; if AD can't find ANY of them, its specific lookups aren't
        # returning real data right now, so we skip rather than trust a "not found" on a
        # candidate. This replaces the old "find my own PC" gate, which failed on an
        # Entra-joined admin PC even though AD lookups of real devices work fine.
        def _fresh(r):
            lc = (r.get("last_checkin") or "")[:10]
            if not lc:
                return False
            try:
                return (today - date.fromisoformat(lc)).days <= 10
            except ValueError:
                return False
        _bg = [r for r in in_use if _fresh(r) and (r.get("device_name") or "").strip().upper().startswith("BG")]
        controls = (_bg or [r for r in in_use if _fresh(r) and (r.get("device_name") or "").strip()])[:8]
        control_serials = {(r.get("serial") or "").strip().upper() for r in controls}

        checkset = [{"serial": r.get("serial", ""), "hostname": r.get("device_name", "")} for r in candidates]
        checkset += [{"serial": r.get("serial", ""),
                      "hostname": snaps.get((r.get("serial") or "").strip().upper(), {}).get("device_name", "")}
                     for r in boneyard_rows]
        checkset += [{"serial": r.get("serial", ""), "hostname": r.get("device_name", "")} for r in controls]
        if not candidates and not boneyard_rows:
            return {"ok": True, "added": [], "restored": [], "dry_run": dry_run}
        loc = self.locate_devices(checkset)
        # Safety guards — if any source couldn't be checked, do nothing.
        if loc.get("ad_error"):
            return {"ok": True, "skipped": "AD unavailable: " + str(loc["ad_error"]), "added": [], "restored": []}
        if loc.get("entra_state") != "on":
            return {"ok": True, "skipped": "Entra not checkable (" + str(loc.get("entra_state")) + ")", "added": [], "restored": []}
        if not loc.get("intune_ok"):
            return {"ok": True, "skipped": "Intune query failed", "added": [], "restored": []}
        by = {(d.get("serial") or "").strip().upper(): d for d in loc.get("devices", [])}
        # Authoritativeness: AD must find at least one known-active control device,
        # else its cn= lookups aren't reliable right now -> don't trust any "not found".
        if control_serials:
            if not any((by.get(s) or {}).get("in_ad") for s in control_serials):
                return {"ok": True, "added": [], "restored": [],
                        "skipped": "AD lookups not returning known-active devices — not trusting 'not found' this run."}
        added, restored, now = [], [], datetime.now().isoformat()
        for r in candidates:
            d = by.get((r.get("serial") or "").strip().upper())
            if d and not d["in_ad"] and not d["in_entra"] and not d["in_intune"]:
                if not dry_run:
                    self._boneyard_move(gc, r.get("serial", ""), {
                        "device_name": r.get("device_name", ""), "user": r.get("user", ""),
                        "last_checkin": r.get("last_checkin", ""), "model": r.get("model", ""),
                        "site": r.get("site_tag", ""), "moved_at": now,
                        "moved_by": gc.account_name or "auto-sync",
                        "reason": "Not in AD, Entra, or Intune"})
                added.append({"serial": r.get("serial", ""), "device_name": r.get("device_name", ""), "model": r.get("model", "")})
        for r in boneyard_rows:
            d = by.get((r.get("serial") or "").strip().upper())
            if d and (d["in_ad"] or d["in_entra"] or d["in_intune"]):
                if not dry_run:
                    self.restore_boneyard(r.get("serial", ""))
                restored.append({"serial": r.get("serial", "")})
        return {"ok": True, "added": added, "restored": restored, "dry_run": dry_run}

    # ---- BG Tools: Timesheet Fix (SQL, integrated auth) ------------------
    def _ts_server(self) -> str:
        srv = (self._client().cfg.get("timesheet_sql_server") or "").strip()
        if not srv:        # never fall back to another division's server
            raise RuntimeError("Timesheet is not configured for this division (no SQL server in its settings).")
        return srv

    @staticmethod
    def _sql_ident(name: str) -> str:
        """[schema].[table] from 'schema.table'/'table'; rejects anything but letters, digits, underscores."""
        parts = (name or "").strip().split(".")
        if not parts or len(parts) > 2 or not all(re.match(r"^[A-Za-z0-9_]+$", p) for p in parts):
            raise RuntimeError(f"Bad SQL name '{name}'.")
        return ".".join(f"[{p}]" for p in parts)

    def _ts_conf(self) -> dict:
        """Server + database/table names for THIS division. Every part is required (no cross-division defaults)."""
        cfg = self._client().cfg
        server = self._ts_server()
        out = {"server": server}
        for key, label in (("timesheet_db", "timesheet database"), ("timesheet_table", "timesheet table"),
                           ("employee_db", "employee database"), ("employee_table", "employee table")):
            v = (cfg.get(key) or "").strip()
            if not v:
                raise RuntimeError(f"Timesheet is not fully configured for this division (missing {label}).")
            out[key] = v
        if not re.match(r"^[A-Za-z0-9_\-]+$", out["timesheet_db"]) or \
                not re.match(r"^[A-Za-z0-9_\-]+$", out["employee_db"]):
            raise RuntimeError("Database names may only contain letters, digits, - and _.")
        out["ts_table"] = self._sql_ident(out["timesheet_table"])
        out["emp_table"] = self._sql_ident(out["employee_table"])
        return out

    def ts_search(self, query: str) -> dict:
        """Find employees by first or last name in the division's employee table."""
        q = (query or "").strip()
        if len(q) < 2:
            return {"ok": True, "employees": []}
        try:
            from sqltools import run
            c = self._ts_conf()
            r = run(c["server"], c["employee_db"],
                    "SELECT TOP 25 EmployeeID, FirstName, LastName, Department "
                    f"FROM {c['emp_table']} WHERE FirstName LIKE @q OR LastName LIKE @q "
                    "ORDER BY LastName, FirstName", {"q": f"%{q}%"})
            if "__error__" in r:
                return {"ok": False, "error": r["__error__"]}
            emps = [{"employid": (x.get("EmployeeID") or "").strip(),
                     "first": x.get("FirstName", ""), "last": x.get("LastName", ""),
                     "dept": x.get("Department", "")} for x in r.get("rows", [])]
            return {"ok": True, "employees": [e for e in emps if e["employid"]]}
        except Exception as e:
            return self._fail(e)

    def ts_weeks(self, employid: str) -> dict:
        """Last 8 weeks' lock status for an employee from the division's timesheet WeekLocked table."""
        emp = (employid or "").strip()
        if not emp:
            return {"ok": False, "error": "No employee id."}
        try:
            from sqltools import run
            c = self._ts_conf()
            r = run(c["server"], c["timesheet_db"],
                    f"SELECT TOP 8 FiscalYear, FiscalWeek, Locked FROM {c['ts_table']} "
                    "WHERE EmployID = @emp ORDER BY FiscalYear DESC, FiscalWeek DESC", {"emp": emp})
            if "__error__" in r:
                return {"ok": False, "error": r["__error__"]}
            weeks = [{"fiscal_year": int(x.get("FiscalYear") or 0),
                      "fiscal_week": int(x.get("FiscalWeek") or 0),
                      "locked": str(x.get("Locked", "")).strip().lower() in ("true", "1")}
                     for x in r.get("rows", [])]
            return {"ok": True, "weeks": weeks}
        except Exception as e:
            return self._fail(e)

    def ts_unlock(self, employid: str, fiscal_year, fiscal_week) -> dict:
        """Unlock one week: set Locked = 0. Only touches a currently-locked row, stamps
        ModifiedBy/ModifiedDate, and writes a shared audit entry."""
        emp = (employid or "").strip()
        try:
            fy, fw = int(fiscal_year), int(fiscal_week)
        except (TypeError, ValueError):
            return {"ok": False, "error": "Bad fiscal year/week."}
        if not emp:
            return {"ok": False, "error": "No employee id."}
        actor = (self._actor() or "NBG Hub")[:60]
        if self._client().data_mode == "local":
            return {"ok": False, "error": "Local data mode: Timesheet unlock writes to the production SQL "
                                          "server, so it is disabled. Switch to Live to unlock."}
        try:
            from sqltools import run
            # Only flip Locked — leave ModifiedBy/ModifiedDate as they were (per request).
            # Who unlocked it is still captured in the shared hub audit log below.
            c = self._ts_conf()
            r = run(c["server"], c["timesheet_db"],
                    f"UPDATE {c['ts_table']} SET Locked = 0 "
                    "WHERE EmployID = @emp AND FiscalYear = @fy AND FiscalWeek = @fw AND Locked = 1",
                    {"emp": emp, "fy": fy, "fw": fw}, nonquery=True)
            if "__error__" in r:
                return {"ok": False, "error": r["__error__"]}
            n = int(r.get("affected", 0))
            try:
                self._hubc()._change("Timesheet unlock",
                                     f"EmployID {emp} · FY{fy} W{fw} unlocked by {actor} ({n} row).")
            except Exception:
                pass
            return {"ok": True, "affected": n}
        except Exception as e:
            return self._fail(e)

    # ---- BG Tools: Delete coil card (CoilCard DB, integrated auth) ----------
    def coil_card_find(self, nbs: str) -> dict:
        """Read-only dry run: card details + how many CoilTracking rows would go with it."""
        try:
            import coilcards
            c = coilcards.conf(self._client())
            srv = self._ts_server()
            return {"ok": True, "server": srv, "db": c["coilcard_db"], **coilcards.preview(srv, c, nbs)}
        except Exception as e:
            return self._fail(e)

    def coil_card_delete(self, nbs: str, confirm: str = "", commit: bool = False) -> dict:
        """Delete a coil card and its CoilTracking rows in one transaction. `confirm` must equal the
        card number. Rows are saved to the Hub Files library (and read back) first; one audit entry per run."""
        try:
            import coilcards
            gc = self._client()
            nbs = coilcards.clean_nbs(nbs)
            if not commit:
                return self.coil_card_find(nbs)
            if (confirm or "").strip() != nbs:
                return {"ok": False, "error": "Type the card number exactly to confirm."}
            if gc.data_mode == "local":
                return {"ok": False, "error": "Local data mode: Delete Coil Card writes to the production SQL "
                                              "server, so it is disabled. Switch to Live."}
            actor = (self._actor() or "NBG Hub")[:60]
            hub = self._hubc()
            r = coilcards.delete(self._ts_server(), coilcards.conf(gc), nbs,
                                 hub.put_attachment, hub.get_attachment)
            card = r["card"]
            try:
                self._hubc()._change("Coil card deleted",
                                     f"{nbs} (part {card.get('PartNumber', '')}, heat {card.get('HeatNumber', '')}) deleted by "
                                     f"{actor}: {r['cards']} card, {r['tracking']} tracking rows. Backup: {r['backup']}")
            except Exception:
                pass
            return {"ok": True, "cards": r["cards"], "tracking": r["tracking"], "backup": r["backup"]}
        except Exception as e:
            return self._fail(e)

    def coil_card_backups(self) -> dict:
        """Coil card backup files in the Hub Files library, newest first."""
        try:
            import coilcards
            out = []
            for b in self._hubc().list_attachments(coilcards.PREFIX):
                m = re.match(r"^coilcard-backup-(.+)-(\d{8}-\d{6})\.json$", b["name"])
                out.append({**b, "nbs": m.group(1) if m else "", "stamp": m.group(2) if m else ""})
            return {"ok": True, "backups": out}
        except Exception as e:
            return self._fail(e)

    def coil_card_restore(self, name: str, confirm: str = "", commit: bool = False) -> dict:
        """Put a deleted card and its tracking rows back from a backup file. Dry run unless commit;
        `confirm` must equal the card number. Refuses if the card or its tracking rows exist."""
        try:
            import coilcards
            gc = self._client()
            hub = self._hubc()
            data = coilcards.read_backup(name, hub.get_attachment)
            c = coilcards.conf(gc)
            plan = coilcards.restore_plan(self._ts_server(), c, data)
            if not commit:
                return {"ok": True, **plan}
            if (confirm or "").strip() != plan["nbs"]:
                return {"ok": False, "error": "Type the card number exactly to confirm."}
            if gc.data_mode == "local":
                return {"ok": False, "error": "Local data mode: Restore Coil Card writes to the production SQL "
                                              "server, so it is disabled. Switch to Live."}
            actor = (self._actor() or "NBG Hub")[:60]
            r = coilcards.restore(self._ts_server(), c, data)
            try:
                hub._change("Coil card restored",
                            f"{r['nbs']} restored by {actor} from {name}: {r['cards']} card, {r['tracking']} tracking rows.")
            except Exception:
                pass
            return {"ok": True, "cards": r["cards"], "tracking": r["tracking"], "nbs": r["nbs"]}
        except Exception as e:
            return self._fail(e)

    # ---- BG Tools: Copy permissions (on-prem AD groups) -------------------
    def _ad_perm_gate(self):
        gc = self._client()
        if gc.division_role() not in ("super", "admin"):
            raise PermissionError("Copy permissions is for admins.")
        try:
            dc = ((gc.master_settings().get("ad_domain_controller") or {}).get("value") or "").strip()
        except Exception:
            dc = ""
        return dc or (gc.cfg.get("ad_domain") or "bg.nucorsteel.local")      # one named server = writes are visible at once

    def ad_user_search(self, q: str, all_divisions: bool = False) -> dict:
        """People search; limited to the ACTIVE division's AD company unless all_divisions (Rule 6)."""
        try:
            domain = self._ad_perm_gate()
            import adperms
            d = self._client().division or {}
            cos = [] if all_divisions else [d.get("name", ""), d.get("company_name", "")]
            r = adperms.search_users(q, domain, cos)
            if "__error__" in r:
                return {"ok": False, "error": r["__error__"]}
            return {"ok": True, "users": r["users"]}
        except Exception as e:
            return self._fail(e)

    def ad_smartcard_accounts(self) -> dict:
        """Admin accounts found on the inserted YubiKey / smart card (certificate UPNs), to pick from instead of typing."""
        try:
            self._ad_perm_gate()
            import adperms
            r = adperms.smartcard_accounts()
            if "__error__" in r:
                return {"ok": False, "error": r["__error__"]}
            return {"ok": True, "accounts": r["accounts"]}
        except Exception as e:
            return self._fail(e)

    def ad_perm_compare(self, src_dn: str, dst_dn: str) -> dict:
        try:
            domain = self._ad_perm_gate()
            import adperms
            if not src_dn or not dst_dn or src_dn.lower() == dst_dn.lower():
                return {"ok": False, "error": "Pick two different people."}
            s, d = adperms.user_groups(src_dn, domain), adperms.user_groups(dst_dn, domain)
            for r in (s, d):
                if "__error__" in r:
                    return {"ok": False, "error": r["__error__"]}
            c = adperms.compare(s["groups"], d["groups"])
            return {"ok": True, "src_count": len(s["groups"]), "dst_count": len(d["groups"]), **c}
        except Exception as e:
            return self._fail(e)

    def ad_perm_copy(self, src_dn: str, dst_dn: str, group_dns, account: str = "", commit: bool = False) -> dict:
        """Add the destination user to the chosen groups the source user is in. Dry run unless commit: the write runs under
        the admin's own smart card account (runas /netonly /smartcard). Re-reads AD afterwards and logs one audit entry."""
        try:
            domain = self._ad_perm_gate()
            import adperms
            group_dns = list(group_dns or [])
            if not src_dn or not dst_dn or src_dn.lower() == dst_dn.lower():
                return {"ok": False, "error": "Pick two different people."}
            if not group_dns:
                return {"ok": False, "error": "Select at least one group."}
            if len(group_dns) > adperms.MAX_COPY:
                return {"ok": False, "error": f"At most {adperms.MAX_COPY} groups per copy."}
            s, d = adperms.user_groups(src_dn, domain), adperms.user_groups(dst_dn, domain)
            for r in (s, d):
                if "__error__" in r:
                    return {"ok": False, "error": r["__error__"]}
            plan = adperms.plan_copy(s["groups"], d["groups"], group_dns)
            out = {"ok": True, "committed": False, "would_add": [g["name"] for g in plan["add"]], "skipped": plan["skipped"]}
            return self._ad_apply(out, plan["add"], dst_dn, domain, account, commit,
                                  f"copied from {src_dn.split(',')[0][3:]}")
        except Exception as e:
            return self._fail(e)

    def _ad_apply(self, out: dict, add: list, dst_dn: str, domain: str, account: str, commit: bool, how: str) -> dict:
        """Shared tail of every AD group add: dry run unless commit, then write with the YubiKey account, verify, audit."""
        import adperms
        if not commit or not add:
            return out
        if self._client().data_mode == "local":
            return {"ok": False, "error": "Local data mode: this writes to production AD, so it is disabled. Switch to Live."}
        w = adperms.write_groups(dst_dn, [g["dn"] for g in add], domain, (account or "").strip())
        if "__error__" in w:
            return {"ok": False, "error": w["__error__"]}
        names = {g["dn"]: g["name"] for g in add}
        import time
        written = [x for x in w["done"] if x in names]
        have = None
        for attempt in range(3):                       # another domain controller may answer before the write has replicated
            after = adperms.user_groups(dst_dn, w.get("dc") or domain)      # ask the controller that took the write first
            have = {g["dn"].lower() for g in after.get("groups", [])} if "__error__" not in after else None
            if have is None or all(x.lower() in have for x in written):
                break
            time.sleep(2)
        added = [names[x] for x in written]            # the directory accepted these writes
        failed = [{"name": names.get(f.get("dn"), f.get("dn")), "error": f.get("error", "")} for f in w["failed"]]
        unverified = [names[x] for x in written if have is not None and x.lower() not in have]
        try:
            self._hubc()._change("AD add groups", f"{self._actor() or 'NBG Hub'} added {dst_dn.split(',')[0][3:]} to {len(added)} group(s) "
                                 f"{how} as {w.get('who') or 'admin account'} on {w.get('dc') or 'a domain controller'}: {', '.join(added)[:300]}")
        except Exception:
            pass
        out.update({"committed": True, "added": added, "failed": failed, "unverified": unverified, "who": w.get("who", ""), "dc": w.get("dc", "")})
        return out

    def ad_add_missing(self, upn: str, group_names, account: str = "", commit: bool = False) -> dict:
        """Missing Groups -> AD: add one person (by sign-in name) to the chosen groups, looked up in AD by exact name."""
        try:
            domain = self._ad_perm_gate()
            import adperms
            names = [n for n in dict.fromkeys(group_names or []) if (n or "").strip()]
            if not names:
                return {"ok": False, "error": "Select at least one group."}
            if len(names) > adperms.MAX_COPY:
                return {"ok": False, "error": f"At most {adperms.MAX_COPY} groups at a time."}
            u = adperms.find_user_by_upn(upn, domain)
            if "__error__" in u:
                return {"ok": False, "error": u["__error__"]}
            if not u.get("dn"):
                return {"ok": False, "error": f"No single on-premises AD account matches {upn}."}
            found = adperms.find_groups_by_name(names, domain)
            if "__error__" in found:
                return {"ok": False, "error": found["__error__"]}
            cur = adperms.user_groups(u["dn"], domain)
            if "__error__" in cur:
                return {"ok": False, "error": cur["__error__"]}
            have = {g["dn"].lower() for g in cur["groups"]}
            add, skipped = [], []
            for n in names:
                g = found.get(n.lower()) or {}
                if not g.get("dn"):
                    skipped.append({"name": n, "dn": "", "why": "more than one AD group has this name" if g.get("n", 0) > 1 else "no AD group with this name (cloud-only?)"})
                elif g["dn"].lower() in have:
                    skipped.append({"name": n, "dn": g["dn"], "why": "already a member"})
                else:
                    add.append({"dn": g["dn"], "name": n})
            out = {"ok": True, "committed": False, "would_add": [g["name"] for g in add], "skipped": skipped,
                   "user": {"dn": u["dn"], "name": u.get("name", ""), "sam": u.get("sam", "")}}
            return self._ad_apply(out, add, u["dn"], domain, account, commit, "from the department baseline (Missing Groups)")
        except Exception as e:
            return self._fail(e)

    # ---- BG Tools: Permissions Finder (Entra groups) ---------------------
    # BG locations to scope the user search by email domain. All live in the one Nucor
    # tenant, so this is a filter, not a tenant switch. Override in config.json via
    # "permission_locations": [{"label": "...", "domain": "..."}].
    _BG_LOCATIONS_DEFAULT = [
        {"label": "Nucor (nucor.com)", "domain": "nucor.com"},
        {"label": "American Buildings", "domain": "americanbuildings.com"},
        {"label": "CBC Steel Buildings", "domain": "cbcsteelbuildings.com"},
        {"label": "CENTRIA", "domain": "centria.com"},
        {"label": "Gulf States Mfg", "domain": "gulfstatesmanufacturers.com"},
        {"label": "Kirby Building Systems", "domain": "kirbybuildingsystems.com"},
        {"label": "Metl-Span", "domain": "metlspan.com"},
        {"label": "NBG Commercial Services", "domain": "nbgcommercialservices.com"},
        {"label": "NBG West", "domain": "nbgwest.com"},
        {"label": "Nucor Buildings Group", "domain": "nucorbuildingsgroup.com"},
        {"label": "Nucor Building Systems", "domain": "nucorbuildingsystems.com"},
        {"label": "TrueCore Panels", "domain": "truecorepanels.com"},
        {"label": "Verco Decking", "domain": "vercodeck.com"},
    ]

    # Divisions that share @nucor.com (and even department names) — told apart only by
    # Entra companyName. Values confirmed live 2026-09-29. Override in config.json via
    # "permission_divisions": [{"label": "...", "company": "..."}].
    _BG_DIVISIONS_DEFAULT = [
        {"label": "NBGW — Nucor Buildings Group West", "company": "Nucor Buildings Group West"},
        {"label": "NBGTX — NBG Terrell", "company": "NBG - Terrell"},
        {"label": "NBSIN — Waterloo", "company": "NBSIN"},
        {"label": "NBGSC — NBG Swansea", "company": "NBG - Swansea"},
    ]

    def bg_locations(self) -> dict:
        try:
            sc_ = self._scopes()
        except Exception:
            sc_ = {"brands": [], "divisions": []}
        out = [{"label": b["label"], "domain": b["domain"]} for b in sc_["brands"] if b.get("domain")]
        dout = [{"label": d["label"], "company": d["company"]} for d in sc_["divisions"] if d.get("company")]
        have = {d["company"].lower() for d in dout}
        try:                                    # every division in the registry is offered, not just the saved list
            for rd in self._client().registry:
                co = (rd.get("company_name") or "").strip()
                if co and co.lower() not in have and rd.get("enabled") is not False:
                    dout.append({"label": rd.get("name") or co, "company": co})
                    have.add(co.lower())
        except Exception:
            pass
        return {"ok": True, "locations": out, "divisions": dout,
                "nbgw_company": self._division_company()}

    def bg_user_search(self, query: str, domain: str = "", company: str = "") -> dict:
        """Find teammates by name in Entra (handles 'First Last' vs 'Last, First').
        Optional `company` scopes to one division by Entra companyName (e.g. "Nucor
        Buildings Group West" = NBGW — the only reliable way to separate NBGW from
        NBGTX/NBSIN, which share @nucor.com and department names). Optional `domain`
        scopes to a BG brand with its own email domain (American Buildings, CBC…)."""
        q = (query or "").strip()
        if len(q) < 2:
            return {"ok": True, "users": []}
        try:
            from graph import GRAPH
            from urllib.parse import quote
            gc = self._client()
            gc.sign_in(interactive=False)
            if not gc._has_dir_read:
                return {"ok": False, "error": "Needs Directory.Read.All (Entra) — ask an admin to grant it, then sign out/in."}
            term = quote('"displayName:' + q.replace('"', "") + '"')
            url = (f"{GRAPH}/users?$search={term}"
                   "&$select=id,displayName,userPrincipalName,department,companyName&$top=50")
            filters = []
            co = (company or "").strip()
            if co:
                filters.append(f"companyName eq '{self._odq(co)}'")
            dom = "".join(c for c in (domain or "").strip().lower() if c.isalnum() or c in ".-")
            if dom:
                filters.append(f"endsWith(userPrincipalName,'@{dom}')")
            if filters:
                url += f"&$filter={quote(' and '.join(filters))}&$count=true"
            r = gc._req("GET", url, headers={"ConsistencyLevel": "eventual"}).json()
            users = [{"id": u.get("id", ""), "display": u.get("displayName", ""),
                      "upn": u.get("userPrincipalName", ""), "dept": u.get("department", ""),
                      "company": u.get("companyName", "")}
                     for u in r.get("value", []) if u.get("id")]
            users.sort(key=lambda u: (u["display"] or "").lower())
            return {"ok": True, "users": users}
        except Exception as e:
            return self._fail(e)

    def bg_user_groups(self, user_id: str) -> dict:
        """All groups a user belongs to — directly (memberOf) and indirectly via nested
        groups (transitiveMemberOf) — each flagged direct vs nested."""
        uid = (user_id or "").strip()
        if not uid:
            return {"ok": False, "error": "No user selected."}
        try:
            from graph import GRAPH
            gc = self._client()
            gc.sign_in(interactive=False)
            if not gc._has_dir_read:
                return {"ok": False, "error": "Needs Directory.Read.All (Entra)."}
            direct = gc._get_all(f"{GRAPH}/users/{uid}/memberOf/microsoft.graph.group?$select=id,displayName&$top=999")
            trans = gc._get_all(f"{GRAPH}/users/{uid}/transitiveMemberOf/microsoft.graph.group?$select=id,displayName&$top=999")
            direct_ids = {g.get("id") for g in direct}
            groups = [{"name": g.get("displayName", ""), "id": g.get("id", ""),
                       "direct": g.get("id") in direct_ids} for g in trans]
            groups.sort(key=lambda g: (g["name"] or "").lower())
            return {"ok": True, "groups": groups,
                    "direct_count": len(direct_ids), "total": len(groups)}
        except Exception as e:
            return self._fail(e)

    # ---- BG Tools: Group baselines + Missing Groups ----------------------
    # Per-department "expected" groups (the ones the majority of a department holds),
    # across ALL Entra groups (not just BomsNet), derived from Entra and curated in
    # Configuration, then used by the Missing Groups tool to flag users who lack groups
    # their peers have.
    # keyword "" means ALL groups (no name filter). A non-empty keyword restricts the
    # analysis to groups whose name contains it — kept as an optional advanced filter.
    _PERM_KEYWORD_DEFAULT = ""
    _PERM_THRESHOLD_DEFAULT = 0.7
    # When analyzing ALL groups, only STORE groups held by >= this fraction of the
    # department (and by at least 2 people) — drops the long tail of one-off groups so
    # the shared baseline file + the config UI stay small. Every "expected" (>= threshold)
    # group clears this easily; it just trims low-coverage noise below the slider's range.
    _PERM_STORE_MIN_PCT = 0.2
    # SCOPE: baselines + Missing Groups are NBGW-only. Department names are NOT unique
    # across divisions — e.g. "Detailing Dept NBS" is used by NBGW (Brigham), NBSIN
    # (Waterloo) AND NBGTX (Terrell), all in the same tenant, same AD domain, same
    # @nucor.com — so neither the department nor the email domain can isolate NBGW.
    # Entra `companyName` can: every NBGW teammate is "Nucor Buildings Group West".
    # Overridable per shared baseline doc ("company") if ever needed.
    def _division_company(self) -> str:
        """Entra companyName of the active division (scopes people queries)."""
        name = (self._client().division.get("company_name") or "").strip()
        if not name:       # never default to another division's company: people queries would leak
            raise RuntimeError("This division has no Entra company name configured.")
        return name
    _PERM_MIN_MEMBERS = 5    # a "majority" baseline off fewer people isn't meaningful

    def _perm_doc(self) -> dict:
        """Load the baseline doc from the shared hub, normalized to a known shape."""
        raw = self._hubc().get_perm_baselines() or {}
        kw = raw.get("keyword")
        kw = "" if kw is None else str(kw).strip().lower()   # "" = all groups
        try:
            thr = float(raw.get("threshold"))
        except (TypeError, ValueError):
            thr = self._PERM_THRESHOLD_DEFAULT
        thr = min(max(thr, 0.0), 1.0)
        company = (raw.get("company") or self._division_company()).strip()
        depts = raw.get("departments") if isinstance(raw.get("departments"), dict) else {}
        return {"keyword": kw, "threshold": thr, "company": company, "departments": depts}

    @staticmethod
    def _odq(v: str) -> str:
        """Escape a value for an OData string literal."""
        return (v or "").replace("'", "''")

    def _users_where(self, gc, filt: str, select: str) -> list:
        """Page through /users with an advanced-query $filter (ConsistencyLevel on every
        page, which paged advanced queries require)."""
        from graph import GRAPH
        from urllib.parse import quote
        url = f"{GRAPH}/users?$filter={quote(filt)}&$select={select}&$top=999&$count=true"
        out, hdr = [], {"ConsistencyLevel": "eventual"}
        while url:
            data = gc._req("GET", url, headers=hdr).json()
            out.extend(data.get("value", []))
            url = data.get("@odata.nextLink")
        return out

    def perm_get_baselines(self) -> dict:
        try:
            return {"ok": True, "data": self._perm_doc()}
        except Exception as e:
            return self._fail(e)

    def perm_save_baselines(self, data: dict, meta: dict | None = None) -> dict:
        try:
            self._client().require_section("perms")
            data = data or {}
            depts = data.get("departments") if isinstance(data.get("departments"), dict) else {}
            n = sum(len([g for g in (v.get("groups") or []) if g.get("expected")])
                    for v in depts.values() if isinstance(v, dict))
            meta = meta or {"action": "save", "target": "Group baselines",
                            "detail": f"{len(depts)} department(s), {n} expected group(s)"}
            self._hubc().save_perm_baselines(data, meta)
            return {"ok": True, "data": self._perm_doc()}
        except Exception as e:
            return self._fail(e)

    def _dept_users(self, gc, dept: str, company: str) -> list:
        """Enabled NBGW teammates (Entra companyName == `company`) whose `department`
        equals `dept`. Returns [{id, display, upn}]."""
        filt = (f"department eq '{self._odq(dept)}' and companyName eq '{self._odq(company)}'"
                " and accountEnabled eq true")
        out = self._users_where(gc, filt, "id,displayName,userPrincipalName")
        return [{"id": u.get("id", ""), "display": u.get("displayName", ""),
                 "upn": u.get("userPrincipalName", "")} for u in out if u.get("id")]

    def _perm_gc(self):
        """Signed-in Graph client with directory read, or raise a friendly error."""
        gc = self._client()
        gc.sign_in(interactive=False)
        if not gc._has_dir_read:
            raise RuntimeError("Needs Directory.Read.All (Entra).")
        return gc

    def perm_dept_suggest(self, prefix: str, domain: str = "") -> dict:
        """Distinct NBGW department names (with NBGW head-counts) starting with `prefix`,
        so the baseline editor can autocomplete a department to analyze."""
        p = (prefix or "").strip()
        if len(p) < 2:
            return {"ok": True, "departments": []}
        try:
            gc = self._perm_gc()
            company = self._perm_doc()["company"]
            out = self._users_where(
                gc, f"startsWith(department,'{self._odq(p)}') and companyName eq "
                    f"'{self._odq(company)}' and accountEnabled eq true", "department")
            counts: dict[str, int] = {}
            for u in out:
                dep = (u.get("department") or "").strip()
                if dep:
                    counts[dep] = counts.get(dep, 0) + 1
            depts = sorted(({"dept": k, "count": v} for k, v in counts.items()),
                           key=lambda x: (-x["count"], x["dept"].lower()))[:25]
            return {"ok": True, "departments": depts}
        except Exception as e:
            return self._fail(e)

    def perm_discover_departments(self) -> dict:
        """Every department in the NBGW scope with its NBGW head-count (largest first),
        flagging which are big enough (>= _PERM_MIN_MEMBERS) to baseline. Drives the
        "Rebuild from NBGW directory" button."""
        try:
            gc = self._perm_gc()
            company = self._perm_doc()["company"]
            out = self._users_where(
                gc, f"companyName eq '{self._odq(company)}' and accountEnabled eq true",
                "department")
            counts: dict[str, int] = {}
            for u in out:
                dep = (u.get("department") or "").strip()
                if dep:
                    counts[dep] = counts.get(dep, 0) + 1
            depts = sorted(({"dept": k, "count": v, "eligible": v >= self._PERM_MIN_MEMBERS}
                            for k, v in counts.items()),
                           key=lambda x: (-x["count"], x["dept"].lower()))
            return {"ok": True, "company": company, "total_users": len(out),
                    "min_members": self._PERM_MIN_MEMBERS, "departments": depts}
        except Exception as e:
            return self._fail(e)

    def perm_analyze_dept(self, dept: str, domain: str = "") -> dict:
        """Analyze one department: for every enabled member, pull their groups (direct +
        nested; all groups unless a keyword filter is set) and tally how many hold each.
        Groups held by >= threshold of the department are marked `expected`. Persists the
        result into the shared baseline doc and returns the whole (updated) doc."""
        name = (dept or "").strip()
        if not name:
            return {"ok": False, "error": "No department."}
        try:
            gc = self._perm_gc()
            doc = self._perm_doc()
            kw, thr, company = doc["keyword"], doc["threshold"], doc["company"]
            users = self._dept_users(gc, name, company)
            total = len(users)
            if not total:
                return {"ok": False, "error": f"No enabled {company} teammates found in department “{name}”."}
            gmap = gc.groups_for_users([u["id"] for u in users], keyword=kw)
            tally: dict[str, int] = {}
            for u in users:
                for nm in gmap.get(u["id"], []):
                    tally[nm] = tally.get(nm, 0) + 1
            # Store only groups above the min-coverage cutoff (unless a keyword filter is
            # in play — then keep them all, since the set is already narrow).
            cut = 0.0 if kw else self._PERM_STORE_MIN_PCT
            groups = [{"name": nm, "count": c, "pct": round(c / total, 3),
                       "expected": (c / total) >= thr}
                      for nm, c in tally.items()
                      if (c / total) >= cut and (kw or c >= 2)]
            groups.sort(key=lambda g: (-g["count"], g["name"].lower()))
            doc["departments"][name] = {
                "updated": datetime.now().isoformat(timespec="seconds"), "total": total,
                "company": company, "groups": groups,
            }
            kw_lbl = f"common {kw}" if kw else "common"
            self._hubc().save_perm_baselines(
                doc, {"action": "analyze", "target": "Group baselines",
                      "detail": f"Analyzed {name}: {total} users, "
                                f"{len([g for g in groups if g['expected']])} {kw_lbl} group(s)"})
            return {"ok": True, "data": doc, "department": name, "total": total,
                    "found": len(groups)}
        except Exception as e:
            return self._fail(e)

    def perm_missing_for_user(self, user_id: str) -> dict:
        """Compare one teammate against their department baseline: which expected groups
        do they lack (and hold), plus any keyword groups they have beyond the baseline."""
        uid = (user_id or "").strip()
        if not uid:
            return {"ok": False, "error": "No user selected."}
        try:
            from graph import GRAPH
            gc = self._perm_gc()
            u = gc._req("GET", f"{GRAPH}/users/{uid}"
                        "?$select=id,displayName,userPrincipalName,department,companyName").json()
            dept = (u.get("department") or "").strip()
            user = {"id": uid, "display": u.get("displayName", ""),
                    "upn": u.get("userPrincipalName", ""), "dept": dept,
                    "company": u.get("companyName") or ""}
            doc = self._perm_doc()
            # Baselines are built from NBGW teammates only — comparing someone from
            # another division that shares the department name would be meaningless.
            if (user["company"] or "").strip().lower() != doc["company"].lower():
                return {"ok": True, "user": user, "in_scope": False, "has_baseline": False,
                        "company": doc["company"], "keyword": doc["keyword"], "dept": dept}
            base = doc["departments"].get(dept) if dept else None
            expected = [g for g in ((base or {}).get("groups") or []) if g.get("expected")]
            if not dept or not base or not expected:
                return {"ok": True, "user": user, "in_scope": True, "has_baseline": False,
                        "company": doc["company"], "keyword": doc["keyword"], "dept": dept}
            mine = set(gc.groups_for_users([uid], keyword=doc["keyword"]).get(uid, []))
            missing = [g for g in expected if g["name"] not in mine]
            present = [g for g in expected if g["name"] in mine]
            return {"ok": True, "user": user, "in_scope": True, "has_baseline": True,
                    "company": doc["company"], "keyword": doc["keyword"], "dept": dept,
                    "total": base.get("total", 0), "updated": base.get("updated", ""),
                    "missing": missing, "present": present}
        except Exception as e:
            return self._fail(e)

    def perm_missing_in_dept(self, dept: str, domain: str = "") -> dict:
        """Department-wide compliance: for each member, which expected groups they lack.
        Uses the stored baseline's expected list; live-reads each member's groups."""
        name = (dept or "").strip()
        if not name:
            return {"ok": False, "error": "No department."}
        try:
            gc = self._perm_gc()
            doc = self._perm_doc()
            base = doc["departments"].get(name)
            expected = [g["name"] for g in ((base or {}).get("groups") or []) if g.get("expected")]
            if not base or not expected:
                return {"ok": True, "department": name, "has_baseline": False,
                        "keyword": doc["keyword"]}
            users = self._dept_users(gc, name, doc["company"])
            gmap = gc.groups_for_users([u["id"] for u in users], keyword=doc["keyword"])
            rows, have = [], {g: 0 for g in expected}
            for u in users:
                mine = set(gmap.get(u["id"], []))
                miss = [g for g in expected if g not in mine]
                for g in expected:
                    if g in mine:
                        have[g] += 1
                rows.append({"display": u["display"], "upn": u["upn"],
                             "missing": miss, "missing_count": len(miss),
                             "have_count": len(expected) - len(miss)})
            rows.sort(key=lambda r: (-r["missing_count"], r["display"].lower()))
            summary = sorted(({"name": g, "have": have[g],
                               "missing": len(users) - have[g]} for g in expected),
                             key=lambda s: (-s["missing"], s["name"].lower()))
            return {"ok": True, "department": name, "has_baseline": True,
                    "company": doc["company"], "keyword": doc["keyword"], "total": len(users),
                    "expected": expected, "users": rows, "summary": summary,
                    "compliant": len([r for r in rows if not r["missing_count"]])}
        except Exception as e:
            return self._fail(e)

    def hub_cancel_setup(self, setup_id: str, reason: str = "") -> dict:
        try:
            return {"ok": True, **self._hubc().cancel_setup(setup_id, reason, self._actor())}
        except Exception as e:
            return self._fail(e)

    def hub_get_changes(self) -> dict:
        try:
            return {"ok": True, "changes": self._hubc().get_changes()}
        except Exception as e:
            return self._fail(e)

    def hub_get_feedback(self) -> dict:
        try:
            return {"ok": True, "feedback": self._hubc().get_feedback()}
        except Exception as e:
            return self._fail(e)

    def hub_add_feedback(self, item: dict) -> dict:
        try:
            return {"ok": True, **self._hubc().add_feedback(item)}
        except Exception as e:
            return self._fail(e)

    def hub_open_folder(self) -> dict:
        """Files mode: open the shared data folder. Central mode: there is no folder, so open the central SharePoint site."""
        try:
            hub = self._hubc()
            if getattr(hub, "_store", None):
                gc = self._client()
                cc = gc._base_cfg.get("central") or {}
                host = (cc.get("site_host") or "").strip()
                path = (cc.get("site_path") or "").strip()
                if not host or not path.startswith("/"):
                    return {"ok": False, "error": "The central site address is not configured."}
                import webbrowser
                webbrowser.open(f"https://{host}{path}")
                return {"ok": True, "central": True}
            hub.open_folder()
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    def hub_storage_info(self) -> dict:
        try:
            gc = self._client()
            info = self._hubc().storage_info()
            if info.get("store") == "sharepoint":
                cc = gc._base_cfg.get("central") or {}
                info["site"] = f"https://{cc.get('site_host', '')}{cc.get('site_path', '')}"
            info["data_mode"] = gc.data_mode
            return {"ok": True, **info}
        except Exception as e:
            return self._fail(e)

    # ---- model -> department categorization (shared, no auth) -------------
    def hub_get_departments(self) -> dict:
        try:
            return {"ok": True, "data": self._hubc().get_model_departments()}
        except Exception as e:
            return self._fail(e)

    def hub_save_departments(self, data: dict, meta: dict = None) -> dict:
        try:
            self._hubc().save_model_departments(data or {}, meta or {})
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    # ---- NBT Sites: ONE list for the whole platform (platform document `nbt-sites`) ----
    _SITE_MODES = ("browser", "fullview", "window", "embed")

    @staticmethod
    def _clean_icon(icon) -> str:
        """An emoji (short text) or a small PNG data URL made by the picker; anything else becomes the globe."""
        import re
        s = str(icon or "").strip()
        if re.fullmatch(r"data:image/png;base64,[A-Za-z0-9+/=]{20,60000}", s):
            return s
        if s and len(s) <= 16 and not re.search(r"[<>\"'`]", s):
            return s
        return "\U0001F310"

    @classmethod
    def _clean_sites(cls, data) -> dict:
        import re
        d = data if isinstance(data, dict) else {}
        cats, seen = [], set()
        for c in d.get("categories") or []:
            c = str(c or "").strip()[:60]
            if c and c.lower() not in seen:
                seen.add(c.lower())
                cats.append(c)
        sites = []
        for s in (d.get("sites") or [])[:200]:
            if not isinstance(s, dict):
                continue
            name, url = str(s.get("name") or "").strip()[:80], str(s.get("url") or "").strip()[:600]
            if not name or not re.match(r"https?://", url, re.I):
                continue
            mode = s.get("mode") if s.get("mode") in cls._SITE_MODES else "fullview"
            sites.append({"id": re.sub(r"[^a-z0-9\-]", "", str(s.get("id") or name).lower().replace(" ", "-"))[:40] or "site",
                          "name": name, "url": url, "icon": cls._clean_icon(s.get("icon")), "mode": mode,
                          "category": str(s.get("category") or "").strip()[:60]})
        return {"categories": cats, "sites": sites, "pin": str(d.get("pin") or "")}

    def hub_get_sites(self) -> dict:
        """The NBT Sites list. Shared by every division. Until a platform list is saved, the active division's old list
        is shown so nothing disappears."""
        try:
            from hub import platform_hub_for
            gc = self._client()
            doc = platform_hub_for(gc).get_named("nbt-sites")
            if doc and isinstance(doc.get("sites"), list):
                return {"ok": True, "data": doc, "platform": True}
            return {"ok": True, "data": self._hubc().get_sites(), "platform": False}
        except Exception as e:
            return self._fail(e)

    def hub_save_sites(self, data: dict, meta: dict = None) -> dict:
        """Save the platform-wide list. Super admins may change anything; everyone else may only add or remove sites in the
        Custom category (the self-serve '+ Add site' tile)."""
        try:
            import json
            from hub import platform_hub_for
            gc = self._client()
            ph = platform_hub_for(gc)
            new = self._clean_sites(data)
            if not gc.is_super_admin():
                cur = ph.get_named("nbt-sites") or self._hubc().get_sites() or {}
                old = self._clean_sites(cur)

                def locked(d):
                    return json.dumps({"c": [c for c in d["categories"] if c.lower() != "custom"],
                                       "s": sorted([s for s in d["sites"] if (s["category"] or "").lower() != "custom"], key=lambda s: s["id"])}, sort_keys=True)
                if locked(new) != locked(old):
                    return {"ok": False, "error": "Only a super admin can change the built-in sites and categories."}
            ph.put_named("nbt-sites", new)
            m = meta or {}
            try:
                ph._change(m.get("target", "NBT Sites"), f"{self._actor() or 'NBG Hub'}: {m.get('action', 'save')} {m.get('detail', '')}".strip())
            except Exception:
                pass
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    # ---- device upgrade list (shared, no auth) ---------------------------
    def _actor(self) -> str:
        """Best 'by who' label: the signed-in Graph account if we have one, else
        the hub falls back to the Windows user."""
        try:
            gc = self._gc
            if gc is not None and getattr(gc, "account_name", None):
                return gc.account_name
        except Exception:
            pass
        return ""

    def hub_get_upgrades(self) -> dict:
        try:
            h = self._hubc()
            return {"ok": True, "data": h.get_upgrades(), "log": h.get_upgrade_log(), "ignored": len(h.get_upgrade_ignored())}
        except Exception as e:
            return self._fail(e)

    def hub_add_upgrade(self, device: dict, priority=3, notes: str = "") -> dict:
        try:
            return {"ok": True, **self._hubc().add_upgrade(device or {}, priority, notes, self._actor())}
        except Exception as e:
            return self._fail(e)

    def hub_save_upgrades(self, data: dict) -> dict:
        try:
            return {"ok": True, **self._hubc().save_upgrades(data or {}, self._actor())}
        except Exception as e:
            return self._fail(e)

    def hub_update_upgrade(self, item_id: str, priority=None, notes=None) -> dict:
        try:
            return {"ok": True, **self._hubc().update_upgrade(item_id, priority, notes, self._actor())}
        except Exception as e:
            return self._fail(e)

    def hub_bulk_upgrades(self, action: str, ids, priority=None, site=None) -> dict:
        """Several upgrade entries at once: action = priority | site | complete | remove."""
        try:
            ids = [str(i) for i in (ids or [])]
            if not ids:
                return {"ok": False, "error": "Nothing selected."}
            return {"ok": True, **self._hubc().bulk_upgrades(action, ids, priority, site, self._actor())}
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        except Exception as e:
            return self._fail(e)

    def hub_clear_upgrade_ignored(self) -> dict:
        """Let the automatic rules queue devices that were completed or removed before (division admins)."""
        try:
            self._client().require_division_admin()
            return {"ok": True, "cleared": self._hubc().clear_upgrade_ignored(None)}
        except Exception as e:
            return self._fail(e)

    # ---- fill in missing specs by hand (Dashboard > Missing specs, Devices) ----
    def cpu_info(self, text: str) -> dict:
        """What the app makes of a typed CPU name: release year and age (feeds the live hint in the edit window)."""
        try:
            from datetime import date
            from cpu import release_year
            yr = release_year(text or "")
            return {"ok": True, "year": yr, "age": (date.today().year - yr) if yr else None}
        except Exception as e:
            return self._fail(e)

    def update_device_specs(self, serial: str, fields: dict) -> dict:
        """Set CPU / RAM / storage / warranty on a device in In Use or New Stock. Only those four fields are accepted."""
        try:
            import re as _re
            import sync
            gc = self._client()
            serial = (serial or "").strip()
            key, item = "in_use", gc.find_by_serial("in_use", serial)
            if not item:
                key, item = "new_stock", gc.find_by_serial("new_stock", serial)
            if not item:
                return {"ok": False, "error": f"{serial} was not found in inventory."}
            upd = {}
            for k in ("cpu", "ram", "storage", "warranty"):
                if k in (fields or {}) and fields[k] is not None:
                    v = " ".join(str(fields[k]).split())
                    if len(v) > 120:
                        return {"ok": False, "error": f"{k.upper()} is too long."}
                    if k == "warranty" and v and not _re.match(r"^\d{4}-\d{2}-\d{2}$", v):
                        return {"ok": False, "error": "Warranty must be a date like 2027-05-31."}
                    upd[k] = v
            if not upd:
                return {"ok": True}
            gc.update_item(key, item["id"], upd)
            gc.add_log("Specs edited", serial, gc._row(item["fields"], key, in_use=(key == "in_use")).get("model", ""),
                       actor=gc.account_name or "", details=", ".join(f"{k}={v or '(blank)'}" for k, v in upd.items()))
            queued = sync.queue_upgrades(gc) if ("cpu" in upd or "warranty" in upd) else 0
            return {"ok": True, "queued_upgrades": queued}
        except Exception as e:
            return self._fail(e)

    def hub_begin_upgrade(self, item_id: str, setup_id: str) -> dict:
        try:
            return {"ok": True, **self._hubc().begin_upgrade(item_id, setup_id, self._actor())}
        except Exception as e:
            return self._fail(e)

    def hub_remove_upgrade(self, item_id: str) -> dict:
        try:
            return {"ok": True, **self._hubc().remove_upgrade(item_id, self._actor())}
        except Exception as e:
            return self._fail(e)

    def hub_complete_upgrade(self, item_id: str) -> dict:
        try:
            return {"ok": True, **self._hubc().complete_upgrade(item_id, self._actor())}
        except Exception as e:
            return self._fail(e)

    # ======================================================================
    # COMBINED DASHBOARD - setup stats always; inventory only when signed in
    # ======================================================================
    def get_dashboard(self) -> dict:
        out = {"ok": True, "signed_in": False, "account": None,
               "setups": None, "inventory": None}
        # endpoint-hub side (no auth)
        try:
            out["setups"] = self._hubc().setup_stats()
        except Exception as e:
            out["setups_error"] = str(e)
        # inventory side (only if a cached silent sign-in works; never prompt here)
        try:
            gc = self._client()
            gc.sign_in(interactive=False)
            out["signed_in"] = True
            out["account"] = gc.account_name
            # Boneyard-status devices are retired — never count them as deployable stock.
            new_stock_full = [r for r in gc.get_new_stock()
                              if (r.get("status") or "").strip().lower() != "boneyard"]
            new_stock = new_stock_full
            in_use = gc.get_in_use()
            # Devices reserved by an in-flight computer setup OR logged as hot spares are
            # held out of the deployable "in stock" rollups (count / by-site / by-dept)
            # so the dashboard shows what's genuinely available. They still appear in
            # their own tiles. Hot-spare enrichment below uses the FULL stock list so a
            # spare that lives in stock keeps its specs.
            try:
                reservations = self._hubc().active_reservations() or {}
            except Exception:
                reservations = {}
            try:
                hot_serials_u = {(h.get("serial") or "").strip().upper()
                                 for h in self._hubc().get_hot_spares()
                                 if (h.get("serial") or "").strip()}
            except Exception:
                hot_serials_u = set()
            reserved_serials_u = {s.strip().upper() for s in reservations}
            reserved_devs = []
            if reservations:
                _by_serial_u = {(r.get("serial") or "").strip().upper(): r for r in new_stock_full}
                for serial, info in reservations.items():
                    src = _by_serial_u.get(serial.strip().upper())
                    if not src:
                        continue   # already left stock (deployed) — nothing to subtract
                    reserved_devs.append({
                        "serial": serial, "model": src.get("model", ""),
                        "site": src.get("site_tag", ""), "subject": info.get("subject", ""),
                        "dept": info.get("dept", ""), "by": info.get("by", ""),
                    })
            held_u = reserved_serials_u | hot_serials_u
            if held_u:
                new_stock = [r for r in new_stock_full
                             if (r.get("serial") or "").strip().upper() not in held_u]
            # in-use devices whose primary user has NOT registered MFA (drill-down).
            # Reads the persisted MFA cell (filled fill-when-blank by enrich_in_use);
            # "" (not yet resolved) is not counted as "no MFA".
            no_mfa = [{"serial": r.get("serial", ""), "device_name": r.get("device_name", ""),
                       "model": r.get("model", ""), "user": r.get("user", ""), "source": "In Use"}
                      for r in in_use if r.get("mfa") == "No"]
            by_site = {}
            for r in in_use:
                t = (r.get("site_tag") or "—")
                by_site[t] = by_site.get(t, 0) + 1
            stock_by_site = {}
            for r in new_stock:
                t = (r.get("site_tag") or "—")
                stock_by_site[t] = stock_by_site.get(t, 0) + 1
            # in-stock rolled up by department (model -> dept map from the hub,
            # shared/no-auth); unmapped models fall under "Unassigned".
            dept_map = {}
            try:
                _dd = self._hubc().get_model_departments() or {}
                dept_map = _dd.get("map") or {}
            except Exception:
                dept_map = {}
            stock_by_dept = {}
            div_sites = set(__import__("divisions").site_codes(self._client().division))
            stock_by_dept_site = {}   # dept -> {<site code>: n, "Other": n}
            for r in new_stock:
                dep = dept_map.get((r.get("model") or "").strip()) or "Unassigned"
                stock_by_dept[dep] = stock_by_dept.get(dep, 0) + 1
                site = (r.get("site_tag") or "").strip().upper()
                skey = site if site in div_sites else "Other"
                d = stock_by_dept_site.setdefault(dep, {})
                d[skey] = d.get(skey, 0) + 1
            # devices whose primary user is NOT at an NBGW site (LTR/BRI): their
            # resolved "site" is an office location elsewhere. Surfaced on the dashboard
            # with a drill-down.
            nbgw_sites = div_sites
            not_nbgw, by_office = [], {}
            for r in in_use:
                site = (r.get("site_tag") or "").strip()
                if site and site.upper() not in nbgw_sites:
                    not_nbgw.append({"serial": r.get("serial", ""), "model": r.get("model", ""),
                                     "user": r.get("user", ""), "office": site})
                    by_office[site] = by_office.get(site, 0) + 1
            # in-use devices missing a primary user (drill-down)
            no_upn = [{"serial": r.get("serial", ""), "device_name": r.get("device_name", ""),
                       "model": r.get("model", ""), "site": r.get("site_tag", ""), "source": "In Use"}
                      for r in in_use if not (r.get("user") or "").strip()]
            # tag each device with the SharePoint list it lives in, so drills that span
            # both lists can show a Source column ("which system was it found in").
            tagged = [(r, "In Use") for r in in_use] + [(r, "In Stock") for r in new_stock]
            # devices whose warranty is expired or ends within 90 days (drill-down)
            _today = date.today()
            warranty_soon = []
            for r, src in tagged:
                wd = _parse_warranty(r.get("warranty"))
                if not wd:
                    continue
                days = (wd - _today).days
                if days <= 90:
                    warranty_soon.append({"serial": r.get("serial", ""), "model": r.get("model", ""),
                                          "user": r.get("user", ""), "warranty": wd.isoformat(), "days": days,
                                          "source": src})
            warranty_soon.sort(key=lambda x: x["days"])
            # "Needs upgrade": the rules in Settings > Integrations > Upgrades (processor age, warranty age).
            # Viewing the dashboard writes nothing: the Upgrade list is filled by the sync (sync.queue_upgrades).
            import settings_catalog as _sc
            import upgrade_rules
            _cpu_years = _sc.number(gc, "upgrade_cpu_years")
            _warr_months = _sc.number(gc, "upgrade_warranty_months")
            needs_upgrade = upgrade_rules.evaluate(tagged, _cpu_years, _warr_months, _today)
            missing_specs = upgrade_rules.missing_specs(tagged)
            # devices that haven't checked in to Intune in 30+ days (drill-down). Spans
            # both lists — a stock/loaner device can go stale too; Source shows which.
            stale_checkin = []
            stale_limit = self._stale_limit()
            for r, src in tagged:
                lc = (r.get("last_checkin") or "")[:10]
                if not lc:
                    continue
                try:
                    days = (_today - date.fromisoformat(lc)).days
                except ValueError:
                    continue
                if days > stale_limit:
                    stale_checkin.append({"serial": r.get("serial", ""), "device_name": r.get("device_name", ""),
                                          "model": r.get("model", ""), "user": r.get("user", ""),
                                          "last_checkin": lc, "days": days, "source": src})
            stale_checkin.sort(key=lambda x: -x["days"])
            out["inventory"] = {
                "new_stock": len(new_stock), "in_use": len(in_use),
                "total": len(new_stock) + len(in_use), "by_site": by_site,
                "stock_by_site": stock_by_site,
                "stock_by_dept": stock_by_dept,
                "stock_by_dept_site": stock_by_dept_site,
                "warranty": _warranty_summary(new_stock + in_use),
                "not_nbgw_count": len(not_nbgw),
                "not_nbgw": not_nbgw,
                "not_nbgw_by_office": by_office,
                "no_upn_count": len(no_upn),
                "no_upn": no_upn,
                "warranty_soon": warranty_soon,
                "needs_upgrade_count": len(needs_upgrade),
                "needs_upgrade": needs_upgrade,
                "upgrade_rules": {"cpu_years": _cpu_years, "warranty_months": _warr_months},
                "missing_specs_count": len(missing_specs),
                "missing_specs": missing_specs,
                "stale_days": stale_limit,
                "stale_checkin_count": len(stale_checkin),
                "stale_checkin": stale_checkin,
                "no_mfa_count": len(no_mfa),
                "no_mfa": no_mfa,
                "reserved_count": len(reserved_devs),
                "reserved": reserved_devs,
                "hot_spares": self._enrich_hot_spares(gc, in_use, new_stock_full),
            }
        except Exception:
            out["signed_in"] = False
        return out


# Injected into an NBT site page (top-level) so the user can get back to the app
# without a separate window. Self-heals if the site's own scripts remove it.
def _long_op(fn):
    """Mark an Api method as a long-running write: a division switch is refused while one runs."""
    import functools

    @functools.wraps(fn)
    def wrapper(self, *a, **k):
        with self._work():
            return fn(self, *a, **k)
    return wrapper


for _n in ("run_sync", "enrich_inventory", "master_sync", "populate_mfa", "boneyard_sweep", "sync_all_divisions", "software_refresh", "mfa_people_refresh"):
    setattr(Api, _n, _long_op(getattr(Api, _n)))


_BACK_JS = r"""
(function(){
  function add(){
    if(!document.body || document.getElementById('__nbgwBack')) return;
    var b=document.createElement('button');
    b.id='__nbgwBack';
    b.textContent='← Back to NBG Hub';
    b.style.cssText='position:fixed;top:10px;left:10px;z-index:2147483647;background:#006325;color:#fff;border:none;border-radius:8px;padding:9px 14px;font:600 13px "Segoe UI",sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.45)';
    b.onmouseenter=function(){b.style.background='#00782d';};
    b.onmouseleave=function(){b.style.background='#006325';};
    b.onclick=function(){
      try{ if(window.pywebview&&window.pywebview.api&&window.pywebview.api.site_back){ window.pywebview.api.site_back(); return; } }catch(e){}
      try{ history.back(); }catch(e){}
    };
    document.body.appendChild(b);
  }
  add(); setInterval(add, 1200);
})();
"""


def main() -> None:
    # Relax the embedded WebView2's SameSite cookie enforcement so sign-in
    # portals (e.g. the Lockout Portal) can complete their auth redirect INSIDE
    # an iframe instead of looping ("redirected too many times"). Framed pages
    # are otherwise treated as third-party, and Lax cookies aren't sent there.
    # Must be set before the WebView2 environment is created (before start()).
    # Only affects the desktop webview, and only pages we choose to load.
    _extra = "--disable-features=SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure"
    prev = os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "")
    os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (prev + " " + _extra).strip()

    try:
        import webview
    except ImportError:
        sys.exit("pywebview is not installed. Run:  pip install pywebview   (see README.md)")

    api = Api()
    window = webview.create_window(
        "NBG Hub",
        url=_asset("web", "index.html"),
        js_api=api,
        width=1500,
        height=900,
        min_size=(1080, 640),
    )

    # When the main window is showing an NBT site, inject the "Back to Hub"
    # button after each load (auth redirects fire this several times).
    def _on_loaded():
        if not api._site_view:
            return
        try:
            window.evaluate_js(_BACK_JS)
        except Exception:
            pass

    window.events.loaded += _on_loaded
    webview.start()


if __name__ == "__main__":
    if "--selftest" in sys.argv:                      # packaging check (build.ps1): no window, no network
        import selftest
        i = sys.argv.index("--selftest")
        sys.exit(selftest.run(sys.argv[i + 1] if len(sys.argv) > i + 1 else None))
    try:
        import selftest
        selftest.require_webview2()
        main()
    except Exception:
        traceback.print_exc()
        input("\nPress Enter to close...")
